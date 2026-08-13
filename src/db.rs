use serde::{Deserialize, Serialize};
use worker::{wasm_bindgen::JsValue, D1Type, Result};

/// One row of `files`.
///
/// `key` is the R2 object name and never changes once written — that is what
/// keeps `/api/file/{key}` URLs stable. `path` is the mutable name the UI shows
/// and the one duplicate detection works against. See migration 0002.
#[derive(Debug, Serialize, Deserialize)]
pub struct FileRecord {
    pub key: String,
    pub path: String,
    pub size: i64,
    pub content_type: String,
    pub uploaded_at: String,
    /// R2 key of this file's cover image (migration 0008), or `None`.
    ///
    /// May point at an object this column owns (`covers/…`) *or* at one of the
    /// file's own attachments, so it is never deleted without checking who else
    /// names it. Serialised to the public listing, which is what lets the
    /// gallery draw a poster instead of an emoji.
    #[serde(default)]
    pub cover_key: Option<String>,
}

/// Migration 0002 backfills `path` for every existing row, so the COALESCE here
/// is only a belt-and-braces default for reads. Lookups below deliberately do
/// *not* use it: `WHERE COALESCE(path, key) = ?` is an expression SQLite cannot
/// match against `idx_files_path`, which turns every one of them — including
/// `path_exists` on the upload path — into a full table scan.
const SELECT_COLS: &str =
    "key, COALESCE(path, key) AS path, size, content_type, uploaded_at, cover_key";

/// List files from D1 with optional filter and pagination
pub async fn list_files(
    ctx: &worker::RouteContext<()>,
    filter: &str,
    offset: u32,
    limit: u32,
) -> Result<Vec<FileRecord>> {
    let db = ctx.d1("DB")?;

    let where_clause = match filter {
        "image" => "WHERE content_type LIKE 'image/%' ",
        "video" => "WHERE content_type LIKE 'video/%' ",
        "audio" => "WHERE content_type LIKE 'audio/%' ",
        _ => "",
    };
    let query = format!(
        "SELECT {SELECT_COLS} FROM files {where_clause}ORDER BY uploaded_at DESC LIMIT ? OFFSET ?"
    );

    let params = vec![
        JsValue::from(&D1Type::Integer(limit as i32)),
        JsValue::from(&D1Type::Integer(offset as i32)),
    ];

    let result = db.prepare(&query).bind(&params)?.all().await?;
    let files: Vec<FileRecord> = result.results()?;
    Ok(files)
}

/// Insert a file record into D1.
///
/// Plain INSERT, not INSERT OR REPLACE: `key` is freshly generated per upload,
/// so a replace would never fire on the key and a collision on `path` must be
/// resolved by the caller (which knows the old row's `key` and can delete that
/// R2 object instead of orphaning it).
pub async fn insert_file(
    ctx: &worker::RouteContext<()>,
    key: &str,
    path: &str,
    size: i64,
    content_type: &str,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    db.prepare(
        "INSERT INTO files (key, path, size, content_type, uploaded_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .bind(&[
        JsValue::from(&D1Type::Text(key)),
        JsValue::from(&D1Type::Text(path)),
        // D1Type has no 64-bit integer; Integer(i32) truncates over 2 GB.
        JsValue::from(&D1Type::Real(size as f64)),
        JsValue::from(&D1Type::Text(content_type)),
    ])?
    .run()
    .await?;
    Ok(())
}

/// Delete a file record from D1 by display path
pub async fn delete_by_path(ctx: &worker::RouteContext<()>, path: &str) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("DELETE FROM files WHERE path = ?")
        .bind(&[JsValue::from(&D1Type::Text(path))])?
        .run()
        .await?;
    Ok(result.success())
}

/// Look up a row by its display path — this is how an admin request that names
/// a file resolves the R2 object it actually has to touch.
pub async fn get_by_path(
    ctx: &worker::RouteContext<()>,
    path: &str,
) -> Result<Option<FileRecord>> {
    let db = ctx.d1("DB")?;
    let query = format!("SELECT {SELECT_COLS} FROM files WHERE path = ?");
    let result = db
        .prepare(&query)
        .bind(&[JsValue::from(&D1Type::Text(path))])?
        .first::<FileRecord>(None)
        .await?;
    Ok(result)
}

/// Check whether a display path is already taken
pub async fn path_exists(ctx: &worker::RouteContext<()>, path: &str) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("SELECT COUNT(*) as cnt FROM files WHERE path = ?")
        .bind(&[JsValue::from(&D1Type::Text(path))])?
        .first::<i64>(Some("cnt"))
        .await?;
    Ok(result.unwrap_or(0) > 0)
}

/// Rename a file — a pure metadata update. The R2 object is not touched, which
/// is what makes this O(1) instead of O(file size).
///
/// Returns false if no row carried `old_path`.
pub async fn rename_path(
    ctx: &worker::RouteContext<()>,
    old_path: &str,
    new_path: &str,
) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("UPDATE files SET path = ? WHERE path = ?")
        .bind(&[
            JsValue::from(&D1Type::Text(new_path)),
            JsValue::from(&D1Type::Text(old_path)),
        ])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) > 0)
}

/// Everything attached to a display path, counted for the delete confirmation.
#[derive(Debug, Serialize, Deserialize)]
pub struct AttachedCounts {
    pub clips: i32,
    pub clip_sets: i32,
    pub attachments: i32,
    pub proxies: i32,
}

impl AttachedCounts {
    pub fn is_empty(&self) -> bool {
        self.clips == 0 && self.clip_sets == 0 && self.attachments == 0 && self.proxies == 0
    }
}

/// Count everything bound to a display path, for the delete confirmation dialog.
///
/// Deliberately **no `is_public` filter** on `clips`: the dialog reports how much
/// is about to be destroyed, and private clips are destroyed exactly like public
/// ones. Reusing `list_clips` here would have counted only the public ones and
/// told the admin "3" while purging 40 — a confirmation that understates
/// irreversible loss is worse than no confirmation at all. The number this
/// returns is the same population `delete_clips_for_path` reports afterwards,
/// which is the cheap way to check the two have not drifted.
pub async fn count_attached(
    ctx: &worker::RouteContext<()>,
    file_path: &str,
) -> Result<AttachedCounts> {
    let db = ctx.d1("DB")?;
    // One round trip. Four separate binds rather than `?1` reused — worker-rs
    // binds a positional array and numbered parameters are not part of that API.
    let row = db
        .prepare(
            "SELECT (SELECT COUNT(*) FROM clips WHERE file_path = ?) AS clips, \
                    (SELECT COUNT(*) FROM clip_sets WHERE file_path = ?) AS clip_sets, \
                    (SELECT COUNT(*) FROM file_attachments WHERE file_path = ?) AS attachments, \
                    (SELECT COUNT(*) FROM proxy_videos WHERE file_path = ?) AS proxies",
        )
        .bind(&[
            JsValue::from(&D1Type::Text(file_path)),
            JsValue::from(&D1Type::Text(file_path)),
            JsValue::from(&D1Type::Text(file_path)),
            JsValue::from(&D1Type::Text(file_path)),
        ])?
        .first::<AttachedCounts>(None)
        .await?;
    Ok(row.unwrap_or(AttachedCounts {
        clips: 0,
        clip_sets: 0,
        attachments: 0,
        proxies: 0,
    }))
}

// ── Proxy video records ──

#[derive(Debug, Serialize, Deserialize)]
pub struct ProxyRecord {
    pub file_path: String,
    pub key: String,
    pub label: String,
    pub content_type: String,
    pub size: i64,
    pub uploaded_at: String,
}

