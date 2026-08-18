package sfu

import "time"

// SnapshotDTO backs GET /api/v1/admin/sfu/rooms (sfu-migration-plan.md §7
// Phase 1, decision #12). SFU bugs tend to be silent — the connection looks
// fine and nothing errors, but one subscriber just never gets a track — so
// this exists to answer "what does the router think is happening right now"
// directly, instead of reconstructing it from logs.
type SnapshotDTO struct {
	Rooms []RoomSnapshot `json:"rooms"`
}

type RoomSnapshot struct {
	ChannelID int64          `json:"channel_id"`
	Peers     []PeerSnapshot `json:"peers"`
}

type PeerSnapshot struct {
	SessionID          string                 `json:"session_id"`
	UserID             int                    `json:"user_id"`
	ICEConnectionState string                 `json:"ice_connection_state"`
	ConnectionState    string                 `json:"connection_state"`
	SignalingState     string                 `json:"signaling_state"`
	Published          []TrackSnapshot        `json:"published"`
	Subscriptions      []SubscriptionSnapshot `json:"subscriptions"`
}

type TrackSnapshot struct {
	Source Source `json:"source"`
	Kind   string `json:"kind"`
	// Layers lists the simulcast RIDs currently publishing (migration phase
	// 6) — a single empty-string entry for a non-simulcast source.
	Layers []string `json:"layers,omitempty"`
}

type SubscriptionSnapshot struct {
	PublisherUserID int    `json:"publisher_user_id"`
	Source          Source `json:"source"`
	// ActiveLayer/PendingLayer are the simulcast RID this subscription is
	// currently receiving vs. waiting to switch to on the next keyframe
	// (migration phase 6) — always "" for a non-simulcast source.
	ActiveLayer  string `json:"active_layer,omitempty"`
	PendingLayer string `json:"pending_layer,omitempty"`
}

func (r *Router) Snapshot() SnapshotDTO {
	r.mu.RLock()
	rooms := make([]*Room, 0, len(r.rooms))
	for _, room := range r.rooms {
		rooms = append(rooms, room)
	}
	r.mu.RUnlock()

	out := SnapshotDTO{Rooms: make([]RoomSnapshot, 0, len(rooms))}
	for _, room := range rooms {
		peers := room.snapshot()
		rs := RoomSnapshot{ChannelID: room.channelID, Peers: make([]PeerSnapshot, 0, len(peers))}
		for _, p := range peers {
			rs.Peers = append(rs.Peers, p.snapshot())
		}
		out.Rooms = append(out.Rooms, rs)
	}
	return out
}

// snapshot reads subs by round-tripping through the peer's own command
// queue (it's run()-only state — see Peer's type doc), bounded by a timeout
// so a stuck peer can never hang the debug endpoint: this is an operational
// tool, and it must stay usable precisely when something else is already
// broken.
func (p *Peer) snapshot() PeerSnapshot {
	subsCh := make(chan []SubscriptionSnapshot, 1)
	p.enqueue(func() {
		subs := make([]SubscriptionSnapshot, 0, len(p.subs))
		for _, sub := range p.subs {
			active, pending := sub.pub.subscriberLayerState(p.userID)
			subs = append(subs, SubscriptionSnapshot{
				PublisherUserID: sub.pub.userID,
				Source:          sub.pub.source,
				ActiveLayer:     active,
				PendingLayer:    pending,
			})
		}
		subsCh <- subs
	})

	var subs []SubscriptionSnapshot
	select {
	case subs = <-subsCh:
	case <-time.After(2 * time.Second):
	}

	p.publishedMu.RLock()
	published := make([]TrackSnapshot, 0, len(p.published))
	for source, pub := range p.published {
		published = append(published, TrackSnapshot{Source: source, Kind: kindString(pub.kind), Layers: pub.layerRIDs()})
	}
	p.publishedMu.RUnlock()

	return PeerSnapshot{
		SessionID:          p.sessionID,
		UserID:             p.userID,
		ICEConnectionState: p.pc.ICEConnectionState().String(),
		ConnectionState:    p.pc.ConnectionState().String(),
		SignalingState:     p.pc.SignalingState().String(),
		Published:          published,
		Subscriptions:      subs,
	}
}
