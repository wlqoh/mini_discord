package sfu

import (
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/pion/webrtc/v4"
)

// Peer is one client's connection to the SFU: a single PeerConnection with
// up to four fixed publish slots (sfu-migration-plan.md §4.3, decision #3)
// plus whatever the router has subscribed it to receive.
//
// Concurrency invariant: slotBySource, subs, negotiating and
// renegotiatePending are only ever read or written from inside run() —
// Pion's own callbacks (OnTrack, OnICECandidate, ...) and other peers'
// auto-subscribe logic never touch them directly; they enqueue a closure via
// enqueue() instead. This is what makes cross-peer calls like
// subscribeToTrack safe without a peer-level mutex: only one goroutine
// (run's) ever mutates a given peer's negotiation state.
//
// published is the one exception: migration phase 1's auto-subscribe-audio
// needs to read one peer's published tracks from another peer's goroutine
// (see autoSubscribeToExisting), and routing that through enqueue would mean
// blocking one peer's run() loop on another's — a cross-goroutine call
// pattern one bad ordering away from a deadlock. It gets its own narrow
// mutex (publishedMu) instead.
type Peer struct {
	sessionID string
	userID    int
	channelID int64

	router *Router
	room   *Room
	pc     *webrtc.PeerConnection
	log    *slog.Logger

	// mutated only from run() — see the invariant above.
	slotBySource map[Source]string // Source -> MID, from the client's initial offer
	subs         map[subKey]*subscription

	publishedMu sync.RWMutex
	published   map[Source]*publishedTrack

	negotiating        atomic.Bool
	renegotiatePending atomic.Bool

	// detached is set by Router.Detach when the client's WebSocket drops
	// (migration phase 3, decision #10) — the PeerConnection is left alone
	// (media keeps flowing; only signaling depends on the WebSocket) but
	// nothing is sent to a peer that has nowhere to receive it. Router.Resume
	// clears it once the client reconnects.
	detached atomic.Bool

	commands  chan func()
	stopped   atomic.Bool
	closeOnce sync.Once
}

type subKey struct {
	publisherUserID int
	source          Source
}

type subscription struct {
	pub    *publishedTrack
	local  *webrtc.TrackLocalStaticRTP
	sender *webrtc.RTPSender
}

func newPeer(sessionID string, userID int, channelID int64, pc *webrtc.PeerConnection, router *Router, room *Room, log *slog.Logger) *Peer {
	p := &Peer{
		sessionID:    sessionID,
		userID:       userID,
		channelID:    channelID,
		router:       router,
		room:         room,
		pc:           pc,
		log:          log,
		slotBySource: make(map[Source]string),
		subs:         make(map[subKey]*subscription),
		published:    make(map[Source]*publishedTrack),
		commands:     make(chan func(), 32),
	}
	go p.run()
	p.wire()
	return p
}

// run is the single goroutine allowed to touch this peer's negotiation state
// (see the type doc). It exits once a command sets stopped (only doClose
// does). p.commands is deliberately never closed — enqueue() after stopped
// just drops the command instead, avoiding a send-on-closed-channel race
// with whatever last called enqueue concurrently with close().
func (p *Peer) run() {
	for fn := range p.commands {
		p.safeRun(fn)
		if p.stopped.Load() {
			return
		}
	}
}

// safeRun's recover() is load-bearing (sfu-migration-plan.md §8 pitfall #5):
// this runs SDP/ICE handling reachable directly from client input, and the
// SFU shares a process with chat (decision #2) — an unrecovered panic here
// would take the whole server down over one bad peer.
func (p *Peer) safeRun(fn func()) {
	defer func() {
		if r := recover(); r != nil {
			p.log.Error("sfu: panic in peer command", "panic", r)
		}
	}()
	fn()
}

func (p *Peer) enqueue(fn func()) {
	if p.stopped.Load() {
		return
	}
	select {
	case p.commands <- fn:
	default:
		p.log.Warn("sfu: peer command queue full, dropping command")
	}
}

