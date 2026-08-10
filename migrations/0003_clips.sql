-- Clips, proxy videos, and social features.
--
-- proxy_videos: low-quality proxy uploads for the clip page preview.
--   A video can have more than one proxy (e.g. 360p, 480p).
--   The `label` is a short human-readable name shown in the proxy selector.
-- clips: user-created time-range segments. Public clips are listed on the
--         main gallery and the shared area of the clip page.
-- clip_likes: one like per identity per clip (composite PK enforces this).
-- clip_reports: user reports on public clips, resolved by an admin.

CREATE TABLE IF NOT EXISTS proxy_videos (
    file_path    TEXT NOT NULL,         -- references files.path (not unique — multiple proxies per file)
    key          TEXT NOT NULL UNIQUE,  -- R2 object name for the proxy file
    label        TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    size         INTEGER NOT NULL,
    uploaded_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- `/api/proxy?file_path=` runs on every clip-page load; without this it is a
-- full scan of the table.
CREATE INDEX IF NOT EXISTS idx_proxy_videos_file_path ON proxy_videos(file_path);

CREATE TABLE IF NOT EXISTS clips (
    id          TEXT NOT NULL PRIMARY KEY,  -- UUID
    file_path   TEXT NOT NULL,              -- references files.path
    identity    TEXT NOT NULL,              -- opaque identity token (HMAC of user id)
    nickname    TEXT NOT NULL DEFAULT '',   -- display name chosen by the user
    name        TEXT NOT NULL DEFAULT '',   -- clip name
    description TEXT NOT NULL DEFAULT '',   -- clip description
    start_time  REAL NOT NULL,              -- seconds
    end_time    REAL NOT NULL,              -- seconds
    is_public   INTEGER NOT NULL DEFAULT 0,
    is_featured INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The public list is always `WHERE is_public = 1 AND file_path = ?`; a composite
-- index serves it, whereas is_public alone is two-valued and useless on its own.
CREATE INDEX IF NOT EXISTS idx_clips_public_path ON clips(is_public, file_path);
CREATE INDEX IF NOT EXISTS idx_clips_file_path   ON clips(file_path);
CREATE INDEX IF NOT EXISTS idx_clips_identity    ON clips(identity);

CREATE TABLE IF NOT EXISTS clip_likes (
    clip_id    TEXT NOT NULL,
    identity   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (clip_id, identity)
);

CREATE TABLE IF NOT EXISTS clip_reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    clip_id    TEXT NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    identity   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_clip_reports_resolved ON clip_reports(resolved);
-- The dedupe check on report insert and the cascades on clip delete both filter
-- by clip_id; `identity` backs the batch-delete cleanup.
CREATE INDEX IF NOT EXISTS idx_clip_reports_clip_id  ON clip_reports(clip_id);
CREATE INDEX IF NOT EXISTS idx_clip_likes_identity   ON clip_likes(identity);
