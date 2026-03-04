package user

import (
	"fmt"
	"net/http"

	"github.com/go-playground/validator/v10"
	"github.com/gofiber/fiber/v2"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/service/auth"
	"github.com/wlqoh/mini_discord.git/types"
	"github.com/wlqoh/mini_discord.git/utils"
)

type Handler struct {
	store types.UserStore
	cfg   *config.Config
}

func NewHandler(store types.UserStore, cfg *config.Config) *Handler {
	return &Handler{store: store, cfg: cfg}
}

func (h *Handler) RegisterRoutes(router fiber.Router) {
	router.Post("/login", h.handleLogin)
	router.Post("/register", h.handleRegister)
}

func (h *Handler) handleLogin(c *fiber.Ctx) error {
	var payload types.LoginUserPayload
	err := c.BodyParser(&payload)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).SendString(err.Error())
	}

	if err := utils.Validate.Struct(payload); err != nil {
		return c.Status(fiber.StatusBadRequest).SendString(err.Error())
	}

	u, err := h.store.GetUserByEmail(payload.Email)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).SendString("invalid email or password")
	}

	if !auth.ComparePasswords(u.Password, []byte(payload.Password)) {
		return c.Status(fiber.StatusUnauthorized).SendString("invalid email or password")
	}

	secret := []byte(h.cfg.JWTSecret)
	token, err := auth.CreateJWT(secret, u.ID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).SendString(fmt.Sprintf("auth error: %v", err))
	}

	c.Status(http.StatusOK)
	err = c.JSON(fiber.Map{"token": token})
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).SendString(fmt.Sprintf("failed to write response: %v", err))
	}

	return nil
}

func (h *Handler) handleRegister(c *fiber.Ctx) error {
	var payload types.RegisterUserPayload

	err := c.BodyParser(&payload)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).SendString(err.Error())
	}

	if err := utils.Validate.Struct(payload); err != nil {
		errors := err.(validator.ValidationErrors)
		return c.Status(fiber.StatusBadRequest).SendString(fmt.Sprintf("invalid payload %v", errors))
	}

	_, err = h.store.GetUserByEmail(payload.Email)
	if err == nil {
		return c.Status(fiber.StatusBadRequest).SendString("email already in use")
	}

	hashedPassword, err := auth.HashPassword(payload.Password)

	if err != nil {
		return c.Status(fiber.StatusBadRequest).SendString(fmt.Sprintf("failed to hash password: %v", err))
	}

	err = h.store.CreateUser(types.User{
		FirstName: payload.FirstName,
		LastName:  payload.LastName,
		Email:     payload.Email,
		Password:  hashedPassword,
	})
	if err != nil {
		return c.Status(fiber.StatusBadRequest).SendString(fmt.Sprintf("failed to create user: %v", err))
	}

	u, err := h.store.GetUserByEmail(payload.Email)
	if err != nil {
		return c.Status(fiber.StatusUnauthorized).SendString("invalid email or password")
	}

	if !auth.ComparePasswords(u.Password, []byte(payload.Password)) {
		return c.Status(fiber.StatusUnauthorized).SendString("invalid email or password")
	}

	secret := []byte(h.cfg.JWTSecret)
	token, err := auth.CreateJWT(secret, u.ID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).SendString(fmt.Sprintf("auth error: %v", err))
	}

	c.Status(http.StatusOK)
	err = c.JSON(fiber.Map{"token": token})
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).SendString(fmt.Sprintf("failed to write response: %v", err))
	}

	return nil
}
