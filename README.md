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
- `[[secrets_store_secrets]].store_id` — the identity signing key, see step 4

There is no R2 S3 API token. If you set one up for an earlier version of this
worker, revoke it: nothing reads it any more, and it granted far more than the
R2 binding does.

### 4. Create the identity signing key

Clip ownership and like de-duplication ride on an HMAC-signed `identity` cookie,
so the worker needs a signing key. It is a **Secrets Store binding**, not a
`wrangler secret put` value: that keeps the dependency visible in
`wrangler.toml` next to R2/D1/KV, while the key itself stays encrypted in the
store and never enters the repo.

```bash
npx wrangler secrets-store store create zcll --remote
# note the store id it prints, then:
npx wrangler secrets-store secret create <store_id> \
  --name IDENTITY_SECRET --value "$(openssl rand -base64 32)" --remote
```

Put that `<store_id>` into the `[[secrets_store_secrets]]` block in
`wrangler.toml`, and set `secret_name` to whatever you passed to `--name`.

`secret_name` is the name inside the store and is free to change; `binding` is
what the worker looks up (`ctx.env.secret_store("IDENTITY_SECRET")`) and must
stay `IDENTITY_SECRET`. Without the binding, `/api/identity` and every clip,
like and report route returns 500.

Rotating the key invalidates every existing cookie: clips stay in D1 but their
authors can no longer prove ownership, so they cannot delete their own clips and
their likes can be cast a second time. Rotate deliberately, not routinely.

For `wrangler dev`, put `IDENTITY_SECRET=…` in a `.dev.vars` file (gitignored)
instead of reaching for the remote store.

### 5. Apply D1 migrations

```bash
npx wrangler d1 migrations apply zcll --remote
```

