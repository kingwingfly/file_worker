use serde::{Deserialize, Serialize};
use worker::{wasm_bindgen::JsValue, D1Type, Result};

#[derive(Debug, Serialize, Deserialize)]
pub struct FileRecord {
    pub key: String,
    pub size: i64,
    pub content_type: String,
    pub uploaded_at: String,
}

/// List files from D1 with optional filter and pagination
pub async fn list_files(
    ctx: &worker::RouteContext<()>,
    filter: &str,
    offset: u32,
    limit: u32,
) -> Result<Vec<FileRecord>> {
    let db = ctx.d1("DB")?;

    let query = match filter {
        "image" => "SELECT key, size, content_type, uploaded_at FROM files WHERE content_type LIKE 'image/%' ORDER BY uploaded_at DESC LIMIT ? OFFSET ?",
        "video" => "SELECT key, size, content_type, uploaded_at FROM files WHERE content_type LIKE 'video/%' ORDER BY uploaded_at DESC LIMIT ? OFFSET ?",
        "audio" => "SELECT key, size, content_type, uploaded_at FROM files WHERE content_type LIKE 'audio/%' ORDER BY uploaded_at DESC LIMIT ? OFFSET ?",
        _ => "SELECT key, size, content_type, uploaded_at FROM files ORDER BY uploaded_at DESC LIMIT ? OFFSET ?",
    };

    let params = vec![
        JsValue::from(&D1Type::Integer(limit as i32)),
        JsValue::from(&D1Type::Integer(offset as i32)),
    ];

    let result = db.prepare(query).bind(&params)?.all().await?;
    let files: Vec<FileRecord> = result.results()?;
    Ok(files)
}

/// Insert a file record into D1
pub async fn insert_file(
    ctx: &worker::RouteContext<()>,
    key: &str,
    size: i64,
    content_type: &str,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    db.prepare(
        "INSERT OR REPLACE INTO files (key, size, content_type, uploaded_at) VALUES (?, ?, ?, datetime('now'))",
    )
    .bind(&[
        JsValue::from(&D1Type::Text(key)),
        JsValue::from(&D1Type::Real(size as f64)),
        JsValue::from(&D1Type::Text(content_type)),
    ])?
    .run()
    .await?;
    Ok(())
}

/// Delete a file record from D1 by key
pub async fn delete_file(ctx: &worker::RouteContext<()>, key: &str) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("DELETE FROM files WHERE key = ?")
        .bind(&[JsValue::from(&D1Type::Text(key))])?
        .run()
        .await?;
    Ok(result.success())
}

/// Get a single file record from D1 by key
#[allow(dead_code)]
pub async fn get_file(ctx: &worker::RouteContext<()>, key: &str) -> Result<Option<FileRecord>> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("SELECT key, size, content_type, uploaded_at FROM files WHERE key = ?")
        .bind(&[JsValue::from(&D1Type::Text(key))])?
        .first::<FileRecord>(None)
        .await?;
    Ok(result)
}

/// Check if a file key exists in D1
pub async fn check_file_exists(ctx: &worker::RouteContext<()>, key: &str) -> Result<bool> {
    let db = ctx.d1("DB")?;
    let result = db
        .prepare("SELECT COUNT(*) as cnt FROM files WHERE key = ?")
        .bind(&[JsValue::from(&D1Type::Text(key))])?
        .first::<i64>(Some("cnt"))
        .await?;
    Ok(result.unwrap_or(0) > 0)
}

/// Rename a file in D1 — update the key
pub async fn rename_file(
    ctx: &worker::RouteContext<()>,
    old_key: &str,
    new_key: &str,
) -> Result<()> {
    let db = ctx.d1("DB")?;
    db.prepare("UPDATE files SET key = ? WHERE key = ?")
        .bind(&[
            JsValue::from(&D1Type::Text(new_key)),
            JsValue::from(&D1Type::Text(old_key)),
        ])?
        .run()
        .await?;
    Ok(())
}
