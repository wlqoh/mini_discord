-- +goose Up
CREATE TABLE server_members (
    user_id bigserial REFERENCES users(id) ON DELETE CASCADE,
    server_id bigserial REFERENCES servers(id) ON DELETE CASCADE,
    joined_at TIMESTAMP DEFAULT now(),
    
    PRIMARY KEY (user_id, server_id)
);
-- +goose Down
DROP TABLE IF EXISTS server_members;