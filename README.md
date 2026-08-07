# 🐱 File Neko

*A cute cat-themed media file browser powered by Cloudflare Workers (Rust/worker-rs), R2, and D1.*

*可爱的猫咪主题媒体文件浏览器，由 Cloudflare Workers (Rust)、R2 和 D1 驱动。*

## ✨ Features / 功能

- 🖼 **Image Preview** — View images directly in browser / 直接在浏览器中预览图片
- 🎬 **Video Playback** — Play videos with built-in player / 内置播放器播放视频
- 🎵 **Audio Playback** — Listen to audio files / 在线收听音频文件
- ⬇ **One-Click Download** — Download any file instantly / 一键下载任意文件
- 📤 **Admin Upload** — Upload files via admin page (protected by Cloudflare Access) / 通过管理页面上传文件
- 🔐 **JWT Auth** — Admin API protected with Cloudflare Access JWT validation / 管理员 API 使用 Cloudflare Access JWT 验证
- 🐾 **Cute UI** — Cat-themed design with water blue, pink, and white / 猫咪主题设计（水蓝色、粉色、白色）
- 📱 **Responsive** — Works on desktop, tablet, and mobile / 响应式设计

## 🏗 Architecture / 架构

```
Browser
  ├── / (public gallery) → Static Assets + GET /api/files + GET /api/file/:key
  └── /admin (protected) → Static Assets + POST /admin/api/upload + DELETE /admin/api/files/:key

Worker (Rust/worker-rs)
  ├── D1 Database (file metadata)
  ├── R2 Bucket (file storage)
  └── ASSETS Fetcher (static files)
```

## 📋 Prerequisites / 前置要求

- [Rust](https://rustup.rs/) (stable)
- WASM target: `rustup target add wasm32-unknown-unknown`
- [Node.js](https://nodejs.org/) (for wrangler CLI)
- [Cloudflare Account](https://dash.cloudflare.com/)

## 🚀 Setup / 设置

### 1. Install dependencies

```bash
git clone <repo-url>
cd file_worker

# Install Node.js dependencies (wrangler)
npm install

# Install worker-build (one-time setup)
cargo install worker-build
```

### 2. Configure Cloudflare Resources

#### R2 Bucket
Create an R2 bucket in the Cloudflare Dashboard and update `wrangler.toml`:

```toml
[[r2_buckets]]
binding = "FILE_BUCKET"
bucket_name = "your-bucket-name"
```

#### D1 Database
Create a D1 database and update the `database_id` in `wrangler.toml`:

```bash
npx wrangler d1 create file-metadata
```

Then update `wrangler.toml` with the returned database ID, and apply migrations:

```bash
npx wrangler d1 migrations apply file-metadata
```

Migrations are in the `migrations/` directory.

#### Cloudflare Access (for admin page)
1. In Cloudflare Zero Trust dashboard, create an Application
2. Set the application domain to your worker's `/admin/*` path
3. Configure identity providers (e.g., GitHub, Google, email OTP)
4. Set these environment variables in `wrangler.toml`:

```toml
[vars]
CF_ACCESS_TEAM_DOMAIN = "your-team-name"
CF_ACCESS_AUD = "your-application-audience-tag"
```

### 3. Run locally

```bash
# Apply D1 migrations (first time)
npx wrangler d1 migrations apply zcll --local

# Start dev server
npx wrangler dev
```

Open http://localhost:8787 in your browser.

### 4. Deploy

```bash
# Apply D1 migrations to production
npx wrangler d1 migrations apply zcll

# Deploy the worker
npx wrangler deploy
```

## 📡 API Endpoints

### Public API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/files?filter=&offset=&limit=` | List files from D1 with pagination and optional filter |
| GET | `/api/file/{key}` | Serve file content from R2 (preview) |
| GET | `/api/file/{key}?download=1` | Download file with Content-Disposition header |

### Admin API (Cloudflare Access protected)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/api/files` | List all files |
| POST | `/admin/api/upload` | Upload file (multipart form: `file` + optional `path`) |
| DELETE | `/admin/api/files/{key}` | Delete file from R2 and D1 |

### Response format for `GET /api/files`:

```json
{
  "files": [
    {
      "key": "uploads/20000/example.jpg",
      "size": 123456,
      "content_type": "image/jpeg",
      "uploaded_at": "2026-08-01 12:00:00"
    }
  ],
  "offset": 0,
  "limit": 50
}
```

## 📁 Project Structure / 项目结构

```
file_worker/
├── Cargo.toml            # Rust dependencies / Rust 依赖
├── wrangler.toml          # Cloudflare Workers config / Workers 配置
├── src/
│   ├── lib.rs             # Worker entry point (Router + API) / Worker 入口
│   ├── auth.rs            # Cloudflare Access JWT validation / JWT 验证
│   ├── cors.rs            # CORS headers / 跨域头
│   └── db.rs              # D1 database operations / D1 数据库操作
├── static/
│   ├── index.html         # Public gallery page / 公共画廊页面
│   ├── admin.html         # Admin upload page / 管理员上传页面
│   ├── style.css          # Cat-themed styles / 猫咪主题样式
│   └── app.js             # Frontend gallery logic / 前端画廊逻辑
└── README.md
```

## 🛠 Tech Stack / 技术栈

- **Backend**: Rust + [worker-rs](https://github.com/cloudflare/workers-rs) 0.8
- **Storage**: Cloudflare R2
- **Metadata**: Cloudflare D1 (SQLite)
- **Auth**: Cloudflare Access (JWT)
- **Frontend**: Vanilla HTML/CSS/JS
- **Deployment**: Cloudflare Workers + Static Assets

## 🎨 Design / 设计

- **Colors**: Water blue `#89CFF0`, pink `#FFB6C1`, white `#FFFFFF`
- **Theme**: 🐱 Cat elements (paw prints, cat ears on cards, cat emojis)
- **Responsive**: Mobile-first, supports all screen sizes

## 📝 License / 许可证

MIT
