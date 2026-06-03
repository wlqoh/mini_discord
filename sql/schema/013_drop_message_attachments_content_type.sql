-- +goose Up
ALTER TABLE message_attachments
    DROP COLUMN IF EXISTS content_type;

-- +goose Down
ALTER TABLE message_attachments
    ADD COLUMN content_type TEXT NOT NULL DEFAULT '';