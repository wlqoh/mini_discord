package api

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	gws "github.com/gorilla/websocket"
	"github.com/wlqoh/mini_discord.git/internal/config"
	"github.com/wlqoh/mini_discord.git/internal/lib/logger/sl"
	"github.com/wlqoh/mini_discord.git/internal/service/user"
	"github.com/wlqoh/mini_discord.git/internal/websocket"
)

type APIServer struct {
	addr  string
	db    *sql.DB
	wsUpg *gws.Upgrader
}

func NewAPIServer(addr string, db *sql.DB) *APIServer {
	return &APIServer{
		addr:  addr,
		db:    db,
		wsUpg: &gws.Upgrader{},
	}
}

func (s *APIServer) Run(log *slog.Logger, cfg *config.Config) {
	router := chi.NewRouter()
	router.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"https://*", "http://*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		ExposedHeaders:   []string{"link"},
		AllowCredentials: false,
		MaxAge:           300,
	}))
	v1Router := chi.NewRouter()
	router.Mount("/api/v1", v1Router)

	userStore := user.NewStore(s.db)
	userHandler := user.NewHandler(userStore, cfg)
	userHandler.RegisterRoutes(v1Router)

	websocketStore := websocket.NewWebsocket(s.db)
	websocketHandler := websocket.NewHandler(websocketStore)
	websocketHandler.RegisterRoutes(v1Router)

	_ = websocketHandler

	srv := &http.Server{
		Addr:         cfg.Address,
		Handler:      router,
		ReadTimeout:  cfg.HTTPServer.Timeout,
		WriteTimeout: cfg.HTTPServer.Timeout,
		IdleTimeout:  cfg.HTTPServer.IdleTimeout,
	}

	//Graceful shutdown
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("failed to start server", sl.Err(err))
		}
	}()

	log.Info("server started")

	<-done
	log.Info("stopping server...")

	ctx, cancel := context.WithTimeout(context.Background(), cfg.HTTPServer.Timeout)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Error("failed to shutdown server", sl.Err(err))
		return
	}

	log.Info("server stopped gracefully")
}
