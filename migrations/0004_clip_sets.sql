-- Clip sets ("归档"): a named, ordered group of clips published as one unit.
--
-- `set_id` is pure grouping. `clips.is_public` stays the only visibility flag —
-- two sources of truth on visibility would eventually disagree, and the main
-- page still wants one flat list of public clips regardless of grouping, which
-- a nullable `set_id` gives for free.
--
-- Sorting a set "by likes" sums the likes of its member clips rather than
-- introducing set-level likes: no new table, and the per-clip heart on the
-- gallery player keeps meaning exactly what it did before.
--
-- `file_path` joins on `files.path`, which rename mutates by design, so
-- `db::repoint_file_path` must update this table too (see CLAUDE.md).

CREATE TABLE IF NOT EXISTS clip_sets (
    id          TEXT NOT NULL PRIMARY KEY,
    file_path   TEXT NOT NULL,
    identity    TEXT NOT NULL,
    nickname    TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clip_sets_file_path ON clip_sets(file_path);
CREATE INDEX IF NOT EXISTS idx_clip_sets_identity  ON clip_sets(identity);

-- Nullable on purpose: a clip published on its own has no set, and every
-- existing row predates sets entirely.
ALTER TABLE clips ADD COLUMN set_id TEXT;

CREATE INDEX IF NOT EXISTS idx_clips_set_id ON clips(set_id);
