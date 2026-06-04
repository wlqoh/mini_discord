package server

import (
	"fmt"

	"github.com/gofiber/contrib/websocket"
	"github.com/wlqoh/mini_discord.git/types"
)

type Client struct {
	Conn     *websocket.Conn
	Outbound chan *types.WsEvent
	UserID   int `json:"user_id"`
}

func (c *Client) writeMessage() {
	defer func() {
		_ = c.Conn.Close()
	}()

	for {
		event, ok := <-c.Outbound
		if !ok {
			return
		}

		if err := c.safeWriteJSON(event); err != nil {
			return
		}
	}
}

func (c *Client) safeWriteJSON(event *types.WsEvent) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("websocket write panic: %v", r)
		}
	}()

	if err := c.Conn.WriteJSON(event); err != nil {
		return err
	}

	return nil
}

func (c *Client) readMessage(hub *Hub) {
	defer func() {
		hub.Unregister <- c
	}()

	for {
		var cmd types.WsCommand
		err := c.Conn.ReadJSON(&cmd)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				hub.log.Error("read error", "error", err)
			}
			break
		}

		if cmd.Action == "" {
			hub.pushError(c, "action is required")
			continue
		}

		hub.Commands <- wsCommandRequest{client: c, command: cmd}
	}
}
