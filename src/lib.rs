use worker::*;

mod auth;
mod cors;
mod db;

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
            let key = ctx.param("key").map_or("", |v| v);
            let url = req.url()?;
            let query_pairs: std::collections::HashMap<String, String> =
                url.query_pairs().into_owned().collect();
            let is_download = query_pairs.get("download").map(|s| s.as_str()) == Some("1");

            match bucket.get(key).execute().await? {
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
                        let filename = key.rsplit('/').next().unwrap_or(key);
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
        // POST /admin/api/upload — upload file to R2 + D1
        .post_async("/admin/api/upload", |mut req, ctx| async move {
            // Verify Cloudflare Access JWT
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Upload by: {:?}", claims.email);

            let form = req.form_data().await?;

            // Extract file from form data
            let file_entry = form
                .get("file")
                .ok_or_else(|| worker::Error::RustError("no file field".into()))?;

            let (file_name, content_type, file_bytes) = match file_entry {
                FormEntry::File(f) => {
                    let name = f.name();
                    let ct = f.type_();
                    let bytes = f.bytes().await?;
                    (name, ct, bytes)
                }
                FormEntry::Field(_) => {
                    return Ok(Response::error("file field is not a file", 400)?
                        .with_headers(cors::headers()?));
                }
            };

            // Use custom path if provided, otherwise auto-generate
            let custom_path = form
                .get("path")
                .and_then(|entry| match entry {
                    FormEntry::Field(f) => Some(f),
                    _ => None,
                })
                .filter(|v| !v.is_empty());

            let key = if let Some(path) = custom_path {
                if path.ends_with('/') {
                    format!("{}{}", path, file_name)
                } else {
                    path
                }
            } else {
                let ts = Date::now().as_millis();
                format!("uploads/{}/{}", ts / 86400000, file_name)
            };

            // Upload to R2
            let bucket = ctx.bucket("FILE_BUCKET")?;
            bucket.put(&key, file_bytes.clone()).execute().await?;

            // Insert record into D1
            db::insert_file(&ctx, &key, file_bytes.len() as i64, &content_type).await?;

            Ok(Response::from_json(&serde_json::json!({
                "ok": true,
                "key": key,
                "size": file_bytes.len(),
                "content_type": content_type,
            }))?
            .with_headers(cors::headers()?))
        })
        // DELETE /admin/api/files/*key — delete file from R2 + D1 (wildcard matches keys with /)
        .delete_async("/admin/api/files/*key", |req, ctx| async move {
            // Verify Cloudflare Access JWT
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Delete by: {:?}", claims.email);

            let key = ctx.param("key").map_or("", |v| v);

            if key.is_empty() {
                return Ok(Response::error("Bad Request: missing key", 400)?
                    .with_headers(cors::headers()?));
            }

            // Delete from R2
            let bucket = ctx.bucket("FILE_BUCKET")?;
            bucket.delete(key).await?;

            // Delete from D1
            db::delete_file(&ctx, key).await?;

            Ok(Response::from_json(&serde_json::json!({"ok": true, "deleted": key}))?
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
