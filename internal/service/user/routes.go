package user

import (
	"fmt"
	"log/slog"

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

func NewHandler(storage types.UserStorage, cfg *config.Config, log *slog.Logger) *Handler {
	return &Handler{storage: storage, cfg: cfg, log: log}
}

func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Post("/login", h.handleLogin)
	router.Post("/register", h.handleRegister)
}

func (h *Handler) handleLogin(c *fiber.Ctx) error {
	const op = "service.user.handleLogin"

	var payload types.LoginUserPayload
	err := c.BodyParser(&payload)
	if err != nil {
		h.log.Error(op, err.Error())
		return c.Status(fiber.StatusBadRequest).SendString(err.Error())
	}

	if err := utils.Validate.Struct(payload); err != nil {
		h.log.Error(op, err.Error())
		return c.Status(fiber.StatusBadRequest).SendString(err.Error())
	}

	u, err := h.storage.GetUserByEmail(c.Context(), payload.Email)
	if err != nil {
		h.log.Error(op, err.Error())
		return c.Status(fiber.StatusUnauthorized).SendString("invalid email or password")
	}

	if !auth.ComparePasswords(u.Password, []byte(payload.Password)) {
		return c.Status(fiber.StatusUnauthorized).SendString("invalid email or password")
	}

	secret := []byte(h.cfg.JWTSecret)
	token, err := auth.CreateJWT(secret, u.ID)
	if err != nil {
		h.log.Error(op, err.Error())
		return c.Status(fiber.StatusBadRequest).SendString(fmt.Sprintf("auth error: %v", err))
	}

	return c.Status(fiber.StatusOK).JSON(fiber.Map{"token": token})
}

func (h *Handler) handleRegister(c *fiber.Ctx) error {
	const op = "service.user.handleRegister"

	var payload types.RegisterUserPayload

	err := c.BodyParser(&payload)
	if err != nil {
		h.log.Error(op, err.Error())
		return c.Status(fiber.StatusBadRequest).SendString(err.Error())
	}

	if err := utils.Validate.Struct(payload); err != nil {
		errors := err.(validator.ValidationErrors)
		h.log.Error(op, err.Error())
		return c.Status(fiber.StatusBadRequest).SendString(fmt.Sprintf("invalid payload %v", errors))
	}

	_, err = h.storage.GetUserByEmail(c.Context(), payload.Email)
	if err == nil {
		return c.Status(fiber.StatusBadRequest).SendString("email already in use")
	}

	hashedPassword, err := auth.HashPassword(payload.Password)

	if err != nil {
		return c.Status(fiber.StatusBadRequest).SendString(fmt.Sprintf("failed to hash password: %v", err))
	}

	err = h.storage.CreateUser(
		c.Context(), types.User{
			FirstName: payload.FirstName,
			LastName:  payload.LastName,
			Email:     payload.Email,
			Password:  hashedPassword,
		})
	if err != nil {
		h.log.Error(op, err.Error())
		return c.Status(fiber.StatusBadRequest).SendString(fmt.Sprintf("failed to create user: %v", err))
	}

	u, err := h.storage.GetUserByEmail(c.Context(), payload.Email)
	if err != nil {
		h.log.Error(op, err.Error())
		return c.Status(fiber.StatusUnauthorized).SendString("invalid email or password")
	}

	if !auth.ComparePasswords(u.Password, []byte(payload.Password)) {
		return c.Status(fiber.StatusUnauthorized).SendString("invalid email or password")
	}

	secret := []byte(h.cfg.JWTSecret)
	token, err := auth.CreateJWT(secret, u.ID)
	if err != nil {
		h.log.Error(op, err.Error())
		return c.Status(fiber.StatusBadRequest).SendString(fmt.Sprintf("auth error: %v", err))
	}

	return c.Status(fiber.StatusOK).JSON(fiber.Map{"token": token})
}
