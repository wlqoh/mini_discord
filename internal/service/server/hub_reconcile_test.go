package server

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/service/sfu"
)

// fakeVoiceRouter implements voiceRouter with in-memory, directly
// controllable LiveSessions state — the reconciliation sweep needs to
// exercise router ConnectionState/Age combinations (failed, closed, stale)
// that aren't practical to produce through a real WebRTC handshake.
type fakeVoiceRouter struct {
	mu   sync.Mutex
	live []sfu.LiveSession
	left []string
}

func (f *fakeVoiceRouter) Join(int, int64) (string, error)                  { return "", nil }
func (f *fakeVoiceRouter) HandleOffer(string, string, []sfu.SlotDecl) error { return nil }
func (f *fakeVoiceRouter) HandleAnswer(string, string) error                { return nil }
func (f *fakeVoiceRouter) HandleCandidate(string, sfu.CandidateInit) error  { return nil }
func (f *fakeVoiceRouter) SetPublishState(string, sfu.Source, bool) error   { return nil }
func (f *fakeVoiceRouter) Detach(string)                                    {}
func (f *fakeVoiceRouter) Resume(context.Context, string, int) error        { return nil }
func (f *fakeVoiceRouter) SubscribeVideo(string, int, sfu.Source, sfu.Quality) error {
	return nil
}

func (f *fakeVoiceRouter) LiveSessions() []sfu.LiveSession {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]sfu.LiveSession, len(f.live))
	copy(out, f.live)
	return out
}

func (f *fakeVoiceRouter) Leave(sessionID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.left = append(f.left, sessionID)
}

func (f *fakeVoiceRouter) leftSessions() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.left))
	copy(out, f.left)
	return out
}

// newReconcileTestHub builds a Hub with SFU "enabled" only in the sense
// that voice handlers treat it as available — sfuRouter is a fakeVoiceRouter
// under full test control, not a real *sfu.Router, so there's no UDP mux
// and no SFURouter()/admin-endpoint access (SFURouter's type assertion to
// *sfu.Router correctly yields nil for a fake, which is fine: nothing here
// exercises the admin endpoint).
func newReconcileTestHub(t *testing.T) (*Hub, *fakeVoiceRouter) {
	t.Helper()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	storage := &fakeStorage{onlineUserIDs: []int{1, 2, 3, 4, 5}, canAccess: true}

	h := NewHub(storage, nil, log, "", nil, nil, nil, config.WebRTCConfig{
		SFU: config.SFUConfig{Enabled: false},
	})
	fake := &fakeVoiceRouter{}
	h.sfuRouter = fake
	return h, fake
}

func TestReconcileRemovesHubGhost(t *testing.T) {
	h, fake := newReconcileTestHub(t)
	const userID = 1
	const channelID int64 = 100
	setVoiceState(h, userID, channelID, "sess-1")
	h.mu.Lock()
	h.voiceJoinedAt[userID] = time.Now().Add(-time.Hour)
	h.mu.Unlock()
	fake.live = nil // router has nothing for sess-1: a ghost

	h.reconcileTick(10 * time.Millisecond)

	h.mu.RLock()
	_, stillInVoice := h.userVoiceChannel[userID]
	h.mu.RUnlock()
	if stillInVoice {
		t.Fatal("expected the hub ghost to be removed")
	}
	if got := h.VoiceDiagnostics().CloseCounts["reconcile_hub"]; got != 1 {
		t.Fatalf("expected reconcile_hub=1, got %d", got)
	}
	if got := h.VoiceDiagnostics().LastReconcileRemoved; got != 1 {
		t.Fatalf("expected LastReconcileRemoved=1, got %d", got)
	}
}

func TestReconcileSkipsYoungEntries(t *testing.T) {
	h, fake := newReconcileTestHub(t)
	const userID = 1
	const channelID int64 = 100
	setVoiceState(h, userID, channelID, "sess-1")
	h.mu.Lock()
	h.voiceJoinedAt[userID] = time.Now() // fresh — could be mid-Join
	h.mu.Unlock()
	fake.live = nil

	h.reconcileTick(time.Hour)

	h.mu.RLock()
	_, stillInVoice := h.userVoiceChannel[userID]
	h.mu.RUnlock()
	if !stillInVoice {
		t.Fatal("expected a young entry to be left alone even though it looks like a ghost")
	}
	if got := h.VoiceDiagnostics().CloseCounts["reconcile_hub"]; got != 0 {
		t.Fatalf("expected reconcile_hub=0, got %d", got)
	}
}

func TestReconcileClosesOrphanRouterSession(t *testing.T) {
	h, fake := newReconcileTestHub(t)
	// No hub voice state at all for this session — the router thinks it's
	// live, but nothing in the hub owns it.
	fake.live = []sfu.LiveSession{
		{SessionID: "orphan-1", UserID: 9, ChannelID: 200, ConnectionState: "connected", Age: time.Hour},
	}

	h.reconcileTick(10 * time.Millisecond)

	left := fake.leftSessions()
	if len(left) != 1 || left[0] != "orphan-1" {
		t.Fatalf("expected router.Leave(\"orphan-1\"), got %v", left)
	}
	if got := h.VoiceDiagnostics().CloseCounts["reconcile_router"]; got != 1 {
		t.Fatalf("expected reconcile_router=1, got %d", got)
	}
}

func TestReconcileKeepsDetachedParticipant(t *testing.T) {
	h, fake := newReconcileTestHub(t)
	const userID = 1
	const channelID int64 = 100
	setVoiceState(h, userID, channelID, "sess-1")
	h.mu.Lock()
	h.voiceJoinedAt[userID] = time.Now().Add(-time.Hour)
	h.mu.Unlock()
	// Detach never removes the session from the router — media keeps
	// flowing — so the live session is still there, just signaling-less.
	fake.live = []sfu.LiveSession{
		{SessionID: "sess-1", UserID: userID, ChannelID: channelID, ConnectionState: "connected", Age: time.Hour},
	}

	h.reconcileTick(10 * time.Millisecond)

	h.mu.RLock()
	_, stillInVoice := h.userVoiceChannel[userID]
	h.mu.RUnlock()
	if !stillInVoice {
		t.Fatal("expected a detached-but-still-live participant to be left alone")
	}
	diag := h.VoiceDiagnostics()
	if diag.CloseCounts["reconcile_hub"] != 0 || diag.CloseCounts["reconcile_hub_dead_pc"] != 0 {
		t.Fatalf("expected no reconcile removals, got %+v", diag.CloseCounts)
	}
	if len(fake.leftSessions()) != 0 {
		t.Fatal("expected no router.Leave calls")
	}
}

func TestReconcileRemovesDeadPC(t *testing.T) {
	h, fake := newReconcileTestHub(t)
	const userID = 1
	const channelID int64 = 100
	setVoiceState(h, userID, channelID, "sess-1")
	h.mu.Lock()
	h.voiceJoinedAt[userID] = time.Now().Add(-time.Hour)
	h.mu.Unlock()
	fake.live = []sfu.LiveSession{
		{SessionID: "sess-1", UserID: userID, ChannelID: channelID, ConnectionState: "failed", Age: time.Hour},
	}

	h.reconcileTick(10 * time.Millisecond)

	h.mu.RLock()
	_, stillInVoice := h.userVoiceChannel[userID]
	h.mu.RUnlock()
	if stillInVoice {
		t.Fatal("expected a session with a dead pc to be removed")
	}
	if got := h.VoiceDiagnostics().CloseCounts["reconcile_hub_dead_pc"]; got != 1 {
		t.Fatalf("expected reconcile_hub_dead_pc=1, got %d", got)
	}
}
