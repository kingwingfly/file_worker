# CLAUDE.md — file_worker (zcll-worker)

Rust Cloudflare Worker (`worker-rs` 0.8) serving a media gallery from R2 + D1.
`src/lib.rs` routes, `src/auth.rs` Access JWT, `src/db.rs` D1, `static/` frontend.

## Build / check

```bash
cargo check --target wasm32-unknown-unknown   # fast loop; always run before claiming done
npx wrangler deploy                            # runs worker-build --release
npx wrangler tail                              # the only way to see runtime errors
```

There are no tests. `cargo check` passing says nothing about runtime behaviour —
most bugs in this project are JS-interop bugs that only appear in `wrangler tail`.

## Hard-won constraints — do not re-break these

### Renaming is a D1 update, never an R2 copy

`files.key` is the R2 object name and is immutable — minted by `new_storage_key()`
at upload and never rewritten. `files.path` is the mutable display name. Rename
(`db::rename_path`) touches only `path`, so it is O(1) for a 40 GB video and every
existing `/api/file/{key}` link keeps working. Migration 0002 introduced this.

Do not "simplify" this back into a key rewrite. The Workers R2 binding has **no**
`copy` (`R2Bucket` is head/get/put/delete/delete_multiple/list/
create_multipart_upload/resume_multipart_upload only), so a key rewrite means one
of two bad options, both of which this project has already tried and abandoned:

- `bucket.get(old).bytes()` → `bucket.put(new, …)`: buffers the file in the
  Worker's 128 MB heap. OOMs on any real video.
- S3 `CopyObject` against `<account_id>.r2.cloudflarestorage.com`: server-side but
  still moves every byte (~15 MB/s measured — a 300 MB rename took 20 s and larger
  files failed), and it needs an R2 S3 API token, a much broader credential than
  the R2 binding. Deleted in favour of the `path` column; do not reintroduce it.

`ObjectBody::stream()` pumps every byte through WASM (CPU-billed) and worker-rs
0.8.5 gives no way to hand the raw `ReadableStream` back to `bucket.put`, so there
is no cheap streaming middle ground either.

### Consequences of the two-name model

Anything the user names is a **path**; anything R2 is asked about is a **key**.
Mixing them up is the easy bug here.

- Admin routes (`DELETE /admin/api/files/*path`, rename, check-key) take paths and
  resolve to a key via `db::get_by_path` before touching the bucket.
- `/api/file/*key` takes the storage key and does **no** D1 read — that keeps the
  Range path (dozens of requests per video playback) at zero extra latency.
- Because the key is opaque, `?download=1` cannot derive a filename from it. The
  frontend passes `&name=`; the fallback to the key only helps pre-0002 rows.
- `INSERT OR REPLACE` no longer implements `?overwrite=1`: keys are fresh per
  upload, so the replace would never fire and the old object would leak. The
  complete handler explicitly deletes the previous row's object.
- `SELECT` lists use `COALESCE(path, key)` as a default, but every `WHERE` filters
  on bare `path` — `COALESCE(...) = ?` is an expression `idx_files_path` cannot
  serve, so it would full-scan on the upload hot path. Migration 0002 backfills
  `path` for all rows, which is what makes the bare column safe.
- Key immutability is convention, not enforcement: `/upload/part` and
  `/upload/complete` take `key` from the client's query string, so an admin client
  that reused an existing key would rewrite bytes an `immutable` cache is holding
  for a year. Never let the client pick the key at `/upload/start`.

### Route params: `:id` for a segment, `*key` only at the end

worker-rs 0.8.5 hands the pattern straight to `matchit` 0.7 and **panics** if the
insert fails — and the panic happens while the `Router` is being built, i.e. on
*every* request, so one bad pattern takes the whole Worker down, not just its own
route. `matchit` rejects a catch-all that is not the last thing in the pattern:
`/api/clips/*id/like` is `InsertError::InvalidCatchAll`, and `/api/clips/*id`
next to `/api/clips/*id/like` in the same method map is a `Conflict`.