### 6. Deploy

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
| GET | `/api/proxy?file_path=` | List proxy videos for a file (feeds the gallery's source picker) |
| GET | `/api/attachments?file_path=` | List a file's related files (subtitles, transcripts) |
| GET | `/api/announcements?offset=&limit=` | Published announcements, pinned first, each with its media nested |
| GET | `/api/skill` | The clip-writing skill (`SKILL.md`); `?download=1` attaches it |
| POST | `/api/identity` | Issue signed identity cookie `{nickname}` |
| GET | `/api/identity/me` | Return current identity or null |
| GET | `/api/clips?file_path=&sort=likes\|time` | List public clips (set members included; filter on `set_id`) |
| POST | `/api/clips` | Create a clip (needs identity cookie) |
| GET | `/api/clip-sets?file_path=&sort=likes\|time` | List public clip sets, each with its clips inlined |
| POST | `/api/clip-sets` | Publish a whole set `{file_path, name, description, clips[]}` |
| DELETE | `/api/clip-sets/{id}` | Withdraw own set **and its clips** |
| DELETE | `/api/clips/{id}` | Delete own clip |
| PATCH | `/api/clips/{id}` | Toggle own clip public/private `{is_public}` |
| POST | `/api/clips/{id}/like` | Like a clip (needs identity cookie) |
| DELETE | `/api/clips/{id}/like` | Unlike a clip |
| POST | `/api/clips/{id}/report` | Report a clip `{reason}` |

### Admin (Cloudflare Access JWT)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/api/files` | List all files |
| POST | `/admin/api/upload/start` | Begin a multipart upload → `{upload_id, key}` |
| PUT | `/admin/api/upload/part?upload_id=&key=&n=` | Upload one chunk (raw bytes) |
| POST | `/admin/api/upload/complete?upload_id=&key=` | Finish upload + D1 insert (409s if the name was taken while paused) |
| DELETE | `/admin/api/upload?upload_id=&key=` | Abort a multipart upload |
| POST | `/admin/api/files/check-key` | Check whether a display path would collide |
| POST | `/admin/api/files/rename` | Rename — one D1 `UPDATE`, no R2 work |
| POST | `/admin/api/files/attach` | Fold a file into another file's collection as a proxy (D1 only) |
| POST | `/admin/api/proxy/detach` | Lift a proxy back out into its own file (D1 only) |
| DELETE | `/admin/api/files/{path}` | Delete. 409s with the impact unless `?mode=purge` or `?mode=promote&promote_key=` |
| POST | `/admin/api/proxy/start` | Start proxy upload `{file_path, filename, label}` |
| POST | `/admin/api/proxy/complete` | Finish proxy upload + D1 insert (409s if the file was deleted meanwhile) |
| GET | `/admin/api/proxy?file_path=` | List proxies for a file (admin) |
| DELETE | `/admin/api/proxy?key=` | Delete a proxy by R2 key |
| POST | `/admin/api/attachment/start` | Start attachment upload `{file_path, filename, label}` |
| POST | `/admin/api/attachment/complete` | Finish attachment upload + D1 insert (409s if the file was deleted meanwhile) |
| GET | `/admin/api/attachment?file_path=` | List attachments for a file (admin) |
| DELETE | `/admin/api/attachment?key=` | Delete an attachment by R2 key |
| GET | `/admin/api/announcements` | List announcements, drafts included |
| POST | `/admin/api/announcements` | Create `{title, body, pinned, is_published}` → `{id}` (draft by default) |
| POST | `/admin/api/announcements/{id}` | Edit text (`title`/`body`) or flip flags (`pinned`/`is_published`) — send only what you own |
| DELETE | `/admin/api/announcements/{id}` | Delete an announcement **and every object it carries** (502 with the row intact if R2 fails) |
| POST | `/admin/api/announcement/start` | Start announcement media upload `{announcement_id, filename, label}` |
| POST | `/admin/api/announcement/complete` | Finish it + D1 insert (409s if the announcement was deleted meanwhile) |
| GET | `/admin/api/announcement-media?announcement_id=` | List one announcement's media (admin) |
| DELETE | `/admin/api/announcement-media?key=` | Delete one media object by R2 key |
| GET | `/admin/api/clips` | List all clips |
| DELETE | `/admin/api/clips/{id}` | Delete any clip |
| GET | `/admin/api/clip-sets` | List all clip sets |
| DELETE | `/admin/api/clip-sets/{id}` | Delete any set **and its clips** |
| POST | `/admin/api/clips/{id}/feature` | Toggle featured `{featured: bool}` |
| GET | `/admin/api/clips/reports` | List unresolved reports |
| POST | `/admin/api/clips/reports/{id}/resolve` | Resolve a report |
| DELETE | `/admin/api/identity/{id}/clips` | Batch-delete all clips by identity |

### Clip export never touches the server

Two ways to get a clip out, both entirely client-side:

- **⬇ 一键下载** cuts the MP4 in the browser and saves the file. It reads the
  original's index over Range requests, works out which bytes the time window
  needs, fetches only those, and writes a new container around them — a
  **remux**, not a transcode, so the compressed video is copied unchanged and a
  20-second clip out of a 40 GB source moves about 20 seconds of bytes. A batch
  (a whole 归档) comes back as one store-only ZIP. See `static/mp4clip.js`.
- **The ffmpeg command** stays next to it, for anything the browser declines
  (fragmented MP4, a clip too large to hold in memory) and for scripting.

Both cut on a keyframe — a frame mid-GOP cannot be decoded without the ones
before it — so both produce the same clip, starting at or slightly before the
mark. The UI reports the real start time before you commit. `-g` at encode time
sets how much "slightly" is.

The worker does no transcoding, no concatenation and no clip-specific work at
all: the browser is making the same ranged `GET /api/file/{key}` requests the
player already makes.

### AI-assisted clip lists

The clip page's 🤖 AI 辅助 section hands out the two inputs an LLM needs and
takes back the result through the import path that already existed:

1. **⬇ 下载 skill / 📋 复制 skill** — `SKILL.md`, a standard Agent Skill
   (`name: clip-description`) served straight from the repo at `/api/skill`, so
   it cannot drift from the copy in git. It downloads under its conventional
   filename, ready to drop into `~/.claude/skills/clip-description/`.
2. **📎 关联文件** — subtitles, transcripts or anything else an admin attached to
   the video, uploaded from the admin page's `📎 关联文件` mode and downloaded
   here. Timestamps come from these; without one an AI is guessing.
3. The AI returns the YAML this README's skill file specifies, and it goes in
   through 暂存区 → **📥 导入 YAML**, unchanged.

Attachments download through the same public `/api/file/{key}?download=1` route
as everything else — no new serving path, and the stored type is clamped to
`application/octet-stream`, so nothing an admin uploads can execute on the
origin `/admin` lives on. They are download-only by design: `.srt` in the wild
is frequently GBK or Shift-JIS, so a copy-to-clipboard button would silently
mojibake half the world's subtitles.

### Two names per file

`files.key` is the R2 object name. It is minted once at upload and never
changes, so `/api/file/{key}` links stay valid forever — including across
renames. `files.path` is the name the UI shows and the one duplicate detection
uses; renaming edits only this column.

The consequence is that after a rename the R2 dashboard still shows the original
object name. That is the trade for renames that cost the same whether the file is
4 KB or 40 GB.

### Resumable uploads

A dropped part is retried in place (4 attempts, 1s/2s/4s backoff). If it still
fails, the multipart upload is **left open** rather than aborted, and the part
etags stay in `localStorage` — so a 40 GB transfer that dies at 90% resumes from
90% instead of from zero. The admin page shows a banner offering *继续上传* or
*放弃并清理*.

A resume after a page reload needs the same file re-selected from disk: a `File`
handle cannot be persisted, and resuming with a different file would splice
foreign bytes into the object. Name, size and last-modified must all match.

The upload section has three modes. **普通文件** uploads a new object; **代理**
attaches a low-quality playback source (360p, audio-only, …) to a file that
already exists, picked from a dropdown; **关联文件** attaches a downloadable
related file (subtitles, a transcript) the same way. All three run through the
same uploader, so both attach modes get resume, progress and the wake lock too.
The 代理与关联文件 section lists and deletes both; it no longer uploads them.

**Set an R2 lifecycle rule to abort incomplete multipart uploads** (7 days is
reasonable) in the bucket's dashboard settings. *放弃并清理* aborts the one
session it knows about, but an admin who never returns leaves parts that are
billed as storage with nothing referencing them. The rule is the only backstop
that covers that case.

Non-GET calls to `/admin/api/*` require an `Origin` header matching the worker's
own origin (CSRF defence — admin auth is a cookie). The admin page satisfies this
automatically; scripted clients must send `Origin` explicitly.

## 🎬 Video codecs

The gallery serves whatever the admin uploads — H.264, HEVC (H.265) and AV1 in
MP4 all work. Nothing server-side needs to change per codec: everything is stored
and served as `video/mp4`, and the browser decodes it.

What *does* vary is which browsers can decode what. There is no codec that is
both small and universal, so the choice is a real trade:

| Codec | Chrome | Firefox | Safari | Size vs H.264 |
|-------|--------|---------|--------|---------------|
| **H.264** | ✅ | ✅ | ✅ | baseline |
| **HEVC (H.265)** | ⚠️ macOS & Android yes; Windows only with Microsoft's HEVC Video Extensions; **Linux no** | ❌ | ✅ | ~50% |
| **AV1** | ✅ any platform (software decoder) | ✅ any platform | ⚠️ Safari 17+ **and** M3-generation Apple silicon or newer | ~50%, slower to encode |

The two lopsided rows are near-inverses, which is the thing to internalise:
Chrome has **no software HEVC decoder** and depends on one supplied by the OS,
while Chrome and Firefox both ship a **software AV1 decoder** that works
everywhere. So HEVC fails on Linux/Firefox, and AV1 fails on older Apple
hardware. **H.264 is the only universally safe choice.**

The AV1 row is the one that bites in practice, because Safari's AV1 support is
**hardware only**: an M1 or M2 Mac cannot play these files on any macOS version,
and no update will change that. That is the case the panel below exists for.

### When a browser can't decode

No server setting fixes a missing decoder, so the player fails loudly instead of
showing a black rectangle. If `<video>` reports `MEDIA_ERR_SRC_NOT_SUPPORTED`,
the preview is replaced by a panel that probes this device with `canPlayType` and
lists what it actually supports (`✅ H.264  ❌ HEVC  ✅ AV1 (10-bit)  ✅ VP9`),
names the browser to switch to for the codec it lacks, and offers a download
button — the one path that works in every browser.

Both players do this, from one shared table in `static/codecs.js`. The clip page
adds one button the gallery cannot offer: if the source it failed on is not the
only one, it offers to **switch to the smallest other source**, which is the
usual fix — an AV1 original that this device cannot decode normally sits beside
an H.264 proxy that it can, and the proxy is what you would be clipping against
anyway.

The probe runs *only after* a real failure. As a pre-flight check it would be
wrong: the file is served as `video/mp4` whatever is inside, so `canPlayType`
reports browser capability and says nothing about this file's contents.

The AV1 row probes `av01.0.05M.10` — **10-bit**, matching what the encode below
produces. A software decoder answers the same for 8- and 10-bit, so this changes
nothing on Chrome or Firefox; it is honest on a device whose AV1 support comes
from fixed-function hardware, where the two depths can differ. It is not a
detector for that gap — it is a probe for the profile actually being served.

### Encoding

NVENC on a CUDA GPU. HEVC — roughly half the bytes of H.264, which matters for R2
egress and upload time, at the cost of the Linux/Firefox gap above:

```bash
ffmpeg -hwaccel cuda -hwaccel_output_format cuda -i input.mp4 \
  -c:v hevc_nvenc -preset p6 -tune hq -rc vbr -cq 26 -b:v 0 \
  -g 48 -tag:v hvc1 -c:a copy \
  -movflags +faststart out_hevc.mp4
```

H.264 — larger files, plays everywhere:

```bash
ffmpeg -hwaccel cuda -hwaccel_output_format cuda -i input.mp4 \
  -c:v h264_nvenc -preset p6 -tune hq -rc vbr -cq 23 -b:v 0 \
  -g 48 -c:a aac -b:a 192k \
  -movflags +faststart out_h264.mp4
```

AV1 — SVT-AV1 on the CPU. This is what the archive is actually encoded with:

```bash
ffmpeg -i "$VIDEO" \
  -c:v libsvtav1 -crf 32 -preset 6 \
  -svtav1-params keyint=3s:enable-variance-boost=1 \
  -pix_fmt yuv420p10le \
  -c:a copy \
  -movflags +faststart \
  "chuan/$VIDEO"
```

- **`-pix_fmt yuv420p10le`** — 10-bit, even from an 8-bit source: it gives the
  encoder more precision in its internal transforms, which is what removes the
  banding 8-bit AV1 shows on gradients and dark scenes. This is also why the
  browser probe above is `…M.10` — the file this produces is 10-bit whatever
  the source was.
- **`-preset 6`** — SVT-AV1's speed/efficiency dial, 0 (slowest) to 13. 6 is the
  usual archive compromise; going lower costs a lot of wall-clock time.
- **`-crf 32`** — a quality target, not a bitrate. AV1's CRF scale is not
  H.264's; tune it on your own footage rather than translating a number across.
- **`enable-variance-boost=1`** — spends more bits on flat, low-variance regions,
  which is where AV1 at a high CRF looks worst. Same motivation as 10-bit.
- **`keyint=3s`** — see the GOP note below. Expressed in *seconds*, so it does
  not silently mean something different for 30 fps and 60 fps sources.

`-c:v av1_nvenc` is the GPU alternative and needs a 40-series (Ada) card or
newer; `libaom-av1 -crf 30 -b:v 0` is the reference encoder and is far slower
than SVT-AV1 for no gain here.

Flags that matter for playback through this worker specifically:

- **`-tag:v hvc1`** (HEVC only) — Safari refuses HEVC tagged `hev1`, which is
  ffmpeg's default. This is the usual reason a file plays in VLC but shows a
  black frame in Safari. Non-negotiable.
- **`-movflags +faststart`** — moves the `moov` atom to the front. Without it the
  player must fetch the tail before it can start, so playback stalls until most
  of the file has downloaded. Applies to every codec.
- **`-g 48` / `keyint=3s`** — the keyframe interval bounds how precisely a seek
  can land, and also how precisely a clip can *start*: both the one-click
  download and the ffmpeg command cut on a keyframe, so a longer GOP means a
  clip that begins further before the mark that was set. `-g 48` is a frame
  count, so it is ~2s at 24–25 fps but only 0.8s at 60 fps; SVT-AV1's
  `keyint=3s` is a duration and means 3s at any frame rate — so an AV1 clip can
  begin up to 3 seconds early, and the clip page says which second it actually
  starts on. The worker's HTTP Range support (`206` on `/api/file/{key}`) is
  what turns a seek into a small ranged fetch instead of a full download — and
  is what makes the in-browser clipping possible at all.

`-c:a copy` keeps the source's audio codec. If your sources aren't uniform, use
`-c:a aac -b:a 192k` — Opus in MP4, for example, will not play in Safari, and
`copy` carries that problem forward.

Use MP4. `.mkv` passes the server's `video/*` check but no browser plays it, so
it reaches the same "can't decode" panel with the container, not the codec, as
the cause.

Uploading a re-encode under the same name is an **overwrite** (the admin page
offers it when the name collides). That writes a new R2 object and drops the old
one, so the `/api/file/{key}` URL changes — which is exactly what keeps the
year-long `immutable` cache correct.

## 📁 Structure

```
file_worker/
├── Cargo.toml
├── wrangler.toml
├── SKILL.md             # Agent Skill: writing clip descriptions, served at /api/skill
├── migrations/          # D1 migrations
├── src/
│   ├── lib.rs           # Worker entry + Router
│   ├── auth.rs          # Cloudflare Access JWT verification
│   ├── cors.rs          # CORS headers
│   └── db.rs            # D1 operations
├── static/            # no build step — plain HTML/CSS/JS, served by [assets]
│   ├── index.html       # Public gallery + clip rank
│   ├── app.js           #   its logic
│   ├── clip.html        # Clipping page
│   ├── clip.js / .css   #   its logic and styles
│   ├── admin.html       # Admin upload page
│   ├── admin.js / .css  #   its logic and styles
│   ├── mp4clip.js       # In-browser MP4 cutting (remux, no re-encode)
│   ├── codecs.js        # Codec probe + "can't decode" panel, shared by both players
│   └── style.css        # Shared cat-themed styles
└── README.md
```

## 🎨 Design

Water blue `#89CFF0` · pink `#FFB6C1` · white `#FFFFFF` — with 🐱 cat elements throughout.
