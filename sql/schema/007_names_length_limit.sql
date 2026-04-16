-- +goose Up
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'servers_name_len_chk') THEN
        ALTER TABLE servers
            ADD CONSTRAINT servers_name_len_chk CHECK (char_length(name) <= 16);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'channels_name_len_chk') THEN
        ALTER TABLE channels
            ADD CONSTRAINT channels_name_len_chk CHECK (char_length(name) <= 16);
    END IF;
END $$;

-- +goose Down
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_name_len_chk;
ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_name_len_chk;


