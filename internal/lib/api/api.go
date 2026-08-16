package api

import (
	"context"
	"log/slog"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/lib/closer"
	"github.com/wlqoh/mini_discord.git/internal/middleware"
	"github.com/wlqoh/mini_discord.git/internal/service/embed"
	"github.com/wlqoh/mini_discord.git/internal/service/notification"
	"github.com/wlqoh/mini_discord.git/internal/service/push"
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
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	app := fiber.New(fiber.Config{
		ReadTimeout:  cfg.HTTPServer.Timeout,
		WriteTimeout: cfg.HTTPServer.Timeout,
		IdleTimeout:  cfg.HTTPServer.IdleTimeout,
		BodyLimit:    10 * 1024 * 1024,
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

	pushSender := push.NewSender(s.db, cfg.Push, log)

	// Хосты, для которых превью не делаем: собственный фронтенд и бакет с
	// вложениями — они уже отрисованы в интерфейсе как есть.
	skipHosts := embed.HostsFromURLs([]string{cfg.FrontendBaseURL, cfg.S3HOST, cfg.S3.Endpoint})
	embedService := embed.NewService(s.db, cfg.LinkPreview, log, skipHosts)

	hub := server.NewHub(s.db, s3Client, log, cfg.S3HOST, []byte(cfg.JWTSecret), pushSender, embedService)
	// Замыкаем связь в обе стороны: сервису нужен хаб для рассылки готовых
	// превью, хабу — сервис для постановки задач.
	embedService.SetBroadcaster(hub)

	userHandler := user.NewHandler(s.db, s.db, cfg, log, s3Client, hub)
	userHandler.RegisterRoutes(v1)

	wsHandler := server.NewHandler(hub, cfg.HTTPServer.WSAllowedOrigins)
	wsHandler.RegisterRoutes(v1)

	notificationHandler := notification.NewHandler(s.db, cfg, log)
	notificationHandler.RegisterRoutes(v1)

	embedHandler := embed.NewHandler(s.db, cfg.LinkPreview, log)
	embedHandler.RegisterRoutes(v1)
	go hub.Run()
	go func() {
		if err := app.Listen(cfg.Address); err != nil {
			log.Error("failed to start API server", "error", err.Error())
		}
	}()

	<-ctx.Done()
	log.Info("signal received, shutting down server...")

	stop()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer shutdownCancel()

	if err := app.ShutdownWithContext(shutdownCtx); err != nil {
		log.Error("failed to gracefully shutdown API server", "error", err.Error())
	}

	log.Info("API server shutdown complete")

	closerCtx, closerCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer closerCancel()

	if err := closer.CloseAll(closerCtx); err != nil {
		log.Error("failed to close resources", "error", err)
	}
}
