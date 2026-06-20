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
	"github.com/wlqoh/mini_discord.git/internal/middleware"
	"github.com/wlqoh/mini_discord.git/internal/service/auth"
	"github.com/wlqoh/mini_discord.git/types"
	"github.com/wlqoh/mini_discord.git/utils"
)

type Handler struct {
	storage       types.UserStorage
	serverStorage types.ServerStorage
	pendingStore  types.PendingAttachmentStore
	cfg           *config.Config
	log           *slog.Logger
	s3Client      types.S3ClientStorage
}

func NewHandler(storage types.UserStorage, serverStorage types.ServerStorage, cfg *config.Config, log *slog.Logger, s3Client types.S3ClientStorage, pendingStore types.PendingAttachmentStore) *Handler {
	return &Handler{
		storage:       storage,
		serverStorage: serverStorage,
		pendingStore:  pendingStore,
		cfg:           cfg,
		log:           log,
		s3Client:      s3Client,
	}
}

func (h *Handler) RegisterRoutes(router fiber.Router) {
	limiter := middleware.NewTokenBucket(5.0/60.0, 5)
	limiterMW := limiter.FiberRateLimitMiddleware()
	uploadLimiter := middleware.NewTokenBucket(10.0/60.0, 5)
	uploadLimiterMW := uploadLimiter.FiberRateLimitMiddleware()
	secret := []byte(h.cfg.JWTSecret)
	router.Get("/getAvatar", middleware.WithJWTAuth(h.storage, h.log, false, secret), h.handleGetImage)
	router.Post("/setAvatar", middleware.WithJWTAuth(h.storage, h.log, false, secret), h.handleSetImage)
	router.Post("/upload", uploadLimiterMW, middleware.WithJWTAuth(h.storage, h.log, false, secret), h.handleUpload)
	router.Post("/login", limiterMW, h.handleLogin)
	router.Post("/register", limiterMW, h.handleRegister)
	router.Post("/updateUser", middleware.WithJWTAuth(h.storage, h.log, false, secret), h.handleUpdateUser)
	router.Delete("/deleteUser", limiterMW, middleware.WithJWTAuth(h.storage, h.log, false, secret), h.handleDeleteUser)

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
			Nickname:  u.Nickname,
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

func (h *Handler) handleUpdateUser(c *fiber.Ctx) error {
	const op = "service.user.handleUpdateUser"

	rawUserID := c.Locals("user_id")
	clientID, ok := rawUserID.(int)

	if !ok || clientID <= 0 {
		return utils.PermissionDenied(c)
	}

	var payload types.UpdateUserRequest

	err := c.BodyParser(&payload)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid request body")
	}

	if err := utils.Validate.Struct(payload); err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusBadRequest, "invalid payload")
	}

	err = h.storage.UpdateUser(c.Context(), clientID, types.UpdateUserRequest{
		FirstName: payload.FirstName,
		LastName:  payload.LastName,
		Nickname:  payload.Nickname,
	})

	if err != nil {
		h.log.Error(op, "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to update user")
	}

	c.Status(fiber.StatusOK)

	return nil
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
			Nickname:  payload.Nickname,
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

	res := types.UserResponse{
		FirstName: u.FirstName,
		LastName:  u.LastName,
		Nickname:  u.Nickname,
	}
	return c.Status(fiber.StatusOK).JSON(res)
}

func (h *Handler) handleRenewAccessToken(c *fiber.Ctx) error {
	var req types.RenewAccessTokenRequest
	if err := c.BodyParser(&req); err != nil {
		h.log.Error(err.Error())
		return utils.WriteError(c, fiber.StatusBadRequest, "error decoding request body")
	}

	refreshClaims, err := auth.ValidateToken(req.RefreshToken, []byte(h.cfg.JWTSecret))
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

func isAllowedMediaType(contentType string) bool {
	switch {
	case contentType == "image/jpeg",
		contentType == "image/png",
		contentType == "image/gif",
		contentType == "image/webp",
		contentType == "image/avif",
		contentType == "video/mp4",
		contentType == "video/webm",
		contentType == "video/quicktime",
		contentType == "audio/mpeg",
		contentType == "audio/ogg",
		contentType == "audio/wav",
		contentType == "audio/webm",
		contentType == "audio/mp4":
		return true
	default:
		return false
	}
}

func (h *Handler) handleUpload(c *fiber.Ctx) error {
	const maxUploadSizeBytes int64 = 10 * 1024 * 1024

	rawUserID := c.Locals("user_id")
	clientID, ok := rawUserID.(int)
	if !ok || clientID <= 0 {
		return utils.PermissionDenied(c)
	}

	file, err := c.FormFile("file")
	if err != nil {
		return utils.WriteError(c, fiber.StatusBadRequest, "file is required")
	}

	if file.Size > maxUploadSizeBytes {
		return utils.WriteError(c, fiber.StatusBadRequest, "file is too large (max 10MB)")
	}

	ext := strings.ToLower(filepath.Ext(file.Filename))
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif",
		".mp4", ".webm", ".mov",
		".mp3", ".ogg", ".wav", ".m4a":
	default:
		return utils.WriteError(c, fiber.StatusBadRequest, "unsupported file type")
	}

	src, err := file.Open()
	if err != nil {
		h.log.Error("upload: failed to open file", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to open file")
	}
	defer func() { _ = src.Close() }()

	raw, err := io.ReadAll(io.LimitReader(src, maxUploadSizeBytes+1))
	if err != nil {
		h.log.Error("upload: failed to read file", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to read file")
	}

	if int64(len(raw)) > maxUploadSizeBytes {
		return utils.WriteError(c, fiber.StatusBadRequest, "file is too large (max 10MB)")
	}

	contentType := http.DetectContentType(raw)
	if !isAllowedMediaType(contentType) {
		return utils.WriteError(c, fiber.StatusBadRequest, "unsupported content type: "+contentType)
	}

	folderKey, err := h.storage.GetOrCreateAttachmentFolderKey(c.Context(), clientID)
	if err != nil {
		h.log.Error("upload: failed to get user folder key", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to get user folder")
	}

	fileSuffix := uuid.NewString()[:8]
	url, err := h.s3Client.PutAttachment(c.Context(), folderKey, raw, file.Filename, contentType, fileSuffix)
	if err != nil {
		h.log.Error("upload: failed to upload to s3", "error", err.Error())
		return utils.WriteError(c, fiber.StatusInternalServerError, "failed to upload file")
	}

	s3Key := fmt.Sprintf("attachments/%s/%s_%s", folderKey, fileSuffix, file.Filename)
	pa := types.PendingAttachment{
		UserID:      clientID,
		FolderKey:   folderKey,
		FileKey:     s3Key,
		FileName:    file.Filename,
		ContentType: contentType,
		SizeBytes:   int64(len(raw)),
	}

	attachmentID := h.pendingStore.StorePendingAttachment(pa)

	return c.Status(fiber.StatusOK).JSON(types.UploadResponse{
		AttachmentID: attachmentID,
		URL:          url,
	})
}
