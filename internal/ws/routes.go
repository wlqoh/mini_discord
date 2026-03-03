package ws

import (
	"errors"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/wlqoh/mini_discord.git/internal/lib/logger/sl"
	"github.com/wlqoh/mini_discord.git/types"
)

type Handler struct {
	upgrader  *websocket.Upgrader
	log       *slog.Logger
	wsClients map[*websocket.Conn]struct{}
	mutex     *sync.RWMutex
	broadcast chan *types.WsMessage
}

func NewHandler(log *slog.Logger) *Handler {
	return &Handler{
		upgrader:  &websocket.Upgrader{},
		log:       log,
		wsClients: map[*websocket.Conn]struct{}{},
		mutex:     &sync.RWMutex{},
		broadcast: make(chan *types.WsMessage),
	}
}

func (h *Handler) RegisterRoutes(router *chi.Mux) {
	router.HandleFunc("/ws", h.wsHandler)
	router.HandleFunc("/test", h.handleTest)
	go h.writeToClientBroadcast()
}

func (h *Handler) handleTest(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("Hello World"))
}

func (h *Handler) wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.log.Error("Error with websocket connection", sl.Err(err))
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	h.log.Info("client with address connected", conn.RemoteAddr().String())
	h.mutex.Lock()
	h.wsClients[conn] = struct{}{}
	h.mutex.Unlock()
	go h.readFromClient(conn)
}

func (h *Handler) readFromClient(conn *websocket.Conn) {
	for {
		msg := new(types.WsMessage)
		if err := conn.ReadJSON(msg); err != nil {
			var wsErr *websocket.CloseError
			ok := errors.As(err, &wsErr)
			if !ok || wsErr.Code != websocket.CloseGoingAway {
				h.log.Error("Error reading from websocket", sl.Err(err))
			}
			break
		}
		host, _, err := net.SplitHostPort(conn.RemoteAddr().String())
		if err != nil {
			h.log.Error("Error with address split", sl.Err(err))
		}

		msg.IPAddress = host
		msg.Time = time.Now().Format("15:04")
		h.broadcast <- msg
	}
	h.mutex.Lock()
	delete(h.wsClients, conn)
	h.mutex.Unlock()
}

func (h *Handler) writeToClientBroadcast() {
	for msg := range h.broadcast {
		h.mutex.RLock()
		for client := range h.wsClients {
			func() {
				if err := client.WriteJSON(msg); err != nil {
					h.log.Error("Error writing to client", sl.Err(err))
				}
			}()
		}
		h.mutex.RUnlock()
	}
}
