package types

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"
)

// ServerStorage is the hub's persistence contract: servers, channels,
// membership, messages and their attachments/mentions/embeds, and read
// state. It is implemented by *postgresql.Storage and consumed by
// internal/service/server.Hub, which is why every read that renders
// attachment URLs takes an s3Host parameter — the storage layer has no
// config of its own and rebuilds URLs from stored S3 keys per-request using
// whatever host the current request came in on (see utils).
type ServerStorage interface {
	// GetUserByID looks up a user by ID.
	GetUserByID(ctx context.Context, id int) (*User, error)
	// CreateServer inserts server and returns its assigned ID.
	CreateServer(ctx context.Context, server Server) (int64, error)
	// DeleteServer removes a server and everything under it, if userID owns it.
	DeleteServer(ctx context.Context, serverID int64, userID int) error
	// DeleteChannel removes a channel, if userID owns the server it belongs to.
	DeleteChannel(ctx context.Context, channelID int64, userID int) error
	// AddMemberToServer adds userID as a member of serverID.
	AddMemberToServer(ctx context.Context, userID int, serverID int64) error
	// CreateChannel inserts a channel (channelType is ChannelTypeText or
	// ChannelTypeVoice) and returns its assigned ID.
	CreateChannel(ctx context.Context, serverID int64, name, channelType string) (int64, error)
	// IsServerMember reports whether userID belongs to serverID.
	IsServerMember(ctx context.Context, userID int, serverID int64) (bool, error)
	// CanUserAccessChannel reports whether userID may read/write channelID
	// (i.e. is a member of the server the channel belongs to).
	CanUserAccessChannel(ctx context.Context, userID int, channelID int64) (bool, error)
	// ListServerMembersUserIDs returns the user IDs of every member of serverID.
	ListServerMembersUserIDs(ctx context.Context, serverID int64) ([]int, error)
	// ListChannelMemberUserIDs returns the user IDs that can access channelID.
	ListChannelMemberUserIDs(ctx context.Context, channelID int64) ([]int, error)
	// SaveMessage inserts msg and fills in its assigned ID and CreatedAt.
	SaveMessage(ctx context.Context, msg *WsMessage) error
	// DeleteMessage removes the message if userID is its author, and returns
	// the S3 keys of its attachments so the caller can delete the underlying
	// objects (deleting the row does not delete the objects).
	DeleteMessage(ctx context.Context, messageID int64, userID int) ([]string, error)
	// EditMessage rewrites a message's content if userID is its author and
	// less than window has elapsed since it was created; window is compared
	// against messages.created_at in Postgres, not against time.Now() in Go,
	// so the two never disagree about timezone. It returns the message's
	// channel ID (for broadcasting the edit) and the new edited_at
	// timestamp, or one of ErrMessageNotFound / ErrNotMessageOwner /
	// ErrEditWindowExpired / ErrEmptyContent.
	EditMessage(ctx context.Context, messageID int64, userID int, content string, window time.Duration) (int64, time.Time, error)
	// GetMessages loads one backward page of a channel's history: up to
	// limit messages older than cursor (or the newest limit messages if
	// cursor is nil), returned oldest-first. The returned cursor, when
	// non-nil, points at the next (older) page; hasMore reports whether one
	// exists. This is the initial-load / "scroll up" path.
	GetMessages(ctx context.Context, channelID int64, limit int, cursor *WsMessageCursor, s3Host string) ([]WsMessage, *WsMessageCursor, bool, error)
	// GetMessagesAfter loads the page of messages immediately following
	// cursor, ascending. It is the forward-pagination counterpart to
	// GetMessages, used to walk back down to the live tail after
	// GetMessagesAround has opened a window in the middle of history.
	GetMessagesAfter(ctx context.Context, channelID int64, limit int, cursor *WsMessageCursor, s3Host string) ([]WsMessage, *WsMessageCursor, bool, error)
	// GetMessagesAround loads a two-sided window centered on messageID: up
	// to limit messages older than (and including) the anchor, and up to
	// limit messages newer, returned oldest-first as a single slice. It is
	// used to jump straight to an arbitrary message — a search hit, a reply
	// preview, a push notification — without paging GetMessages backward one
	// screen at a time.
	//
	// The two returned *WsMessageCursor are the "load older" and "load
	// newer" cursors respectively (nil when that side has no more), and the
	// two bools report whether each side actually has more (hasMoreOlder,
	// hasMoreNewer), in the same left-to-right order as the cursors.
	GetMessagesAround(ctx context.Context, channelID, messageID int64, limit int, s3Host string) ([]WsMessage, *WsMessageCursor, *WsMessageCursor, bool, bool, error)
	// SearchMessages runs a full-text search over message content and
	// returns a page of hits, newest first, with matched terms marked in
	// WsMessageSearchHit.Headline. params.Query is required; scope is
	// params.ServerID if it is set (searching every text channel in that
	// server), otherwise params.ChannelID.
	SearchMessages(ctx context.Context, params MessageSearchParams, s3Host string) ([]WsMessageSearchHit, *WsMessageCursor, bool, error)
	// GetServersByUserID returns every server userID is a member of.
	GetServersByUserID(ctx context.Context, userID int) ([]Server, error)
	// GetServerChannels returns every channel of serverID.
	GetServerChannels(ctx context.Context, serverID int64) ([]Channel, error)
	// GetChannelByID looks up a channel by ID.
	GetChannelByID(ctx context.Context, channelID int64) (*Channel, error)
	// SearchServersByName returns up to limit servers whose name matches
	// query that userID is not already a member of — for discovering
	// servers to join, not for searching one's own server list.
	SearchServersByName(ctx context.Context, userID int, query string, limit int) ([]Server, error)
	// SaveMessageAttachments links attachments to messageID.
	SaveMessageAttachments(ctx context.Context, messageID int64, attachments []Attachment) error
	// GetAttachmentsByMessageIDs returns each message's attachments, keyed
	// by message ID; messages with none are omitted from the map.
	GetAttachmentsByMessageIDs(ctx context.Context, messageIDs []int64, s3Host string) (map[int64][]Attachment, error)
	// GetMessageReplyTos returns the resolved reply preview for each of
	// messageIDs that is itself a reply, keyed by message ID.
	GetMessageReplyTos(ctx context.Context, messageIDs []int64, s3Host string) (map[int64]*WsReplyTo, error)
	// GetReplyPreview returns the preview of a single message, for building
	// the reply_to of a message that references it.
	GetReplyPreview(ctx context.Context, messageID int64) (*WsReplyTo, error)
	// GetUnreadCounts returns userID's unread count for every channel they
	// have unread messages in.
	GetUnreadCounts(ctx context.Context, userID int) ([]WsChannelUnread, error)
	// MarkChannelRead advances userID's read cursor in channelID to
	// messageID; it never moves the cursor backward (see the underlying
	// GREATEST in the upsert).
	MarkChannelRead(ctx context.Context, userID int, channelID, messageID int64) error

	// IsChannelServerOwner reports whether userID owns the server channelID
	// belongs to.
	IsChannelServerOwner(ctx context.Context, userID int, channelID int64) (bool, error)
	// ListServerMembers returns the display info of every member of serverID.
	ListServerMembers(ctx context.Context, serverID int64, s3Host string) ([]WsServerMember, error)
	// SaveMessageMentions records which users are mentioned by messageID.
	SaveMessageMentions(ctx context.Context, messageID int64, userIDs []int) error
	// GetMessageMentions returns the mentioned user IDs for each of
	// messageIDs, keyed by message ID; messages with none are omitted.
	GetMessageMentions(ctx context.Context, messageIDs []int64) (map[int64][]int, error)
}

