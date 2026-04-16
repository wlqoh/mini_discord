-- +goose Up
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS avatar_key TEXT;

-- +goose Down
ALTER TABLE users
    DROP COLUMN IF EXISTS avatar_key;

