CREATE TABLE IF NOT EXISTS user_notification_settings (
    user_id              BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_level        TEXT      NOT NULL DEFAULT 'all'
                                   CHECK (default_level IN ('all','mentions','none')),
    hide_message_preview BOOLEAN   NOT NULL DEFAULT FALSE,
    dnd_until            TIMESTAMP NULL,
    updated_at           TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS server_notification_settings (
    user_id     BIGINT    NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    server_id   BIGINT    NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    level       TEXT      NULL CHECK (level IN ('all','mentions','none')),
    muted_until TIMESTAMP NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, server_id)
);

CREATE TABLE IF NOT EXISTS channel_notification_settings (
    user_id     BIGINT    NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    channel_id  BIGINT    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    level       TEXT      NULL CHECK (level IN ('all','mentions','none')),
    muted_until TIMESTAMP NULL,
    updated_at  TIMESTAMP NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel_id)
);
