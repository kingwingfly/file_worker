use percent_encoding::percent_decode_str;
use worker::*;

mod auth;
mod cors;
mod db;

/// URL-decode a percent-encoded key from the URL path.
/// The URL parser preserves `%2F` (encoded `/`) in pathnames, so keys
/// containing slashes arrive still-encoded and must be decoded for R2/D1.
fn decode_key(encoded: &str) -> String {
    percent_decode_str(encoded).decode_utf8_lossy().into_owned()
}

/// Parse an HTTP `Range: bytes=...` header value into an R2 Range.
fn parse_range(header: &str) -> Option<worker::Range> {
    let v = header.strip_prefix("bytes=")?;
    if v.contains(',') {
        return None; // multi-range — not supported
    }
    if let Some(suffix) = v.strip_prefix('-') {
        return Some(worker::Range::Suffix { suffix: suffix.trim().parse().ok()? });
    }
    if let Some(rest) = v.strip_suffix('-') {
        return Some(worker::Range::OffsetToEnd { offset: rest.trim().parse().ok()? });
    }
    let (start, end) = v.split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    let end: u64 = end.trim().parse().ok()?;
    if start > end {
        return None;
    }
    Some(worker::Range::OffsetWithLength { offset: start, length: end - start + 1 })
}

/// Compute Content-Range bounds from the requested Range and total file size.
fn range_bounds(range: worker::Range, total: u64) -> (u64, u64) {
    let last = total.saturating_sub(1);
    match range {
        worker::Range::OffsetWithLength { offset, length } => (offset, (offset + length - 1).min(last)),
        worker::Range::OffsetToEnd { offset } => (offset, last),
        worker::Range::Prefix { length } => (0, (length - 1).min(last)),
        worker::Range::Suffix { suffix } => (total.saturating_sub(suffix), last),
    }
}

