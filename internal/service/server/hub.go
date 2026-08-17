package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/wlqoh/mini_discord.git/internal/middleware"
	"github.com/wlqoh/mini_discord.git/internal/service/embed"
	"github.com/wlqoh/mini_discord.git/internal/service/push"
	"github.com/wlqoh/mini_discord.git/types"
	"github.com/wlqoh/mini_discord.git/utils"
)

type Hub struct {
	storage              types.ServerStorage
	s3Client             types.S3ClientStorage
	s3Host               string
	pushSender           *push.Sender
	embedService         *embed.Service
	mu                   sync.RWMutex
	clientsByUser        map[int]*Client
	createServerLimiter  *middleware.TokenBucket
	createChannelLimiter *middleware.TokenBucket
	sendMessageLimiter   *middleware.TokenBucket
	markReadLimiter      *middleware.TokenBucket
	voiceParticipants    map[int64]map[int]struct{}
	userVoiceChannel     map[int]int64
	voiceStatusByUser    map[int]voiceStatus
	typingChannelByUser  map[int]int64

	jwtSecret []byte

	pendingAttachmentsMu sync.Mutex
	pendingAttachments   map[int64]*types.PendingAttachment
	nextAttachmentID     atomic.Int64

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
const maxAttachmentsPerMessage = 10
const maxMentionsPerMessage = 50
const everyoneMentionToken = "@everyone"
const maxMessageContentLen = 4000
const maxEditWindow = 15 * time.Minute

var mentionTokenRegex = regexp.MustCompile(`<@(\d+)>`)

func NewHub(storage types.ServerStorage, s3Client types.S3ClientStorage, log *slog.Logger, s3Host string, jwtSecret []byte, pushSender *push.Sender, embedService *embed.Service) *Hub {
	return &Hub{
		storage:              storage,
		s3Client:             s3Client,
		s3Host:               strings.TrimSpace(s3Host),
		pushSender:           pushSender,
		embedService:         embedService,
		clientsByUser:        make(map[int]*Client),
		createServerLimiter:  middleware.NewTokenBucket(5.0/60.0, 5.0),
		createChannelLimiter: middleware.NewTokenBucket(5.0/60.0, 5.0),
		sendMessageLimiter:   middleware.NewTokenBucket(1.0, 1.0),
		markReadLimiter:      middleware.NewTokenBucket(2.0, 10.0),
		voiceParticipants:    make(map[int64]map[int]struct{}),
		jwtSecret:            jwtSecret,
		userVoiceChannel:     make(map[int]int64),
		voiceStatusByUser:    make(map[int]voiceStatus),
		typingChannelByUser:  make(map[int]int64),
		pendingAttachments:   make(map[int64]*types.PendingAttachment),
		log:                  log,
		Register:             make(chan *Client),
		Unregister:           make(chan *Client),
		Commands:             make(chan wsCommandRequest, 64),
	}
}

func (h *Hub) StorePendingAttachment(pa types.PendingAttachment) int64 {
	id := h.nextAttachmentID.Add(1)
	pa.ID = id
	h.pendingAttachmentsMu.Lock()
	h.pendingAttachments[id] = &pa
	h.pendingAttachmentsMu.Unlock()
	return id
}

func (h *Hub) TakePendingAttachment(id int64, userID int) (*types.PendingAttachment, bool) {
	h.pendingAttachmentsMu.Lock()
	pa, ok := h.pendingAttachments[id]
	if !ok {
		h.pendingAttachmentsMu.Unlock()
		return nil, false
	}
	if pa.UserID != userID {
		h.pendingAttachmentsMu.Unlock()
		return nil, false
	}
	delete(h.pendingAttachments, id)
	h.pendingAttachmentsMu.Unlock()
	return pa, true
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
		h.stopTypingOnDisconnect(cl)
	}
}