pub async fn insert_proxy(
    ctx: &worker::RouteContext<()>,
    file_path: &str,
    key: &str,
    label: &str,
    content_type: &str,
    size: i64,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    db.prepare(
        "INSERT INTO proxy_videos (file_path, key, label, content_type, size, uploaded_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
    )
    .bind(&[
        JsValue::from(&D1Type::Text(file_path)),
        JsValue::from(&D1Type::Text(key)),
        JsValue::from(&D1Type::Text(label)),
        JsValue::from(&D1Type::Text(content_type)),
        JsValue::from(&D1Type::Real(size as f64)),
    ])?
    .run()
    .await?;
    Ok(())
}

/// List all proxies for a given file_path.
pub async fn list_proxies(
    ctx: &worker::RouteContext<()>,
    file_path: &str,
) -> Result<Vec<ProxyRecord>> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("SELECT file_path, key, label, content_type, size, uploaded_at FROM proxy_videos WHERE file_path = ? ORDER BY uploaded_at DESC")
        .bind(&[JsValue::from(&D1Type::Text(file_path))])?
        .all()
        .await?;
    result.results::<ProxyRecord>()
}

/// Every proxy R2 key attached to a file path.
///
/// Used by the file-delete route: proxies are separate R2 objects, and nothing
/// else would ever find them again once the `files` row is gone.
pub async fn list_proxy_keys(
    ctx: &worker::RouteContext<()>,
    file_path: &str,
) -> Result<Vec<String>> {
    Ok(list_proxies(ctx, file_path)
        .await?
        .into_iter()
        .map(|p| p.key)
        .collect())
}

/// Drop every proxy row for a file path (the R2 objects are the caller's job).
pub async fn delete_proxies_for_path(
    ctx: &worker::RouteContext<()>,
    file_path: &str,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    db.prepare("DELETE FROM proxy_videos WHERE file_path = ?")
        .bind(&[JsValue::from(&D1Type::Text(file_path))])?
        .run()
        .await?;
    Ok(())
}

/// Does a proxy row exist for this R2 key?
///
/// `DELETE /admin/api/proxy?key=` deletes an R2 object; without this check a
/// mistyped key would delete a *source* file's bytes and leave its `files` row
/// pointing at nothing.
pub async fn proxy_exists(ctx: &worker::RouteContext<()>, key: &str) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let found = db
        .prepare("SELECT COUNT(*) AS cnt FROM proxy_videos WHERE key = ?")
        .bind(&[JsValue::from(&D1Type::Text(key))])?
        .first::<i32>(Some("cnt"))
        .await?;
    Ok(found.unwrap_or(0) > 0)
}

/// Delete a proxy by its R2 key.
pub async fn delete_proxy_by_key(
    ctx: &worker::RouteContext<()>,
    key: &str,
) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("DELETE FROM proxy_videos WHERE key = ?")
        .bind(&[JsValue::from(&D1Type::Text(key))])?
        .run()
        .await?;
    // `run()` reports success for a DELETE that matched nothing, so check the
    // row count instead — the admin UI needs to tell "gone" from "never existed".
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) > 0)
}

/// Make a proxy the file's own source: point the `files` row at its R2 object
/// and stop listing it as a proxy.
///
/// This is how "delete the 40 GB original but keep everything built on it"
/// works. `files.path` never moves, so clips, clip sets, attachments and the
/// remaining proxies stay attached with no repointing at all — they all join on
/// the path, and a proxy shares the original's timeline, so every clip's time
/// range still means what it meant.
///
/// It does **not** violate key immutability (CLAUDE.md): no key's bytes change,
/// the proxy's object is exactly what it always was. What moves is the row → key
/// mapping. Links to the *deleted* original's key break, but that is inherent to
/// deleting it and is equally true of a plain delete.
///
/// The two writes go through `batch`, which D1 runs as a transaction, so the
/// intermediate state never exists. Keep them in this order anyway: if they are
/// ever unwound into two calls, `UPDATE files` must land first. Deleting the
/// proxy row first and then failing the update leaves an R2 object no table
/// names — unenumerable, and therefore a permanent leak. The reverse failure
/// leaves the same key in both tables, which is visible and repairable.
pub async fn promote_proxy_to_file(
    ctx: &worker::RouteContext<()>,
    file_path: &str,
    proxy: &ProxyRecord,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    let update = db
        .prepare("UPDATE files SET key = ?, size = ?, content_type = ? WHERE path = ?")
        .bind(&[
            JsValue::from(&D1Type::Text(&proxy.key)),
            // Real, not Integer — D1Type has no 64-bit int (see CLAUDE.md).
            JsValue::from(&D1Type::Real(proxy.size as f64)),
            JsValue::from(&D1Type::Text(&proxy.content_type)),
            JsValue::from(&D1Type::Text(file_path)),
        ])?;
    let drop_proxy = db
        .prepare("DELETE FROM proxy_videos WHERE key = ?")
        .bind(&[JsValue::from(&D1Type::Text(&proxy.key))])?;
    db.batch(vec![update, drop_proxy]).await?;
    Ok(())
}

/// One proxy row by its R2 key.
pub async fn get_proxy_by_key(
    ctx: &worker::RouteContext<()>,
    key: &str,
) -> Result<Option<ProxyRecord>> {
    let db = ctx.d1("DB")?;
    db.prepare(
        "SELECT file_path, key, label, content_type, size, uploaded_at FROM proxy_videos WHERE key = ?",
    )
    .bind(&[JsValue::from(&D1Type::Text(key))])?
    .first::<ProxyRecord>(None)
    .await
}

/// Fold a standalone file into another file's collection as a proxy.
///
/// The inverse of `promote_proxy_to_file`, and the reason both exist: a
/// "collection" here is just a `files` row plus the `proxy_videos` and
/// `file_attachments` rows that name its path, so grouping two separately
/// uploaded encodes is a matter of moving one row between two tables. No bytes
/// move — the R2 object keeps the key it was minted with, which is why a 40 GB
/// file can be regrouped instantly.
///
/// The caller must have checked that `source` has nothing of its own attached;
/// its `files` row disappears here, and anything keyed on its path would be
/// orphaned with no way left to enumerate it (same reasoning as the delete
/// route). One `batch` so the row is never in both tables or neither.
pub async fn attach_file_as_proxy(
    ctx: &worker::RouteContext<()>,
    source: &FileRecord,
    target_path: &str,
    label: &str,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    let drop_file = db
        .prepare("DELETE FROM files WHERE path = ?")
        .bind(&[JsValue::from(&D1Type::Text(&source.path))])?;
    let add_proxy = db
        .prepare(
            "INSERT INTO proxy_videos (file_path, key, label, content_type, size, uploaded_at) \
             VALUES (?, ?, ?, ?, ?, datetime('now'))",
        )
        .bind(&[
            JsValue::from(&D1Type::Text(target_path)),
            JsValue::from(&D1Type::Text(&source.key)),
            JsValue::from(&D1Type::Text(label)),
            JsValue::from(&D1Type::Text(&source.content_type)),
            JsValue::from(&D1Type::Real(source.size as f64)),
        ])?;
    db.batch(vec![drop_file, add_proxy]).await?;
    Ok(())
}

/// Lift a proxy back out of a collection into a file of its own.
///
/// The undo for `attach_file_as_proxy` — without it, an accidental attach could
/// only be reversed by deleting the proxy, which throws the bytes away. Again
/// D1-only: the object keeps its key, the row changes tables.
///
/// `new_path` must be free; `idx_files_path` is UNIQUE and the caller checks it
/// first so the admin gets a 409 rather than a raw constraint error.
pub async fn detach_proxy_to_file(
    ctx: &worker::RouteContext<()>,
    proxy: &ProxyRecord,
    new_path: &str,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    let drop_proxy = db
        .prepare("DELETE FROM proxy_videos WHERE key = ?")
        .bind(&[JsValue::from(&D1Type::Text(&proxy.key))])?;
    let add_file = db
        .prepare("INSERT INTO files (key, path, size, content_type) VALUES (?, ?, ?, ?)")
        .bind(&[
            JsValue::from(&D1Type::Text(&proxy.key)),
            JsValue::from(&D1Type::Text(new_path)),
            JsValue::from(&D1Type::Real(proxy.size as f64)),
            JsValue::from(&D1Type::Text(&proxy.content_type)),
        ])?;
    db.batch(vec![drop_proxy, add_file]).await?;
    Ok(())
}

