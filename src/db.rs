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
