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
    Ok(result.success())
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
    pub created_at: String,
    pub updated_at: String,
}

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
) -> Result<()> {
    let db = ctx.d1("DB")?;
    db.prepare(
        "INSERT INTO clips (id, file_path, identity, nickname, name, description, start_time, end_time, is_public, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
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
    ])?
    .run()
    .await?;
    Ok(())
}

pub async fn get_clip(
    ctx: &worker::RouteContext<()>,
    id: &str,
) -> Result<Option<ClipRecord>> {
    let db = ctx.d1("DB")?;
    db.prepare(
        "SELECT c.*, (SELECT COUNT(*) FROM clip_likes WHERE clip_id = c.id) AS like_count \
         FROM clips c WHERE c.id = ?",
    )
    .bind(&[JsValue::from(&D1Type::Text(id))])?
    .first::<ClipRecord>(None)
    .await
}

/// List public clips, optionally filtered by file_path.
///
/// `sort` is `"likes"` (most-liked first), `"time"` (newest first, the default),
/// or anything else (also newest first).
pub async fn list_clips(
    ctx: &worker::RouteContext<()>,
    file_path: Option<&str>,
    sort: &str,
    offset: u32,
    limit: u32,
) -> Result<Vec<ClipRecord>> {
    let db = ctx.d1("DB")?;

    let where_clause = if file_path.is_some() {
        "WHERE c.is_public = 1 AND c.file_path = ? "
    } else {
        "WHERE c.is_public = 1 "
    };

    let order = match sort {
        "likes" => "ORDER BY like_count DESC, c.created_at DESC ",
        _ => "ORDER BY c.created_at DESC ",
    };

    let query = format!(
        "SELECT c.*, (SELECT COUNT(*) FROM clip_likes WHERE clip_id = c.id) AS like_count \
         FROM clips c {where_clause}{order}LIMIT ? OFFSET ?"
    );

    let mut params: Vec<JsValue> = vec![];
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
    let query = "SELECT c.*, (SELECT COUNT(*) FROM clip_likes WHERE clip_id = c.id) AS like_count \
                 FROM clips c ORDER BY c.created_at DESC LIMIT ? OFFSET ?";
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
    let result = db
        .prepare("DELETE FROM clips WHERE id = ?")
        .bind(&[JsValue::from(&D1Type::Text(id))])?
        .run()
        .await?;
    Ok(result.success())
}

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

pub async fn has_liked(
    ctx: &worker::RouteContext<()>,
    clip_id: &str,
    identity: &str,
) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("SELECT COUNT(*) as cnt FROM clip_likes WHERE clip_id = ? AND identity = ?")
        .bind(&[
            JsValue::from(&D1Type::Text(clip_id)),
            JsValue::from(&D1Type::Text(identity)),
        ])?
        .first::<i32>(Some("cnt"))
        .await?;
    Ok(result.unwrap_or(0) > 0)
}

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
    db.prepare("INSERT INTO clip_reports (clip_id, reason, identity, created_at) VALUES (?, ?, ?, datetime('now'))")
        .bind(&[
            JsValue::from(&D1Type::Text(clip_id)),
            JsValue::from(&D1Type::Text(reason)),
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
    let result = db
        .prepare("DELETE FROM clips WHERE identity = ?")
        .bind(&[JsValue::from(&D1Type::Text(identity))])?
        .run()
        .await?;
    Ok(result.meta()?.and_then(|m| m.changes).unwrap_or(0) as u32)
}
