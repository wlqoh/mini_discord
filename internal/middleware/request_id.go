package middleware

import (
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

const requestIDKey = "requestID"

// RequestID returns Fiber middleware that assigns each request an ID —
// reusing an incoming X-Request-Id header if present, otherwise generating
// a UUID — and stores it in c.Locals for IDFromLocals, and echoes it back
// on both the request and response X-Request-Id headers.
func RequestID() fiber.Handler {
	return func(c *fiber.Ctx) error {
		id := c.Get(fiber.HeaderXRequestID)
		if id == "" {
			id = uuid.NewString()
		}

		c.Locals(requestIDKey, id)
		c.Request().Header.Set(fiber.HeaderXRequestID, id)
		c.Set(fiber.HeaderXRequestID, id)

		return c.Next()
	}
}

// IDFromLocals returns the request ID RequestID stored for c, or "" if
// RequestID was not run on this request.
func IDFromLocals(c *fiber.Ctx) string {
	if val, ok := c.Locals(requestIDKey).(string); ok {
		return val
	}

	return ""
}
