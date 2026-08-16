-- +goose Up
-- Генерируемая колонка вместо триггера: Postgres поддерживает вектор сам,
-- код записи сообщений трогать не нужно и рассинхрон индекса невозможен.
-- Две конфигурации склеены, потому что чат смешанный: 'russian' даёт морфологию
-- русского, 'english' — английского ("logs" ↔ "log"). Обе формы to_tsvector
-- с явным первым аргументом IMMUTABLE, поэтому допустимы в GENERATED.
ALTER TABLE messages
    ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
        to_tsvector('russian', coalesce(content, '')) ||
        to_tsvector('english', coalesce(content, ''))
    ) STORED;

CREATE INDEX idx_messages_search_vector ON messages USING GIN (search_vector);

-- +goose Down
DROP INDEX IF EXISTS idx_messages_search_vector;
ALTER TABLE messages DROP COLUMN IF EXISTS search_vector;
