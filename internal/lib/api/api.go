package api

import (
	"database/sql"
	"fmt"
	"log/slog"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/service/user"
	"github.com/wlqoh/mini_discord.git/internal/ws"
)

type APIServer struct {
	addr string
	db   *sql.DB
}

func NewAPIServer(addr string, db *sql.DB) *APIServer {
	return &APIServer{
		addr: addr,
		db:   db,
	}
}

func (s *APIServer) Run(log *slog.Logger, cfg *config.Config) {
	app := fiber.New(fiber.Config{
		ReadTimeout:  cfg.HTTPServer.Timeout,
		WriteTimeout: cfg.HTTPServer.Timeout,
		IdleTimeout:  cfg.HTTPServer.IdleTimeout,
	})
	app.Use(logger.New())
	app.Use(cors.New())

	api := app.Group("/api")

	v1 := api.Group("/v1")

	userStore := user.NewStore(s.db)
	userHandler := user.NewHandler(userStore, cfg, log)
	userHandler.RegisterRoutes(v1)

	hub := ws.NewHub()
	wsHandler := ws.NewHandler(hub)
	wsHandler.RegisterRoutes(v1)
	go hub.Run()

	err := app.Listen(cfg.Address)
	if err != nil {
		fmt.Println(err.Error())
		return
	}
}
