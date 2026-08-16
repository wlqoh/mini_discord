-- +goose Up
CREATE TABLE link_previews (
    url_hash    CHAR(64) PRIMARY KEY,           -- sha256(normalized url) в hex
    url         TEXT NOT NULL,
    status      TEXT NOT NULL,                  -- ok | empty | failed
    title       TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    site_name   TEXT NOT NULL DEFAULT '',
    image_url   TEXT NOT NULL DEFAULT '',
    image_token CHAR(32) NOT NULL DEFAULT '',   -- случайный, отдаётся наружу вместо url_hash
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Токен ищется на каждый запрос картинки; частичный уникальный индекс не даёт
-- пустым токенам (превью без картинки) конфликтовать между собой.
CREATE UNIQUE INDEX link_previews_image_token_idx
    ON link_previews(image_token) WHERE image_token <> '';

CREATE TABLE message_embeds (
    message_id BIGINT   NOT NULL REFERENCES messages(id)          ON DELETE CASCADE,
    position   SMALLINT NOT NULL DEFAULT 0,
    url_hash   CHAR(64) NOT NULL REFERENCES link_previews(url_hash) ON DELETE CASCADE,
    PRIMARY KEY (message_id, position)
);

-- +goose Down
DROP TABLE IF EXISTS message_embeds;
DROP TABLE IF EXISTS link_previews;