#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: worker::Context) -> Result<Response> {
    // Handle CORS preflight
    if req.method() == Method::Options {
        return Ok(Response::empty()?.with_headers(cors::headers()?));
    }

    let router = Router::new();

    router
        // === Public API ===
        // GET /api/files — list files from D1
        .get_async("/api/files", |req, ctx| async move {
            let url = req.url()?;
            let query_pairs: std::collections::HashMap<String, String> =
                url.query_pairs().into_owned().collect();

            let offset: u32 = query_pairs
                .get("offset")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let limit: u32 = query_pairs
                .get("limit")
                .and_then(|v| v.parse().ok())
                .unwrap_or(50)
                .min(100);
            let filter = query_pairs
                .get("filter")
                .map(|s| s.as_str())
                .unwrap_or("all");

            let files = db::list_files(&ctx, filter, offset, limit).await?;

            Ok(Response::from_json(&serde_json::json!({
                "files": files,
                "offset": offset,
                "limit": limit,
            }))?
            .with_headers(cors::headers()?))
        })
        // GET /api/file/*key — serve file from R2 (wildcard matches keys with /)
        .get_async("/api/file/*key", |req, ctx| async move {
            let bucket = ctx.bucket("FILE_BUCKET")?;
            let raw = ctx.param("key").map_or("", |v| v);
            let key = decode_key(raw);
            let url = req.url()?;
            let query_pairs: std::collections::HashMap<String, String> =
                url.query_pairs().into_owned().collect();
            let is_download = query_pairs.get("download").map(|s| s.as_str()) == Some("1");

            // Range support for video/audio seeking.
            // On any failure we silently fall through to the full-file serve below.
            if !is_download {
                if let Some(range_str) = req.headers().get("Range").ok().flatten() {
                    if let Some(r) = parse_range(&range_str) {
                        let r2 = r.clone();
                        if let Ok(Some(obj)) = bucket.get(&key).range(r).execute().await {
                            if let Some(body) = obj.body() {
                                let total = obj.size();
                                let meta = obj.http_metadata();
                                let ct = meta.content_type.as_deref().unwrap_or("application/octet-stream");
                                let (rs, re) = range_bounds(r2, total);

                                let mut headers = Headers::new();
                                headers.set("Content-Type", ct)?;
                                headers.set("Accept-Ranges", "bytes")?;
                                headers.set("Content-Range", &format!("bytes {}-{}/{}", rs, re, total))?;
                                headers.set("Content-Length", &(re - rs + 1).to_string())?;
                                cors::extend_headers(&mut headers)?;

                                return Ok(Response::from_body(body.response_body()?)?
                                    .with_status(206)
                                    .with_headers(headers));
                            }
                        }
                    }
                }
            }

            match bucket.get(&key).execute().await? {
                Some(object) => {
                    let body = object
                        .body()
                        .ok_or_else(|| worker::Error::RustError("no body".into()))?;

                    let meta = object.http_metadata();
                    let content_type = meta
                        .content_type
                        .as_deref()
                        .unwrap_or("application/octet-stream");

                    let mut headers = Headers::new();
                    headers.set("Content-Type", content_type)?;
                    headers.set("Cache-Control", "public, max-age=31536000, immutable")?;

                    if is_download {
                        let filename = key.rsplit('/').next().unwrap_or(&key);
                        headers.set(
                            "Content-Disposition",
                            &format!("attachment; filename=\"{}\"", filename),
                        )?;
                    }

                    cors::extend_headers(&mut headers)?;

                    Ok(Response::from_body(body.response_body()?)?.with_headers(headers))
                }
                None => Ok(Response::error("Not Found", 404)?.with_headers(cors::headers()?)),
            }
        })
        // === Admin API (protected by Cloudflare Access JWT) ===
        // GET /admin/api/files — list all files for admin page
        .get_async("/admin/api/files", |req, ctx| async move {
            // Verify Cloudflare Access JWT
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Admin access by: {:?}", claims.email);

            let files = db::list_files(&ctx, "all", 0, 1000).await?;
            Ok(Response::from_json(&serde_json::json!({
                "files": files,
            }))?
            .with_headers(cors::headers()?))
        })
        // POST /admin/api/upload/start — create multipart upload
        .post_async("/admin/api/upload/start", |mut req, ctx| async move {
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Upload start by: {:?}", claims.email);

            let body: serde_json::Value = req.json().await?;
            let filename = body["filename"].as_str().unwrap_or("unnamed");
            let content_type = body["content_type"]
                .as_str()
                .unwrap_or("application/octet-stream");
            let custom_path = body["path"].as_str().filter(|s| !s.is_empty());
            let overwrite = body["overwrite"].as_bool().unwrap_or(false);

            let key = if let Some(path) = custom_path {
                if path.ends_with('/') {
                    format!("{}{}", path, filename)
                } else {
                    path.to_string()
                }
            } else {
                let ts = Date::now().as_millis();
                format!("uploads/{}/{}", ts / 86400000, filename)
            };

            // Check for duplicate unless overwrite flag is set
            if !overwrite && db::check_file_exists(&ctx, &key).await? {
                return Ok(
                    Response::from_json(&serde_json::json!({
                        "error": "duplicate",
                        "key": key,
                        "message": "A file with this key already exists.",
                    }))?
                    .with_status(409)
                    .with_headers(cors::headers()?),
                );
            }

            let bucket = ctx.bucket("FILE_BUCKET")?;
            let metadata = HttpMetadata {
                content_type: Some(content_type.to_string()),
                ..Default::default()
            };
            let upload = bucket
                .create_multipart_upload(&key)
                .http_metadata(metadata)
                .execute()
                .await?;
            let upload_id = upload.upload_id().await;

            Ok(Response::from_json(&serde_json::json!({
                "upload_id": upload_id,
                "key": key,
            }))?
            .with_headers(cors::headers()?))
        })
        // PUT /admin/api/upload/part — upload one chunk (raw bytes)
        .put_async("/admin/api/upload/part", |mut req, ctx| async move {
            let _claims = auth::verify_access_jwt(&req, &ctx).await?;

            let url = req.url()?;
            let qs: std::collections::HashMap<String, String> =
                url.query_pairs().into_owned().collect();
            let upload_id = qs.get("upload_id").cloned().unwrap_or_default();
            // query_pairs() already percent-decodes — do NOT decode_key() here
            let key = qs.get("key").cloned().unwrap_or_default();
            let part_number: u16 = qs.get("n").and_then(|v| v.parse().ok()).unwrap_or(0);

            if upload_id.is_empty() || key.is_empty() || part_number == 0 {
                return Ok(
                    Response::error("Bad Request: missing upload_id, key, or n", 400)?
                        .with_headers(cors::headers()?),
                );
            }

            let bucket = ctx.bucket("FILE_BUCKET")?;
            let upload = bucket.resume_multipart_upload(&key, &upload_id)?;
            let bytes = req.bytes().await?;
            let part = upload.upload_part(part_number, bytes).await?;

            Ok(Response::from_json(&serde_json::json!({
                "part_number": part.part_number(),
                "etag": part.etag(),
            }))?
            .with_headers(cors::headers()?))
        })
        // POST /admin/api/upload/complete — complete multipart upload + D1 insert
        .post_async("/admin/api/upload/complete", |mut req, ctx| async move {
            let _claims = auth::verify_access_jwt(&req, &ctx).await?;

            let url = req.url()?;
            let qs: std::collections::HashMap<String, String> =
                url.query_pairs().into_owned().collect();
            let upload_id = qs.get("upload_id").cloned().unwrap_or_default();
            // query_pairs() already percent-decodes — do NOT decode_key() here
            let key = qs.get("key").cloned().unwrap_or_default();

            if upload_id.is_empty() || key.is_empty() {
                return Ok(
                    Response::error("Bad Request: missing upload_id or key", 400)?
                        .with_headers(cors::headers()?),
                );
            }

            let body: serde_json::Value = req.json().await?;
            let parts_json = body["parts"]
                .as_array()
                .ok_or_else(|| worker::Error::RustError("missing parts array".into()))?;
            let content_type = body["content_type"]
                .as_str()
                .unwrap_or("application/octet-stream");

            let uploaded_parts: Vec<UploadedPart> = parts_json
                .iter()
                .map(|p| {
                    UploadedPart::new(
                        p["n"].as_u64().unwrap_or(0) as u16,
                        p["etag"].as_str().unwrap_or("").to_string(),
                    )
                })
                .collect();

            let bucket = ctx.bucket("FILE_BUCKET")?;
            let upload = bucket.resume_multipart_upload(&key, &upload_id)?;
            let obj = upload.complete(uploaded_parts).await?;
            let size = obj.size() as i64;

            // Insert record into D1. If this fails, clean up the R2 object.
            match db::insert_file(&ctx, &key, size, content_type).await {
                Ok(()) => {
                    console_log!("Upload complete: key={}, size={}", key, size);
                    Ok(Response::from_json(&serde_json::json!({
                        "ok": true,
                        "key": key,
                        "size": size,
                    }))?
                    .with_headers(cors::headers()?))
                }
                Err(e) => {
                    // D1 insert failed — delete the committed R2 object so it doesn't
                    // become an invisible storage leak.
                    console_log!("D1 insert failed for key={}, cleaning up R2 object: {:?}", key, e);
                    let _ = bucket.delete(&key).await;
                    Err(e)
                }
            }
        })
        // DELETE /admin/api/upload — abort multipart upload
        .delete_async("/admin/api/upload", |req, ctx| async move {
            let _claims = auth::verify_access_jwt(&req, &ctx).await?;

            let url = req.url()?;
            let qs: std::collections::HashMap<String, String> =
                url.query_pairs().into_owned().collect();
            let upload_id = qs.get("upload_id").cloned().unwrap_or_default();
            // query_pairs() already percent-decodes — do NOT decode_key() here
            let key = qs.get("key").cloned().unwrap_or_default();

            if upload_id.is_empty() || key.is_empty() {
                return Ok(
                    Response::error("Bad Request: missing upload_id or key", 400)?
                        .with_headers(cors::headers()?),
                );
            }

            let bucket = ctx.bucket("FILE_BUCKET")?;
            let upload = bucket.resume_multipart_upload(&key, &upload_id)?;
            upload.abort().await?;

            console_log!("Upload aborted: key={}", key);
            Ok(Response::from_json(&serde_json::json!({"ok": true}))?
                .with_headers(cors::headers()?))
        })
        // DELETE /admin/api/files/*key — delete file from R2 + D1 (wildcard matches keys with /)
        .delete_async("/admin/api/files/*key", |req, ctx| async move {
            // Verify Cloudflare Access JWT
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Delete by: {:?}", claims.email);

            let raw = ctx.param("key").map_or("", |v| v);
            let key = decode_key(raw);

            if key.is_empty() {
                return Ok(Response::error("Bad Request: missing key", 400)?
                    .with_headers(cors::headers()?));
            }

            // Delete from R2 first, then D1.
            // If R2 fails, D1 row remains visible → retryable from UI.
            // If D1 fails after R2 success, the object is already gone
            // but retry works (R2 delete is idempotent, D1 delete is a no-op).
            let bucket = ctx.bucket("FILE_BUCKET")?;
            bucket.delete(&key).await?;
            let deleted_key = key.clone();
            db::delete_file(&ctx, &key).await?;

            Ok(Response::from_json(&serde_json::json!({"ok": true, "deleted": deleted_key}))?
                .with_headers(cors::headers()?))
        })
        // POST /admin/api/files/rename — rename a file (R2 copy + delete + D1 update)
        .post_async("/admin/api/files/rename", |mut req, ctx| async move {
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Rename by: {:?}", claims.email);

            let body: serde_json::Value = req.json().await?;
            let old_key = body["old_key"]
                .as_str()
                .ok_or_else(|| worker::Error::RustError("missing old_key".into()))?;
            let new_key = body["new_key"]
                .as_str()
                .ok_or_else(|| worker::Error::RustError("missing new_key".into()))?;

            if old_key.is_empty() || new_key.is_empty() {
                return Ok(Response::error("Bad Request: empty key", 400)?
                    .with_headers(cors::headers()?));
            }

            if old_key == new_key {
                return Ok(Response::from_json(&serde_json::json!({
                    "ok": true,
                    "key": new_key,
                }))?
                .with_headers(cors::headers()?));
            }

            // Check target key doesn't already exist
            if db::check_file_exists(&ctx, new_key).await? {
                return Ok(Response::from_json(&serde_json::json!({
                    "error": "duplicate",
                    "message": "目标文件名已存在。",
                }))?
                .with_status(409)
                .with_headers(cors::headers()?));
            }

            let bucket = ctx.bucket("FILE_BUCKET")?;

            // Copy object in R2: get old → put new → delete old
            let old_obj = bucket.get(old_key).execute().await?;
            let old_obj = old_obj.ok_or_else(|| {
                worker::Error::RustError("source file not found in storage".into())
            })?;

            let body = old_obj
                .body()
                .ok_or_else(|| worker::Error::RustError("source file has no body".into()))?;

            let body_bytes = body.bytes().await?;

            let content_type = old_obj
                .http_metadata()
                .content_type
                .as_deref()
                .unwrap_or("application/octet-stream")
                .to_string();

            // Put the object with the new key
            let metadata = HttpMetadata {
                content_type: Some(content_type.clone()),
                ..Default::default()
            };
            bucket
                .put(new_key, body_bytes)
                .http_metadata(metadata)
                .execute()
                .await?;

            // Delete the old object
            bucket.delete(old_key).await?;

            // Update D1 record
            db::rename_file(&ctx, old_key, new_key).await?;

            console_log!("Renamed: {} -> {}", old_key, new_key);
            Ok(Response::from_json(&serde_json::json!({
                "ok": true,
                "old_key": old_key,
                "new_key": new_key,
            }))?
            .with_headers(cors::headers()?))
        })
        // POST /admin/api/files/check-key — check if a key would collide before upload
        .post_async("/admin/api/files/check-key", |mut req, ctx| async move {
            let _claims = auth::verify_access_jwt(&req, &ctx).await?;

            let body: serde_json::Value = req.json().await?;
            let filename = body["filename"].as_str().unwrap_or("unnamed");
            let custom_path = body["path"].as_str().filter(|s| !s.is_empty());

            let key = if let Some(path) = custom_path {
                if path.ends_with('/') {
                    format!("{}{}", path, filename)
                } else {
                    path.to_string()
                }
            } else {
                let ts = Date::now().as_millis();
                format!("uploads/{}/{}", ts / 86400000, filename)
            };

            let exists = db::check_file_exists(&ctx, &key).await?;
            Ok(Response::from_json(&serde_json::json!({
                "key": key,
                "exists": exists,
            }))?
            .with_headers(cors::headers()?))
        })
        // Fallback: serve static assets via Fetcher
        .get_async("/*path", |req, ctx| async move {
            let assets = ctx
                .env
                .assets("ASSETS")
                .map_err(|e| worker::Error::RustError(format!("assets binding: {}", e)))?;
            assets.fetch_request(req).await.map_err(|e| {
                worker::Error::RustError(format!("assets fetch: {}", e))
            })
        })
        .run(req, env)
        .await
}