func (p *Peer) wire() {
	p.pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		p.router.sig.SendCandidate(p.userID, p.sessionID, CandidateInit{
			Candidate:     init.Candidate,
			SDPMid:        init.SDPMid,
			SDPMLineIndex: init.SDPMLineIndex,
		})
	})

	p.pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		p.log.Debug("sfu: ice state", "state", state.String())
		// failed/disconnected handling (grace period, resume) lands in
		// migration phase 3 (sfu-migration-plan.md §7); Phase 1 only logs.
	})

	p.pc.OnTrack(func(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		p.enqueue(func() { p.handleOnTrack(remote, receiver) })
	})
}

// handleOffer processes the client's one and only client-initiated offer
// (decision #3): the four fixed publish slots declared in slots. Every
// negotiation after this one is server-initiated (see scheduleNegotiate).
func (p *Peer) handleOffer(sdp string, slots []SlotDecl) {
	p.slotBySource = make(map[Source]string, len(slots))
	for _, s := range slots {
		p.slotBySource[s.Source] = s.MID
	}

	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		p.fail("offer_failed", fmt.Errorf("set remote description: %w", err))
		return
	}

	answer, err := p.pc.CreateAnswer(nil)
	if err != nil {
		p.fail("offer_failed", fmt.Errorf("create answer: %w", err))
		return
	}
	if err := p.pc.SetLocalDescription(answer); err != nil {
		p.fail("offer_failed", fmt.Errorf("set local description: %w", err))
		return
	}
	p.router.sig.SendAnswer(p.userID, p.sessionID, answer.SDP)

	p.autoSubscribeToExisting()
}

// autoSubscribeToExisting wires this newly joined peer up to receive every
// audio track already published by someone else in the room (decision #8 —
// audio is auto-subscribed; video needs an explicit sfu_subscribe_video,
// added in migration phase 2). Always followed by a server-initiated offer
// (via doSubscribe -> scheduleNegotiate): a client's answer to its own offer
// can't introduce new m-lines per SDP offer/answer rules, so subscribing to
// anything pre-existing necessarily needs a follow-up renegotiation anyway.
func (p *Peer) autoSubscribeToExisting() {
	for _, other := range p.room.others(p.userID) {
		for _, pub := range other.publishedAudioTracks() {
			p.doSubscribe(other.userID, pub)
		}
	}
}

// publishedAudioTracks is read from another peer's run() goroutine (via
// autoSubscribeToExisting above) — see the type doc on why this field has
// its own mutex instead of going through enqueue.
func (p *Peer) publishedAudioTracks() []*publishedTrack {
	p.publishedMu.RLock()
	defer p.publishedMu.RUnlock()
	var result []*publishedTrack
	for _, pub := range p.published {
		if pub.kind == webrtc.RTPCodecTypeAudio {
			result = append(result, pub)
		}
	}
	return result
}

func (p *Peer) handleAnswer(sdp string) {
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}); err != nil {
		p.negotiating.Store(false)
		p.fail("answer_failed", fmt.Errorf("set remote description: %w", err))
		return
	}
	p.negotiating.Store(false)
	if p.renegotiatePending.CompareAndSwap(true, false) {
		p.negotiating.Store(true)
		p.sendOffer()
	}
}

func (p *Peer) handleCandidate(c CandidateInit) {
	if err := p.pc.AddICECandidate(webrtc.ICECandidateInit{
		Candidate:     c.Candidate,
		SDPMid:        c.SDPMid,
		SDPMLineIndex: c.SDPMLineIndex,
	}); err != nil {
		// Non-fatal: candidates that lose the ICE-restart-generation race are
		// expected to fail occasionally. Log only, mirroring the frontend's
		// treatment of the equivalent case (see meshCallClient.ts's
		// ignoreOffer handling for the mesh path).
		p.log.Debug("sfu: add ice candidate failed", "err", err)
	}
}

