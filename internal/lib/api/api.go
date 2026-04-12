package api

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/logger"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/lib/ratelimit"
	"github.com/wlqoh/mini_discord.git/internal/service/server"
	"github.com/wlqoh/mini_discord.git/internal/service/user"
	"github.com/wlqoh/mini_discord.git/internal/storage/postgresql"
)

type APIServer struct {
	addr string
	db   *postgresql.Storage
}

func NewAPIServer(addr string, db *postgresql.Storage) *APIServer {
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
	app.Use(cors.New(cors.Config{AllowOrigins: strings.Join(cfg.HTTPServer.CORSOrigins, ",")}))

	limiter := ratelimit.NewTokenBucket(5.0/60.0, 5)
	defer limiter.Close()

	api := app.Group("/api")
	v1 := api.Group("/v1")
	userRoutes := v1.Group("", limiter.FiberRateLimitMiddleware())

	userHandler := user.NewHandler(s.db, cfg, log)
	userHandler.RegisterRoutes(userRoutes)

	hub := server.NewHub(s.db, log)
	defer hub.Close()
	wsHandler := server.NewHandler(hub, cfg.HTTPServer.WSAllowedOrigins)
	wsHandler.RegisterRoutes(v1)
	go hub.Run()

	err := app.Listen(cfg.Address)
	if err != nil {
		fmt.Println(err.Error())
		return
	}
}
