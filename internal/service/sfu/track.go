package sfu

import (
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// trackLayer is one simulcast RTP stream backing a publishedTrack. A
// non-simulcast source (mic, screen, screen_audio, or a camera from a
// client that didn't negotiate simulcast) has exactly one layer, keyed by
// the empty RID. A simulcast camera (migration phase 6) has up to three,
// keyed "l"/"m"/"h" (see RIDLow/RIDMid/RIDHigh).
type trackLayer struct {
	rid    string
	remote *webrtc.TrackRemote

	keyframeMu     sync.RWMutex
	lastKeyframeAt time.Time
}

func (l *trackLayer) markKeyframe() {
	l.keyframeMu.Lock()
	l.lastKeyframeAt = time.Now()
	l.keyframeMu.Unlock()
}

func (l *trackLayer) hasKeyframeSince(since time.Time) bool {
	l.keyframeMu.RLock()
	defer l.keyframeMu.RUnlock()
	return l.lastKeyframeAt.After(since)
}

// trackSubscriber is one subscriber's view into a publishedTrack: which
// layer they're actually receiving, which layer they're waiting to cut over
// to (switches only happen on that layer's next key frame — sfu-migration-
// plan.md §7 phase 6 step 3 / §8), the local track their RTP is written
// into, and the rewrite state that keeps that track's sequence
// numbers/timestamps continuous across a switch. requestedQuality is what
// the client last asked for via sfu_subscribe_video; degraded is a
// server-side override applied on top of it when RTCP receiver reports show
// sustained loss (phase 6 step 4) — cleared the moment the client asks for
// anything explicitly again.
type trackSubscriber struct {
	local *webrtc.TrackLocalStaticRTP

	mu               sync.Mutex
	requestedQuality Quality
	degraded         bool
	// hasActive distinguishes "no layer chosen yet" from "chosen layer has
	// the empty RID" — a non-simulcast source (screen, mic, screen_audio;
	// RID "") would otherwise collide with activeRID's zero value and
	// forwardToSubscribers would treat a brand-new subscriber as already on
	// that layer, skipping rewrite.start() and letting packets through from
	// wherever the GOP happens to be instead of waiting for a keyframe.
	hasActive  bool
	activeRID  string
	pendingRID string // "" while no switch is pending
	rewrite    rtpRewriter
}

// publishedTrack is one media source a peer is sending to the SFU (their
// mic, camera, screen video, or screen audio — see Source). It owns the
// fan-out to every subscriber's local copy of the track, across however many
// simulcast layers the source actually has. subs has its own mutex
// independent of the owning Peer's command queue (see peer.go's
// package-level invariant comment): a subscriber Peer's own command
// goroutine adds/removes/reconfigures itself here, and each layer's RTP
// forward loop below reads it from a completely different goroutine, so it
// cannot be folded into either peer's serialized state.
type publishedTrack struct {
	userID int
	source Source
	kind   webrtc.RTPCodecType

	// owner lets a subscriber (see doSubscribe in peer.go) send PLI back to
	// the publisher's own PeerConnection without a room/router lookup, and
	// forwardLayer() reach the room's active-speaker tracker. Set once at
	// construction, never reassigned — safe to read from any goroutine (see
	// peer.go's pc field for the same reasoning).
	owner *Peer
	// audioLevelExtID is the negotiated RTP header extension ID for
	// ssrc-audio-level (RFC 6464, decision #9) on this track, or 0 if the
	// client didn't negotiate it. Only meaningful for kind == audio.
	audioLevelExtID uint8

	layersMu sync.RWMutex
	layers   map[string]*trackLayer // rid -> layer

	subsMu sync.RWMutex
	subs   map[int]*trackSubscriber // subscriber userID -> subscriber state
}

func newPublishedTrack(userID int, source Source, kind webrtc.RTPCodecType, owner *Peer, audioLevelExtID uint8) *publishedTrack {
	return &publishedTrack{
		userID:          userID,
		source:          source,
		kind:            kind,
		owner:           owner,
		audioLevelExtID: audioLevelExtID,
		layers:          make(map[string]*trackLayer),
		subs:            make(map[int]*trackSubscriber),
	}
}

// addLayer registers a new simulcast layer (or the sole layer, for a
// non-simulcast source) and starts forwarding it. Safe to call more than
// once for the same publishedTrack — a simulcast camera's "m"/"h" layers
// typically arrive shortly after "l", each as its own OnTrack callback.
func (t *publishedTrack) addLayer(remote *webrtc.TrackRemote, log *slog.Logger) {
	layer := &trackLayer{rid: remote.RID(), remote: remote}
	t.layersMu.Lock()
	t.layers[layer.rid] = layer
	t.layersMu.Unlock()
	go t.forwardLayer(layer, log)
}

func (t *publishedTrack) layerRIDs() []string {
	t.layersMu.RLock()
	defer t.layersMu.RUnlock()
	rids := make([]string, 0, len(t.layers))
	for rid := range t.layers {
		rids = append(rids, rid)
	}
	return rids
}

func (t *publishedTrack) codecCapability() webrtc.RTPCodecCapability {
	t.layersMu.RLock()
	defer t.layersMu.RUnlock()
	for _, l := range t.layers {
		return l.remote.Codec().RTPCodecCapability
	}
	return webrtc.RTPCodecCapability{}
}

// resolveRID picks which layer best satisfies quality given whatever this
// track's layers currently are. A non-simulcast track (exactly one layer)
// always resolves to that one layer regardless of quality — off is handled
// by the caller before this is ever reached (SubscribeVideo/doUnsubscribe).
func (t *publishedTrack) resolveRID(quality Quality) string {
	t.layersMu.RLock()
	defer t.layersMu.RUnlock()

	if len(t.layers) <= 1 {
		for rid := range t.layers {
			return rid
		}
		return ""
	}

	for _, rid := range preferredRIDOrder[quality] {
		if _, ok := t.layers[rid]; ok {
			return rid
		}
	}
	// None of the preferred RIDs have started publishing yet (e.g. subscribed
	// the instant "l" arrived, before "m"/"h" did) — fall back to whatever
	// layer does exist rather than resolving to a RID that will never match
	// any layer.forwardLayer call and leave the subscriber stuck forever.
	for rid := range t.layers {
		return rid
	}
	return ""
}

// newSubscriber creates subscriberUserID's subscription to this track at
// quality, returning the local track to hand to pc.AddTrack and the RID it
// resolved to (for the caller's initial PLI request). Called only when the
// subscriber has no existing subscription to this track (see doSubscribe).
func (t *publishedTrack) newSubscriber(userID int, quality Quality) (local *webrtc.TrackLocalStaticRTP, targetRID string, err error) {
	targetRID = t.resolveRID(quality)

	local, err = webrtc.NewTrackLocalStaticRTP(
		t.codecCapability(),
		fmt.Sprintf("u%d-%s-%s", t.userID, t.source, kindString(t.kind)),
		fmt.Sprintf("u%d-%s", t.userID, t.source),
	)
	if err != nil {
		return nil, "", err
	}

	t.subsMu.Lock()
	t.subs[userID] = &trackSubscriber{local: local, requestedQuality: quality, pendingRID: targetRID}
	t.subsMu.Unlock()

	return local, targetRID, nil
}

// setSubscriberQuality updates an existing subscriber's requested quality —
// sfu_subscribe_video with a new quality for a source they're already
// subscribed to. This never touches the m-line (the client's own transport
// state doesn't change, only which internal layer feeds it), so unlike a
// fresh subscription it needs no renegotiation. Returns the RID the
// subscriber should end up on so the caller can request a key frame for it.
func (t *publishedTrack) setSubscriberQuality(userID int, quality Quality) string {
	targetRID := t.resolveRID(quality)

	t.subsMu.RLock()
	sub, ok := t.subs[userID]
	t.subsMu.RUnlock()
	if !ok {
		return targetRID
	}

	sub.mu.Lock()
	sub.requestedQuality = quality
	// An explicit request from the client overrides any standing
	// loss-triggered degradation — give the new tier a clean chance.
	sub.degraded = false
	if !sub.hasActive || sub.activeRID != targetRID {
		sub.pendingRID = targetRID
	}
	sub.mu.Unlock()

	return targetRID
}

// setDegraded flips a subscriber's loss-triggered degradation flag (phase 6
// step 4: sustained RTCP-reported loss steps a "high" subscription down to
// "low" until loss clears). No-op if the flag is already what's requested.
// Returns the RID the subscriber should end up on and whether that's a
// change from where they already are or are already headed.
func (t *publishedTrack) setDegraded(userID int, degraded bool) (targetRID string, changed bool) {
	t.subsMu.RLock()
	sub, ok := t.subs[userID]
	t.subsMu.RUnlock()
	if !ok {
		return "", false
	}

	sub.mu.Lock()
	if sub.degraded == degraded {
		sub.mu.Unlock()
		return "", false
	}
	sub.degraded = degraded
	effective := sub.requestedQuality
	if sub.degraded && effective == QualityHigh {
		effective = QualityLow
	}
	sub.mu.Unlock()

	targetRID = t.resolveRID(effective)

	sub.mu.Lock()
	changed = sub.pendingRID != targetRID && (!sub.hasActive || sub.activeRID != targetRID)
	if changed {
		sub.pendingRID = targetRID
	}
	sub.mu.Unlock()

	return targetRID, changed
}

func (t *publishedTrack) removeSubscriber(userID int) {
	t.subsMu.Lock()
	delete(t.subs, userID)
	t.subsMu.Unlock()
}

// subscriberUserIDs is used when this track's publisher goes away (see
// doClose in peer.go): every subscriber needs to be told to tear its side
// of the subscription down too, since nothing else ever reaches into
// another peer's pc/subs otherwise.
func (t *publishedTrack) subscriberUserIDs() []int {
	t.subsMu.RLock()
	defer t.subsMu.RUnlock()
	ids := make([]int, 0, len(t.subs))
	for id := range t.subs {
		ids = append(ids, id)
	}
	return ids
}

// subscriberLayerState reports userID's current active/pending RID, for the
// debug snapshot (decision #12). Empty strings if userID isn't subscribed.
func (t *publishedTrack) subscriberLayerState(userID int) (active, pending string) {
	t.subsMu.RLock()
	sub, ok := t.subs[userID]
	t.subsMu.RUnlock()
	if !ok {
		return "", ""
	}
	sub.mu.Lock()
	defer sub.mu.Unlock()
	if !sub.hasActive {
		return "", sub.pendingRID
	}
	return sub.activeRID, sub.pendingRID
}

// forwardLayer reads RTP from one simulcast layer and fans it out to every
// subscriber currently on (or switching to) that layer, for the lifetime of
// the layer. Runs in its own goroutine per layer (started by addLayer).
//
// recover() here is load-bearing, not defensive boilerplate (see
// sfu-migration-plan.md §8 pitfall #5): this loop processes attacker- or
// bug-reachable RTP straight from the network, and the SFU is a monolith
// sharing a process with chat (decision #2) — an unrecovered panic here
// takes the whole server down, not just this one call.
func (t *publishedTrack) forwardLayer(layer *trackLayer, log *slog.Logger) {
	defer func() {
		if r := recover(); r != nil {
			log.Error("sfu: panic in RTP forward loop", "user_id", t.userID, "source", t.source, "rid", layer.rid, "panic", r)
		}
	}()

	isVideo := t.kind == webrtc.RTPCodecTypeVideo
	// Active-speaker detection (decision #9) is scoped to mic audio only —
	// screen_audio shouldn't make someone look like they're "speaking". Mic
	// is never simulcast, so this only ever runs against the "" layer.
	tracksAudioLevel := t.source == SourceMic && t.audioLevelExtID != 0

	for {
		packet, _, err := layer.remote.ReadRTP()
		if err != nil {
			// Track ended: publisher's connection closed, or (for a
			// simulcast layer) that specific encoding stopped. Either way
			// there is nothing left to forward on this layer.
			return
		}

		// Audio has no GOP structure to wait on — every packet is a valid
		// place to start or resume forwarding, so it's treated as a
		// "keyframe" for the switch logic below. Video only actually
		// switches subscribers over on a real VP8 key frame.
		isKeyframe := !isVideo
		if isVideo && isVP8Keyframe(packet.Payload) {
			isKeyframe = true
			layer.markKeyframe()
		}
		if tracksAudioLevel {
			if data := packet.Header.GetExtension(t.audioLevelExtID); len(data) >= 1 {
				level := data[0] & 0x7F // RFC 6464: 0 = loudest, 127 = silence
				if level < audioLevelSpeakingThreshold {
					t.owner.room.speakers.markLoud(t.userID)
				}
			}
		}

		t.forwardToSubscribers(layer, packet, isKeyframe)
	}
}

// forwardToSubscribers writes packet (from layer) into every subscriber
// that's either already active on this layer or waiting to cut over to it.
// A waiting subscriber only cuts over once isKeyframe is true (pitfall: a
// mid-GOP switch produces frames the decoder can't reconstruct), at which
// point its rewriter is (re)started so its output sequence numbers and
// timestamps continue smoothly from wherever they last left off instead of
// jumping to this layer's own independent numbering.
func (t *publishedTrack) forwardToSubscribers(layer *trackLayer, packet *rtp.Packet, isKeyframe bool) {
	t.subsMu.RLock()
	subs := make([]*trackSubscriber, 0, len(t.subs))
	for _, s := range t.subs {
		subs = append(subs, s)
	}
	t.subsMu.RUnlock()

	for _, sub := range subs {
		sub.mu.Lock()
		switch {
		case sub.hasActive && sub.activeRID == layer.rid:
			// Already receiving this layer — nothing to do but forward.
		case sub.pendingRID == layer.rid && isKeyframe:
			sub.rewrite.start(packet.SequenceNumber, packet.Timestamp)
			sub.hasActive = true
			sub.activeRID = layer.rid
			sub.pendingRID = ""
		default:
			sub.mu.Unlock()
			continue
		}
		outSeq, outTs := sub.rewrite.apply(packet.SequenceNumber, packet.Timestamp)
		sub.mu.Unlock()

		out := *packet
		out.SequenceNumber = outSeq
		out.Timestamp = outTs
		// Best-effort: one subscriber's write failing (e.g. their
		// PeerConnection just closed) must not stop forwarding to the rest
		// of the room.
		_ = sub.local.WriteRTP(&out)
	}
}

// requestKeyframeForRID sends PLI for one specific layer. Used both for a
// brand-new subscription and for a layer switch (sfu-migration-plan.md §7
// phase 2/6, §8 pitfall #3): a subscriber waiting on a layer decodes nothing
// until that layer's next key frame, which without this can be seconds away.
func (t *publishedTrack) requestKeyframeForRID(rid string) {
	if t.kind != webrtc.RTPCodecTypeVideo {
		return
	}
	t.layersMu.RLock()
	layer, ok := t.layers[rid]
	t.layersMu.RUnlock()
	if !ok {
		return
	}
	_ = t.owner.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(layer.remote.SSRC())}})
}

