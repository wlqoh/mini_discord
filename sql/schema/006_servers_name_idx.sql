-- +goose Up
CREATE INDEX IF NOT EXISTS idx_servers_name_lower ON servers (LOWER(name));

-- +goose Down
DROP INDEX IF EXISTS idx_servers_name_lower;