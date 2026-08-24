// Package utils holds small, dependency-light helpers shared across
// handlers and the storage layer: request validation, error responses, and
// rebuilding S3 object URLs from stored keys.
package utils

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-playground/validator/v10"
	"github.com/gofiber/fiber/v2"
)

// Validate is the shared validator instance used to check `validate:"..."`
// struct tags on request DTOs.
var Validate = validator.New()

// WriteJSON writes v as a JSON response body with status, for the plain
// net/http handlers (Fiber handlers use WriteError/PermissionDenied
// instead).
func WriteJSON(w http.ResponseWriter, status int, v any) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	return json.NewEncoder(w).Encode(v)
}

// AvatarURLFromKey rebuilds a public URL from a stored S3 object key and
// S3HOST — despite the name, it is used for both avatar and message
// attachment keys (see internal/storage/postgresql). avatarKey already
// being a full http(s) URL is passed through unchanged; a bare key with no
// "/" is assumed to live under "avatars/". An empty S3HOST returns the key
// itself, and an empty avatarKey returns "".
func AvatarURLFromKey(avatarKey, S3HOST string) string {

	key := strings.TrimSpace(avatarKey)
	if key == "" {
		return ""
	}

	if strings.HasPrefix(key, "http://") || strings.HasPrefix(key, "https://") {
		return key
	}

	if S3HOST == "" {
		return key
	}

	if !strings.Contains(key, "/") {
		key = "avatars/" + key
	}

	base := strings.TrimRight(S3HOST, "/")
	trimmedKey := strings.TrimLeft(key, "/")
	return base + "/" + trimmedKey
}

// ErrorResponse is the JSON body WriteError and PermissionDenied write.
type ErrorResponse struct {
	Error string `json:"error"`
}

// WriteError writes msg as a JSON ErrorResponse with status.
func WriteError(c *fiber.Ctx, status int, msg string) error {
	return c.Status(status).JSON(ErrorResponse{Error: msg})
}

// Int64 parses s as a base-10 int64, returning 0 if s is not a valid
// integer.
func Int64(s string) int64 {
	i, _ := strconv.ParseInt(s, 10, 64)
	return i
}

// PermissionDenied writes a 403 Forbidden JSON error response.
func PermissionDenied(c *fiber.Ctx) error {
	return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"error": "permission denied"})
}
