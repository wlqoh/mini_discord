-- +goose Up
CREATE TABLE servers (
    id bigserial PRIMARY KEY,
    name TEXT NOT NULL CHECK (char_length(name) <= 16),
    owner_id bigserial REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT now()
);
-- +goose Down
DROP TABLE IF EXISTS servers;

