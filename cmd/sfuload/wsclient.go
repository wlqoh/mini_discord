package main

import (
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// wsEnvelope mirrors the wire shape of types.WsEvent / types.WsCommand
// closely enough for this tool's purposes without importing the server's
// internal Client/Hub machinery — sfuload only needs to speak the protocol,
// not run it.
type wsEnvelope struct {
	Action    string          `json:"action,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Event     string          `json:"event,omitempty"`
	RequestID string          `json:"request_id,omitempty"`
	Error     string          `json:"error,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

type pendingCommand struct {
	resultCh chan wsEnvelope
}

// wsClient is a minimal client for the chat/voice WebSocket protocol
// (sfu-migration-plan.md §5) — just enough to drive join_voice_channel and
// the sfu_* actions the way a real browser client does, without any of the
// UI/state concerns useVoice.ts and chatSocket.ts carry.
type wsClient struct {
	conn *websocket.Conn

	// writeMu serializes writes to conn: gorilla/websocket does not allow
	// concurrent writers, but sendCommand (bot's main flow) and
	// sendFireAndForget (called from Pion's OnICECandidate callback, its
	// own goroutine) both write to the same connection.
	writeMu sync.Mutex

	mu      sync.Mutex
	pending map[string]*pendingCommand

	nextRequestID atomic.Int64

	onEvent func(event string, data json.RawMessage)

	closeOnce sync.Once
	done      chan struct{}
}

func dialWSClient(url string, onEvent func(event string, data json.RawMessage)) (*wsClient, error) {
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		return nil, fmt.Errorf("dial: %w", err)
	}

	c := &wsClient{
		conn:    conn,
		pending: make(map[string]*pendingCommand),
		onEvent: onEvent,
		done:    make(chan struct{}),
	}
	go c.readLoop()
	return c, nil
}

func (c *wsClient) readLoop() {
	defer close(c.done)
	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			return
		}

		var env wsEnvelope
		if err := json.Unmarshal(raw, &env); err != nil {
			continue
		}

		if env.Event == "ack" || env.Event == "error" {
			c.mu.Lock()
			pc, ok := c.pending[env.RequestID]
			if ok {
				delete(c.pending, env.RequestID)
			}
			c.mu.Unlock()
			if ok {
				pc.resultCh <- env
				continue
			}
			// No matching pending command (fire-and-forget or a stale
			// request_id) — fall through to onEvent so callers can still
			// observe bare errors if they care to.
		}

		if c.onEvent != nil {
			c.onEvent(env.Event, env.Data)
		}
	}
}

// sendCommand sends a request/ack-style action and blocks for the matching
// response (matched by request_id, same as chatSocket.ts's sendCommand) or
// until timeout.
func (c *wsClient) sendCommand(action string, payload any, timeout time.Duration) (json.RawMessage, error) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal payload: %w", err)
	}

	requestID := fmt.Sprintf("r%d", c.nextRequestID.Add(1))
	pc := &pendingCommand{resultCh: make(chan wsEnvelope, 1)}

	c.mu.Lock()
	c.pending[requestID] = pc
	c.mu.Unlock()

	env := wsEnvelope{Action: action, Payload: payloadBytes, RequestID: requestID}
	raw, err := json.Marshal(env)
	if err != nil {
		return nil, fmt.Errorf("marshal envelope: %w", err)
	}

	c.writeMu.Lock()
	err = c.conn.WriteMessage(websocket.TextMessage, raw)
	c.writeMu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("write: %w", err)
	}

	select {
	case result := <-pc.resultCh:
		if result.Event == "error" {
			return nil, fmt.Errorf("%s: %s", action, result.Error)
		}
		return result.Data, nil
	case <-time.After(timeout):
		c.mu.Lock()
		delete(c.pending, requestID)
		c.mu.Unlock()
		return nil, fmt.Errorf("%s: timed out after %s", action, timeout)
	case <-c.done:
		return nil, fmt.Errorf("%s: connection closed", action)
	}
}

// sendFireAndForget mirrors sendSfuCandidate/sendRTCSignal on the frontend:
// no ack expected, bypasses the pending-command tracking entirely.
func (c *wsClient) sendFireAndForget(action string, payload any) error {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}
	raw, err := json.Marshal(wsEnvelope{Action: action, Payload: payloadBytes})
	if err != nil {
		return fmt.Errorf("marshal envelope: %w", err)
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.WriteMessage(websocket.TextMessage, raw)
}

// Close sends a normal-closure WebSocket close frame and closes the
// underlying connection. Safe to call more than once; only the first call
// has any effect.
func (c *wsClient) Close() {
	c.closeOnce.Do(func() {
		c.writeMu.Lock()
		_ = c.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
		c.writeMu.Unlock()
		_ = c.conn.Close()
	})
}
