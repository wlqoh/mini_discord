package sfu

import (
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	// activeSpeakerHoldDuration: lights up the moment a loud packet arrives,
	// fades out only after this much silence — long enough that a normal
	// pause mid-sentence doesn't flicker the indicator off
	// (sfu-migration-plan.md §3 decision #9).
	activeSpeakerHoldDuration = 400 * time.Millisecond
	// activeSpeakerTickInterval bounds the broadcast rate to the plan's "не
	// чаще 5 раз в секунду" (≤5/sec).
	activeSpeakerTickInterval = 200 * time.Millisecond

	// audioLevelSpeakingThreshold is a level in RFC 6464's -dBov scale
	// (0 = loudest possible, 127 = silence) below which a packet counts as
	// "this person is talking". A heuristic, not a calibrated value — 60
	// corresponds to roughly -60 dBov, comfortably below typical background
	// noise (90-127) and within typical speech levels (20-60) as reported by
	// Chrome/Firefox's own VAD-derived level.
	audioLevelSpeakingThreshold = 60
)

// activeSpeakers tracks which users in a room are currently talking, with
// hysteresis (see activeSpeakerHoldDuration) so a single loud packet or a
// short pause doesn't flicker the indicator. One instance per Room, fed by
// every mic publishedTrack's forward() loop and swept on a timer by the
// Room's own goroutine (see runActiveSpeakerLoop in room.go) — sweep() is
// cheap and side-effect-free, so the caller decides when/how often to call
// it and what to do with a change.
type activeSpeakers struct {
	mu         sync.Mutex
	lastLoudAt map[int]time.Time
	current    map[int]bool
}

func newActiveSpeakers() *activeSpeakers {
	return &activeSpeakers{
		lastLoudAt: make(map[int]time.Time),
		current:    make(map[int]bool),
	}
}

// markLoud records that userID's mic produced an above-threshold packet
// just now. Called directly from the RTP forward loop (sfu-migration-
// plan.md §8 — the same goroutine that already reads every packet), so it
// has to be cheap: one lock, one map write, no allocation.
func (a *activeSpeakers) markLoud(userID int) {
	a.mu.Lock()
	a.lastLoudAt[userID] = time.Now()
	a.mu.Unlock()
}

// removeUser drops a departed peer immediately rather than waiting for
// their last-loud timestamp to age out — otherwise someone who leaves
// mid-sentence would keep showing as speaking for another 400ms.
func (a *activeSpeakers) removeUser(userID int) {
	a.mu.Lock()
	// Deliberately only touches lastLoudAt, not current: current is
	// sweep()'s record of what it last REPORTED, and mutating it here would
	// make the next sweep() see no difference from what it's about to
	// compute — silently swallowing the "no longer speaking" broadcast this
	// removal should trigger.
	delete(a.lastLoudAt, userID)
	a.mu.Unlock()
}

// sweep recomputes the active set from lastLoudAt and reports it only if it
// changed since the previous sweep — the caller broadcasts on change, never
// on every tick, per the plan's "только при изменении состава".
func (a *activeSpeakers) sweep() (userIDs []int, changed bool) {
	now := time.Now()

	a.mu.Lock()
	defer a.mu.Unlock()

	next := make(map[int]bool, len(a.lastLoudAt))
	for userID, at := range a.lastLoudAt {
		if now.Sub(at) < activeSpeakerHoldDuration {
			next[userID] = true
		}
	}

	changed = len(next) != len(a.current)
	if !changed {
		for id := range next {
			if !a.current[id] {
				changed = true
				break
			}
		}
	}

	a.current = next
	if !changed {
		return nil, false
	}

	ids := make([]int, 0, len(next))
	for id := range next {
		ids = append(ids, id)
	}
	return ids, true
}

// audioLevelExtensionID finds the negotiated RTP header extension ID for
// urn:ietf:params:rtp-hdrext:ssrc-audio-level (RFC 6464) on a receiver, or 0
// if the client didn't negotiate it (e.g. an old/unusual client — forward()
// just skips level parsing in that case, no active-speaker data for them).
func audioLevelExtensionID(receiver *webrtc.RTPReceiver) uint8 {
	for _, ext := range receiver.GetParameters().HeaderExtensions {
		if ext.URI == "urn:ietf:params:rtp-hdrext:ssrc-audio-level" {
			return uint8(ext.ID)
		}
	}
	return 0
}
