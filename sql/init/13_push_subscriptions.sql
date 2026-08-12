CREATE TABLE IF NOT EXISTS push_subscriptions (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint     TEXT      NOT NULL UNIQUE,
    p256dh       TEXT      NOT NULL,
    auth         TEXT      NOT NULL,
    user_agent   TEXT      NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT now(),
    last_used_at TIMESTAMP NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);
