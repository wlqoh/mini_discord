package user

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/wlqoh/mini_discord.git/types"
)

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

func (s *Store) GetUserByEmail(ctx context.Context, email string) (*types.User, error) {
	row := s.db.QueryRowContext(ctx, "SELECT id, first_name, last_name, email, password, created_at, updated_at FROM users WHERE email = $1", email)

	u, err := scanRowIntoUser(row)
	if err != nil {
		return nil, err
	}

	return u, nil
}

func scanRowIntoUser(row *sql.Row) (*types.User, error) {
	u := new(types.User)

	err := row.Scan(
		&u.ID,
		&u.FirstName,
		&u.LastName,
		&u.Email,
		&u.Password,
		&u.CreatedAt,
		&u.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("failed to find user")
		}
		return nil, err
	}

	return u, nil
}

func (s *Store) GetUserByID(ctx context.Context, id int) (*types.User, error) {
	row := s.db.QueryRowContext(ctx, "SELECT * FROM users WHERE id = $1", id)

	u, err := scanRowIntoUser(row)
	if err != nil {
		return nil, err
	}

	return u, nil
}

func (s *Store) CreateUser(ctx context.Context, user types.User) error {
	return s.db.QueryRowContext(ctx, "INSERT INTO users (first_name, last_name, email, password) VALUES ($1, $2, $3, $4) RETURNING id",
		user.FirstName, user.LastName, user.Email, user.Password).Scan(&user.ID)
}

func (s *Store) DeleteUser(ctx context.Context, user types.User) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM users WHERE id = $1", user.ID)
	return err
}
