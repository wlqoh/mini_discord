package server

import (
	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/wlqoh/mini_discord.git/internal/service/auth"
	"github.com/wlqoh/mini_discord.git/types"
)

type Handler struct {
	hub *Hub
}

func NewHandler(h *Hub) *Handler {
	return &Handler{
		hub: h,
	}
}

func (h *Handler) RegisterRoutes(router fiber.Router) {

	router.Use("/server", auth.WithJWTAuth(h.hub.storage, h.hub.log, true))
	router.Use("/server/ws", isWebsocketUpgraded)
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

func isWebsocketUpgraded(c *fiber.Ctx) error {
	if websocket.IsWebSocketUpgrade(c) {
		c.Locals("allowed", true)
		return c.Next()
	}

	return c.SendStatus(fiber.StatusUpgradeRequired)
}
