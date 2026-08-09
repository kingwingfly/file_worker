-- Split the display path from the R2 storage key.
--
-- `key` becomes immutable: it is the R2 object name and nothing else ever
-- changes it, so `/api/file/{key}` URLs stay valid forever.
-- `path` is the mutable name shown in the UI. Renaming is now a single UPDATE
-- on this column instead of a byte-for-byte R2 CopyObject, so it is instant and
-- independent of file size.
--
-- Existing rows carry `path = key`, which is exactly what they meant before.

ALTER TABLE files ADD COLUMN path TEXT;

UPDATE files SET path = key WHERE path IS NULL;

-- Duplicate-name detection now runs against `path`. `key` keeps its own UNIQUE
-- constraint from 0001 — two rows must never point at the same R2 object.
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_path ON files(path);
