package sfu

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pion/webrtc/v4"
)

// Config mirrors config.SFUConfig; kept as a separate type so this package
// doesn't depend on internal/config (see the package doc in sfu.go).
type Config struct {
	PublicIP            string
	UDPPort             int
	StunURLs            []string
	MaxRoomParticipants int
	SessionGracePeriod  time.Duration
}

// PublishSlots is the fixed, ordered list of transceivers every client
// creates on join (sfu-migration-plan.md §4.3, decision #3 — one PC per
// client, no glare because slots are pre-declared and only the server
// re-offers after the initial exchange). Exposed as a var, not a const
// block, so a fifth source can be appended without becoming a breaking wire
// change — see the plan's note on this in §4.3.
var PublishSlots = []SlotDecl{
	{MID: "0", Kind: "audio", Source: SourceMic},
	{MID: "1", Kind: "video", Source: SourceCamera},
	{MID: "2", Kind: "video", Source: SourceScreen},
	{MID: "3", Kind: "audio", Source: SourceScreenAudio},
}

// Router owns all rooms and peers for the SFU transport.
type Router struct {
	cfg  Config
	sig  Signaler
	auth Authorizer
	log  *slog.Logger

	api      *webrtc.API
	closeUDP func() error

	mu    sync.RWMutex
	rooms map[int64]*Room  // channelID -> Room
	peers map[string]*Peer // sessionID -> Peer
}

func New(cfg Config, sig Signaler, auth Authorizer, log *slog.Logger) (*Router, error) {
	api, closeUDP, err := newAPI(cfg)
	if err != nil {
		return nil, fmt.Errorf("sfu: build webrtc API: %w", err)
	}

	return &Router{
		cfg:      cfg,
		sig:      sig,
		auth:     auth,
		log:      log,
		api:      api,
		closeUDP: closeUDP,
		rooms:    make(map[int64]*Room),
		peers:    make(map[string]*Peer),
	}, nil
}

func (r *Router) Close() error {
	r.mu.Lock()
	peers := make([]*Peer, 0, len(r.peers))
	for _, p := range r.peers {
		peers = append(peers, p)
	}
	r.mu.Unlock()

	for _, p := range peers {
		p.close()
	}
	return r.closeUDP()
}

// Join creates a fresh PeerConnection for a user entering a voice channel.
// It does no signaling itself — the caller (hub.go's join_voice_channel
// handler) uses the returned session ID and the router's ICE server list to
// build the join ack; the client then drives the connection via HandleOffer.
func (r *Router) Join(userID int, channelID int64) (sessionID string, err error) {
	pc, err := r.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return "", fmt.Errorf("sfu: create peer connection: %w", err)
	}

	sessionID = uuid.NewString()
	log := r.log.With("session_id", sessionID, "user_id", userID, "channel_id", channelID)

	r.mu.Lock()
	room, ok := r.rooms[channelID]
	if !ok {
		room = newRoom(channelID, r.sig)
		r.rooms[channelID] = room
	}
	peer := newPeer(sessionID, userID, channelID, pc, r, room, log)
	r.peers[sessionID] = peer
	r.mu.Unlock()

	room.add(peer)

	return sessionID, nil
}

func (r *Router) peerBySession(sessionID string) (*Peer, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.peers[sessionID]
	return p, ok
}

func (r *Router) roomFor(channelID int64) (*Room, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	room, ok := r.rooms[channelID]
	return room, ok
}

func (r *Router) HandleOffer(sessionID, sdp string, slots []SlotDecl) error {
	peer, ok := r.peerBySession(sessionID)
	if !ok {
		return fmt.Errorf("sfu: unknown session %s", sessionID)
	}
	peer.enqueue(func() { peer.handleOffer(sdp, slots) })
	return nil
}

func (r *Router) HandleAnswer(sessionID, sdp string) error {
	peer, ok := r.peerBySession(sessionID)
	if !ok {
		return fmt.Errorf("sfu: unknown session %s", sessionID)
	}
	peer.enqueue(func() { peer.handleAnswer(sdp) })
	return nil
}

func (r *Router) HandleCandidate(sessionID string, c CandidateInit) error {
	peer, ok := r.peerBySession(sessionID)
	if !ok {
		return fmt.Errorf("sfu: unknown session %s", sessionID)
	}
	peer.enqueue(func() { peer.handleCandidate(c) })
	return nil
}

