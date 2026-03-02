package websocket

import (
	"net/http"
)

type wsSrv struct {
	srv *http.Server
}
