package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/wlqoh/mini_discord.git/internal/lib/ratelimit"
	"github.com/wlqoh/mini_discord.git/types"
	"github.com/wlqoh/mini_discord.git/utils"
)

type Hub struct {
	storage              types.ServerStorage
	s3Host               string
	mu                   sync.RWMutex
	clientsByUser        map[int]*Client
	createServerLimiter  *ratelimit.TokenBucket
	createChannelLimiter *ratelimit.TokenBucket
	sendMessageLimiter   *ratelimit.TokenBucket
	voiceParticipants    map[int64]map[int]struct{}
	userVoiceChannel     map[int]int64
	voiceStatusByUser    map[int]voiceStatus

	log *slog.Logger

	Register   chan *Client
	Unregister chan *Client
	Commands   chan wsCommandRequest
}

type wsCommandRequest struct {
	client  *Client
	command types.WsCommand
}

type voiceStatus struct {
	micEnabled bool
	deafened   bool
}

const maxServerChannelNameLen = 16

func NewHub(storage types.ServerStorage, log *slog.Logger, s3Host string) *Hub {
	return &Hub{
		storage:              storage,
		s3Host:               strings.TrimSpace(s3Host),
		clientsByUser:        make(map[int]*Client),
		createServerLimiter:  ratelimit.NewTokenBucket(5.0/60.0, 5.0),
		createChannelLimiter: ratelimit.NewTokenBucket(5.0/60.0, 5.0),
		sendMessageLimiter:   ratelimit.NewTokenBucket(1.0, 1.0),
		voiceParticipants:    make(map[int64]map[int]struct{}),
		userVoiceChannel:     make(map[int]int64),
		voiceStatusByUser:    make(map[int]voiceStatus),
		log:                  log,
		Register:             make(chan *Client),
		Unregister:           make(chan *Client),
		Commands:             make(chan wsCommandRequest, 64),
	}
}

func (h *Hub) Close() {
	h.createServerLimiter.Close()
	h.createChannelLimiter.Close()
	h.sendMessageLimiter.Close()
}

func (h *Hub) Run() {
	for {
		select {
		case cl := <-h.Register:
			h.registerClient(cl)

		case cl := <-h.Unregister:
			h.unregisterClient(cl)
		case req := <-h.Commands:
			h.handleCommand(req)
		}
	}
}

func (h *Hub) registerClient(cl *Client) {
	h.mu.Lock()
	if old, ok := h.clientsByUser[cl.UserID]; ok && old != cl {
		_ = old.Conn.Close()
		close(old.Outbound)
	}
	h.clientsByUser[cl.UserID] = cl
	h.mu.Unlock()

	h.pushEvent(cl, &types.WsEvent{Event: types.WsEventConnected})
}

func (h *Hub) unregisterClient(cl *Client) {
	removed := false

	h.mu.Lock()
	if current, ok := h.clientsByUser[cl.UserID]; ok && current == cl {
		delete(h.clientsByUser, cl.UserID)
		close(cl.Outbound)
		removed = true
	}
	h.mu.Unlock()

	if removed {
		h.leaveVoiceChannelInternal(cl, false)
	}
}

func (h *Hub) handleCommand(req wsCommandRequest) {
	ctx := context.Background()

	switch req.command.Action {
	case types.WsActionCreateServer:
		h.createServer(req, ctx)
	case types.WsActionDeleteServer:
		h.deleteServer(req, ctx)
	case types.WsActionJoinServer:
		h.joinServer(req, ctx)
	case types.WsActionCreateChannel:
		h.createChannel(req, ctx)
	case types.WsActionDeleteChannel:
		h.deleteChannel(req, ctx)
	case types.WsActionSendMessage:
		h.sendMessage(req, ctx)
	case types.WsActionGetMessages:
		h.getMessages(req, ctx)
	case types.WsActionGetServers:
		h.getServers(req, ctx)
	case types.WsActionGetServerChannels:
		h.getServerChannels(req, ctx)
	case types.WsActionGetUsersOnline:
		h.getUsersOnline(req, ctx)
	case types.WsActionJoinVoiceChannel:
		h.joinVoiceChannel(req, ctx)
	case types.WsActionLeaveVoiceChannel:
		h.leaveVoiceChannel(req)
	case types.WsActionRTCSignal:
		h.relayRTCSignal(req, ctx)
	case types.WsActionSearchServers:
		h.searchServers(req, ctx)
	case types.WsActionChangeVoiceStatus:
		h.changeVoiceStatus(req, ctx)

	default:
		h.pushError(req.client, "unknown action")
	}
}

