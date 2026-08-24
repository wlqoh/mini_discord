package embed

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/middleware"
	"github.com/wlqoh/mini_discord.git/internal/storage/cache"
	"github.com/wlqoh/mini_discord.git/internal/storage/single_flight"
	"github.com/wlqoh/mini_discord.git/types"
)

const (
	jobBufferSize    = 256
	memoryCacheTTL   = 15 * time.Minute
	memoryCacheSweep = 5 * time.Minute
)

// Broadcaster is implemented by Hub. The interface is declared here rather
// than in server so embed does not import server (that would create a
// cycle: server → embed → server).
type Broadcaster interface {
	// BroadcastEmbeds delivers resolved link previews for messageID to
	// recipientIDs as a message_embeds event.
	BroadcastEmbeds(channelID, messageID int64, recipientIDs []int, embeds []types.WsLinkPreview)
}

// Job is everything a worker needs to resolve a message's link preview
// without calling back into the hub.
type Job struct {
	MessageID    int64
	ChannelID    int64
	AuthorID     int
	Content      string
	RecipientIDs []int
}

// Service resolves link previews for chat messages: it extracts the first
// eligible URL from a message, resolves it through a three-tier cache
// (memory → Postgres → network fetch, see resolve), and broadcasts the
// result back through Broadcaster once ready. Work is queued via Enqueue
// and processed by a pool of background workers, so it never blocks the
// hub's event loop.
type Service struct {
	cfg       config.LinkPreviewConfig
	storage   types.EmbedStorage
	log       *slog.Logger
	fetcher   *Fetcher
	cache     *cache.Cache
	sf        *single_flight.SingleFlight
	limiter   *middleware.TokenBucket
	skipHosts map[string]struct{}
	jobs      chan Job

	mu          sync.RWMutex
	broadcaster Broadcaster
}

type cachedPreview struct {
	hash    string
	preview types.WsLinkPreview
	ok      bool
}

// NewService builds a Service and, if cfg.Enabled, starts cfg.Workers
// background goroutines (at least 1) draining its job queue. If disabled,
// Enqueue becomes a no-op. The service has no Broadcaster yet — call
// SetBroadcaster once the hub exists.
func NewService(storage types.EmbedStorage, cfg config.LinkPreviewConfig, log *slog.Logger, skipHosts map[string]struct{}) *Service {
	service := &Service{
		cfg:     cfg,
		storage: storage,
		log:     log,
		fetcher: NewFetcher(cfg),
		cache:   cache.NewCache(memoryCacheTTL, memoryCacheSweep),
		sf:      single_flight.NewSingleFlight(),
		// Хаб уже режет send_message до 1/с на пользователя, так что этот лимит —
		// вторая линия обороны: он не даёт устроить с нашего IP обход чужих
		// хостов даже при всплеске сообщений со ссылками.
		limiter:   middleware.NewTokenBucket(0.5, 10.0),
		skipHosts: skipHosts,
		jobs:      make(chan Job, jobBufferSize),
	}

	if !cfg.Enabled {
		return service
	}

	workers := cfg.Workers
	if workers <= 0 {
		workers = 1
	}
	for i := 0; i < workers; i++ {
		go service.worker()
	}

	return service
}

// SetBroadcaster is called once after the Hub is constructed — the hub and
// this service reference each other, so the cycle is closed as a second
// step rather than at construction. Safe for concurrent use with Enqueue's
// workers.
func (s *Service) SetBroadcaster(broadcaster Broadcaster) {
	s.mu.Lock()
	s.broadcaster = broadcaster
	s.mu.Unlock()
}

// Enqueue never blocks: it is called from the Hub.Run goroutine that
// services every user's commands. If job is eligible (content contains a
// link, the per-author rate limit allows it) but the queue is full, the job
// is dropped and logged rather than blocking — a message with no preview is
// not a critical failure.
func (s *Service) Enqueue(job Job) {
	if !s.cfg.Enabled {
		return
	}
	if !strings.Contains(job.Content, "http") {
		return
	}
	if !s.limiter.Allow(strconv.Itoa(job.AuthorID)) {
		return
	}

	select {
	case s.jobs <- job:
	default:
		s.log.Warn("link preview queue is full, dropping job", "message_id", job.MessageID)
	}
}

func (s *Service) worker() {
	for job := range s.jobs {
		s.process(job)
	}
}

