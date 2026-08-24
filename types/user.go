package types

import (
	"context"
	"time"
)

// UserStorage is the account/auth persistence contract, implemented by
// *postgresql.Storage.
type UserStorage interface {
	// CreateUser inserts a new user row. Password is expected to already be
	// hashed by the caller.
	CreateUser(context.Context, User) error
	// UpdateUser applies the editable profile fields in user to userID.
	UpdateUser(ctx context.Context, userID int, user UpdateUserRequest) error
	// DeleteUser soft-deletes the user (marks IsDeleted, sets DeletedAt);
	// it does not remove the row.
	DeleteUser(context.Context, int) error
	// GetUserByEmail looks up a user by email.
	GetUserByEmail(ctx context.Context, email string) (*User, error)
	// GetUserByID looks up a user by ID.
	GetUserByID(ctx context.Context, id int) (*User, error)
	// SaveUserAvatar records avatarKey as the user's current avatar object key.
	SaveUserAvatar(ctx context.Context, userID int, avatarKey string) error
	// GetOrCreateAttachmentFolderKey returns the user's per-user S3 prefix
	// for message attachments, creating and persisting one on first call.
	GetOrCreateAttachmentFolderKey(ctx context.Context, userID int) (string, error)
	// CreateEmailVerificationToken stores tokenHash (never the raw token)
	// for the user, valid until expiresAt.
	CreateEmailVerificationToken(ctx context.Context, userID int, tokenHash string, expiresAt time.Time) error
	// VerifyEmailByToken marks the user matching tokenHash as
	// EmailVerified. It errors if the token is unknown or expired.
	VerifyEmailByToken(ctx context.Context, tokenHash string) error
}

// User is an account row, including fields that are never sent to the
// client (Password, IsDeleted, DeletedAt, EmailVerified all carry
// json:"-").
type User struct {
	ID                  int        `json:"id"`
	FirstName           string     `json:"first_name"`
	LastName            string     `json:"last_name"`
	Nickname            string     `json:"nickname"`
	Email               string     `json:"email"`
	AvatarKey           string     `json:"avatar_key,omitempty"`
	AttachmentFolderKey string     `json:"attachment_folder_key,omitempty"`
	Password            string     `json:"-"`
	IsDeleted           bool       `json:"-"`
	DeletedAt           *time.Time `json:"-"`
	EmailVerified       bool       `json:"-"`
	CreatedAt           time.Time  `json:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
}

// UserResponse is the public, wire-safe projection of User.
type UserResponse struct {
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Nickname  string `json:"nickname"`
	AvatarURL string `json:"avatar_url"`
	Email     string `json:"email"`
}

// RegisterUserRequest is the REST payload for account creation.
type RegisterUserRequest struct {
	FirstName string `json:"first_name" validate:"required"`
	LastName  string `json:"last_name" validate:"required"`
	Nickname  string `json:"nickname" validate:"required"`
	Email     string `json:"email" validate:"required,email"`
	Password  string `json:"password" validate:"required,min=6,max=130"`
}

// UpdateUserRequest is the REST payload for editing profile fields.
type UpdateUserRequest struct {
	FirstName string `json:"first_name" validate:"required,min=1"`
	LastName  string `json:"last_name" validate:"required,min=1"`
	Nickname  string `json:"nickname" validate:"required,min=1"`
}

// DeleteAccountRequest is the REST payload for self-service account
// deletion; Password re-confirms the request is from the account owner.
type DeleteAccountRequest struct {
	Password string `json:"password" validate:"required"`
}

// LoginUserRequest is the REST payload for email/password login.
type LoginUserRequest struct {
	Email    string `json:"email" validate:"required,email"`
	Password string `json:"password" validate:"required"`
}

// LoginUserResponse carries the issued JWT pair and the logged-in user's
// public profile.
type LoginUserResponse struct {
	AccessToken           string       `json:"access_token"`
	RefreshToken          string       `json:"refresh_token"`
	AccessTokenExpiresAt  time.Time    `json:"access_token_expires_at"`
	RefreshTokenExpiresAt time.Time    `json:"refresh_token_expires_at"`
	User                  UserResponse `json:"user"`
}

// RenewAccessTokenRequest is the REST payload for exchanging a refresh
// token for a new access token.
type RenewAccessTokenRequest struct {
	RefreshToken string `json:"refresh_token" validate:"required"`
}

// RenewAccessTokenResponse carries the newly issued access token.
type RenewAccessTokenResponse struct {
	AccessToken          string    `json:"access_token"`
	AccessTokenExpiresAt time.Time `json:"access_token_expires_at"`
}

// VerifyEmailRequest is the REST payload for completing email verification
// via the token sent by CreateEmailVerificationToken.
type VerifyEmailRequest struct {
	Token string `json:"token" validate:"required"`
}

// ResendVerificationRequest is the REST payload for re-sending the email
// verification link.
type ResendVerificationRequest struct {
	Email string `json:"email" validate:"required,email"`
}