func (h *Hub) changeVoiceStatus(req wsCommandRequest, ctx context.Context) {
	var payload types.WsChangeVoiceStatusRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid change_voice_status payload")
		return
	}

	h.mu.Lock()
	channelID, inVoice := h.userVoiceChannel[payload.UserID]
	if !inVoice {
		h.mu.Unlock()
		h.pushError(req.client, "user not in voice channel")
		return
	}

	participants := h.voiceParticipants[channelID]
	if participants == nil {
		h.mu.Unlock()
		h.pushError(req.client, "voice channel not found")
		return
	}

	h.voiceStatusByUser[payload.UserID] = voiceStatus{
		micEnabled: payload.MicEnabled,
		deafened:   payload.Deafened,
	}

	notifyUsers := make([]int, 0, len(participants))
	for userID := range participants {
		notifyUsers = append(notifyUsers, userID)
	}
	h.mu.Unlock()

	updatedParticipant := h.resolveVoiceParticipant(ctx, payload.UserID)
	h.pushToUsers(notifyUsers, &types.WsEvent{
		Event: types.WsEventVoiceStatusChanged,
		Data: types.WsVoiceUserEvent{
			ChannelID: channelID,
			User:      updatedParticipant,
		},
	})

	h.pushEvent(req.client, &types.WsEvent{Event: types.WsEventAck})
}

func (h *Hub) pushToUsers(userIDs []int, event *types.WsEvent) {
	h.mu.RLock()
	for _, userID := range userIDs {
		if cl, ok := h.clientsByUser[userID]; ok {
			h.enqueueEvent(cl, event)
		}

	}
	h.mu.RUnlock()
}

func (h *Hub) pushToAllUsers(event *types.WsEvent) {
	h.mu.RLock()
	for _, cl := range h.clientsByUser {
		h.enqueueEvent(cl, event)
	}
	h.mu.RUnlock()
}

func (h *Hub) pushEvent(cl *Client, event *types.WsEvent) {
	h.mu.RLock()
	current, ok := h.clientsByUser[cl.UserID]
	if !ok || current != cl {
		h.mu.RUnlock()
		return
	}
	h.enqueueEvent(cl, event)
	h.mu.RUnlock()
}

func (h *Hub) enqueueEvent(cl *Client, event *types.WsEvent) {
	if event != nil && event.Event == types.WsEventRTCSignal {
		select {
		case cl.Outbound <- event:
		case <-time.After(300 * time.Millisecond):
			h.log.Warn("drop rtc_signal event: outbound queue timeout", "user_id", cl.UserID)
		}
		return
	}

	select {
	case cl.Outbound <- event:
	default:
		h.log.Debug("drop websocket event: outbound queue full", "event", event.Event, "user_id", cl.UserID)
	}
}

func (h *Hub) pushError(cl *Client, message string) {
	h.pushEvent(cl, &types.WsEvent{Event: types.WsEventError, Error: message})
}

func (h *Hub) listOnlineServerUserIDs(ctx context.Context, serverID int64, excludeUserID int) ([]int, error) {
	serverUserIDs, err := h.storage.ListServerMembersUserIDs(ctx, serverID)
	if err != nil {
		return nil, err
	}

	h.mu.RLock()
	onlineUsers := make([]int, 0, len(serverUserIDs))
	for _, userID := range serverUserIDs {
		if userID == excludeUserID {
			continue
		}
		if _, ok := h.clientsByUser[userID]; ok {
			onlineUsers = append(onlineUsers, userID)
		}
	}
	h.mu.RUnlock()

	return onlineUsers, nil
}

