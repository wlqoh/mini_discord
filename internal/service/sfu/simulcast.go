package sfu

import (
	"log/slog"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// Simulcast RID naming (sfu-migration-plan.md §7 phase 6): a camera
// transceiver publishes three independent RTP streams the browser tags with
// these RIDs via sendEncodings. Screen share is deliberately never
// simulcast (decision #4 — clarity of static text matters more than
// adaptive bitrate there), so it and every audio source always publish a
// single stream tagged with the empty RID.
const (
	RIDLow  = "l"
	RIDMid  = "m"
	RIDHigh = "h"
)

// preferredRIDOrder lists layer preference from most to least wanted for
// each wire Quality, used both to pick a starting layer and to fall back
// when the preferred one hasn't started publishing yet (e.g. "h" hasn't
// produced a keyframe) or doesn't exist at all (source isn't simulcast, in
// which case resolveRID never even consults this — see its single-layer
// short-circuit).
var preferredRIDOrder = map[Quality][]string{
	QualityHigh: {RIDHigh, RIDMid, RIDLow},
	QualityLow:  {RIDLow, RIDMid, RIDHigh},
}

// simulcastSwitchTimestampStep approximates one video frame's worth of RTP
// timestamp advance (90kHz clock / 30fps) so a layer switch's rewritten
// timestamp keeps moving forward instead of jumping backward or stalling.
// Exact media-time accuracy doesn't matter here — only monotonicity, so the
// subscriber's jitter buffer and decoder don't treat the switch as a
// discontinuity (sfu-migration-plan.md §7 phase 6 step 3).
const simulcastSwitchTimestampStep = 90000 / 30

// rtpRewriter keeps one subscriber's outgoing RTP sequence number and
// timestamp continuous across a publisher-side layer switch. Each layer is
// an independent RTP stream with its own numbering; without this, a switch
// would look like a sequence number discontinuity (out-of-order/loss) or a
// timestamp jump to the subscriber's jitter buffer. The zero value is a
// no-op passthrough (offsets 0), which is exactly correct for a
// non-simulcast subscription that never switches layers at all.
type rtpRewriter struct {
	initialized bool
	seqOffset   uint16
	tsOffset    uint32
	lastOutSeq  uint16
	lastOutTs   uint32
}

// start begins (or resumes, after a switch) rewriting from firstInSeq/
// firstInTs — the first packet of the layer now being forwarded. The very
// first call for a subscription passes through unchanged (offset 0, so the
// subscriber's stream starts at whatever sequence/timestamp the publisher
// happens to be at); every call after that computes an offset that
// continues the subscriber's own output numbering immediately after the
// last packet sent to them, regardless of what the new layer's numbering is.
func (rw *rtpRewriter) start(firstInSeq uint16, firstInTs uint32) {
	if !rw.initialized {
		rw.seqOffset = 0
		rw.tsOffset = 0
		rw.initialized = true
		return
	}
	rw.seqOffset = rw.lastOutSeq + 1 - firstInSeq
	rw.tsOffset = rw.lastOutTs + simulcastSwitchTimestampStep - firstInTs
}

// apply rewrites one packet's sequence number/timestamp per the current
// offsets and records the result, so a future start() (on the next switch)
// continues from here.
func (rw *rtpRewriter) apply(seq uint16, ts uint32) (outSeq uint16, outTs uint32) {
	outSeq = seq + rw.seqOffset
	outTs = ts + rw.tsOffset
	rw.lastOutSeq = outSeq
	rw.lastOutTs = outTs
	return outSeq, outTs
}

// Loss-based auto-degrade thresholds (sfu-migration-plan.md §7 phase 6 step
// 4: "при потерях у подписчика — понижение"). fractionLost is RTCP's 0-255
// scale (255 = 100% of the interval's packets lost) read as a 0-1 fraction.
// Requiring lossSampleWindow consecutive reports on the same side before
// acting debounces a single noisy RTCP interval — receiver reports arrive
// roughly once a second, so this reacts within a few seconds either way,
// which is fine for a coarse high/low degrade rather than a tight ABR loop.
const (
	lossDegradeThreshold = 0.10
	lossRecoverThreshold = 0.02
	lossSampleWindow     = 3
)

// Keyframe retry pacing for requestKeyframeForRIDWithRetry (track.go) —
// keyframeRetryMaxAttempts attempts spaced keyframeRetryInterval apart is
// about 15s of persistence before giving up on a layer that's never going
// to send one.
const (
	keyframeRetryInterval    = 1500 * time.Millisecond
	keyframeRetryMaxAttempts = 10
)

// monitorSubscriptionLoss watches RTCP receiver reports the subscriber sends
// back about sub's local track and steps the subscription's effective
// quality down (via publishedTrack.setDegraded) under sustained loss,
// recovering once loss clears for the same number of samples. Runs for the
// lifetime of sender — returns as soon as Read starts failing, which is what
// happens once the subscription's sender is removed or the peer connection
// closes (same shutdown pattern as publishedTrack.forwardLayer's ReadRTP
// loop; no separate stop signal needed).
//
// Only meaningful for video: audio isn't simulcast, and Opus's own DTX
// (decision #5) already adapts to bad networks, so there's nothing here to
// downgrade for it.
func monitorSubscriptionLoss(pub *publishedTrack, subscriberUserID int, sender *webrtc.RTPSender, log *slog.Logger) {
	if pub.kind != webrtc.RTPCodecTypeVideo {
		return
	}

	defer func() {
		if r := recover(); r != nil {
			log.Error("sfu: panic in loss monitor", "user_id", subscriberUserID, "panic", r)
		}
	}()

	buf := make([]byte, 1500)
	badStreak, goodStreak := 0, 0

	for {
		n, _, err := sender.Read(buf)
		if err != nil {
			return
		}
		packets, err := rtcp.Unmarshal(buf[:n])
		if err != nil {
			continue
		}

		for _, pkt := range packets {
			rr, ok := pkt.(*rtcp.ReceiverReport)
			if !ok {
				continue
			}
			for _, report := range rr.Reports {
				fractionLost := float64(report.FractionLost) / 256.0
				switch {
				case fractionLost >= lossDegradeThreshold:
					badStreak++
					goodStreak = 0
				case fractionLost <= lossRecoverThreshold:
					goodStreak++
					badStreak = 0
				default:
					badStreak, goodStreak = 0, 0
				}
			}
		}

		if badStreak >= lossSampleWindow {
			badStreak = 0
			if targetRID, changed := pub.setDegraded(subscriberUserID, true); changed {
				log.Debug("sfu: degrading subscription under loss", "user_id", subscriberUserID, "publisher_id", pub.userID, "source", pub.source, "rid", targetRID)
				pub.requestKeyframeForRIDWithRetry(targetRID)
			}
		}
		if goodStreak >= lossSampleWindow {
			goodStreak = 0
			if targetRID, changed := pub.setDegraded(subscriberUserID, false); changed {
				log.Debug("sfu: recovering subscription after loss cleared", "user_id", subscriberUserID, "publisher_id", pub.userID, "source", pub.source, "rid", targetRID)
				pub.requestKeyframeForRIDWithRetry(targetRID)
			}
		}
	}
}
