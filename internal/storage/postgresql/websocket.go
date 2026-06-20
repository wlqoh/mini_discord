package postgresql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
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

	err = tx.Commit()
	if err != nil {
		return 0, err
	}

	s.cache.Delete(fmt.Sprintf("%s%d", serversUserKey, server.OwnerID))
	return serverID, nil
}

func (s *Storage) DeleteChannel(ctx context.Context, channelID int64, userID int) error {
	var ownerID int
	var serverID int64
	err := s.db.QueryRowContext(
		ctx,
		`SELECT s.owner_id, s.id
				FROM channels c
				JOIN servers s ON s.id = c.server_id
				WHERE c.id = $1
				`,
		channelID,
	).Scan(&ownerID, &serverID)
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
	if err != nil {
		return err
	}
	s.cache.Delete(fmt.Sprintf("%s%d", channelKey, channelID))
	s.cache.Delete(fmt.Sprintf("%s%d", channelsServerKey, serverID))
	s.cache.DeleteByPrefix(fmt.Sprintf("%s%d", membersKey, channelID))
	s.cache.DeleteByPrefix(fmt.Sprintf("%s%d", accessKey, channelID))
	return nil
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

	rows, err := s.db.QueryContext(ctx, "SELECT user_id FROM server_members WHERE server_id = $1", serverID)
	if err != nil {
		slog.Error("failed to query server members for cache invalidation", "server_id", serverID, "error", err)
	} else {
		for rows.Next() {
			var memberID int
			if err := rows.Scan(&memberID); err != nil {
				slog.Error("failed to scan member id for cache invalidation", "error", err)
				continue
			}
			s.cache.Delete(fmt.Sprintf("%s%d", serversUserKey, memberID))
			s.cache.Delete(fmt.Sprintf("%s%d:%d", memberKey, memberID, serverID))
		}
		rows.Close()
	}

	_, err = s.db.ExecContext(ctx, "DELETE FROM servers WHERE id = $1", serverID)
	if err != nil {
		return err
	}
	s.cache.Delete(fmt.Sprintf("%s%d", channelsServerKey, serverID))
	s.cache.Delete(fmt.Sprintf("%s%d", membersServerKey, serverID))
	return nil
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

	s.cache.Delete(fmt.Sprintf("%s%d", channelsServerKey, serverID))

	return channelID, nil
}

func (s *Storage) IsServerMember(ctx context.Context, userID int, serverID int64) (bool, error) {
	key := fmt.Sprintf("%s%d:%d", memberKey, userID, serverID)
	if v, ok := s.cache.Get(key); ok {
		return v.(bool), nil
	}
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

	if err != nil {
		return false, err
	}

	s.cache.Set(key, exists, 2*time.Minute)
	return exists, nil
}

func (s *Storage) CanUserAccessChannel(ctx context.Context, userID int, channelID int64) (bool, error) {
	key := fmt.Sprintf("%s%d:%d", accessKey, channelID, userID)
	if v, ok := s.cache.Get(key); ok {
		return v.(bool), nil
	}
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

	if err != nil {
		return false, err
	}

	s.cache.Set(key, exists, 2*time.Minute)
	return exists, nil
}

func (s *Storage) ListServerMembersUserIDs(ctx context.Context, serverID int64) ([]int, error) {
	key := fmt.Sprintf("%s%d", membersServerKey, serverID)
	if v, ok := s.cache.Get(key); ok {
		cached := v.([]int)
		copied := make([]int, len(cached))
		copy(copied, cached)
		return copied, nil
	}
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

	s.cache.Set(key, userIDs, 2*time.Minute)
	return userIDs, nil
}

func (s *Storage) ListChannelMemberUserIDs(ctx context.Context, channelID int64) ([]int, error) {
	key := fmt.Sprintf("%s%d", membersKey, channelID)
	if v, ok := s.cache.Get(key); ok {
		cached := v.([]int)
		copied := make([]int, len(cached))
		copy(copied, cached)
		return copied, nil
	}
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

	s.cache.Set(key, userIDs, 2*time.Minute)
	return userIDs, nil
}

