package utils

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-playground/validator/v10"
	"github.com/gofiber/fiber/v2"
)

var Validate = validator.New()

func WriteJSON(w http.ResponseWriter, status int, v any) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	return json.NewEncoder(w).Encode(v)
}

type ErrorResponse struct {
	Error string `json:"error"`
}

func WriteError(c *fiber.Ctx, status int, msg string) error {
	return c.Status(status).JSON(ErrorResponse{Error: msg})
}

func Int64(s string) int64 {
	i, _ := strconv.ParseInt(s, 10, 64)
	return i
}

func PermissionDenied(c *fiber.Ctx) error {
	return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "permission denied"})
}
