package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/wlqoh/mini_discord.git/types"
)

type Hub struct {
	storage       types.ServerStorage
	mu            sync.RWMutex
	clientsByUser map[int]*Client

	log *slog.Logger

	Register   chan *Client
	Unregister chan *Client
	Commands   chan wsCommandRequest
}

type wsCommandRequest struct {
	client  *Client
	command types.WsCommand
}

func NewHub(storage types.ServerStorage, log *slog.Logger) *Hub {
	return &Hub{
		storage:       storage,
		clientsByUser: make(map[int]*Client),
		log:           log,
		Register:      make(chan *Client),
		Unregister:    make(chan *Client),
		Commands:      make(chan wsCommandRequest, 64),
	}
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
	h.mu.Lock()
	if current, ok := h.clientsByUser[cl.UserID]; ok && current == cl {
		delete(h.clientsByUser, cl.UserID)
		close(cl.Outbound)
	}
	h.mu.Unlock()
}

func (h *Hub) handleCommand(req wsCommandRequest) {
	ctx := context.Background()

	switch req.command.Action {
	case types.WsActionCreateServer:
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
	case types.WsActionJoinServer:
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
	case types.WsActionCreateChannel:
		var payload types.WsCreateChannelRequest
		if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
			h.pushError(req.client, "invalid create_channel payload")
			return
		}
		payload.Name = strings.TrimSpace(payload.Name)
		if payload.ServerID <= 0 || payload.Name == "" {
			h.pushError(req.client, "server_id and name are required")
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

		channelID, err := h.storage.CreateChannel(ctx, payload.ServerID, payload.Name)
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
			},
		})
	case types.WsActionSendMessage:
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

		msg := types.WsMessage{
			ChannelID: payload.ChannelID,
			AuthorID:  req.client.UserID,
			Content:   payload.Content,
			CreatedAt: time.Now().UTC(),
		}
		if err := h.storage.SaveMessage(ctx, msg); err != nil {
			h.pushError(req.client, "failed to save message")
			return
		}

		memberIDs, err := h.storage.ListChannelMemberUserIDs(ctx, payload.ChannelID)
		if err != nil {
			h.pushError(req.client, "failed to resolve recipients")
			return
		}

		event := &types.WsEvent{Event: types.WsEventMessage, Data: msg}
		h.pushToUsers(memberIDs, event)

		h.pushEvent(req.client, &types.WsEvent{Event: types.WsEventAck})
	case types.WsActionGetMessages:
		var payload types.WsGetMessagesRequest

		if err := json.Unmarshal(req.command.Payload, &payload); err != nil {
			h.pushError(req.client, "invalid get_messages payload")
			return
		}
		if payload.ChannelID <= 0 {
			h.pushError(req.client, "channel_id is required")
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

		cursor, err := types.DecodeWsMessageCursor(payload.Cursor)
		if err != nil {
			h.pushError(req.client, "invalid cursor")
			return
		}
		if cursor != nil && cursor.ChannelID != payload.ChannelID {
			h.pushError(req.client, "cursor channel mismatch")
			return
		}

		messages, nextCursor, hasMore, err := h.storage.GetMessages(ctx, payload.ChannelID, payload.Limit, cursor)
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
	default:
		h.pushError(req.client, "unknown action")
	}
}

func (h *Hub) pushToUsers(userIDs []int, event *types.WsEvent) {
	h.mu.RLock()
	for _, userID := range userIDs {
		if cl, ok := h.clientsByUser[userID]; ok {
			select {
			case cl.Outbound <- event:
			default:
			}
		}

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
	select {
	case cl.Outbound <- event:
	default:
	}
	h.mu.RUnlock()
}

func (h *Hub) pushError(cl *Client, message string) {
	h.pushEvent(cl, &types.WsEvent{Event: types.WsEventError, Error: message})
}
