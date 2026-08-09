use percent_encoding::percent_decode_str;
use worker::*;

/// Build an RFC 6266 / RFC 5987 `Content-Disposition` value.
///
/// Header values are ByteStrings: any code point above U+00FF throws when set,
/// and a raw `"` or `\` in the filename would break out of the quoted-string.
/// So we send an ASCII-sanitised `filename=` for legacy clients plus a
/// percent-encoded `filename*=UTF-8''…` that every modern browser prefers.
fn content_disposition(filename: &str) -> String {
    let ascii_fallback: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii() && !c.is_ascii_control() && c != '"' && c != '\\' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let ascii_fallback = if ascii_fallback.trim().is_empty() {
        "download".to_string()
    } else {
        ascii_fallback
    };

    let encoded =
        percent_encoding::utf8_percent_encode(filename, percent_encoding::NON_ALPHANUMERIC)
            .to_string();

    format!("attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{encoded}")
}

mod auth;
mod cors;
mod db;
mod identity;

/// Mint the R2 object name for a new upload.
///
/// This is never shown to anyone and never changes: renaming edits `files.path`
/// instead, so `/api/file/{key}` links survive it. The timestamp+random prefix
/// makes it collision-free even when two uploads pick the same display path,
/// and keeping the original filename on the end keeps the R2 dashboard readable.
fn new_storage_key(filename: &str) -> String {
    let ts = Date::now().as_millis();
    let rand = (js_sys::Math::random() * u32::MAX as f64) as u32;
    format!("uploads/{}/{}-{:08x}/{}", ts / 86_400_000, ts, rand, filename)
}

/// URL-decode a percent-encoded key from the URL path.
/// The URL parser preserves `%2F` (encoded `/`) in pathnames, so keys
/// containing slashes arrive still-encoded and must be decoded for R2/D1.
fn decode_key(encoded: &str) -> String {
    percent_decode_str(encoded).decode_utf8_lossy().into_owned()
}

/// Clamp a client-supplied Content-Type to the media types this gallery serves.
///
/// The stored type is echoed back verbatim on the public `/api/file/*key` route,
/// which lives on the same origin as `/admin`. Letting a caller store
/// `text/html` (or `image/svg+xml`, which scripts) turns any upload into stored
/// XSS — `X-Content-Type-Options` does not help when the declared type *is*
/// active. The upload UI only offers image/video/audio anyway.
fn sanitize_content_type(raw: &str) -> String {
    let base = raw.split(';').next().unwrap_or("").trim().to_ascii_lowercase();

    let allowed = matches!(base.split('/').next(), Some("image" | "video" | "audio"))
        && base != "image/svg+xml"
        && !base.contains(|c: char| c.is_ascii_control());

    if allowed {
        base
    } else {
        "application/octet-stream".to_string()
    }
}

/// Reject cross-site state-changing calls to the admin API.
///
/// Admin routes authenticate on the `CF_Authorization` cookie alone, and
/// `req.json()` ignores Content-Type — so a plain cross-origin form POST
/// (`text/plain`, no preflight) would otherwise arrive fully authenticated.
/// Browsers always send `Origin` on non-GET requests, so anything without a
/// matching one is not our own admin page. Non-browser callers must send it too.
fn reject_cross_site_admin(req: &Request) -> Result<Option<Response>> {
    let url = req.url()?;
    if !url.path().starts_with("/admin/api/") {
        return Ok(None);
    }
    if matches!(req.method(), Method::Get | Method::Head | Method::Options) {
        return Ok(None);
    }

    let expected = url.origin().ascii_serialization();
    match req.headers().get("Origin")?.as_deref() {
        Some(origin) if origin == expected => Ok(None),
        _ => Ok(Some(
            Response::error("Forbidden: cross-site request", 403)?.with_headers(cors::headers()?),
        )),
    }
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
    // `end - start + 1` overflows on e.g. `bytes=0-18446744073709551615`.
    let length = end.checked_sub(start)?.checked_add(1)?;
    Some(worker::Range::OffsetWithLength { offset: start, length })
}