// scheduleNegotiate coalesces bursts of AddTrack/RemoveTrack calls (e.g.
// auto-subscribing a new peer to several existing publishers at once) into
// a single offer, and defers to right after the in-flight negotiation's
// answer arrives if one is already running (sfu-migration-plan.md §8
// pitfall #7). The server is the only offerer after the client's initial
// offer (decision #3), so this is the one and only place that creates one.
func (p *Peer) scheduleNegotiate() {
	if !p.negotiating.CompareAndSwap(false, true) {
		p.renegotiatePending.Store(true)
		return
	}
	p.sendOffer()
}

// markDetached is called via Router.Detach when the client's WebSocket
// drops. A negotiation in flight at that moment will never get its answer —
// unstuck it now so a resumed session renegotiates again instead of
// scheduleNegotiate silently no-oping forever (negotiating would otherwise
// stay true with nothing left to ever clear it).
func (p *Peer) markDetached() {
	p.detached.Store(true)
	if p.negotiating.Load() {
		p.negotiating.Store(false)
		p.renegotiatePending.Store(true)
	}
}

// clearDetached is called via Router.Resume once the client reconnects. If
// anything tried to renegotiate while detached (see sendOffer's guard
// below), that request was deferred by setting renegotiatePending instead
// of being lost — fire it now.
func (p *Peer) clearDetached() {
	p.detached.Store(false)
	if p.renegotiatePending.CompareAndSwap(true, false) {
		p.negotiating.Store(true)
		p.sendOffer()
	}
}

func (p *Peer) isDetached() bool {
	return p.detached.Load()
}

func (p *Peer) sendOffer() {
	if p.isDetached() {
		// Nothing to deliver an offer to right now — defer it. Resume()
		// retries via clearDetached once the WebSocket is back.
		p.negotiating.Store(false)
		p.renegotiatePending.Store(true)
		return
	}

	offer, err := p.pc.CreateOffer(nil)
	if err != nil {
		p.negotiating.Store(false)
		p.fail("negotiate_failed", fmt.Errorf("create offer: %w", err))
		return
	}
	if err := p.pc.SetLocalDescription(offer); err != nil {
		p.negotiating.Store(false)
		p.fail("negotiate_failed", fmt.Errorf("set local description: %w", err))
		return
	}
	p.router.sig.SendOffer(p.userID, p.sessionID, offer.SDP)
}

func (p *Peer) handleOnTrack(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	mid := receiver.RTPTransceiver().Mid()
	source, ok := p.sourceForMID(mid)
	if !ok {
		p.log.Warn("sfu: track on unrecognized mid", "mid", mid)
		return
	}

	var audioLevelExtID uint8
	if remote.Kind() == webrtc.RTPCodecTypeAudio {
		audioLevelExtID = audioLevelExtensionID(receiver)
	}

	pub := newPublishedTrack(p.userID, source, remote, p, audioLevelExtID)
	p.publishedMu.Lock()
	p.published[source] = pub
	p.publishedMu.Unlock()

	go pub.forward(p.log)

	// Every published track is announced so clients know it's there to
	// subscribe to. Audio auto-subscribes everyone in the room right away
	// (decision #8); video waits for an explicit sfu_subscribe_video
	// (migration phase 2) — draining the track via forward() above keeps
	// Pion's internal buffers healthy in the meantime regardless.
	p.router.sig.SendTrackPublished(p.channelID, TrackInfo{UserID: p.userID, Source: source, Kind: kindString(pub.kind)})

	if pub.kind != webrtc.RTPCodecTypeAudio {
		return
	}

	for _, other := range p.room.others(p.userID) {
		other.subscribeToTrack(p.userID, pub)
	}
}

func (p *Peer) sourceForMID(mid string) (Source, bool) {
	for source, m := range p.slotBySource {
		if m == mid {
			return source, true
		}
	}
	return "", false
}

// subscribeToTrack is how OTHER peers ask this peer to receive a track —
// always routed through enqueue so the actual work (doSubscribe) runs on
// this peer's own command goroutine: the caller is running on the
// publisher's goroutine, and doSubscribe mutates state only this peer's
// run() is allowed to touch (see the type doc's concurrency invariant).
func (p *Peer) subscribeToTrack(publisherUserID int, pub *publishedTrack) {
	p.enqueue(func() { p.doSubscribe(publisherUserID, pub) })
}

