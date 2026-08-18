// Package sfu implements the SFU (Selective Forwarding Unit) voice/video
// transport described in sfu-migration-plan.md. It is embedded in the same
// process as internal/service/server (decision #2 in that plan: a monolith,
// not a separate service) but MUST NOT import that package — all
// interaction happens through the Signaler/Authorizer interfaces below,
// which internal/service/server.Hub implements. This keeps the media code
// isolated: a panic inside an RTP-reading goroutine is recovered locally
// (see sfu-migration-plan.md §8 pitfall #5) instead of being able to import
// and directly corrupt hub state, and the package can be lifted into a
// separate binary later (§10 of the plan) by adding a transport, not by
// untangling imports.
//
// Phase 0 only establishes this boundary; Router is unimplemented until
// migration phase 1.
package sfu

import "context"

// Signaler is how the Router reaches a client. Implemented by the hub,
// which forwards these onto the right WebSocket connection.
type Signaler interface {
	SendOffer(userID int, sessionID string, sdp string)
	SendAnswer(userID int, sessionID string, sdp string)
	SendCandidate(userID int, sessionID string, c CandidateInit)
	SendTrackPublished(channelID int64, t TrackInfo)
	// SendTrackPublishedTo delivers a track_published event to a single
	// user — the snapshot of already-published tracks handed to a peer that
	// just joined (see Peer.sendTrackSnapshot). channelID is needed because
	// the client filters events by it (see handleTrackPublished).
	SendTrackPublishedTo(userID int, channelID int64, t TrackInfo)
	SendTrackUnpublished(channelID int64, t TrackInfo)
	SendActiveSpeakers(channelID int64, userIDs []int)
	SendError(userID int, sessionID, code, message string)
}

// Authorizer checks channel access. Implemented by the hub on top of
// types.ServerStorage.CanUserAccessChannel.
type Authorizer interface {
	CanUserAccessChannel(ctx context.Context, userID int, channelID int64) (bool, error)
}

// CandidateInit mirrors the wire shape of an ICE candidate (see
// types.WsSfuCandidatePayload) without importing the types package, keeping
// this package's public surface self-contained.
type CandidateInit struct {
	Candidate     string
	SDPMid        *string
	SDPMLineIndex *uint16
}

// Source identifies which of the fixed publish slots a track belongs to —
// see sfu-migration-plan.md §4.3.
type Source string

const (
	SourceMic         Source = "mic"
	SourceCamera      Source = "camera"
	SourceScreen      Source = "screen"
	SourceScreenAudio Source = "screen_audio"
)

// Quality is the subscription level a client can request for a video
// source — see sfu-migration-plan.md §8 (decision #8). Only Off is
// meaningful until simulcast lands in migration phase 6; Low and High are
// reserved so the wire protocol doesn't change when it does.
type Quality string

const (
	QualityOff  Quality = "off"
	QualityLow  Quality = "low"
	QualityHigh Quality = "high"
)

// TrackInfo describes a published track for track_published/unpublished
// notifications.
type TrackInfo struct {
	UserID int
	Source Source
	Kind   string // "audio" | "video"
}

// SlotDecl is the MID -> Source mapping a client declares in its initial
// offer (see sfu-migration-plan.md §4.3 / WsSfuSlotDecl).
type SlotDecl struct {
	MID    string
	Kind   string
	Source Source
}