func (h *Hub) stopTypingOnDisconnect(cl *Client) {
	h.mu.Lock()
	typingChannelID, wasTyping := h.typingChannelByUser[cl.UserID]
	delete(h.typingChannelByUser, cl.UserID)
	h.mu.Unlock()

	if !wasTyping {
		return
	}

	ctx := context.Background()
	recipients, err := h.storage.ListChannelMemberUserIDs(ctx, typingChannelID)
	if err != nil {
		return
	}

	filtered := recipients[:0:0]
	for _, id := range recipients {
		if id != cl.UserID {
			filtered = append(filtered, id)
		}
	}

	h.pushToUsers(filtered, &types.WsEvent{
		Event: types.WsEventTypingStop,
		Data:  types.WsTypingEvent{ChannelID: typingChannelID, UserID: cl.UserID},
	})
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
	case types.WsActionDeleteMessage:
		h.deleteMessage(req, ctx)
	case types.WsActionEditMessage:
		h.editMessage(req, ctx)
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
	case types.WsActionGetUserInfo:
		h.getUserInfo(req, ctx)
	case types.WsActionChangeVoiceStatus:
		h.changeVoiceStatus(req, ctx)
	case types.WsActionTypingStart:
		h.handleTyping(req, ctx, true)
	case types.WsActionTypingStop:
		h.handleTyping(req, ctx, false)
	case types.WsActionGetUnread:
		h.getUnread(req, ctx)
	case types.WsActionMarkRead:
		h.markRead(req, ctx)
	case types.WsActionGetServerMembers:
		h.getServerMembers(req, ctx)
	case types.WsActionGetMessagesAround:
		// Read-only and independent of hub state, so unlike every other case
		// here it runs off the Run() loop instead of blocking it — see the
		// comment on searchMessages below for why that's safe.
		go h.getMessagesAround(req, ctx)
	case types.WsActionGetMessagesAfter:
		go h.getMessagesAfter(req, ctx)
	case types.WsActionSearchMessages:
		// The only command whose latency is inherently unpredictable (full-text
		// scan across an arbitrary date range): running it synchronously would
		// stall send_message/typing/rtc_signal for every other connected client
		// until the query returns. Safe to hand off because pushEvent takes
		// h.mu.RLock before touching clientsByUser, and unregisterClient closes
		// Outbound under the paired write lock — so a client that disconnects
		// mid-search can't race this goroutine into a send-on-closed-channel
		// panic.
		go h.searchMessages(req, ctx)

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

	userID := req.client.UserID

	h.mu.Lock()
	channelID, inVoice := h.userVoiceChannel[userID]
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

	h.voiceStatusByUser[userID] = voiceStatus{
		micEnabled: payload.MicEnabled,
		deafened:   payload.Deafened,
	}

	notifyUsers := make([]int, 0, len(participants))
	for userID := range participants {
		notifyUsers = append(notifyUsers, userID)
	}
	h.mu.Unlock()

	updatedParticipant := h.resolveVoiceParticipant(ctx, userID)
	h.pushToUsers(notifyUsers, &types.WsEvent{
		Event: types.WsEventVoiceStatusChanged,
		Data: types.WsVoiceUserEvent{
			ChannelID: channelID,
			User:      updatedParticipant,
		},
	})

	h.pushEvent(req.client, &types.WsEvent{Event: types.WsEventAck})
}

func (h *Hub) handleTyping(req wsCommandRequest, ctx context.Context, start bool) {
	var payload types.WsTypingRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		return
	}
	if payload.ChannelID <= 0 {
		return
	}

	canAccess, err := h.storage.CanUserAccessChannel(ctx, req.client.UserID, payload.ChannelID)
	if err != nil || !canAccess {
		return
	}

	h.mu.Lock()
	if start {
		h.typingChannelByUser[req.client.UserID] = payload.ChannelID
	} else {
		delete(h.typingChannelByUser, req.client.UserID)
	}
	h.mu.Unlock()

	recipientUserIDs, err := h.storage.ListChannelMemberUserIDs(ctx, payload.ChannelID)
	if err != nil {
		return
	}

	filtered := recipientUserIDs[:0:0]
	for _, id := range recipientUserIDs {
		if id != req.client.UserID {
			filtered = append(filtered, id)
		}
	}

	event := types.WsEventTypingStart
	if !start {
		event = types.WsEventTypingStop
	}
	h.pushToUsers(filtered, &types.WsEvent{
		Event: event,
		Data:  types.WsTypingEvent{ChannelID: payload.ChannelID, UserID: req.client.UserID},
	})
}

func (h *Hub) getUnread(req wsCommandRequest, ctx context.Context) {
	counts, err := h.storage.GetUnreadCounts(ctx, req.client.UserID)
	if err != nil {
		h.pushError(req.client, "failed to get unread counts")
		return
	}

	h.pushEvent(req.client, &types.WsEvent{
		Event: types.WsEventAck,
		Data:  types.WsGetUnreadResponse{Channels: counts},
	})
}

