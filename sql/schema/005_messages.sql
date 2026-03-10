-- +goose Up
CREATE TABLE messages (
    id bigserial PRIMARY KEY,
    channel_id bigserial REFERENCES channels(id) ON DELETE CASCADE,
    author_id bigserial REFERENCES users(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT now(),
    edited_at TIMESTAMP
);

CREATE INDEX idx_messages_channel_created ON messages(channel_id, created_at DESC);
-- +goose Down
DROP TABLE IF EXISTS messages;