// WsAction* names every command a client can send in WsCommand.Action.
// WsEvent* names every event the server can push in WsEvent.Event.
// ChannelType* enumerates the two kinds of channel. This block is the
// single source of truth for the WS wire contract: any addition or rename
// here must be mirrored by hand in frontend/src/services/chatSocket.ts and
// frontend/src/types/chat.ts — there is no codegen.
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

	// sfu_* actions address the server directly (unlike mesh's removed
	// rtc_signal, whose to_user_id addressed a peer) — see
	// sfu-migration-plan.md §3 decision #11. Mesh itself was removed once
	// the SFU migration cleared its criteria (§9 of that plan).
	WsActionSfuOffer          = "sfu_offer"
	WsActionSfuAnswer         = "sfu_answer"
	WsActionSfuCandidate      = "sfu_candidate"
	WsActionSfuSubscribeVideo = "sfu_subscribe_video"
	WsActionSfuResume         = "sfu_resume"
	// WsActionSfuPublishState lets a publisher explicitly tell the room when
	// a togglable source ("screen" or "camera") starts/stops actually
	// producing media. Fixed publish slots never renegotiate on toggle
	// (decision #3) and the SFU has no reliable server-side way to infer
	// "the publisher called replaceTrack(null)" (screen) or "the publisher
	// disabled its track" (camera) from RTP alone — neither produces an
	// error/EOF the SFU can observe, and there's no spec-guaranteed
	// mute/unmute timing on the subscriber's end either. This is relayed
	// through as the same sfu_track_published/unpublished events a first
	// publish uses, but it's no longer purely informational: the router
	// records the state (Peer.setPublishState) so a resumed source gets a
	// fresh keyframe request for its existing subscribers, and so a late
	// joiner's snapshot (Peer.sendTrackSnapshot) doesn't offer a source the
	// publisher has explicitly turned off.
	WsActionSfuPublishState = "sfu_publish_state"

	WsEventAck                = "ack"
	WsEventError              = "error"
	WsEventMessage            = "message"
	WsEventMessageEdited      = "message_edited"
	WsEventMessageEmbeds      = "message_embeds"
	WsEventConnected          = "connected"
	WsEventVoiceUserJoined    = "voice_user_joined"
	WsEventVoiceUserLeft      = "voice_user_left"
	WsEventVoiceStatusChanged = "voice_status_changed"
	// WsEventVoiceUserDetached/Resumed (migration phase 3, decision #10):
	// fired when an SFU participant's WebSocket drops/reconnects during the
	// grace period. Media keeps flowing the whole time — these are a UI
	// affordance (show the tile as reconnecting), not a membership change,
	// so unlike VoiceUserJoined/Left they're not in isCriticalVoiceEvent.
	WsEventVoiceUserDetached = "voice_user_detached"
	WsEventVoiceUserResumed  = "voice_user_resumed"
	WsEventTypingStart       = "typing_start"
	WsEventTypingStop        = "typing_stop"

	WsEventSfuOffer            = "sfu_offer"
	WsEventSfuAnswer           = "sfu_answer"
	WsEventSfuCandidate        = "sfu_candidate"
	WsEventSfuTrackPublished   = "sfu_track_published"
	WsEventSfuTrackUnpublished = "sfu_track_unpublished"
	WsEventSfuActiveSpeakers   = "sfu_active_speakers"
	// WsEventSfuError exists because sfu_candidate is sent fire-and-forget
	// (bypasses the request/ack queue), so its errors can't be dispatched as
	// a plain WsEventError without misattributing them to an unrelated
	// in-flight command.
	WsEventSfuError = "sfu_error"

	ChannelTypeText  = "text"
	ChannelTypeVoice = "voice"
)

