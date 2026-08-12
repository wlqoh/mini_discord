-- +goose Up
CREATE TABLE message_mentions (
    message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_mentions_user_idx ON message_mentions(user_id, message_id DESC);

ALTER TABLE messages ADD COLUMN mentions_everyone BOOLEAN NOT NULL DEFAULT FALSE;

-- +goose Down
ALTER TABLE messages DROP COLUMN IF EXISTS mentions_everyone;
DROP TABLE IF EXISTS message_mentions;
