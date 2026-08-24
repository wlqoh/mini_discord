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
