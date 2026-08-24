package middleware

import (
	"log/slog"
	"runtime/debug"

	"github.com/gofiber/fiber/v2"
)

// Recovery returns Fiber middleware that recovers a panic from a
// downstream handler, logs it with a stack trace, and turns it into a 500
// response instead of crashing the process.
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
