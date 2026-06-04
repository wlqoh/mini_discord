package middleware

import (
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
)

func Logger(log *slog.Logger) fiber.Handler {
	return func(c *fiber.Ctx) error {
		start := time.Now()
		err := c.Next()

		log.Info("http",
			"method", c.Method(),
			"path", c.Path(),
			"status", c.Response().StatusCode(),
			"duration_ms", time.Since(start).Milliseconds(),
			"request_id", IDFromLocals(c))

		return err
	}
}
