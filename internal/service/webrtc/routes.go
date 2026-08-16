package webrtc

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"log/slog"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/middleware"
	"github.com/wlqoh/mini_discord.git/types"
	"github.com/wlqoh/mini_discord.git/utils"
)

type Handler struct {
	storage middleware.UserReader
	cfg     *config.Config
	log     *slog.Logger
}

func NewHandler(storage middleware.UserReader, cfg *config.Config, log *slog.Logger) *Handler {
	return &Handler{storage: storage, cfg: cfg, log: log}
}

func (h *Handler) RegisterRoutes(router fiber.Router) {
	auth := middleware.WithJWTAuth(h.storage, h.log, false, []byte(h.cfg.JWTSecret))
	router.Get("/webrtc/turn-credentials", auth, h.handleTurnCredentials)
}

// handleTurnCredentials mints short-lived TURN credentials using coturn's
// use-auth-secret scheme (REST API for TURN Server, RFC-inspired). The
// frontend previously called this endpoint (turnApi.ts) without it ever
// being registered, so every deployment silently ran on STUN alone unless
// static VITE_WEBRTC_TURN_* credentials were baked into the frontend build —
// which fails closed for anyone behind a symmetric NAT/CGNAT.
func (h *Handler) handleTurnCredentials(c *fiber.Ctx) error {
	cfg := h.cfg.WebRTC
	if len(cfg.TurnURLs) == 0 || cfg.TurnStaticAuthSecret == "" {
		return utils.WriteError(c, fiber.StatusNotFound, "TURN is not configured")
	}

	userID, _ := c.Locals("user_id").(int)
	ttl := cfg.TurnCredentialsTTLSeconds
	if ttl <= 0 {
		ttl = 600
	}

	expiresAt := time.Now().Add(time.Duration(ttl) * time.Second)
	// coturn's use-auth-secret format: username = "<unix_expiry>:<any id>",
	// password = base64(HMAC-SHA1(secret, username)).
	username := strconv.FormatInt(expiresAt.Unix(), 10) + ":" + strconv.Itoa(userID)

	mac := hmac.New(sha1.New, []byte(cfg.TurnStaticAuthSecret))
	mac.Write([]byte(username))
	credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	return c.JSON(types.TurnCredentialsResponse{
		URLs:       cfg.TurnURLs,
		Username:   username,
		Credential: credential,
		TTLSeconds: ttl,
		ExpiresAt:  expiresAt.UTC(),
	})
}
