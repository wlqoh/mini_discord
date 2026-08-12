CREATE TABLE IF NOT EXISTS message_mentions (
    message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_mentions_user_idx ON message_mentions(user_id, message_id DESC);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentions_everyone BOOLEAN NOT NULL DEFAULT FALSE;
