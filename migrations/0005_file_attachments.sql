-- File attachments ("关联文件"): subtitles, transcripts, notes — anything an
-- admin wants to hand to viewers alongside a video.
--
-- Deliberately a separate table from `proxy_videos` rather than a `kind` column
-- on it: a proxy is a *playback source* (the clip page puts it in the source
-- selector and cuts against it) and an attachment is a *download*. They share
-- the upload path and nothing else, and merging them would put a `WHERE kind=`
-- on `/api/proxy`, which runs on every clip-page load.
--
-- `filename` exists because `key` is an opaque storage name (migration 0002):
-- `/api/file/{key}?download=1` cannot derive a display name from it, so the
-- real one has to be stored and passed back as `&name=`.
--
-- `file_path` joins on `files.path`, which rename mutates by design, so this
-- table is in `db::repoint_file_path` next to clips, proxies and clip_sets.
-- Leaving it out silently detaches every attachment on rename.

CREATE TABLE IF NOT EXISTS file_attachments (
    file_path    TEXT NOT NULL,         -- references files.path (many per file)
    key          TEXT NOT NULL UNIQUE,  -- R2 object name for the attachment
    label        TEXT NOT NULL DEFAULT '',
    filename     TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size         INTEGER NOT NULL,
    uploaded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- `/api/attachments?file_path=` runs on every clip-page load, same as the proxy
-- listing; without this it is a full scan.
CREATE INDEX IF NOT EXISTS idx_file_attachments_file_path ON file_attachments(file_path);