// markRead is fire-and-forget: no ack, no error events — the client sends it
// outside the ack queue, so any response here would resolve an unrelated command.
func (h *Hub) markRead(req wsCommandRequest, ctx context.Context) {
	var payload types.WsMarkReadRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		return
	}
	if payload.ChannelID <= 0 || payload.MessageID <= 0 {
		return
	}
	if !h.markReadLimiter.Allow(strconv.Itoa(req.client.UserID)) {
		return
	}

	canAccess, err := h.storage.CanUserAccessChannel(ctx, req.client.UserID, payload.ChannelID)
	if err != nil || !canAccess {
		return
	}

	if err := h.storage.MarkChannelRead(ctx, req.client.UserID, payload.ChannelID, payload.MessageID); err != nil {
		h.log.Warn("failed to mark channel read", "user_id", req.client.UserID, "channel_id", payload.ChannelID, "err", err)
	}
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

// isCriticalVoiceEvent identifies events whose silent loss leaves a client in
// a state it cannot recover from on its own: a missed rtc_signal breaks one
// P2P link forever, and a missed voice_user_joined/left/status_changed
// desyncs the client's view of who's in the call from the server's.
func isCriticalVoiceEvent(event string) bool {
	switch event {
	case types.WsEventRTCSignal,
		types.WsEventVoiceUserJoined,
		types.WsEventVoiceUserLeft,
		types.WsEventVoiceStatusChanged:
		return true
	}
	return false
}

func (h *Hub) enqueueEvent(cl *Client, event *types.WsEvent) {
	if event == nil {
		return
	}

	select {
	case cl.Outbound <- event:
		return
	default:
	}

	if !isCriticalVoiceEvent(event.Event) {
		h.log.Debug("drop websocket event: outbound queue full", "event", event.Event, "user_id", cl.UserID)
		return
	}

	// The outbound queue is full and this event can't be silently dropped:
	// the client would end up with a peer it never learns about, or a
	// signaling message that permanently breaks one P2P link. Closing the
	// connection is the correct response — the client's own reconnect logic
	// (see ChatSocket) reconnects and pulls a fresh, consistent snapshot,
	// which a half-delivered event stream never would.
	h.log.Warn("closing slow client: critical event would be dropped", "user_id", cl.UserID, "event", event.Event)
	_ = cl.Conn.Close()
}

func (h *Hub) pushError(cl *Client, message string) {
	h.pushEvent(cl, &types.WsEvent{Event: types.WsEventError, Error: message})
}

