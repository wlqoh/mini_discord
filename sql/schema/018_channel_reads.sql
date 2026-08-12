-- +goose Up
CREATE TABLE channel_reads (
    user_id              BIGINT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    channel_id           BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_message_id BIGINT NOT NULL DEFAULT 0,
    updated_at           TIMESTAMP NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel_id)
);
-- +goose Down
DROP TABLE IF EXISTS channel_reads;
