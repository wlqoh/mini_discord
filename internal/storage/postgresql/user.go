package postgresql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/wlqoh/mini_discord.git/types"
)

func (s *Storage) GetUserByEmail(ctx context.Context, email string) (*types.User, error) {
	row := s.db.QueryRowContext(ctx, "SELECT id, first_name, last_name, email, avatar_key, attachment_folder_key, password, created_at, updated_at FROM users WHERE email = $1", email)

	u, err := scanRowIntoUser(row)
	if err != nil {
		return nil, err
	}

	return u, nil
}

func scanRowIntoUser(row *sql.Row) (*types.User, error) {
	u := new(types.User)
	var avatarKey sql.NullString
	var folderKey sql.NullString

	err := row.Scan(
		&u.ID,
		&u.FirstName,
		&u.LastName,
		&u.Email,
		&avatarKey,
		&folderKey,
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

	if avatarKey.Valid {
		u.AvatarKey = avatarKey.String
	}
	if folderKey.Valid {
		u.AttachmentFolderKey = folderKey.String
	}

	return u, nil
}

func (s *Storage) GetUserByID(ctx context.Context, id int) (*types.User, error) {
	row := s.db.QueryRowContext(ctx, "SELECT id, first_name, last_name, email, avatar_key, attachment_folder_key, password, created_at, updated_at FROM users WHERE id = $1", id)

	u, err := scanRowIntoUser(row)
	if err != nil {
		return nil, err
	}

	return u, nil
}

func (s *Storage) SaveUserAvatar(ctx context.Context, userID int, avatarKey string) error {
	_, err := s.db.ExecContext(
		ctx,
		"UPDATE users SET avatar_key = $1, updated_at = NOW() WHERE id = $2",
		avatarKey,
		userID,
	)
	return err
}

func (s *Storage) GetOrCreateAttachmentFolderKey(ctx context.Context, userID int) (string, error) {
	var folderKey sql.NullString
	err := s.db.QueryRowContext(ctx,
		"SELECT attachment_folder_key FROM users WHERE id = $1",
		userID,
	).Scan(&folderKey)
	if err != nil {
		return "", err
	}

	if folderKey.Valid && folderKey.String != "" {
		return folderKey.String, nil
	}

	newKey := uuid.NewString()
	_, err = s.db.ExecContext(ctx,
		"UPDATE users SET attachment_folder_key = $1, updated_at = NOW() WHERE id = $2",
		newKey, userID,
	)
	if err != nil {
		return "", err
	}

	return newKey, nil
}

func (s *Storage) CreateUser(ctx context.Context, user types.User) error {
	return s.db.QueryRowContext(ctx, "INSERT INTO users (first_name, last_name, email, password) VALUES ($1, $2, $3, $4) RETURNING id",
		user.FirstName, user.LastName, user.Email, user.Password).Scan(&user.ID)
}

func (s *Storage) DeleteUser(ctx context.Context, userID int) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM users WHERE id = $1", userID)
	return err
}
