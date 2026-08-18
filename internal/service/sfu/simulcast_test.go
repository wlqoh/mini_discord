package sfu

import (
	"testing"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestRTPRewriterPassthroughOnFirstStart(t *testing.T) {
	var rw rtpRewriter
	rw.start(1000, 90000)
	seq, ts := rw.apply(1000, 90000)
	if seq != 1000 || ts != 90000 {
		t.Fatalf("first start should pass through unchanged, got seq=%d ts=%d", seq, ts)
	}
}

func TestRTPRewriterContinuityAcrossSwitch(t *testing.T) {
	var rw rtpRewriter
	rw.start(100, 90000) // subscription's very first layer
	rw.apply(100, 90000)
	seq, ts := rw.apply(101, 90000) // second packet, same video frame
	if seq != 101 || ts != 90000 {
		t.Fatalf("unexpected passthrough output: seq=%d ts=%d", seq, ts)
	}

	// Publisher-side switch to an unrelated layer with its own independent
	// sequence/timestamp numbering (sfu-migration-plan.md §7 phase 6 step 3).
	rw.start(5000, 500000)
	seq, ts = rw.apply(5000, 500000)
	if seq != 102 {
		t.Fatalf("sequence number discontinuity across switch: got %d, want 102", seq)
	}
	if ts != 93000 {
		t.Fatalf("timestamp discontinuity across switch: got %d, want 93000", ts)
	}

	// The stream continues to advance normally on the new layer afterward.
	seq, ts = rw.apply(5001, 503000)
	if seq != 103 || ts != 96000 {
		t.Fatalf("unexpected continuation after switch: seq=%d ts=%d", seq, ts)
	}
}

func TestRTPRewriterHandlesSequenceNumberWraparound(t *testing.T) {
	var rw rtpRewriter
	rw.start(65530, 0)
	if seq, _ := rw.apply(65530, 0); seq != 65530 {
		t.Fatalf("got %d, want 65530", seq)
	}
	if seq, _ := rw.apply(65535, 3000); seq != 65535 {
		t.Fatalf("got %d, want 65535", seq)
	}

	rw.start(10, 100000) // new layer's numbering starts far below ours
	if seq, _ := rw.apply(10, 100000); seq != 0 {
		t.Fatalf("sequence number should wrap from 65535 to 0, got %d", seq)
	}
}

func TestResolveRIDSingleLayerIgnoresQuality(t *testing.T) {
	pub := &publishedTrack{layers: map[string]*trackLayer{RIDLow: {rid: RIDLow}}}
	if got := pub.resolveRID(QualityHigh); got != RIDLow {
		t.Fatalf("non-simulcast track should always resolve to its one layer, got %q", got)
	}
	if got := pub.resolveRID(QualityLow); got != RIDLow {
		t.Fatalf("non-simulcast track should always resolve to its one layer, got %q", got)
	}
}

func TestResolveRIDPrefersRequestedThenFallsBack(t *testing.T) {
	pub := &publishedTrack{layers: map[string]*trackLayer{
		RIDLow:  {rid: RIDLow},
		RIDMid:  {rid: RIDMid},
		RIDHigh: {rid: RIDHigh},
	}}

	if got := pub.resolveRID(QualityHigh); got != RIDHigh {
		t.Fatalf("resolveRID(high) = %q, want h", got)
	}
	if got := pub.resolveRID(QualityLow); got != RIDLow {
		t.Fatalf("resolveRID(low) = %q, want l", got)
	}

	// "h" hasn't started publishing yet — fall back down the preference
	// order instead of resolving to a RID with no layer behind it.
	delete(pub.layers, RIDHigh)
	if got := pub.resolveRID(QualityHigh); got != RIDMid {
		t.Fatalf("resolveRID(high) without h should fall back to m, got %q", got)
	}
}

func TestSetSubscriberQualityRetargetsPendingLayer(t *testing.T) {
	pub := &publishedTrack{
		layers: map[string]*trackLayer{RIDLow: {rid: RIDLow}, RIDHigh: {rid: RIDHigh}},
		subs:   map[int]*trackSubscriber{7: {activeRID: RIDLow, requestedQuality: QualityLow}},
	}

	target := pub.setSubscriberQuality(7, QualityHigh)
	if target != RIDHigh {
		t.Fatalf("target = %q, want h", target)
	}
	if pub.subs[7].pendingRID != RIDHigh {
		t.Fatalf("pendingRID = %q, want h", pub.subs[7].pendingRID)
	}
	if pub.subs[7].activeRID != RIDLow {
		t.Fatalf("activeRID must not change until the switch actually happens on a keyframe, got %q", pub.subs[7].activeRID)
	}
}

func TestSetSubscriberQualityClearsDegradedOverride(t *testing.T) {
	pub := &publishedTrack{
		layers: map[string]*trackLayer{RIDLow: {rid: RIDLow}, RIDHigh: {rid: RIDHigh}},
		subs:   map[int]*trackSubscriber{7: {activeRID: RIDLow, requestedQuality: QualityHigh, degraded: true}},
	}

	// The client re-asking for "high" should get a clean shot at it, not be
	// silently held at "low" by a stale server-side degradation.
	target := pub.setSubscriberQuality(7, QualityHigh)
	if target != RIDHigh {
		t.Fatalf("target = %q, want h", target)
	}
	if pub.subs[7].degraded {
		t.Fatal("explicit quality request should clear the degraded flag")
	}
}

func TestSetDegradedStepsHighDownAndRecovers(t *testing.T) {
	pub := &publishedTrack{
		layers: map[string]*trackLayer{RIDLow: {rid: RIDLow}, RIDHigh: {rid: RIDHigh}},
		subs:   map[int]*trackSubscriber{7: {activeRID: RIDHigh, requestedQuality: QualityHigh}},
	}

	target, changed := pub.setDegraded(7, true)
	if !changed || target != RIDLow {
		t.Fatalf("setDegraded(true) = (%q, %v), want (l, true)", target, changed)
	}
	if pub.subs[7].pendingRID != RIDLow {
		t.Fatalf("pendingRID = %q, want l", pub.subs[7].pendingRID)
	}

	if _, changed := pub.setDegraded(7, true); changed {
		t.Fatal("re-degrading an already-degraded subscriber should be a no-op")
	}

	// Simulate the pending switch having completed, then loss clears.
	pub.subs[7].activeRID = RIDLow
	pub.subs[7].pendingRID = ""

	target, changed = pub.setDegraded(7, false)
	if !changed || target != RIDHigh {
		t.Fatalf("setDegraded(false) = (%q, %v), want (h, true)", target, changed)
	}
}

func TestForwardToSubscribersSwitchesOnlyOnKeyframe(t *testing.T) {
	local, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8},
		"u1-camera-video", "u1-camera",
	)
	if err != nil {
		t.Fatalf("NewTrackLocalStaticRTP: %v", err)
	}

	// Simulates a subscriber mid-call: already receiving "h" and has been
	// for a while (rewrite initialized with a real running offset), now
	// asked to step down to "l" (e.g. an active speaker losing the floor).
	sub := &trackSubscriber{
		local:      local,
		hasActive:  true,
		activeRID:  RIDHigh,
		pendingRID: RIDLow,
		rewrite:    rtpRewriter{initialized: true, lastOutSeq: 200, lastOutTs: 90000},
	}
	pub := &publishedTrack{
		kind: webrtc.RTPCodecTypeVideo,
		subs: map[int]*trackSubscriber{42: sub},
	}

	highLayer := &trackLayer{rid: RIDHigh}
	lowLayer := &trackLayer{rid: RIDLow}

	// Still forwarding the active "h" layer normally.
	pub.forwardToSubscribers(highLayer, &rtp.Packet{Header: rtp.Header{SequenceNumber: 201, Timestamp: 93000}}, false)
	sub.mu.Lock()
	if sub.activeRID != RIDHigh || sub.rewrite.lastOutSeq != 201 {
		t.Fatalf("unexpected state after forwarding active layer: activeRID=%s lastOutSeq=%d", sub.activeRID, sub.rewrite.lastOutSeq)
	}
	sub.mu.Unlock()

	// A non-keyframe packet on the pending layer must NOT trigger the
	// switch — cutting over mid-GOP would hand the decoder frames it can't
	// reconstruct (sfu-migration-plan.md §7 phase 6 step 3 / §8).
	pub.forwardToSubscribers(lowLayer, &rtp.Packet{Header: rtp.Header{SequenceNumber: 5000, Timestamp: 500000}}, false)
	sub.mu.Lock()
	if sub.activeRID != RIDHigh || sub.pendingRID != RIDLow {
		t.Fatalf("switched before a keyframe arrived: active=%s pending=%s", sub.activeRID, sub.pendingRID)
	}
	sub.mu.Unlock()

	// The pending layer's keyframe arrives — now it switches, and the
	// subscriber's output stream must continue right where it left off.
	pub.forwardToSubscribers(lowLayer, &rtp.Packet{Header: rtp.Header{SequenceNumber: 5000, Timestamp: 500000}}, true)
	sub.mu.Lock()
	defer sub.mu.Unlock()
	if sub.activeRID != RIDLow || sub.pendingRID != "" {
		t.Fatalf("did not switch on keyframe: active=%s pending=%s", sub.activeRID, sub.pendingRID)
	}
	if sub.rewrite.lastOutSeq != 202 {
		t.Fatalf("sequence discontinuity across switch: got %d, want 202", sub.rewrite.lastOutSeq)
	}
	if sub.rewrite.lastOutTs != 96000 {
		t.Fatalf("timestamp discontinuity across switch: got %d, want 96000", sub.rewrite.lastOutTs)
	}
}

