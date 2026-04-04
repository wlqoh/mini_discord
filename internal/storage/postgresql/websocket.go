package postgresql

import (
	"context"

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

func (s *Storage) DeleteServer(ctx context.Context, server types.Server) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM servers WHERE id = $1", server.ID)
	return err
}

func (s *Storage) CreateChannel(ctx context.Context, serverID int64, name string) (int64, error) {
	var channelID int64
	err := s.db.QueryRowContext(ctx,
		`INSERT INTO channels (server_id, name)
		 VALUES ($1, $2)
		 RETURNING id`,
		serverID,
		name,
	).Scan(&channelID)
	if err != nil {
		return 0, err
	}

	return channelID, nil
}

func (s *Storage) IsServerMember(ctx context.Context, userID int, serverID int64) (bool, error) {
	_ = userID

	var exists bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM servers WHERE id = $1
		)`,
		serverID,
	).Scan(&exists)

	return exists, err
}

func (s *Storage) CanUserAccessChannel(ctx context.Context, userID int, channelID int64) (bool, error) {
	_ = userID

	var exists bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM channels WHERE id = $1
		)`,
		channelID,
	).Scan(&exists)

	return exists, err
}

func (s *Storage) ListChannelMemberUserIDs(ctx context.Context, channelID int64) ([]int, error) {
	var channelExists bool
	err := s.db.QueryRowContext(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM channels WHERE id = $1
		)`,
		channelID,
	).Scan(&channelExists)
	if err != nil {
		return nil, err
	}
	if !channelExists {
		return []int{}, nil
	}

	rows, err := s.db.QueryContext(ctx, `SELECT id FROM users`)
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
	query := "SELECT id, server_id, name, type FROM channels WHERE server_id = $1"
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
	_ = userID

	query := `
		SELECT id, name, owner_id
		FROM servers
		ORDER BY id
	`

	rows, err := s.db.QueryContext(ctx, query)
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
