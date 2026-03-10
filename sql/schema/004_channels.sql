-- +goose Up
CREATE TABLE channels (
    id bigserial PRIMARY KEY,
    server_id bigserial REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'text',
    position INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT now()
);
-- +goose Down
DROP TABLE IF EXISTS channels;