So `*name` is only for values that legitimately contain `/` — object keys and
display paths (`/api/file/*key`, `/admin/api/files/*path`) — and only as the
final segment. Anything with a segment after it, or any id that cannot contain a
slash (clip ids, report ids, identity ids), takes `:name`.

`cargo check` will not catch this. Neither will a unit test — there are none.
It shows up as a 500 on every route at once.

### One uploader, three modes

The admin upload section uploads a new file, a **proxy** (a low-quality playback
source) or an **attachment** (a downloadable related file — subtitles, a
transcript); `session.mode` picks the branch. Only `/start` and `/complete`
differ — `/admin/api/upload/part` already served all three — so both attach
modes get resume, the progress bar, the wake lock and the retry set for free.
Proxies used to have a parallel stripped-down uploader that had none of it, and
attachments would have grown a second one.

**Never test the mode with a bare `=== 'proxy'`.** With two modes that
comparison doubled as "not a plain file upload"; with three it silently
reclassifies attachments as file uploads. Every site goes through
`attachSpec(mode)`, which returns the mode's endpoints/labels or `null` for a
plain file — so a legacy session with no `mode` still resolves to a file upload
without a special case, and the audit is one grep instead of nine.

Three things that must stay branched:

- **`uploadLanded()`**, the reconcile oracle for a lost `/complete` response,
  queries the mode's own listing (`spec.listUrl`). An attached upload is never
  in `/admin/api/files`, so asking the file listing would report every
  *successful* proxy/attachment upload as failed — and `complete` is the one
  step that must never be blindly retried, because it has already consumed the
  multipart upload, so two reported failures send the admin to Discard over an
  object sitting in the bucket. This is the expensive one to get wrong.
- **`check-key` is skipped in both attach modes.** It tests `files.path` for
  collisions; proxies and attachments are deliberately many-per-`file_path`, so
  it would raise the overwrite dialog over an unrelated file, and overwrite
  means nothing for either.
- **`filename` is sent at `/attachment/complete` and ignored by
  `/proxy/complete`.** A proxy is only ever played, so its opaque storage key is
  enough; an attachment is downloaded, and `/api/file/{key}?download=1` has no
  way to derive a display name from a key (migration 0002).

`sessionAttachPath()` / `sessionAttachLabel()` also read the pre-rename
`proxyFilePath` / `proxyLabel` fields, so an upload already in flight when this
version ships still resumes.

### Related files ride the public `/api/file` route

`file_attachments` (migration 0005) is a structural twin of `proxy_videos`:
many per `files.path`, one R2 object each, listed publicly at
`/api/attachments?file_path=`. It is a separate table rather than a `kind`
column, because a proxy is a *playback source* (the clip page puts it in the
source selector and cuts against it) and an attachment is a *download* — they
share the upload path and nothing else, and merging them would put a `WHERE
kind=` on `/api/proxy`, which runs on every clip-page load.

There is **no attachment download route**. `/api/file/*key` already does no D1
read, and already re-clamps any non-media stored type to
`application/octet-stream`, so `/api/file/{key}?download=1&name={filename}`
serves an attachment safely today. `sanitize_attachment_content_type()` exists
only so the record carries something more descriptive than octet-stream; it is
D1/R2 metadata and the serve path must keep ignoring it. Teaching
`/api/file/*key` to honour it would reopen the stored-XSS hole on the same
origin as `/admin`.

Like proxies, attachments are in `repoint_file_path` (rename detaches them
otherwise, silently) and in the file-delete cleanup (nothing enumerates their
R2 objects once the `files` row is gone).

The clip page offers **download only, never copy-to-clipboard**. `.srt` in the
wild is routinely GBK, Big5 or Shift-JIS, and `Response.text()` assumes UTF-8 —
copying would hand over silent mojibake with no signal anything went wrong. A
plain `<a download>` preserves the bytes and never puts the file in the page's
heap. The skill keeps its copy button because that content is ours and
known-UTF-8.

### `SKILL.md` is served from the repo, not copied into `static/`

`GET /api/skill` returns the repo's own `SKILL.md` via `include_str!`, so the
skill the clip page hands out cannot drift from the one the README points at.
Its `Cache-Control` is `max-age=300`, deliberately not the `immutable` used for
`/api/file/*key` — unlike an R2 key this content changes with every deploy.