// Err* are the storage errors the hub forwards to the client verbatim; any
// other error a storage call returns is replaced with a generic message and
// only logged.
var (
	ErrMessageNotFound   = errors.New("message not found")
	ErrNotMessageOwner   = errors.New("user is not message owner")
	ErrEditWindowExpired = errors.New("edit window expired")
	ErrEmptyContent      = errors.New("content is required")
)

// WsCommand is the envelope for every client-to-server WebSocket message;
// Payload is unmarshaled into an action-specific request struct based on
// Action (see WsAction* and Hub.handleCommand).
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

// WsCreateServerRequest is the payload for WsActionCreateServer.
type WsCreateServerRequest struct {
	Name string `json:"name"`
}

// WsChangeVoiceStatusRequest is the payload for WsActionChangeVoiceStatus.
type WsChangeVoiceStatusRequest struct {
	UserID     int  `json:"user_id"`
	MicEnabled bool `json:"mic_enabled,omitempty"`
	Deafened   bool `json:"deafened,omitempty"`
}

// WsDeleteServerRequest is the payload for WsActionDeleteServer.
type WsDeleteServerRequest struct {
	ServerID int64 `json:"server_id"`
}

// WsGetUserInfoRequest is the payload for WsActionGetUserInfo.
type WsGetUserInfoRequest struct {
	UserID int `json:"user_id"`
}

