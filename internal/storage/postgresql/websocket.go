package postgresql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/wlqoh/mini_discord.git/internal/lib/logger/sl"
	"github.com/wlqoh/mini_discord.git/types"
	"github.com/wlqoh/mini_discord.git/utils"
)

// messageColumns is the fixed column list shared by every query that reads
// full message rows (GetMessages, GetMessagesAfter, GetMessagesAround) so the
// scan order in scanMessageRow always matches the SELECT list.
const messageColumns = `m.id, m.channel_id, COALESCE(m.author_id, 0), COALESCE(u.first_name, ''), COALESCE(u.last_name, ''), COALESCE(u.nickname, 'deleted user'), u.avatar_key, m.content, m.created_at, m.edited_at, m.reply_to_id, m.mentions_everyone`

// finalizeMessage applies the normalization every message row needs after
// scanning: resolving the avatar URL and undoing the " " placeholder SaveMessage
// uses for empty content (Postgres has no NOT NULL-but-empty-allowed distinct
// from NULL here, so an empty message is stored as a single space).
func finalizeMessage(msg *types.WsMessage, avatarKey sql.NullString, replyToID *int64, s3Host string) {
	if avatarKey.Valid {
		msg.AuthorAvatarURL = utils.AvatarURLFromKey(avatarKey.String, s3Host)
	}
	if msg.Content == " " {
		msg.Content = ""
	}
	msg.ReplyToID = replyToID
}

func scanMessageRow(rows *sql.Rows, s3Host string) (types.WsMessage, error) {
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
		&msg.MentionsEveryone,
	); err != nil {
		return msg, err
	}
	finalizeMessage(&msg, avatarKey, replyToID, s3Host)
	return msg, nil
}

// enrichMessages attaches attachments, reply previews, mentions and link
// embeds to an already-fetched page of messages. Shared by every method that
// returns a page of full messages (as opposed to search hits, which only need
// a headline).
func (s *Storage) enrichMessages(ctx context.Context, messages []types.WsMessage, s3Host string) error {
	if len(messages) == 0 {
		return nil
	}

	msgIDs := make([]int64, len(messages))
	for i, m := range messages {
		msgIDs[i] = m.ID
	}

	atts, err := s.GetAttachmentsByMessageIDs(ctx, msgIDs, s3Host)
	if err != nil {
		return err
	}

	replyTos, err := s.GetMessageReplyTos(ctx, msgIDs, s3Host)
	if err != nil {
		return err
	}

	mentions, err := s.GetMessageMentions(ctx, msgIDs)
	if err != nil {
		return err
	}

	// Превью — необязательная часть сообщения: если таблица недоступна,
	// историю всё равно нужно отдать, просто без карточек.
	embeds, err := s.GetMessageEmbeds(ctx, msgIDs)
	if err != nil {
		embeds = nil
	}

	for i := range messages {
		if a, ok := atts[messages[i].ID]; ok {
			messages[i].Attachments = a
		}
		if rt, ok := replyTos[messages[i].ID]; ok {
			messages[i].ReplyTo = rt
		}
		if m, ok := mentions[messages[i].ID]; ok {
			messages[i].Mentions = m
		}
		if e, ok := embeds[messages[i].ID]; ok {
			messages[i].Embeds = e
		}
	}

	return nil
}

// CreateServer implements types.ServerStorage: it inserts the server and
// adds its owner as the first member, in one transaction, and invalidates
// the owner's GetServersByUserID cache entry.
func (s *Storage) CreateServer(ctx context.Context, server types.Server) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

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

// DeleteChannel implements types.ServerStorage, erroring if userID does not
// own the channel's server, and invalidates the channel's cached lookup,
// membership and access-check entries.
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

