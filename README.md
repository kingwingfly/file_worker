# 🐱 File Neko

A cute cat-themed media file browser powered by Cloudflare Workers (Rust/worker-rs), R2, and D1.

## 🏗 Architecture

```
Browser
  ├── / (public gallery) → Static Assets + GET /api/files + GET /api/file/:key
  └── /admin (protected by Cloudflare Access) → Static Assets + admin API

Worker (Rust/worker-rs)
  ├── D1 — file metadata
  ├── R2 — file storage
  ├── KV — JWKS cache
  └── ASSETS — static files
```

## 🚀 Deploy

### 1. Prerequisites

- [Rust](https://rustup.rs/) + `rustup target add wasm32-unknown-unknown`
- [Node.js](https://nodejs.org/)
- [Cloudflare Account](https://dash.cloudflare.com/)

### 2. Install

```bash
git clone <repo-url> && cd file_worker
npm install
cargo install worker-build
```

### 3. Configure

Edit `wrangler.toml` with your resource IDs:
- `[[r2_buckets]]` — your R2 bucket name
- `[[d1_databases]]` — your D1 database name + id
- `[[kv_namespaces]]` — your KV namespace id (for JWKS cache)
- `[vars].CF_ACCESS_TEAM_DOMAIN` — your Cloudflare Access team domain
- `[vars].CF_ACCESS_AUD` — your Cloudflare Access application audience tag

No R2 S3 API token is needed. Rename used to require one; migration 0002 made it
a D1-only operation, so the `CLIENT_ID` / `CLIENT_SECRET` secrets-store bindings
and the `CF_ACCOUNT_ID` / `R2_BUCKET_NAME` vars are gone. If you configured that
token, revoke it — it granted far more than the R2 binding does.

### 4. Apply D1 migrations

```bash
npx wrangler d1 migrations apply zcll --remote
```

### 5. Deploy

```bash
npx wrangler deploy
```

## 📡 API

### Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/files?filter=&offset=&limit=` | List files from D1 |
| GET | `/api/file/{key}` | Serve file from R2 (preview) |
| GET | `/api/file/{key}?download=1` | Download file |

### Admin (Cloudflare Access JWT)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/api/files` | List all files |
| POST | `/admin/api/upload/start` | Begin a multipart upload → `{upload_id, key}` |
| PUT | `/admin/api/upload/part?upload_id=&key=&n=` | Upload one chunk (raw bytes) |
| POST | `/admin/api/upload/complete?upload_id=&key=` | Finish upload + D1 insert |
| DELETE | `/admin/api/upload?upload_id=&key=` | Abort a multipart upload |
| POST | `/admin/api/files/check-key` | Check whether a display path would collide |
| POST | `/admin/api/files/rename` | Rename — one D1 `UPDATE`, no R2 work |
| DELETE | `/admin/api/files/{path}` | Delete file from R2 + D1 |

### Two names per file

`files.key` is the R2 object name. It is minted once at upload and never
changes, so `/api/file/{key}` links stay valid forever — including across
renames. `files.path` is the name the UI shows and the one duplicate detection
uses; renaming edits only this column.

The consequence is that after a rename the R2 dashboard still shows the original
object name. That is the trade for renames that cost the same whether the file is
4 KB or 40 GB.

Non-GET calls to `/admin/api/*` require an `Origin` header matching the worker's
own origin (CSRF defence — admin auth is a cookie). The admin page satisfies this
automatically; scripted clients must send `Origin` explicitly.

## 🎬 Encoding videos

HEVC (H.265) roughly halves the file size of H.264 at the same quality, which is
worth it here because R2 egress and upload time both scale with bytes. NVENC on a
CUDA GPU:

```bash
ffmpeg -hwaccel cuda -hwaccel_output_format cuda -i input.mp4 \
  -c:v hevc_nvenc -preset p6 -tune hq -rc vbr -cq 26 -b:v 0 \
  -g 48 -tag:v hvc1 -c:a copy \
  -movflags +faststart out_hevc.mp4
```

Three of those flags matter for playback through this worker specifically:

- **`-tag:v hvc1`** — Safari refuses HEVC tagged `hev1`, which is ffmpeg's
  default. This is the usual reason a file plays in VLC but shows a black frame
  in Safari. Non-negotiable.
- **`-movflags +faststart`** — moves the `moov` atom to the front of the file.
  Without it the player must fetch the tail before it can start, so playback
  stalls until most of the file has downloaded.
- **`-g 48`** — a keyframe every ~2s bounds how precisely a seek can land. The
  worker's HTTP Range support (`206` responses on `/api/file/{key}`) is what
  turns a seek into a small ranged fetch instead of a full download.

`-c:a copy` keeps whatever audio codec the source had. If your sources aren't
uniform, use `-c:a aac -b:a 192k` instead — Opus in MP4, for example, will not
play in Safari and `copy` carries that problem forward.

### Browser support — read this before converting everything

| Browser | HEVC in MP4 |
|---------|-------------|
| Safari (macOS / iOS / iPadOS) | ✅ |
| Chrome / Edge on macOS | ✅ |
| Chrome on Android | ✅ (with a hardware decoder) |
| Chrome / Edge on Windows | ⚠️ only with Microsoft's HEVC Video Extensions installed |
| Chrome on Linux | ❌ |
| Firefox (all platforms) | ❌ |

Chrome has **no software HEVC decoder** — it plays HEVC only where the operating
system provides a hardware one. No server-side setting changes this, so an
HEVC-only library is genuinely unplayable for some visitors.

The gallery handles that honestly rather than silently: if the `<video>` element
reports `MEDIA_ERR_SRC_NOT_SUPPORTED`, the preview is replaced with an
explanation and a download button, so the file is still reachable.

If you need playback everywhere, encode H.264 instead — same container flags,
noticeably larger files:

```bash
ffmpeg -hwaccel cuda -hwaccel_output_format cuda -i input.mp4 \
  -c:v h264_nvenc -preset p6 -tune hq -rc vbr -cq 23 -b:v 0 \
  -g 48 -c:a aac -b:a 192k \
  -movflags +faststart out_h264.mp4
```

Uploading a re-encode under the same name is an **overwrite** (the admin page
offers it when the name collides). That writes a new R2 object and drops the old
one, so the `/api/file/{key}` URL changes — which is exactly what keeps the
year-long `immutable` cache correct.

## 📁 Structure

```
file_worker/
├── Cargo.toml
├── wrangler.toml
├── migrations/          # D1 migrations
├── src/
│   ├── lib.rs           # Worker entry + Router
│   ├── auth.rs          # Cloudflare Access JWT verification
│   ├── cors.rs          # CORS headers
│   └── db.rs            # D1 operations
├── static/
│   ├── index.html       # Public gallery
│   ├── admin.html       # Admin upload page
│   ├── style.css        # Cat-themed styles
│   └── app.js           # Gallery logic
└── README.md
```

## 🎨 Design

Water blue `#89CFF0` · pink `#FFB6C1` · white `#FFFFFF` — with 🐱 cat elements throughout.
