package types

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"
)

type ServerStorage interface {
	GetUserByID(ctx context.Context, id int) (*User, error)
	CreateServer(ctx context.Context, server Server) (int64, error)
	DeleteServer(ctx context.Context, serverID int64, userID int) error
	DeleteChannel(ctx context.Context, channelID int64, userID int) error
	AddMemberToServer(ctx context.Context, userID int, serverID int64) error
	CreateChannel(ctx context.Context, serverID int64, name, channelType string) (int64, error)
	IsServerMember(ctx context.Context, userID int, serverID int64) (bool, error)
	CanUserAccessChannel(ctx context.Context, userID int, channelID int64) (bool, error)
	ListChannelMemberUserIDs(ctx context.Context, channelID int64) ([]int, error)
	SaveMessage(ctx context.Context, msg WsMessage) error
	GetMessages(ctx context.Context, channelID int64, limit int, cursor *WsMessageCursor) ([]WsMessage, *WsMessageCursor, bool, error)
	GetServersByUserID(ctx context.Context, userID int) ([]Server, error)
	GetServerChannels(ctx context.Context, serverID int64) ([]Channel, error)
	GetChannelByID(ctx context.Context, channelID int64) (*Channel, error)
}

const (
	WsActionCreateServer      = "create_server"
	WsActionDeleteServer      = "delete_server"
	WsActionJoinServer        = "join_server"
	WsActionCreateChannel     = "create_channel"
	WsActionDeleteChannel     = "delete_channel"
	WsActionSendMessage       = "send_message"
	WsActionGetMessages       = "get_messages"
	WsActionGetServers        = "get_servers"
	WsActionGetServerChannels = "get_server_channels"
	WsActionJoinVoiceChannel  = "join_voice_channel"
	WsActionLeaveVoiceChannel = "leave_voice_channel"
	WsActionRTCSignal         = "rtc_signal"

	WsEventAck               = "ack"
	WsEventError             = "error"
	WsEventMessage           = "message"
	WsEventConnected         = "connected"
	WsEventVoiceParticipants = "voice_participants"
	WsEventVoiceUserJoined   = "voice_user_joined"
	WsEventVoiceUserLeft     = "voice_user_left"
	WsEventRTCSignal         = "rtc_signal"

	ChannelTypeText  = "text"
	ChannelTypeVoice = "voice"
)

type WsCommand struct {
	Action  string          `json:"action"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type WsCreateServerRequest struct {
	Name string `json:"name"`
}

type WsDeleteServerRequest struct {
	ServerID int64 `json:"server_id"`
}

type WsJoinServerRequest struct {
	ServerID int64 `json:"server_id"`
}

type WsCreateChannelRequest struct {
	ServerID int64  `json:"server_id"`
	Name     string `json:"name"`
	Type     string `json:"type,omitempty"`
}

type WsDeleteChannelRequest struct {
	ChannelID int64 `json:"channel_id"`
}

type WsSendMessageRequest struct {
	ChannelID int64  `json:"channel_id"`
	Content   string `json:"content"`
}

type WsGetMessagesRequest struct {
	ChannelID int64  `json:"channel_id"`
	Limit     int    `json:"limit"`
	Cursor    string `json:"cursor,omitempty"`
}

type WsGetServersResponse struct {
	Servers []Server `json:"servers"`
}

type WsGetServerChannelsRequest struct {
	ServerID int64 `json:"server_id"`
}

type WsGetChannelsResponse struct {
	Channels []Channel `json:"channels"`
}

type WsJoinVoiceChannelRequest struct {
	ChannelID int64 `json:"channel_id"`
}

type WsVoiceParticipant struct {
	UserID    int    `json:"user_id"`
	FirstName string `json:"first_name,omitempty"`
	LastName  string `json:"last_name,omitempty"`
}

type WsJoinVoiceChannelResponse struct {
	ChannelID    int64                `json:"channel_id"`
	Participants []WsVoiceParticipant `json:"participants"`
}

type WsVoiceUserEvent struct {
	ChannelID int64              `json:"channel_id"`
	User      WsVoiceParticipant `json:"user"`
}

type WsRTCSignalRequest struct {
	ChannelID     int64   `json:"channel_id"`
	ToUserID      int     `json:"to_user_id"`
	SignalType    string  `json:"signal_type"`
	SDP           string  `json:"sdp,omitempty"`
	Candidate     string  `json:"candidate,omitempty"`
	SDPMid        *string `json:"sdp_mid,omitempty"`
	SDPMLineIndex *uint16 `json:"sdp_mline_index,omitempty"`
}

type WsRTCSignalEvent struct {
	ChannelID     int64   `json:"channel_id"`
	FromUserID    int     `json:"from_user_id"`
	SignalType    string  `json:"signal_type"`
	SDP           string  `json:"sdp,omitempty"`
	Candidate     string  `json:"candidate,omitempty"`
	SDPMid        *string `json:"sdp_mid,omitempty"`
	SDPMLineIndex *uint16 `json:"sdp_mline_index,omitempty"`
}

type WsMessageCursor struct {
	ChannelID int64     `json:"channel_id"`
	CreatedAt time.Time `json:"created_at"`
	ID        int64     `json:"id"`
}

func EncodeWsMessageCursor(cursor WsMessageCursor) (string, error) {
	b, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}

	return base64.RawURLEncoding.EncodeToString(b), nil
}

func DecodeWsMessageCursor(raw string) (*WsMessageCursor, error) {
	if raw == "" {
		return nil, nil
	}

	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, err
	}

	var cursor WsMessageCursor
	if err := json.Unmarshal(b, &cursor); err != nil {
		return nil, err
	}

	if cursor.ChannelID <= 0 || cursor.ID <= 0 || cursor.CreatedAt.IsZero() {
		return nil, errors.New("invalid cursor")
	}

	return &cursor, nil
}

type WsEvent struct {
	Event     string `json:"event"`
	RequestID string `json:"request_id,omitempty"`
	Error     string `json:"error,omitempty"`
	Data      any    `json:"data,omitempty"`
}

type WsMessage struct {
	ID              int64      `json:"id"`
	ChannelID       int64      `json:"channel_id"`
	AuthorID        int        `json:"author_id"`
	AuthorFirstName string     `json:"author_first_name"`
	AuthorLastName  string     `json:"author_last_name"`
	Content         string     `json:"content"`
	CreatedAt       time.Time  `json:"created_at"`
	EditedAt        *time.Time `json:"edited_at,omitempty"`
}

type Server struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	OwnerID   int       `json:"owner_id"`
	CreatedAt time.Time `json:"created_at"`
}

type Channel struct {
	ID        int64     `json:"id"`
	ServerID  int64     `json:"server_id"`
	Name      string    `json:"name"`
	Type      string    `json:"type"`
	CreatedAt time.Time `json:"created_at"`
}
