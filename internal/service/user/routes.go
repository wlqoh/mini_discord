package user

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/lib/ratelimit"
	"github.com/wlqoh/mini_discord.git/internal/service/auth"
	"github.com/wlqoh/mini_discord.git/types"
	"github.com/wlqoh/mini_discord.git/utils"
)

type Handler struct {
	storage  types.UserStorage
	cfg      *config.Config
	log      *slog.Logger
	s3Client types.S3ClientStorage
}

func NewHandler(storage types.UserStorage, cfg *config.Config, log *slog.Logger, s3Client types.S3ClientStorage) *Handler {
	return &Handler{storage: storage, cfg: cfg, log: log, s3Client: s3Client}
}

func (h *Handler) RegisterRoutes(router fiber.Router) {
	limiter := ratelimit.NewTokenBucket(5.0/60.0, 5)
	limiterMW := limiter.FiberRateLimitMiddleware()
	router.Get("/getAvatar", auth.WithJWTAuth(h.storage, h.log, false), h.handleGetImage)
	router.Post("/setAvatar", auth.WithJWTAuth(h.storage, h.log, false), h.handleSetImage)
	router.Post("/login", limiterMW, h.handleLogin)
	router.Post("/register", limiterMW, h.handleRegister)
	router.Delete("/deleteUser", limiterMW, auth.WithJWTAuth(h.storage, h.log, false), h.handleDeleteUser)

	router.Route("/tokens", func(router fiber.Router) {
		router.Post("/renew", limiterMW, h.handleRenewAccessToken)
	})
}

func (h *Handler) handleSetImage(c *fiber.Ctx) error {
	const op = "service.user.handleSetImage"
	const maxAvatarSizeBytes int64 = 1 * 1024 * 1024

	rawUserID := c.Locals("user_id")
	clientID, ok := rawUserID.(int)

	if !ok || clientID <= 0 {
		return utils.PermissionDenied(c)
	}

	file, err := c.FormFile("avatar")
	if err != nil {
		return utils.WriteError(c, fiber.StatusBadRequest, "avatar file is required")
	}

	if file.Size > maxAvatarSizeBytes {
		return utils.WriteError(c, fiber.StatusBadRequest, "avatar is too large (max 1MB)")
	}

	ext := strings.ToLower(filepath.Ext(file.Filename))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".webp":
	default:
		return utils.WriteError(c, fiber.StatusBadRequest, "unsupported avatar type")
	}

	src, err := file.Open()
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to open avatar")
	}
	defer func() {
		if closeErr := src.Close(); closeErr != nil {
			h.log.Error(op, "error", closeErr.Error())
		}
	}()

	var url string

	raw, err := io.ReadAll(io.LimitReader(src, maxAvatarSizeBytes+1))
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to read avatar")
	}

	if int64(len(raw)) > maxAvatarSizeBytes {
		return utils.WriteError(c, fiber.StatusBadRequest, "avatar is too large (max 1MB)")
	}

	contentType := http.DetectContentType(raw)
	switch contentType {
	case "image/png", "image/jpeg", "image/webp":
	default:
		return utils.WriteError(c, fiber.StatusBadRequest, "unsupported avatar content type")
	}

	user, err := h.storage.GetUserByID(c.Context(), clientID)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusUnauthorized, "can't get user")
	}

	avatarKey := user.AvatarKey
	if avatarKey == "" {
		avatarKey = uuid.NewString()
		url, err = h.s3Client.PutAvatar(c.Context(), avatarKey, raw, file.Filename)
		if err != nil {
			h.log.Error(op, "error", err.Error())
			return utils.WriteError(c, fiber.StatusInternalServerError, "failed to upload avatar")
		}
		err = h.storage.SaveUserAvatar(c.Context(), clientID, avatarKey)
		if err != nil {
			h.log.Error(op, "error", err.Error())
			return utils.WriteError(c, fiber.StatusBadRequest, err.Error())
		}
	} else {
		url, err = h.s3Client.PutAvatar(c.Context(), avatarKey, raw, file.Filename)
		if err != nil {
			h.log.Error(op, "error", err.Error())
			return utils.WriteError(c, fiber.StatusInternalServerError, "failed to upload avatar")
		}
	}

	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"url": url,
	})
}

func (h *Handler) handleGetImage(c *fiber.Ctx) error {
	const op = "service.user.handleGetImage"

	rawUserID := c.Locals("user_id")
	clientID, ok := rawUserID.(int)

	if !ok || clientID <= 0 {
		return utils.PermissionDenied(c)
	}

	user, err := h.storage.GetUserByID(c.Context(), clientID)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusBadRequest, "can't get user")
	}

	if user.AvatarKey == "" {
		return utils.WriteError(c, fiber.StatusBadRequest, "user has no avatar")
	}

	return c.Status(fiber.StatusOK).JSON(fiber.Map{
		"url": utils.AvatarURLFromKey(user.AvatarKey, h.cfg.S3HOST),
	})
}

