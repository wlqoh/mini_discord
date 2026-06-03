-- +goose Up
ALTER TABLE message_attachments
    ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT '';
ALTER TABLE message_attachments
    ADD COLUMN IF NOT EXISTS file_name TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE message_attachments
    DROP COLUMN IF EXISTS content_type;
ALTER TABLE message_attachments
    DROP COLUMN IF EXISTS file_name;