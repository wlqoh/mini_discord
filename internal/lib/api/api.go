package api

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/middleware"
	"github.com/wlqoh/mini_discord.git/internal/service/server"
	"github.com/wlqoh/mini_discord.git/internal/service/user"
	"github.com/wlqoh/mini_discord.git/internal/storage/objectStorage"
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
	app.Use(
		middleware.Recovery(log),
		middleware.RequestID(),
		middleware.Logger(log),
	)
	app.Use(cors.New(cors.Config{AllowOrigins: strings.Join(cfg.HTTPServer.CORSOrigins, ",")}))

	s3Client := objectStorage.NewS3Client(cfg, log)

	api := app.Group("/api")
	v1 := api.Group("/v1")

	hub := server.NewHub(s.db, s3Client, log, cfg.S3HOST, []byte(cfg.JWTSecret))
	defer hub.Close()

	userHandler := user.NewHandler(s.db, s.db, hub, cfg, log, s3Client)
	userHandler.RegisterRoutes(v1)

	wsHandler := server.NewHandler(hub, cfg.HTTPServer.WSAllowedOrigins)
	wsHandler.RegisterRoutes(v1)
	go hub.Run()

	err := app.Listen(cfg.Address)
	if err != nil {
		fmt.Println(err.Error())
		return
	}
}
