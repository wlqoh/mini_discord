package postgresql

import (
	"context"
	"database/sql"
	"errors"

	"github.com/wlqoh/mini_discord.git/types"
	"github.com/wlqoh/mini_discord.git/utils"
)

// normalizeDMPair returns (a, b) with a < b, matching the dm_channels CHECK
// constraint — callers never need to know which of userID/peerID happened to
// be smaller.
func normalizeDMPair(userID, peerID int) (int, int) {
	if userID < peerID {
		return userID, peerID
	}
	return peerID, userID
}

// OpenDMChannel implements types.ServerStorage. It first looks for an
// existing channel for the pair; if none exists it verifies the two users
// share a server, then creates the channels row and the dm_channels row
// inside one transaction. The dm_channels insert uses ON CONFLICT DO NOTHING
// on (user_a, user_b) rather than relying on the earlier existence check to
// be race-free: two concurrent OpenDMChannel calls for the same pair can
// both pass that check before either commits, and only the unique index
// actually prevents a duplicate row. The loser deletes the channels row it
// speculatively created and returns the winner's channel_id instead.
func (s *Storage) OpenDMChannel(ctx context.Context, userID, peerID int) (int64, bool, error) {
	a, b := normalizeDMPair(userID, peerID)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback() }()

	var existingChannelID int64
	err = tx.QueryRowContext(ctx,
		`SELECT channel_id FROM dm_channels WHERE user_a = $1 AND user_b = $2`,
		a, b,
	).Scan(&existingChannelID)
	if err == nil {
		if err := tx.Commit(); err != nil {
			return 0, false, err
		}
		return existingChannelID, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, false, err
	}

	var hasSharedServer bool
	err = tx.QueryRowContext(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM server_members sm1
			JOIN server_members sm2 ON sm2.server_id = sm1.server_id
			WHERE sm1.user_id = $1 AND sm2.user_id = $2
		)`,
		a, b,
	).Scan(&hasSharedServer)
	if err != nil {
		return 0, false, err
	}
	if !hasSharedServer {
		return 0, false, types.ErrNoSharedServer
	}

	var channelID int64
	err = tx.QueryRowContext(ctx,
		`INSERT INTO channels (server_id, name, type) VALUES (NULL, '', $1) RETURNING id`,
		types.ChannelTypeDM,
	).Scan(&channelID)
	if err != nil {
		return 0, false, err
	}

	res, err := tx.ExecContext(ctx,
		`INSERT INTO dm_channels (channel_id, user_a, user_b) VALUES ($1, $2, $3)
		 ON CONFLICT (user_a, user_b) DO NOTHING`,
		channelID, a, b,
	)
	if err != nil {
		return 0, false, err
	}
	rowsAffected, err := res.RowsAffected()
	if err != nil {
		return 0, false, err
	}

	if rowsAffected == 0 {
		// Lost the race: another transaction created the pair first. Discard
		// the channels row we speculatively inserted and hand back the
		// winner's channel instead.
		var winnerChannelID int64
		if err := tx.QueryRowContext(ctx,
			`SELECT channel_id FROM dm_channels WHERE user_a = $1 AND user_b = $2`,
			a, b,
		).Scan(&winnerChannelID); err != nil {
			return 0, false, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM channels WHERE id = $1`, channelID); err != nil {
			return 0, false, err
		}
		if err := tx.Commit(); err != nil {
			return 0, false, err
		}
		return winnerChannelID, false, nil
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO dm_visibility (channel_id, user_id) VALUES ($1, $2)`,
		channelID, userID,
	); err != nil {
		return 0, false, err
	}

	if err := tx.Commit(); err != nil {
		return 0, false, err
	}
	return channelID, true, nil
}

// ListDMChannels implements types.ServerStorage. A channel is visible to
// userID exactly when a dm_visibility row for (channel_id, userID) exists
// with hidden_at NULL — OpenDMChannel creates that row for the initiator,
// RevealDMChannel creates/restores it for both sides on the first (and every
// subsequent) message, and HideDMChannel sets hidden_at.
func (s *Storage) ListDMChannels(ctx context.Context, userID int, s3Host string) ([]types.DMChannel, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			dv.channel_id,
			CASE WHEN dc.user_a = $1 THEN dc.user_b ELSE dc.user_a END AS peer_id,
			u.nickname,
			u.avatar_key,
			lm.last_message_at
		FROM dm_visibility dv
		JOIN dm_channels dc ON dc.channel_id = dv.channel_id
		JOIN users u ON u.id = CASE WHEN dc.user_a = $1 THEN dc.user_b ELSE dc.user_a END
		LEFT JOIN LATERAL (
			SELECT MAX(m.created_at) AS last_message_at
			FROM messages m
			WHERE m.channel_id = dv.channel_id
		) lm ON true
		WHERE dv.user_id = $1 AND dv.hidden_at IS NULL
		ORDER BY lm.last_message_at DESC NULLS LAST, dc.created_at DESC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	channels := make([]types.DMChannel, 0)
	for rows.Next() {
		var dm types.DMChannel
		var avatarKey sql.NullString
		var lastMessageAt sql.NullTime
		if err := rows.Scan(&dm.ChannelID, &dm.PeerUserID, &dm.PeerNickname, &avatarKey, &lastMessageAt); err != nil {
			return nil, err
		}
		if avatarKey.Valid {
			dm.PeerAvatarURL = utils.AvatarURLFromKey(avatarKey.String, s3Host)
		}
		if lastMessageAt.Valid {
			t := lastMessageAt.Time
			dm.LastMessageAt = &t
		}
		channels = append(channels, dm)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return channels, nil
}

// HideDMChannel implements types.ServerStorage.
func (s *Storage) HideDMChannel(ctx context.Context, userID int, channelID int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE dm_visibility SET hidden_at = now() WHERE channel_id = $1 AND user_id = $2`,
		channelID, userID,
	)
	return err
}

