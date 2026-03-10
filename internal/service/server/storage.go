package server

import (
	"context"
	"database/sql"

	"github.com/wlqoh/mini_discord.git/types"
)

type Storage struct {
	db *sql.DB
}

func NewStorage(db *sql.DB) *Storage {
	return &Storage{db: db}
}

func (s *Storage) CreateServer(ctx context.Context, server types.Server) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	_, err = tx.ExecContext(ctx,
		`INSERT INTO servers (name, owner_id)
		 VALUES ($2, $3) RETURNING id`,
		server.Name,
		server.OwnerID,
	)
	if err != nil {
		return err
	}

	_, err = tx.ExecContext(ctx,
		`INSERT INTO server_members (user_id, server_id)
		 VALUES ($1, $2)`,
		server.OwnerID,
		server.ID,
	)
	if err != nil {
		return err
	}

	return tx.Commit()
}

func (s *Storage) DeleteServer(ctx context.Context, server types.Server) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM servers WHERE id = $1", server.ID)
	return err
}

func (s *Storage) AddMemberToServer(ctx context.Context, userID int, serverID int) error {
	query := `
	INSERT INTO server_members (user_id, server_id)
	VALUES ($1, $2)
	`

	_, err := s.db.ExecContext(ctx, query, userID, serverID)
	return err
}