// SubscribeVideo implements sfu_subscribe_video (decision #8, migration
// phase 2): quality "off" tears an existing subscription down; anything
// else subscribes sessionID to targetUserID's video source, triggering a
// PLI so the new subscriber isn't stuck waiting for the publisher's next
// scheduled key frame (see publishedTrack.requestKeyframeWithRetry).
func (r *Router) SubscribeVideo(sessionID string, targetUserID int, source Source, quality Quality) error {
	peer, ok := r.peerBySession(sessionID)
	if !ok {
		return fmt.Errorf("sfu: unknown session %s", sessionID)
	}

	if quality == QualityOff {
		peer.enqueue(func() { peer.doUnsubscribe(targetUserID, source) })
		return nil
	}

	room, ok := r.roomFor(peer.channelID)
	if !ok {
		return fmt.Errorf("sfu: room not found for channel %d", peer.channelID)
	}
	publisher, ok := room.peerByUserID(targetUserID)
	if !ok {
		return fmt.Errorf("sfu: target user %d not in room", targetUserID)
	}
	if publisher == peer {
		return fmt.Errorf("sfu: cannot subscribe to your own track")
	}

	peer.enqueue(func() {
		pub, ok := publisher.publishedTrack(source)
		if !ok {
			peer.fail("subscribe_failed", fmt.Errorf("user %d has no published %s track", targetUserID, source))
			return
		}
		if pub.kind != webrtc.RTPCodecTypeVideo {
			peer.fail("subscribe_failed", fmt.Errorf("%s is not a video source", source))
			return
		}
		peer.doSubscribe(targetUserID, pub, quality)
	})
	return nil
}

// Leave tears a session down immediately — used for an explicit
// leave_voice_channel. A dropped WebSocket goes through Detach instead
// (migration phase 3, sfu-migration-plan.md §7) so a brief signaling blip
// doesn't kill the call.
func (r *Router) Leave(sessionID string) {
	r.mu.Lock()
	peer, ok := r.peers[sessionID]
	if !ok {
		r.mu.Unlock()
		return
	}
	delete(r.peers, sessionID)
	room := r.rooms[peer.channelID]
	r.mu.Unlock()

	if room != nil {
		room.remove(peer.userID)
		room.speakers.removeUser(peer.userID)
		if room.isEmpty() {
			r.mu.Lock()
			// Re-check under lock: someone may have joined the same channel
			// between the unlock above and here.
			if room.isEmpty() {
				delete(r.rooms, peer.channelID)
				room.close()
			}
			r.mu.Unlock()
		}
	}

	peer.close()
}

// Detach marks a session as having lost its signaling connection without
// tearing anything down (migration phase 3, decision #10): the client's
// WebSocket dropped, but ICE/DTLS don't depend on it, so media keeps
// flowing exactly as before. The hub owns the actual grace-period timer and
// decides when a Detach without a matching Resume becomes a real Leave —
// this only flips the flag Peer checks before trying to deliver anything
// (see sendOffer's guard).
func (r *Router) Detach(sessionID string) {
	peer, ok := r.peerBySession(sessionID)
	if !ok {
		return
	}
	peer.enqueue(func() { peer.markDetached() })
}

// Resume clears a session's detached flag once the client's WebSocket comes
// back, after re-checking that the user can still access the channel — they
// may have been removed from the server during the gap. Returns an error
// without touching the session on any failure; the caller (hub.go's
// handleSfuResume) is responsible for tearing the session down immediately
// on error instead of waiting out the rest of the grace period.
func (r *Router) Resume(ctx context.Context, sessionID string, userID int) error {
	peer, ok := r.peerBySession(sessionID)
	if !ok {
		return fmt.Errorf("sfu: unknown session %s", sessionID)
	}
	if peer.userID != userID {
		return fmt.Errorf("sfu: session does not belong to user %d", userID)
	}

	canAccess, err := r.auth.CanUserAccessChannel(ctx, userID, peer.channelID)
	if err != nil {
		return fmt.Errorf("sfu: check channel access: %w", err)
	}
	if !canAccess {
		return fmt.Errorf("sfu: access denied")
	}

	peer.enqueue(func() { peer.clearDetached() })
	return nil
}