// RevealDMChannel implements types.ServerStorage: it makes channelID visible
// to both dm_channels participants, inserting whichever side's dm_visibility
// row doesn't exist yet and clearing hidden_at either way. Called after
// every message saved into a DM channel (see hub sendMessage).
func (s *Storage) RevealDMChannel(ctx context.Context, channelID int64) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO dm_visibility (channel_id, user_id)
		SELECT $1, uid FROM (
			SELECT user_a AS uid FROM dm_channels WHERE channel_id = $1
			UNION ALL
			SELECT user_b FROM dm_channels WHERE channel_id = $1
		) participants
		ON CONFLICT (channel_id, user_id) DO UPDATE SET hidden_at = NULL
	`, channelID)
	return err
}

// SearchUsers implements types.ServerStorage, clamping limit to [1, 50] and
// restricting results to users who share at least one server with userID.
func (s *Storage) SearchUsers(ctx context.Context, userID int, query string, limit int, s3Host string) ([]types.UserSearchHit, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT u.id, u.nickname, u.avatar_key
		FROM users u
		JOIN server_members sm ON sm.user_id = u.id
		WHERE sm.server_id IN (SELECT server_id FROM server_members WHERE user_id = $1)
		  AND u.id <> $1
		  AND u.is_deleted = FALSE
		  AND u.nickname ILIKE '%' || $2 || '%'
		ORDER BY u.nickname, u.id
		LIMIT $3
	`, userID, query, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	hits := make([]types.UserSearchHit, 0)
	for rows.Next() {
		var hit types.UserSearchHit
		var avatarKey sql.NullString
		if err := rows.Scan(&hit.UserID, &hit.Nickname, &avatarKey); err != nil {
			return nil, err
		}
		if avatarKey.Valid {
			hit.AvatarURL = utils.AvatarURLFromKey(avatarKey.String, s3Host)
		}
		hits = append(hits, hit)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return hits, nil
}

// IsDMChannel implements types.ServerStorage.
func (s *Storage) IsDMChannel(ctx context.Context, channelID int64) (bool, error) {
	var exists bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(SELECT 1 FROM dm_channels WHERE channel_id = $1)`,
		channelID,
	).Scan(&exists)
	return exists, err
}
