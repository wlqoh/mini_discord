// Package auth implements password hashing, JWT issuance/validation, and
// email-verification token generation.
package auth

import (
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// UserClaims is the JWT claims payload used for both access and refresh
// tokens.
type UserClaims struct {
	UserID int `json:"user_id"`
	jwt.RegisteredClaims
}

// NewUserClaims builds UserClaims for userID with a random JWT ID, expiring
// after duration.
func NewUserClaims(userID int, duration time.Duration) (*UserClaims, error) {
	tokenID, err := uuid.NewRandom()
	if err != nil {
		return nil, fmt.Errorf("new user claims: %w", err)
	}

	return &UserClaims{
		UserID: userID,
		RegisteredClaims: jwt.RegisteredClaims{
			ID:        tokenID.String(),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(duration)),
		},
	}, nil
}
