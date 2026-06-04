package auth

import (
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

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
