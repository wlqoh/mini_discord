package postgresql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/wlqoh/mini_discord.git/types"
	"github.com/wlqoh/mini_discord.git/utils"
)

func (s *Storage) IsChannelServerOwner(ctx context.Context, userID int, channelID int64) (bool, error) {
	var exists bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(
			SELECT 1
			FROM channels c
			JOIN servers s ON s.id = c.server_id
			WHERE c.id = $1 AND s.owner_id = $2
		)`,
		channelID,
		userID,
	).Scan(&exists)
	if err != nil {
		return false, err
	}

	return exists, nil
}

func (s *Storage) ListServerMembers(ctx context.Context, serverID int64, s3Host string) ([]types.WsServerMember, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.id, u.first_name, u.last_name, COALESCE(u.nickname, ''), u.avatar_key
		FROM server_members sm
		JOIN users u ON u.id = sm.user_id
		WHERE sm.server_id = $1 AND u.is_deleted = FALSE
		ORDER BY u.first_name, u.last_name
	`, serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	members := make([]types.WsServerMember, 0)
	for rows.Next() {
		var member types.WsServerMember
		var avatarKey sql.NullString
		if err := rows.Scan(&member.UserID, &member.FirstName, &member.LastName, &member.Nickname, &avatarKey); err != nil {
			return nil, err
		}
		if avatarKey.Valid {
			member.AvatarURL = utils.AvatarURLFromKey(avatarKey.String, s3Host)
		}
		members = append(members, member)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return members, nil
}

func (s *Storage) SaveMessageMentions(ctx context.Context, messageID int64, userIDs []int) error {
	if len(userIDs) == 0 {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO message_mentions (message_id, user_id)
		VALUES ($1, $2)
		ON CONFLICT (message_id, user_id) DO NOTHING
	`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, userID := range userIDs {
		if _, err := stmt.ExecContext(ctx, messageID, userID); err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (s *Storage) GetMessageMentions(ctx context.Context, messageIDs []int64) (map[int64][]int, error) {
	result := make(map[int64][]int)
	if len(messageIDs) == 0 {
		return result, nil
	}

	args := make([]any, len(messageIDs))
	placeholders := make([]string, len(messageIDs))
	for i, id := range messageIDs {
		args[i] = id
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}

	query := fmt.Sprintf(`
		SELECT message_id, user_id
		FROM message_mentions
		WHERE message_id IN (%s)
	`, strings.Join(placeholders, ","))

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var messageID int64
		var userID int
		if err := rows.Scan(&messageID, &userID); err != nil {
			return nil, err
		}
		result[messageID] = append(result[messageID], userID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return result, nil
}

func (s *Storage) GetNotificationSettings(ctx context.Context, userID int) (*types.NotificationSettings, error) {
	settings := &types.NotificationSettings{
		DefaultLevel:       types.NotificationLevelAll,
		HideMessagePreview: false,
	}

	var dndUntil sql.NullTime
	err := s.db.QueryRowContext(ctx, `
		SELECT default_level, hide_message_preview, dnd_until
		FROM user_notification_settings
		WHERE user_id = $1
	`, userID).Scan(&settings.DefaultLevel, &settings.HideMessagePreview, &dndUntil)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if dndUntil.Valid {
		settings.DNDUntil = &dndUntil.Time
	}

	serverRows, err := s.db.QueryContext(ctx, `
		SELECT server_id, level, muted_until
		FROM server_notification_settings
		WHERE user_id = $1
	`, userID)
	if err != nil {
		return nil, err
	}
	defer serverRows.Close()

	settings.Servers = make([]types.ServerNotificationOverride, 0)
	for serverRows.Next() {
		var override types.ServerNotificationOverride
		var level sql.NullString
		var mutedUntil sql.NullTime
		if err := serverRows.Scan(&override.ServerID, &level, &mutedUntil); err != nil {
			return nil, err
		}
		if level.Valid {
			override.Level = &level.String
		}
		if mutedUntil.Valid {
			override.MutedUntil = &mutedUntil.Time
		}
		settings.Servers = append(settings.Servers, override)
	}
	if err := serverRows.Err(); err != nil {
		return nil, err
	}

	channelRows, err := s.db.QueryContext(ctx, `
		SELECT channel_id, level, muted_until
		FROM channel_notification_settings
		WHERE user_id = $1
	`, userID)
	if err != nil {
		return nil, err
	}
	defer channelRows.Close()

	settings.Channels = make([]types.ChannelNotificationOverride, 0)
	for channelRows.Next() {
		var override types.ChannelNotificationOverride
		var level sql.NullString
		var mutedUntil sql.NullTime
		if err := channelRows.Scan(&override.ChannelID, &level, &mutedUntil); err != nil {
			return nil, err
		}
		if level.Valid {
			override.Level = &level.String
		}
		if mutedUntil.Valid {
			override.MutedUntil = &mutedUntil.Time
		}
		settings.Channels = append(settings.Channels, override)
	}
	if err := channelRows.Err(); err != nil {
		return nil, err
	}

	return settings, nil
}

func (s *Storage) UpsertGlobalNotificationSettings(ctx context.Context, userID int, defaultLevel string, hideMessagePreview bool, dndUntil *time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO user_notification_settings (user_id, default_level, hide_message_preview, dnd_until, updated_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (user_id) DO UPDATE SET
			default_level = EXCLUDED.default_level,
			hide_message_preview = EXCLUDED.hide_message_preview,
			dnd_until = EXCLUDED.dnd_until,
			updated_at = now()
	`, userID, defaultLevel, hideMessagePreview, dndUntil)
	return err
}

// UpsertServerNotificationSetting deletes the override row when both fields
// are cleared — a row only exists when the user set something explicitly
// (NULL at this scope means "inherit", see NOTIFICATIONS_PLAN.md §3).
func (s *Storage) UpsertServerNotificationSetting(ctx context.Context, userID int, serverID int64, level *string, mutedUntil *time.Time) error {
	if level == nil && mutedUntil == nil {
		_, err := s.db.ExecContext(ctx, `
			DELETE FROM server_notification_settings WHERE user_id = $1 AND server_id = $2
		`, userID, serverID)
		return err
	}

	_, err := s.db.ExecContext(ctx, `
		INSERT INTO server_notification_settings (user_id, server_id, level, muted_until, updated_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (user_id, server_id) DO UPDATE SET
			level = EXCLUDED.level,
			muted_until = EXCLUDED.muted_until,
			updated_at = now()
	`, userID, serverID, level, mutedUntil)
	return err
}

func (s *Storage) UpsertChannelNotificationSetting(ctx context.Context, userID int, channelID int64, level *string, mutedUntil *time.Time) error {
	if level == nil && mutedUntil == nil {
		_, err := s.db.ExecContext(ctx, `
			DELETE FROM channel_notification_settings WHERE user_id = $1 AND channel_id = $2
		`, userID, channelID)
		return err
	}

	_, err := s.db.ExecContext(ctx, `
		INSERT INTO channel_notification_settings (user_id, channel_id, level, muted_until, updated_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (user_id, channel_id) DO UPDATE SET
			level = EXCLUDED.level,
			muted_until = EXCLUDED.muted_until,
			updated_at = now()
	`, userID, channelID, level, mutedUntil)
	return err
}

const maxPushSubscriptionsPerUser = 10

// UpsertPushSubscription upserts by endpoint (unique) so a browser
// re-subscribing after login/logout updates its row instead of duplicating
// it, then trims to the newest maxPushSubscriptionsPerUser rows for that user.
func (s *Storage) UpsertPushSubscription(ctx context.Context, sub types.PushSubscription) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at, last_used_at)
		VALUES ($1, $2, $3, $4, $5, now(), now())
		ON CONFLICT (endpoint) DO UPDATE SET
			user_id = EXCLUDED.user_id,
			p256dh = EXCLUDED.p256dh,
			auth = EXCLUDED.auth,
			user_agent = EXCLUDED.user_agent,
			last_used_at = now()
	`, sub.UserID, sub.Endpoint, sub.P256dh, sub.Auth, sub.UserAgent)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx, `
		DELETE FROM push_subscriptions
		WHERE user_id = $1 AND id NOT IN (
			SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2
		)
	`, sub.UserID, maxPushSubscriptionsPerUser)
	return err
}

func (s *Storage) DeletePushSubscriptionByEndpoint(ctx context.Context, endpoint string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM push_subscriptions WHERE endpoint = $1`, endpoint)
	return err
}