func (s *Service) process(job Job) {
	// Свой контекст, не связанный с WS-запросом: клиент мог уже отключиться,
	// а превью всё равно нужно доделать и сохранить для остальных.
	ctx, cancel := context.WithTimeout(context.Background(), 2*s.cfg.Timeout+2*time.Second)
	defer cancel()

	target := s.firstEligibleURL(job.Content)
	if target == "" {
		return
	}

	resolved, ok := s.resolve(ctx, target)
	if !ok {
		return
	}

	if err := s.storage.LinkMessageEmbed(ctx, job.MessageID, 0, resolved.hash); err != nil {
		// Обычная причина — сообщение удалили, пока мы ходили в сеть:
		// FK на messages(id) не даст привязать превью к несуществующей строке.
		s.log.Debug("failed to link message embed", "message_id", job.MessageID, "error", err.Error())
		return
	}

	s.mu.RLock()
	broadcaster := s.broadcaster
	s.mu.RUnlock()
	if broadcaster == nil {
		return
	}

	broadcaster.BroadcastEmbeds(job.ChannelID, job.MessageID, job.RecipientIDs, []types.WsLinkPreview{resolved.preview})
}

func (s *Service) firstEligibleURL(content string) string {
	for _, candidate := range ExtractURLs(content) {
		normalized, err := NormalizeURL(candidate)
		if err != nil {
			continue
		}
		parsed, err := url.Parse(normalized)
		if err != nil {
			continue
		}
		// Свой фронтенд и бакет с вложениями пропускаем: они уже отрисованы
		// в интерфейсе, превью только задублирует их.
		if _, skip := s.skipHosts[strings.ToLower(parsed.Hostname())]; skip {
			continue
		}
		return normalized
	}
	return ""
}

// resolve is the three-tier cache: memory → Postgres → network. The
// network tier is wrapped in single_flight so that ten people posting the
// same link at once trigger exactly one fetch.
func (s *Service) resolve(ctx context.Context, normalizedURL string) (cachedPreview, bool) {
	sum := sha256.Sum256([]byte(normalizedURL))
	hash := hex.EncodeToString(sum[:])

	if raw, found := s.cache.Get(cacheKey(hash)); found {
		if entry, valid := raw.(cachedPreview); valid {
			return entry, entry.ok
		}
	}

	if record, err := s.storage.GetLinkPreview(ctx, hash); err != nil {
		s.log.Error("failed to read link preview", "error", err.Error())
	} else if record != nil && s.isFresh(record) {
		entry := s.toCached(record)
		s.cache.Set(cacheKey(hash), entry, 0)
		return entry, entry.ok
	}

	raw, err := s.sf.Do(ctx, hash, func(ctx context.Context) (interface{}, error) {
		return s.fetchAndStore(ctx, hash, normalizedURL), nil
	})
	if err != nil {
		return cachedPreview{}, false
	}

	entry, valid := raw.(cachedPreview)
	if !valid {
		return cachedPreview{}, false
	}

	return entry, entry.ok
}

func (s *Service) fetchAndStore(ctx context.Context, hash, normalizedURL string) cachedPreview {
	record, err := s.fetcher.Fetch(ctx, normalizedURL)
	if err != nil {
		record = types.LinkPreviewRecord{URL: normalizedURL, Status: types.LinkPreviewStatusFailed}
		s.log.Debug("link preview fetch failed", "url", normalizedURL, "error", err.Error())
	}

	record.URLHash = hash
	record.URL = normalizedURL
	if record.ImageURL != "" {
		record.ImageToken = newImageToken()
	}

	// Токен возвращается из БД: если запись уже существовала, за ней
	// закреплён прежний токен, и разосланные ранее ссылки на картинку живы.
	effectiveToken, err := s.storage.UpsertLinkPreview(ctx, record)
	if err != nil {
		s.log.Error("failed to store link preview", "error", err.Error())
		return cachedPreview{}
	}
	record.ImageToken = effectiveToken

	entry := s.toCached(&record)
	s.cache.Set(cacheKey(hash), entry, 0)

	return entry
}

func (s *Service) isFresh(record *types.LinkPreviewRecord) bool {
	ttl := s.cfg.NegativeTTL
	if record.Status == types.LinkPreviewStatusOK {
		ttl = s.cfg.CacheTTL
	}
	return time.Since(record.FetchedAt) < ttl
}

func (s *Service) toCached(record *types.LinkPreviewRecord) cachedPreview {
	if record.Status != types.LinkPreviewStatusOK {
		return cachedPreview{hash: record.URLHash, ok: false}
	}

	return cachedPreview{
		hash: record.URLHash,
		ok:   true,
		preview: types.WsLinkPreview{
			URL:         record.URL,
			Title:       record.Title,
			Description: record.Description,
			SiteName:    record.SiteName,
			ImageToken:  record.ImageToken,
		},
	}
}

func cacheKey(hash string) string {
	return "linkpreview:" + hash
}

// newImageToken must be unguessable: if the URL's sha256 were exposed
// directly, anyone could check "has this link been posted in this chat" by
// hashing it themselves and hitting the image proxy.
func newImageToken() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return ""
	}
	return hex.EncodeToString(buffer)
}
