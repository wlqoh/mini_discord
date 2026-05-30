-- +goose Up
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS nickname TEXT NOT NULL default '';

-- +goose Down
ALTER TABLE users
    DROP COLUMN IF EXISTS nickname;