// DeleteServer implements types.ServerStorage, erroring if userID does not
// own the server, and invalidates every former member's GetServersByUserID
// and IsServerMember cache entries (a cache-invalidation query failure is
// logged and does not abort the deletion, since a stale cache entry is
// recoverable but an undeleted server is not).
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
		s.log.Error("failed to query server members for cache invalidation", "server_id", serverID, sl.Err(err))
	} else {
		for rows.Next() {
			var memberID int
			if err := rows.Scan(&memberID); err != nil {
				s.log.Error("failed to scan member id for cache invalidation", sl.Err(err))
				continue
			}
			s.cache.Delete(fmt.Sprintf("%s%d", serversUserKey, memberID))
			s.cache.Delete(fmt.Sprintf("%s%d:%d", memberKey, memberID, serverID))
		}
		_ = rows.Close()
	}

	_, err = s.db.ExecContext(ctx, "DELETE FROM servers WHERE id = $1", serverID)
	if err != nil {
		return err
	}
	s.cache.Delete(fmt.Sprintf("%s%d", channelsServerKey, serverID))
	s.cache.Delete(fmt.Sprintf("%s%d", membersServerKey, serverID))
	return nil
}

// CreateChannel implements types.ServerStorage; an empty channelType
// defaults to ChannelTypeText.
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

// IsServerMember implements types.ServerStorage, caching the result for 2
// minutes.
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

// CanUserAccessChannel implements types.ServerStorage, caching the result
// for 2 minutes.
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

// ListServerMembersUserIDs implements types.ServerStorage, caching the
// result for 2 minutes; callers always get a defensive copy of the cached
// slice.
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
	defer func() { _ = rows.Close() }()

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

// ListChannelMemberUserIDs implements types.ServerStorage, caching the
// result for 2 minutes; callers always get a defensive copy of the cached
// slice.
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
	defer func() { _ = rows.Close() }()

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

// SaveMessage implements types.ServerStorage, filling in msg.ID and
// msg.CreatedAt from the insert. Empty content is stored as a single space
// (messages.content is NOT NULL and an attachment-only message has no
// text), the same convention EditMessage follows.
func (s *Storage) SaveMessage(ctx context.Context, msg *types.WsMessage) error {
	content := msg.Content
	if content == "" {
		content = " "
	}

	var err error
	if msg.ReplyToID != nil && *msg.ReplyToID > 0 {
		query := `
		INSERT INTO messages (channel_id, author_id, content, reply_to_id, mentions_everyone)
		VALUES ($1,$2,$3,$4,$5)
		RETURNING id, created_at
		`
		err = s.db.QueryRowContext(
			ctx,
			query,
			msg.ChannelID,
			msg.AuthorID,
			content,
			*msg.ReplyToID,
			msg.MentionsEveryone,
		).Scan(&msg.ID, &msg.CreatedAt)
	} else {
		query := `
		INSERT INTO messages (channel_id, author_id, content, mentions_everyone)
		VALUES ($1,$2,$3,$4)
		RETURNING id, created_at
		`
		err = s.db.QueryRowContext(
			ctx,
			query,
			msg.ChannelID,
			msg.AuthorID,
			content,
			msg.MentionsEveryone,
		).Scan(&msg.ID, &msg.CreatedAt)
	}

	return err
}

