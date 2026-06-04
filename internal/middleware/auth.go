package middleware

import (
	"context"
	"log/slog"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/wlqoh/mini_discord.git/internal/lib/logger/sl"
	"github.com/wlqoh/mini_discord.git/internal/service/auth"
	"github.com/wlqoh/mini_discord.git/types"
	"github.com/wlqoh/mini_discord.git/utils"
)

type UserReader interface {
	GetUserByID(ctx context.Context, id int) (*types.User, error)
}

func WithJWTAuth(userReader UserReader, log *slog.Logger, isWebsocket bool, secret []byte) fiber.Handler {

	return func(c *fiber.Ctx) error {
		// get the token from the user request
		tokenString := getTokenFromRequest(c, isWebsocket)
		if tokenString == "" {
			return utils.PermissionDenied(c)
		}

		claims, err := auth.ValidateToken(tokenString, secret)
		if err != nil {
			log.Error("failed to validate token", sl.Err(err))
			return utils.PermissionDenied(c)
		}

		if claims.UserID <= 0 {
			log.Info("invalid token claims")
			return utils.PermissionDenied(c)
		}

		u, err := userReader.GetUserByID(c.Context(), claims.UserID)
		if err != nil {
			log.Error("failed to get user by id", sl.Err(err))
			return utils.PermissionDenied(c)
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
