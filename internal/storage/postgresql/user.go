package postgresql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/wlqoh/mini_discord.git/types"
	"golang.org/x/crypto/bcrypt"
)

func (s *Storage) GetUserByEmail(ctx context.Context, email string) (*types.User, error) {
	row := s.db.QueryRowContext(ctx, "SELECT id, first_name, last_name, nickname, email, avatar_key, attachment_folder_key, password, is_deleted, deleted_at, created_at, updated_at FROM users WHERE email = $1 AND is_deleted = FALSE", email)

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
	var deletedAt sql.NullTime

	err := row.Scan(
		&u.ID,
		&u.FirstName,
		&u.LastName,
		&u.Nickname,
		&u.Email,
		&avatarKey,
		&folderKey,
		&u.Password,
		&u.IsDeleted,
		&deletedAt,
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
	if deletedAt.Valid {
		u.DeletedAt = &deletedAt.Time
	}

	return u, nil
}

func (s *Storage) GetUserByID(ctx context.Context, id int) (*types.User, error) {
	key := fmt.Sprintf("%s%d", userIDKey, id)
	if v, ok := s.cache.Get(key); ok {
		u := v.(*types.User)
		uCopy := *u
		return &uCopy, nil
	}
	val, err := s.sf.Do(ctx, key, func(ctx context.Context) (interface{}, error) {
		row := s.db.QueryRowContext(ctx, "SELECT id, first_name, last_name, nickname, email, avatar_key, attachment_folder_key, password, is_deleted, deleted_at, created_at, updated_at FROM users WHERE id = $1", id)

		u, err := scanRowIntoUser(row)
		if err != nil {
			return nil, err
		}

		s.cache.Set(key, u, 0)
		return u, nil
	})
	if err != nil {
		return nil, err
	}
	u := val.(*types.User)
	uCopy := *u
	return &uCopy, nil
}

func (s *Storage) SaveUserAvatar(ctx context.Context, userID int, avatarKey string) error {
	_, err := s.db.ExecContext(
		ctx,
		"UPDATE users SET avatar_key = $1, updated_at = NOW() WHERE id = $2",
		avatarKey,
		userID,
	)
	if err != nil {
		return err
	}

	key := fmt.Sprintf("%s%d", userIDKey, userID)
	s.cache.Delete(key)
	return nil
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
	key := fmt.Sprintf("%s%d", userIDKey, userID)
	s.cache.Delete(key)
	return newKey, nil
}

func (s *Storage) CreateUser(ctx context.Context, user types.User) error {
	return s.db.QueryRowContext(ctx, "INSERT INTO users (first_name, last_name, nickname, email, password) VALUES ($1, $2, $3, $4, $5) RETURNING id",
		user.FirstName, user.LastName, user.Nickname, user.Email, user.Password).Scan(&user.ID)
}

func (s *Storage) UpdateUser(ctx context.Context, userID int, user types.UpdateUserRequest) error {
	_, err := s.db.ExecContext(ctx, "UPDATE users SET first_name = $1, last_name = $2, nickname = $3, updated_at = NOW() WHERE id = $4",
		user.FirstName, user.LastName, user.Nickname, userID)
	if err != nil {
		return err
	}
	key := fmt.Sprintf("%s%d", userIDKey, userID)
	s.cache.Delete(key)
	return nil
}

func (s *Storage) DeleteUser(ctx context.Context, userID int) error {
	deletedEmail := fmt.Sprintf("deleted+%s@local.invalid", uuid.NewString())
	newPassword, err := bcrypt.GenerateFromPassword([]byte(uuid.NewString()), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx, `UPDATE users
		SET first_name = $1,
			last_name = $2,
			nickname = $3,
			email = $4,
			password = $5,
			avatar_key = NULL,
			attachment_folder_key = NULL,
			is_deleted = TRUE,
			deleted_at = NOW(),
			updated_at = NOW()
		WHERE id = $6`,
		"Deleted", "User", "deleted user", deletedEmail, string(newPassword), userID,
	)
	if err != nil {
		return err
	}
	key := fmt.Sprintf("%s%d", userIDKey, userID)
	s.cache.Delete(key)
	return nil
}
