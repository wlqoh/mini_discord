package sfu

import (
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

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
	// joinedAt is used by the hub's reconciliation sweep (ghost-participants-
	// plan.md §5) to avoid tearing down a session that is mid-Join — it's set
	// once here and never mutated, so it needs no synchronization.
	joinedAt time.Time

	router *Router
	room   *Room
	pc     *webrtc.PeerConnection
	log    *slog.Logger

	// mutated only from run() — see the invariant above.
	slotBySource map[Source]string // Source -> MID, from the client's initial offer
	subs         map[subKey]*subscription

	publishedMu sync.RWMutex
	published   map[Source]*publishedTrack
	// publishState is the publisher's explicitly announced state
	// (sfu_publish_state) for each source. No entry means "active": a camera
	// physically keeps publishing even when "off" (decision #3 — that's
	// track.enabled=false client-side, not a stopped track), so defaulting
	// to active preserves today's behavior for a client that never
	// announces its camera's state.
	publishState map[Source]bool

	negotiating        atomic.Bool
	renegotiatePending atomic.Bool

	// detached is set by Router.Detach when the client's WebSocket drops
	// (migration phase 3, decision #10) — the PeerConnection is left alone
	// (media keeps flowing; only signaling depends on the WebSocket) but
	// nothing is sent to a peer that has nowhere to receive it. Router.Resume
	// clears it once the client reconnects.
	detached atomic.Bool

	// closeNotified dedupes SessionObserver.OnSessionClosed: PeerConnection
	// state failed -> closed fires the change handler twice in a row for
	// the same death (decision #2/#3).
	closeNotified atomic.Bool

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
		joinedAt:     time.Now(),
		router:       router,
		room:         room,
		pc:           pc,
		log:          log,
		slotBySource: make(map[Source]string),
		subs:         make(map[subKey]*subscription),
		published:    make(map[Source]*publishedTrack),
		publishState: make(map[Source]bool),
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
		// Deliberately log-only: ICE state flaps on its own (a brief
		// disconnected -> connected blip is normal) and isn't a reliable
		// "this session is dead" signal by itself. The teardown decision is
		// made on PeerConnectionState below instead, which aggregates
		// ICE+DTLS and is terminal (ghost-participants-plan.md §3 decision
		// #2).
	})

	p.pc.OnConnectionStateChange(p.handleConnectionStateChange)

	p.pc.OnTrack(func(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		p.enqueue(func() { p.handleOnTrack(remote, receiver) })
	})
}

// handleConnectionStateChange is p.pc's OnConnectionStateChange callback,
// extracted to a named method so tests can drive it directly instead of
// waiting out a real ICE/DTLS failure. It deliberately does not go through
// enqueue (see the type doc's concurrency invariant): stopped and
// closeNotified are atomics precisely so this can run safely from whatever
// goroutine Pion calls it on.
func (p *Peer) handleConnectionStateChange(state webrtc.PeerConnectionState) {
	p.log.Debug("sfu: pc state", "state", state.String())
	switch state {
	case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
		if p.stopped.Load() {
			// Our own teardown (Router.Leave/Close -> doClose -> pc.Close)
			// also lands here — don't report a normal exit as a session the
			// SFU had to kill.
			return
		}
		if !p.closeNotified.CompareAndSwap(false, true) {
			return
		}
		reason := CloseReasonPCFailed
		if state == webrtc.PeerConnectionStateClosed {
			reason = CloseReasonPCClosed
		}
		p.router.notifySessionClosed(p, reason)
	}
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
	p.sendTrackSnapshot()
}

