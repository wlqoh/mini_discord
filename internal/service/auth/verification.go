package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

// GenerateVerificationToken returns a random token to email to the user and
// the hash of that token to persist. Only the hash is stored so a database
// leak does not expose usable verification links.
func GenerateVerificationToken() (rawToken string, tokenHash string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", fmt.Errorf("generate verification token: %w", err)
	}

	rawToken = hex.EncodeToString(b)
	return rawToken, HashVerificationToken(rawToken), nil
}

// HashVerificationToken hashes rawToken (sha256, hex-encoded) the same way
// GenerateVerificationToken does, so a token received back from a client
// can be looked up by its stored hash.
func HashVerificationToken(rawToken string) string {
	sum := sha256.Sum256([]byte(rawToken))
	return hex.EncodeToString(sum[:])
}
