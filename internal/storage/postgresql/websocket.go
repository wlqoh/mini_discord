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

func (s *Storage) SaveMessage(ctx context.Context, msg *types.WsMessage) error {
	content := msg.Content
	if content == "" {
		content = " "
	}

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
		content,
	).Scan(&msg.ID, &msg.CreatedAt)

	return err
}

func (s *Storage) GetMessages(ctx context.Context, channelID int64, limit int, cursor *types.WsMessageCursor, s3Host string) ([]types.WsMessage, *types.WsMessageCursor, bool, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	limitPlusOne := limit + 1

	query := `SELECT m.id, m.channel_id, m.author_id, u.first_name, u.last_name, u.nickname, u.avatar_key, m.content, m.created_at, m.edited_at
		 FROM messages m
		 LEFT JOIN users u ON u.id = m.author_id
		 WHERE m.channel_id = $1
		 ORDER BY m.created_at DESC, m.id DESC
		 LIMIT $2`
	args := []any{channelID, limitPlusOne}

	if cursor != nil {
		query = `SELECT m.id, m.channel_id, m.author_id, u.first_name, u.last_name, u.nickname, u.avatar_key, m.content, m.created_at, m.edited_at
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
		var avatarKey sql.NullString
		if err := rows.Scan(
			&msg.ID,
			&msg.ChannelID,
			&msg.AuthorID,
			&msg.AuthorFirstName,
			&msg.AuthorLastName,
			&msg.AuthorNickname,
			&avatarKey,
			&msg.Content,
			&msg.CreatedAt,
			&msg.EditedAt,
		); err != nil {
			return nil, nil, false, err
		}
		if avatarKey.Valid {
			msg.AuthorAvatarURL = utils.AvatarURLFromKey(avatarKey.String, s3Host)
		}
		if msg.Content == " " {
			msg.Content = ""
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

	if len(messages) > 0 {
		msgIDs := make([]int64, len(messages))
		for i, m := range messages {
			msgIDs[i] = m.ID
		}
		atts, err := s.GetAttachmentsByMessageIDs(ctx, msgIDs, s3Host)
		if err != nil {
			return nil, nil, false, err
		}
		for i := range messages {
			if a, ok := atts[messages[i].ID]; ok {
				messages[i].Attachments = a
			}
		}
	}

	return messages, nextCursor, hasMore, nil
}

func (s *Storage) DeleteMessage(ctx context.Context, messageID int64) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM messages WHERE id = $1`, messageID)
	return err
}

func (s *Storage) SaveMessageAttachments(ctx context.Context, messageID int64, attachments []types.Attachment) error {
	if len(attachments) == 0 {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	const batchSize = 100
	for i := 0; i < len(attachments); i += batchSize {
		end := i + batchSize
		if end > len(attachments) {
			end = len(attachments)
		}
		batch := attachments[i:end]

		var sb strings.Builder
		sb.WriteString("INSERT INTO message_attachments (message_id, file_key, size_bytes) VALUES ")
		args := make([]any, 0, len(batch)*5)
		for j, a := range batch {
			if j > 0 {
				sb.WriteString(", ")
			}
			sb.WriteString(fmt.Sprintf("($%d, $%d, $%d)", len(args)+1, len(args)+2, len(args)+3))
			args = append(args, messageID, a.FileKey, a.SizeBytes)
		}

		if _, err := tx.ExecContext(ctx, sb.String(), args...); err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (s *Storage) GetAttachmentsByMessageIDs(ctx context.Context, messageIDs []int64, s3Host string) (map[int64][]types.Attachment, error) {
	if len(messageIDs) == 0 {
		return nil, nil
	}

	args := make([]any, len(messageIDs))
	placeholders := make([]string, len(messageIDs))
	for i, id := range messageIDs {
		args[i] = id
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}

	query := fmt.Sprintf(
		`SELECT id, message_id, file_key, size_bytes, created_at
		 FROM message_attachments
		 WHERE message_id IN (%s)
		 ORDER BY id`,
		strings.Join(placeholders, ","),
	)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[int64][]types.Attachment)
	for rows.Next() {
		var a types.Attachment
		var createdAt time.Time
		var fileKey string
		if err := rows.Scan(&a.ID, &a.MessageID, &fileKey, &a.SizeBytes, &createdAt); err != nil {
			return nil, err
		}
		a.URL = utils.AvatarURLFromKey(fileKey, s3Host)
		a.CreatedAt = createdAt.Format(time.RFC3339)
		result[a.MessageID] = append(result[a.MessageID], a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return result, nil
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
	query := `
		SELECT
			id,
			server_id,
			name,
			CASE
				WHEN LOWER(TRIM(COALESCE(type, ''))) = $2 THEN $2
				ELSE $3
			END AS type
		FROM channels
		WHERE server_id = $1
		ORDER BY id
	`
	rows, err := s.db.QueryContext(ctx, query, serverID, types.ChannelTypeVoice, types.ChannelTypeText)
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

func (s *Storage) SearchServersByName(ctx context.Context, userID int, query string, limit int) ([]types.Server, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT s.id, s.name, s.owner_id
		FROM servers s
		WHERE s.name ILIKE '%' || $1 || '%'
		  AND NOT EXISTS (
			SELECT 1
			FROM server_members sm
			WHERE sm.server_id = s.id
			  AND sm.user_id = $2
		  )
		ORDER BY s.name, s.id
		LIMIT $3
	`, query, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	servers := make([]types.Server, 0)
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
