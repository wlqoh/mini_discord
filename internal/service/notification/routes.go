// Package notification is the REST handler for notification settings and
// Web Push subscription management.
package notification

import (
	"encoding/json"
	"log/slog"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/middleware"
	"github.com/wlqoh/mini_discord.git/types"
	"github.com/wlqoh/mini_discord.git/utils"
)

// Handler serves the /notifications/* and /push/* REST routes.
type Handler struct {
	storage types.NotificationStorage
	cfg     *config.Config
	log     *slog.Logger
}

// NewHandler builds a Handler.
func NewHandler(storage types.NotificationStorage, cfg *config.Config, log *slog.Logger) *Handler {
	return &Handler{storage: storage, cfg: cfg, log: log}
}

// RegisterRoutes mounts the notification-settings and push-subscription
// routes on router; all but GET /push/public-key require JWT auth.
func (h *Handler) RegisterRoutes(router fiber.Router) {
	secret := []byte(h.cfg.JWTSecret)
	auth := middleware.WithJWTAuth(h.storage, h.log, false, secret)
	limiter := middleware.NewTokenBucket(2.0, 10)
	limiterMW := limiter.FiberRateLimitMiddleware()

	router.Get("/notifications/settings", auth, h.handleGetSettings)
	router.Patch("/notifications/settings", limiterMW, auth, h.handlePatchGlobalSettings)
	router.Put("/notifications/settings/server/:id", limiterMW, auth, h.handlePutServerSetting)
	router.Put("/notifications/settings/channel/:id", limiterMW, auth, h.handlePutChannelSetting)

	router.Get("/push/public-key", h.handleGetPushPublicKey)
	router.Post("/push/subscribe", limiterMW, auth, h.handlePushSubscribe)
	router.Post("/push/unsubscribe", limiterMW, auth, h.handlePushUnsubscribe)
}

func (h *Handler) handleGetPushPublicKey(c *fiber.Ctx) error {
	if !h.cfg.Push.Enabled || h.cfg.Push.VAPIDPublic == "" {
		return utils.WriteError(c, fiber.StatusNotFound, "push is not enabled")
	}
	return c.JSON(fiber.Map{"key": h.cfg.Push.VAPIDPublic})
}

