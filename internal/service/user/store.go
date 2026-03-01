package user

import (
	"context"
	"database/sql"
	"discord_go/types"
	"errors"
	"fmt"
)

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

func (s *Store) GetUserByEmail(email string) (*types.User, error) {
	row := s.db.QueryRowContext(context.Background(), "SELECT id, first_name, last_name, email, password, created_at, updated_at FROM users WHERE email = $1", email)

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

func (s *Store) GetUserByID(id int) (*types.User, error) {
	row := s.db.QueryRowContext(context.Background(), "SELECT * FROM users WHERE id = $1", id)

	u, err := scanRowIntoUser(row)
	if err != nil {
		return nil, err
	}

	return u, nil
}

func (s *Store) CreateUser(user types.User) error {
	return s.db.QueryRowContext(context.Background(), "INSERT INTO users (first_name, last_name, email, password) VALUES ($1, $2, $3, $4) RETURNING id",
		user.FirstName, user.LastName, user.Email, user.Password).Scan(&user.ID)
}

func (s *Store) DeleteUser(user types.User) error {
	_, err := s.db.ExecContext(context.Background(), "DELETE FROM users WHERE id = $1", user.ID)
	return err
}