func (s *Storage) ListPushSubscriptions(ctx context.Context, userIDs []int) ([]types.PushSubscription, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}

	args := make([]any, len(userIDs))
	placeholders := make([]string, len(userIDs))
	for i, id := range userIDs {
		args[i] = id
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}

	query := fmt.Sprintf(`
		SELECT id, user_id, endpoint, p256dh, auth, COALESCE(user_agent, '')
		FROM push_subscriptions
		WHERE user_id IN (%s)
	`, strings.Join(placeholders, ","))

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var subs []types.PushSubscription
	for rows.Next() {
		var sub types.PushSubscription
		if err := rows.Scan(&sub.ID, &sub.UserID, &sub.Endpoint, &sub.P256dh, &sub.Auth, &sub.UserAgent); err != nil {
			return nil, err
		}
		subs = append(subs, sub)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return subs, nil
}

// ResolveNotificationTargets is the server-side mirror of the client's
// rules.ts level resolution (channel → server → global), used by the push
// sender to decide who to deliver to. One query for the whole recipient
// list — never N queries per recipient.
func (s *Storage) ResolveNotificationTargets(ctx context.Context, channelID int64, userIDs []int) ([]types.ResolvedNotificationTarget, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}

	args := make([]any, 0, len(userIDs)+1)
	args = append(args, channelID)
	placeholders := make([]string, len(userIDs))
	for i, id := range userIDs {
		args = append(args, id)
		placeholders[i] = fmt.Sprintf("$%d", i+2)
	}

	query := fmt.Sprintf(`
		SELECT u.id,
		       COALESCE(cns.level, sns.level, uns.default_level, 'all') AS level,
		       GREATEST(cns.muted_until, sns.muted_until) AS muted_until,
		       uns.dnd_until,
		       COALESCE(uns.hide_message_preview, FALSE) AS hide_preview
		FROM unnest(ARRAY[%s]::bigint[]) AS u(id)
		JOIN channels ch ON ch.id = $1
		LEFT JOIN user_notification_settings    uns ON uns.user_id = u.id
		LEFT JOIN server_notification_settings  sns ON sns.user_id = u.id AND sns.server_id = ch.server_id
		LEFT JOIN channel_notification_settings cns ON cns.user_id = u.id AND cns.channel_id = ch.id
	`, strings.Join(placeholders, ","))

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var targets []types.ResolvedNotificationTarget
	for rows.Next() {
		var target types.ResolvedNotificationTarget
		var mutedUntil, dndUntil sql.NullTime
		if err := rows.Scan(&target.UserID, &target.Level, &mutedUntil, &dndUntil, &target.HideMessagePreview); err != nil {
			return nil, err
		}
		if mutedUntil.Valid {
			target.MutedUntil = &mutedUntil.Time
		}
		if dndUntil.Valid {
			target.DNDUntil = &dndUntil.Time
		}
		targets = append(targets, target)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return targets, nil
}
