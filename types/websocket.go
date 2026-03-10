package types

import "time"

type ServerStorage interface {
}

type WsMessage struct {
	Content  string `json:"content"`
	RoomID   string `json:"room_id"`
	Username string `json:"username"`
	SenderID string `json:"sender_id,omitempty"`
}

type Server struct {
	ID        int       `json:"id"`
	Name      string    `json:"name"`
	OwnerID   string    `json:"owner_id"`
	CreatedAt time.Time `json:"created_at"`
}
type CreateRoomRequest struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type RoomResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ClientResponse struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}
