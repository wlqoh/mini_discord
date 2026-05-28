CREATE TABLE IF NOT EXISTS pending_attachments (
    id bigserial PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    folder_key TEXT NOT NULL DEFAULT '',
    file_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes bigint NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_attachments_user_folder ON pending_attachments(user_id, folder_key);

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