// requestKeyframeForRIDWithRetry sends PLI immediately and keeps retrying on
// an interval until that layer actually produces a keyframe, up to
// keyframeRetryMaxAttempts. PLI travels over UDP with no delivery guarantee,
// and on a lossy real-world network a single retry (the original design)
// wasn't enough — a subscriber whose one retry also got lost was stuck with
// a permanently blank tile and no further recovery attempt, which is what
// made camera/screen visibility inconsistent between viewers on the same
// call (some got lucky with their one retry, some didn't).
func (t *publishedTrack) requestKeyframeForRIDWithRetry(rid string) {
	if t.kind != webrtc.RTPCodecTypeVideo {
		return
	}
	t.layersMu.RLock()
	layer, ok := t.layers[rid]
	t.layersMu.RUnlock()
	if !ok {
		return
	}
	requestedAt := time.Now()
	t.requestKeyframeForRID(rid)
	t.scheduleKeyframeRetry(layer, rid, requestedAt, 1)
}

// scheduleKeyframeRetry re-sends PLI on keyframeRetryInterval until layer
// reports a keyframe newer than since, or keyframeRetryMaxAttempts is
// reached (~15s total) — bounded so a layer that's genuinely never going to
// produce a keyframe (e.g. the publisher went away mid-negotiation) doesn't
// PLI-storm forever.
func (t *publishedTrack) scheduleKeyframeRetry(layer *trackLayer, rid string, since time.Time, attempt int) {
	if attempt > keyframeRetryMaxAttempts {
		return
	}
	time.AfterFunc(keyframeRetryInterval, func() {
		if layer.hasKeyframeSince(since) {
			return
		}
		t.requestKeyframeForRID(rid)
		t.scheduleKeyframeRetry(layer, rid, since, attempt+1)
	})
}

