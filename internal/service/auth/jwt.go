package auth

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/lib/logger/sl"
	"github.com/wlqoh/mini_discord.git/types"

	"github.com/golang-jwt/jwt/v5"
)

type UserReader interface {
	GetUserByID(ctx context.Context, id int) (*types.User, error)
}

func CreateJWT(secret []byte, userID int, email string, expiration time.Duration) (string, *UserClaims, error) {
	claims, err := NewUserClaims(userID, email, expiration)
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

func WithJWTAuth(userReader UserReader, log *slog.Logger, isWebsocket bool) fiber.Handler {

	return func(c *fiber.Ctx) error {
		// get the token from the user request
		tokenString := getTokenFromRequest(c, isWebsocket)
		if tokenString == "" {
			return permissionDenied(c)
		}

		claims, err := ValidateToken(tokenString)
		if err != nil {
			log.Error("failed to validate token", sl.Err(err))
			return permissionDenied(c)
		}

		if claims.UserID <= 0 {
			log.Info("invalid token claims")
			return permissionDenied(c)
		}

		u, err := userReader.GetUserByID(c.Context(), claims.UserID)
		if err != nil {
			log.Error("failed to get user by id", sl.Err(err))
			return permissionDenied(c)
		}

		c.Locals("user_id", u.ID)
		return c.Next()
	}
}

func getTokenFromRequest(c *fiber.Ctx, isWebsocket bool) string {
	if isWebsocket {
		if cookieToken := strings.TrimSpace(c.Cookies("jwt")); cookieToken != "" {
			return cookieToken
		}

		if queryToken := strings.TrimSpace(c.Query("token")); queryToken != "" {
			return queryToken
		}

		return ""
	}

	authorization := strings.TrimSpace(c.Get("Authorization"))
	if authorization == "" {
		return ""
	}

	parts := strings.SplitN(authorization, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}

	return strings.TrimSpace(parts[1])
}

func ValidateToken(tokenString string) (*UserClaims, error) {
	cfg := config.MustLoad()
	token, err := jwt.ParseWithClaims(tokenString, &UserClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}

		return []byte(cfg.JWTSecret), nil
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

func permissionDenied(c *fiber.Ctx) error {
	return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "permission denied"})
}
