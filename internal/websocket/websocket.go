package websocket

import "database/sql"

type Websocket struct {
	db *sql.DB
}

func NewWebsocket(db *sql.DB) *Websocket {
	return &Websocket{db: db}
}
