package ws

import (
	"log"
	"log/slog"
	"sync"
	"time"

	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"github.com/wlqoh/mini_discord.git/internal/lib/logger/sl"
	"github.com/wlqoh/mini_discord.git/types"
)

type client struct {
	isClosing bool
	mu        sync.Mutex
}

type Handler struct {
	log        *slog.Logger
	wsClients  map[*websocket.Conn]*client
	register   chan *websocket.Conn
	broadcast  chan *types.WsMessage
	unregister chan *websocket.Conn
	//mutex     *sync.RWMutex

}

func NewHandler(log *slog.Logger) *Handler {
	return &Handler{
		log:        log,
		wsClients:  make(map[*websocket.Conn]*client),
		register:   make(chan *websocket.Conn),
		broadcast:  make(chan *types.WsMessage),
		unregister: make(chan *websocket.Conn),
		//mutex:     &sync.RWMutex{},
	}
}

func (h *Handler) runHub() {
	for {
		select {
		case connection := <-h.register:
			h.wsClients[connection] = &client{}
			log.Println("connection registered", connection.RemoteAddr().String())

		case message := <-h.broadcast:
			log.Println("message received:", message)

			for connection, c := range h.wsClients {
				go func(connection *websocket.Conn, c *client) {
					c.mu.Lock()
					defer c.mu.Unlock()
					if c.isClosing {
						return
					}
					if err := connection.WriteJSON(message); err != nil {
						c.isClosing = true
						log.Println("connection lost", err)

						connection.WriteMessage(websocket.CloseMessage, []byte{})
						connection.Close()
						h.unregister <- connection
					}
				}(connection, c)
			}

		case connection := <-h.unregister:
			delete(h.wsClients, connection)
			log.Println("connection unregistered")
		}
	}
}

func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Use("/ws", isWebsocketUpgraded)
	router.Get("/ws", websocket.New(h.wsHandler))
	router.Get("/test", websocket.New(h.handleTest))
	go h.runHub()
}

func (h *Handler) wsHandler(c *websocket.Conn) {
	defer func() {
		h.unregister <- c
		c.Close()
	}()

	h.register <- c

	for {
		msg := new(types.WsMessage)
		messageType, message, err := c.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				h.log.Error("Error reading from websocket", sl.Err(err))
			}

			return
		}

		if messageType == websocket.TextMessage {
			msg.Message = string(message)
			msg.IPAddress = c.RemoteAddr().String()
			msg.Time = time.Now().Format("15:04")
			h.broadcast <- msg
		} else {
			h.log.Info("websocket message received of type", messageType)
		}
	}
}

func isWebsocketUpgraded(c *fiber.Ctx) error {
	if websocket.IsWebSocketUpgrade(c) {
		c.Locals("allowed", true)
		return c.Next()
	}

	return c.SendStatus(fiber.StatusUpgradeRequired)
}

func (h *Handler) handleTest(c *websocket.Conn) {
	c.WriteMessage(websocket.TextMessage, []byte("Hello World"))
}