func (h *Hub) buildVoiceParticipantsSnapshot(ctx context.Context, channels []types.Channel) []types.WsVoiceChannelParticipants {
	voiceChannelIDs := make([]int64, 0, len(channels))
	for _, ch := range channels {
		if ch.Type == types.ChannelTypeVoice {
			voiceChannelIDs = append(voiceChannelIDs, ch.ID)
		}
	}

	h.mu.RLock()
	participantsByChannel := make(map[int64][]int, len(voiceChannelIDs))
	for _, channelID := range voiceChannelIDs {
		participants := h.voiceParticipants[channelID]
		if len(participants) == 0 {
			continue
		}

		userIDs := make([]int, 0, len(participants))
		for userID := range participants {
			userIDs = append(userIDs, userID)
		}
		participantsByChannel[channelID] = userIDs
	}
	h.mu.RUnlock()

	snapshot := make([]types.WsVoiceChannelParticipants, 0, len(participantsByChannel))
	for channelID, userIDs := range participantsByChannel {
		participants := make([]types.WsVoiceParticipant, 0, len(userIDs))
		for _, userID := range userIDs {
			participants = append(participants, h.resolveVoiceParticipant(ctx, userID))
		}
		sort.Slice(participants, func(i, j int) bool { return participants[i].UserID < participants[j].UserID })

		snapshot = append(snapshot, types.WsVoiceChannelParticipants{
			ChannelID:    channelID,
			Participants: participants,
		})
	}
	sort.Slice(snapshot, func(i, j int) bool { return snapshot[i].ChannelID < snapshot[j].ChannelID })

	return snapshot
}

func (h *Hub) deleteChannel(req wsCommandRequest, ctx context.Context) {
	var payload types.WsDeleteChannelRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid delete_channel payload")
		return
	}
	if payload.ChannelID <= 0 {
		h.pushError(req.client, "channel_id is required")
		return
	}

	if err := h.storage.DeleteChannel(ctx, payload.ChannelID, req.client.UserID); err != nil {
		h.pushError(req.client, err.Error())
		return
	}

	h.pushEvent(req.client, &types.WsEvent{
		Event: types.WsEventAck,
		Data: map[string]any{
			"channel_id": payload.ChannelID,
		},
	})
}

func (h *Hub) deleteServer(req wsCommandRequest, ctx context.Context) {
	var payload types.WsDeleteServerRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid delete_server payload")
		return
	}
	if payload.ServerID <= 0 {
		h.pushError(req.client, "server_id is required")
		return
	}

	if err := h.storage.DeleteServer(ctx, payload.ServerID, req.client.UserID); err != nil {
		h.pushError(req.client, err.Error())
		return
	}

	h.pushEvent(req.client, &types.WsEvent{
		Event: types.WsEventAck,
		Data: map[string]any{
			"server_id": payload.ServerID,
		},
	})
}

func (h *Hub) createServer(req wsCommandRequest, ctx context.Context) {
	if !h.createServerLimiter.Allow(strconv.Itoa(req.client.UserID)) {
		h.pushError(req.client, "rate limit exceeded for create_server")
		return
	}

	var payload types.WsCreateServerRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid create_server payload")
		return
	}
	payload.Name = strings.TrimSpace(payload.Name)
	if payload.Name == "" {
		h.pushError(req.client, "server name is required")
		return
	}
	if utf8.RuneCountInString(payload.Name) > maxServerChannelNameLen {
		h.pushError(req.client, "server name must be at most 16 characters")
		return
	}

	serverID, err := h.storage.CreateServer(ctx, types.Server{Name: payload.Name, OwnerID: req.client.UserID})
	if err != nil {
		h.pushError(req.client, "failed to create server")
		return
	}

	h.pushEvent(req.client, &types.WsEvent{
		Event: types.WsEventAck,
		Data: map[string]any{
			"server_id": serverID,
			"name":      payload.Name,
		},
	})
}

func (h *Hub) joinServer(req wsCommandRequest, ctx context.Context) {
	var payload types.WsJoinServerRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid join_server payload")
		return
	}
	if payload.ServerID <= 0 {
		h.pushError(req.client, "server_id is required")
		return
	}

	isMember, err := h.storage.IsServerMember(ctx, req.client.UserID, payload.ServerID)
	if err != nil {
		h.pushError(req.client, "failed to check server membership")
		return
	}
	if isMember {
		h.pushError(req.client, "already a member")
		return
	}

	if err := h.storage.AddMemberToServer(ctx, req.client.UserID, payload.ServerID); err != nil {
		h.pushError(req.client, "failed to join server")
		return
	}

	h.pushEvent(req.client, &types.WsEvent{
		Event: types.WsEventAck,
		Data: map[string]any{
			"server_id": payload.ServerID,
		},
	})
}

