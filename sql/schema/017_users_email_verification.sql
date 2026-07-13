-- +goose Up
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Grandfather all pre-existing accounts so they are not locked out after this migration.
UPDATE users SET email_verified = TRUE;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
    id bigserial PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id ON email_verification_tokens (user_id);

-- +goose Down
DROP TABLE IF EXISTS email_verification_tokens;

ALTER TABLE users
    DROP COLUMN IF EXISTS email_verified;
