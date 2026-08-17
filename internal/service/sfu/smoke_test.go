package sfu

import (
	"context"
	"io"
	"log/slog"
	"testing"
)

type stubSignaler struct{}

func (stubSignaler) SendOffer(int, string, string)            {}
func (stubSignaler) SendAnswer(int, string, string)           {}
func (stubSignaler) SendCandidate(int, string, CandidateInit) {}
func (stubSignaler) SendTrackPublished(int64, TrackInfo)      {}
func (stubSignaler) SendTrackUnpublished(int64, TrackInfo)    {}
func (stubSignaler) SendActiveSpeakers(int64, []int)          {}
func (stubSignaler) SendError(int, string, string, string)    {}

type stubAuthorizer struct{}

func (stubAuthorizer) CanUserAccessChannel(context.Context, int, int64) (bool, error) {
	return true, nil
}

// TestRouterStartsAndJoins is a smoke test, not a unit test suite: it
// verifies newAPI's UDP-mux bind + MediaEngine/interceptor registration
// actually succeed at runtime (go build only checks the code compiles
// against Pion's real API, not that constructing it works), and that a
// bare Join produces a usable session ID and PeerConnection.
func TestRouterStartsAndJoins(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	router, err := New(Config{
		PublicIP: "127.0.0.1",
		UDPPort:  0, // ephemeral port — avoids clashing with a real deployment's 7881
	}, stubSignaler{}, stubAuthorizer{}, log)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() {
		if err := router.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	}()

	sessionID, err := router.Join(1, 100)
	if err != nil {
		t.Fatalf("Join: %v", err)
	}
	if sessionID == "" {
		t.Fatal("Join returned empty session ID")
	}

	peer, ok := router.peerBySession(sessionID)
	if !ok {
		t.Fatal("session not found in router after Join")
	}
	if peer.userID != 1 || peer.channelID != 100 {
		t.Fatalf("unexpected peer identity: userID=%d channelID=%d", peer.userID, peer.channelID)
	}

	snapshot := router.Snapshot()
	if len(snapshot.Rooms) != 1 || len(snapshot.Rooms[0].Peers) != 1 {
		t.Fatalf("unexpected snapshot: %+v", snapshot)
	}

	router.Leave(sessionID)
	if _, ok := router.peerBySession(sessionID); ok {
		t.Fatal("session still present after Leave")
	}
}
