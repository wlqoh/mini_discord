package auth

import (
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// CreateJWT issues an HS256-signed JWT for userID, expiring after
// expiration, returning both the signed string and the claims it encodes.
func CreateJWT(secret []byte, userID int, expiration time.Duration) (string, *UserClaims, error) {
	claims, err := NewUserClaims(userID, expiration)
	if err != nil {
		return "", nil, err
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signedString, err := token.SignedString(secret)
	if err != nil {
		return "", nil, fmt.Errorf("error signed token: %w", err)
	}

	return signedString, claims, nil
}

// ValidateToken parses and verifies tokenString's HMAC signature against
// secret, rejecting any token not using an HMAC signing method, and returns
// its claims.
func ValidateToken(tokenString string, secret []byte) (*UserClaims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &UserClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}

		return secret, nil
	})
	if err != nil {
		return nil, fmt.Errorf("failed to parse token: %w", err)
	}

	claims, ok := token.Claims.(*UserClaims)
	if !ok {
		return nil, fmt.Errorf("failed to parse token claims")
	}
	return claims, nil
}
