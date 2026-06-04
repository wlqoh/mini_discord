package middleware

import (
	"log/slog"
	"runtime/debug"

	"github.com/gofiber/fiber/v2"
)

func Recovery(log *slog.Logger) fiber.Handler {
	return func(c *fiber.Ctx) (err error) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Error("panic recovered",
					"panic", rec,
					"method", c.Method(),
					"path", c.Path(),
					"stack", string(debug.Stack()),
				)
				err = fiber.NewError(fiber.StatusInternalServerError, "internal server error")
			}
		}()
		return c.Next()
	}
}
