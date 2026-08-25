package server

import (
	"fmt"
	"sync/atomic"
	"time"

	"github.com/gofiber/contrib/websocket"
	"github.com/wlqoh/mini_discord.git/internal/lib/logger/sl"
	"github.com/wlqoh/mini_discord.git/types"
)

const (
	writeWait = 10 * time.Second
	pongWait  = 60 * time.Second
	// pingPeriod must be comfortably below pongWait and below any proxy's
	// idle-read timeout (nginx defaults to 60s) — otherwise an idle voice
	// call gets silently dropped by the proxy before either side notices.
	pingPeriod = 25 * time.Second
)

// Client is one user's WebSocket connection. There is at most one Client
// per user in Hub.clientsByUser; a second connection for the same user
// evicts the first. Outbound is drained by a dedicated writer goroutine
// (writeMessage, started by Handler alongside readMessage) that also sends
// a ping every pingPeriod, so callers must never write to c.Conn directly —
// send events through Outbound instead.
type Client struct {
	Conn     *websocket.Conn
	Outbound chan *types.WsEvent
	UserID   int `json:"user_id"`

	// gracefulClose is set by readMessage when the connection closed with a
	// normal-closure/going-away code (tab closed, navigation, F5): the
	// RTCPeerConnection died with the document in that case, so a voice
	// grace period would just guarantee a ghost for its full duration with
	// nothing to resume (ghost-participants-plan.md §3 decision #5).
	gracefulClose atomic.Bool
}

func (c *Client) writeMessage() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.Conn.Close()
	}()

	for {
		select {
		case event, ok := <-c.Outbound:
			if !ok {
				_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
				_ = c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.safeWriteJSON(event); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) safeWriteJSON(event *types.WsEvent) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("websocket write panic: %v", r)
		}
	}()

	if err := c.Conn.SetWriteDeadline(time.Now().Add(writeWait)); err != nil {
		return err
	}

	if err := c.Conn.WriteJSON(event); err != nil {
		return err
	}

	return nil
}

func (c *Client) readMessage(hub *Hub) {
	defer func() {
		hub.Unregister <- c
	}()

	_ = c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		return c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		var cmd types.WsCommand
		err := c.Conn.ReadJSON(&cmd)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				hub.log.Error("read error", sl.Err(err))
			}
			if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				c.gracefulClose.Store(true)
			}
			break
		}
		_ = c.Conn.SetReadDeadline(time.Now().Add(pongWait))

		if cmd.Action == "" {
			hub.pushError(c, "action is required")
			continue
		}

		hub.Commands <- wsCommandRequest{client: c, command: cmd}
	}
}