// ── File attachment records ──
//
// Subtitles, transcripts, notes — files an admin binds to a video for viewers
// to download. Structurally a twin of `proxy_videos` (many per `files.path`,
// one R2 object each) with one extra column: `filename`. A proxy is only ever
// played, so its opaque key is enough; an attachment is downloaded, and
// `/api/file/{key}?download=1` has no way to derive a display name from a key.

#[derive(Debug, Serialize, Deserialize)]
pub struct AttachmentRecord {
    pub file_path: String,
    pub key: String,
    pub label: String,
    pub filename: String,
    pub content_type: String,
    pub size: i64,
    pub uploaded_at: String,
}

const ATTACHMENT_COLUMNS: &str =
    "file_path, key, label, filename, content_type, size, uploaded_at";

pub async fn insert_attachment(
    ctx: &worker::RouteContext<()>,
    file_path: &str,
    key: &str,
    label: &str,
    filename: &str,
    content_type: &str,
    size: i64,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    db.prepare(
        "INSERT INTO file_attachments (file_path, key, label, filename, content_type, size, uploaded_at) \
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
    )
    .bind(&[
        JsValue::from(&D1Type::Text(file_path)),
        JsValue::from(&D1Type::Text(key)),
        JsValue::from(&D1Type::Text(label)),
        JsValue::from(&D1Type::Text(filename)),
        JsValue::from(&D1Type::Text(content_type)),
        // Real, not Integer — D1Type has no 64-bit int and an attachment is not
        // guaranteed to be small (a transcript bundle, a reference render).
        JsValue::from(&D1Type::Real(size as f64)),
    ])?
    .run()
    .await?;
    Ok(())
}

/// List every attachment bound to a file path, newest first.
pub async fn list_attachments(
    ctx: &worker::RouteContext<()>,
    file_path: &str,
) -> Result<Vec<AttachmentRecord>> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare(&format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM file_attachments WHERE file_path = ? ORDER BY uploaded_at DESC"
        ))
        .bind(&[JsValue::from(&D1Type::Text(file_path))])?
        .all()
        .await?;
    result.results::<AttachmentRecord>()
}

/// Every attachment R2 key bound to a file path.
///
/// Same role as `list_proxy_keys`: once the `files` row is gone nothing can
/// enumerate these objects again, so file-delete has to collect them first.
pub async fn list_attachment_keys(
    ctx: &worker::RouteContext<()>,
    file_path: &str,
) -> Result<Vec<String>> {
    Ok(list_attachments(ctx, file_path)
        .await?
        .into_iter()
        .map(|a| a.key)
        .collect())
}

/// Drop every attachment row for a file path (the R2 objects are the caller's job).
pub async fn delete_attachments_for_path(
    ctx: &worker::RouteContext<()>,
    file_path: &str,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    db.prepare("DELETE FROM file_attachments WHERE file_path = ?")
        .bind(&[JsValue::from(&D1Type::Text(file_path))])?
        .run()
        .await?;
    Ok(())
}

/// Does an attachment row exist for this R2 key?
///
/// The same guard as `proxy_exists`, for the same reason: `DELETE
/// /admin/api/attachment?key=` deletes an R2 object, and without the lookup
/// `?key=uploads/…/video.mp4` would delete a source file's bytes and leave its
/// `files` row pointing at nothing.
pub async fn attachment_exists(ctx: &worker::RouteContext<()>, key: &str) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let found = db
        .prepare("SELECT COUNT(*) AS cnt FROM file_attachments WHERE key = ?")
        .bind(&[JsValue::from(&D1Type::Text(key))])?
        .first::<i32>(Some("cnt"))
        .await?;
    Ok(found.unwrap_or(0) > 0)
}

/// Delete an attachment by its R2 key.
pub async fn delete_attachment_by_key(
    ctx: &worker::RouteContext<()>,
    key: &str,
) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("DELETE FROM file_attachments WHERE key = ?")
        .bind(&[JsValue::from(&D1Type::Text(key))])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) > 0)
}

// ── Clip records ──

#[derive(Debug, Serialize, Deserialize)]
pub struct ClipRecord {
    pub id: String,
    pub file_path: String,
    pub identity: String,
    pub nickname: String,
    pub name: String,
    pub description: String,
    pub start_time: f64,
    pub end_time: f64,
    pub is_public: i32,
    pub is_featured: i32,
    pub like_count: Option<i32>,
    /// 1 when the caller passed to `get_clip`/`list_clips` has already liked this
    /// clip. The client needs this to pick POST vs DELETE on the like button —
    /// without it there is no way to tell the two states apart.
    pub liked: Option<i32>,
    /// The clip set this clip belongs to, or `None` for a clip published on its
    /// own. Pure grouping — `is_public` alone decides visibility.
    pub set_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// The R2 object key of the file this clip points into, resolved through
    /// `files.path`. A clip stores only the *display path*, which is the mutable
    /// name — so a caller that has a clip and wants to play or cut it has no way
    /// to build a `/api/file/{key}` URL without this. Everything on the clip page
    /// already knows the key from its own query string; the gallery's clip rank
    /// lists clips across every file and does not.
    ///
    /// `Option` because the join is a `LEFT JOIN`: a clip whose file was deleted
    /// out from under it still lists, with playback unavailable rather than the
    /// whole query failing.
    pub file_key: Option<String>,
    pub file_content_type: Option<String>,
    /// Needed by the clip page's `&size=` ranking, and by the export dialog to
    /// say how big the cut will be before it starts.
    pub file_size: Option<f64>,
}

/// A named group of clips, published as one unit.
///
/// `like_count` is the **sum** of the member clips' likes, not a set-level like
/// count — there is no `clip_set_likes` table. `clip_count` counts only public
/// members, so a set whose clips were individually unpublished reads as empty
/// rather than advertising clips a viewer cannot see.
#[derive(Debug, Serialize, Deserialize)]
pub struct ClipSetRecord {
    pub id: String,
    pub file_path: String,
    pub identity: String,
    pub nickname: String,
    pub name: String,
    pub description: String,
    pub clip_count: Option<i32>,
    pub like_count: Option<i32>,
    pub created_at: String,
    pub updated_at: String,
}

/// The `like_count` / `liked` projection shared by every clip query.
///
/// `liked` binds the viewer's identity, so it is always the **first** bound
/// parameter of any query built on top of this fragment.
const CLIP_COLUMNS: &str = "c.*, (SELECT COUNT(*) FROM clip_likes WHERE clip_id = c.id) AS like_count, \
     EXISTS(SELECT 1 FROM clip_likes WHERE clip_id = c.id AND identity = ?) AS liked, \
     f.key AS file_key, f.content_type AS file_content_type, f.size AS file_size";

/// The `FROM` that `CLIP_COLUMNS` is written against.
///
/// A `LEFT JOIN`, not an inner one: a clip whose file has been deleted should
/// still appear in its author's list (so they can see it and remove it) rather
/// than silently vanish from every query. `files.path` is UNIQUE
/// (`idx_files_path`), so this is an index lookup per row, not a scan — the same
/// index the upload hot path depends on.
const CLIP_FROM: &str = "FROM clips c LEFT JOIN files f ON f.path = c.file_path";

