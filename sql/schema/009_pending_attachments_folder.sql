-- +goose Up
ALTER TABLE pending_attachments ADD COLUMN IF NOT EXISTS folder_key TEXT NOT NULL DEFAULT '';

UPDATE pending_attachments SET folder_key = file_key;

ALTER TABLE pending_attachments ALTER COLUMN folder_key DROP DEFAULT;

CREATE INDEX IF NOT EXISTS idx_pending_attachments_user_folder ON pending_attachments(user_id, folder_key);

-- +goose Down
DROP INDEX IF EXISTS idx_pending_attachments_user_folder;
ALTER TABLE pending_attachments DROP COLUMN IF EXISTS folder_key;