func (s *Storage) SaveMessage(ctx context.Context, msg *types.WsMessage) error {
	content := msg.Content
	if content == "" {
		content = " "
	}

	var err error
	if msg.ReplyToID != nil && *msg.ReplyToID > 0 {
		query := `
		INSERT INTO messages (channel_id, author_id, content, reply_to_id)
		VALUES ($1,$2,$3,$4)
		RETURNING id, created_at
		`
		err = s.db.QueryRowContext(
			ctx,
			query,
			msg.ChannelID,
			msg.AuthorID,
			content,
			*msg.ReplyToID,
		).Scan(&msg.ID, &msg.CreatedAt)
	} else {
		query := `
		INSERT INTO messages (channel_id, author_id, content)
		VALUES ($1,$2,$3)
		RETURNING id, created_at
		`
		err = s.db.QueryRowContext(
			ctx,
			query,
			msg.ChannelID,
			msg.AuthorID,
			content,
		).Scan(&msg.ID, &msg.CreatedAt)
	}

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

	query := `SELECT m.id, m.channel_id, COALESCE(m.author_id, 0), COALESCE(u.first_name, ''), COALESCE(u.last_name, ''), COALESCE(u.nickname, 'deleted user'), u.avatar_key, m.content, m.created_at, m.edited_at, m.reply_to_id
		 FROM messages m
		 LEFT JOIN users u ON u.id = m.author_id
		 WHERE m.channel_id = $1
		 ORDER BY m.created_at DESC, m.id DESC
		 LIMIT $2`
	args := []any{channelID, limitPlusOne}

	if cursor != nil {
		query = `SELECT m.id, m.channel_id, COALESCE(m.author_id, 0), COALESCE(u.first_name, ''), COALESCE(u.last_name, ''), COALESCE(u.nickname, 'deleted user'), u.avatar_key, m.content, m.created_at, m.edited_at, m.reply_to_id
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
		var replyToID *int64
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
			&replyToID,
		); err != nil {
			return nil, nil, false, err
		}
		if avatarKey.Valid {
			msg.AuthorAvatarURL = utils.AvatarURLFromKey(avatarKey.String, s3Host)
		}
		if msg.Content == " " {
			msg.Content = ""
		}
		msg.ReplyToID = replyToID
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

		replyTos, err := s.GetMessageReplyTos(ctx, msgIDs, s3Host)
		if err != nil {
			return nil, nil, false, err
		}

		for i := range messages {
			if a, ok := atts[messages[i].ID]; ok {
				messages[i].Attachments = a
			}
			if rt, ok := replyTos[messages[i].ID]; ok {
				messages[i].ReplyTo = rt
			}
		}
	}

	return messages, nextCursor, hasMore, nil
}

func (s *Storage) DeleteMessage(ctx context.Context, messageID int64, userID int) ([]string, error) {
	var ownerID int
	err := s.db.QueryRowContext(ctx, "SELECT author_id FROM messages WHERE id = $1", messageID).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errors.New("message not found")
		}
		return nil, err
	}

	if ownerID != userID {
		return nil, errors.New("user is not message owner")
	}

	rows, err := s.db.QueryContext(
		ctx,
		"SELECT file_key FROM message_attachments WHERE message_id = $1",
		messageID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var fileKeys []string

	for rows.Next() {
		var key string

		if err := rows.Scan(&key); err != nil {
			return nil, err
		}

		fileKeys = append(fileKeys, key)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM messages WHERE id = $1`, messageID)

	return fileKeys, err
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
		sb.WriteString("INSERT INTO message_attachments (message_id, file_key, file_name, content_type, size_bytes) VALUES ")
		args := make([]any, 0, len(batch)*5)
		for j, a := range batch {
			if j > 0 {
				sb.WriteString(", ")
			}
			sb.WriteString(fmt.Sprintf("($%d, $%d, $%d, $%d, $%d)", len(args)+1, len(args)+2, len(args)+3, len(args)+4, len(args)+5))
			args = append(args, messageID, a.FileKey, a.FileName, a.ContentType, a.SizeBytes)
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
		`SELECT id, message_id, file_key, file_name, content_type, size_bytes, created_at
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
		if err := rows.Scan(&a.ID, &a.MessageID, &fileKey, &a.FileName, &a.ContentType, &a.SizeBytes, &createdAt); err != nil {
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

func (s *Storage) GetMessageReplyTos(ctx context.Context, messageIDs []int64, s3Host string) (map[int64]*types.WsReplyTo, error) {
	if len(messageIDs) == 0 {
		return nil, nil
	}

	replyToIDs := make(map[int64]int64)
	for _, id := range messageIDs {
		replyToIDs[id] = 0
	}

	args := make([]any, len(messageIDs))
	placeholders := make([]string, len(messageIDs))
	for i, id := range messageIDs {
		args[i] = id
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}

	query := fmt.Sprintf(
		`SELECT m.id, m.reply_to_id
		 FROM messages m
		 WHERE m.id IN (%s)
		   AND m.reply_to_id IS NOT NULL`,
		strings.Join(placeholders, ","),
	)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	referencedIDs := make(map[int64]bool)
	msgToReplyID := make(map[int64]int64)
	for rows.Next() {
		var msgID, replyToID int64
		if err := rows.Scan(&msgID, &replyToID); err != nil {
			return nil, err
		}
		msgToReplyID[msgID] = replyToID
		referencedIDs[replyToID] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if len(referencedIDs) == 0 {
		return nil, nil
	}

	refArgs := make([]any, 0, len(referencedIDs))
	refPlaceholders := make([]string, 0, len(referencedIDs))
	idx := 1
	for refID := range referencedIDs {
		refArgs = append(refArgs, refID)
		refPlaceholders = append(refPlaceholders, fmt.Sprintf("$%d", idx))
		idx++
	}

	refQuery := fmt.Sprintf(
		`SELECT rm.id, rm.channel_id, rm.content, rm.author_id, u.first_name, u.last_name, u.nickname,
		        EXISTS(SELECT 1 FROM message_attachments WHERE message_id = rm.id) AS has_attachments
		 FROM messages rm
		 LEFT JOIN users u ON u.id = rm.author_id
		 WHERE rm.id IN (%s)`,
		strings.Join(refPlaceholders, ","),
	)

	refRows, err := s.db.QueryContext(ctx, refQuery, refArgs...)
	if err != nil {
		return nil, err
	}
	defer refRows.Close()

	type refInfo struct {
		content         string
		channelID       int64
		authorID        sql.NullInt64
		authorFirstName sql.NullString
		authorLastName  sql.NullString
		authorNickname  sql.NullString
		hasAttachments  bool
	}
	refData := make(map[int64]*refInfo)
	for refRows.Next() {
		var id int64
		var content string
		var channelID int64
		var authorID sql.NullInt64
		var authorFirstName, authorLastName, authorNickname sql.NullString
		var hasAttachments bool
		if err := refRows.Scan(&id, &channelID, &content, &authorID, &authorFirstName, &authorLastName, &authorNickname, &hasAttachments); err != nil {
			return nil, err
		}
		if content == " " {
			content = ""
		}
		refData[id] = &refInfo{
			content:         content,
			channelID:       channelID,
			authorID:        authorID,
			authorFirstName: authorFirstName,
			authorLastName:  authorLastName,
			authorNickname:  authorNickname,
			hasAttachments:  hasAttachments,
		}
	}
	if err := refRows.Err(); err != nil {
		return nil, err
	}

	result := make(map[int64]*types.WsReplyTo)
	for msgID, replyID := range msgToReplyID {
		info, ok := refData[replyID]
		if !ok {
			continue
		}
		var authorID int
		if info.authorID.Valid {
			authorID = int(info.authorID.Int64)
		}
		result[msgID] = &types.WsReplyTo{
			MessageID:       replyID,
			ChannelID:       info.channelID,
			AuthorID:        authorID,
			AuthorFirstName: info.authorFirstName.String,
			AuthorLastName:  info.authorLastName.String,
			AuthorNickname:  info.authorNickname.String,
			Content:         info.content,
			HasAttachments:  info.hasAttachments,
		}
	}

	return result, nil
}

func (s *Storage) GetReplyPreview(ctx context.Context, messageID int64) (*types.WsReplyTo, error) {
	var content string
	var channelID int64
	var authorID sql.NullInt64
	var authorFirstName, authorLastName, authorNickname sql.NullString
	var hasAttachments bool

	err := s.db.QueryRowContext(ctx, `
		SELECT m.content, m.channel_id, m.author_id, u.first_name, u.last_name, u.nickname,
		       EXISTS(SELECT 1 FROM message_attachments WHERE message_id = m.id) AS has_attachments
		FROM messages m
		LEFT JOIN users u ON u.id = m.author_id
		WHERE m.id = $1`, messageID).Scan(&content, &channelID, &authorID, &authorFirstName, &authorLastName, &authorNickname, &hasAttachments)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}

	if content == " " {
		content = ""
	}

	var aID int
	if authorID.Valid {
		aID = int(authorID.Int64)
	}

	return &types.WsReplyTo{
		MessageID:       messageID,
		ChannelID:       channelID,
		AuthorID:        aID,
		AuthorFirstName: authorFirstName.String,
		AuthorLastName:  authorLastName.String,
		AuthorNickname:  authorNickname.String,
		Content:         content,
		HasAttachments:  hasAttachments,
	}, nil
}

func (s *Storage) AddMemberToServer(ctx context.Context, userID int, serverID int64) error {
	query := `
	INSERT INTO server_members (user_id, server_id)
	VALUES ($1, $2)
	`

	_, err := s.db.ExecContext(ctx, query, userID, serverID)
	if err != nil {
		return err
	}
	s.cache.Delete(fmt.Sprintf("%s%d", serversUserKey, userID))
	s.cache.Delete(fmt.Sprintf("%s%d", membersServerKey, serverID))
	s.cache.Delete(fmt.Sprintf("%s%d:%d", memberKey, userID, serverID))
	channels, err := s.GetServerChannels(ctx, serverID)
	if err == nil {
		for _, channel := range channels {
			s.cache.Delete(fmt.Sprintf("%s%d:%d", accessKey, channel.ID, userID))
		}
	}
	return nil
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
	key := fmt.Sprintf("%s%d", channelsServerKey, serverID)
	if v, ok := s.cache.Get(key); ok {
		cached := v.([]types.Channel)
		copied := make([]types.Channel, len(cached))
		copy(copied, cached)
		return copied, nil
	}
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
	s.cache.Set(key, channels, 5*time.Minute)
	return channels, nil
}

func (s *Storage) GetServersByUserID(ctx context.Context, userID int) ([]types.Server, error) {
	key := fmt.Sprintf("%s%d", serversUserKey, userID)
	if v, ok := s.cache.Get(key); ok {
		cached := v.([]types.Server)
		copied := make([]types.Server, len(cached))
		copy(copied, cached)
		return copied, nil
	}
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

	s.cache.Set(key, servers, 5*time.Minute)
	return servers, nil
}

func (s *Storage) GetChannelByID(ctx context.Context, channelID int64) (*types.Channel, error) {
	key := fmt.Sprintf("%s%d", channelKey, channelID)
	if v, ok := s.cache.Get(key); ok {
		ch := v.(*types.Channel)
		chCopy := *ch
		return &chCopy, nil
	}
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

	s.cache.Set(key, &channel, 5*time.Minute)
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
