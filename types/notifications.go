package types

import (
	"context"
	"time"
)

// NotificationLevel is a notification preference: all messages, mentions
// only, or none. It is a plain string alias so it round-trips through JSON
// and SQL without conversion.
type NotificationLevel = string

// NotificationLevel* enumerates the valid values of NotificationLevel; see
// IsValidNotificationLevel.
const (
	NotificationLevelAll      NotificationLevel = "all"
	NotificationLevelMentions NotificationLevel = "mentions"
	NotificationLevelNone     NotificationLevel = "none"
)

// IsValidNotificationLevel reports whether level is one of the
// NotificationLevel* constants.
func IsValidNotificationLevel(level string) bool {
	switch level {
	case NotificationLevelAll, NotificationLevelMentions, NotificationLevelNone:
		return true
	default:
		return false
	}
}

// ServerNotificationOverride is a per-server exception to a user's default
// notification level.
type ServerNotificationOverride struct {
	ServerID int64 `json:"server_id"`
	// Level is nil when this server has no override and inherits DefaultLevel.
	Level *string `json:"level"`
	// MutedUntil is nil when the server is not muted.
	MutedUntil *time.Time `json:"muted_until"`
}

// ChannelNotificationOverride is a per-channel exception to a user's default
// (or server-level) notification level.
type ChannelNotificationOverride struct {
	ChannelID int64 `json:"channel_id"`
	// Level is nil when this channel has no override and inherits the
	// server/default level.
	Level *string `json:"level"`
	// MutedUntil is nil when the channel is not muted.
	MutedUntil *time.Time `json:"muted_until"`
}

// NotificationSettings is a user's full notification configuration: a
// global default plus any server- and channel-level overrides.
type NotificationSettings struct {
	DefaultLevel       string                        `json:"default_level"`
	HideMessagePreview bool                          `json:"hide_message_preview"`
	DNDUntil           *time.Time                    `json:"dnd_until"` // nil when do-not-disturb is off
	Servers            []ServerNotificationOverride  `json:"servers"`
	Channels           []ChannelNotificationOverride `json:"channels"`
}

// UpdateScopedNotificationSettingRequest sets or clears a single server- or
// channel-level override; a nil field leaves that part of the override
// unchanged.
type UpdateScopedNotificationSettingRequest struct {
	Level      *string    `json:"level"`
	MutedUntil *time.Time `json:"muted_until"`
}

// PushSubscription is a browser's Web Push subscription, as registered via
// the Push API and stored for later delivery.
type PushSubscription struct {
	ID        int64
	UserID    int
	Endpoint  string
	P256dh    string
	Auth      string
	UserAgent string
}

// PushSubscribeRequest is the REST payload for registering a Web Push
// subscription, mirroring the browser's PushSubscription.toJSON() shape.
type PushSubscribeRequest struct {
	Endpoint string `json:"endpoint" validate:"required"`
	Keys     struct {
		P256dh string `json:"p256dh" validate:"required"`
		Auth   string `json:"auth" validate:"required"`
	} `json:"keys"`
}

// PushUnsubscribeRequest is the REST payload for removing a Web Push
// subscription by its endpoint URL.
type PushUnsubscribeRequest struct {
	Endpoint string `json:"endpoint" validate:"required"`
}

// ResolvedNotificationTarget is one channel recipient's fully-resolved
// notification posture — used by the push sender to decide whether to
// deliver, mirroring the client's rules.ts (NOTIFICATIONS_PLAN.md §5.3/§4.5).
type ResolvedNotificationTarget struct {
	UserID             int
	Level              string
	MutedUntil         *time.Time
	DNDUntil           *time.Time
	HideMessagePreview bool
}

// NotificationStorage is implemented by the same postgresql.Storage that
// backs ServerStorage; kept as a separate interface so the REST handler
// package doesn't need to depend on the full WS-oriented ServerStorage.
type NotificationStorage interface {
	// GetUserByID looks up a user by ID.
	GetUserByID(ctx context.Context, id int) (*User, error)
	// IsServerMember reports whether userID belongs to serverID.
	IsServerMember(ctx context.Context, userID int, serverID int64) (bool, error)
	// CanUserAccessChannel reports whether userID may read/write channelID.
	CanUserAccessChannel(ctx context.Context, userID int, channelID int64) (bool, error)

	// GetNotificationSettings returns userID's full notification
	// configuration, defaulting to NotificationLevelAll with no overrides
	// if the user has never customized it.
	GetNotificationSettings(ctx context.Context, userID int) (*NotificationSettings, error)
	// UpsertGlobalNotificationSettings replaces userID's default-level
	// notification configuration.
	UpsertGlobalNotificationSettings(ctx context.Context, userID int, defaultLevel string, hideMessagePreview bool, dndUntil *time.Time) error
	// UpsertServerNotificationSetting sets or clears (via nil fields)
	// userID's override for serverID; see UpdateScopedNotificationSettingRequest.
	UpsertServerNotificationSetting(ctx context.Context, userID int, serverID int64, level *string, mutedUntil *time.Time) error
	// UpsertChannelNotificationSetting sets or clears (via nil fields)
	// userID's override for channelID; see UpdateScopedNotificationSettingRequest.
	UpsertChannelNotificationSetting(ctx context.Context, userID int, channelID int64, level *string, mutedUntil *time.Time) error

	// UpsertPushSubscription inserts or refreshes a Web Push subscription,
	// keyed by its endpoint.
	UpsertPushSubscription(ctx context.Context, sub PushSubscription) error
	// DeletePushSubscriptionByEndpoint removes a subscription, e.g. after
	// the push service reports it as expired/invalid.
	DeletePushSubscriptionByEndpoint(ctx context.Context, endpoint string) error
	// ListPushSubscriptions returns every push subscription registered by
	// any of userIDs.
	ListPushSubscriptions(ctx context.Context, userIDs []int) ([]PushSubscription, error)
	// ResolveNotificationTargets computes each of userIDs' effective
	// notification posture for channelID (merging global, server- and
	// channel-level settings), for the push sender to decide who to notify.
	ResolveNotificationTargets(ctx context.Context, channelID int64, userIDs []int) ([]ResolvedNotificationTarget, error)
}
