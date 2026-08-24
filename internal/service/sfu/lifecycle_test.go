package sfu

import (
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// recordingObserver captures OnSessionClosed calls for assertions. Router
// always dispatches to the observer on a fresh goroutine (see
// Router.notifySessionClosed), so tests must wait rather than read
// immediately after triggering a state change.
type recordingObserver struct {
	mu    sync.Mutex
	calls []sessionClosedCall
}

type sessionClosedCall struct {
	userID    int
	sessionID string
	channelID int64
	reason    CloseReason
}

func (o *recordingObserver) OnSessionClosed(userID int, sessionID string, channelID int64, reason CloseReason) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.calls = append(o.calls, sessionClosedCall{userID: userID, sessionID: sessionID, channelID: channelID, reason: reason})
}

func (o *recordingObserver) waitForCall(t *testing.T) sessionClosedCall {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		o.mu.Lock()
		if len(o.calls) > 0 {
			call := o.calls[0]
			o.mu.Unlock()
			return call
		}
		o.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatal("observer was never notified")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (o *recordingObserver) callCount() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.calls)
}

func newTestRouter(t *testing.T) *Router {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	router, err := New(Config{
		PublicIP: "127.0.0.1",
		UDPPort:  0,
	}, stubSignaler{}, stubAuthorizer{}, log)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() {
		_ = router.Close()
	})
	return router
}

func TestPeerNotifiesObserverOnPCFailure(t *testing.T) {
	router := newTestRouter(t)
	obs := &recordingObserver{}
	router.SetSessionObserver(obs)

	sessionID, err := router.Join(7, 42)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	peer, ok := router.peerBySession(sessionID)
	if !ok {
		t.Fatal("session not found after Join")
	}

	peer.handleConnectionStateChange(webrtc.PeerConnectionStateFailed)

	call := obs.waitForCall(t)
	if call.userID != 7 || call.sessionID != sessionID || call.channelID != 42 {
		t.Fatalf("unexpected call: %+v", call)
	}
	if call.reason != CloseReasonPCFailed {
		t.Fatalf("expected reason %q, got %q", CloseReasonPCFailed, call.reason)
	}

	// failed -> closed both fire for the same death; only the first should
	// reach the observer.
	peer.handleConnectionStateChange(webrtc.PeerConnectionStateClosed)
	time.Sleep(20 * time.Millisecond)
	if got := obs.callCount(); got != 1 {
		t.Fatalf("expected exactly 1 notification, got %d", got)
	}
}

func TestNormalLeaveDoesNotNotifyObserver(t *testing.T) {
	router := newTestRouter(t)
	obs := &recordingObserver{}
	router.SetSessionObserver(obs)

	sessionID, err := router.Join(7, 42)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	peer, ok := router.peerBySession(sessionID)
	if !ok {
		t.Fatal("session not found after Join")
	}

	router.Leave(sessionID)

	// Leave's actual teardown (doClose) runs on the peer's own command
	// queue, asynchronously to Leave's return — wait for it, since it's what
	// sets stopped, the flag this test is exercising.
	deadline := time.Now().Add(2 * time.Second)
	for !peer.stopped.Load() {
		if time.Now().After(deadline) {
			t.Fatal("peer never finished closing")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// Simulate Pion firing the state-change callback after our own
	// pc.Close() — this must not be reported as a session the SFU had to
	// kill, since doClose already set stopped before this could observe it.
	peer.handleConnectionStateChange(webrtc.PeerConnectionStateClosed)
	time.Sleep(20 * time.Millisecond)

	if got := obs.callCount(); got != 0 {
		t.Fatalf("expected no notification for a normal Leave, got %d", got)
	}
}
