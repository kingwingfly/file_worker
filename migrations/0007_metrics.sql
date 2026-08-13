-- Play and download counts, aggregated per file per day.
--
-- **Counters, not an event log.** A row per play would grow without bound in a
-- database whose only reader is one admin page asking "what is popular", and
-- nothing here ever needs to replay a single event. One upsert per event keeps
-- the table proportional to files × days lived instead of to traffic.
--
-- Keyed on `file_path`, the mutable display name, like every other table that
-- hangs off a file — so it is in `repoint_file_path` (a renamed video keeps its
-- history; leaving it out would silently reset every count to zero) and in the
-- file-delete fan-out. It owns no R2 object, so it is deleted on the same side
-- of that route's bail as the clips: after the object failures are checked,
-- never before, because dropping it is pure irreversible loss.
--
-- It is deliberately **not** in `count_attached`. That number is the "this is
-- what you are about to destroy" confirmation, and it lists user content —
-- clips, sets, attachments, proxies. A view counter is not something the admin
-- is being asked to weigh.
--
-- `day` is UTC (`date('now')`), because that is the only clock D1 has. The
-- dashboard says so rather than pretending the buckets are local days.
CREATE TABLE IF NOT EXISTS file_metrics (
    file_path TEXT NOT NULL,             -- references files.path
    day       TEXT NOT NULL,             -- 'YYYY-MM-DD', UTC
    plays     INTEGER NOT NULL DEFAULT 0,
    downloads INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (file_path, day)
);

-- The dashboard's two queries are both "the last N days": a daily series across
-- all files, and a per-file total. The primary key already covers lookups by
-- path, so this is the other axis.
CREATE INDEX IF NOT EXISTS idx_file_metrics_day ON file_metrics(day);
