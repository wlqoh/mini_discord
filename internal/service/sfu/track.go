package sfu

import (
	"log/slog"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// publishedTrack is one media source a peer is sending to the SFU (their
// mic, camera, screen video, or screen audio — see Source). It owns the
// fan-out to every subscriber's local copy of the track. subscribers has its
// own mutex independent of the owning Peer's command queue (see peer.go's
// package-level invariant comment): a subscriber Peer's own command
// goroutine adds/removes itself here, and the RTP forward loop below reads
// it from a completely different goroutine, so it cannot be folded into
// either peer's serialized state.
type publishedTrack struct {
	userID int
	source Source
	kind   webrtc.RTPCodecType

	remote *webrtc.TrackRemote
	// owner lets a subscriber (see doSubscribe in peer.go) send PLI back to
	// the publisher's own PeerConnection without a room/router lookup, and
	// forward() reach the room's active-speaker tracker. Set once at
	// construction, never reassigned — safe to read from any goroutine (see
	// peer.go's pc field for the same reasoning).
	owner *Peer
	// audioLevelExtID is the negotiated RTP header extension ID for
	// ssrc-audio-level (RFC 6464, decision #9) on this track, or 0 if the
	// client didn't negotiate it. Only meaningful for kind == audio.
	audioLevelExtID uint8

	mu          sync.RWMutex
	subscribers map[int]*webrtc.TrackLocalStaticRTP // subscriber userID -> track to write into

	keyframeMu     sync.RWMutex
	lastKeyframeAt time.Time
}

func newPublishedTrack(userID int, source Source, remote *webrtc.TrackRemote, owner *Peer, audioLevelExtID uint8) *publishedTrack {
	return &publishedTrack{
		userID:          userID,
		source:          source,
		kind:            remote.Kind(),
		remote:          remote,
		owner:           owner,
		audioLevelExtID: audioLevelExtID,
		subscribers:     make(map[int]*webrtc.TrackLocalStaticRTP),
	}
}

func (t *publishedTrack) addSubscriber(userID int, local *webrtc.TrackLocalStaticRTP) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.subscribers[userID] = local
}

func (t *publishedTrack) removeSubscriber(userID int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.subscribers, userID)
}

// subscriberUserIDs is used when this track's publisher goes away (see
// doClose in peer.go): every subscriber needs to be told to tear its side
// of the subscription down too, since nothing else ever reaches into
// another peer's pc/subs otherwise.
func (t *publishedTrack) subscriberUserIDs() []int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	ids := make([]int, 0, len(t.subscribers))
	for id := range t.subscribers {
		ids = append(ids, id)
	}
	return ids
}

// forward reads RTP from the remote track and fans it out to every current
// subscriber's local track, for the lifetime of the published track. Runs in
// its own goroutine (started by Peer's OnTrack handling in peer.go).
//
// recover() here is load-bearing, not defensive boilerplate (see
// sfu-migration-plan.md §8 pitfall #5): this loop processes attacker- or
// bug-reachable RTP straight from the network, and the SFU is a monolith
// sharing a process with chat (decision #2) — an unrecovered panic here
// takes the whole server down, not just this one call.
func (t *publishedTrack) forward(log *slog.Logger) {
	defer func() {
		if r := recover(); r != nil {
			log.Error("sfu: panic in RTP forward loop", "user_id", t.userID, "source", t.source, "panic", r)
		}
	}()

	isVideo := t.kind == webrtc.RTPCodecTypeVideo
	// Active-speaker detection (decision #9) is scoped to mic audio only —
	// screen_audio shouldn't make someone look like they're "speaking".
	tracksAudioLevel := t.source == SourceMic && t.audioLevelExtID != 0

	for {
		packet, _, err := t.remote.ReadRTP()
		if err != nil {
			// Track ended: publisher's connection closed or the transport
			// tore down. Either way there is nothing left to forward.
			return
		}

		if isVideo && isVP8Keyframe(packet.Payload) {
			t.markKeyframe()
		}
		if tracksAudioLevel {
			if data := packet.Header.GetExtension(t.audioLevelExtID); len(data) >= 1 {
				level := data[0] & 0x7F // RFC 6464: 0 = loudest, 127 = silence
				if level < audioLevelSpeakingThreshold {
					t.owner.room.speakers.markLoud(t.userID)
				}
			}
		}

		t.mu.RLock()
		for _, local := range t.subscribers {
			// Best-effort: one subscriber's write failing (e.g. their
			// PeerConnection just closed) must not stop forwarding to the
			// rest of the room.
			_ = local.WriteRTP(packet)
		}
		t.mu.RUnlock()
	}
}

func (t *publishedTrack) markKeyframe() {
	t.keyframeMu.Lock()
	t.lastKeyframeAt = time.Now()
	t.keyframeMu.Unlock()
}

func (t *publishedTrack) hasKeyframeSince(since time.Time) bool {
	t.keyframeMu.RLock()
	defer t.keyframeMu.RUnlock()
	return t.lastKeyframeAt.After(since)
}

// requestKeyframe sends PLI to the publisher. Called whenever a new
// subscriber attaches (sfu-migration-plan.md §7 phase 2, §8 pitfall #3): a
// subscriber that joins between keyframes decodes nothing until the next
// one arrives, which without this can be several seconds away.
func (t *publishedTrack) requestKeyframe() {
	if t.kind != webrtc.RTPCodecTypeVideo {
		return
	}
	_ = t.owner.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(t.remote.SSRC())}})
}

// requestKeyframeWithRetry sends PLI immediately and, if no keyframe has
// been observed 1.5s later, sends it once more — PLI travels over UDP with
// no delivery guarantee, and a lost PLI otherwise leaves a new subscriber
// stuck on a black frame with no further recovery attempt.
func (t *publishedTrack) requestKeyframeWithRetry() {
	if t.kind != webrtc.RTPCodecTypeVideo {
		return
	}
	requestedAt := time.Now()
	t.requestKeyframe()
	time.AfterFunc(1500*time.Millisecond, func() {
		if !t.hasKeyframeSince(requestedAt) {
			t.requestKeyframe()
		}
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
