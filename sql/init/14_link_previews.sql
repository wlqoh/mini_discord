CREATE TABLE IF NOT EXISTS link_previews (
    url_hash    CHAR(64) PRIMARY KEY,
    url         TEXT NOT NULL,
    status      TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    site_name   TEXT NOT NULL DEFAULT '',
    image_url   TEXT NOT NULL DEFAULT '',
    image_token CHAR(32) NOT NULL DEFAULT '',
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS link_previews_image_token_idx
    ON link_previews(image_token) WHERE image_token <> '';

CREATE TABLE IF NOT EXISTS message_embeds (
    message_id BIGINT   NOT NULL REFERENCES messages(id)            ON DELETE CASCADE,
    position   SMALLINT NOT NULL DEFAULT 0,
    url_hash   CHAR(64) NOT NULL REFERENCES link_previews(url_hash) ON DELETE CASCADE,
    PRIMARY KEY (message_id, position)
);