#[allow(clippy::too_many_arguments)]
pub async fn insert_clip(
    ctx: &worker::RouteContext<()>,
    id: &str,
    file_path: &str,
    identity: &str,
    nickname: &str,
    name: &str,
    description: &str,
    start_time: f64,
    end_time: f64,
    is_public: bool,
    set_id: Option<&str>,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    db.prepare(
        "INSERT INTO clips (id, file_path, identity, nickname, name, description, start_time, end_time, is_public, set_id, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
    )
    .bind(&[
        JsValue::from(&D1Type::Text(id)),
        JsValue::from(&D1Type::Text(file_path)),
        JsValue::from(&D1Type::Text(identity)),
        JsValue::from(&D1Type::Text(nickname)),
        JsValue::from(&D1Type::Text(name)),
        JsValue::from(&D1Type::Text(description)),
        JsValue::from(&D1Type::Real(start_time)),
        JsValue::from(&D1Type::Real(end_time)),
        JsValue::from(&D1Type::Integer(if is_public { 1 } else { 0 })),
        match set_id {
            Some(s) => JsValue::from(&D1Type::Text(s)),
            None => JsValue::from(&D1Type::Null),
        },
    ])?
    .run()
    .await?;
    Ok(())
}

// ── Clip sets ──

/// `like_count` sums the member clips' likes; `clip_count` counts public members.
/// `viewer` is unused here (sets carry no per-viewer state) but the parameter
/// order of the clip queries is kept for symmetry at the call sites.
const CLIP_SET_COLUMNS: &str = "s.id, s.file_path, s.identity, s.nickname, s.name, s.description, \
     s.created_at, s.updated_at, \
     (SELECT COUNT(*) FROM clips WHERE set_id = s.id AND is_public = 1) AS clip_count, \
     (SELECT COUNT(*) FROM clip_likes WHERE clip_id IN \
        (SELECT id FROM clips WHERE set_id = s.id AND is_public = 1)) AS like_count";

pub async fn insert_clip_set(
    ctx: &worker::RouteContext<()>,
    id: &str,
    file_path: &str,
    identity: &str,
    nickname: &str,
    name: &str,
    description: &str,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    db.prepare(
        "INSERT INTO clip_sets (id, file_path, identity, nickname, name, description, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
    )
    .bind(&[
        JsValue::from(&D1Type::Text(id)),
        JsValue::from(&D1Type::Text(file_path)),
        JsValue::from(&D1Type::Text(identity)),
        JsValue::from(&D1Type::Text(nickname)),
        JsValue::from(&D1Type::Text(name)),
        JsValue::from(&D1Type::Text(description)),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn get_clip_set(
    ctx: &worker::RouteContext<()>,
    id: &str,
) -> Result<Option<ClipSetRecord>> {
    let db = ctx.d1("DB")?;
    db.prepare(&format!(
        "SELECT {CLIP_SET_COLUMNS} FROM clip_sets s WHERE s.id = ?"
    ))
    .bind(&[JsValue::from(&D1Type::Text(id))])?
    .first::<ClipSetRecord>(None)
    .await
}

/// List clip sets that still have at least one public clip.
///
/// A set with nothing public left is dead weight in the shared area — its author
/// unpublished every member — so it is filtered out rather than shown empty.
pub async fn list_clip_sets(
    ctx: &worker::RouteContext<()>,
    file_path: Option<&str>,
    sort: &str,
    offset: u32,
    limit: u32,
) -> Result<Vec<ClipSetRecord>> {
    let db = ctx.d1("DB")?;

    let where_clause = if file_path.is_some() {
        "WHERE s.file_path = ? "
    } else {
        ""
    };
    let order = match sort {
        "likes" => "ORDER BY like_count DESC, s.created_at DESC ",
        _ => "ORDER BY s.created_at DESC ",
    };
    let query = format!(
        "SELECT {CLIP_SET_COLUMNS} FROM clip_sets s {where_clause}\
         GROUP BY s.id HAVING clip_count > 0 {order}LIMIT ? OFFSET ?"
    );

    let mut params: Vec<JsValue> = Vec::new();
    if let Some(path) = file_path {
        params.push(JsValue::from(&D1Type::Text(path)));
    }
    params.push(JsValue::from(&D1Type::Integer(limit as i32)));
    params.push(JsValue::from(&D1Type::Integer(offset as i32)));

    let result = db.prepare(&query).bind(&params)?.all().await?;
    result.results::<ClipSetRecord>()
}

/// List every set regardless of whether its clips are public (admin view).
pub async fn list_all_clip_sets(
    ctx: &worker::RouteContext<()>,
    offset: u32,
    limit: u32,
) -> Result<Vec<ClipSetRecord>> {
    let db = ctx.d1("DB")?;
    let query = format!(
        "SELECT {CLIP_SET_COLUMNS} FROM clip_sets s ORDER BY s.created_at DESC LIMIT ? OFFSET ?"
    );
    let result = db
        .prepare(&query)
        .bind(&[
            JsValue::from(&D1Type::Integer(limit as i32)),
            JsValue::from(&D1Type::Integer(offset as i32)),
        ])?
        .all()
        .await?;
    result.results::<ClipSetRecord>()
}

/// List the public clips of one set, oldest start time first.
pub async fn list_clips_in_set(
    ctx: &worker::RouteContext<()>,
    set_id: &str,
    viewer: &str,
) -> Result<Vec<ClipRecord>> {
    let db = ctx.d1("DB")?;
    let query = format!(
        "SELECT {CLIP_COLUMNS} {CLIP_FROM} WHERE c.set_id = ? AND c.is_public = 1 \
         ORDER BY c.start_time ASC"
    );
    // `liked` binds first — see CLIP_COLUMNS.
    let result = db
        .prepare(&query)
        .bind(&[
            JsValue::from(&D1Type::Text(viewer)),
            JsValue::from(&D1Type::Text(set_id)),
        ])?
        .all()
        .await?;
    result.results::<ClipRecord>()
}

/// Delete a set and every clip in it.
///
/// The set is the unit that was published, so it is the unit that is withdrawn;
/// leaving the members behind as loose public clips would mean "delete" did not
/// remove what the author pointed at.
pub async fn delete_clip_set(ctx: &worker::RouteContext<()>, id: &str) -> Result<bool> {
    let db = ctx.d1("DB")?;
    for sql in [
        "DELETE FROM clip_likes WHERE clip_id IN (SELECT id FROM clips WHERE set_id = ?)",
        "UPDATE clip_reports SET resolved = 1 WHERE clip_id IN (SELECT id FROM clips WHERE set_id = ?)",
        "DELETE FROM clips WHERE set_id = ?",
    ] {
        let _ = db
            .prepare(sql)
            .bind(&[JsValue::from(&D1Type::Text(id))])?
            .run()
            .await;
    }
    let result = db
        .prepare("DELETE FROM clip_sets WHERE id = ?")
        .bind(&[JsValue::from(&D1Type::Text(id))])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) > 0)
}

/// Fetch one clip. `viewer` is the caller's identity id (empty for anonymous)
/// and only feeds the `liked` flag.
pub async fn get_clip(
    ctx: &worker::RouteContext<()>,
    id: &str,
    viewer: &str,
) -> Result<Option<ClipRecord>> {
    let db = ctx.d1("DB")?;
    db.prepare(&format!("SELECT {CLIP_COLUMNS} {CLIP_FROM} WHERE c.id = ?"))
        .bind(&[
            JsValue::from(&D1Type::Text(viewer)),
            JsValue::from(&D1Type::Text(id)),
        ])?
        .first::<ClipRecord>(None)
        .await
}

/// List public clips, optionally filtered by file_path.
///
/// `sort` is `"likes"` (most-liked first), `"time"` (newest first, the default),
/// or anything else (also newest first).
///
/// `loose_only` restricts the result to clips with no `set_id`. This has to be a
/// server-side filter: members of a published set are public clips like any
/// other, so a caller that wants only the ungrouped ones cannot get them by
/// filtering a capped page — one 200-clip set would fill the whole `limit` and
/// every loose clip would silently disappear from the list.
pub async fn list_clips(
    ctx: &worker::RouteContext<()>,
    file_path: Option<&str>,
    viewer: &str,
    sort: &str,
    loose_only: bool,
    offset: u32,
    limit: u32,
) -> Result<Vec<ClipRecord>> {
    let db = ctx.d1("DB")?;

    let where_clause = match (file_path.is_some(), loose_only) {
        (true, true) => "WHERE c.is_public = 1 AND c.set_id IS NULL AND c.file_path = ? ",
        (true, false) => "WHERE c.is_public = 1 AND c.file_path = ? ",
        (false, true) => "WHERE c.is_public = 1 AND c.set_id IS NULL ",
        (false, false) => "WHERE c.is_public = 1 ",
    };

    // Featured leads either ordering — that flag is the only thing the admin
    // "精选" toggle does, so it has to reach the list order to mean anything.
    let order = match sort {
        "likes" => "ORDER BY c.is_featured DESC, like_count DESC, c.created_at DESC ",
        _ => "ORDER BY c.is_featured DESC, c.created_at DESC ",
    };

    let query =
        format!("SELECT {CLIP_COLUMNS} {CLIP_FROM} {where_clause}{order}LIMIT ? OFFSET ?");

    // `liked` binds first — see CLIP_COLUMNS.
    let mut params: Vec<JsValue> = vec![JsValue::from(&D1Type::Text(viewer))];
    if let Some(path) = file_path {
        params.push(JsValue::from(&D1Type::Text(path)));
    }
    params.push(JsValue::from(&D1Type::Integer(limit as i32)));
    params.push(JsValue::from(&D1Type::Integer(offset as i32)));

    let result = db.prepare(&query).bind(&params)?.all().await?;
    result.results::<ClipRecord>()
}

/// List all clips regardless of public/private (admin view).
pub async fn list_all_clips(
    ctx: &worker::RouteContext<()>,
    offset: u32,
    limit: u32,
) -> Result<Vec<ClipRecord>> {
    let db = ctx.d1("DB")?;
    // The admin view has no viewer identity, so `liked` is always 0 here. The
    // file columns still come along: the admin clip list links to the file each
    // clip points at, and a NULL `file_key` is how it spots an orphan.
    let query = "SELECT c.*, (SELECT COUNT(*) FROM clip_likes WHERE clip_id = c.id) AS like_count, \
                 0 AS liked, f.key AS file_key, f.content_type AS file_content_type, f.size AS file_size \
                 FROM clips c LEFT JOIN files f ON f.path = c.file_path \
                 ORDER BY c.created_at DESC LIMIT ? OFFSET ?";
    let result = db
        .prepare(query)
        .bind(&[
            JsValue::from(&D1Type::Integer(limit as i32)),
            JsValue::from(&D1Type::Integer(offset as i32)),
        ])?
        .all()
        .await?;
    result.results::<ClipRecord>()
}

pub async fn delete_clip(ctx: &worker::RouteContext<()>, id: &str) -> Result<bool> {
    let db = ctx.d1("DB")?;
    // Delete likes first (FK-style cleanup, though no FK constraint exists)
    let _ = db
        .prepare("DELETE FROM clip_likes WHERE clip_id = ?")
        .bind(&[JsValue::from(&D1Type::Text(id))])?
        .run()
        .await;
    // Reports about a clip that no longer exists are not actionable — close them
    // so the admin queue does not fill up with rows pointing at nothing.
    let _ = db
        .prepare("UPDATE clip_reports SET resolved = 1 WHERE clip_id = ?")
        .bind(&[JsValue::from(&D1Type::Text(id))])?
        .run()
        .await;
    let result = db
        .prepare("DELETE FROM clips WHERE id = ?")
        .bind(&[JsValue::from(&D1Type::Text(id))])?
        .run()
        .await?;
    // `success()` is true even when the id matched nothing; callers use the
    // return value to decide between 200 and 404, so report the row count.
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) > 0)
}

