-- +goose Up
ALTER TABLE users ADD COLUMN IF NOT EXISTS attachment_folder_key TEXT;

-- +goose Down
ALTER TABLE users DROP COLUMN IF EXISTS attachment_folder_key;