package types

import "time"

// TurnCredentialsResponse is the REST response for minting short-lived TURN
// credentials, returned to the client for use as an ICE server.
type TurnCredentialsResponse struct {
	URLs       []string  `json:"urls"`
	Username   string    `json:"username"`
	Credential string    `json:"credential"`
	TTLSeconds int       `json:"ttl_seconds"`
	ExpiresAt  time.Time `json:"expires_at"`
}

// VoiceDiagnostics is the "voice" section of the GET /api/v1/admin/sfu/rooms
// response (ghost-participants-plan.md §5, decision #10): a successful
// ghost-session cleanup looks like nothing happened, so without counters
// there's no way to tell "working" apart from "never triggered" from the
// outside.
type VoiceDiagnostics struct {
	// CloseCounts is keyed by why a voice session ended: ws_closed,
	// grace_expired, pc_failed, pc_closed, reconcile_hub,
	// reconcile_hub_dead_pc, reconcile_router, evicted.
	CloseCounts map[string]int64 `json:"close_counts"`
	// LastReconcileAt is the unix-millisecond timestamp of the most
	// recently completed sweep tick, or 0 if the sweep has never run (e.g.
	// SFU_RECONCILE_INTERVAL=0).
	LastReconcileAt int64 `json:"last_reconcile_at"`
	// LastReconcileRemoved is how many ghost/orphan sessions the most
	// recent sweep tick acted on.
	LastReconcileRemoved int64 `json:"last_reconcile_removed"`
}