func (p *Peer) doSubscribe(publisherUserID int, pub *publishedTrack) {
	key := subKey{publisherUserID: publisherUserID, source: pub.source}
	if _, exists := p.subs[key]; exists {
		return
	}

	local, err := webrtc.NewTrackLocalStaticRTP(
		pub.remote.Codec().RTPCodecCapability,
		fmt.Sprintf("u%d-%s-%s", publisherUserID, pub.source, kindString(pub.kind)),
		fmt.Sprintf("u%d-%s", publisherUserID, pub.source),
	)
	if err != nil {
		p.log.Error("sfu: create local track failed", "err", err)
		return
	}

	sender, err := p.pc.AddTrack(local)
	if err != nil {
		p.log.Error("sfu: add track failed", "err", err)
		return
	}

	pub.addSubscriber(p.userID, local)
	p.subs[key] = &subscription{pub: pub, local: local, sender: sender}
	p.scheduleNegotiate()

	// A new video subscriber decodes nothing until the next key frame — ask
	// the publisher for one right away instead of waiting out its normal
	// interval (sfu-migration-plan.md §8 pitfall #3). No-op for audio.
	pub.requestKeyframeWithRetry()
}

// doUnsubscribe removes this peer's subscription to one publisher's track
// (sfu_subscribe_video with quality "off" — migration phase 2). Symmetric
// with doSubscribe: same command-queue-only invariant, same renegotiation.
func (p *Peer) doUnsubscribe(publisherUserID int, source Source) {
	key := subKey{publisherUserID: publisherUserID, source: source}
	sub, exists := p.subs[key]
	if !exists {
		return
	}
	delete(p.subs, key)
	sub.pub.removeSubscriber(p.userID)

	if err := p.pc.RemoveTrack(sub.sender); err != nil {
		p.log.Warn("sfu: remove track failed", "err", err)
	}
	p.scheduleNegotiate()
}

// publishedTrack is read from another peer's run() goroutine (via
// Router.SubscribeVideo) — see the type doc on why the published field has
// its own mutex instead of going through enqueue.
func (p *Peer) publishedTrack(source Source) (*publishedTrack, bool) {
	p.publishedMu.RLock()
	defer p.publishedMu.RUnlock()
	pub, ok := p.published[source]
	return pub, ok
}

func (p *Peer) fail(code string, err error) {
	p.log.Error("sfu: "+code, "err", err)
	p.router.sig.SendError(p.userID, p.sessionID, code, err.Error())
}

// close tears the peer down. Safe to call from any goroutine (Router.Leave
// and Router.Close both call it directly, not from inside a peer's own
// run()) — the actual teardown runs as an enqueued command so it's
// serialized against everything else touching this peer's state, same as
// every other mutation.
func (p *Peer) close() {
	p.closeOnce.Do(func() {
		p.enqueue(p.doClose)
	})
}

func (p *Peer) doClose() {
	for key, sub := range p.subs {
		sub.pub.removeSubscriber(p.userID)
		delete(p.subs, key)
	}

	p.publishedMu.RLock()
	published := make(map[Source]*publishedTrack, len(p.published))
	for k, v := range p.published {
		published[k] = v
	}
	p.publishedMu.RUnlock()

	for source, pub := range published {
		p.router.sig.SendTrackUnpublished(p.channelID, TrackInfo{UserID: p.userID, Source: source, Kind: kindString(pub.kind)})

		// Nothing else ever reaches into another peer's subs/pc, so without
		// this every subscriber's sender for this track leaks for the rest
		// of the call: dead entry in their p.subs, dead sender still on
		// their pc, and an m-line that's never removed.
		for _, subscriberID := range pub.subscriberUserIDs() {
			if subscriber, ok := p.room.peerByUserID(subscriberID); ok {
				subscriber.enqueue(func() { subscriber.doUnsubscribe(p.userID, source) })
			}
		}
	}

	_ = p.pc.Close()
	p.stopped.Store(true)
}
