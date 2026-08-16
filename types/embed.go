package types

import (
	"context"
	"time"
)

// Статусы записи в link_previews. `empty` — страница получена, но пригодных
// метаданных в ней нет; `failed` — не получена вовсе. Различаем их, потому что
// у них разный смысл при ретраях, хотя TTL сейчас одинаковый.
const (
	LinkPreviewStatusOK     = "ok"
	LinkPreviewStatusEmpty  = "empty"
	LinkPreviewStatusFailed = "failed"
)

// LinkPreviewRecord — строка кэша link_previews.
type LinkPreviewRecord struct {
	URLHash     string
	URL         string
	Status      string
	Title       string
	Description string
	SiteName    string
	ImageURL    string
	ImageToken  string
	FetchedAt   time.Time
}

// WsLinkPreview — то, что уезжает клиенту. Сырой ImageURL наружу не отдаётся
// никогда: вместо него ImageToken, по которому картинка запрашивается у нас.
type WsLinkPreview struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	SiteName    string `json:"site_name,omitempty"`
	ImageToken  string `json:"image_token,omitempty"`
}

// WsMessageEmbedsEvent — payload события message_embeds.
type WsMessageEmbedsEvent struct {
	ChannelID int64           `json:"channel_id"`
	MessageID int64           `json:"message_id"`
	Embeds    []WsLinkPreview `json:"embeds"`
}

type EmbedStorage interface {
	GetLinkPreview(ctx context.Context, urlHash string) (*LinkPreviewRecord, error)
	GetLinkPreviewByImageToken(ctx context.Context, imageToken string) (*LinkPreviewRecord, error)
	// UpsertLinkPreview возвращает действующий image_token: при обновлении
	// существующей записи он сохраняется, а не перегенерируется, иначе бы
	// протухли все уже разосланные клиентам ссылки на картинку.
	UpsertLinkPreview(ctx context.Context, record LinkPreviewRecord) (string, error)
	LinkMessageEmbed(ctx context.Context, messageID int64, position int, urlHash string) error
	GetMessageEmbeds(ctx context.Context, messageIDs []int64) (map[int64][]WsLinkPreview, error)
}
