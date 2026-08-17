package sfu

import (
	"sync"
	"time"
)

// Room is pure bookkeeping — which peers are in a channel — so Peer.OnTrack
// and subscribeToTrack know who else to notify/subscribe. It holds no media
// state itself; that lives on the individual Peers and their publishedTracks.
// The one exception is speakers: active-speaker detection (decision #9) is
// necessarily room-scoped (it's "who's talking in this room", not per-peer
// state), so it lives here alongside membership.
type Room struct {
	channelID int64
	sig       Signaler

	mu    sync.RWMutex
	peers map[int]*Peer // userID -> Peer

	speakers *activeSpeakers
	stopCh   chan struct{}
}

func newRoom(channelID int64, sig Signaler) *Room {
	r := &Room{
		channelID: channelID,
		sig:       sig,
		peers:     make(map[int]*Peer),
		speakers:  newActiveSpeakers(),
		stopCh:    make(chan struct{}),
	}
	go r.runActiveSpeakerLoop()
	return r
}

// runActiveSpeakerLoop sweeps the active-speaker set on a fixed interval and
// broadcasts only when it changed (sfu-migration-plan.md §3 decision #9:
// "не чаще 5 раз в секунду и только при изменении состава"). Exits once the
// room is torn down (see close, called by Router when the room empties).
func (r *Room) runActiveSpeakerLoop() {
	ticker := time.NewTicker(activeSpeakerTickInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if ids, changed := r.speakers.sweep(); changed {
				r.sig.SendActiveSpeakers(r.channelID, ids)
			}
		case <-r.stopCh:
			return
		}
	}
}

// close stops the active-speaker loop. Called once by Router when the room
// becomes empty and is removed — never call this while peers might still be
// added (Router deletes from its rooms map first, under the same lock, so
// no new peer can join a room being closed).
func (r *Room) close() {
	close(r.stopCh)
}

func (r *Room) add(p *Peer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.peers[p.userID] = p
}

func (r *Room) remove(userID int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.peers, userID)
}

func (r *Room) peerByUserID(userID int) (*Peer, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.peers[userID]
	return p, ok
}

func (r *Room) isEmpty() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.peers) == 0
}

// others returns every peer in the room except the given user — used both to
// fan a new publisher's track out to everyone already present, and to
// auto-subscribe a newly joined peer to everything already published.
func (r *Room) others(exceptUserID int) []*Peer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Peer, 0, len(r.peers))
	for id, p := range r.peers {
		if id != exceptUserID {
			out = append(out, p)
		}
	}
	return out
}

func (r *Room) snapshot() []*Peer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*Peer, 0, len(r.peers))
	for _, p := range r.peers {
		out = append(out, p)
	}
	return out
}
