-- Announcements ("公告"): admin-authored posts shown at the top of the gallery.
--
-- The only tables in this schema that name no file. Everything else here hangs
-- off `files.path` (clips, sets, proxies, attachments) and is therefore in
-- `repoint_file_path` and the four `delete_*_for_path` functions. An
-- announcement is site-wide, so it joins nothing, moves with no rename and
-- survives every file delete — deliberately, and it is the reason these tables
-- need no entry in any of those.
--
-- Two flags, and they are not the same kind of flag:
--
--   `is_published` is **visibility** — the single source of truth for whether
--     `/api/announcements` returns the row, same role `clips.is_public` plays.
--     Nothing else may gate visibility; two visibility flags eventually
--     disagree and then nobody can say why an announcement is not showing.
--   `pinned` is **ordering only**, exactly as `clips.set_id` is grouping only.
--     Any number of rows may be pinned; the list is one flat
--     `ORDER BY pinned DESC, created_at DESC`, so pinning re-sorts and never
--     filters. A pinned-but-unpublished row is simply not returned — the two
--     flags compose instead of competing.

CREATE TABLE IF NOT EXISTS announcements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL DEFAULT '',
    pinned       INTEGER NOT NULL DEFAULT 0,
    is_published INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- `/api/announcements` runs on every gallery load, which is the most-hit page
-- on the site. The column order matches the query's: `is_published` filters,
-- then `pinned` and `created_at` supply the sort, so SQLite can serve the whole
-- statement from the index instead of sorting the table.
CREATE INDEX IF NOT EXISTS idx_announcements_feed
    ON announcements(is_published, pinned DESC, created_at DESC);

-- Media and downloads carried by an announcement: a poster image, a teaser
-- video, a PDF. One R2 object per row, in the same bucket as everything else,
-- served by the existing `/api/file/{key}` route — which does no D1 read and
-- re-clamps any non-media stored type to `application/octet-stream`, so an
-- announcement needs no serve route of its own (same reasoning as
-- `file_attachments`).
--
-- **One table for both**, unlike the deliberate `proxy_videos` /
-- `file_attachments` split. That split exists because the two are read by
-- different hot routes and merging them would put a `WHERE kind =` on
-- `/api/proxy`. Here both are read by the *same* query on the *same* route —
-- the announcement feed hands the whole list to the page at once — so a `kind`
-- column would be a filter nobody runs plus a second thing to keep in sync with
-- `content_type`. The renderer decides: `image/` `video/` `audio/` go inline,
-- everything else is offered as a download.
--
-- `filename` exists for the same reason it does on `file_attachments`: `key` is
-- an opaque storage name, so `/api/file/{key}?download=1` cannot derive a
-- display name from it and has to be handed one as `&name=`.
--
-- No foreign key: D1 does not enforce them unless `PRAGMA foreign_keys` is on
-- per connection, so the delete fan-out in `DELETE /admin/api/announcements/{id}`
-- is the real guarantee — and it has to run anyway, because dropping the rows
-- is what strands the R2 objects nothing else enumerates.
CREATE TABLE IF NOT EXISTS announcement_media (
    announcement_id INTEGER NOT NULL,      -- references announcements.id
    key             TEXT NOT NULL UNIQUE,  -- R2 object name
    label           TEXT NOT NULL DEFAULT '',
    filename        TEXT NOT NULL DEFAULT '',
    content_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
    size            INTEGER NOT NULL,
    uploaded_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The feed fetches every published announcement's media in one statement
-- keyed on this column; without the index that is a full scan on the gallery's
-- first paint.
CREATE INDEX IF NOT EXISTS idx_announcement_media_announcement
    ON announcement_media(announcement_id);
