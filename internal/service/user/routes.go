package user

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/gofiber/fiber/v2"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/service/auth"
	"github.com/wlqoh/mini_discord.git/types"
	"github.com/wlqoh/mini_discord.git/utils"
)

type Handler struct {
	storage types.UserStorage
	cfg     *config.Config
	log     *slog.Logger
}

type ErrorResponse struct {
    Error string `json:"error"`
}

func writeError(c *fiber.Ctx, status int, msg string) error {
    return c.Status(status).JSON(ErrorResponse{Error: msg})
}

func NewHandler(storage types.UserStorage, cfg *config.Config, log *slog.Logger) *Handler {
	return &Handler{storage: storage, cfg: cfg, log: log}
}

func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Post("/login", h.handleLogin)
	router.Post("/register", h.handleRegister)

	router.Route("/tokens", func(router fiber.Router) {
		router.Route("/renew", func(router fiber.Router) {
			router.Post("/", h.handleRenewAccessToken)
		})
	})
}

func (h *Handler) handleLogin(c *fiber.Ctx) error {
	const op = "service.user.handleLogin"

	var payload types.LoginUserRequest
	err := c.BodyParser(&payload)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return writeError(c, fiber.StatusBadRequest, "invalid request body")
	}

	if err := utils.Validate.Struct(payload); err != nil {
		h.log.Error(op, "error", err.Error())
		return writeError(c, fiber.StatusBadRequest, "invalid payload")
	}

	u, err := h.storage.GetUserByEmail(c.Context(), payload.Email)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return writeError(c, fiber.StatusUnauthorized, "invalid email or password")
	}

	if !auth.ComparePasswords(u.Password, []byte(payload.Password)) {
		return writeError(c, fiber.StatusUnauthorized, "invalid email or password")
	}

	secret := []byte(h.cfg.JWTSecret)
	accessToken, accessClaims, err := auth.CreateJWT(
		secret,
		u.ID,
		u.Email,
		u.FirstName,
		u.LastName,
		time.Minute*time.Duration(h.cfg.JWTAccessExpirationInMinutes),
	)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return writeError(c, fiber.StatusBadRequest, "auth error")
	}

	refreshToken, refreshClaims, err := auth.CreateJWT(
		secret,
		u.ID,
		u.Email,
		u.FirstName,
		u.LastName,
		time.Minute*time.Duration(h.cfg.JWTRefreshExpirationInMinutes),
	)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return writeError(c, fiber.StatusBadRequest, "auth error")
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

func (h *Handler) handleRegister(c *fiber.Ctx) error {
	const op = "service.user.handleRegister"

	var payload types.RegisterUserRequest

	err := c.BodyParser(&payload)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return writeError(c, fiber.StatusBadRequest, "invalid request body")
	}

	if err := utils.Validate.Struct(payload); err != nil {
		errors := err.(validator.ValidationErrors)
		h.log.Error(op, "error", err.Error())
		return writeError(c, fiber.StatusBadRequest, fmt.Sprintf("invalid payload: %v", errors))
	}

	_, err = h.storage.GetUserByEmail(c.Context(), payload.Email)
	if err == nil {
		return writeError(c, fiber.StatusBadRequest, "email already in use")
	}

	hashedPassword, err := auth.HashPassword(payload.Password)

	if err != nil {
		return writeError(c, fiber.StatusBadRequest, "failed to hash password")
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
		return writeError(c, fiber.StatusBadRequest, "failed to create user")
	}

	u, err := h.storage.GetUserByEmail(c.Context(), payload.Email)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return writeError(c, fiber.StatusUnauthorized, "invalid email or password")
	}

	if !auth.ComparePasswords(u.Password, []byte(payload.Password)) {
		return writeError(c, fiber.StatusUnauthorized, "invalid email or password")
	}

	secret := []byte(h.cfg.JWTSecret)
	accessToken, accessClaims, err := auth.CreateJWT(
		secret,
		u.ID,
		u.Email,
		u.FirstName,
		u.LastName,
		time.Minute*time.Duration(h.cfg.JWTAccessExpirationInMinutes),
	)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return writeError(c, fiber.StatusBadRequest, "auth error")
	}

	refreshToken, refreshClaims, err := auth.CreateJWT(
		secret,
		u.ID,
		u.Email,
		u.FirstName,
		u.LastName,
		time.Minute*time.Duration(h.cfg.JWTRefreshExpirationInMinutes),
	)
	if err != nil {
		h.log.Error(op, "error", err.Error())
		return writeError(c, fiber.StatusBadRequest, "auth error")
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
		 return writeError(c, fiber.StatusBadRequest, "error decoding request body")
	}

	refreshClaims, err := auth.ValidateToken(req.RefreshToken)
	if err != nil {
		h.log.Error(err.Error())
		return writeError(c, fiber.StatusUnauthorized, "error verifying token")
	}

	accessToken, accessClaims, err := auth.CreateJWT(
		[]byte(h.cfg.JWTSecret),
		refreshClaims.UserID,
		refreshClaims.Email,
		refreshClaims.FirstName,
		refreshClaims.LastName,
		time.Minute*time.Duration(h.cfg.JWTRefreshExpirationInMinutes),
	)
	if err != nil {
		h.log.Error(err.Error())
		return writeError(c, fiber.StatusInternalServerError, "error creating token")
	}

	res := types.RenewAccessTokenResponse{
		AccessToken:          accessToken,
		AccessTokenExpiresAt: accessClaims.RegisteredClaims.ExpiresAt.Time,
	}

	return c.Status(fiber.StatusOK).JSON(res)
}
