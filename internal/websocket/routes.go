package websocket

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/wlqoh/mini_discord.git/types"
)

type Handler struct {
	websocket types.WSServer
}

func NewHandler(websocket types.WSServer) *Handler {
	return &Handler{websocket: websocket}
}

func (h *Handler) RegisterRoutes(router *chi.Mux) {
	router.HandleFunc("/test", h.handleTest)
}

func (h *Handler) handleTest(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("Hello World"))
}

func (h *Handler) wsHandler(w http.ResponseWriter, r *http.Request) {

}
