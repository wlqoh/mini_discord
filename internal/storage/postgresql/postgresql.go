package postgresql

import (
	"context"
	"database/sql"
	"fmt"

	_ "github.com/lib/pq"
	"github.com/wlqoh/mini_discord.git/internal/lib/closer"
)

type Storage struct {
	db *sql.DB
}

func New(storagePath string) (*Storage, error) {
	const op = "storage.postgresql.New"

	db, err := sql.Open("postgres", storagePath)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", op, err)
	}

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("%s: failed to connect %w", op, err)
	}

	closer.Add("postgresql", func(ctx context.Context) error {
		return db.Close()
	})

	return &Storage{db: db}, nil
}