/// Move every clip, proxy and attachment that references `old_path` onto `new_path`.
///
/// `clips.file_path`, `proxy_videos.file_path`, `clip_sets.file_path` and
/// `file_attachments.file_path` all join on `files.path`, which rename mutates
/// by design (see CLAUDE.md — the key is immutable, the path is not). Without
/// this, renaming a video silently detaches everything attached to it:
/// `/api/clips?file_path=`, `/api/proxy?file_path=` and
/// `/api/attachments?file_path=` are queried with the *new* name and match nothing.
///
/// The durable fix is to key both tables on the immutable `files.key` instead;
/// that is a schema migration, and this keeps the two names consistent until then.
pub async fn repoint_file_path(
    ctx: &worker::RouteContext<()>,
    old_path: &str,
    new_path: &str,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    for sql in [
        "UPDATE clips SET file_path = ? WHERE file_path = ?",
        "UPDATE proxy_videos SET file_path = ? WHERE file_path = ?",
        "UPDATE clip_sets SET file_path = ? WHERE file_path = ?",
        "UPDATE file_attachments SET file_path = ? WHERE file_path = ?",
        // Metrics move with the file too: a rename that left them behind would
        // silently reset a video's play count to zero, and the orphaned rows
        // would keep counting toward nothing.
        "UPDATE file_metrics SET file_path = ? WHERE file_path = ?",
    ] {
        db.prepare(sql)
            .bind(&[
                JsValue::from(&D1Type::Text(new_path)),
                JsValue::from(&D1Type::Text(old_path)),
            ])?
            .run()
            .await?;
    }
    Ok(())
}

/// Delete every clip (and its likes/reports) attached to a file path.
///
/// Returns the number of clips removed. Called when the underlying file is
/// deleted — a clip is a time range into bytes that no longer exist.
pub async fn delete_clips_for_path(
    ctx: &worker::RouteContext<()>,
    file_path: &str,
) -> Result<u32> {
    let db = ctx.d1("DB")?;
    for sql in [
        "DELETE FROM clip_likes WHERE clip_id IN (SELECT id FROM clips WHERE file_path = ?)",
        "UPDATE clip_reports SET resolved = 1 WHERE clip_id IN (SELECT id FROM clips WHERE file_path = ?)",
    ] {
        let _ = db
            .prepare(sql)
            .bind(&[JsValue::from(&D1Type::Text(file_path))])?
            .run()
            .await;
    }
    let result = db
        .prepare("DELETE FROM clips WHERE file_path = ?")
        .bind(&[JsValue::from(&D1Type::Text(file_path))])?
        .run()
        .await?;
    // The sets that grouped them describe a file that no longer exists.
    let _ = db
        .prepare("DELETE FROM clip_sets WHERE file_path = ?")
        .bind(&[JsValue::from(&D1Type::Text(file_path))])?
        .run()
        .await;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) as u32)
}

/// Re-point every clip of `identity` at a new display nickname.
///
/// `clips.nickname` is denormalised at insert time, so a nickname change has to
/// be pushed into the existing rows or the author's old clips keep the old name.
pub async fn rename_identity_nickname(
    ctx: &worker::RouteContext<()>,
    identity: &str,
    nickname: &str,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    for sql in [
        "UPDATE clips SET nickname = ?, updated_at = datetime('now') WHERE identity = ?",
        "UPDATE clip_sets SET nickname = ?, updated_at = datetime('now') WHERE identity = ?",
    ] {
        db.prepare(sql)
            .bind(&[
                JsValue::from(&D1Type::Text(nickname)),
                JsValue::from(&D1Type::Text(identity)),
            ])?
            .run()
            .await?;
    }
    Ok(())
}

