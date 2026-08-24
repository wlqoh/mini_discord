package sfu

import "context"

// Signaler is how the Router reaches a client. Implemented by the hub,
// which forwards these onto the right WebSocket connection.
type Signaler interface {
	// SendOffer delivers a server-initiated SDP renegotiation offer to userID.
	SendOffer(userID int, sessionID string, sdp string)
	// SendAnswer delivers the server's SDP answer to a client-initiated offer.
	SendAnswer(userID int, sessionID string, sdp string)
	// SendCandidate delivers a server-gathered ICE candidate to userID.
	SendCandidate(userID int, sessionID string, c CandidateInit)
	// SendTrackPublished notifies every participant of channelID that t was
	// published.
	SendTrackPublished(channelID int64, t TrackInfo)
	// SendTrackPublishedTo delivers a track_published event to a single
	// user — the snapshot of already-published tracks handed to a peer that
	// just joined (see Peer.sendTrackSnapshot). channelID is needed because
	// the client filters events by it (see handleTrackPublished).
	SendTrackPublishedTo(userID int, channelID int64, t TrackInfo)
	// SendTrackUnpublished notifies every participant of channelID that t
	// was unpublished.
	SendTrackUnpublished(channelID int64, t TrackInfo)
	// SendActiveSpeakers notifies every participant of channelID of the
	// current set of active speakers.
	SendActiveSpeakers(channelID int64, userIDs []int)
	// SendError delivers an out-of-band error to userID, for signaling paths
	// (like sfu_candidate) that have no request/ack of their own to attach
	// an error response to.
	SendError(userID int, sessionID, code, message string)
}

// Authorizer checks channel access. Implemented by the hub on top of
// types.ServerStorage.CanUserAccessChannel.
type Authorizer interface {
	// CanUserAccessChannel reports whether userID may join the voice
	// channel channelID.
	CanUserAccessChannel(ctx context.Context, userID int, channelID int64) (bool, error)
}

// CloseReason describes why a session was torn down by the SFU itself
// rather than by an explicit leave_voice_channel — see SessionObserver
// (tmp/ghost-participants-plan.md §3 decision #4).
type CloseReason string

const (
	// CloseReasonPCFailed: PeerConnectionState reached failed — ICE/DTLS is
	// unrecoverable for this PC, the client has to build a new one.
	CloseReasonPCFailed CloseReason = "pc_failed"
	// CloseReasonPCClosed: the PC closed without the router initiating it
	// (Router.Leave/Close set Peer.stopped first and are exempted from this
	// notification — see peer.go's OnConnectionStateChange handler).
	CloseReasonPCClosed CloseReason = "pc_closed"
)

// SessionObserver receives session-lifecycle events the hub must react to
// (tmp/ghost-participants-plan.md §3 decision #3): deliberately separate
// from Signaler, which is "how the Router reaches a client" — this is
// "something happened to a session" and needs the hub to update voice
// membership state, not just relay a message to it. A nil observer (the
// default until Router.SetSessionObserver is called) means nobody is
// listening — fine for tests and any future embedding that doesn't need
// this.
type SessionObserver interface {
	// OnSessionClosed reports that sessionID (userID's session in
	// channelID) was torn down by the SFU on its own. Called from a
	// goroutine the Router spawns for this purpose — never from a Peer's
	// own command queue (see Router.notifySessionClosed).
	OnSessionClosed(userID int, sessionID string, channelID int64, reason CloseReason)
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

// Source* enumerates the four fixed publish slots (PublishSlots in
// router.go): one mic, one camera, one screen, and one screen-audio track
// per peer.
const (
	SourceMic         Source = "mic"
	SourceCamera      Source = "camera"
	SourceScreen      Source = "screen"
	SourceScreenAudio Source = "screen_audio"
)

// Quality is the subscription level a client can request for a video
// source — see sfu-migration-plan.md §8 (decision #8). Low and High select
// a simulcast layer (see simulcast.go); Off unsubscribes.
type Quality string

// Quality* enumerates the values of Quality.
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