func (h *Hub) createChannel(req wsCommandRequest, ctx context.Context) {
	if !h.createChannelLimiter.Allow(strconv.Itoa(req.client.UserID)) {
		h.pushError(req.client, "rate limit exceeded for create_channel")
		return
	}

	var payload types.WsCreateChannelRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid create_channel payload")
		return
	}
	payload.Name = strings.TrimSpace(payload.Name)
	payload.Type = strings.TrimSpace(strings.ToLower(payload.Type))
	payloadType := normalizeChannelType(payload.Type)
	if payload.ServerID <= 0 || payload.Name == "" {
		h.pushError(req.client, "server_id and name are required")
		return
	}
	if utf8.RuneCountInString(payload.Name) > maxServerChannelNameLen {
		h.pushError(req.client, "channel name must be at most 16 characters")
		return
	}
	if payloadType == "" {
		h.pushError(req.client, "invalid channel type")
		return
	}

	isMember, err := h.storage.IsServerMember(ctx, req.client.UserID, payload.ServerID)
	if err != nil {
		h.pushError(req.client, "failed to check server membership")
		return
	}
	if !isMember {
		h.pushError(req.client, "access denied")
		return
	}

	channelID, err := h.storage.CreateChannel(ctx, payload.ServerID, payload.Name, payloadType)
	if err != nil {
		h.pushError(req.client, "failed to create channel")
		return
	}

	h.pushEvent(req.client, &types.WsEvent{
		Event: types.WsEventAck,
		Data: map[string]any{
			"channel_id": channelID,
			"server_id":  payload.ServerID,
			"name":       payload.Name,
			"type":       payloadType,
		},
	})
}

func (h *Hub) getUsersOnline(req wsCommandRequest, ctx context.Context) {
	var payload types.WsGetUsersOnlineRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid get_users_online payload")
		return
	}
	if payload.ServerID <= 0 {
		h.pushError(req.client, "server_id is required")
		return
	}

	isMember, err := h.storage.IsServerMember(ctx, req.client.UserID, payload.ServerID)
	if err != nil {
		h.pushError(req.client, "failed to check server membership")
		return
	}
	if !isMember {
		h.pushError(req.client, "access denied")
		return
	}

	serverUserIDs, err := h.storage.ListServerMembersUserIDs(ctx, payload.ServerID)
	if err != nil {
		h.pushError(req.client, "failed to resolve server members")
		return
	}

	h.mu.RLock()
	onlineUsers := make([]types.UserResponse, 0, len(serverUserIDs))
	for _, userID := range serverUserIDs {
		if _, ok := h.clientsByUser[userID]; ok {
			user, err := h.storage.GetUserByID(ctx, userID)
			if err != nil {
				h.pushError(req.client, "failed to resolve user")
			}

			onlineUsers = append(onlineUsers, types.UserResponse{
				FirstName: user.FirstName,
				LastName:  user.LastName,
				AvatarURL: utils.AvatarURLFromKey(user.AvatarKey, h.s3Host),
				Email:     user.Email,
			})
		}
	}
	h.mu.RUnlock()

	h.pushEvent(req.client, &types.WsEvent{
		Event: types.WsEventAck,
		Data: types.WsGetUsersOnlineResponse{
			ServerID: payload.ServerID,
			Users:    onlineUsers,
		},
	})
}