`?download=1` attaches it **under the name `SKILL.md`**, not a prettified one:
it is a standard Agent Skill with YAML frontmatter (`name: clip-description`),
and that filename is what lets it drop into `~/.claude/skills/<name>/` without
being renamed. The UI calls it "skill" for the same reason — it is a skill, not
a page of instructions.

The bare URL stays inline so the page's 复制 button can fetch it. The
static-assets binding serves `static/`, and `SKILL.md` is not in there — do not
"simplify" this by copying the file, that is two copies in git and the served
one goes stale first.

### Sources: gallery picks, clip page defaults to the smallest

`/api/proxy` is public, so the gallery preview offers the original plus every
proxy as playback sources, and `downloadFile` follows the selection. Export
deliberately does **not** — clipping happens against the proxy, export always
against the HQ original. That holds for both export paths: the ffmpeg command
and the one-click download below.

The clip page defaults its preview to the smallest source, **including
audio-only proxies**. It used to exclude them for a video file, reasoning that
opening in sound-only mode hides the picture needed to pick boundaries. That
reasoning fails in exactly the case it matters: when a file's *only* proxy is
audio-only, the filter left nothing eligible and fell back to the original — so
uploading a 30 MB proxy still had the page pulling a 40 GB source. Between "no
picture" and "no playback at all", no picture wins.

The old concern is real, so it is handled rather than designed around:
`updatePreviewNote` says the preview is sound-only and renders a
切换到画面 button that switches to the smallest source that has one. Defaulting
to audio is only acceptable because getting the picture back is one tap.

The original's size is not in `proxy_videos`, so the clip link carries `&size=`.
Without it the original ranks as unknown-and-largest, which is the right
fallback — a proxy exists in order to be smaller.

### One-click clip download is a remux in the page (`static/mp4clip.js`)

The ⬇ button cuts the MP4 client-side and hands back a file; the ffmpeg command
stays beside it as the fallback. **Still no server-side transcoding or
concatenation** — the Worker only serves the same ranged `/api/file/{key}` reads
the player already makes.

It works because `moov` carries, per sample, a decode time, a byte offset and a
size. So the module walks the top-level boxes with 16-byte Range requests to
find `moov` (2–3 requests, faststart or not), resolves the time window to byte
ranges *before* fetching any media — which is also where the exact output size on
the button comes from — then fetches only those ranges and writes a fresh
container. A 20-second clip out of a 40 GB source moves ~20 seconds of bytes.

`stsd` is copied **verbatim**, which is why H.264, HEVC and AV1 all work and why
no codec is named anywhere in that file. Same reasoning as the `canPlayType`
rule above: the container is knowable, the contents are not.

Three things that look optional and are not:

- **The emitted `elst` is load-bearing.** It was left out at first, and both the
  AAC priming delay and the composition-time shift leaked into the output —
  video at `start_time=0.066667` against audio at `0.000`, a 67 ms lag, clearly
  visible. `media_time = sourceEditOffset + t0*timescale - firstKeptSampleDts`
  reproduces exactly what ffmpeg's own `-c copy` writes, and is provably ≥ 0, so
  a version-0 `elst` always suffices.
- **`ctts` is therefore copied unmodified.** The formula above assumes untouched
  composition offsets. Normalising them *as well* (subtracting the minimum, the
  obvious-looking way to force a 0 start) trims the same shift twice and pulls
  video ahead of audio by exactly as much as omitting the `elst` pushed it
  behind.
- **The cut snaps back to the previous keyframe**, because decoding is the thing
  being refused. `plan()` returns `actualStart` and the UI says so. `ffmpeg -ss T
  -c copy` snaps identically, so both export paths produce the same clip.

Declines are explicit and always name a reason — fragmented MP4 (samples live in
`moof`, so `mvex` in `moov` is the tell), non-MP4, oversized `moov`, clip too
large for memory. Each one falls back to the ffmpeg command. A silent failure
would be worse than not offering the button.

