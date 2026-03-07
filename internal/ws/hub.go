package ws

import (
	"sync"

	"github.com/wlqoh/mini_discord.git/types"
)

type Room struct {
	ID      string             `json:"id"`
	Name    string             `json:"name"`
	Clients map[string]*Client `json:"clients"`
}
type Hub struct {
	Rooms map[string]*Room
	mu    sync.RWMutex

	Register   chan *Client
	Unregister chan *Client
	Broadcast  chan *types.WsMessage
}

func NewHub() *Hub {
	return &Hub{
		Rooms:      make(map[string]*Room),
		Register:   make(chan *Client),
		Unregister: make(chan *Client),
		Broadcast:  make(chan *types.WsMessage, 5),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case cl := <-h.Register:
			h.mu.Lock()
			if _, ok := h.Rooms[cl.RoomID]; ok {
				r := h.Rooms[cl.RoomID]

				if _, ok := r.Clients[cl.ID]; !ok {
					r.Clients[cl.ID] = cl
				}
			}
			h.mu.Unlock()
		case cl := <-h.Unregister:
			h.mu.Lock()
			if _, ok := h.Rooms[cl.RoomID]; ok {
				if _, ok := h.Rooms[cl.RoomID].Clients[cl.ID]; ok {
					if len(h.Rooms[cl.RoomID].Clients) != 0 {
						h.Broadcast <- &types.WsMessage{
							Content:  "A user has left the chat",
							RoomID:   cl.RoomID,
							Username: cl.Username,
						}
					}

					delete(h.Rooms[cl.RoomID].Clients, cl.ID)
					close(cl.Message)
				}
			}
			h.mu.Unlock()
		case m := <-h.Broadcast:
			h.mu.Lock()
			if _, ok := h.Rooms[m.RoomID]; ok {
				for _, cl := range h.Rooms[m.RoomID].Clients {
					if cl.ID != m.SenderID {
						cl.Message <- m
					}
				}
			}
			h.mu.Unlock()
		}
	}
}