func (h *Handler) handleLogin(c *fiber.Ctx) error {
	const op = "service.user.handleLogin"

	var payload types.LoginUserRequest
	err := c.BodyParser(&payload)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid request body")
	}

	if err := utils.Validate.Struct(payload); err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid payload")
	}

	u, err := h.storage.GetUserByEmail(c.Context(), payload.Email)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusUnauthorized, "invalid email or password")
	}

	if !auth.ComparePasswords(u.Password, []byte(payload.Password)) {
		return utils.WriteError(c, fiber.StatusUnauthorized, "invalid email or password")
	}

	secret := []byte(h.cfg.JWTSecret)
	accessToken, accessClaims, err := auth.CreateJWT(
		secret,
		u.ID,
		time.Minute*time.Duration(h.cfg.JWTAccessExpirationInMinutes),
	)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusBadRequest, "auth error")
	}

	refreshToken, refreshClaims, err := auth.CreateJWT(
		secret,
		u.ID,
		time.Minute*time.Duration(h.cfg.JWTRefreshExpirationInMinutes),
	)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusBadRequest, "auth error")
	}

	res := types.LoginUserResponse{
		AccessToken:           accessToken,
		RefreshToken:          refreshToken,
		AccessTokenExpiresAt:  accessClaims.RegisteredClaims.ExpiresAt.Time,
		RefreshTokenExpiresAt: refreshClaims.RegisteredClaims.ExpiresAt.Time,
		User: types.UserResponse{
			FirstName: u.FirstName,
			LastName:  u.LastName,
			AvatarURL: utils.AvatarURLFromKey(u.AvatarKey, h.cfg.S3HOST),
			Email:     u.Email,
		},
	}

	return c.Status(fiber.StatusOK).JSON(res)
}

func (h *Handler) handleDeleteUser(c *fiber.Ctx) error {
	const op = "service.user.handleDeleteUser"

	rawUserID := c.Locals("user_id")
	clientID, ok := rawUserID.(int)

	if !ok || clientID <= 0 {
		return utils.PermissionDenied(c)
	}

	err := h.storage.DeleteUser(c.Context(), clientID)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to delete user")
	}

	return c.Status(fiber.StatusOK).JSON(fiber.Map{})
}

func (h *Handler) handleRegister(c *fiber.Ctx) error {
	const op = "service.user.handleRegister"

	var payload types.RegisterUserRequest

	err := c.BodyParser(&payload)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid request body")
	}

	if err := utils.Validate.Struct(payload); err != nil {
		errors := err.(validator.ValidationErrors)
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusBadRequest, fmt.Sprintf("invalid payload: %v", errors))
	}

	_, err = h.storage.GetUserByEmail(c.Context(), payload.Email)
	if err == nil {
		return utils.WriteError(c, fiber.StatusBadRequest, "email already in use")
	}

	hashedPassword, err := auth.HashPassword(payload.Password)

	if err != nil {
		return utils.WriteError(c, fiber.StatusBadRequest, "failed to hash password")
	}

	err = h.storage.CreateUser(
		c.Context(), types.User{
			FirstName: payload.FirstName,
			LastName:  payload.LastName,
			Email:     payload.Email,
			Password:  hashedPassword,
		})
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusBadRequest, "failed to create user")
	}

	u, err := h.storage.GetUserByEmail(c.Context(), payload.Email)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusUnauthorized, "invalid email or password")
	}

	if !auth.ComparePasswords(u.Password, []byte(payload.Password)) {
		return utils.WriteError(c, fiber.StatusUnauthorized, "invalid email or password")
	}

	secret := []byte(h.cfg.JWTSecret)
	accessToken, accessClaims, err := auth.CreateJWT(
		secret,
		u.ID,
		time.Minute*time.Duration(h.cfg.JWTAccessExpirationInMinutes),
	)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusBadRequest, "auth error")
	}

	refreshToken, refreshClaims, err := auth.CreateJWT(
		secret,
		u.ID,
		time.Minute*time.Duration(h.cfg.JWTRefreshExpirationInMinutes),
	)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusBadRequest, "auth error")
	}

	res := types.LoginUserResponse{
		AccessToken:           accessToken,
		RefreshToken:          refreshToken,
		AccessTokenExpiresAt:  accessClaims.RegisteredClaims.ExpiresAt.Time,
		RefreshTokenExpiresAt: refreshClaims.RegisteredClaims.ExpiresAt.Time,
		User: types.UserResponse{
			FirstName: u.FirstName,
			LastName:  u.LastName,
			Email:     u.Email,
		},
	}

	return c.Status(fiber.StatusOK).JSON(res)
}

func (h *Handler) handleRenewAccessToken(c *fiber.Ctx) error {
	var req types.RenewAccessTokenRequest
	if err := c.BodyParser(&req); err != nil {
		h.log.Error(err.Error())
		return utils.WriteError(c, fiber.StatusBadRequest, "error decoding request body")
	}

	refreshClaims, err := auth.ValidateToken(req.RefreshToken)
	if err != nil {
		h.log.Error(err.Error())
		return utils.WriteError(c, fiber.StatusUnauthorized, "error verifying token")
	}

	accessToken, accessClaims, err := auth.CreateJWT(
		[]byte(h.cfg.JWTSecret),
		refreshClaims.UserID,
		time.Minute*time.Duration(h.cfg.JWTRefreshExpirationInMinutes),
	)
	if err != nil {
		h.log.Error(err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "error creating token")
	}

	res := types.RenewAccessTokenResponse{
		AccessToken:          accessToken,
		AccessTokenExpiresAt: accessClaims.RegisteredClaims.ExpiresAt.Time,
	}

	return c.Status(fiber.StatusOK).JSON(res)
}

func (h *Handler) turnURLs() []string {
	if len(h.cfg.WebRTC.TurnURLs) == 0 {
		return nil
	}

	urls := make([]string, 0, len(h.cfg.WebRTC.TurnURLs))
	for _, rawURL := range h.cfg.WebRTC.TurnURLs {
		url := strings.TrimSpace(rawURL)
		if url == "" {
			continue
		}
		urls = append(urls, url)
	}

	return urls
}