func (h *Hub) sendMessage(req wsCommandRequest, ctx context.Context) {
	if !h.sendMessageLimiter.Allow(strconv.Itoa(req.client.UserID)) {
		h.pushError(req.client, "rate limit exceeded for send_message")
		return
	}

	var payload types.WsSendMessageRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid send_message payload")
		return
	}
	payload.Content = strings.TrimSpace(payload.Content)
	if payload.ChannelID <= 0 || payload.Content == "" {
		h.pushError(req.client, "channel_id and content are required")
		return
	}

	canAccess, err := h.storage.CanUserAccessChannel(ctx, req.client.UserID, payload.ChannelID)
	if err != nil {
		h.pushError(req.client, "failed to check channel access")
		return
	}
	if !canAccess {
		h.pushError(req.client, "access denied")
		return
	}

	recipientUserIDs, err := h.storage.ListChannelMemberUserIDs(ctx, payload.ChannelID)
	if err != nil {
		h.pushError(req.client, "failed to resolve channel members")
		return
	}

	user, err := h.storage.GetUserByID(ctx, req.client.UserID)
	if err != nil || user == nil {
		h.pushError(req.client, "failed to resolve message author")
		return
	}

	msg := types.WsMessage{
		ChannelID:       payload.ChannelID,
		AuthorID:        req.client.UserID,
		AuthorFirstName: user.FirstName,
		AuthorLastName:  user.LastName,
		AuthorAvatarURL: utils.AvatarURLFromKey(user.AvatarKey, h.s3Host),
		Content:         payload.Content,
		CreatedAt:       time.Now().UTC(),
	}
	if err := h.storage.SaveMessage(ctx, msg); err != nil {
		h.pushError(req.client, "failed to save message")
		return
	}

	event := &types.WsEvent{Event: types.WsEventMessage, Data: msg}
	h.pushToUsers(recipientUserIDs, event)

	h.pushEvent(req.client, &types.WsEvent{Event: types.WsEventAck})
}

func (h *Hub) getMessages(req wsCommandRequest, ctx context.Context) {
	var payload types.WsGetMessagesRequest

	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid get_messages payload")
		return
	}
	if payload.ChannelID <= 0 {
		h.pushError(req.client, "channel_id is required")
		return
	}

	cursor, err := types.DecodeWsMessageCursor(payload.Cursor)
	if err != nil {
		h.pushError(req.client, "invalid cursor")
		return
	}
	if cursor != nil && cursor.ChannelID != payload.ChannelID {
		h.pushError(req.client, "cursor channel mismatch")
		return
	}

	messages, nextCursor, hasMore, err := h.storage.GetMessages(ctx, payload.ChannelID, payload.Limit, cursor, h.s3Host)
	if err != nil {
		h.pushError(req.client, "failed to get messages")
		return
	}

	var nextCursorRaw string
	if nextCursor != nil {
		nextCursorRaw, err = types.EncodeWsMessageCursor(*nextCursor)
		if err != nil {
			h.pushError(req.client, "failed to encode cursor")
			return
		}
	}

	h.pushEvent(req.client, &types.WsEvent{
		Event: types.WsEventAck,
		Data: map[string]any{
			"channel_id":  payload.ChannelID,
			"messages":    messages,
			"next_cursor": nextCursorRaw,
			"has_more":    hasMore,
		},
	})
}

func (h *Hub) getServers(req wsCommandRequest, ctx context.Context) {
	servers, err := h.storage.GetServersByUserID(ctx, req.client.UserID)
	if err != nil {
		h.pushError(req.client, "failed to get servers")
		return
	}

	h.log.Info("ws get_servers", "user_id", req.client.UserID, "servers_count", len(servers))

	h.pushEvent(req.client, &types.WsEvent{
		Event: types.WsEventAck,
		Data:  types.WsGetServersResponse{Servers: servers},
	})
}

func (h *Hub) getServerChannels(req wsCommandRequest, ctx context.Context) {
	var payload types.WsGetServerChannelsRequest

	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid get_server_channels payload")
		return
	}

	if payload.ServerID <= 0 {
		h.pushError(req.client, "server_id is required")
		return
	}

	channels, err := h.storage.GetServerChannels(ctx, payload.ServerID)
	if err != nil {
		h.pushError(req.client, "failed to get server_channels")
		return
	}

	voiceParticipants := h.buildVoiceParticipantsSnapshot(ctx, channels)

	h.log.Info("ws get_server_channels", "user_id", req.client.UserID, "server_id", payload.ServerID, "channels_count", len(channels))

	h.pushEvent(req.client, &types.WsEvent{
		Event: types.WsEventAck,
		Data: types.WsGetChannelsResponse{
			Channels:          channels,
			VoiceParticipants: voiceParticipants,
		},
	})
}

