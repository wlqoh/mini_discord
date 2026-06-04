package middleware

import (
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

const requestIDKey = "requestID"

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

func IDFromLocals(c *fiber.Ctx) string {
	if val, ok := c.Locals(requestIDKey).(string); ok {
		return val
	}

	return ""
}