/// Flip a clip between public and private. Used by `PATCH /api/clips/{id}`.
pub async fn set_clip_public(
    ctx: &worker::RouteContext<()>,
    id: &str,
    is_public: bool,
) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("UPDATE clips SET is_public = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(&[
            JsValue::from(&D1Type::Integer(if is_public { 1 } else { 0 })),
            JsValue::from(&D1Type::Text(id)),
        ])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) > 0)
}

pub async fn set_clip_featured(
    ctx: &worker::RouteContext<()>,
    id: &str,
    featured: bool,
) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("UPDATE clips SET is_featured = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(&[
            JsValue::from(&D1Type::Integer(if featured { 1 } else { 0 })),
            JsValue::from(&D1Type::Text(id)),
        ])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) > 0)
}

// ── Likes ──

pub async fn like_clip(ctx: &worker::RouteContext<()>, clip_id: &str, identity: &str) -> Result<()> {
    let db = ctx.d1("DB")?;
    db.prepare("INSERT OR IGNORE INTO clip_likes (clip_id, identity, created_at) VALUES (?, ?, datetime('now'))")
        .bind(&[
            JsValue::from(&D1Type::Text(clip_id)),
            JsValue::from(&D1Type::Text(identity)),
        ])?
        .run()
        .await?;
    Ok(())
}

pub async fn unlike_clip(ctx: &worker::RouteContext<()>, clip_id: &str, identity: &str) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("DELETE FROM clip_likes WHERE clip_id = ? AND identity = ?")
        .bind(&[
            JsValue::from(&D1Type::Text(clip_id)),
            JsValue::from(&D1Type::Text(identity)),
        ])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) > 0)
}

pub async fn get_like_count(ctx: &worker::RouteContext<()>, clip_id: &str) -> Result<i32> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("SELECT COUNT(*) as cnt FROM clip_likes WHERE clip_id = ?")
        .bind(&[JsValue::from(&D1Type::Text(clip_id))])?
        .first::<i32>(Some("cnt"))
        .await?;
    Ok(result.unwrap_or(0))
}

// A standalone `has_liked` used to live here. `ClipRecord::liked` (see
// CLIP_COLUMNS) answers the same question in the query that already fetches the
// clip, so an extra round trip is never needed.

// ── Reports ──

#[derive(Debug, Serialize, Deserialize)]
pub struct ClipReport {
    pub id: i32,
    pub clip_id: String,
    pub reason: String,
    pub identity: String,
    pub created_at: String,
    pub resolved: i32,
}

pub async fn report_clip(
    ctx: &worker::RouteContext<()>,
    clip_id: &str,
    reason: &str,
    identity: &str,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    // One *open* report per identity per clip. `/api/clips/{id}/report` is
    // unauthenticated beyond a self-issued cookie, so without this a single
    // caller can flood the admin queue with the same clip.
    db.prepare(
        "INSERT INTO clip_reports (clip_id, reason, identity, created_at) \
         SELECT ?, ?, ?, datetime('now') WHERE NOT EXISTS \
         (SELECT 1 FROM clip_reports WHERE clip_id = ? AND identity = ? AND resolved = 0)",
    )
    .bind(&[
        JsValue::from(&D1Type::Text(clip_id)),
        JsValue::from(&D1Type::Text(reason)),
        JsValue::from(&D1Type::Text(identity)),
        JsValue::from(&D1Type::Text(clip_id)),
        JsValue::from(&D1Type::Text(identity)),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn list_reports(
    ctx: &worker::RouteContext<()>,
    offset: u32,
    limit: u32,
) -> Result<Vec<ClipReport>> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare(
            "SELECT id, clip_id, reason, identity, created_at, resolved \
             FROM clip_reports WHERE resolved = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?",
        )
        .bind(&[
            JsValue::from(&D1Type::Integer(limit as i32)),
            JsValue::from(&D1Type::Integer(offset as i32)),
        ])?
        .all()
        .await?;
    result.results::<ClipReport>()
}

pub async fn resolve_report(ctx: &worker::RouteContext<()>, report_id: i32) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("UPDATE clip_reports SET resolved = 1 WHERE id = ?")
        .bind(&[JsValue::from(&D1Type::Integer(report_id))])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) > 0)
}

/// Batch-delete every clip (and their likes) from a given identity.
pub async fn delete_clips_by_identity(
    ctx: &worker::RouteContext<()>,
    identity: &str,
) -> Result<u32> {
    let db = ctx.d1("DB")?;
    // Delete likes for this identity's clips first
    let _ = db
        .prepare("DELETE FROM clip_likes WHERE clip_id IN (SELECT id FROM clips WHERE identity = ?)")
        .bind(&[JsValue::from(&D1Type::Text(identity))])?
        .run()
        .await;
    // Also delete likes BY this identity
    let _ = db
        .prepare("DELETE FROM clip_likes WHERE identity = ?")
        .bind(&[JsValue::from(&D1Type::Text(identity))])?
        .run()
        .await;
    // Close reports about the clips that are about to vanish, and drop reports
    // filed by this identity — batch-delete is the abuse hammer, and leaving the
    // offender's own reports queued defeats it.
    let _ = db
        .prepare(
            "UPDATE clip_reports SET resolved = 1 \
             WHERE clip_id IN (SELECT id FROM clips WHERE identity = ?)",
        )
        .bind(&[JsValue::from(&D1Type::Text(identity))])?
        .run()
        .await;
    let _ = db
        .prepare("DELETE FROM clip_reports WHERE identity = ?")
        .bind(&[JsValue::from(&D1Type::Text(identity))])?
        .run()
        .await;
    let result = db
        .prepare("DELETE FROM clips WHERE identity = ?")
        .bind(&[JsValue::from(&D1Type::Text(identity))])?
        .run()
        .await?;
    // Batch-delete is the abuse hammer; leaving the offender's sets behind would
    // leave named, attributed shells in the admin list pointing at nothing.
    let _ = db
        .prepare("DELETE FROM clip_sets WHERE identity = ?")
        .bind(&[JsValue::from(&D1Type::Text(identity))])?
        .run()
        .await;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) as u32)
}

// ── Announcements ──
//
// The one feature here that names no file: an announcement joins nothing, so
// it is absent from `repoint_file_path` and from every `delete_*_for_path`
// function by design, not by omission.

