package ws

import (
	"log"

	"github.com/gofiber/contrib/websocket"
	"github.com/wlqoh/mini_discord.git/types"
)

type Client struct {
	Conn     *websocket.Conn
	Message  chan *types.WsMessage
	ID       string `json:"id"`
	RoomID   string `json:"room_id"`
	Username string `json:"username"`
}

func (c *Client) writeMessage() {
	defer func() {
		c.Conn.Close()
	}()

	for {
		message, ok := <-c.Message
		if !ok {
			return
		}

		c.Conn.WriteJSON(message)
	}
}

func (c *Client) readMessage(hub *Hub) {
	defer func() {
		hub.Unregister <- c
		c.Conn.Close()
	}()

	for {
		_, m, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("error: %v", err)
			}
			break
		}

		msg := &types.WsMessage{
			Content:  string(m),
			RoomID:   c.RoomID,
			Username: c.Username,
			SenderID: c.ID,
		}

		hub.Broadcast <- msg
	}
}
