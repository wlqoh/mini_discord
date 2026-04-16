CREATE TABLE IF NOT EXISTS servers (
    id bigserial PRIMARY KEY,
    name TEXT NOT NULL CHECK (char_length(name) <= 16),
    owner_id bigint REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS server_members (
    user_id bigint REFERENCES users(id) ON DELETE CASCADE,
    server_id bigint REFERENCES servers(id) ON DELETE CASCADE,
    joined_at TIMESTAMP DEFAULT now(),
    PRIMARY KEY (user_id, server_id)
);

CREATE TABLE IF NOT EXISTS channels (
    id bigserial PRIMARY KEY,
    server_id bigint REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (char_length(name) <= 16),
    type TEXT DEFAULT 'text',
    position INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
    id bigserial PRIMARY KEY,
    channel_id bigint REFERENCES channels(id) ON DELETE CASCADE,
    author_id bigint REFERENCES users(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT now(),
    edited_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created
    ON messages(channel_id, created_at DESC, id DESC);

