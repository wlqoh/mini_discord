-- +goose Up
CREATE TABLE IF NOT EXISTS pending_attachments (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes bigint NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS message_attachments (
    id bigserial PRIMARY KEY,
    message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    file_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes bigint NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_attachments_message_id ON message_attachments(message_id);

ALTER TABLE messages ALTER COLUMN content SET DEFAULT '';

-- +goose Down
DROP TABLE IF EXISTS message_attachments;
DROP TABLE IF EXISTS pending_attachments;