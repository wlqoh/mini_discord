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
	ListServerMembersUserIDs(ctx context.Context, serverID int64) ([]int, error)
	ListChannelMemberUserIDs(ctx context.Context, channelID int64) ([]int, error)
	SaveMessage(ctx context.Context, msg *WsMessage) error
	DeleteMessage(ctx context.Context, messageID int64, userID int) ([]string, error)
	EditMessage(ctx context.Context, messageID int64, userID int, content string, window time.Duration) (int64, time.Time, error)
	GetMessages(ctx context.Context, channelID int64, limit int, cursor *WsMessageCursor, s3Host string) ([]WsMessage, *WsMessageCursor, bool, error)
	GetMessagesAfter(ctx context.Context, channelID int64, limit int, cursor *WsMessageCursor, s3Host string) ([]WsMessage, *WsMessageCursor, bool, error)
	GetMessagesAround(ctx context.Context, channelID, messageID int64, limit int, s3Host string) ([]WsMessage, *WsMessageCursor, *WsMessageCursor, bool, bool, error)
	SearchMessages(ctx context.Context, params MessageSearchParams, s3Host string) ([]WsMessageSearchHit, *WsMessageCursor, bool, error)
	GetServersByUserID(ctx context.Context, userID int) ([]Server, error)
	GetServerChannels(ctx context.Context, serverID int64) ([]Channel, error)
	GetChannelByID(ctx context.Context, channelID int64) (*Channel, error)
	SearchServersByName(ctx context.Context, userID int, query string, limit int) ([]Server, error)
	SaveMessageAttachments(ctx context.Context, messageID int64, attachments []Attachment) error
	GetAttachmentsByMessageIDs(ctx context.Context, messageIDs []int64, s3Host string) (map[int64][]Attachment, error)
	GetMessageReplyTos(ctx context.Context, messageIDs []int64, s3Host string) (map[int64]*WsReplyTo, error)
	GetReplyPreview(ctx context.Context, messageID int64) (*WsReplyTo, error)
	GetUnreadCounts(ctx context.Context, userID int) ([]WsChannelUnread, error)
	MarkChannelRead(ctx context.Context, userID int, channelID, messageID int64) error

	IsChannelServerOwner(ctx context.Context, userID int, channelID int64) (bool, error)
	ListServerMembers(ctx context.Context, serverID int64, s3Host string) ([]WsServerMember, error)
	SaveMessageMentions(ctx context.Context, messageID int64, userIDs []int) error
	GetMessageMentions(ctx context.Context, messageIDs []int64) (map[int64][]int, error)
}

const (
	WsActionCreateServer      = "create_server"
	WsActionDeleteServer      = "delete_server"
	WsActionJoinServer        = "join_server"
	WsActionCreateChannel     = "create_channel"
	WsActionDeleteChannel     = "delete_channel"
	WsActionSendMessage       = "send_message"
	WsActionDeleteMessage     = "delete_message"
	WsActionEditMessage       = "edit_message"
	WsActionGetMessages       = "get_messages"
	WsActionGetServers        = "get_servers"
	WsActionGetServerChannels = "get_server_channels"
	WsActionGetUsersOnline    = "get_users_online"
	WsActionJoinVoiceChannel  = "join_voice_channel"
	WsActionLeaveVoiceChannel = "leave_voice_channel"
	WsActionRTCSignal         = "rtc_signal"
	WsActionSearchServers     = "search_servers"
	WsActionGetUserInfo       = "get_user_info"
	WsActionChangeVoiceStatus = "change_voice_status"
	WsActionTypingStart       = "typing_start"
	WsActionTypingStop        = "typing_stop"
	WsActionGetUnread         = "get_unread"
	WsActionMarkRead          = "mark_read"
	WsActionGetServerMembers  = "get_server_members"
	WsActionGetMessagesAround = "get_messages_around"
	WsActionGetMessagesAfter  = "get_messages_after"
	WsActionSearchMessages    = "search_messages"

	WsEventAck                = "ack"
	WsEventError              = "error"
	WsEventMessage            = "message"
	WsEventMessageEdited      = "message_edited"
	WsEventMessageEmbeds      = "message_embeds"
	WsEventConnected          = "connected"
	WsEventVoiceUserJoined    = "voice_user_joined"
	WsEventVoiceUserLeft      = "voice_user_left"
	WsEventVoiceStatusChanged = "voice_status_changed"
	WsEventRTCSignal          = "rtc_signal"
	// WsEventRTCSignalError reports a validation failure from relayRTCSignal
	// (e.g. sender/recipient not yet registered as in-voice — a common race
	// right after joining). rtc_signal is sent fire-and-forget on the client
	// (it bypasses the request/ack queue — see chatSocket.ts sendRTCSignal),
	// so its errors must NOT be dispatched as a plain WsEventError: that would
	// reject whatever unrelated command the client happens to be awaiting at
	// that moment (e.g. join_voice_channel failing with an rtc_signal error).
	WsEventRTCSignalError = "rtc_signal_error"
	WsEventTypingStart    = "typing_start"
	WsEventTypingStop     = "typing_stop"

	ChannelTypeText  = "text"
	ChannelTypeVoice = "voice"
)