// WsGetUserInfoResponse is the response data for WsActionGetUserInfo.
type WsGetUserInfoResponse struct {
	UserID    int    `json:"user_id"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Nickname  string `json:"nickname,omitempty"`
	AvatarURL string `json:"avatar_url"`
}

// WsJoinServerRequest is the payload for WsActionJoinServer.
type WsJoinServerRequest struct {
	ServerID int64 `json:"server_id"`
}

// WsCreateChannelRequest is the payload for WsActionCreateChannel.
type WsCreateChannelRequest struct {
	ServerID int64  `json:"server_id"`
	Name     string `json:"name"`
	Type     string `json:"type,omitempty"` // ChannelTypeText or ChannelTypeVoice; defaults to text
}

// WsDeleteChannelRequest is the payload for WsActionDeleteChannel.
type WsDeleteChannelRequest struct {
	ChannelID int64 `json:"channel_id"`
}

// WsSendMessageRequest is the payload for WsActionSendMessage.
type WsSendMessageRequest struct {
	ChannelID int64  `json:"channel_id"`
	Content   string `json:"content"`
	// AttachmentIDs reference PendingAttachments previously uploaded via
	// POST /upload; each is consumed exactly once.
	AttachmentIDs []int64 `json:"attachment_ids,omitempty"`
	// ReplyToID is nil when the message is not a reply.
	ReplyToID *int64 `json:"reply_to_id,omitempty"`
}

// WsDeleteMessageRequest is the payload for WsActionDeleteMessage.
type WsDeleteMessageRequest struct {
	MessageID int64 `json:"message_id"`
}

// WsEditMessageRequest is the payload for WsActionEditMessage.
type WsEditMessageRequest struct {
	MessageID int64  `json:"message_id"`
	Content   string `json:"content"`
}

// WsMessageEditedEvent is the payload of the message_edited event. It is a
// patch, not a full message: only the text changes, so attachments,
// reply_to and the author are left as the client already has them.
type WsMessageEditedEvent struct {
	MessageID int64     `json:"message_id"`
	ChannelID int64     `json:"channel_id"`
	Content   string    `json:"content"`
	EditedAt  time.Time `json:"edited_at"`
}

// WsGetMessagesRequest is the payload for WsActionGetMessages — the
// backward-paginating history load; see ServerStorage.GetMessages.
type WsGetMessagesRequest struct {
	ChannelID int64  `json:"channel_id"`
	Limit     int    `json:"limit"`
	Cursor    string `json:"cursor,omitempty"`
}

// WsGetMessagesAfterRequest is the payload for WsActionGetMessagesAfter; see
// ServerStorage.GetMessagesAfter.
type WsGetMessagesAfterRequest struct {
	ChannelID int64  `json:"channel_id"`
	Limit     int    `json:"limit"`
	Cursor    string `json:"cursor"`
}

// WsGetMessagesAroundRequest is the payload for WsActionGetMessagesAround;
// see ServerStorage.GetMessagesAround.
type WsGetMessagesAroundRequest struct {
	ChannelID int64 `json:"channel_id"`
	MessageID int64 `json:"message_id"`
	Limit     int   `json:"limit,omitempty"`
}

// WsGetMessagesAroundResponse is the response data for
// WsActionGetMessagesAround. OlderCursor/HasMoreOlder and
// NewerCursor/HasMoreNewer describe pagination on each side of the anchor
// message independently.
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

// WsMessageSearchHit is one result row of WsActionSearchMessages.
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

// WsSearchMessagesResponse is the response data for WsActionSearchMessages.
type WsSearchMessagesResponse struct {
	Hits       []WsMessageSearchHit `json:"hits"`
	NextCursor string               `json:"next_cursor,omitempty"`
	HasMore    bool                 `json:"has_more"`
}

// WsGetServersResponse is the response data for WsActionGetServers.
type WsGetServersResponse struct {
	Servers []Server `json:"servers"`
}

// WsGetServerChannelsRequest is the payload for WsActionGetServerChannels.
type WsGetServerChannelsRequest struct {
	ServerID int64 `json:"server_id"`
}

// WsGetUsersOnlineRequest is the payload for WsActionGetUsersOnline.
type WsGetUsersOnlineRequest struct {
	ServerID int64 `json:"server_id"`
}

// WsGetUsersOnlineResponse is the response data for WsActionGetUsersOnline.
type WsGetUsersOnlineResponse struct {
	ServerID int64          `json:"server_id"`
	Users    []UserResponse `json:"users"`
}

// WsGetChannelsResponse is the response data for WsActionGetServerChannels,
// including each voice channel's current participants.
type WsGetChannelsResponse struct {
	Channels          []Channel                    `json:"channels"`
	VoiceParticipants []WsVoiceChannelParticipants `json:"voice_participants,omitempty"`
}

// WsJoinVoiceChannelRequest is the payload for WsActionJoinVoiceChannel.
type WsJoinVoiceChannelRequest struct {
	ChannelID int64 `json:"channel_id"`
}

// WsVoiceParticipant is one user's presence and mic/deafen state in a voice
// channel.
type WsVoiceParticipant struct {
	UserID     int    `json:"user_id"`
	FirstName  string `json:"first_name,omitempty"`
	LastName   string `json:"last_name,omitempty"`
	Nickname   string `json:"nickname,omitempty"`
	MicEnabled bool   `json:"mic_enabled"`
	Deafened   bool   `json:"deafened"`
	AvatarURL  string `json:"avatar_url,omitempty"`
}

// TransportModeSFU is the only value WsJoinVoiceChannelResponse.TransportMode
// ever carries now — mesh was removed once the SFU migration cleared its
// criteria (sfu-migration-plan.md §9). Kept as a named constant rather than
// inlining the literal, per the plan's Phase 5 note on why the field itself
// stays on the wire.
const TransportModeSFU = "sfu"

// WsJoinVoiceChannelResponse is the response data for
// WsActionJoinVoiceChannel.
type WsJoinVoiceChannelResponse struct {
	ChannelID    int64                `json:"channel_id"`
	Participants []WsVoiceParticipant `json:"participants"`

	// TransportMode tells the client which VoiceClient implementation to
	// use for this call — decided server-side (see sfu-migration-plan.md §3
	// decision #11) so the switch doesn't require a frontend rebuild and can
	// be scoped to individual channels via SFUConfig.ChannelAllowlist.
	TransportMode string          `json:"transport_mode"`
	SessionID     string          `json:"session_id,omitempty"`
	ICEServers    []WsICEServer   `json:"ice_servers,omitempty"`
	PublishSlots  []WsPublishSlot `json:"publish_slots,omitempty"`
}

// WsICEServer is one ICE server (STUN or TURN) offered to the client for
// establishing the SFU peer connection.
type WsICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// WsPublishSlot declares one fixed transceiver a client must create (in
// order) when publishing to the SFU — see sfu-migration-plan.md §4.3.
type WsPublishSlot struct {
	Kind   string `json:"kind"`   // "audio" | "video"
	Source string `json:"source"` // mic | camera | screen | screen_audio
}

// WsVoiceUserEvent is the payload of voice_user_joined / voice_user_left /
// voice_user_detached / voice_user_resumed.
type WsVoiceUserEvent struct {
	ChannelID int64              `json:"channel_id"`
	User      WsVoiceParticipant `json:"user"`
}

// WsVoiceChannelParticipants is one voice channel's current participant
// list, as embedded in WsGetChannelsResponse.
type WsVoiceChannelParticipants struct {
	ChannelID    int64                `json:"channel_id"`
	Participants []WsVoiceParticipant `json:"participants"`
}

// --- sfu_* protocol payloads (sfu-migration-plan.md §5) ---

// WsSfuSlotDecl declares one transceiver the client created in its offer,
// naming which fixed publish slot (Source) it corresponds to.
type WsSfuSlotDecl struct {
	MID    string `json:"mid"`
	Kind   string `json:"kind"`   // "audio" | "video"
	Source string `json:"source"` // mic | camera | screen | screen_audio
}

// WsSfuOfferRequest is the payload for WsActionSfuOffer: the client's
// initial SDP offer, declaring its publish slots via Slots.
type WsSfuOfferRequest struct {
	SessionID string          `json:"session_id"`
	SDP       string          `json:"sdp"`
	Slots     []WsSfuSlotDecl `json:"slots,omitempty"`
}

// WsSfuOfferEvent is the payload of the sfu_offer event: a renegotiation
// offer pushed by the server, which is always the offerer after the
// client's initial offer.
type WsSfuOfferEvent struct {
	SessionID string `json:"session_id"`
	SDP       string `json:"sdp"`
}

// WsSfuAnswerPayload is the payload for WsActionSfuAnswer: the client's SDP
// answer to a server-initiated offer.
type WsSfuAnswerPayload struct {
	SessionID string `json:"session_id"`
	SDP       string `json:"sdp"`
}

// WsSfuCandidatePayload is the payload for WsActionSfuCandidate; it is sent
// fire-and-forget (see WsSfuErrorEvent).
type WsSfuCandidatePayload struct {
	SessionID     string  `json:"session_id"`
	Candidate     string  `json:"candidate"`
	SDPMid        *string `json:"sdp_mid,omitempty"`
	SDPMLineIndex *uint16 `json:"sdp_mline_index,omitempty"`
}

// WsSfuSubscribeVideoRequest is the payload for WsActionSfuSubscribeVideo,
// requesting a simulcast quality (or turning the subscription off) for one
// remote publisher's video source.
type WsSfuSubscribeVideoRequest struct {
	SessionID    string `json:"session_id"`
	TargetUserID int    `json:"target_user_id"`
	Source       string `json:"source"`  // camera | screen
	Quality      string `json:"quality"` // off | low | high
}

// WsSfuPublishStateRequest is the payload for WsActionSfuPublishState — see
// its doc comment above for why this exists instead of inferring publish
// state from RTP.
type WsSfuPublishStateRequest struct {
	SessionID string `json:"session_id"`
	Source    string `json:"source"` // "screen" or "camera"
	Active    bool   `json:"active"`
}

// WsSfuResumeRequest is the payload for WsActionSfuResume, reattaching a
// client to an SFU session after its WebSocket reconnects within the grace
// period.
type WsSfuResumeRequest struct {
	SessionID string `json:"session_id"`
}

// WsSfuResumeResponse is the response data for WsActionSfuResume.
type WsSfuResumeResponse struct {
	OK           bool                 `json:"ok"`
	Participants []WsVoiceParticipant `json:"participants"`
}

// WsSfuTrackEvent is the payload of sfu_track_published /
// sfu_track_unpublished, and of the publish-state change relayed through
// the same two events (see WsActionSfuPublishState).
type WsSfuTrackEvent struct {
	ChannelID int64  `json:"channel_id"`
	UserID    int    `json:"user_id"`
	Source    string `json:"source"`
	Kind      string `json:"kind,omitempty"`
}

// WsSfuActiveSpeakersEvent is the payload of the sfu_active_speakers event.
type WsSfuActiveSpeakersEvent struct {
	ChannelID int64 `json:"channel_id"`
	UserIDs   []int `json:"user_ids"`
}

// WsSfuErrorEvent is the payload of the sfu_error event: sfu_candidate is
// sent fire-and-forget (bypasses the request/ack queue), so its errors need
// a dedicated event instead of a plain "error" event.
type WsSfuErrorEvent struct {
	SessionID string `json:"session_id"`
	Code      string `json:"code"`
	Message   string `json:"message"`
}

// WsMessageCursor is an opaque pagination position (a specific message's
// channel, timestamp and ID), encoded to/from a string via
// EncodeWsMessageCursor / DecodeWsMessageCursor for the wire.
type WsMessageCursor struct {
	ChannelID int64     `json:"channel_id"`
	CreatedAt time.Time `json:"created_at"`
	ID        int64     `json:"id"`
}

// WsTypingRequest is the payload for WsActionTypingStart / WsActionTypingStop.
type WsTypingRequest struct {
	ChannelID int64 `json:"channel_id"`
}

// WsTypingEvent is the payload of the typing_start / typing_stop events.
type WsTypingEvent struct {
	ChannelID int64 `json:"channel_id"`
	UserID    int   `json:"user_id"`
}

// WsSearchServersRequest is the payload for WsActionSearchServers.
type WsSearchServersRequest struct {
	Query string `json:"query"`
	Limit int    `json:"limit,omitempty"`
}

// WsSearchServersResponse is the response data for WsActionSearchServers.
type WsSearchServersResponse struct {
	Servers []Server `json:"servers"`
}

// WsMarkReadRequest is the payload for WsActionMarkRead.
type WsMarkReadRequest struct {
	ChannelID int64 `json:"channel_id"`
	MessageID int64 `json:"message_id"`
}

// WsChannelUnread is one channel's unread message count, as returned by
// WsActionGetUnread.
type WsChannelUnread struct {
	ChannelID   int64 `json:"channel_id"`
	ServerID    int64 `json:"server_id"`
	UnreadCount int   `json:"unread_count"`
}

// WsGetUnreadResponse is the response data for WsActionGetUnread.
type WsGetUnreadResponse struct {
	Channels []WsChannelUnread `json:"channels"`
}

// EncodeWsMessageCursor encodes cursor as an opaque base64 string suitable
// for a Ws*Request.Cursor field.
func EncodeWsMessageCursor(cursor WsMessageCursor) (string, error) {
	b, err := json.Marshal(cursor)
	if err != nil {
		return "", err
	}

	return base64.RawURLEncoding.EncodeToString(b), nil
}

// DecodeWsMessageCursor parses a cursor string produced by
// EncodeWsMessageCursor. An empty raw string is a valid "no cursor" and
// returns (nil, nil). It returns an error if raw is malformed or decodes to
// a cursor with a non-positive ChannelID/ID or a zero CreatedAt.
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

// WsEvent is the envelope for every server-to-client WebSocket message.
// Data holds one of the event-specific payload structs (Ws*Event /
// Ws*Response), chosen by Event (see WsEvent*); RequestID is echoed from
// the triggering WsCommand when it was set (see WsCommand.RequestID).
type WsEvent struct {
	Event     string `json:"event"`
	RequestID string `json:"request_id,omitempty"`
	Error     string `json:"error,omitempty"`
	Data      any    `json:"data,omitempty"`
}

// WsMessage is a chat message as sent to the client, denormalized with its
// author's display info, attachments, reply preview, mentions and link
// embeds so the client never needs a follow-up request to render it.
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

// WsServerMember is one server member's display info, as returned by
// WsActionGetServerMembers.
type WsServerMember struct {
	UserID    int    `json:"user_id"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Nickname  string `json:"nickname,omitempty"`
	AvatarURL string `json:"avatar_url,omitempty"`
}

// WsGetServerMembersRequest is the payload for WsActionGetServerMembers.
type WsGetServerMembersRequest struct {
	ServerID int64 `json:"server_id"`
}

// WsGetServerMembersResponse is the response data for
// WsActionGetServerMembers.
type WsGetServerMembersResponse struct {
	Members []WsServerMember `json:"members"`
}

// WsReplyTo is the preview of a message another message replies to, as
// embedded in WsMessage.ReplyTo. ChannelID is used server-side to resolve
// the preview and is never sent to the client.
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

// Server is a top-level server (guild) row.
type Server struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	OwnerID   int       `json:"owner_id"`
	CreatedAt time.Time `json:"created_at"`
}

// Channel is a text or voice channel row; Type is ChannelTypeText or
// ChannelTypeVoice.
type Channel struct {
	ID        int64     `json:"id"`
	ServerID  int64     `json:"server_id"`
	Name      string    `json:"name"`
	Type      string    `json:"type"`
	CreatedAt time.Time `json:"created_at"`
}
