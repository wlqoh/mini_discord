package types

import (
	"context"
	"time"
)

// Status values for a link_previews row. LinkPreviewStatusEmpty means the
// page was fetched but no usable metadata was found in it;
// LinkPreviewStatusFailed means the fetch itself failed. They are kept
// distinct because they carry different meaning on retry, even though both
// currently share the same cache TTL.
const (
	LinkPreviewStatusOK     = "ok"
	LinkPreviewStatusEmpty  = "empty"
	LinkPreviewStatusFailed = "failed"
)

// LinkPreviewRecord is one row of the link_previews cache table.
type LinkPreviewRecord struct {
	URLHash     string
	URL         string
	Status      string // one of LinkPreviewStatusOK/Empty/Failed
	Title       string
	Description string
	SiteName    string
	ImageURL    string // source image URL; never sent to clients, see WsLinkPreview
	ImageToken  string // opaque handle clients use to fetch ImageURL via our proxy
	FetchedAt   time.Time
}

// WsLinkPreview is what is sent to the client. The raw ImageURL is never
// exposed; ImageToken is used instead to request the image through our own
// proxy.
type WsLinkPreview struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	SiteName    string `json:"site_name,omitempty"`
	ImageToken  string `json:"image_token,omitempty"`
}

// WsMessageEmbedsEvent is the payload of the message_embeds event.
type WsMessageEmbedsEvent struct {
	ChannelID int64           `json:"channel_id"`
	MessageID int64           `json:"message_id"`
	Embeds    []WsLinkPreview `json:"embeds"`
}

// EmbedStorage persists link-preview cache rows and their association with
// messages, and is implemented by *postgresql.Storage.
type EmbedStorage interface {
	// GetLinkPreview looks up a cached preview by the hash of its source URL.
	GetLinkPreview(ctx context.Context, urlHash string) (*LinkPreviewRecord, error)
	// GetLinkPreviewByImageToken looks up a cached preview by the opaque
	// token used to request its proxied image, for the embed image-proxy
	// route.
	GetLinkPreviewByImageToken(ctx context.Context, imageToken string) (*LinkPreviewRecord, error)
	// UpsertLinkPreview inserts or refreshes a cache row and returns the
	// image_token now in effect. When updating an existing row the previous
	// token is preserved rather than regenerated, since regenerating it
	// would invalidate image links already sent to clients.
	UpsertLinkPreview(ctx context.Context, record LinkPreviewRecord) (string, error)
	// LinkMessageEmbed associates a cached preview (by urlHash) with a
	// message at the given position, so GetMessageEmbeds can later return it
	// alongside the message.
	LinkMessageEmbed(ctx context.Context, messageID int64, position int, urlHash string) error
	// GetMessageEmbeds returns the linked previews for each of messageIDs,
	// keyed by message ID; messages with no embeds are omitted from the map.
	GetMessageEmbeds(ctx context.Context, messageIDs []int64) (map[int64][]WsLinkPreview, error)
}