// pushErrorWithRequestID is pushError plus the request_id echo. Used only by
// handlers dispatched off the Run() loop (search_messages, get_messages_around,
// get_messages_after) — see the RequestID field comment on types.WsCommand for
// why the rest of the hub doesn't need this.
func (h *Hub) pushErrorWithRequestID(cl *Client, requestID, message string) {
	h.pushEvent(cl, &types.WsEvent{Event: types.WsEventError, Error: message, RequestID: requestID})
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

// getServerMembers backs the @-mention autocomplete: unlike get_users_online
// it returns every member (not just online ones) together with their user_id,
// which get_users_online's response shape does not carry.
func (h *Hub) getServerMembers(req wsCommandRequest, ctx context.Context) {
	var payload types.WsGetServerMembersRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid get_server_members payload")
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

	members, err := h.storage.ListServerMembers(ctx, payload.ServerID, h.s3Host)
	if err != nil {
		h.pushError(req.client, "failed to resolve server members")
		return
	}

	h.pushEvent(req.client, &types.WsEvent{
		Event: types.WsEventAck,
		Data:  types.WsGetServerMembersResponse{Members: members},
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
				Nickname:  user.Nickname,
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

// resolveMentions extracts <@id> tokens from message content and validates
// each id against the channel's actual recipients — a hand-crafted mention of
// a non-member is dropped silently rather than trusted. @everyone is only
// honored for the server owner to prevent it being used as a spam tool.
func (h *Hub) resolveMentions(ctx context.Context, content string, authorID int, channelID int64, recipientUserIDs []int) ([]int, bool) {
	memberSet := make(map[int]struct{}, len(recipientUserIDs))
	for _, id := range recipientUserIDs {
		memberSet[id] = struct{}{}
	}

	seen := make(map[int]struct{})
	var mentioned []int
	for _, match := range mentionTokenRegex.FindAllStringSubmatch(content, -1) {
		if len(mentioned) >= maxMentionsPerMessage {
			break
		}
		id, err := strconv.Atoi(match[1])
		if err != nil || id == authorID {
			continue
		}
		if _, ok := memberSet[id]; !ok {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		mentioned = append(mentioned, id)
	}

	everyone := false
	if strings.Contains(content, everyoneMentionToken) {
		isOwner, err := h.storage.IsChannelServerOwner(ctx, authorID, channelID)
		if err == nil && isOwner {
			everyone = true
		}
	}

	return mentioned, everyone
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
	if payload.ChannelID <= 0 {
		h.pushError(req.client, "channel_id is required")
		return
	}
	if payload.Content == "" && len(payload.AttachmentIDs) == 0 && (payload.ReplyToID == nil || *payload.ReplyToID <= 0) {
		h.pushError(req.client, "content, attachment_ids, or reply_to_id are required")
		return
	}
	if utf8.RuneCountInString(payload.Content) > maxMessageContentLen {
		h.pushError(req.client, "content is too long")
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

	var replyTo *types.WsReplyTo
	if payload.ReplyToID != nil && *payload.ReplyToID > 0 {
		rt, err := h.storage.GetReplyPreview(ctx, *payload.ReplyToID)
		if err != nil {
			h.pushError(req.client, "failed to resolve reply target")
			return
		}
		if rt == nil {
			h.pushError(req.client, "reply target message not found")
			return
		}
		if rt.ChannelID != payload.ChannelID {
			h.pushError(req.client, "reply target must be in the same channel")
			return
		}
		replyTo = rt
	}

	var pendingAtts []*types.PendingAttachment
	if len(payload.AttachmentIDs) > 0 {
		if len(payload.AttachmentIDs) > maxAttachmentsPerMessage {
			h.pushError(req.client, "too many attachments (max 10)")
			return
		}
		for _, id := range payload.AttachmentIDs {
			pa, ok := h.TakePendingAttachment(id, req.client.UserID)
			if !ok {
				h.pushError(req.client, "attachment not found: "+strconv.FormatInt(id, 10))
				return
			}
			pendingAtts = append(pendingAtts, pa)
		}
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

	mentionedUserIDs, mentionsEveryone := h.resolveMentions(ctx, payload.Content, req.client.UserID, payload.ChannelID, recipientUserIDs)

	content := payload.Content
	if content == "" {
		content = " "
	}

	msg := &types.WsMessage{
		ChannelID:        payload.ChannelID,
		AuthorID:         req.client.UserID,
		AuthorFirstName:  user.FirstName,
		AuthorLastName:   user.LastName,
		AuthorNickname:   user.Nickname,
		AuthorAvatarURL:  utils.AvatarURLFromKey(user.AvatarKey, h.s3Host),
		Content:          content,
		ReplyToID:        payload.ReplyToID,
		ReplyTo:          replyTo,
		Mentions:         mentionedUserIDs,
		MentionsEveryone: mentionsEveryone,
		CreatedAt:        time.Now().UTC(),
	}
	if err := h.storage.SaveMessage(ctx, msg); err != nil {
		h.pushError(req.client, "failed to save message")
		return
	}

	if len(mentionedUserIDs) > 0 {
		if err := h.storage.SaveMessageMentions(ctx, msg.ID, mentionedUserIDs); err != nil {
			h.log.Error("failed to save message mentions", "message_id", msg.ID, "error", err.Error())
		}
	}

	if len(pendingAtts) > 0 {
		var attachments []types.Attachment
		for _, pa := range pendingAtts {
			attachments = append(attachments, types.Attachment{
				MessageID:   msg.ID,
				FileKey:     pa.FileKey,
				FileName:    pa.FileName,
				ContentType: pa.ContentType,
				SizeBytes:   pa.SizeBytes,
			})
		}
		if err := h.storage.SaveMessageAttachments(ctx, msg.ID, attachments); err != nil {
			h.log.Error("failed to save attachments, deleting message", "message_id", msg.ID, "error", err.Error())
			if _, delErr := h.storage.DeleteMessage(ctx, msg.ID, user.ID); delErr != nil {
				h.log.Error("failed to delete message after attachment save failure", "message_id", msg.ID, "error", delErr.Error())
			}
			h.pushError(req.client, "failed to save attachments")
			return
		}
		for i, pa := range pendingAtts {
			url := utils.AvatarURLFromKey(pa.FileKey, h.s3Host)
			attachments[i].URL = url
			attachments[i].ID = 0
		}
		msg.Attachments = attachments
	}

	if msg.Content == " " {
		msg.Content = ""
	}

	event := &types.WsEvent{Event: types.WsEventMessage, Data: msg}
	h.pushToUsers(recipientUserIDs, event)
	h.enqueuePush(ctx, payload.ChannelID, recipientUserIDs, msg, replyTo)
	h.enqueueEmbeds(payload.ChannelID, recipientUserIDs, msg)

	h.pushEvent(req.client, &types.WsEvent{Event: types.WsEventAck})
}

// enqueueEmbeds отдаёт сообщение конвейеру превью. Как и push, это
// best-effort поверх уже сохранённого и разосланного сообщения — здесь нельзя
// ни блокироваться, ни возвращать ошибку: мы в единственной горутине хаба.
func (h *Hub) enqueueEmbeds(channelID int64, recipientUserIDs []int, msg *types.WsMessage) {
	if h.embedService == nil || msg.Content == "" {
		return
	}

	h.embedService.Enqueue(embed.Job{
		MessageID:    msg.ID,
		ChannelID:    channelID,
		AuthorID:     msg.AuthorID,
		Content:      msg.Content,
		RecipientIDs: recipientUserIDs,
	})
}

// BroadcastEmbeds вызывается из горутины воркера превью, а не из Hub.Run().
// Это безопасно: pushToUsers работает под RWMutex, а enqueueEvent не блокирует
// отправителя — переполненная очередь клиента просто теряет событие.
func (h *Hub) BroadcastEmbeds(channelID, messageID int64, recipientIDs []int, embeds []types.WsLinkPreview) {
	if len(embeds) == 0 {
		return
	}

	h.pushToUsers(recipientIDs, &types.WsEvent{
		Event: types.WsEventMessageEmbeds,
		Data: types.WsMessageEmbedsEvent{
			ChannelID: channelID,
			MessageID: messageID,
			Embeds:    embeds,
		},
	})
}

// enqueuePush hands the message off to the push.Sender for offline
// recipients. Non-fatal on any failure here — the message has already been
// saved and broadcast over WS; push is best-effort on top of that.
func (h *Hub) enqueuePush(ctx context.Context, channelID int64, recipientUserIDs []int, msg *types.WsMessage, replyTo *types.WsReplyTo) {
	if h.pushSender == nil {
		return
	}

	channel, err := h.storage.GetChannelByID(ctx, channelID)
	if err != nil || channel == nil {
		h.log.Error("failed to resolve channel for push", "channel_id", channelID)
		return
	}

	isMention := make(map[int]bool, len(recipientUserIDs))
	for _, userID := range msg.Mentions {
		isMention[userID] = true
	}
	if replyTo != nil {
		isMention[replyTo.AuthorID] = true
	}
	if msg.MentionsEveryone {
		for _, userID := range recipientUserIDs {
			isMention[userID] = true
		}
	}

	h.mu.RLock()
	onlineIDs := make(map[int]bool, len(h.clientsByUser))
	for userID := range h.clientsByUser {
		onlineIDs[userID] = true
	}
	h.mu.RUnlock()

	h.pushSender.Enqueue(push.Event{
		RecipientIDs: recipientUserIDs,
		ChannelID:    channelID,
		ServerID:     channel.ServerID,
		ChannelName:  channel.Name,
		Message:      msg,
		IsMention:    isMention,
		OnlineIDs:    onlineIDs,
	})
}

func (h *Hub) deleteMessage(req wsCommandRequest, ctx context.Context) {
	var payload types.WsDeleteMessageRequest

	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid delete_message payload")
		return
	}

	if payload.MessageID <= 0 {
		h.pushError(req.client, "message_id is required")
		return
	}

	fileKeys, err := h.storage.DeleteMessage(ctx, payload.MessageID, req.client.UserID)
	if err != nil {
		h.pushError(req.client, err.Error())
		return
	}

	err = h.s3Client.DeleteAttachment(ctx, fileKeys)
	if err != nil {
		h.pushError(req.client, err.Error())
		return
	}
}

func (h *Hub) editMessage(req wsCommandRequest, ctx context.Context) {
	// Отдельного лимитера нет намеренно: правка стоит столько же, сколько
	// отправка, и делит с ней бюджет пользователя.
	if !h.sendMessageLimiter.Allow(strconv.Itoa(req.client.UserID)) {
		h.pushError(req.client, "rate limit exceeded for edit_message")
		return
	}

	var payload types.WsEditMessageRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid edit_message payload")
		return
	}
	if payload.MessageID <= 0 {
		h.pushError(req.client, "message_id is required")
		return
	}

	payload.Content = strings.TrimSpace(payload.Content)
	if utf8.RuneCountInString(payload.Content) > maxMessageContentLen {
		h.pushError(req.client, "content is too long")
		return
	}

	channelID, editedAt, err := h.storage.EditMessage(
		ctx, payload.MessageID, req.client.UserID, payload.Content, maxEditWindow,
	)
	if err != nil {
		switch {
		case errors.Is(err, types.ErrMessageNotFound),
			errors.Is(err, types.ErrNotMessageOwner),
			errors.Is(err, types.ErrEditWindowExpired),
			errors.Is(err, types.ErrEmptyContent):
			h.pushError(req.client, err.Error())
		default:
			h.log.Error("failed to edit message",
				"message_id", payload.MessageID, "error", err.Error())
			h.pushError(req.client, "failed to edit message")
		}
		return
	}

	recipientUserIDs, err := h.storage.ListChannelMemberUserIDs(ctx, channelID)
	if err != nil {
		// Текст уже сохранён — откатывать нечего. Подтверждаем автору и
		// молчим для остальных: они увидят правку при следующей загрузке.
		h.log.Error("failed to resolve channel members for edit",
			"channel_id", channelID, "error", err.Error())
		h.pushEvent(req.client, &types.WsEvent{Event: types.WsEventAck})
		return
	}

	h.pushToUsers(recipientUserIDs, &types.WsEvent{
		Event: types.WsEventMessageEdited,
		Data: types.WsMessageEditedEvent{
			MessageID: payload.MessageID,
			ChannelID: channelID,
			Content:   payload.Content,
			EditedAt:  editedAt,
		},
	})

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

func (h *Hub) getMessagesAfter(req wsCommandRequest, ctx context.Context) {
	requestID := req.command.RequestID
	var payload types.WsGetMessagesAfterRequest

	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushErrorWithRequestID(req.client, requestID, "invalid get_messages_after payload")
		return
	}
	if payload.ChannelID <= 0 {
		h.pushErrorWithRequestID(req.client, requestID, "channel_id is required")
		return
	}

	cursor, err := types.DecodeWsMessageCursor(payload.Cursor)
	if err != nil || cursor == nil {
		h.pushErrorWithRequestID(req.client, requestID, "invalid cursor")
		return
	}
	if cursor.ChannelID != payload.ChannelID {
		h.pushErrorWithRequestID(req.client, requestID, "cursor channel mismatch")
		return
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	canAccess, err := h.storage.CanUserAccessChannel(ctx, req.client.UserID, payload.ChannelID)
	if err != nil {
		h.pushErrorWithRequestID(req.client, requestID, "failed to check channel access")
		return
	}
	if !canAccess {
		h.pushErrorWithRequestID(req.client, requestID, "access denied")
		return
	}

	messages, nextCursor, hasMore, err := h.storage.GetMessagesAfter(ctx, payload.ChannelID, payload.Limit, cursor, h.s3Host)
	if err != nil {
		h.pushErrorWithRequestID(req.client, requestID, "failed to get messages")
		return
	}

	var nextCursorRaw string
	if nextCursor != nil {
		nextCursorRaw, err = types.EncodeWsMessageCursor(*nextCursor)
		if err != nil {
			h.pushErrorWithRequestID(req.client, requestID, "failed to encode cursor")
			return
		}
	}

	h.pushEvent(req.client, &types.WsEvent{
		Event:     types.WsEventAck,
		RequestID: requestID,
		Data: map[string]any{
			"channel_id":  payload.ChannelID,
			"messages":    messages,
			"next_cursor": nextCursorRaw,
			"has_more":    hasMore,
		},
	})
}

// getMessagesAround serves both the "jump to a search hit" and the "jump to a
// reply/notification target" cases: it opens a two-sided window around an
// arbitrary message id instead of requiring the caller to already have it
// loaded, which GetMessages (backward-only) cannot do.
func (h *Hub) getMessagesAround(req wsCommandRequest, ctx context.Context) {
	requestID := req.command.RequestID
	var payload types.WsGetMessagesAroundRequest

	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushErrorWithRequestID(req.client, requestID, "invalid get_messages_around payload")
		return
	}
	if payload.ChannelID <= 0 || payload.MessageID <= 0 {
		h.pushErrorWithRequestID(req.client, requestID, "channel_id and message_id are required")
		return
	}

	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	canAccess, err := h.storage.CanUserAccessChannel(ctx, req.client.UserID, payload.ChannelID)
	if err != nil {
		h.pushErrorWithRequestID(req.client, requestID, "failed to check channel access")
		return
	}
	if !canAccess {
		h.pushErrorWithRequestID(req.client, requestID, "access denied")
		return
	}

	messages, olderCursor, newerCursor, hasMoreOlder, hasMoreNewer, err := h.storage.GetMessagesAround(ctx, payload.ChannelID, payload.MessageID, payload.Limit, h.s3Host)
	if err != nil {
		h.pushErrorWithRequestID(req.client, requestID, err.Error())
		return
	}

	var olderCursorRaw, newerCursorRaw string
	if olderCursor != nil {
		olderCursorRaw, err = types.EncodeWsMessageCursor(*olderCursor)
		if err != nil {
			h.pushErrorWithRequestID(req.client, requestID, "failed to encode cursor")
			return
		}
	}
	if newerCursor != nil {
		newerCursorRaw, err = types.EncodeWsMessageCursor(*newerCursor)
		if err != nil {
			h.pushErrorWithRequestID(req.client, requestID, "failed to encode cursor")
			return
		}
	}

	h.pushEvent(req.client, &types.WsEvent{
		Event:     types.WsEventAck,
		RequestID: requestID,
		Data: types.WsGetMessagesAroundResponse{
			ChannelID:    payload.ChannelID,
			Messages:     messages,
			OlderCursor:  olderCursorRaw,
			NewerCursor:  newerCursorRaw,
			HasMoreOlder: hasMoreOlder,
			HasMoreNewer: hasMoreNewer,
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

// pushRTCSignalError reports a rtc_signal validation failure. It deliberately
// uses a dedicated event type instead of pushError/WsEventError: rtc_signal
// is sent fire-and-forget (it bypasses the client's request/ack queue), so a
// plain "error" event here would be misattributed to whatever unrelated
// command the client happens to be awaiting (e.g. rejecting a perfectly
// successful join_voice_channel because of a stale rtc_signal race).
func (h *Hub) pushRTCSignalError(cl *Client, message string) {
	h.pushEvent(cl, &types.WsEvent{Event: types.WsEventRTCSignalError, Error: message})
}

func (h *Hub) relayRTCSignal(req wsCommandRequest, ctx context.Context) {
	var payload types.WsRTCSignalRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushRTCSignalError(req.client, "invalid rtc_signal payload")
		return
	}

	payload.SignalType = strings.TrimSpace(strings.ToLower(payload.SignalType))
	if payload.ChannelID <= 0 || payload.ToUserID <= 0 || payload.SignalType == "" {
		h.pushRTCSignalError(req.client, "channel_id, to_user_id and signal_type are required")
		return
	}
	if payload.SignalType != "offer" && payload.SignalType != "answer" && payload.SignalType != "candidate" {
		h.pushRTCSignalError(req.client, "unsupported signal_type")
		return
	}

	canAccess, err := h.storage.CanUserAccessChannel(ctx, req.client.UserID, payload.ChannelID)
	if err != nil {
		h.pushRTCSignalError(req.client, "failed to check channel access")
		return
	}
	if !canAccess {
		h.pushRTCSignalError(req.client, "access denied")
		return
	}

	h.mu.RLock()
	senderChannelID, senderInVoice := h.userVoiceChannel[req.client.UserID]
	targetChannelID, targetInVoice := h.userVoiceChannel[payload.ToUserID]
	targetClient, targetConnected := h.clientsByUser[payload.ToUserID]
	h.mu.RUnlock()

	if !senderInVoice || senderChannelID != payload.ChannelID {
		h.pushRTCSignalError(req.client, "join voice channel before signaling")
		return
	}
	if !targetInVoice || targetChannelID != payload.ChannelID || !targetConnected {
		h.pushRTCSignalError(req.client, "recipient not in channel")
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
	participant.Nickname = user.Nickname
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

// searchMessages resolves a search_messages command. Runs off Run() (see the
// dispatch comment in handleCommand) since a full-text scan across an
// arbitrary date range has no bounded latency the way the rest of the hub's
// commands do.
func (h *Hub) searchMessages(req wsCommandRequest, ctx context.Context) {
	requestID := req.command.RequestID
	var payload types.WsSearchMessagesRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushErrorWithRequestID(req.client, requestID, "invalid search_messages payload")
		return
	}

	payload.Query = strings.TrimSpace(payload.Query)
	if len([]rune(payload.Query)) < 2 {
		h.pushEvent(req.client, &types.WsEvent{
			Event:     types.WsEventAck,
			RequestID: requestID,
			Data:      types.WsSearchMessagesResponse{Hits: []types.WsMessageSearchHit{}},
		})
		return
	}

	if payload.ServerID <= 0 && payload.ChannelID <= 0 {
		h.pushErrorWithRequestID(req.client, requestID, "channel_id or server_id is required")
		return
	}

	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	// Scope determines which access check applies: a server-wide search is
	// gated on membership, a single-channel search on that channel's access —
	// checked before the query runs, not inferred from its results.
	if payload.ServerID > 0 {
		isMember, err := h.storage.IsServerMember(ctx, req.client.UserID, payload.ServerID)
		if err != nil {
			h.pushErrorWithRequestID(req.client, requestID, "failed to check server membership")
			return
		}
		if !isMember {
			h.pushErrorWithRequestID(req.client, requestID, "access denied")
			return
		}
	} else {
		canAccess, err := h.storage.CanUserAccessChannel(ctx, req.client.UserID, payload.ChannelID)
		if err != nil {
			h.pushErrorWithRequestID(req.client, requestID, "failed to check channel access")
			return
		}
		if !canAccess {
			h.pushErrorWithRequestID(req.client, requestID, "access denied")
			return
		}
	}

	params := types.MessageSearchParams{
		Query:     payload.Query,
		ChannelID: payload.ChannelID,
		ServerID:  payload.ServerID,
		AuthorID:  payload.AuthorID,
		HasFile:   payload.HasFile,
		HasLink:   payload.HasLink,
		Limit:     payload.Limit,
	}

	if payload.Before != nil {
		t, err := time.Parse(time.RFC3339, *payload.Before)
		if err != nil {
			h.pushErrorWithRequestID(req.client, requestID, "invalid before date")
			return
		}
		params.Before = &t
	}
	if payload.After != nil {
		t, err := time.Parse(time.RFC3339, *payload.After)
		if err != nil {
			h.pushErrorWithRequestID(req.client, requestID, "invalid after date")
			return
		}
		params.After = &t
	}

	// At server scope the cursor's channel_id belongs to whichever channel
	// produced the last page's final hit, not the search's own scope, so
	// unlike get_messages there is nothing here to cross-check it against.
	cursor, err := types.DecodeWsMessageCursor(payload.Cursor)
	if err != nil {
		h.pushErrorWithRequestID(req.client, requestID, "invalid cursor")
		return
	}
	params.Cursor = cursor

	hits, nextCursor, hasMore, err := h.storage.SearchMessages(ctx, params, h.s3Host)
	if err != nil {
		h.pushErrorWithRequestID(req.client, requestID, "search failed")
		return
	}

	var nextCursorRaw string
	if nextCursor != nil {
		nextCursorRaw, err = types.EncodeWsMessageCursor(*nextCursor)
		if err != nil {
			h.pushErrorWithRequestID(req.client, requestID, "failed to encode cursor")
			return
		}
	}

	// Query text is user message content — never logged, only its length.
	h.log.Info("ws search_messages", "user_id", req.client.UserID, "query_len", len(payload.Query), "hits", len(hits))

	h.pushEvent(req.client, &types.WsEvent{
		Event:     types.WsEventAck,
		RequestID: requestID,
		Data: types.WsSearchMessagesResponse{
			Hits:       hits,
			NextCursor: nextCursorRaw,
			HasMore:    hasMore,
		},
	})
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

func (h *Hub) getUserInfo(req wsCommandRequest, ctx context.Context) {
	var payload types.WsGetUserInfoRequest
	if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
		h.pushError(req.client, "invalid get_users_online payload")
		return
	}
	if payload.UserID <= 0 {
		h.pushError(req.client, "server_id is required")
		return
	}

	user, err := h.storage.GetUserByID(ctx, payload.UserID)
	if err != nil {
		h.pushError(req.client, "failed to resolve user info")
		return
	}

	if user == nil {
		h.pushError(req.client, "user not found")
		return
	}

	h.pushEvent(req.client, &types.WsEvent{
		Event: types.WsEventAck,
		Data: types.WsGetUserInfoResponse{
			UserID:    user.ID,
			FirstName: user.FirstName,
			LastName:  user.LastName,
			Nickname:  user.Nickname,
			AvatarURL: utils.AvatarURLFromKey(user.AvatarKey, h.s3Host),
		},
	})
}