Verify by remuxing, not by looking: decode both the clip and the source to
`ffmpeg -f framecrc` (with `-c copy`, so no decoder is involved) and assert the
clip's packets are a contiguous byte-identical run of the source's; then
`ffprobe` both streams' `start_time` for the A/V offset above. A per-frame
`framemd5` comparison will show spurious diffs at the boundary — the decoder
resets state there — and that noise is what hides the real 67 ms bug.

### Clips carry their file's key (`file_key`)

A clip row stores `file_path` — the *mutable display name* — and nothing else
about its file. That is enough on the clip page, which already has the key in its
own query string, but not for the gallery's clip rank, which lists clips across
every file and has to build `/api/file/{key}` URLs to play or cut them.

So `CLIP_COLUMNS` joins `files` (`CLIP_FROM`) and projects `file_key`,
`file_content_type` and `file_size`. Two things about that join:

- **`LEFT JOIN`, not inner.** A clip whose file was deleted still lists, with
  `file_key: null`, and the UI shows 源文件已删除 instead of play/export buttons.
  An inner join would make those rows silently vanish from every query —
  including their author's own list, so they could never be cleaned up.
- It joins on `files.path`, which `idx_files_path` covers as a UNIQUE index, so
  it is one index lookup per row. Joining on anything else here would put a scan
  on `/api/clips`.

`list_all_clips` (admin) spells the same columns out rather than reusing the
const, because it has no viewer identity to bind and hardcodes `0 AS liked`.

### Clip sets group, `is_public` decides

Migration 0004 adds `clip_sets` and a nullable `clips.set_id`. `set_id` is
**grouping only** — `clips.is_public` stays the single source of truth for
visibility. Two flags would eventually disagree, and the gallery player wants one
flat list of public clips whatever their grouping, which a nullable `set_id`
gives for free: `/api/clips` returns members too, and the clip page's shared area
filters them out with `!c.set_id` so they are not listed twice.

A set's `like_count` is the **sum of its members' likes**. There is no
`clip_set_likes` table, so the per-clip heart on the gallery keeps meaning what
it always did, and "sort by likes" over collections needs no new schema.

`clip_sets.file_path` joins on `files.path` — the mutable name — so it is in
`repoint_file_path` alongside `clips` and `proxy_videos`. Leaving it out detaches
every collection on rename, silently: the set survives, and no query with the new
path finds it. Same reason it is in `delete_clips_for_path`,
`delete_clips_by_identity` and `rename_identity_nickname`.

Deleting a set deletes its clips. The set is what was published, so it is what
gets withdrawn; leaving members behind as loose public clips would mean the
author's "delete" did not remove what they pointed at.

### `IDENTITY_SECRET` is a Secrets Store binding, not `ctx.secret()`

It is declared as `[[secrets_store_secrets]]` in `wrangler.toml`, so it is read
with `ctx.env.secret_store("IDENTITY_SECRET")?.get().await` — an **async** call.
That is why `identity_secret()` and `current_identity()` are async and every
identity-gated handler awaits them. `ctx.secret()` will not find it: that method
reads plain env secrets (`wrangler secret put`), which is a different mechanism.

The binding form was chosen on purpose over both alternatives. `wrangler secret
put` works but leaves nothing in `wrangler.toml`, so a fresh clone cannot see the
dependency exists until every clip route 500s. `[vars]` would put an HMAC signing
key in git, where anyone who can read the repo can forge an identity cookie —
impersonate a clip author, delete their clips, and stuff like counts.

Rotating the key silently orphans data: clips survive in D1 but no cookie can
prove ownership of them any more, so authors lose the ability to delete their own
clips and every like can be cast again.

### Header values are ByteStrings

`Headers::set` with any code point above U+00FF throws. Filenames here are
routinely Chinese, so never interpolate a key/filename into a header raw. Use
`content_disposition()` in `lib.rs` (RFC 5987 `filename*=UTF-8''…` plus an
ASCII-sanitised fallback).

### Key encoding across the wire

Frontend `encodePath()` percent-encodes each `/`-separated segment.
`Url::path()` returns the still-encoded path, so wildcard routes must
`decode_key()` the `*key` param. Query-string params (`?key=`) are already
decoded by `query_pairs()` — decoding them again corrupts keys containing `%`.

