package postgresql

import (
	"context"
	"database/sql"
	"errors"

	"github.com/wlqoh/mini_discord.git/types"
)

func (s *Storage) CreateServer(ctx context.Context, server types.Server) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	var serverID int64
	err = tx.QueryRowContext(ctx,
		`INSERT INTO servers (name, owner_id)
		 VALUES ($1, $2) RETURNING id`,
		server.Name,
		server.OwnerID,
	).Scan(&serverID)
	if err != nil {
		return 0, err
	}

	_, err = tx.ExecContext(ctx,
		`INSERT INTO server_members (user_id, server_id)
		 VALUES ($1, $2)`,
		server.OwnerID,
		serverID,
	)
	if err != nil {
		return 0, err
	}

	return serverID, tx.Commit()
}

func (s *Storage) DeleteChannel(ctx context.Context, channelID int64, userID int) error {
	var ownerID int
	err := s.db.QueryRowContext(
		ctx,
		`SELECT s.owner_id
				FROM channels c
				JOIN servers s ON s.id = c.server_id
				WHERE c.id = $1
				`,
		channelID,
	).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("channel not found")
		}
		return err
	}

	if ownerID != userID {
		return errors.New("user is not server owner")
	}

	_, err = s.db.ExecContext(ctx, "DELETE FROM channels WHERE id = $1", channelID)
	return err
}

func (s *Storage) DeleteServer(ctx context.Context, serverID int64, userID int) error {
	var ownerID int
	err := s.db.QueryRowContext(
		ctx,
		"SELECT owner_id FROM servers WHERE id = $1",
		serverID,
	).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("server not found")
		}
		return err
	}

	if ownerID != userID {
		return errors.New("user is not server owner")
	}

	_, err = s.db.ExecContext(ctx, "DELETE FROM servers WHERE id = $1", serverID)
	return err
}

func (s *Storage) CreateChannel(ctx context.Context, serverID int64, name, channelType string) (int64, error) {
	if channelType == "" {
		channelType = types.ChannelTypeText
	}

	var channelID int64
	err := s.db.QueryRowContext(ctx,
		`INSERT INTO channels (server_id, name, type)
		 VALUES ($1, $2, $3)
		 RETURNING id`,
		serverID,
		name,
		channelType,
	).Scan(&channelID)
	if err != nil {
		return 0, err
	}

	return channelID, nil
}

func (s *Storage) IsServerMember(ctx context.Context, userID int, serverID int64) (bool, error) {
	var exists bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(
  SELECT 1
  FROM server_members
  WHERE user_id = $1 AND server_id = $2
)`,
		userID,
		serverID,
	).Scan(&exists)

	return exists, err
}

func (s *Storage) CanUserAccessChannel(ctx context.Context, userID int, channelID int64) (bool, error) {
	var exists bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(
			SELECT 1
			FROM channels c
			JOIN server_members sm ON sm.server_id = c.server_id
			WHERE c.id = $1 AND sm.user_id = $2
		)`,
		channelID,
		userID,
	).Scan(&exists)

	return exists, err
}