/// Compute Content-Range bounds from the requested Range and total file size.
fn range_bounds(range: worker::Range, total: u64) -> (u64, u64) {
    let last = total.saturating_sub(1);
    match range {
        worker::Range::OffsetWithLength { offset, length } => (
            offset,
            offset
                .saturating_add(length)
                .saturating_sub(1)
                .min(last),
        ),
        worker::Range::OffsetToEnd { offset } => (offset, last),
        worker::Range::Prefix { length } => (0, length.saturating_sub(1).min(last)),
        worker::Range::Suffix { suffix } => (total.saturating_sub(suffix), last),
    }
}

#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: worker::Context) -> Result<Response> {
    // Handle CORS preflight
    if req.method() == Method::Options {
        return Ok(Response::empty()?.with_headers(cors::headers()?));
    }

    if let Some(rejection) = reject_cross_site_admin(&req)? {
        return Ok(rejection);
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
                                // Sanitise on read too, not just on write: objects
                                // uploaded before the write-side allowlist existed
                                // still carry whatever type the client sent.
                                let ct = sanitize_content_type(meta.content_type.as_deref().unwrap_or_default());
                                let (rs, re) = range_bounds(r2, total);

                                // `range_bounds` clamps the end to the last byte, so a
                                // start past EOF (`bytes=5000-` on a 100-byte file)
                                // yields rs > re. `re - rs + 1` would then wrap to a
                                // nonsense Content-Length, so answer 416 instead.
                                let len = match re.checked_sub(rs).and_then(|d| d.checked_add(1)) {
                                    Some(len) => len,
                                    None => return Response::error("Range Not Satisfiable", 416),
                                };

                                let mut headers = Headers::new();
                                headers.set("Content-Type", &ct)?;
                                headers.set("Accept-Ranges", "bytes")?;
                                headers.set("Content-Range", &format!("bytes {}-{}/{}", rs, re, total))?;
                                headers.set("Content-Length", &len.to_string())?;
                                headers.set("X-Content-Type-Options", "nosniff")?;
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
                    // See the 206 branch: legacy objects predate the write-side
                    // allowlist, so the stored type is re-checked on every serve.
                    let content_type =
                        sanitize_content_type(meta.content_type.as_deref().unwrap_or_default());

                    let mut headers = Headers::new();
                    headers.set("Content-Type", &content_type)?;
                    // Safe again since migration 0002: a key is minted once per
                    // upload and never rewritten — rename moves `files.path`, and
                    // ?overwrite=1 writes a fresh key and drops the old object.
                    // The bytes behind a given key genuinely never change.
                    headers.set("Cache-Control", "public, max-age=31536000, immutable")?;
                    // Content-Type is client-supplied at upload time; never let the
                    // browser sniff an uploaded blob into an active type.
                    headers.set("X-Content-Type-Options", "nosniff")?;
                    headers.set("Accept-Ranges", "bytes")?;

                    if is_download {
                        // The key is an opaque storage name since migration 0002, so
                        // the display name has to come from the caller. Falling back
                        // to the key still gives pre-0002 files their old filename.
                        let filename = query_pairs
                            .get("name")
                            .map(|s| s.as_str())
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| key.rsplit('/').next().unwrap_or(&key));
                        headers.set("Content-Disposition", &content_disposition(filename))?;
                    }

                    cors::extend_headers(&mut headers)?;

                    Ok(Response::from_body(body.response_body()?)?.with_headers(headers))
                }
                None => Ok(Response::error("Not Found", 404)?.with_headers(cors::headers()?)),
            }
        })
        // === Public Clip API ===
        // GET /api/proxy?file_path=... — list proxy videos for a file (public)
        .get_async("/api/proxy", |req, ctx| async move {
            let url = req.url()?;
            let qs: std::collections::HashMap<String, String> =
                url.query_pairs().into_owned().collect();
            let file_path = qs.get("file_path").map(|s| s.as_str()).unwrap_or("");

            if file_path.is_empty() {
                return Ok(Response::from_json(&serde_json::json!({
                    "proxies": [],
                }))?
                .with_headers(cors::headers()?));
            }

            let proxies = db::list_proxies(&ctx, file_path).await?;
            Ok(Response::from_json(&serde_json::json!({
                "proxies": proxies,
            }))?
            .with_headers(cors::headers()?))
        })
        // POST /api/identity — issue a signed identity cookie
        .post_async("/api/identity", |mut req, ctx| async move {
            let body: serde_json::Value = req.json().await?;
            let nickname = body["nickname"].as_str().unwrap_or("").to_string();

            // Generate a random id. js_sys::Math::random() is available in WASM.
            let rand = (js_sys::Math::random() * u32::MAX as f64) as u32;
            let ts = Date::now().as_millis();
            let id = format!("{:08x}-{:08x}", rand, ts as u32);

            let secret = ctx.secret("IDENTITY_SECRET")?.to_string();
            let token = identity::sign_identity(&id, &nickname, secret.as_bytes())
                .ok_or_else(|| worker::Error::RustError("failed to sign identity token".into()))?;

            let cookie_value = format!(
                "identity={}; Path=/; SameSite=Lax; Max-Age=31536000",
                token
            );

            let mut headers = Headers::new();
            headers.set("Set-Cookie", &cookie_value)?;
            cors::extend_headers(&mut headers)?;

            Ok(Response::from_json(&serde_json::json!({
                "ok": true,
                "id": id,
                "nickname": nickname,
            }))?
            .with_headers(headers))
        })
        // GET /api/identity/me — return the current identity (or null)
        .get_async("/api/identity/me", |req, ctx| async move {
            let secret = ctx.secret("IDENTITY_SECRET")?.to_string();
            let cookie_header = req.headers().get("Cookie")?.unwrap_or_default();
            let me = identity::extract_identity_cookie(&cookie_header)
                .and_then(|token| identity::verify_identity(token, secret.as_bytes()));

            Ok(Response::from_json(&serde_json::json!({
                "identity": me.map(|p| serde_json::json!({
                    "id": p.id,
                    "nickname": p.nickname,
                })),
            }))?
            .with_headers(cors::headers()?))
        })
        // GET /api/clips — list public clips, optionally filtered by file_path
        .get_async("/api/clips", |req, ctx| async move {
            let url = req.url()?;
            let qs: std::collections::HashMap<String, String> =
                url.query_pairs().into_owned().collect();
            let file_path = qs.get("file_path").map(|s| s.as_str());
            let sort = qs.get("sort").map(|s| s.as_str()).unwrap_or("time");
            let offset: u32 = qs.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0);
            let limit: u32 = qs.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50).min(100);

            let clips = db::list_clips(&ctx, file_path, sort, offset, limit).await?;

            Ok(Response::from_json(&serde_json::json!({
                "clips": clips,
                "offset": offset,
                "limit": limit,
            }))?
            .with_headers(cors::headers()?))
        })
        // POST /api/clips — create a clip (requires identity cookie)
        .post_async("/api/clips", |mut req, ctx| async move {
            let secret = ctx.secret("IDENTITY_SECRET")?.to_string();
            let cookie_header = req.headers().get("Cookie")?.unwrap_or_default();
            let who = identity::extract_identity_cookie(&cookie_header)
                .and_then(|token| identity::verify_identity(token, secret.as_bytes()))
                .ok_or_else(|| worker::Error::RustError("identity cookie missing or invalid".into()))?;

            let body: serde_json::Value = req.json().await?;
            let file_path = body["file_path"].as_str().unwrap_or("").to_string();
            let name = body["name"].as_str().unwrap_or("").to_string();
            let description = body["description"].as_str().unwrap_or("").to_string();
            let start_time: f64 = body["start_time"].as_f64().unwrap_or(0.0);
            let end_time: f64 = body["end_time"].as_f64().unwrap_or(0.0);
            let is_public = body["is_public"].as_bool().unwrap_or(false);

            if file_path.is_empty() || start_time >= end_time {
                return Ok(Response::error("Bad Request: file_path and valid start/end times are required", 400)?
                    .with_headers(cors::headers()?));
            }

            // Generate a UUID-like id client-visible but server-generated.
            let rand = (js_sys::Math::random() * u32::MAX as f64) as u32;
            let ts = Date::now().as_millis();
            let id = format!("clip_{:08x}{:08x}", rand, ts as u32);

            db::insert_clip(
                &ctx, &id, &file_path, &who.id, &who.nickname,
                &name, &description, start_time, end_time, is_public,
            ).await?;

            let clip = db::get_clip(&ctx, &id).await?;
            Ok(Response::from_json(&serde_json::json!({
                "ok": true,
                "clip": clip,
            }))?
            .with_headers(cors::headers()?))
        })
        // DELETE /api/clips/*id — delete own clip (identity must match)
        .delete_async("/api/clips/*id", |req, ctx| async move {
            let secret = ctx.secret("IDENTITY_SECRET")?.to_string();
            let cookie_header = req.headers().get("Cookie")?.unwrap_or_default();
            let who = identity::extract_identity_cookie(&cookie_header)
                .and_then(|token| identity::verify_identity(token, secret.as_bytes()))
                .ok_or_else(|| worker::Error::RustError("identity cookie missing or invalid".into()))?;

            let id = ctx.param("id").map_or("", |v| v);

            let clip = db::get_clip(&ctx, id).await?
                .ok_or_else(|| worker::Error::RustError("clip not found".into()))?;

            if clip.identity != who.id {
                return Ok(Response::error("Forbidden: not your clip", 403)?
                    .with_headers(cors::headers()?));
            }

            db::delete_clip(&ctx, id).await?;
            Ok(Response::from_json(&serde_json::json!({"ok": true}))?
                .with_headers(cors::headers()?))
        })
        // POST /api/clips/*id/like — like a clip (identity required, no nickname needed)
        .post_async("/api/clips/*id/like", |req, ctx| async move {
            let secret = ctx.secret("IDENTITY_SECRET")?.to_string();
            let cookie_header = req.headers().get("Cookie")?.unwrap_or_default();
            let who = identity::extract_identity_cookie(&cookie_header)
                .and_then(|token| identity::verify_identity(token, secret.as_bytes()))
                .ok_or_else(|| worker::Error::RustError("identity cookie missing or invalid".into()))?;

            let id = ctx.param("id").map_or("", |v| v);
            let clip = db::get_clip(&ctx, id).await?
                .ok_or_else(|| worker::Error::RustError("clip not found".into()))?;
            if clip.is_public == 0 {
                return Ok(Response::error("Not Found", 404)?.with_headers(cors::headers()?));
            }

            db::like_clip(&ctx, id, &who.id).await?;
            let count = db::get_like_count(&ctx, id).await?;
            Ok(Response::from_json(&serde_json::json!({
                "ok": true,
                "like_count": count,
            }))?
            .with_headers(cors::headers()?))
        })
        // DELETE /api/clips/*id/like — unlike a clip
        .delete_async("/api/clips/*id/like", |req, ctx| async move {
            let secret = ctx.secret("IDENTITY_SECRET")?.to_string();
            let cookie_header = req.headers().get("Cookie")?.unwrap_or_default();
            let who = identity::extract_identity_cookie(&cookie_header)
                .and_then(|token| identity::verify_identity(token, secret.as_bytes()))
                .ok_or_else(|| worker::Error::RustError("identity cookie missing or invalid".into()))?;

            let id = ctx.param("id").map_or("", |v| v);
            db::unlike_clip(&ctx, id, &who.id).await?;
            let count = db::get_like_count(&ctx, id).await?;
            Ok(Response::from_json(&serde_json::json!({
                "ok": true,
                "like_count": count,
            }))?
            .with_headers(cors::headers()?))
        })
        // POST /api/clips/*id/report — report a public clip
        .post_async("/api/clips/*id/report", |mut req, ctx| async move {
            let secret = ctx.secret("IDENTITY_SECRET")?.to_string();
            let cookie_header = req.headers().get("Cookie")?.unwrap_or_default();
            let who = identity::extract_identity_cookie(&cookie_header)
                .and_then(|token| identity::verify_identity(token, secret.as_bytes()))
                .ok_or_else(|| worker::Error::RustError("identity cookie missing or invalid".into()))?;

            let id = ctx.param("id").map_or("", |v| v);
            let body: serde_json::Value = req.json().await?;
            let reason = body["reason"].as_str().unwrap_or("");

            let clip = db::get_clip(&ctx, id).await?
                .ok_or_else(|| worker::Error::RustError("clip not found".into()))?;
            if clip.is_public == 0 {
                return Ok(Response::error("Not Found", 404)?.with_headers(cors::headers()?));
            }

            db::report_clip(&ctx, id, reason, &who.id).await?;
            Ok(Response::from_json(&serde_json::json!({"ok": true}))?
                .with_headers(cors::headers()?))
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
            let content_type =
                sanitize_content_type(body["content_type"].as_str().unwrap_or_default());
            let custom_path = body["path"].as_str().filter(|s| !s.is_empty());
            let overwrite = body["overwrite"].as_bool().unwrap_or(false);

            // The display path the file will be listed under…
            let path = if let Some(path) = custom_path {
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
            if !overwrite && db::path_exists(&ctx, &path).await? {
                return Ok(
                    Response::from_json(&serde_json::json!({
                        "error": "duplicate",
                        "path": path,
                        "message": "A file with this name already exists.",
                    }))?
                    .with_status(409)
                    .with_headers(cors::headers()?),
                );
            }

            // …and the R2 object name, which is independent of it.
            let key = new_storage_key(filename);

            let bucket = ctx.bucket("FILE_BUCKET")?;
            let metadata = HttpMetadata {
                content_type: Some(content_type.clone()),
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
                "path": path,
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
            let content_type =
                sanitize_content_type(body["content_type"].as_str().unwrap_or_default());
            // Display path chosen at /upload/start. Falls back to the storage key
            // so a client that predates this field still produces a usable row.
            let path = body["path"].as_str().filter(|s| !s.is_empty()).unwrap_or(&key).to_string();
            let overwrite = body["overwrite"].as_bool().unwrap_or(false);

            // /upload/start ran a duplicate check, but a resumable session can be
            // completed hours or days later — by which time another upload may own
            // this path. Without this re-check the overwrite branch below would
            // delete that newer file's object and row on the strength of a stale
            // decision. Re-validate against the state that exists *now*.
            let previous = db::get_by_path(&ctx, &path).await?;
            if let Some(prev) = &previous {
                if prev.key != key && !overwrite {
                    return Ok(Response::from_json(&serde_json::json!({
                        "error": "duplicate",
                        "path": path,
                        "message": "Another file took this name while the upload was paused.",
                    }))?
                    .with_status(409)
                    .with_headers(cors::headers()?));
                }
            }

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

            // Overwrite: the row keeping this path points at a *different* R2
            // object now that keys are generated per upload, so drop that object
            // explicitly. INSERT OR REPLACE can no longer do this for us — it
            // would leave the old bytes in the bucket with nothing referencing them.
            if let Some(previous) = previous {
                if previous.key != key {
                    let _ = bucket.delete(&previous.key).await;
                }
                db::delete_by_path(&ctx, &path).await?;
                console_log!("Overwrote {} (dropped old object {})", path, previous.key);
            }

            // Insert record into D1. If this fails, clean up the R2 object.
            match db::insert_file(&ctx, &key, &path, size, &content_type).await {
                Ok(()) => {
                    console_log!("Upload complete: path={}, key={}, size={}", path, key, size);
                    Ok(Response::from_json(&serde_json::json!({
                        "ok": true,
                        "key": key,
                        "path": path,
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
        // DELETE /admin/api/files/*path — delete file from R2 + D1 (wildcard matches paths with /)
        .delete_async("/admin/api/files/*path", |req, ctx| async move {
            // Verify Cloudflare Access JWT
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Delete by: {:?}", claims.email);

            let raw = ctx.param("path").map_or("", |v| v);
            let path = decode_key(raw);

            if path.is_empty() {
                return Ok(Response::error("Bad Request: missing path", 400)?
                    .with_headers(cors::headers()?));
            }

            // The UI names files by display path; D1 holds the R2 object name.
            let record = match db::get_by_path(&ctx, &path).await? {
                Some(record) => record,
                None => {
                    return Ok(Response::from_json(&serde_json::json!({
                        "error": "not_found",
                        "message": "文件不存在。",
                    }))?
                    .with_status(404)
                    .with_headers(cors::headers()?))
                }
            };

            // Delete from R2 first, then D1.
            // If R2 fails, D1 row remains visible → retryable from UI.
            // If D1 fails after R2 success, the object is already gone
            // but retry works (R2 delete is idempotent, D1 delete is a no-op).
            let bucket = ctx.bucket("FILE_BUCKET")?;
            bucket.delete(&record.key).await?;
            db::delete_by_path(&ctx, &path).await?;

            Ok(Response::from_json(&serde_json::json!({"ok": true, "deleted": path}))?
                .with_headers(cors::headers()?))
        })
        // POST /admin/api/files/rename — rename a file (pure D1 metadata update)
        //
        // The R2 object is never touched: `files.key` is the immutable storage
        // name and only `files.path` moves. That makes rename constant-time for a
        // 4 KB thumbnail and a 40 GB video alike, and it leaves every existing
        // /api/file/{key} link working.
        .post_async("/admin/api/files/rename", |mut req, ctx| async move {
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Rename by: {:?}", claims.email);

            let body: serde_json::Value = req.json().await?;
            // `old_key`/`new_key` are the pre-0002 field names, still accepted so
            // a cached copy of the admin page keeps working after deploy.
            let field = |new: &str, legacy: &str| -> String {
                body[new]
                    .as_str()
                    .or_else(|| body[legacy].as_str())
                    .unwrap_or_default()
                    .to_string()
            };
            let old_path = field("old_path", "old_key");
            let new_path = field("new_path", "new_key");

            if old_path.is_empty() || new_path.is_empty() {
                return Ok(Response::error("Bad Request: empty path", 400)?
                    .with_headers(cors::headers()?));
            }

            if old_path == new_path {
                return Ok(Response::from_json(&serde_json::json!({
                    "ok": true,
                    "path": new_path,
                }))?
                .with_headers(cors::headers()?));
            }

            if db::path_exists(&ctx, &new_path).await? {
                return Ok(Response::from_json(&serde_json::json!({
                    "error": "duplicate",
                    "message": "目标文件名已存在。",
                }))?
                .with_status(409)
                .with_headers(cors::headers()?));
            }

            if !db::rename_path(&ctx, &old_path, &new_path).await? {
                return Ok(Response::from_json(&serde_json::json!({
                    "error": "not_found",
                    "message": "文件不存在。",
                }))?
                .with_status(404)
                .with_headers(cors::headers()?));
            }

            console_log!("Renamed: {} -> {}", old_path, new_path);
            Ok(Response::from_json(&serde_json::json!({
                "ok": true,
                "old_path": old_path,
                "new_path": new_path,
            }))?
            .with_headers(cors::headers()?))
        })
        // POST /admin/api/files/check-key — check if a display path would collide
        .post_async("/admin/api/files/check-key", |mut req, ctx| async move {
            let _claims = auth::verify_access_jwt(&req, &ctx).await?;

            let body: serde_json::Value = req.json().await?;
            let filename = body["filename"].as_str().unwrap_or("unnamed");
            let custom_path = body["path"].as_str().filter(|s| !s.is_empty());

            // Must mirror the path logic in /upload/start exactly.
            let path = if let Some(path) = custom_path {
                if path.ends_with('/') {
                    format!("{}{}", path, filename)
                } else {
                    path.to_string()
                }
            } else {
                let ts = Date::now().as_millis();
                format!("uploads/{}/{}", ts / 86400000, filename)
            };

            let exists = db::path_exists(&ctx, &path).await?;
            Ok(Response::from_json(&serde_json::json!({
                "path": path,
                "exists": exists,
            }))?
            .with_headers(cors::headers()?))
        })
        // === Admin Proxy Video API ===
        // POST /admin/api/proxy/start — begin a proxy video multipart upload
        .post_async("/admin/api/proxy/start", |mut req, ctx| async move {
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Proxy upload start by: {:?}", claims.email);

            let body: serde_json::Value = req.json().await?;
            let file_path = body["file_path"].as_str().unwrap_or("").to_string();
            let filename = body["filename"].as_str().unwrap_or("proxy.mp4");
            let label = body["label"].as_str().unwrap_or("").to_string();
            let content_type =
                sanitize_content_type(body["content_type"].as_str().unwrap_or_default());

            if file_path.is_empty() {
                return Ok(Response::error("Bad Request: file_path is required", 400)?
                    .with_headers(cors::headers()?));
            }

            // Proxy keys live under `proxies/` so they sort apart from uploads.
            let ts = Date::now().as_millis();
            let rand = (js_sys::Math::random() * u32::MAX as f64) as u32;
            let key = format!("proxies/{}/{}-{:08x}/{}", ts / 86_400_000, ts, rand, filename);

            let bucket = ctx.bucket("FILE_BUCKET")?;
            let metadata = HttpMetadata {
                content_type: Some(content_type.clone()),
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
                "file_path": file_path,
            }))?
            .with_headers(cors::headers()?))
        })
        // POST /admin/api/proxy/complete — finish proxy upload + insert DB record
        .post_async("/admin/api/proxy/complete", |mut req, ctx| async move {
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Proxy complete by: {:?}", claims.email);

            let body: serde_json::Value = req.json().await?;
            let upload_id = body["upload_id"].as_str().unwrap_or("").to_string();
            let key = body["key"].as_str().unwrap_or("").to_string();
            let file_path = body["file_path"].as_str().unwrap_or("").to_string();
            let label = body["label"].as_str().unwrap_or("").to_string();
            let content_type =
                sanitize_content_type(body["content_type"].as_str().unwrap_or_default());
            let parts_json = body["parts"]
                .as_array()
                .ok_or_else(|| worker::Error::RustError("missing parts array".into()))?;

            if upload_id.is_empty() || key.is_empty() || file_path.is_empty() {
                return Ok(Response::error("Bad Request: missing upload_id, key, or file_path", 400)?
                    .with_headers(cors::headers()?));
            }

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

            match db::insert_proxy(&ctx, &file_path, &key, &label, &content_type, size).await {
                Ok(()) => {
                    console_log!("Proxy complete: file_path={}, key={}, size={}", file_path, key, size);
                    Ok(Response::from_json(&serde_json::json!({
                        "ok": true,
                        "key": key,
                        "file_path": file_path,
                        "size": size,
                    }))?
                    .with_headers(cors::headers()?))
                }
                Err(e) => {
                    console_log!("Proxy D1 insert failed, cleaning up R2 object: {:?}", e);
                    let _ = bucket.delete(&key).await;
                    Err(e)
                }
            }
        })
        // GET /admin/api/proxy?file_path=... — list proxies for a file (admin)
        .get_async("/admin/api/proxy", |req, ctx| async move {
            let _claims = auth::verify_access_jwt(&req, &ctx).await?;
            let url = req.url()?;
            let qs: std::collections::HashMap<String, String> =
                url.query_pairs().into_owned().collect();
            let file_path = qs.get("file_path").map(|s| s.as_str()).unwrap_or("");

            if file_path.is_empty() {
                return Ok(Response::error("Bad Request: file_path query param required", 400)?
                    .with_headers(cors::headers()?));
            }

            let proxies = db::list_proxies(&ctx, file_path).await?;
            Ok(Response::from_json(&serde_json::json!({
                "proxies": proxies,
            }))?
            .with_headers(cors::headers()?))
        })
        // DELETE /admin/api/proxy?key=... — delete a proxy by its R2 key
        .delete_async("/admin/api/proxy", |req, ctx| async move {
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Proxy delete by: {:?}", claims.email);

            let url = req.url()?;
            let qs: std::collections::HashMap<String, String> =
                url.query_pairs().into_owned().collect();
            let key = qs.get("key").map(|s| s.as_str()).unwrap_or("");

            if key.is_empty() {
                return Ok(Response::error("Bad Request: key query param required", 400)?
                    .with_headers(cors::headers()?));
            }

            let bucket = ctx.bucket("FILE_BUCKET")?;
            let _ = bucket.delete(key).await;
            db::delete_proxy_by_key(&ctx, key).await?;

            Ok(Response::from_json(&serde_json::json!({"ok": true}))?
                .with_headers(cors::headers()?))
        })
        // === Admin Clip Management API ===
        // GET /admin/api/clips — list all clips
        .get_async("/admin/api/clips", |req, ctx| async move {
            let _claims = auth::verify_access_jwt(&req, &ctx).await?;
            let url = req.url()?;
            let qs: std::collections::HashMap<String, String> =
                url.query_pairs().into_owned().collect();
            let offset: u32 = qs.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0);
            let limit: u32 = qs.get("limit").and_then(|v| v.parse().ok()).unwrap_or(100).min(500);

            let clips = db::list_all_clips(&ctx, offset, limit).await?;
            Ok(Response::from_json(&serde_json::json!({
                "clips": clips,
                "offset": offset,
                "limit": limit,
            }))?
            .with_headers(cors::headers()?))
        })
        // DELETE /admin/api/clips/*id — delete any clip (admin force-delete)
        .delete_async("/admin/api/clips/*id", |req, ctx| async move {
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Admin clip delete by: {:?}", claims.email);

            let id = ctx.param("id").map_or("", |v| v);
            if id.is_empty() {
                return Ok(Response::error("Bad Request: missing clip id", 400)?
                    .with_headers(cors::headers()?));
            }

            let existed = db::delete_clip(&ctx, id).await?;
            if !existed {
                return Ok(Response::from_json(&serde_json::json!({
                    "error": "not_found",
                    "message": "切片不存在。",
                }))?
                .with_status(404)
                .with_headers(cors::headers()?));
            }

            console_log!("Admin deleted clip: {}", id);
            Ok(Response::from_json(&serde_json::json!({"ok": true}))?
                .with_headers(cors::headers()?))
        })
        // POST /admin/api/clips/*id/feature — toggle featured
        .post_async("/admin/api/clips/*id/feature", |mut req, ctx| async move {
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Clip feature toggle by: {:?}", claims.email);

            let id = ctx.param("id").map_or("", |v| v);
            let body: serde_json::Value = req.json().await?;
            let featured = body["featured"].as_bool().unwrap_or(false);

            let ok = db::set_clip_featured(&ctx, id, featured).await?;
            if !ok {
                return Ok(Response::from_json(&serde_json::json!({
                    "error": "not_found",
                    "message": "切片不存在。",
                }))?
                .with_status(404)
                .with_headers(cors::headers()?));
            }

            Ok(Response::from_json(&serde_json::json!({"ok": true}))?
                .with_headers(cors::headers()?))
        })
        // GET /admin/api/clips/reports — list unresolved reports
        .get_async("/admin/api/clips/reports", |req, ctx| async move {
            let _claims = auth::verify_access_jwt(&req, &ctx).await?;
            let url = req.url()?;
            let qs: std::collections::HashMap<String, String> =
                url.query_pairs().into_owned().collect();
            let offset: u32 = qs.get("offset").and_then(|v| v.parse().ok()).unwrap_or(0);
            let limit: u32 = qs.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50).min(200);

            let reports = db::list_reports(&ctx, offset, limit).await?;
            Ok(Response::from_json(&serde_json::json!({
                "reports": reports,
                "offset": offset,
                "limit": limit,
            }))?
            .with_headers(cors::headers()?))
        })
        // POST /admin/api/clips/reports/*id/resolve — resolve a report
        .post_async("/admin/api/clips/reports/*id/resolve", |req, ctx| async move {
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Report resolve by: {:?}", claims.email);

            let id_str = ctx.param("id").map_or("", |v| v);
            let report_id: i32 = id_str.parse().unwrap_or(0);
            if report_id == 0 {
                return Ok(Response::error("Bad Request: invalid report id", 400)?
                    .with_headers(cors::headers()?));
            }

            db::resolve_report(&ctx, report_id).await?;
            console_log!("Resolved report {}", report_id);
            Ok(Response::from_json(&serde_json::json!({"ok": true}))?
                .with_headers(cors::headers()?))
        })
        // DELETE /admin/api/identity/*id/clips — batch delete all clips by identity
        .delete_async("/admin/api/identity/*id/clips", |req, ctx| async move {
            let claims = auth::verify_access_jwt(&req, &ctx).await?;
            console_log!("Batch clip delete by: {:?}", claims.email);

            let identity_id = ctx.param("id").map_or("", |v| v);
            if identity_id.is_empty() {
                return Ok(Response::error("Bad Request: missing identity id", 400)?
                    .with_headers(cors::headers()?));
            }

            let count = db::delete_clips_by_identity(&ctx, identity_id).await?;
            console_log!("Deleted {} clips for identity {}", count, identity_id);
            Ok(Response::from_json(&serde_json::json!({
                "ok": true,
                "deleted": count,
            }))?
            .with_headers(cors::headers()?))
        })
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