### D1

`D1Type` has no 64-bit integer. File sizes are bound as `D1Type::Real(size as
f64)`; SQLite's INTEGER affinity stores the lossless float. Do **not** "fix" this
to `Integer(i32)` — it truncates files over 2 GB.

### Content-Type is attacker-controlled

`/api/file/*key` echoes the stored Content-Type on the same origin as `/admin`,
so `sanitize_content_type()` in `lib.rs` clamps uploads to `image|video|audio`
(minus `image/svg+xml`) and falls everything else back to
`application/octet-stream`. `X-Content-Type-Options: nosniff` does *not* cover
this — it only stops sniffing away from a declared type. Keep both.

`Cache-Control` on that route is `public, max-age=31536000, immutable`. That is
only correct because keys are content-stable: rename moves `files.path`, and
`?overwrite=1` mints a fresh key rather than rewriting one. If you ever make a
key's bytes mutable again, this header must come down with it or clients will pin
stale content for a year.

### Multi-step mutations need an order

R2 and D1 are not transactional together, so every route that touches both has a
deliberate order. Upload commits the object, then inserts the row, and deletes the
object if the insert fails. Delete removes the object first, then the row, so a
half-failure leaves a retryable row rather than a phantom listing. Rename no
longer touches R2 at all, which is the main reason the whole class of problem
mostly went away.

### Video codecs

Uploads are a mix of H.264, HEVC and AV1 (see README for the matrix and ffmpeg
commands). Nothing server-side varies per codec — everything is stored and served
as `video/mp4`. Two facts drive the frontend handling and are easy to get
backwards:

- Chrome has **no software HEVC decoder**; it needs one from the OS. HEVC fails
  on Chrome/Linux and on Firefox everywhere.
- Chrome and Firefox **do** ship a software AV1 decoder, so AV1 works on any
  platform there. Safari needs 17+ *and* M3-generation silicon.

Because the served type is `video/mp4` whatever is inside, the player cannot know
in advance whether a file is decodable. Do **not** add a `canPlayType` gate before
playback — it reports browser support, not file contents, and would warn on H.264
files too. The `<video>` `error` listener in `openPreview` checks for
`MEDIA_ERR_SRC_NOT_SUPPORTED`; only then does `unplayableNotice` probe all four
codecs to describe the device and offer a download. Post-failure diagnosis is the
correct use of `canPlayType`; pre-flight gating is not.

Deliberately not implemented: parsing the MP4 `stsd` box (via a Range fetch) to
name the file's actual codec. It ends at the same download button, and needs a
moov-at-tail fallback for files without `+faststart`.

### Resumable uploads live in the client, because they have to

worker-rs 0.8.5's `MultipartUpload` is `upload_part` / `abort` / `complete` and
nothing else — **there is no `list_parts`**. The server therefore cannot tell a
returning client which parts already landed, so the part etags are persisted in
`localStorage` under `zcll.upload.session` and replayed at `/upload/complete`.
Do not "move this to the server"; there is no API to move it to.

Consequences that are easy to break:

- A failed part no longer aborts the multipart upload. That abort is what used
  to discard hours of transfer. The open upload is the resume point; `Discard`
  and an R2 lifecycle rule (see README) are what stop them accumulating.
- The session stores `chunkSize` and every read uses it, never `CHUNK_SIZE`.
  R2 requires all parts but the last to be identically sized, so changing the
  constant would corrupt any session started under the old value.
- Resume replays the stored server-minted `key`. It never calls `/upload/start`
  again — that would mint a second key and orphan everything already sent —
  which keeps "never let the client pick the key" true.
- Resume is gated on name + size + lastModified matching. A mismatched file
  would splice foreign bytes into the object and every part would still have a
  valid etag, so nothing downstream would notice.
- `/upload/complete` re-checks the path and 409s unless the session carried
  `overwrite`. `/upload/start`'s duplicate check can be days stale by the time
  a resumed session completes, and the overwrite branch below it deletes the
  colliding row's R2 object — on a stale decision that destroys a live file.
