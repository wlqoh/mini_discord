package api

import (
	"database/sql"
	"fmt"
	"log/slog"

	"github.com/gofiber/fiber/v2"
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

	api := app.Group("/api")

	v1 := api.Group("/v1")

	userStore := user.NewStore(s.db)
	userHandler := user.NewHandler(userStore, cfg)
	userHandler.RegisterRoutes(v1)

	//websocketStore := ws.NewWebsocket(s.db)
	websocketHandler := ws.NewHandler(log)
	websocketHandler.RegisterRoutes(v1)

	_ = websocketHandler

	err := app.Listen(cfg.Address)
	if err != nil {
		fmt.Println(err.Error())
		return
	}
}
