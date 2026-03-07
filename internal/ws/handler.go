package ws

import (
	"net/http"

	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
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
	router.Post("/ws/createRoom", h.CreateRoom)
	router.Use("/ws/joinRoom/:room_id", isWebsocketUpgraded)
	router.Get("/ws/joinRoom/:room_id", websocket.New(h.JoinRoom))
	router.Get("/ws/getRooms", h.GetRooms)
	router.Get("/ws/getClients/:room_id", h.GetClients)
}

func (h *Handler) CreateRoom(c *fiber.Ctx) error {
	var request types.CreateRoomRequest
	if err := c.BodyParser(&request); err != nil {
		return c.Status(fiber.StatusBadRequest).SendString("error: " + err.Error())
	}

	h.hub.mu.Lock()
	h.hub.Rooms[request.ID] = &Room{
		ID:      request.ID,
		Name:    request.Name,
		Clients: make(map[string]*Client),
	}
	h.hub.mu.Unlock()

	return c.Status(http.StatusOK).JSON(request)

}

func (h *Handler) JoinRoom(c *websocket.Conn) {
	roomID := c.Params("room_id")
	clientID := c.Query("user_id")
	username := c.Query("username")

	cl := &Client{
		Conn:     c,
		Message:  make(chan *types.WsMessage),
		ID:       clientID,
		RoomID:   roomID,
		Username: username,
	}

	m := &types.WsMessage{
		Content:  "A new user has joined the room",
		RoomID:   roomID,
		Username: username,
	}

	h.hub.Register <- cl
	h.hub.Broadcast <- m

	go cl.writeMessage()
	cl.readMessage(h.hub)
}

func (h *Handler) GetRooms(c *fiber.Ctx) error {
	rooms := make([]types.RoomResponse, 0)

	h.hub.mu.RLock()
	for _, r := range h.hub.Rooms {
		rooms = append(rooms, types.RoomResponse{
			ID:   r.ID,
			Name: r.Name,
		})
	}
	h.hub.mu.RUnlock()

	return c.Status(http.StatusOK).JSON(rooms)
}

func (h *Handler) GetClients(c *fiber.Ctx) error {
	var clients []types.ClientResponse
	roomID := c.Params("room_id")

	h.hub.mu.RLock()
	room, ok := h.hub.Rooms[roomID]
	if !ok {
		h.hub.mu.RUnlock()
		clients = make([]types.ClientResponse, 0)

		return c.Status(http.StatusOK).JSON(clients)
	}

	for _, c := range room.Clients {
		clients = append(clients, types.ClientResponse{
			ID:       c.ID,
			Username: c.Username,
		})
	}
	h.hub.mu.RUnlock()

	return c.Status(http.StatusOK).JSON(clients)
}

func isWebsocketUpgraded(c *fiber.Ctx) error {
	if websocket.IsWebSocketUpgrade(c) {
		c.Locals("allowed", true)
		return c.Next()
	}

	return c.SendStatus(fiber.StatusUpgradeRequired)
}
