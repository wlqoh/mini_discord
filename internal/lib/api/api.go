// Package api is the composition root: it builds the Fiber app, wires
// together every storage/service/handler, and owns the process's
// listen/shutdown lifecycle.
package api

import (
	"context"
	"log/slog"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/basicauth"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/lib/closer"
	"github.com/wlqoh/mini_discord.git/internal/middleware"
	"github.com/wlqoh/mini_discord.git/internal/service/embed"
	"github.com/wlqoh/mini_discord.git/internal/service/notification"
	"github.com/wlqoh/mini_discord.git/internal/service/push"
	"github.com/wlqoh/mini_discord.git/internal/service/server"
	"github.com/wlqoh/mini_discord.git/internal/service/user"
	"github.com/wlqoh/mini_discord.git/internal/service/webrtc"
	"github.com/wlqoh/mini_discord.git/internal/storage/objectStorage"
	"github.com/wlqoh/mini_discord.git/internal/storage/postgresql"
	"github.com/wlqoh/mini_discord.git/utils"
)

// APIServer owns the Fiber app and its dependencies for one run of the
// backend.
type APIServer struct {
	addr string
	db   *postgresql.Storage
}

// NewAPIServer builds an APIServer bound to db, listening on addr once Run
// is called.
func NewAPIServer(addr string, db *postgresql.Storage) *APIServer {
	return &APIServer{
		addr: addr,
		db:   db,
	}
}

// Run builds the Fiber app, wires every handler and background service
// (S3 client, push sender, embed service, the hub, the admin SFU debug
// route) to db, then starts the hub's event loop and the HTTP listener as
// background goroutines. It blocks until SIGINT/SIGTERM, then shuts the
// Fiber app down gracefully (15s budget) and runs every registered
// closer.Add callback (10s budget) before returning.
func (s *APIServer) Run(log *slog.Logger, cfg *config.Config) {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	app := fiber.New(fiber.Config{
		ReadTimeout:  cfg.Timeout,
		WriteTimeout: cfg.Timeout,
		IdleTimeout:  cfg.IdleTimeout,
		BodyLimit:    10 * 1024 * 1024,
	})
	app.Use(
		middleware.Recovery(log),
		middleware.RequestID(),
		middleware.Logger(log),
	)
	app.Use(cors.New(cors.Config{AllowOrigins: strings.Join(cfg.CORSOrigins, ",")}))

	s3Client := objectStorage.NewS3Client(cfg, log)

	api := app.Group("/api")
	v1 := api.Group("/v1")

	pushSender := push.NewSender(s.db, cfg.Push, log)

	// Хосты, для которых превью не делаем: собственный фронтенд и бакет с
	// вложениями — они уже отрисованы в интерфейсе как есть.
	skipHosts := embed.HostsFromURLs([]string{cfg.FrontendBaseURL, cfg.S3HOST, cfg.S3.Endpoint})
	embedService := embed.NewService(s.db, cfg.LinkPreview, log, skipHosts)

	hub := server.NewHub(s.db, s3Client, log, cfg.S3HOST, []byte(cfg.JWTSecret), pushSender, embedService, cfg.WebRTC)
	// Замыкаем связь в обе стороны: сервису нужен хаб для рассылки готовых
	// превью, хабу — сервис для постановки задач.
	embedService.SetBroadcaster(hub)

	userHandler := user.NewHandler(s.db, s.db, cfg, log, s3Client, hub)
	userHandler.RegisterRoutes(v1)

	wsHandler := server.NewHandler(hub, cfg.WSAllowedOrigins)
	wsHandler.RegisterRoutes(v1)

	notificationHandler := notification.NewHandler(s.db, cfg, log)
	notificationHandler.RegisterRoutes(v1)

	embedHandler := embed.NewHandler(s.db, cfg.LinkPreview, log)
	embedHandler.RegisterRoutes(v1)

	webrtcHandler := webrtc.NewHandler(s.db, cfg, log)
	webrtcHandler.RegisterRoutes(v1)

	// GET /admin/sfu/rooms: live snapshot of every SFU room/peer (decision
	// #12, sfu-migration-plan.md §7 phase 1 / §12) — SFU bugs tend to be
	// silent (connection looks fine, one subscriber just never gets a
	// track), so this exists to answer "what does the router think is
	// happening right now" directly instead of reconstructing it from logs.
	// Gated on the same operator credentials as the rest of this deployment
	// (cfg.User/Password) rather than a per-user role: this project has no
	// admin-role concept, and inventing one just for this debug endpoint
	// would be more surface than the endpoint is worth.
	adminAuth := basicauth.New(basicauth.Config{
		Users: map[string]string{cfg.User: cfg.Password},
	})
	v1.Get("/admin/sfu/rooms", adminAuth, func(c *fiber.Ctx) error {
		router := hub.SFURouter()
		if router == nil {
			return utils.WriteError(c, fiber.StatusNotFound, "SFU is not enabled")
		}
		return c.JSON(router.Snapshot())
	})

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
