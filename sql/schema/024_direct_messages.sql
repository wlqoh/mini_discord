-- +goose Up
-- DM-канал — это channels-строка без сервера. Всё, что висит на channel_id
-- (messages, channel_reads, message_mentions, link_previews, FTS), работает
-- для него без изменений.
ALTER TABLE channels ALTER COLUMN server_id DROP NOT NULL;

-- Пара участников. user_a < user_b всегда (нормализация на стороне запроса
-- через least/greatest), поэтому UNIQUE PK даёт "один диалог на пару" на
-- уровне БД — без гонок при одновременном open_dm с обеих сторон.
CREATE TABLE dm_channels (
    channel_id BIGINT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    user_a     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP NOT NULL DEFAULT now(),
    CHECK (user_a < user_b)
);
CREATE UNIQUE INDEX idx_dm_channels_pair ON dm_channels(user_a, user_b);
CREATE INDEX idx_dm_channels_user_a ON dm_channels(user_a);
CREATE INDEX idx_dm_channels_user_b ON dm_channels(user_b);

-- Видимость диалога у каждой стороны. Строка инициатора создаётся при
-- open_dm; строка второй стороны — при первом сообщении (решение №5).
-- hidden_at выставляется при close_dm и сбрасывается входящим сообщением.
CREATE TABLE dm_visibility (
    channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    BIGINT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    hidden_at  TIMESTAMP,
    PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX idx_dm_visibility_user ON dm_visibility(user_id);

-- +goose Down
DROP TABLE IF EXISTS dm_visibility;
DROP TABLE IF EXISTS dm_channels;
-- server_id обратно в NOT NULL только если DM-каналов не осталось.
DELETE FROM channels WHERE server_id IS NULL;
ALTER TABLE channels ALTER COLUMN server_id SET NOT NULL;