- Only 0 (no response), 408, 425, 429 and 5xx are retried. 401/403 is an
  expired Access cookie, which needs a reload, not backoff. **408 is the
  common one**: Cloudflare drops a request whose body arrives too slowly, on
  an undocumented edge timeout. It is transient and must stay in that set —
  leaving it out turned every slow part into a manual Resume.
- Part size comes from `chunkSizeFor()` and is bounded by the edge timeout,
  not by R2. 8 MB needs roughly a third of the sustained upstream that 25 MB
  did, and a part that does time out is cheaper to resend. Raising it back
  trades 408s for fewer requests; don't, without measuring the upstream.
  Sessions stored under an older size keep working — they carry their own.

## Frontend

Plain HTML/CSS/JS, no build step. Each page is three files:

| page | logic | styles |
|---|---|---|
| `index.html` (gallery + clip rank) | `app.js` | `style.css` |
| `clip.html` | `clip.js` | `style.css` + `clip.css` |
| `admin.html` | `admin.js` | `style.css` + `admin.css` |

Plus `mp4clip.js`, loaded by both `index.html` and `clip.html` — **before** their
own script in both, since they call into it at click time.

`style.css` is shared and holds the tokens; `clip.css` / `admin.css` hold only
what is page-specific. The split was mechanical (the tags were replaced by
`<link>`/`<script src>` and the blocks dedented, nothing else), so page-local
rules stayed page-local rather than being merged into the shared sheet.

An external classic script has the same global scope as the inline one it
replaced, so `'use strict'` at the top of each file still covers that whole file
and top-level declarations are still shared across scripts on the page. Ordering
is the thing to preserve, not scoping.

One deployment consequence: `admin.js` and `admin.css` are now separate static
assets rather than bytes inside `admin.html`. Cloudflare Access is what protects
`/admin`, so confirm the application's path also covers them. Nothing in either
file is a secret and the security boundary is unchanged — `verify_access_jwt`
runs server-side on every `/admin/api/*` route — but the admin UI's source is
worth keeping behind the same door as the page.

### Page containers need an explicit `width: 100%`

`body` is `display: flex; flex-direction: column`, so `.admin-container` and
`.clip-container` are flex items. Their `margin: 0 auto` is an **auto margin on
the cross axis**, which switches off `align-items: stretch` and leaves the box
sized `fit-content` — and `fit-content` is floored by the widest child's
*min-content* width. Any child that cannot wrap (a `nowrap` flex row, a long
unbroken string) therefore widens the whole page and every section overflows a
phone sideways.

This was latent for as long as nothing had a min-content wider than a phone;
the admin section nav (seven pills, deliberately `overflow-x: auto`) tripped it
immediately — the page went to 579px inside a 390px viewport. `width: 100%`
gives the flex item a definite cross size and pins it to the viewport;
`min-width: 0` on the offending child does **not** fix it, and neither does
dropping the `overflow-x` or the `position: sticky`.

Check it the way it was found: load the page in a same-origin iframe sized to
390px and compare `documentElement.scrollWidth` against `innerWidth`. Nothing
else in this repo catches horizontal overflow.

### Responsive bands, and `dvh` over `vh`

Three bands, shared by all three pages: ≤640 phone, 641–1023 tablet, ≥1024
desktop. Don't add a fourth — `style.css` already keys the gallery grid off the
same numbers. Finger-sized hit targets are gated on `(pointer: coarse)`, not on
width, so a narrow desktop window keeps its compact controls.

Viewport-height units are `dvh`. iOS Safari's `vh` is the **large** viewport
(address bar collapsed), so a `90vh` dialog still overflows while the bar is
showing. Overlays scroll (`align-items: flex-start; overflow-y: auto`) and the
dialog inside is capped in `dvh` — a centred flex child with no max-height puts
the action row off-screen on a phone in landscape, unreachable.

### `max-height: 100%` does not bound the preview player

