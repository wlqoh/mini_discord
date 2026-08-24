package postgresql

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/wlqoh/mini_discord.git/types"
	"golang.org/x/crypto/bcrypt"
)

const userSelectColumns = "id, first_name, last_name, nickname, email, avatar_key, attachment_folder_key, password, is_deleted, deleted_at, email_verified, created_at, updated_at"

// GetUserByEmail implements types.UserStorage. It only ever returns
// non-deleted accounts.
func (s *Storage) GetUserByEmail(ctx context.Context, email string) (*types.User, error) {
	row := s.db.QueryRowContext(ctx, "SELECT "+userSelectColumns+" FROM users WHERE email = $1 AND is_deleted = FALSE", email)

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
		&u.EmailVerified,
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

// GetUserByID implements types.UserStorage. Results are cached (keyed by
// userIDKey) with single-flight collapsing of concurrent misses for the
// same ID; callers always get a defensive copy, so mutating the returned
// *types.User cannot corrupt the cache entry.
func (s *Storage) GetUserByID(ctx context.Context, id int) (*types.User, error) {
	key := fmt.Sprintf("%s%d", userIDKey, id)
	if v, ok := s.cache.Get(key); ok {
		u := v.(*types.User)
		uCopy := *u
		return &uCopy, nil
	}
	val, err := s.sf.Do(ctx, key, func(ctx context.Context) (interface{}, error) {
		row := s.db.QueryRowContext(ctx, "SELECT "+userSelectColumns+" FROM users WHERE id = $1", id)

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

// SaveUserAvatar implements types.UserStorage and invalidates the user's
// GetUserByID cache entry.
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

// GetOrCreateAttachmentFolderKey implements types.UserStorage. On first
// call for a user it generates and persists a new UUID folder key and
// invalidates the GetUserByID cache entry; later calls return the
// already-stored key unchanged.
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

// CreateUser implements types.UserStorage.
func (s *Storage) CreateUser(ctx context.Context, user types.User) error {
	return s.db.QueryRowContext(ctx, "INSERT INTO users (first_name, last_name, nickname, email, password) VALUES ($1, $2, $3, $4, $5) RETURNING id",
		user.FirstName, user.LastName, user.Nickname, user.Email, user.Password).Scan(&user.ID)
}

// UpdateUser implements types.UserStorage and invalidates the user's
// GetUserByID cache entry.
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

// CreateEmailVerificationToken implements types.UserStorage. It first
// deletes any of the user's outstanding unused tokens, so only the
// newest verification link ever works.
func (s *Storage) CreateEmailVerificationToken(ctx context.Context, userID int, tokenHash string, expiresAt time.Time) error {
	// Drop any outstanding tokens for this user so only the newest link works.
	_, err := s.db.ExecContext(ctx,
		"DELETE FROM email_verification_tokens WHERE user_id = $1 AND used_at IS NULL",
		userID,
	)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx,
		"INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
		userID, tokenHash, expiresAt,
	)
	return err
}

// VerifyEmailByToken implements types.UserStorage. It runs inside a
// transaction that locks the token row (SELECT ... FOR UPDATE) so a token
// cannot be consumed twice by concurrent requests, and errors if the token
// is unknown, already used, or past its expiry.
func (s *Storage) VerifyEmailByToken(ctx context.Context, tokenHash string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var userID int
	var expiresAt time.Time
	var usedAt sql.NullTime
	err = tx.QueryRowContext(ctx,
		"SELECT user_id, expires_at, used_at FROM email_verification_tokens WHERE token_hash = $1 FOR UPDATE",
		tokenHash,
	).Scan(&userID, &expiresAt, &usedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("invalid or expired verification token")
		}
		return err
	}

	if usedAt.Valid || time.Now().After(expiresAt) {
		return fmt.Errorf("invalid or expired verification token")
	}

	if _, err = tx.ExecContext(ctx,
		"UPDATE email_verification_tokens SET used_at = NOW() WHERE token_hash = $1",
		tokenHash,
	); err != nil {
		return err
	}

	if _, err = tx.ExecContext(ctx,
		"UPDATE users SET email_verified = TRUE, updated_at = NOW() WHERE id = $1",
		userID,
	); err != nil {
		return err
	}

	if err = tx.Commit(); err != nil {
		return err
	}

	s.cache.Delete(fmt.Sprintf("%s%d", userIDKey, userID))

	return nil
}

// DeleteUser implements types.UserStorage. It does not remove the row:
// it scrubs personal fields (name, email, password, avatar), sets
// IsDeleted/DeletedAt, and invalidates the GetUserByID cache entry.
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