#[derive(Debug, Serialize, Deserialize)]
pub struct AnnouncementRecord {
    pub id: i32,
    pub title: String,
    pub body: String,
    /// Ordering only — see `is_published` for visibility. Any number of rows
    /// may carry it.
    pub pinned: i32,
    pub is_published: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AnnouncementMediaRecord {
    pub announcement_id: i32,
    pub key: String,
    pub label: String,
    pub filename: String,
    pub content_type: String,
    pub size: i64,
    pub uploaded_at: String,
}

const ANNOUNCEMENT_COLUMNS: &str =
    "id, title, body, pinned, is_published, created_at, updated_at";
const ANNOUNCEMENT_MEDIA_COLUMNS: &str =
    "announcement_id, key, label, filename, content_type, size, uploaded_at";

/// The feed's sort, shared by the public and admin listings so the admin sees
/// the order viewers get. Pinned first, then newest — `pinned` re-sorts and
/// never filters, which is what lets any number of rows carry it.
const ANNOUNCEMENT_ORDER: &str = "ORDER BY pinned DESC, created_at DESC";

/// List announcements, newest-with-pinned-first.
///
/// `published_only` is the *only* visibility gate. Everything else about an
/// announcement — pinning included — is presentation.
pub async fn list_announcements(
    ctx: &worker::RouteContext<()>,
    published_only: bool,
    offset: u32,
    limit: u32,
) -> Result<Vec<AnnouncementRecord>> {
    let db = ctx.d1("DB")?;
    let where_clause = if published_only {
        "WHERE is_published = 1 "
    } else {
        ""
    };
    let result = db
        .prepare(&format!(
            "SELECT {ANNOUNCEMENT_COLUMNS} FROM announcements {where_clause}\
             {ANNOUNCEMENT_ORDER} LIMIT ? OFFSET ?"
        ))
        .bind(&[
            JsValue::from(&D1Type::Integer(limit as i32)),
            JsValue::from(&D1Type::Integer(offset as i32)),
        ])?
        .all()
        .await?;
    result.results::<AnnouncementRecord>()
}

/// Every media row belonging to the page `list_announcements` would return.
///
/// Deliberately one statement for the whole page rather than one per row: the
/// gallery's first paint fetches the feed, and an announcement-per-request fan
/// out would put N round trips on it. The subquery repeats the listing's own
/// LIMIT/OFFSET so the two answers describe exactly the same page — widening it
/// to "all published" would ship media for announcements the caller never got.
pub async fn list_announcement_media_page(
    ctx: &worker::RouteContext<()>,
    published_only: bool,
    offset: u32,
    limit: u32,
) -> Result<Vec<AnnouncementMediaRecord>> {
    let db = ctx.d1("DB")?;
    let where_clause = if published_only {
        "WHERE is_published = 1 "
    } else {
        ""
    };
    let result = db
        .prepare(&format!(
            "SELECT {ANNOUNCEMENT_MEDIA_COLUMNS} FROM announcement_media \
             WHERE announcement_id IN (SELECT id FROM announcements {where_clause}\
             {ANNOUNCEMENT_ORDER} LIMIT ? OFFSET ?) ORDER BY uploaded_at ASC"
        ))
        .bind(&[
            JsValue::from(&D1Type::Integer(limit as i32)),
            JsValue::from(&D1Type::Integer(offset as i32)),
        ])?
        .all()
        .await?;
    result.results::<AnnouncementMediaRecord>()
}

pub async fn get_announcement(
    ctx: &worker::RouteContext<()>,
    id: i32,
) -> Result<Option<AnnouncementRecord>> {
    let db = ctx.d1("DB")?;
    db.prepare(&format!(
        "SELECT {ANNOUNCEMENT_COLUMNS} FROM announcements WHERE id = ?"
    ))
    .bind(&[JsValue::from(&D1Type::Integer(id))])?
    .first::<AnnouncementRecord>(None)
    .await
}

/// Insert an announcement and hand back its new id.
///
/// The id is read from D1's own `last_row_id` rather than a follow-up SELECT:
/// the caller needs it to attach media, and any "newest row" query would be a
/// race against a second admin tab.
pub async fn insert_announcement(
    ctx: &worker::RouteContext<()>,
    title: &str,
    body: &str,
    pinned: bool,
    is_published: bool,
) -> Result<i64> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare(
            "INSERT INTO announcements (title, body, pinned, is_published, created_at, updated_at) \
             VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
        )
        .bind(&[
            JsValue::from(&D1Type::Text(title)),
            JsValue::from(&D1Type::Text(body)),
            JsValue::from(&D1Type::Integer(pinned as i32)),
            JsValue::from(&D1Type::Integer(is_published as i32)),
        ])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|m| m.last_row_id).unwrap_or(0))
}

/// Rewrite an announcement's text.
///
/// Split from `set_announcement_flags` on purpose. The pin and publish toggles
/// live in a list the admin may have loaded minutes ago; if they carried the
/// whole record, one click would write that stale copy back over an edit made
/// in the editor since. Each writer touches only the columns it actually owns.
pub async fn update_announcement(
    ctx: &worker::RouteContext<()>,
    id: i32,
    title: &str,
    body: &str,
) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare(
            "UPDATE announcements SET title = ?, body = ?, updated_at = datetime('now') \
             WHERE id = ?",
        )
        .bind(&[
            JsValue::from(&D1Type::Text(title)),
            JsValue::from(&D1Type::Text(body)),
            JsValue::from(&D1Type::Integer(id)),
        ])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) > 0)
}

/// Set the two flags. See `update_announcement` for why this is its own write.
///
/// `updated_at` deliberately does not move: it is the text's timestamp, and the
/// feed shows it. Pinning an old announcement should not make it look rewritten.
pub async fn set_announcement_flags(
    ctx: &worker::RouteContext<()>,
    id: i32,
    pinned: bool,
    is_published: bool,
) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("UPDATE announcements SET pinned = ?, is_published = ? WHERE id = ?")
        .bind(&[
            JsValue::from(&D1Type::Integer(pinned as i32)),
            JsValue::from(&D1Type::Integer(is_published as i32)),
            JsValue::from(&D1Type::Integer(id)),
        ])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) > 0)
}

/// Drop the announcement row itself. Its media rows and their R2 objects are
/// the route's job, in that order — see `DELETE /admin/api/announcements/{id}`.
pub async fn delete_announcement(ctx: &worker::RouteContext<()>, id: i32) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("DELETE FROM announcements WHERE id = ?")
        .bind(&[JsValue::from(&D1Type::Integer(id))])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) > 0)
}

pub async fn insert_announcement_media(
    ctx: &worker::RouteContext<()>,
    announcement_id: i32,
    key: &str,
    label: &str,
    filename: &str,
    content_type: &str,
    size: i64,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    db.prepare(
        "INSERT INTO announcement_media \
         (announcement_id, key, label, filename, content_type, size, uploaded_at) \
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
    )
    .bind(&[
        JsValue::from(&D1Type::Integer(announcement_id)),
        JsValue::from(&D1Type::Text(key)),
        JsValue::from(&D1Type::Text(label)),
        JsValue::from(&D1Type::Text(filename)),
        JsValue::from(&D1Type::Text(content_type)),
        // Real, not Integer — same rule as everywhere else here. An
        // announcement can carry a teaser video, which is not small.
        JsValue::from(&D1Type::Real(size as f64)),
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn list_announcement_media(
    ctx: &worker::RouteContext<()>,
    announcement_id: i32,
) -> Result<Vec<AnnouncementMediaRecord>> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare(&format!(
            "SELECT {ANNOUNCEMENT_MEDIA_COLUMNS} FROM announcement_media \
             WHERE announcement_id = ? ORDER BY uploaded_at ASC"
        ))
        .bind(&[JsValue::from(&D1Type::Integer(announcement_id))])?
        .all()
        .await?;
    result.results::<AnnouncementMediaRecord>()
}

/// Every R2 key an announcement owns.
///
/// Same role as `list_proxy_keys` / `list_attachment_keys`: once the
/// announcement row is gone nothing can enumerate these objects again, so the
/// delete route has to collect them before it drops anything.
pub async fn list_announcement_media_keys(
    ctx: &worker::RouteContext<()>,
    announcement_id: i32,
) -> Result<Vec<String>> {
    Ok(list_announcement_media(ctx, announcement_id)
        .await?
        .into_iter()
        .map(|m| m.key)
        .collect())
}

/// Drop an announcement's media rows (the R2 objects are the caller's job).
pub async fn delete_announcement_media_for_id(
    ctx: &worker::RouteContext<()>,
    announcement_id: i32,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    db.prepare("DELETE FROM announcement_media WHERE announcement_id = ?")
        .bind(&[JsValue::from(&D1Type::Integer(announcement_id))])?
        .run()
        .await?;
    Ok(())
}

/// Does a media row exist for this R2 key?
///
/// The same guard as `proxy_exists` / `attachment_exists`, for the same reason:
/// `DELETE /admin/api/announcement-media?key=` deletes an R2 object, and
/// without the lookup `?key=uploads/…/video.mp4` would delete a gallery file's
/// bytes and leave its `files` row pointing at nothing.
pub async fn announcement_media_exists(
    ctx: &worker::RouteContext<()>,
    key: &str,
) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let found = db
        .prepare("SELECT COUNT(*) AS cnt FROM announcement_media WHERE key = ?")
        .bind(&[JsValue::from(&D1Type::Text(key))])?
        .first::<i32>(Some("cnt"))
        .await?;
    Ok(found.unwrap_or(0) > 0)
}

pub async fn delete_announcement_media_by_key(
    ctx: &worker::RouteContext<()>,
    key: &str,
) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("DELETE FROM announcement_media WHERE key = ?")
        .bind(&[JsValue::from(&D1Type::Text(key))])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) > 0)
}

