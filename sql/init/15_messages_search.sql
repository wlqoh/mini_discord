ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
        to_tsvector('russian', coalesce(content, '')) ||
        to_tsvector('english', coalesce(content, ''))
    ) STORED;

CREATE INDEX IF NOT EXISTS idx_messages_search_vector ON messages USING GIN (search_vector);
