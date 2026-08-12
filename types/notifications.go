package types

import (
	"context"
	"time"
)

type NotificationLevel = string

const (
	NotificationLevelAll      NotificationLevel = "all"
	NotificationLevelMentions NotificationLevel = "mentions"
	NotificationLevelNone     NotificationLevel = "none"
)

func IsValidNotificationLevel(level string) bool {
	switch level {
	case NotificationLevelAll, NotificationLevelMentions, NotificationLevelNone:
		return true
	default:
		return false
	}
}

type ServerNotificationOverride struct {
	ServerID   int64      `json:"server_id"`
	Level      *string    `json:"level"`
	MutedUntil *time.Time `json:"muted_until"`
}

type ChannelNotificationOverride struct {
	ChannelID  int64      `json:"channel_id"`
	Level      *string    `json:"level"`
	MutedUntil *time.Time `json:"muted_until"`
}

type NotificationSettings struct {
	DefaultLevel       string                        `json:"default_level"`
	HideMessagePreview bool                          `json:"hide_message_preview"`
	DNDUntil           *time.Time                    `json:"dnd_until"`
	Servers            []ServerNotificationOverride  `json:"servers"`
	Channels           []ChannelNotificationOverride `json:"channels"`
}

type UpdateScopedNotificationSettingRequest struct {
	Level      *string    `json:"level"`
	MutedUntil *time.Time `json:"muted_until"`
}

type PushSubscription struct {
	ID        int64
	UserID    int
	Endpoint  string
	P256dh    string
	Auth      string
	UserAgent string
}

type PushSubscribeRequest struct {
	Endpoint string `json:"endpoint" validate:"required"`
	Keys     struct {
		P256dh string `json:"p256dh" validate:"required"`
		Auth   string `json:"auth" validate:"required"`
	} `json:"keys"`
}

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
	GetUserByID(ctx context.Context, id int) (*User, error)
	IsServerMember(ctx context.Context, userID int, serverID int64) (bool, error)
	CanUserAccessChannel(ctx context.Context, userID int, channelID int64) (bool, error)

	GetNotificationSettings(ctx context.Context, userID int) (*NotificationSettings, error)
	UpsertGlobalNotificationSettings(ctx context.Context, userID int, defaultLevel string, hideMessagePreview bool, dndUntil *time.Time) error
	UpsertServerNotificationSetting(ctx context.Context, userID int, serverID int64, level *string, mutedUntil *time.Time) error
	UpsertChannelNotificationSetting(ctx context.Context, userID int, channelID int64, level *string, mutedUntil *time.Time) error

	UpsertPushSubscription(ctx context.Context, sub PushSubscription) error
	DeletePushSubscriptionByEndpoint(ctx context.Context, endpoint string) error
	ListPushSubscriptions(ctx context.Context, userIDs []int) ([]PushSubscription, error)
	ResolveNotificationTargets(ctx context.Context, channelID int64, userIDs []int) ([]ResolvedNotificationTarget, error)
}