// Ошибки, которые хаб отдаёт клиенту как есть; всё остальное, что вернёт
// хранилище, заменяется на общий текст и уходит только в лог.
var (
	ErrMessageNotFound   = errors.New("message not found")
	ErrNotMessageOwner   = errors.New("user is not message owner")
	ErrEditWindowExpired = errors.New("edit window expired")
	ErrEmptyContent      = errors.New("content is required")
)

type WsCommand struct {
	Action  string          `json:"action"`
	Payload json.RawMessage `json:"payload,omitempty"`
	// RequestID, when set, is echoed back on the resulting ack/error event.
	// Only commands whose handler runs off the Run() loop (see handleCommand)
	// need it: those are the only ones whose response can arrive out of the
	// order the client sent requests in, so the client is the only side that
	// must actually check it — older commands leave it empty and the client
	// treats an empty request_id as always matching.
	RequestID string `json:"request_id,omitempty"`
}

type WsCreateServerRequest struct {
	Name string `json:"name"`
}

type WsChangeVoiceStatusRequest struct {
	UserID     int  `json:"user_id"`
	MicEnabled bool `json:"mic_enabled,omitempty"`
	Deafened   bool `json:"deafened,omitempty"`
}

type WsDeleteServerRequest struct {
	ServerID int64 `json:"server_id"`
}

type WsGetUserInfoRequest struct {
	UserID int `json:"user_id"`
}