// GetMessages implements types.ServerStorage.GetMessages: a backward page
// of history, clamped to [1, 100] messages, returned oldest-first.
func (s *Storage) GetMessages(ctx context.Context, channelID int64, limit int, cursor *types.WsMessageCursor, s3Host string) ([]types.WsMessage, *types.WsMessageCursor, bool, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	limitPlusOne := limit + 1

	query := `SELECT ` + messageColumns + `
		 FROM messages m
		 LEFT JOIN users u ON u.id = m.author_id
		 WHERE m.channel_id = $1
		 ORDER BY m.created_at DESC, m.id DESC
		 LIMIT $2`
	args := []any{channelID, limitPlusOne}

	if cursor != nil {
		query = `SELECT ` + messageColumns + `
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

	var messages []types.WsMessage
	for rows.Next() {
		msg, err := scanMessageRow(rows, s3Host)
		if err != nil {
			_ = rows.Close()
			return nil, nil, false, err
		}
		messages = append(messages, msg)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, nil, false, err
	}
	_ = rows.Close()

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

	if err := s.enrichMessages(ctx, messages, s3Host); err != nil {
		return nil, nil, false, err
	}

	return messages, nextCursor, hasMore, nil
}

// GetMessagesAfter loads the page of messages immediately following cursor,
// in ascending order. It is the forward-pagination counterpart to GetMessages
// (which only ever loads backward) — used to walk back down to the live tail
// after GetMessagesAround opened a window in the middle of history.
func (s *Storage) GetMessagesAfter(ctx context.Context, channelID int64, limit int, cursor *types.WsMessageCursor, s3Host string) ([]types.WsMessage, *types.WsMessageCursor, bool, error) {
	if cursor == nil {
		return nil, nil, false, errors.New("cursor is required")
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}

	limitPlusOne := limit + 1

	query := `SELECT ` + messageColumns + `
		 FROM messages m
		 LEFT JOIN users u ON u.id = m.author_id
		 WHERE m.channel_id = $1
		   AND (m.created_at, m.id) > ($2, $3)
		 ORDER BY m.created_at ASC, m.id ASC
		 LIMIT $4`

	rows, err := s.db.QueryContext(ctx, query, channelID, cursor.CreatedAt, cursor.ID, limitPlusOne)
	if err != nil {
		return nil, nil, false, err
	}

	var messages []types.WsMessage
	for rows.Next() {
		msg, err := scanMessageRow(rows, s3Host)
		if err != nil {
			_ = rows.Close()
			return nil, nil, false, err
		}
		messages = append(messages, msg)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, nil, false, err
	}
	_ = rows.Close()

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

	if err := s.enrichMessages(ctx, messages, s3Host); err != nil {
		return nil, nil, false, err
	}

	return messages, nextCursor, hasMore, nil
}

// GetMessagesAround loads a two-sided window of messages centered on
// messageID: up to limit messages older than (and including) the anchor, and
// up to limit messages newer. Used to jump straight to an arbitrary message
// (a search hit, a reply preview, a push notification) without walking
// GetMessages backward page by page.
func (s *Storage) GetMessagesAround(ctx context.Context, channelID, messageID int64, limit int, s3Host string) ([]types.WsMessage, *types.WsMessageCursor, *types.WsMessageCursor, bool, bool, error) {
	if limit <= 0 {
		limit = 25
	}
	if limit > 50 {
		limit = 50
	}
	limitPlusOne := limit + 1

	var anchorCreatedAt time.Time
	err := s.db.QueryRowContext(ctx,
		`SELECT created_at FROM messages WHERE id = $1 AND channel_id = $2`,
		messageID, channelID,
	).Scan(&anchorCreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil, nil, false, false, errors.New("message not found")
		}
		return nil, nil, nil, false, false, err
	}

	// Each half tags itself with a literal 'half' column: UNION ALL gives no
	// guarantee the two branches' rows arrive in their own ORDER BY sequence
	// (or even stay grouped together), so provenance can't be inferred from
	// row position — every row is re-sorted in Go below instead.
	query := `
		(SELECT ` + messageColumns + `, 'older' AS half
		 FROM messages m
		 LEFT JOIN users u ON u.id = m.author_id
		 WHERE m.channel_id = $1
		   AND (m.created_at, m.id) <= ($2, $3)
		 ORDER BY m.created_at DESC, m.id DESC
		 LIMIT $4)
		UNION ALL
		(SELECT ` + messageColumns + `, 'newer' AS half
		 FROM messages m
		 LEFT JOIN users u ON u.id = m.author_id
		 WHERE m.channel_id = $1
		   AND (m.created_at, m.id) > ($2, $3)
		 ORDER BY m.created_at ASC, m.id ASC
		 LIMIT $4)`

	rows, err := s.db.QueryContext(ctx, query, channelID, anchorCreatedAt, messageID, limitPlusOne)
	if err != nil {
		return nil, nil, nil, false, false, err
	}

	var older, newer []types.WsMessage
	for rows.Next() {
		var msg types.WsMessage
		var avatarKey sql.NullString
		var replyToID *int64
		var half string
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
			&msg.MentionsEveryone,
			&half,
		); err != nil {
			_ = rows.Close()
			return nil, nil, nil, false, false, err
		}
		finalizeMessage(&msg, avatarKey, replyToID, s3Host)
		if half == "older" {
			older = append(older, msg)
		} else {
			newer = append(newer, msg)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, nil, nil, false, false, err
	}
	_ = rows.Close()

	sort.Slice(older, func(i, j int) bool {
		if !older[i].CreatedAt.Equal(older[j].CreatedAt) {
			return older[i].CreatedAt.After(older[j].CreatedAt)
		}
		return older[i].ID > older[j].ID
	})
	hasMoreOlder := len(older) > limit
	if hasMoreOlder {
		older = older[:limit]
	}

	sort.Slice(newer, func(i, j int) bool {
		if !newer[i].CreatedAt.Equal(newer[j].CreatedAt) {
			return newer[i].CreatedAt.Before(newer[j].CreatedAt)
		}
		return newer[i].ID < newer[j].ID
	})
	hasMoreNewer := len(newer) > limit
	if hasMoreNewer {
		newer = newer[:limit]
	}

	messages := make([]types.WsMessage, 0, len(older)+len(newer))
	for i := len(older) - 1; i >= 0; i-- {
		messages = append(messages, older[i])
	}
	messages = append(messages, newer...)

	var olderCursor, newerCursor *types.WsMessageCursor
	if hasMoreOlder && len(messages) > 0 {
		first := messages[0]
		olderCursor = &types.WsMessageCursor{ChannelID: channelID, CreatedAt: first.CreatedAt, ID: first.ID}
	}
	if hasMoreNewer && len(messages) > 0 {
		last := messages[len(messages)-1]
		newerCursor = &types.WsMessageCursor{ChannelID: channelID, CreatedAt: last.CreatedAt, ID: last.ID}
	}

	if err := s.enrichMessages(ctx, messages, s3Host); err != nil {
		return nil, nil, nil, false, false, err
	}

	return messages, olderCursor, newerCursor, hasMoreOlder, hasMoreNewer, nil
}

// DeleteMessage implements types.ServerStorage.DeleteMessage: it errors if
// userID does not own the message, then deletes the row and returns the S3
// keys of its attachments (deleting the row does not delete the S3
// objects; the caller is responsible for that).
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
	defer func() { _ = rows.Close() }()

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

// EditMessage переписывает текст сообщения автора, если с момента создания
// прошло не больше window. Окно считает Postgres: messages.created_at —
// TIMESTAMP без таймзоны, заполняемый через now(), поэтому сравнивать его
// с time.Now() на стороне Go означало бы зависеть от совпадения TZ процесса
// и базы.
func (s *Storage) EditMessage(
	ctx context.Context,
	messageID int64,
	userID int,
	content string,
	window time.Duration,
) (int64, time.Time, error) {
	const checkQuery = `
		SELECT m.channel_id,
		       COALESCE(m.author_id, 0),
		       m.created_at < now() - make_interval(secs => $2) AS window_expired,
		       EXISTS (SELECT 1 FROM message_attachments a WHERE a.message_id = m.id) AS has_attachments
		FROM messages m
		WHERE m.id = $1`

	var (
		channelID      int64
		authorID       int
		windowExpired  bool
		hasAttachments bool
	)

	err := s.db.QueryRowContext(ctx, checkQuery, messageID, window.Seconds()).
		Scan(&channelID, &authorID, &windowExpired, &hasAttachments)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, time.Time{}, types.ErrMessageNotFound
		}
		return 0, time.Time{}, err
	}

	if authorID != userID {
		return 0, time.Time{}, types.ErrNotMessageOwner
	}
	if windowExpired {
		return 0, time.Time{}, types.ErrEditWindowExpired
	}
	if content == "" && !hasAttachments {
		return 0, time.Time{}, types.ErrEmptyContent
	}

	// Та же конвенция, что в SaveMessage: колонка NOT NULL, поэтому пустой
	// текст сообщения-с-вложением хранится как один пробел.
	if content == "" {
		content = " "
	}

	var editedAt time.Time
	if err := s.db.QueryRowContext(
		ctx,
		`UPDATE messages SET content = $2, edited_at = now() WHERE id = $1 RETURNING edited_at`,
		messageID,
		content,
	).Scan(&editedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, time.Time{}, types.ErrMessageNotFound
		}
		return 0, time.Time{}, err
	}

	return channelID, editedAt, nil
}

// SaveMessageAttachments implements types.ServerStorage, inserting in
// batches of 100 rows per statement inside one transaction.
func (s *Storage) SaveMessageAttachments(ctx context.Context, messageID int64, attachments []types.Attachment) error {
	if len(attachments) == 0 {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

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
			fmt.Fprintf(&sb, "($%d, $%d, $%d, $%d, $%d)", len(args)+1, len(args)+2, len(args)+3, len(args)+4, len(args)+5)
			args = append(args, messageID, a.FileKey, a.FileName, a.ContentType, a.SizeBytes)
		}

		if _, err := tx.ExecContext(ctx, sb.String(), args...); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// GetAttachmentsByMessageIDs implements types.ServerStorage in a single
// query for the whole batch, rebuilding each attachment's URL from its
// stored S3 key via s3Host.
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
	defer func() { _ = rows.Close() }()

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

// GetMessageReplyTos implements types.ServerStorage. For the given
// messages it finds which are replies, then batch-loads the referenced
// messages' preview info in a second query, returning a map keyed by the
// replying message's ID (not the referenced message's ID).
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
	defer func() { _ = rows.Close() }()

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
	defer func() { _ = refRows.Close() }()

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

// GetReplyPreview implements types.ServerStorage, loading a single
// message's preview info (used when a new message's reply_to_id is known
// but its target hasn't been batch-loaded via GetMessageReplyTos).
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

// AddMemberToServer implements types.ServerStorage, and invalidates the
// user's server-membership caches along with their per-channel access-check
// cache for every channel of serverID.
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

// GetServerChannels implements types.ServerStorage, caching the result for
// 5 minutes; callers always get a defensive copy of the cached slice.
// Channel.Type is normalized to ChannelTypeVoice/ChannelTypeText regardless
// of the stored value's casing/whitespace.
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
	defer func() { _ = rows.Close() }()

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

// GetServersByUserID implements types.ServerStorage, caching the result for
// 5 minutes; callers always get a defensive copy of the cached slice.
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

	defer func() { _ = rows.Close() }()

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

// GetChannelByID implements types.ServerStorage, caching the result for 5
// minutes; callers always get a defensive copy of the cached value.
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

// GetUnreadCounts implements types.ServerStorage, computing every channel
// userID is a member of and how many messages postdate their read cursor
// (channel_reads), in a single query.
func (s *Storage) GetUnreadCounts(ctx context.Context, userID int) ([]types.WsChannelUnread, error) {
	query := `
		SELECT c.id, c.server_id, COUNT(m.id)
		FROM channels c
		JOIN server_members sm
		  ON sm.server_id = c.server_id AND sm.user_id = $1
		LEFT JOIN channel_reads cr
		  ON cr.user_id = $1 AND cr.channel_id = c.id
		LEFT JOIN messages m
		  ON m.channel_id = c.id
		 AND m.author_id <> $1
		 AND (CASE
		        WHEN cr.last_read_message_id IS NOT NULL THEN m.id > cr.last_read_message_id
		        ELSE m.created_at > sm.joined_at
		      END)
		WHERE c.type = $2
		GROUP BY c.id, c.server_id
		HAVING COUNT(m.id) > 0
	`

	rows, err := s.db.QueryContext(ctx, query, userID, types.ChannelTypeText)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	result := make([]types.WsChannelUnread, 0)
	for rows.Next() {
		var item types.WsChannelUnread
		if err := rows.Scan(&item.ChannelID, &item.ServerID, &item.UnreadCount); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return result, nil
}

// MarkChannelRead implements types.ServerStorage.MarkChannelRead.
func (s *Storage) MarkChannelRead(ctx context.Context, userID int, channelID, messageID int64) error {
	query := `
		INSERT INTO channel_reads (user_id, channel_id, last_read_message_id, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (user_id, channel_id) DO UPDATE
		SET last_read_message_id = GREATEST(channel_reads.last_read_message_id, EXCLUDED.last_read_message_id),
		    updated_at = now()
	`

	_, err := s.db.ExecContext(ctx, query, userID, channelID, messageID)
	return err
}

// SearchMessages runs a full-text search against messages.search_vector
// (see migration 023) and returns a page of ts_headline'd hits, newest first.
// tsquery is always built via websearch_to_tsquery — never assembled by hand
// from user input, which would mean either fighting tsquery's operator syntax
// (AND/OR/<->) or risking a malformed-query error on arbitrary text.
func (s *Storage) SearchMessages(ctx context.Context, params types.MessageSearchParams, s3Host string) ([]types.WsMessageSearchHit, *types.WsMessageCursor, bool, error) {
	limit := params.Limit
	if limit <= 0 {
		limit = 25
	}
	if limit > 50 {
		limit = 50
	}
	limitPlusOne := limit + 1

	args := make([]any, 0, 8)
	args = append(args, params.Query)

	var sb strings.Builder
	sb.WriteString(`
		WITH q AS (
			SELECT websearch_to_tsquery('russian', $1) || websearch_to_tsquery('english', $1) AS tsq
		)
		SELECT m.id, m.channel_id, c.name, COALESCE(m.author_id, 0),
		       COALESCE(u.first_name, ''), COALESCE(u.last_name, ''), COALESCE(u.nickname, 'deleted user'), u.avatar_key,
		       ts_headline('russian', m.content, q.tsq,
		           'StartSel=[[HL]], StopSel=[[/HL]], MaxFragments=2, MaxWords=20, MinWords=8, ShortWord=3'),
		       m.created_at
		FROM messages m
		CROSS JOIN q
		JOIN channels c ON c.id = m.channel_id
		LEFT JOIN users u ON u.id = m.author_id
		WHERE m.search_vector @@ q.tsq`)

	if params.ServerID > 0 {
		fmt.Fprintf(&sb, " AND c.server_id = $%d AND c.type = $%d", len(args)+1, len(args)+2)
		args = append(args, params.ServerID, types.ChannelTypeText)
	} else {
		fmt.Fprintf(&sb, " AND m.channel_id = $%d", len(args)+1)
		args = append(args, params.ChannelID)
	}

	if params.AuthorID > 0 {
		fmt.Fprintf(&sb, " AND m.author_id = $%d", len(args)+1)
		args = append(args, params.AuthorID)
	}
	if params.HasFile {
		sb.WriteString(" AND EXISTS (SELECT 1 FROM message_attachments a WHERE a.message_id = m.id)")
	}
	if params.HasLink {
		sb.WriteString(" AND EXISTS (SELECT 1 FROM message_embeds e WHERE e.message_id = m.id)")
	}
	if params.Before != nil {
		fmt.Fprintf(&sb, " AND m.created_at < $%d", len(args)+1)
		args = append(args, *params.Before)
	}
	if params.After != nil {
		fmt.Fprintf(&sb, " AND m.created_at > $%d", len(args)+1)
		args = append(args, *params.After)
	}
	if params.Cursor != nil {
		fmt.Fprintf(&sb, " AND (m.created_at, m.id) < ($%d, $%d)", len(args)+1, len(args)+2)
		args = append(args, params.Cursor.CreatedAt, params.Cursor.ID)
	}

	fmt.Fprintf(&sb, " ORDER BY m.created_at DESC, m.id DESC LIMIT $%d", len(args)+1)
	args = append(args, limitPlusOne)

	rows, err := s.db.QueryContext(ctx, sb.String(), args...)
	if err != nil {
		return nil, nil, false, err
	}

	var hits []types.WsMessageSearchHit
	for rows.Next() {
		var hit types.WsMessageSearchHit
		var avatarKey sql.NullString
		if err := rows.Scan(
			&hit.MessageID,
			&hit.ChannelID,
			&hit.ChannelName,
			&hit.AuthorID,
			&hit.AuthorFirstName,
			&hit.AuthorLastName,
			&hit.AuthorNickname,
			&avatarKey,
			&hit.Headline,
			&hit.CreatedAt,
		); err != nil {
			_ = rows.Close()
			return nil, nil, false, err
		}
		if avatarKey.Valid {
			hit.AuthorAvatarURL = utils.AvatarURLFromKey(avatarKey.String, s3Host)
		}
		hits = append(hits, hit)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, nil, false, err
	}
	_ = rows.Close()

	hasMore := len(hits) > limit
	if hasMore {
		hits = hits[:limit]
	}

	var nextCursor *types.WsMessageCursor
	if hasMore && len(hits) > 0 {
		last := hits[len(hits)-1]
		nextCursor = &types.WsMessageCursor{ChannelID: last.ChannelID, CreatedAt: last.CreatedAt, ID: last.MessageID}
	}

	return hits, nextCursor, hasMore, nil
}

// SearchServersByName implements types.ServerStorage.SearchServersByName,
// clamping limit to [1, 50] and excluding servers userID already belongs
// to.
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
	defer func() { _ = rows.Close() }()

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
