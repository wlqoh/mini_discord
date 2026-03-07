package types

type WsMessage struct {
	Content  string `json:"content"`
	RoomID   string `json:"room_id"`
	Username string `json:"username"`
	SenderID string `json:"sender_id,omitempty"`
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
