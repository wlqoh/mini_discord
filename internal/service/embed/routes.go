package embed

import (
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/lib/logger/sl"
	"github.com/wlqoh/mini_discord.git/internal/middleware"
	"github.com/wlqoh/mini_discord.git/internal/storage/cache"
	"github.com/wlqoh/mini_discord.git/types"
	"github.com/wlqoh/mini_discord.git/utils"
)

const (
	imageTokenLength = 32
	// Мелкие картинки держим в памяти, чтобы не ходить наружу на каждый
	// первый показ у каждого пользователя. Крупные не кэшируем вовсе —
	// у cache.Cache нет ограничения по объёму, и это единственный способ
	// не дать ему разрастись.
	inlineImageCacheLimit = 256 * 1024
	imageCacheTTL         = 30 * time.Minute
)

// Handler serves the embed image proxy (GET /embeds/image/:token), which
// re-fetches or serves from cache the image referenced by a previously
// resolved link preview.
type Handler struct {
	storage types.EmbedStorage
	cfg     config.LinkPreviewConfig
	log     *slog.Logger
	fetcher *Fetcher
	cache   *cache.Cache
}

// NewHandler builds a Handler with its own image cache and Fetcher.
func NewHandler(storage types.EmbedStorage, cfg config.LinkPreviewConfig, log *slog.Logger) *Handler {
	return &Handler{
		storage: storage,
		cfg:     cfg,
		log:     log,
		fetcher: NewFetcher(cfg),
		cache:   cache.NewCache(imageCacheTTL, 10*time.Minute),
	}
}

// RegisterRoutes mounts the image proxy route on router if link previews
// are enabled (cfg.Enabled); otherwise it is a no-op.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	if !h.cfg.Enabled {
		return
	}

	// Эндпоинт намеренно без JWT: <img src> не умеет слать Authorization,
	// а токен в query утёк бы в Referer и логи. Защита строится на другом —
	// проксируется только URL, уже лежащий в link_previews, и только по
	// случайному 128-битному токену.
	limiter := middleware.NewTokenBucket(20.0, 60.0)
	router.Get("/embeds/image/:token", limiter.FiberRateLimitMiddleware(), h.handleImage)
}

func (h *Handler) handleImage(c *fiber.Ctx) error {
	token := c.Params("token")
	if !isImageToken(token) {
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid image token")
	}

	if raw, found := h.cache.Get(imageCacheKey(token)); found {
		if image, valid := raw.(FetchedImage); valid {
			return h.sendImage(c, image)
		}
	}

	record, err := h.storage.GetLinkPreviewByImageToken(c.Context(), token)
	if err != nil {
		h.log.Error("failed to resolve preview image", sl.Err(err))
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to resolve preview image")
	}
	if record == nil || record.Status != types.LinkPreviewStatusOK || record.ImageURL == "" {
		return utils.WriteError(c, fiber.StatusNotFound, "preview image not found")
	}

	image, err := h.fetcher.FetchImage(c.Context(), record.ImageURL)
	if err != nil {
		h.log.Debug("failed to fetch preview image", "url", record.ImageURL, sl.Err(err))
		return utils.WriteError(c, fiber.StatusBadGateway, "failed to fetch preview image")
	}

	if int64(len(image.Body)) <= inlineImageCacheLimit {
		h.cache.Set(imageCacheKey(token), image, 0)
	}

	return h.sendImage(c, image)
}

func (h *Handler) sendImage(c *fiber.Ctx, image FetchedImage) error {
	c.Set(fiber.HeaderContentType, image.ContentType)
	// Картинка превью неизменна для данного токена, поэтому браузер может
	// держать её у себя долго — это снимает основную часть нагрузки с прокси.
	c.Set(fiber.HeaderCacheControl, "public, max-age=86400")
	c.Set("X-Content-Type-Options", "nosniff")
	return c.Send(image.Body)
}

func isImageToken(token string) bool {
	if len(token) != imageTokenLength {
		return false
	}
	for i := 0; i < len(token); i++ {
		char := token[i]
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func imageCacheKey(token string) string {
	return "embedimage:" + token
}