func (h *Handler) handlePushSubscribe(c *fiber.Ctx) error {
	if !h.cfg.Push.Enabled {
		return utils.WriteError(c, fiber.StatusNotFound, "push is not enabled")
	}

	userID, ok := userIDFromContext(c)
	if !ok {
		return utils.PermissionDenied(c)
	}

	var payload types.PushSubscribeRequest
	if err := json.Unmarshal(c.Body(), &payload); err != nil {
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid request body")
	}
	if payload.Endpoint == "" || payload.Keys.P256dh == "" || payload.Keys.Auth == "" {
		return utils.WriteError(c, fiber.StatusBadRequest, "endpoint and keys are required")
	}

	sub := types.PushSubscription{
		UserID:    userID,
		Endpoint:  payload.Endpoint,
		P256dh:    payload.Keys.P256dh,
		Auth:      payload.Keys.Auth,
		UserAgent: c.Get("User-Agent"),
	}

	if err := h.storage.UpsertPushSubscription(c.Context(), sub); err != nil {
		h.log.Error("failed to save push subscription", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to save push subscription")
	}

	return c.JSON(fiber.Map{"ok": true})
}

func (h *Handler) handlePushUnsubscribe(c *fiber.Ctx) error {
	if _, ok := userIDFromContext(c); !ok {
		return utils.PermissionDenied(c)
	}

	var payload types.PushUnsubscribeRequest
	if err := json.Unmarshal(c.Body(), &payload); err != nil {
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid request body")
	}
	if payload.Endpoint == "" {
		return utils.WriteError(c, fiber.StatusBadRequest, "endpoint is required")
	}

	if err := h.storage.DeletePushSubscriptionByEndpoint(c.Context(), payload.Endpoint); err != nil {
		h.log.Error("failed to delete push subscription", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to delete push subscription")
	}

	return c.JSON(fiber.Map{"ok": true})
}

func userIDFromContext(c *fiber.Ctx) (int, bool) {
	raw := c.Locals("user_id")
	id, ok := raw.(int)
	return id, ok && id > 0
}

func (h *Handler) handleGetSettings(c *fiber.Ctx) error {
	userID, ok := userIDFromContext(c)
	if !ok {
		return utils.PermissionDenied(c)
	}

	settings, err := h.storage.GetNotificationSettings(c.Context(), userID)
	if err != nil {
		h.log.Error("failed to load notification settings", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to load notification settings")
	}

	return c.JSON(settings)
}

// handlePatchGlobalSettings supports true partial updates: a field absent
// from the body is left untouched, while an explicit `null` for dnd_until
// clears it. Both are indistinguishable via a plain struct unmarshal, so the
// body is parsed as a raw map first to detect key presence.
func (h *Handler) handlePatchGlobalSettings(c *fiber.Ctx) error {
	userID, ok := userIDFromContext(c)
	if !ok {
		return utils.PermissionDenied(c)
	}

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(c.Body(), &raw); err != nil {
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid request body")
	}

	current, err := h.storage.GetNotificationSettings(c.Context(), userID)
	if err != nil {
		h.log.Error("failed to load notification settings", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to load notification settings")
	}

	defaultLevel := current.DefaultLevel
	if v, present := raw["default_level"]; present {
		var level string
		if err := json.Unmarshal(v, &level); err != nil || !types.IsValidNotificationLevel(level) {
			return utils.WriteError(c, fiber.StatusBadRequest, "invalid default_level")
		}
		defaultLevel = level
	}

	hidePreview := current.HideMessagePreview
	if v, present := raw["hide_message_preview"]; present {
		if err := json.Unmarshal(v, &hidePreview); err != nil {
			return utils.WriteError(c, fiber.StatusBadRequest, "invalid hide_message_preview")
		}
	}

	dndUntil := current.DNDUntil
	if v, present := raw["dnd_until"]; present {
		if string(v) == "null" {
			dndUntil = nil
		} else {
			var parsed time.Time
			if err := json.Unmarshal(v, &parsed); err != nil {
				return utils.WriteError(c, fiber.StatusBadRequest, "invalid dnd_until")
			}
			dndUntil = &parsed
		}
	}

	if err := h.storage.UpsertGlobalNotificationSettings(c.Context(), userID, defaultLevel, hidePreview, dndUntil); err != nil {
		h.log.Error("failed to update notification settings", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to update notification settings")
	}

	updated, err := h.storage.GetNotificationSettings(c.Context(), userID)
	if err != nil {
		h.log.Error("failed to reload notification settings", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to reload notification settings")
	}

	return c.JSON(updated)
}

func (h *Handler) handlePutServerSetting(c *fiber.Ctx) error {
	userID, ok := userIDFromContext(c)
	if !ok {
		return utils.PermissionDenied(c)
	}

	serverID := utils.Int64(c.Params("id"))
	if serverID <= 0 {
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid server id")
	}

	isMember, err := h.storage.IsServerMember(c.Context(), userID, serverID)
	if err != nil {
		h.log.Error("failed to check server membership", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to check server membership")
	}
	if !isMember {
		return utils.PermissionDenied(c)
	}

	var payload types.UpdateScopedNotificationSettingRequest
	if err := json.Unmarshal(c.Body(), &payload); err != nil {
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid request body")
	}
	if payload.Level != nil && !types.IsValidNotificationLevel(*payload.Level) {
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid level")
	}

	if err := h.storage.UpsertServerNotificationSetting(c.Context(), userID, serverID, payload.Level, payload.MutedUntil); err != nil {
		h.log.Error("failed to update server notification setting", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to update server notification setting")
	}

	updated, err := h.storage.GetNotificationSettings(c.Context(), userID)
	if err != nil {
		h.log.Error("failed to reload notification settings", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to reload notification settings")
	}

	return c.JSON(updated)
}

func (h *Handler) handlePutChannelSetting(c *fiber.Ctx) error {
	userID, ok := userIDFromContext(c)
	if !ok {
		return utils.PermissionDenied(c)
	}

	channelID := utils.Int64(c.Params("id"))
	if channelID <= 0 {
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid channel id")
	}

	canAccess, err := h.storage.CanUserAccessChannel(c.Context(), userID, channelID)
	if err != nil {
		h.log.Error("failed to check channel access", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to check channel access")
	}
	if !canAccess {
		return utils.PermissionDenied(c)
	}

	var payload types.UpdateScopedNotificationSettingRequest
	if err := json.Unmarshal(c.Body(), &payload); err != nil {
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid request body")
	}
	if payload.Level != nil && !types.IsValidNotificationLevel(*payload.Level) {
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid level")
	}

	if err := h.storage.UpsertChannelNotificationSetting(c.Context(), userID, channelID, payload.Level, payload.MutedUntil); err != nil {
		h.log.Error("failed to update channel notification setting", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to update channel notification setting")
	}

	updated, err := h.storage.GetNotificationSettings(c.Context(), userID)
	if err != nil {
		h.log.Error("failed to reload notification settings", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to reload notification settings")
	}

	return c.JSON(updated)
}