type WsGetUserInfoResponse struct {
	UserID    int    `json:"user_id"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Nickname  string `json:"nickname,omitempty"`
	AvatarURL string `json:"avatar_url"`
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
	ChannelID     int64   `json:"channel_id"`
	Content       string  `json:"content"`
	AttachmentIDs []int64 `json:"attachment_ids,omitempty"`
	ReplyToID     *int64  `json:"reply_to_id,omitempty"`
}

type WsDeleteMessageRequest struct {
	MessageID int64 `json:"message_id"`
}

type WsEditMessageRequest struct {
	MessageID int64  `json:"message_id"`
	Content   string `json:"content"`
}

// WsMessageEditedEvent — патч, а не полное сообщение: правится только текст,
// а вложения, reply_to и автор у клиента уже есть.
type WsMessageEditedEvent struct {
	MessageID int64     `json:"message_id"`
	ChannelID int64     `json:"channel_id"`
	Content   string    `json:"content"`
	EditedAt  time.Time `json:"edited_at"`
}

type WsGetMessagesRequest struct {
	ChannelID int64  `json:"channel_id"`
	Limit     int    `json:"limit"`
	Cursor    string `json:"cursor,omitempty"`
}

type WsGetMessagesAfterRequest struct {
	ChannelID int64  `json:"channel_id"`
	Limit     int    `json:"limit"`
	Cursor    string `json:"cursor"`
}

type WsGetMessagesAroundRequest struct {
	ChannelID int64 `json:"channel_id"`
	MessageID int64 `json:"message_id"`
	Limit     int   `json:"limit,omitempty"`
}

type WsGetMessagesAroundResponse struct {
	ChannelID    int64       `json:"channel_id"`
	Messages     []WsMessage `json:"messages"`
	OlderCursor  string      `json:"older_cursor,omitempty"`
	NewerCursor  string      `json:"newer_cursor,omitempty"`
	HasMoreOlder bool        `json:"has_more_older"`
	HasMoreNewer bool        `json:"has_more_newer"`
}

// WsSearchMessagesRequest is the wire payload; dates arrive as RFC3339
// strings and are parsed into MessageSearchParams before reaching storage.
type WsSearchMessagesRequest struct {
	Query     string  `json:"query"`
	ChannelID int64   `json:"channel_id,omitempty"`
	ServerID  int64   `json:"server_id,omitempty"` // scope: whole server, takes priority over ChannelID
	AuthorID  int     `json:"author_id,omitempty"`
	HasFile   bool    `json:"has_file,omitempty"`
	HasLink   bool    `json:"has_link,omitempty"`
	Before    *string `json:"before,omitempty"`
	After     *string `json:"after,omitempty"`
	Limit     int     `json:"limit,omitempty"`
	Cursor    string  `json:"cursor,omitempty"`
}

// MessageSearchParams is the parsed, storage-layer form of a search request:
// dates are already time.Time and the cursor already decoded.
type MessageSearchParams struct {
	Query     string
	ChannelID int64
	ServerID  int64
	AuthorID  int
	HasFile   bool
	HasLink   bool
	Before    *time.Time
	After     *time.Time
	Limit     int
	Cursor    *WsMessageCursor
}

type WsMessageSearchHit struct {
	MessageID       int64  `json:"message_id"`
	ChannelID       int64  `json:"channel_id"`
	ChannelName     string `json:"channel_name"`
	AuthorID        int    `json:"author_id"`
	AuthorFirstName string `json:"author_first_name"`
	AuthorLastName  string `json:"author_last_name"`
	AuthorNickname  string `json:"author_nickname,omitempty"`
	AuthorAvatarURL string `json:"author_avatar_url,omitempty"`
	// Headline is message content with the matched terms wrapped in
	// [[HL]]...[[/HL]] markers (Postgres ts_headline output, not HTML) — the
	// client must split on these markers and render <mark> itself rather than
	// ever treating this as trusted HTML.
	Headline  string    `json:"headline"`
	CreatedAt time.Time `json:"created_at"`
}

type WsSearchMessagesResponse struct {
	Hits       []WsMessageSearchHit `json:"hits"`
	NextCursor string               `json:"next_cursor,omitempty"`
	HasMore    bool                 `json:"has_more"`
}

type WsGetServersResponse struct {
	Servers []Server `json:"servers"`
}

type WsGetServerChannelsRequest struct {
	ServerID int64 `json:"server_id"`
}

type WsGetUsersOnlineRequest struct {
	ServerID int64 `json:"server_id"`
}

type WsGetUsersOnlineResponse struct {
	ServerID int64          `json:"server_id"`
	Users    []UserResponse `json:"users"`
}

type WsGetChannelsResponse struct {
	Channels          []Channel                    `json:"channels"`
	VoiceParticipants []WsVoiceChannelParticipants `json:"voice_participants,omitempty"`
}

type WsJoinVoiceChannelRequest struct {
	ChannelID int64 `json:"channel_id"`
}

type WsVoiceParticipant struct {
	UserID     int    `json:"user_id"`
	FirstName  string `json:"first_name,omitempty"`
	LastName   string `json:"last_name,omitempty"`
	Nickname   string `json:"nickname,omitempty"`
	MicEnabled bool   `json:"mic_enabled"`
	Deafened   bool   `json:"deafened"`
	AvatarURL  string `json:"avatar_url,omitempty"`
}

type WsJoinVoiceChannelResponse struct {
	ChannelID    int64                `json:"channel_id"`
	Participants []WsVoiceParticipant `json:"participants"`
}

type WsVoiceUserEvent struct {
	ChannelID int64              `json:"channel_id"`
	User      WsVoiceParticipant `json:"user"`
}

type WsVoiceChannelParticipants struct {
	ChannelID    int64                `json:"channel_id"`
	Participants []WsVoiceParticipant `json:"participants"`
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

type WsTypingRequest struct {
	ChannelID int64 `json:"channel_id"`
}

type WsTypingEvent struct {
	ChannelID int64 `json:"channel_id"`
	UserID    int   `json:"user_id"`
}

type WsSearchServersRequest struct {
	Query string `json:"query"`
	Limit int    `json:"limit,omitempty"`
}

type WsSearchServersResponse struct {
	Servers []Server `json:"servers"`
}

type WsMarkReadRequest struct {
	ChannelID int64 `json:"channel_id"`
	MessageID int64 `json:"message_id"`
}

type WsChannelUnread struct {
	ChannelID   int64 `json:"channel_id"`
	ServerID    int64 `json:"server_id"`
	UnreadCount int   `json:"unread_count"`
}

type WsGetUnreadResponse struct {
	Channels []WsChannelUnread `json:"channels"`
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
	ID               int64           `json:"id"`
	ChannelID        int64           `json:"channel_id"`
	AuthorID         int             `json:"author_id"`
	AuthorFirstName  string          `json:"author_first_name"`
	AuthorLastName   string          `json:"author_last_name"`
	AuthorNickname   string          `json:"author_nickname,omitempty"`
	AuthorAvatarURL  string          `json:"author_avatar_url,omitempty"`
	Content          string          `json:"content"`
	Attachments      []Attachment    `json:"attachments,omitempty"`
	ReplyToID        *int64          `json:"reply_to_id,omitempty"`
	ReplyTo          *WsReplyTo      `json:"reply_to,omitempty"`
	Mentions         []int           `json:"mentions,omitempty"`
	MentionsEveryone bool            `json:"mentions_everyone,omitempty"`
	Embeds           []WsLinkPreview `json:"embeds,omitempty"`
	CreatedAt        time.Time       `json:"created_at"`
	EditedAt         *time.Time      `json:"edited_at,omitempty"`
}

type WsServerMember struct {
	UserID    int    `json:"user_id"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Nickname  string `json:"nickname,omitempty"`
	AvatarURL string `json:"avatar_url,omitempty"`
}

type WsGetServerMembersRequest struct {
	ServerID int64 `json:"server_id"`
}

type WsGetServerMembersResponse struct {
	Members []WsServerMember `json:"members"`
}

type WsReplyTo struct {
	MessageID       int64  `json:"message_id"`
	ChannelID       int64  `json:"-"`
	AuthorID        int    `json:"author_id"`
	AuthorFirstName string `json:"author_first_name"`
	AuthorLastName  string `json:"author_last_name"`
	AuthorNickname  string `json:"author_nickname,omitempty"`
	Content         string `json:"content"`
	HasAttachments  bool   `json:"has_attachments"`
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