`.modal-media` is a flex item whose height comes from `flex-grow`, so it has no
*definite* height and a percentage `max-height` on its child computes to `none`.
Pair that with `width: 100%` and the video's height comes from its aspect ratio
instead — 1300px wide ÷ 16:9 = 731px in a 709px box. The picture overflowed top
and bottom the moment metadata arrived, and when the clip panel shrank the box
to 530px the video stayed 731px and rode up off the top of the screen.

The fix is `align-self: stretch` on the media element: it takes the height
straight from the flex container, so it is always definite and always
re-resolves when the clip panel opens or closes. `object-fit` then fits the
picture inside that box — `contain` for video (upscaling to fill is what it
already did), `scale-down` for images so a small image is not blown up.
`.modal-media` also has `overflow: hidden` as a backstop, which is why
`.media-unplayable` scrolls: it holds the download button, the only control on
that screen, and clipping it would strand the user.

Check this by measuring, not by looking. Open the modal in a same-origin
iframe, play the video, toggle the clip panel, and compare
`getBoundingClientRect()` on `.modal-media` and its `video` at each step — they
must agree on `top` and `height` every time. A screenshot will not show you a
22px overflow, and headless Chrome paints video unreliably anyway.

The clip page's player and its time controls live in one sticky card. Splitting
them looks tidier and is wrong: `⟵ 当前` reads the playhead, so it is useless
when the player has scrolled away. On desktop that card is the sticky left
column and needs `align-self: start` — a stretched grid item is as tall as its
row and can never move inside its own containing block.

The upload holds a Screen Wake Lock so a long transfer isn't killed by an idle
screen timeout. The browser **releases that lock itself whenever the page stops
being visible** and never re-takes it, so the `visibilitychange` re-acquire in
`admin.html` is load-bearing — delete it and one tab switch mid-upload silently
ends the lock. `acquireWakeLock` also guards against a concurrent second
request: two overlapping `request('screen')` calls orphan the first sentinel,
which then keeps the screen awake forever with nothing holding a reference to
release it.

Acquisition is anchored to the click handlers, not to `doMultipartUpload` —
that runs after the check-key round trip, past any transient activation.
**Safari enforces this**: `navigator.wakeLock.request('screen')` fails with
`NotAllowedError` from the console and succeeds from a click handler, on the
same page with Low Power Mode off. The corollary is that the `visibilitychange`
re-acquire can never succeed on Safari, so a document-level capture-phase
`click` listener re-takes the lock on the next gesture whenever an upload is
running without one. Both recovery paths log at `debug`, not `warn` — they are
expected to fail routinely. The
duplicate-name dialog releases the lock while it waits for an answer and the
overwrite button re-takes it on its own gesture; `wakeLockWanted` covers the
case where a release lands while a request is still in flight, which would
otherwise leak a sentinel nothing holds a reference to.

A `beforeunload` handler guards the same window, because the multipart abort
lives in `doMultipartUpload`'s `catch` and never runs if the page is gone. Every
browser ignores a custom message there and shows its own dialog — cancelling the
event is the entire API surface, so don't add wording to it. Firefox needs the
`preventDefault()`, Chrome and Safari need the `returnValue`; both are set on
purpose. iOS Safari frequently shows no dialog at all, and there is no fix —
on mobile the upload usually dies from backgrounding before a tab close is even
the question.

Object keys are user-controlled: build list rows with DOM APIs and
`addEventListener`, never `innerHTML` with `onclick="fn('${key}')"` — HTML
entities (`&#39;`) escape out of that regardless of quote-escaping.

## Known-unfixed, documented on purpose

- `/api/files` and `/api/file/*key` are fully public by design.
- An unknown `kid` forces a JWKS reload (external fetch + KV write) on every
  request, so an unauthenticated caller can amplify subrequests.
- `/admin/api/files` fetches 1000 rows unpaginated.
- Duplicate detection is a `SELECT` followed by an `UPDATE`/`INSERT`, not atomic.
  The `idx_files_path` UNIQUE index is the real backstop; a losing racer sees a
  D1 constraint error rather than a friendly 409.
- An overwrite upload deletes the previous R2 object before inserting the new
  row. If that insert then fails, both the old bytes and the new row are gone.
  Narrow (the object is committed first), noted rather than restructured.
