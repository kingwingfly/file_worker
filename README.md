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
