package auth

import (
	"context"
	"discord_go/internal/config"
	"discord_go/internal/lib/logger/sl"
	"discord_go/types"
	"discord_go/utils"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type contextKey string

const UserKey contextKey = "user_id"

var cfg = config.MustLoad()

func CreateJWT(secret []byte, userID int) (string, error) {

	expiration := time.Second * time.Duration(cfg.JWTExpirationInSeconds)

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"user_id": userID,
		"exp":     time.Now().Add(expiration).Unix(),
	})

	tokenString, err := token.SignedString(secret)
	if err != nil {
		return "", err
	}

	return tokenString, nil
}

func WithJWTAuth(handleFunc http.HandlerFunc, store types.UserStore, log *slog.Logger) http.HandlerFunc {

	return func(w http.ResponseWriter, r *http.Request) {
		// get the token from the user request
		tokenString := getTokenFromRequest(r)
		// validate the token
		token, err := validateToken(tokenString)
		if err != nil {
			log.Error("failed to validate token", sl.Err(err))
			permissionDenied(w)
			return
		}

		if !token.Valid {
			log.Info("invalid token")
			permissionDenied(w)
			return
		}

		claims := token.Claims.(jwt.MapClaims)
		str, ok := claims["user_id"].(float64)
		if !ok {
			permissionDenied(w)
			return
		}

		userID := int(str)

		u, err := store.GetUserByID(userID)
		if err != nil {
			log.Error("failed to get user by id", sl.Err(err))
			permissionDenied(w)
			return
		}

		ctx := r.Context()
		ctx = context.WithValue(ctx, UserKey, u.ID)
		r = r.WithContext(ctx)

		handleFunc(w, r)
	}
}

func getTokenFromRequest(r *http.Request) string {
	return r.Header.Get("Authorization")
}

func validateToken(tokenString string) (*jwt.Token, error) {
	return jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}

		return []byte(cfg.JWTSecret), nil
	})
}

func permissionDenied(w http.ResponseWriter) {
	utils.WriteError(w, http.StatusForbidden, fmt.Errorf("permission denied"))
}
