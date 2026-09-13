ALTER TABLE channels ALTER COLUMN server_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS dm_channels (
    channel_id BIGINT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    user_a     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    CHECK (user_a < user_b)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_channels_pair ON dm_channels(user_a, user_b);
CREATE INDEX IF NOT EXISTS idx_dm_channels_user_a ON dm_channels(user_a);
CREATE INDEX IF NOT EXISTS idx_dm_channels_user_b ON dm_channels(user_b);

CREATE TABLE IF NOT EXISTS dm_visibility (
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    hidden_at  TIMESTAMP,
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_dm_visibility_user ON dm_visibility(user_id);