func (h *Hub) joinVoiceChannel(req wsCommandRequest, ctx context.Context) {
	var payload types.WsJoinVoiceChannelRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid join_voice_channel payload")
		return
	}
	if payload.ChannelID <= 0 {
		h.pushError(req.client, "channel_id is required")
		return
	}

	channel, err := h.storage.GetChannelByID(ctx, payload.ChannelID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			h.pushError(req.client, "channel not found")
			return
		}
		h.pushError(req.client, "failed to resolve channel")
		return
	}
	if channel.Type != types.ChannelTypeVoice {
		h.pushError(req.client, "selected channel is not voice")
		return
	}

	canAccess, err := h.storage.CanUserAccessChannel(ctx, req.client.UserID, payload.ChannelID)
	if err != nil {
		h.pushError(req.client, "failed to check channel access")
		return
	}
	if !canAccess {
		h.pushError(req.client, "access denied")
		return
	}

	h.leaveVoiceChannelInternal(req.client, false)

	h.mu.Lock()
	participants := h.voiceParticipants[payload.ChannelID]
	if participants == nil {
		participants = make(map[int]struct{})
		h.voiceParticipants[payload.ChannelID] = participants
	}
	participants[req.client.UserID] = struct{}{}
	h.userVoiceChannel[req.client.UserID] = payload.ChannelID
	h.voiceStatusByUser[req.client.UserID] = voiceStatus{micEnabled: true, deafened: false}

	otherUserIDs := make([]int, 0, len(participants))
	for userID := range participants {
		if userID == req.client.UserID {
			continue
		}
		otherUserIDs = append(otherUserIDs, userID)
	}
	h.mu.Unlock()

	peers := make([]types.WsVoiceParticipant, 0, len(otherUserIDs))
	for _, userID := range otherUserIDs {
		peers = append(peers, h.resolveVoiceParticipant(ctx, userID))
	}

	selfParticipant := h.resolveVoiceParticipant(ctx, req.client.UserID)
	h.pushEvent(req.client, &types.WsEvent{
		Event: types.WsEventAck,
		Data: types.WsJoinVoiceChannelResponse{
			ChannelID:    payload.ChannelID,
			Participants: peers,
		},
	})

	serverOnlineUserIDs, err := h.listOnlineServerUserIDs(ctx, channel.ServerID, req.client.UserID)
	if err != nil {
		h.log.Warn("failed to resolve online users for voice join broadcast", "server_id", channel.ServerID, "err", err)
		serverOnlineUserIDs = otherUserIDs
	}

	h.pushToUsers(serverOnlineUserIDs, &types.WsEvent{
		Event: types.WsEventVoiceUserJoined,
		Data: types.WsVoiceUserEvent{
			ChannelID: payload.ChannelID,
			User:      selfParticipant,
		},
	})
}

func (h *Hub) leaveVoiceChannel(req wsCommandRequest) {
	h.leaveVoiceChannelInternal(req.client, true)
}

func (h *Hub) relayRTCSignal(req wsCommandRequest, ctx context.Context) {
	var payload types.WsRTCSignalRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid rtc_signal payload")
		return
	}

	payload.SignalType = strings.TrimSpace(strings.ToLower(payload.SignalType))
	if payload.ChannelID <= 0 || payload.ToUserID <= 0 || payload.SignalType == "" {
		h.pushError(req.client, "channel_id, to_user_id and signal_type are required")
		return
	}
	if payload.SignalType != "offer" && payload.SignalType != "answer" && payload.SignalType != "candidate" {
		h.pushError(req.client, "unsupported signal_type")
		return
	}

	canAccess, err := h.storage.CanUserAccessChannel(ctx, req.client.UserID, payload.ChannelID)
	if err != nil {
		h.pushError(req.client, "failed to check channel access")
		return
	}
	if !canAccess {
		h.pushError(req.client, "access denied")
		return
	}

	h.mu.RLock()
	senderChannelID, senderInVoice := h.userVoiceChannel[req.client.UserID]
	targetChannelID, targetInVoice := h.userVoiceChannel[payload.ToUserID]
	targetClient, targetConnected := h.clientsByUser[payload.ToUserID]
	h.mu.RUnlock()

	if !senderInVoice || senderChannelID != payload.ChannelID {
		h.pushError(req.client, "join voice channel before signaling")
		return
	}
	if !targetInVoice || targetChannelID != payload.ChannelID || !targetConnected {
		h.pushError(req.client, "recipient not in channel")
		return
	}

	h.pushEvent(targetClient, &types.WsEvent{
		Event: types.WsEventRTCSignal,
		Data: types.WsRTCSignalEvent{
			ChannelID:     payload.ChannelID,
			FromUserID:    req.client.UserID,
			SignalType:    payload.SignalType,
			SDP:           payload.SDP,
			Candidate:     payload.Candidate,
			SDPMid:        payload.SDPMid,
			SDPMLineIndex: payload.SDPMLineIndex,
		},
	})
}

