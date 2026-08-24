// Package server implements the real-time chat hub: the WebSocket endpoint,
// the wire-protocol command dispatch, and the glue between chat, voice and
// the SFU.
//
// Hub.Run is a single goroutine that owns all hub state (clients, voice
// membership, rate limiters, pending attachments) and processes everything
// serially by selecting over the Register/Unregister/Commands channels. Any
// code running off that goroutine — SFU callbacks, embed-fetch workers,
// push delivery — may only read hub state, and only through h.mu; Run
// itself must never block on I/O; a network call is handed to a worker pool
// and its result delivered back later as its own WebSocket event (e.g.
// message_embeds).
//
// There is one Client per user (clientsByUser): a second WebSocket
// connection for the same user evicts the first. Each Client has a writer
// goroutine draining Outbound and pinging every pingPeriod, which must stay
// comfortably below a fronting proxy's idle-connection timeout (nginx
// defaults to 60s) or an idle voice call gets silently dropped.
//
// Attachments flow REST → memory → command: a file is uploaded over
// POST /upload, held as a PendingAttachment (StorePendingAttachment), and
// only persisted alongside a message once a send_message command
// references its ID (TakePendingAttachment, which is one-shot).
//
// Voice/SFU integration lives entirely behind the sfu.Signaler and
// sfu.Authorizer interfaces that Hub implements (SendOffer, SendAnswer,
// SendCandidate, SendTrackPublished, SendTrackPublishedTo,
// SendTrackUnpublished, SendActiveSpeakers, SendError,
// CanUserAccessChannel) — see internal/service/sfu's package doc for the
// isolation rationale. Voice membership (voiceParticipants,
// userVoiceChannel, voiceStatusByUser, sfuSessionByUser, sfuGraceTimers) is
// in-memory only; nothing about an in-progress call is persisted to
// storage.
package server