func (s *Storage) ListServerMembersUserIDs(ctx context.Context, serverID int64) ([]int, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT user_id
		FROM server_members
		WHERE server_id = $1
	`, serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	userIDs := make([]int, 0)
	for rows.Next() {
		var userID int
		if err := rows.Scan(&userID); err != nil {
			return nil, err
		}
		userIDs = append(userIDs, userID)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return userIDs, nil
}

func (s *Storage) ListChannelMemberUserIDs(ctx context.Context, channelID int64) ([]int, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT sm.user_id
		FROM channels c
		JOIN server_members sm ON sm.server_id = c.server_id
		WHERE c.id = $1
	`, channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	userIDs := make([]int, 0)
	for rows.Next() {
		var userID int
		if err := rows.Scan(&userID); err != nil {
			return nil, err
		}
		userIDs = append(userIDs, userID)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return userIDs, nil
}

func (s *Storage) SaveMessage(ctx context.Context, msg types.WsMessage) error {
	query := `
	INSERT INTO messages (channel_id, author_id, content)
	VALUES ($1,$2,$3)
	RETURNING id, created_at
	`

	err := s.db.QueryRowContext(
		ctx,
		query,
		msg.ChannelID,
		msg.AuthorID,
		msg.Content,
	).Scan(&msg.ID, &msg.CreatedAt)

	return err
}

func (s *Storage) GetMessages(ctx context.Context, channelID int64, limit int, cursor *types.WsMessageCursor) ([]types.WsMessage, *types.WsMessageCursor, bool, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	limitPlusOne := limit + 1

	query := `SELECT m.id, m.channel_id, m.author_id, u.first_name, u.last_name, m.content, m.created_at, m.edited_at
		 FROM messages m
		 LEFT JOIN users u ON u.id = m.author_id
		 WHERE m.channel_id = $1
		 ORDER BY m.created_at DESC, m.id DESC
		 LIMIT $2`
	args := []any{channelID, limitPlusOne}

	if cursor != nil {
		query = `SELECT m.id, m.channel_id, m.author_id, u.first_name, u.last_name, m.content, m.created_at, m.edited_at
			 FROM messages m
			 LEFT JOIN users u ON u.id = m.author_id
			 WHERE m.channel_id = $1
			   AND (m.created_at, m.id) < ($2, $3)
			 ORDER BY m.created_at DESC, m.id DESC
			 LIMIT $4`
		args = []any{channelID, cursor.CreatedAt, cursor.ID, limitPlusOne}
	}

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, nil, false, err
	}
	defer rows.Close()

	var messages []types.WsMessage
	for rows.Next() {
		var msg types.WsMessage
		if err := rows.Scan(
			&msg.ID,
			&msg.ChannelID,
			&msg.AuthorID,
			&msg.AuthorFirstName,
			&msg.AuthorLastName,
			&msg.Content,
			&msg.CreatedAt,
			&msg.EditedAt,
		); err != nil {
			return nil, nil, false, err
		}
		messages = append(messages, msg)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, false, err
	}

	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit]
	}

	var nextCursor *types.WsMessageCursor
	if hasMore && len(messages) > 0 {
		last := messages[len(messages)-1]
		nextCursor = &types.WsMessageCursor{
			ChannelID: last.ChannelID,
			CreatedAt: last.CreatedAt,
			ID:        last.ID,
		}
	}

	// Reverse to get chronological order
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}

	return messages, nextCursor, hasMore, nil
}

func (s *Storage) AddMemberToServer(ctx context.Context, userID int, serverID int64) error {
	query := `
	INSERT INTO server_members (user_id, server_id)
	VALUES ($1, $2)
	`

	_, err := s.db.ExecContext(ctx, query, userID, serverID)
	return err
}

func (s *Storage) getServerIdsByUserID(ctx context.Context, userID int) ([]int64, error) {
	query := "SELECT server_id FROM server_members WHERE user_id = $1"

	rows, err := s.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, err
	}

	defer rows.Close()

	serverIDs := make([]int64, 0)
	for rows.Next() {
		var serverID int64
		if err := rows.Scan(&serverID); err != nil {
			return nil, err
		}
		serverIDs = append(serverIDs, serverID)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return serverIDs, nil
}

func (s *Storage) GetServerChannels(ctx context.Context, serverID int64) ([]types.Channel, error) {
	query := "SELECT id, server_id, name, type FROM channels WHERE server_id = $1 ORDER BY id"
	rows, err := s.db.QueryContext(ctx, query, serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var channels []types.Channel
	for rows.Next() {
		var channel types.Channel
		if err := rows.Scan(&channel.ID, &channel.ServerID, &channel.Name, &channel.Type); err != nil {
			return nil, err
		}
		channels = append(channels, channel)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return channels, nil
}

func (s *Storage) GetServersByUserID(ctx context.Context, userID int) ([]types.Server, error) {
	query := `
		SELECT s.id, s.name, s.owner_id
		FROM servers s
		JOIN server_members sm ON sm.server_id = s.id
		WHERE sm.user_id = $1
		ORDER BY s.id
	`

	rows, err := s.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, err
	}

	defer rows.Close()

	var servers []types.Server
	for rows.Next() {
		var server types.Server
		if err := rows.Scan(&server.ID, &server.Name, &server.OwnerID); err != nil {
			return nil, err
		}
		servers = append(servers, server)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return servers, nil
}

func (s *Storage) GetChannelByID(ctx context.Context, channelID int64) (*types.Channel, error) {
	query := `
		SELECT id, server_id, name, type, created_at
		FROM channels
		WHERE id = $1
	`

	var channel types.Channel
	if err := s.db.QueryRowContext(ctx, query, channelID).Scan(
		&channel.ID,
		&channel.ServerID,
		&channel.Name,
		&channel.Type,
		&channel.CreatedAt,
	); err != nil {
		return nil, err
	}

	return &channel, nil
}
