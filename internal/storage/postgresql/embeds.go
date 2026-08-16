package postgresql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/wlqoh/mini_discord.git/types"
)

func (s *Storage) GetLinkPreview(ctx context.Context, urlHash string) (*types.LinkPreviewRecord, error) {
	const query = `
		SELECT url_hash, url, status, title, description, site_name, image_url, image_token, fetched_at
		FROM link_previews
		WHERE url_hash = $1`

	var record types.LinkPreviewRecord
	err := s.db.QueryRowContext(ctx, query, urlHash).Scan(
		&record.URLHash,
		&record.URL,
		&record.Status,
		&record.Title,
		&record.Description,
		&record.SiteName,
		&record.ImageURL,
		&record.ImageToken,
		&record.FetchedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	return &record, nil
}

func (s *Storage) GetLinkPreviewByImageToken(ctx context.Context, imageToken string) (*types.LinkPreviewRecord, error) {
	if imageToken == "" {
		return nil, nil
	}

	const query = `
		SELECT url_hash, url, status, title, description, site_name, image_url, image_token, fetched_at
		FROM link_previews
		WHERE image_token = $1`

	var record types.LinkPreviewRecord
	err := s.db.QueryRowContext(ctx, query, imageToken).Scan(
		&record.URLHash,
		&record.URL,
		&record.Status,
		&record.Title,
		&record.Description,
		&record.SiteName,
		&record.ImageURL,
		&record.ImageToken,
		&record.FetchedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	return &record, nil
}

// UpsertLinkPreview обновляет запись на месте и возвращает действующий
// image_token. Токен перевыпускается только если его ещё не было: иначе
// ссылки на картинку, уже разосланные клиентам, начали бы отдавать 404.
func (s *Storage) UpsertLinkPreview(ctx context.Context, record types.LinkPreviewRecord) (string, error) {
	const query = `
		INSERT INTO link_previews (url_hash, url, status, title, description, site_name, image_url, image_token, fetched_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
		ON CONFLICT (url_hash) DO UPDATE SET
			url         = EXCLUDED.url,
			status      = EXCLUDED.status,
			title       = EXCLUDED.title,
			description = EXCLUDED.description,
			site_name   = EXCLUDED.site_name,
			image_url   = EXCLUDED.image_url,
			image_token = CASE
				WHEN EXCLUDED.image_url = ''          THEN ''
				WHEN link_previews.image_token = ''   THEN EXCLUDED.image_token
				ELSE link_previews.image_token
			END,
			fetched_at  = now()
		RETURNING image_token`

	var effectiveToken string
	err := s.db.QueryRowContext(
		ctx,
		query,
		record.URLHash,
		record.URL,
		record.Status,
		record.Title,
		record.Description,
		record.SiteName,
		record.ImageURL,
		record.ImageToken,
	).Scan(&effectiveToken)

	return effectiveToken, err
}

func (s *Storage) LinkMessageEmbed(ctx context.Context, messageID int64, position int, urlHash string) error {
	const query = `
		INSERT INTO message_embeds (message_id, position, url_hash)
		VALUES ($1, $2, $3)
		ON CONFLICT (message_id, position) DO UPDATE SET url_hash = EXCLUDED.url_hash`

	_, err := s.db.ExecContext(ctx, query, messageID, position, urlHash)
	return err
}

// GetMessageEmbeds догружает превью пачкой — по образцу
// GetAttachmentsByMessageIDs. Фильтр по status держит выдачу чистой: неудачные
// фетчи к сообщениям не привязываются, но условие защищает от случая, когда
// запись деградировала до failed при обновлении по TTL.
func (s *Storage) GetMessageEmbeds(ctx context.Context, messageIDs []int64) (map[int64][]types.WsLinkPreview, error) {
	if len(messageIDs) == 0 {
		return nil, nil
	}

	args := make([]any, len(messageIDs))
	placeholders := make([]string, len(messageIDs))
	for i, id := range messageIDs {
		args[i] = id
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}

	query := fmt.Sprintf(`
		SELECT e.message_id, p.url, p.title, p.description, p.site_name, p.image_token
		FROM message_embeds e
		JOIN link_previews p ON p.url_hash = e.url_hash
		WHERE e.message_id IN (%s) AND p.status = 'ok'
		ORDER BY e.message_id, e.position`,
		strings.Join(placeholders, ","),
	)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[int64][]types.WsLinkPreview)
	for rows.Next() {
		var messageID int64
		var preview types.WsLinkPreview
		if err := rows.Scan(
			&messageID,
			&preview.URL,
			&preview.Title,
			&preview.Description,
			&preview.SiteName,
			&preview.ImageToken,
		); err != nil {
			return nil, err
		}
		result[messageID] = append(result[messageID], preview)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	return result, nil
}