// sendTrackSnapshot tells a just-connected peer about every video track
// published in the room BEFORE it arrived. Without this, a peer only learns
// about someone else's video from the broadcast at that source's very first
// publish and permanently misses anything that started earlier. Sent from
// here, not from Router.Join: the client only sets currentChannelID once it
// applies the join ack (applySession), and handleTrackPublished discards
// events for a different channel_id — a snapshot sent any earlier would be
// silently dropped by the time it arrived.
func (p *Peer) sendTrackSnapshot() {
	for _, other := range p.room.others(p.userID) {
		for _, info := range other.publishedVideoTrackInfos() {
			p.router.sig.SendTrackPublishedTo(p.userID, p.channelID, info)
		}
	}
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
			p.doSubscribe(other.userID, pub, QualityHigh)
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

// setPublishState records source's explicitly announced active state
// (sfu_publish_state). Called from a command routed through Router —
// see the type doc's note that publishedMu, not enqueue, guards this field
// because it's read cross-goroutine (publishedVideoTrackInfos/
// sendTrackSnapshot above).
func (p *Peer) setPublishState(source Source, active bool) {
	p.publishedMu.Lock()
	p.publishState[source] = active
	pub := p.published[source]
	p.publishedMu.Unlock()

	// The source just came back to life: subscribers who were already
	// subscribed get no new subscription out of this, and therefore no PLI
	// from doSubscribe — without asking here, they'd be stuck waiting for
	// the publisher's browser to schedule its own next key frame.
	if active && pub != nil {
		for _, rid := range pub.layerRIDs() {
			pub.requestKeyframeForRIDWithRetry(rid)
		}
	}
}

// isSourceActive reports whether source is currently active per the last
// sfu_publish_state announcement (or true, if the publisher never sent one
// — see the publishState field doc).
func (p *Peer) isSourceActive(source Source) bool {
	p.publishedMu.RLock()
	defer p.publishedMu.RUnlock()
	active, ok := p.publishState[source]
	return !ok || active
}

// publishedVideoTrackInfos lists this peer's currently active video
// sources, for the snapshot handed to a newly joined peer (sendTrackSnapshot
// above). Audio is deliberately excluded: it auto-subscribes server-side
// (decision #8), so the client never needs to hear about it.
func (p *Peer) publishedVideoTrackInfos() []TrackInfo {
	p.publishedMu.RLock()
	defer p.publishedMu.RUnlock()
	var out []TrackInfo
	for source, pub := range p.published {
		if pub.kind != webrtc.RTPCodecTypeVideo {
			continue
		}
		if active, ok := p.publishState[source]; ok && !active {
			continue
		}
		out = append(out, TrackInfo{UserID: p.userID, Source: source, Kind: kindString(pub.kind)})
	}
	return out
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
		// Non-fatal: candidates that lose a renegotiation race (e.g. arriving
		// for a description the client already superseded) are expected to
		// fail occasionally. Log only.
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

// handleOnTrack fires once per RTP stream on a slot: once for a
// non-simulcast source (mic, screen, screen_audio, or a camera whose client
// didn't negotiate simulcast), and once per RID for a simulcast camera
// (migration phase 6, sfu-migration-plan.md §7 phase 6 step 2) — Pion calls
// OnTrack separately for each layer of a single m-line's simulcast group.
func (p *Peer) handleOnTrack(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	mid := receiver.RTPTransceiver().Mid()
	source, ok := p.sourceForMID(mid)
	if !ok {
		p.log.Warn("sfu: track on unrecognized mid", "mid", mid)
		return
	}

	p.publishedMu.Lock()
	pub, exists := p.published[source]
	if !exists {
		var audioLevelExtID uint8
		if remote.Kind() == webrtc.RTPCodecTypeAudio {
			audioLevelExtID = audioLevelExtensionID(receiver)
		}
		pub = newPublishedTrack(p.userID, source, remote.Kind(), p, audioLevelExtID)
		p.published[source] = pub
	}
	p.publishedMu.Unlock()

	pub.addLayer(remote, p.log)

	if exists {
		// A later simulcast layer ("m"/"h") for a source already announced
		// by its first layer — subscribers already know this source exists;
		// a subscriber whose resolveRID had to fall back to a lower layer
		// picks this one up automatically once it has a keyframe (see
		// forwardToSubscribers), no further signaling needed.
		return
	}

	// Every published track is announced so clients know it's there to
	// subscribe to. Audio auto-subscribes everyone in the room right away
	// (decision #8); video waits for an explicit sfu_subscribe_video
	// (migration phase 2) — draining the track via forwardLayer() above
	// keeps Pion's internal buffers healthy in the meantime regardless.
	p.router.sig.SendTrackPublished(p.channelID, TrackInfo{UserID: p.userID, Source: source, Kind: kindString(pub.kind)})

	if pub.kind != webrtc.RTPCodecTypeAudio {
		return
	}

	for _, other := range p.room.others(p.userID) {
		other.subscribeToTrack(p.userID, pub, QualityHigh)
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
func (p *Peer) subscribeToTrack(publisherUserID int, pub *publishedTrack, quality Quality) {
	p.enqueue(func() { p.doSubscribe(publisherUserID, pub, quality) })
}

// doSubscribe subscribes this peer to pub at quality, or — if it's already
// subscribed (a quality change on an existing subscription, e.g. an active
// speaker being bumped from "low" to "high", migration phase 6 step 4/5) —
// just retargets which simulcast layer feeds the existing m-line. Only a
// brand-new subscription needs pc.AddTrack + renegotiation; a quality change
// is purely internal to the publishedTrack (see setSubscriberQuality).
func (p *Peer) doSubscribe(publisherUserID int, pub *publishedTrack, quality Quality) {
	key := subKey{publisherUserID: publisherUserID, source: pub.source}

	if _, exists := p.subs[key]; exists {
		targetRID := pub.setSubscriberQuality(p.userID, quality)
		pub.requestKeyframeForRIDWithRetry(targetRID)
		return
	}

	local, targetRID, err := pub.newSubscriber(p.userID, quality)
	if err != nil {
		p.log.Error("sfu: create local track failed", "err", err)
		return
	}

	sender, err := p.pc.AddTrack(local)
	if err != nil {
		p.log.Error("sfu: add track failed", "err", err)
		pub.removeSubscriber(p.userID)
		return
	}

	p.subs[key] = &subscription{pub: pub, local: local, sender: sender}
	p.scheduleNegotiate()
	go monitorSubscriptionLoss(pub, p.userID, sender, p.log)

	// A new video subscriber decodes nothing until the next key frame on
	// their target layer — ask the publisher for one right away instead of
	// waiting out its normal interval (sfu-migration-plan.md §8 pitfall #3).
	// No-op for audio.
	pub.requestKeyframeForRIDWithRetry(targetRID)
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
	// Set before pc.Close(): Pion dispatches OnConnectionStateChange via
	// `go handler(cs)` (pion/webrtc's onConnectionStateChange), so the
	// handler can run concurrently with the rest of this function on
	// another goroutine — setting stopped afterwards would leave a window
	// where handleConnectionStateChange's stopped check could still see
	// false and misreport this normal teardown as a session the SFU had to
	// kill.
	p.stopped.Store(true)

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
}
