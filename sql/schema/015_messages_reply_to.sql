-- +goose Up
ALTER TABLE messages ADD COLUMN reply_to_id bigint REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX idx_messages_reply_to_id ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS idx_messages_reply_to_id;
ALTER TABLE messages DROP COLUMN IF EXISTS reply_to_id;