func (h *Hub) leaveVoiceChannelInternal(cl *Client, ack bool) {
	h.mu.Lock()
	channelID, ok := h.userVoiceChannel[cl.UserID]
	if !ok {
		h.mu.Unlock()
		if ack {
			h.pushEvent(cl, &types.WsEvent{Event: types.WsEventAck})
		}
		return
	}

	delete(h.userVoiceChannel, cl.UserID)
	delete(h.voiceStatusByUser, cl.UserID)
	participants := h.voiceParticipants[channelID]
	if participants != nil {
		delete(participants, cl.UserID)
		if len(participants) == 0 {
			delete(h.voiceParticipants, channelID)
		}
	}

	notifyUsers := make([]int, 0, len(participants))
	for userID := range participants {
		notifyUsers = append(notifyUsers, userID)
	}
	h.mu.Unlock()

	ctx := context.Background()
	channel, err := h.storage.GetChannelByID(ctx, channelID)
	if err != nil {
		h.log.Warn("failed to resolve channel for voice leave broadcast", "channel_id", channelID, "err", err)
	} else if channel != nil {
		serverOnlineUserIDs, err := h.listOnlineServerUserIDs(ctx, channel.ServerID, cl.UserID)
		if err != nil {
			h.log.Warn("failed to resolve online users for voice leave broadcast", "server_id", channel.ServerID, "err", err)
		} else {
			notifyUsers = serverOnlineUserIDs
		}
	}

	h.pushToUsers(notifyUsers, &types.WsEvent{
		Event: types.WsEventVoiceUserLeft,
		Data: types.WsVoiceUserEvent{
			ChannelID: channelID,
			User:      types.WsVoiceParticipant{UserID: cl.UserID},
		},
	})

	if ack {
		h.pushEvent(cl, &types.WsEvent{
			Event: types.WsEventAck,
			Data:  map[string]any{"channel_id": channelID},
		})
	}
}

func (h *Hub) resolveVoiceParticipant(ctx context.Context, userID int) types.WsVoiceParticipant {
	userVoiceStatus := voiceStatus{micEnabled: true, deafened: false}

	h.mu.RLock()
	if status, ok := h.voiceStatusByUser[userID]; ok {
		userVoiceStatus.micEnabled = status.micEnabled
		userVoiceStatus.deafened = status.deafened
	}
	h.mu.RUnlock()

	participant := types.WsVoiceParticipant{UserID: userID, MicEnabled: userVoiceStatus.micEnabled, Deafened: userVoiceStatus.deafened}
	user, err := h.storage.GetUserByID(ctx, userID)
	if err != nil || user == nil {
		return participant
	}

	participant.FirstName = user.FirstName
	participant.LastName = user.LastName
	participant.AvatarURL = utils.AvatarURLFromKey(user.AvatarKey, h.s3Host)
	return participant
}

func normalizeChannelType(raw string) string {
	switch raw {
	case "", types.ChannelTypeText:
		return types.ChannelTypeText
	case types.ChannelTypeVoice:
		return types.ChannelTypeVoice
	default:
		return ""
	}
}

func (h *Hub) searchServers(req wsCommandRequest, ctx context.Context) {
	var payload types.WsSearchServersRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid search_servers payload")
		return
	}

	payload.Query = strings.TrimSpace(payload.Query)
	if payload.Query == "" || len([]rune(payload.Query)) < 2 {
		h.pushEvent(req.client, &types.WsEvent{
			Event: types.WsEventAck,
			Data:  types.WsSearchServersResponse{Servers: []types.Server{}},
		})
		return
	}

	servers, err := h.storage.SearchServersByName(ctx, req.client.UserID, payload.Query, payload.Limit)
	if err != nil {
		h.pushError(req.client, "failed to search servers")
		return
	}

	h.pushEvent(req.client, &types.WsEvent{
		Event: types.WsEventAck,
		Data:  types.WsSearchServersResponse{Servers: servers},
	})
}
