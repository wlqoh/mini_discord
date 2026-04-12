package server

import (
	"net/url"
	"strings"

	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/wlqoh/mini_discord.git/internal/service/auth"
	"github.com/wlqoh/mini_discord.git/types"
)

type Handler struct {
	hub            *Hub
	allowedOrigins map[string]struct{}
}

func NewHandler(h *Hub, allowedOrigins []string) *Handler {
	origins := make(map[string]struct{}, len(allowedOrigins))
	for _, raw := range allowedOrigins {
		normalized := normalizeOrigin(raw)
		if normalized == "" {
			continue
		}
		origins[normalized] = struct{}{}
	}

	return &Handler{
		hub:            h,
		allowedOrigins: origins,
	}
}

func (h *Handler) RegisterRoutes(router fiber.Router) {

	router.Use("/server", auth.WithJWTAuth(h.hub.storage, h.hub.log, true))
	router.Use("/server/ws", h.isWebsocketUpgraded)
	router.Get("/server/ws", websocket.New(h.handleSocket))
}

func (h *Handler) handleSocket(c *websocket.Conn) {
	rawUserID := c.Locals("user_id")
	clientID, ok := rawUserID.(int)

	if !ok || clientID <= 0 {
		_ = c.WriteJSON(map[string]string{"error": "permission denied"})
		_ = c.Close()
		return
	}

	cl := &Client{
		Conn:     c,
		Outbound: make(chan *types.WsEvent, 32),
		UserID:   clientID,
	}

	h.hub.Register <- cl

	go cl.writeMessage()
	cl.readMessage(h.hub)
}

func (h *Handler) isWebsocketUpgraded(c *fiber.Ctx) error {
	if websocket.IsWebSocketUpgrade(c) {
		if len(h.allowedOrigins) > 0 {
			origin := normalizeOrigin(c.Get("Origin"))
			if origin != "" {
				if _, ok := h.allowedOrigins[origin]; !ok {
					return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "origin is not allowed"})
				}
			}
		}

		c.Locals("allowed", true)
		return c.Next()
	}

	return c.SendStatus(fiber.StatusUpgradeRequired)
}

func normalizeOrigin(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}

	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}

	return strings.ToLower(parsed.Scheme + "://" + parsed.Host)
}
