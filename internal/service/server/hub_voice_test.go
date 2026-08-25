package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"testing"
	"time"

	fasthttpws "github.com/fasthttp/websocket"
	"github.com/gofiber/contrib/websocket"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/service/sfu"
	"github.com/wlqoh/mini_discord.git/types"
)

// fakeStorage implements types.ServerStorage by embedding it as a nil
// interface and overriding only what the voice-lifecycle paths under test
// actually call. Any other method panics on a nil-interface call — a
// deliberate signal that a test started exercising code it didn't account
// for, rather than a silently wrong zero value.
type fakeStorage struct {
	types.ServerStorage

	channel       *types.Channel
	onlineUserIDs []int
	canAccess     bool
}

func (f *fakeStorage) GetChannelByID(_ context.Context, channelID int64) (*types.Channel, error) {
	if f.channel != nil {
		return f.channel, nil
	}
	return &types.Channel{ID: channelID, ServerID: 1, Type: types.ChannelTypeVoice}, nil
}

func (f *fakeStorage) ListServerMembersUserIDs(context.Context, int64) ([]int, error) {
	return f.onlineUserIDs, nil
}

func (f *fakeStorage) CanUserAccessChannel(context.Context, int, int64) (bool, error) {
	return f.canAccess, nil
}

func (f *fakeStorage) GetUserByID(_ context.Context, id int) (*types.User, error) {
	return &types.User{ID: id, FirstName: "Test", LastName: "User"}, nil
}

// newTestHub builds a Hub wired to a real *sfu.Router bound to an ephemeral
// UDP port (same pattern as TestRouterStartsAndJoins in the sfu package) —
// Detach/Leave/Resume all need a real Router to call into, but nothing here
// ever exchanges media, so no PublicIP reachability is required.
func newTestHub(t *testing.T, gracePeriod time.Duration) *Hub {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	storage := &fakeStorage{onlineUserIDs: []int{1, 2, 3, 4, 5}, canAccess: true}

	h := NewHub(storage, nil, log, "", nil, nil, nil, config.WebRTCConfig{
		SFU: config.SFUConfig{
			Enabled:             true,
			PublicIP:            "127.0.0.1",
			UDPPort:             0,
			MaxRoomParticipants: 20,
			SessionGracePeriod:  gracePeriod,
		},
	})
	if h.sfuRouter == nil {
		t.Fatal("expected sfu router to start")
	}
	t.Cleanup(func() {
		_ = h.SFURouter().Close()
	})
	return h
}

// newTestClient builds a Client with a Conn whose Close() is safe to call
// without ever having done a real handshake — fasthttp/websocket.Conn.Close
// on a zero-value receiver returns ErrNilNetConn instead of panicking (see
// its own nil checks), which is exactly what registerClient's eviction path
// calls on the client it's replacing.
func newTestClient(userID int) *Client {
	return &Client{
		UserID:   userID,
		Outbound: make(chan *types.WsEvent, 16),
		Conn:     &websocket.Conn{Conn: &fasthttpws.Conn{}},
	}
}

func (h *Hub) testRegister(cl *Client) {
	h.mu.Lock()
	h.clientsByUser[cl.UserID] = cl
	h.mu.Unlock()
}

func setVoiceState(h *Hub, userID int, channelID int64, sessionID string) {
	h.mu.Lock()
	if h.voiceParticipants[channelID] == nil {
		h.voiceParticipants[channelID] = make(map[int]struct{})
	}
	h.voiceParticipants[channelID][userID] = struct{}{}
	h.userVoiceChannel[userID] = channelID
	h.voiceStatusByUser[userID] = voiceStatus{micEnabled: true}
	if sessionID != "" {
		h.sfuSessionByUser[userID] = sessionID
	}
	h.mu.Unlock()
}

func expectEvent(t *testing.T, cl *Client, event string) {
	t.Helper()
	select {
	case ev := <-cl.Outbound:
		if ev.Event != event {
			t.Fatalf("expected event %q, got %q", event, ev.Event)
		}
	default:
		t.Fatalf("expected event %q, got nothing", event)
	}
}

func TestGracefulCloseLeavesImmediately(t *testing.T) {
	h := newTestHub(t, time.Hour)
	const userID, otherID = 1, 2
	const channelID int64 = 100
	setVoiceState(h, userID, channelID, "sess-1")
	other := newTestClient(otherID)
	h.testRegister(other)

	h.handleVoiceDisconnect(userID, true)

	h.mu.RLock()
	_, stillInVoice := h.userVoiceChannel[userID]
	_, hasTimer := h.sfuGraceTimers[userID]
	h.mu.RUnlock()
	if stillInVoice {
		t.Fatal("expected participant to be removed immediately on graceful close")
	}
	if hasTimer {
		t.Fatal("expected no grace timer on graceful close")
	}

	expectEvent(t, other, types.WsEventVoiceUserLeft)
}