// ── Metrics ──

/// Record one play or one download.
///
/// A single statement: the upsert adds to the day's counters, and the
/// `WHERE EXISTS` is what keeps a public unauthenticated endpoint from minting
/// rows for paths that name no file. (It does not stop someone from inflating a
/// *real* file's count — see CLAUDE.md's known-unfixed list.)
///
/// `excluded.plays` / `excluded.downloads` carry the increment through, so the
/// caller passes 1/0 or 0/1 and this stays one code path for both events.
pub async fn record_metric(
    ctx: &worker::RouteContext<()>,
    file_path: &str,
    plays: i32,
    downloads: i32,
) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare(
            "INSERT INTO file_metrics (file_path, day, plays, downloads) \
             SELECT ?, date('now'), ?, ? \
             WHERE EXISTS (SELECT 1 FROM files WHERE path = ?) \
             ON CONFLICT(file_path, day) DO UPDATE SET \
               plays = plays + excluded.plays, downloads = downloads + excluded.downloads",
        )
        .bind(&[
            JsValue::from(&D1Type::Text(file_path)),
            JsValue::from(&D1Type::Integer(plays)),
            JsValue::from(&D1Type::Integer(downloads)),
            JsValue::from(&D1Type::Text(file_path)),
        ])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) > 0)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MetricDay {
    pub day: String,
    pub plays: i32,
    pub downloads: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MetricFile {
    pub file_path: String,
    pub plays: i32,
    pub downloads: i32,
}

/// Daily totals across every file, oldest first, for the last `days` days.
///
/// The window is expressed as `date('now', '-N days')` rather than filtered in
/// the Worker: the whole point of the counter table is that the database can
/// answer this without shipping rows.
pub async fn metrics_daily(ctx: &worker::RouteContext<()>, days: u32) -> Result<Vec<MetricDay>> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare(
            "SELECT day, SUM(plays) AS plays, SUM(downloads) AS downloads FROM file_metrics \
             WHERE day >= date('now', ?) GROUP BY day ORDER BY day ASC",
        )
        .bind(&[JsValue::from(&D1Type::Text(&format!("-{} days", days)))])?
        .all()
        .await?;
    result.results::<MetricDay>()
}

/// The busiest files in the window, most-played first.
pub async fn metrics_top(
    ctx: &worker::RouteContext<()>,
    days: u32,
    limit: u32,
) -> Result<Vec<MetricFile>> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare(
            "SELECT file_path, SUM(plays) AS plays, SUM(downloads) AS downloads \
             FROM file_metrics WHERE day >= date('now', ?) GROUP BY file_path \
             ORDER BY plays DESC, downloads DESC LIMIT ?",
        )
        .bind(&[
            JsValue::from(&D1Type::Text(&format!("-{} days", days))),
            JsValue::from(&D1Type::Integer(limit as i32)),
        ])?
        .all()
        .await?;
    result.results::<MetricFile>()
}

/// Drop a file's counters. Called from the delete fan-out; owns no R2 object.
pub async fn delete_metrics_for_path(
    ctx: &worker::RouteContext<()>,
    file_path: &str,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    db.prepare("DELETE FROM file_metrics WHERE file_path = ?")
        .bind(&[JsValue::from(&D1Type::Text(file_path))])?
        .run()
        .await?;
    Ok(())
}

/// The dashboard's headline numbers, in one round trip.
///
/// Same shape as `count_attached`: separate scalar subqueries rather than joins,
/// because they count unrelated things and a join would multiply them together.
#[derive(Debug, Serialize, Deserialize)]
pub struct Overview {
    pub files: i32,
    pub total_size: f64,
    pub proxies: i32,
    pub attachments: i32,
    pub clips: i32,
    pub public_clips: i32,
    pub clip_sets: i32,
    pub announcements: i32,
    pub published_announcements: i32,
    pub open_reports: i32,
    pub all_plays: i32,
    pub all_downloads: i32,
}

pub async fn overview(ctx: &worker::RouteContext<()>) -> Result<Overview> {
    let db = ctx.d1("DB")?;
    // total_size comes back as REAL for the same reason sizes are bound as
    // Real: the sum of a 40 GB archive overflows an i32 long before the row
    // count does.
    let row = db
        .prepare(
            "SELECT (SELECT COUNT(*) FROM files) AS files, \
                    (SELECT COALESCE(SUM(size), 0) FROM files) AS total_size, \
                    (SELECT COUNT(*) FROM proxy_videos) AS proxies, \
                    (SELECT COUNT(*) FROM file_attachments) AS attachments, \
                    (SELECT COUNT(*) FROM clips) AS clips, \
                    (SELECT COUNT(*) FROM clips WHERE is_public = 1) AS public_clips, \
                    (SELECT COUNT(*) FROM clip_sets) AS clip_sets, \
                    (SELECT COUNT(*) FROM announcements) AS announcements, \
                    (SELECT COUNT(*) FROM announcements WHERE is_published = 1) \
                        AS published_announcements, \
                    (SELECT COUNT(*) FROM clip_reports WHERE resolved = 0) AS open_reports, \
                    (SELECT COALESCE(SUM(plays), 0) FROM file_metrics) AS all_plays, \
                    (SELECT COALESCE(SUM(downloads), 0) FROM file_metrics) AS all_downloads",
        )
        .first::<Overview>(None)
        .await?;
    row.ok_or_else(|| worker::Error::RustError("overview returned no row".into()))
}

// ── Covers ──

/// Point a file's row at a cover image, or clear it with `None`.
///
/// Returns the key it replaced, so the caller can decide whether that object is
/// now unreferenced and should be removed from R2 — a decision this function
/// deliberately does not make, because a cover key may be an attachment's.
pub async fn set_cover(
    ctx: &worker::RouteContext<()>,
    path: &str,
    cover_key: Option<&str>,
) -> Result<Option<String>> {
    let previous = get_by_path(ctx, path).await?.and_then(|f| f.cover_key);
    let db = ctx.d1("DB")?;
    match cover_key {
        Some(key) => {
            db.prepare("UPDATE files SET cover_key = ? WHERE path = ?")
                .bind(&[
                    JsValue::from(&D1Type::Text(key)),
                    JsValue::from(&D1Type::Text(path)),
                ])?
                .run()
                .await?;
        }
        None => {
            db.prepare("UPDATE files SET cover_key = NULL WHERE path = ?")
                .bind(&[JsValue::from(&D1Type::Text(path))])?
                .run()
                .await?;
        }
    }
    Ok(previous)
}

/// How many `files` rows still point at this cover key.
///
/// The other half of "is this object still needed": one file may pick another's
/// image, and a cover that is also an attachment is not this column's to delete
/// at all (`attachment_exists` covers that half).
pub async fn cover_ref_count(ctx: &worker::RouteContext<()>, key: &str) -> Result<i32> {
    let db = ctx.d1("DB")?;
    let found = db
        .prepare("SELECT COUNT(*) AS cnt FROM files WHERE cover_key = ?")
        .bind(&[JsValue::from(&D1Type::Text(key))])?
        .first::<i32>(Some("cnt"))
        .await?;
    Ok(found.unwrap_or(0))
}