func kindString(k webrtc.RTPCodecType) string {
	if k == webrtc.RTPCodecTypeAudio {
		return "audio"
	}
	return "video"
}

// isVP8Keyframe reports whether payload is the first packet of a VP8 key
// frame, per the payload descriptor in RFC 7741 §4.2 and the frame tag in
// RFC 6386 §9.1. Only meaningful for a packet that starts a frame's first
// partition (S=1, PID=0); any other packet returns false, which is the
// correct "this packet doesn't tell us a keyframe is starting" answer even
// though it says nothing about the frame the packet belongs to.
func isVP8Keyframe(payload []byte) bool {
	if len(payload) < 1 {
		return false
	}

	start := payload[0]&0x10 != 0       // S bit: start of partition
	partitionIndex := payload[0] & 0x07 // PID
	if !start || partitionIndex != 0 {
		return false
	}

	headerSize := 1
	if payload[0]&0x80 != 0 { // X bit: extended control bits follow
		headerSize++
		if len(payload) < headerSize {
			return false
		}
		ext := payload[1]
		if ext&0x80 != 0 { // I: PictureID present
			if len(payload) < headerSize+1 {
				return false
			}
			if payload[headerSize]&0x80 != 0 { // long form: 2-byte PictureID
				headerSize += 2
			} else {
				headerSize++
			}
		}
		if ext&0x40 != 0 { // L: TL0PICIDX present
			headerSize++
		}
		if ext&0x30 != 0 { // T and/or K present: one shared byte
			headerSize++
		}
	}

	if len(payload) <= headerSize {
		return false
	}

	// VP8 payload header, byte 0: the frame_tag's low bit (little-endian) is
	// 0 for a key frame, 1 for an interframe.
	return payload[headerSize]&0x01 == 0
}