func TestAbruptCloseStartsGrace(t *testing.T) {
	h := newTestHub(t, time.Hour)
	const userID, otherID = 1, 2
	const channelID int64 = 100
	setVoiceState(h, userID, channelID, "sess-1")
	setVoiceState(h, otherID, channelID, "")
	other := newTestClient(otherID)
	h.testRegister(other)

	h.handleVoiceDisconnect(userID, false)

	h.mu.RLock()
	_, stillInVoice := h.userVoiceChannel[userID]
	_, hasTimer := h.sfuGraceTimers[userID]
	h.mu.RUnlock()
	if !stillInVoice {
		t.Fatal("expected participant to remain during the grace period")
	}
	if !hasTimer {
		t.Fatal("expected a grace timer to be registered")
	}

	expectEvent(t, other, types.WsEventVoiceUserDetached)
}

func TestGraceExpiryRemovesParticipant(t *testing.T) {
	h := newTestHub(t, 10*time.Millisecond)
	const userID = 1
	const channelID int64 = 100
	setVoiceState(h, userID, channelID, "sess-1")

	h.handleVoiceDisconnect(userID, false)

	deadline := time.Now().Add(2 * time.Second)
	for {
		h.mu.RLock()
		_, stillInVoice := h.userVoiceChannel[userID]
		h.mu.RUnlock()
		if !stillInVoice {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("grace timer never expired")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestResumeCancelsGrace(t *testing.T) {
	h := newTestHub(t, time.Hour)
	const userID int = 1
	const channelID int64 = 100

	sessionID, err := h.sfuRouter.Join(userID, channelID)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	setVoiceState(h, userID, channelID, sessionID)

	h.handleVoiceDisconnect(userID, false)
	h.mu.RLock()
	_, hasTimer := h.sfuGraceTimers[userID]
	h.mu.RUnlock()
	if !hasTimer {
		t.Fatal("expected a grace timer after abrupt disconnect")
	}

	cl := newTestClient(userID)
	h.testRegister(cl)

	payload, err := json.Marshal(types.WsSfuResumeRequest{SessionID: sessionID})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	h.handleSfuResume(wsCommandRequest{
		client:  cl,
		command: types.WsCommand{Action: types.WsActionSfuResume, Payload: payload, RequestID: "req-1"},
	}, context.Background())

	h.mu.RLock()
	_, hasTimer = h.sfuGraceTimers[userID]
	_, stillInVoice := h.userVoiceChannel[userID]
	h.mu.RUnlock()
	if hasTimer {
		t.Fatal("expected sfu_resume to cancel the grace timer")
	}
	if !stillInVoice {
		t.Fatal("expected participant to remain in voice after resume")
	}

	expectEvent(t, cl, types.WsEventAck)
}

func TestOnSessionClosedIgnoresStaleSession(t *testing.T) {
	h := newTestHub(t, time.Hour)
	const userID = 1
	const channelID int64 = 100
	setVoiceState(h, userID, channelID, "current-session")

	h.OnSessionClosed(userID, "stale-session", channelID, sfu.CloseReasonPCFailed)

	h.mu.RLock()
	_, stillInVoice := h.userVoiceChannel[userID]
	h.mu.RUnlock()
	if !stillInVoice {
		t.Fatal("OnSessionClosed for a stale session must not tear down the current one")
	}
}

func TestOnSessionClosedTearsDownCurrentSession(t *testing.T) {
	h := newTestHub(t, time.Hour)
	const userID, otherID = 1, 2
	const channelID int64 = 100
	setVoiceState(h, userID, channelID, "current-session")
	other := newTestClient(otherID)
	h.testRegister(other)

	h.OnSessionClosed(userID, "current-session", channelID, sfu.CloseReasonPCFailed)

	h.mu.RLock()
	_, stillInVoice := h.userVoiceChannel[userID]
	_, hasTimer := h.sfuGraceTimers[userID]
	h.mu.RUnlock()
	if stillInVoice {
		t.Fatal("expected the session to be torn down immediately, no grace period")
	}
	if hasTimer {
		t.Fatal("expected no grace timer for a pc-failure teardown")
	}

	expectEvent(t, other, types.WsEventVoiceUserLeft)
}

func TestEvictionStartsGrace(t *testing.T) {
	h := newTestHub(t, time.Hour)
	const userID = 1
	const channelID int64 = 100
	setVoiceState(h, userID, channelID, "sess-1")

	old := newTestClient(userID)
	h.testRegister(old)

	replacement := newTestClient(userID)
	h.registerClient(replacement)

	deadline := time.Now().Add(2 * time.Second)
	for {
		h.mu.RLock()
		_, hasTimer := h.sfuGraceTimers[userID]
		h.mu.RUnlock()
		if hasTimer {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("expected eviction to start a grace timer for the evicted user's voice session")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestLeaveVoiceChannelInternalIsIdempotent(t *testing.T) {
	h := newTestHub(t, time.Hour)
	const userID = 1

	if channelID := h.leaveVoiceChannelInternal(userID); channelID != 0 {
		t.Fatalf("expected 0 for a user not in voice, got %d", channelID)
	}
	if channelID := h.leaveVoiceChannelInternal(userID); channelID != 0 {
		t.Fatalf("expected second call to also return 0, got %d", channelID)
	}
}
