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
}

/// Migration 0002 backfills `path` for every existing row, so the COALESCE here
/// is only a belt-and-braces default for reads. Lookups below deliberately do
/// *not* use it: `WHERE COALESCE(path, key) = ?` is an expression SQLite cannot
/// match against `idx_files_path`, which turns every one of them — including
/// `path_exists` on the upload path — into a full table scan.
const SELECT_COLS: &str = "key, COALESCE(path, key) AS path, size, content_type, uploaded_at";

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