func TestForwardToSubscribersIgnoresUnrelatedLayer(t *testing.T) {
	local, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8},
		"u1-camera-video", "u1-camera",
	)
	if err != nil {
		t.Fatalf("NewTrackLocalStaticRTP: %v", err)
	}

	sub := &trackSubscriber{local: local, hasActive: true, activeRID: RIDLow}
	pub := &publishedTrack{
		kind: webrtc.RTPCodecTypeVideo,
		subs: map[int]*trackSubscriber{42: sub},
	}

	midLayer := &trackLayer{rid: RIDMid}
	pub.forwardToSubscribers(midLayer, &rtp.Packet{Header: rtp.Header{SequenceNumber: 1, Timestamp: 1}}, true)

	sub.mu.Lock()
	defer sub.mu.Unlock()
	if sub.activeRID != RIDLow || sub.pendingRID != "" {
		t.Fatalf("a layer that's neither active nor pending must not affect subscriber state: active=%s pending=%s", sub.activeRID, sub.pendingRID)
	}
}

// TestSingleLayerSubscriberWaitsForKeyframe guards the hasActive fix: a
// non-simulcast source (screen, mic, screen_audio) always has the empty RID,
// which used to collide with a brand-new subscriber's zero-value activeRID
// and let packets through from the middle of a GOP instead of waiting for a
// keyframe (screenshare-and-late-joiner-fix-plan.md defect 3).
func TestSingleLayerSubscriberWaitsForKeyframe(t *testing.T) {
	local, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8},
		"u1-screen-video", "u1-screen",
	)
	if err != nil {
		t.Fatalf("NewTrackLocalStaticRTP: %v", err)
	}

	// Mirrors newSubscriber's state for a non-simulcast source: pendingRID
	// resolves to the empty RID, hasActive/activeRID at their zero values.
	sub := &trackSubscriber{local: local}
	pub := &publishedTrack{
		kind: webrtc.RTPCodecTypeVideo,
		subs: map[int]*trackSubscriber{42: sub},
	}
	layer := &trackLayer{rid: ""}

	pub.forwardToSubscribers(layer, &rtp.Packet{Header: rtp.Header{SequenceNumber: 10, Timestamp: 1000}}, false)
	sub.mu.Lock()
	if sub.hasActive {
		t.Fatal("must not start forwarding on a non-keyframe packet before hasActive is set")
	}
	sub.mu.Unlock()

	pub.forwardToSubscribers(layer, &rtp.Packet{Header: rtp.Header{SequenceNumber: 11, Timestamp: 2000}}, true)
	sub.mu.Lock()
	defer sub.mu.Unlock()
	if !sub.hasActive || sub.activeRID != "" {
		t.Fatalf("expected subscriber active on the empty RID after a keyframe, hasActive=%v activeRID=%q", sub.hasActive, sub.activeRID)
	}
	if !sub.rewrite.initialized {
		t.Fatal("rewrite.start should have been called on the keyframe cutover")
	}
}
