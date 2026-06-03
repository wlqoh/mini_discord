-- +goose Up
ALTER TABLE message_attachments
    DROP COLUMN IF EXISTS file_name;

-- +goose Down
ALTER TABLE message_attachments
    ADD COLUMN file_name TEXT NOT NULL DEFAULT '';