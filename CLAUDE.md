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

The UI uses **the same word**, qualified: 逻辑目标路径. Not 路径 alone, which
told the admin they were choosing a *location* — R2 has no folders, the key is
minted separately and never changes, and a `/` here only groups the listing.
Not 名称 either, which was tried and is worse: it hides that the `/` is
structural, so the hint had to reintroduce the idea the label had just denied.
逻辑 carries the not-physical distinction that this whole model rests on, and
keeping 路径 means the migrations, the API and the form all say one thing.

标题 was the other candidate and is wrong twice over: the announcement editor
already has a 标题 that is a real title, and `files.path` is hierarchical and
UNIQUE-indexed, which a title is not.

The input keeps its `custom-path` id and `path` stays the wire/table field —
renaming those would be a migration for nothing.

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

### One uploader, five modes

The admin upload section uploads a new file, a **proxy** (a low-quality playback
source), an **attachment** (a downloadable related file — subtitles, a
transcript), a **cover** or **announcement media**; `session.mode` picks the
branch. Only `/start` and `/complete` differ — `/admin/api/upload/part` already
served all of them — so every attach mode gets resume, the queue, the progress
bar, the wake lock and the retry set for free. Proxies used to have a parallel
stripped-down uploader that had none of it, and each mode since would have
grown another one.

The fourth mode also made the target polymorphic — see "The uploader's fourth
mode binds to an id, not a path" below.

**Never test the mode with a bare `=== 'proxy'`.** With two modes that
comparison doubled as "not a plain file upload"; with three it silently
reclassifies attachments as file uploads. Every site goes through
`attachSpec(mode)`, which returns the mode's endpoints/labels or `null` for a
plain file — so a legacy session with no `mode` still resolves to a file upload
without a special case, and the audit is one grep instead of nine.

The spec is also where a mode's UI differences live rather than in a branch:
`badge` names it on its queue row, and `single` is why 封面 is the one mode
whose picker is not `multiple`.

Three things that must stay branched:

- **`uploadLanded()`**, the reconcile oracle for a lost `/complete` response,
  queries the mode's own listing (`spec.listUrl`). An attached upload is never
  in `/admin/api/files`, so asking the file listing would report every
  *successful* proxy/attachment upload as failed — and `complete` is the one
  step that must never be blindly retried, because it has already consumed the
  multipart upload, so two reported failures send the admin to 放弃 over an
  object sitting in the bucket. This is the expensive one to get wrong.
- **`check-key` is skipped in every attach mode.** It tests `files.path` for
  collisions; proxies and attachments are deliberately many-per-`file_path`, so
  it would raise the overwrite prompt over an unrelated file, and overwrite
  means nothing for any of them. It is also why `/start` is the first `await`
  in those modes, which is what makes the cancel-during-start race reachable —
  see the queue section.
- **`filename` is sent at `/attachment/complete` and ignored by
  `/proxy/complete`.** A proxy is only ever played, so its opaque storage key is
  enough; an attachment is downloaded, and `/api/file/{key}?download=1` has no
  way to derive a display name from a key (migration 0002).

`sessionAttachTarget()` / `sessionAttachLabel()` also read the pre-rename
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

### Collections are not a table — they are a path and two row moves

A "collection" (a master encode plus its lower-quality variants and its related
files) already exists in the schema: it is one `files` row plus the
`proxy_videos` and `file_attachments` rows naming its `path`. So grouping is not
a migration, it is **one row moving between two tables**, and three routes cover
the whole lifecycle:

| direction | route | what moves |
|---|---|---|
| file → proxy | `POST /admin/api/files/attach` | `files` row out, `proxy_videos` row in |
| proxy → file | `POST /admin/api/proxy/detach` | `proxy_videos` row out, `files` row in |
| proxy → master | `DELETE …?mode=promote` | `files.key` repointed, proxy row dropped |

All three are **D1-only**. The R2 object keeps the key it was minted with, so a
40 GB file is regrouped in one round trip — and so a key's mint prefix stops
predicting which table owns it (see the promote notes below). That is the same property that makes
rename O(1), for the same reason, and it is why there is no `collections` table:
adding one would rewrite the join key in `CLIP_COLUMNS`, `/api/proxy`,
`/api/attachments`, `repoint_file_path` and four `delete_*_for_path` functions.
Worth doing eventually — `repoint_file_path`'s own comment says the durable fix
is keying on something immutable — but not as the price of a grouping feature.

- **`attach` refuses a source that has anything of its own** (409
  `source_not_empty` with the counts). Its `files` row disappears, so its clips,
  sets and attachments would be orphaned with nothing left to enumerate them —
  the same trap the delete route guards. Migrating them to the target instead
  would be a claim that the two files hold the same content, which only the
  admin can make.
- **Both ends must be `video/` or `audio/`.** A proxy is a playback source; an
  image filed as one would show up in the clip page's source selector.
- **`detach` needs a name.** A proxy carries a label, not a path, so the new
  `files` row takes the key's last segment by default. `idx_files_path` is
  UNIQUE, so the route checks `path_exists` first and 409s rather than letting a
  raw D1 constraint error surface.
- Both are **POST with a JSON body, not path params**: `attach` takes two
  user-controlled paths, and `matchit` allows a catch-all only as the final
  segment, so `/admin/api/files/*source/attach/*target` cannot exist. A bad
  pattern panics *every* route (see the routing section above).
- The attach dialog's ids are `groupinto-*`. The upload section already owns
  `#attach-target` / `#attach-label`, and a duplicate id points the dialog's
  `<label for=>` at the element behind the overlay. Its confirm button keeps
  `.btn-rename-confirm` for the styling that `#btn-overwrite` and `#btn-resume`
  also wear, plus `.btn-groupinto-confirm` as the unambiguous hook.

### Delete asks first, and can promote a proxy instead

`DELETE /admin/api/files/*path` **refuses** a bare call whenever anything is
attached, answering 409 `confirm_required` with the counts and the proxy list.
The admin then re-sends with `?mode=promote&promote_key=…` or `?mode=purge`.
Refusing is the safe default: a caller that predates this — or a stray `curl` —
cannot destroy 40 clips it never knew existed. A file with nothing attached
still deletes on the first call, so the dialog only appears when there is
something to lose.

`mode=promote` is the interesting one, and it is **not a delete**: it drops the
original's R2 object and repoints the `files` row at a proxy's object, so the
file survives at the same path, smaller. Everything attached joins on
`files.path`, which does not move, and a proxy shares the original's timeline —
so no clip, set or attachment needs repointing and every time range still means
what it meant. That is the whole trick: it frees 40 GB and keeps the work built
on top of it.

Promotion does **not** break key immutability. No key's bytes change; what moves
is the row → key mapping. Links to the *deleted* original's key break, but that
is inherent to deleting it and equally true of a purge. `files.key` then holds a
`proxies/…` key — verified safe, because nothing filters on that prefix:
`proxy_exists`/`attachment_exists` guard by table membership, and the one R2
lifecycle rule (abort incomplete multipart uploads) never touches committed
objects. Keep it that way; see the prefix note below.

Details that are load-bearing:

- **`count_attached` has no `is_public` filter.** `list_clips` bakes
  `is_public = 1` into all four of its WHERE branches, so reusing it would tell
  the admin "3 个切片" while purging 40. A confirmation that understates
  irreversible loss is worse than no confirmation. Its number is the same
  population `delete_clips_for_path` returns afterwards — comparing them is the
  cheap check that they have not drifted.
- **`promote_key` is validated against *this path's* proxies**, never
  `proxy_exists`, which is a global "is this a proxy anywhere". With the global
  check, `?promote_key=<another file's proxy>` repoints this row at a foreign
  object and hands the next delete of this row that file's playback source to
  destroy. Same bug class as the guard on `DELETE /admin/api/proxy?key=`, one
  level up.
- **The suggestion is the biggest proxy that still has a picture**
  (`max_by_key` on `(!audio, size)`). Biggest because it replaces the original
  and becomes the export source — the clip page still defaults its *preview* to
  the smallest. Picture first because promoting an audio-only proxy moves the
  file into the gallery's 音频 filter and leaves clips with no frame to cut
  against; it stays eligible as a last resort, and the dialog says so, since no
  source at all is worse.
- **`files.key` is `UNIQUE` (migration 0001)** and the promoted key survives
  that, because a key lives in exactly one of the two tables — the batch is what
  maintains it, so no `files` row can already hold what `proxy_videos` holds.
  Promoting the same proxy twice fails the ownership check instead.

  Do **not** reach for the mint prefixes to argue this. `attach` files an
  `uploads/…` key into `proxy_videos` and `promote` files a `proxies/…` key into
  `files`, so after either one the prefix no longer says which table a key is
  in — it only records which uploader minted it. Anything that treats `proxies/`
  as "is a proxy" (a prefix-scoped lifecycle rule, an admin listing, a cleanup
  script) is wrong the moment a collection is rearranged. Ask the table.
- **The two D1 writes go through `batch`**, which D1 runs as a transaction.
  If they are ever unwound into two calls, `UPDATE files` must land first:
  deleting the proxy row first and then failing leaves an R2 object no table
  names — unenumerable, a permanent leak. The reverse failure leaves one key in
  two tables, which is visible and repairable.
- **`admin.js` keeps its `confirm()` first**, before the request. The impact is
  only known from the server's refusal, which arrives *after* the call — so
  discovering the impact can never be what gates the first destructive call.

Deleting a file is the one route that fans out. Four tables key on `files.path`
— `proxy_videos`, `file_attachments`, `clips`, `clip_sets` — and two of them own
R2 objects, so `DELETE /admin/api/files/*path` deletes the source object, then
every proxy object, then every attachment object, then the rows, and the `files`
row **last**. That order is the retry anchor: while the `files` row exists the
whole route can be replayed, and every step in it is idempotent.

Which is why a failed proxy/attachment object delete must **not** drop its row.
The row is the only surviving name for that key — nothing else enumerates these
objects once `files` is gone, which is the entire reason they are deleted here —
so `let _ = bucket.delete(k)` followed by an unconditional row delete strands the
object in the bucket forever, the exact outcome the block exists to prevent. The
route collects failures and returns 502 with the `files` row intact instead.

A bailed run is **not** a no-op — the source object and any table that did clean
up successfully are already gone. The surviving `files` row is a retry handle,
not a live file, so the listing after a 502 shows something that no longer plays.
Retry finishes the job; that is the tradeoff, and it beats a silent leak.

It bails **before** `delete_clips_for_path`, not after. Clips own no R2 object,
so deleting them is pure irreversible loss; doing it on a run that is about to be
retried destroys the clips while the file is still listed as present.

`/proxy/complete` and `/attachment/complete` re-check `get_by_path` before
completing the multipart upload, because an upload runs for minutes and the
delete route runs once — its cleanup already enumerated both tables, so a row
inserted afterwards names an object nothing will ever list again. They abort the
upload and 409, which leaves no object at all and so owes no cleanup. This is the
same class of stale-decision bug as `/upload/complete`'s duplicate re-check.

That 409 shares a status with the duplicate-name refusal, so `admin.js` branches
on the body's `error` field. Both verdicts are deliberately **fatal**: the server
has already aborted, so `uploadLanded()` is never consulted and no Resume banner
appears — resuming an aborted multipart upload loops forever. A non-409 status
here would be worse than the collision: `!ok` alone is non-fatal and lands in
exactly that loop.

### Announcements: the one feature that names no file

Migration 0006 adds `announcements` and `announcement_media`. They are the only
tables here that do not join `files.path`, which is why they are absent from
`repoint_file_path` and from all four `delete_*_for_path` functions — by
design, not by omission. An announcement is site-wide: it survives every
rename and every file delete.

Two flags, and they are different kinds of flag:

- **`is_published` is the only visibility gate.** Same role `clips.is_public`
  plays. Nothing else may decide whether the feed returns a row; two visibility
  flags eventually disagree and then nobody can say why a notice is missing.
- **`pinned` is ordering only**, exactly as `clips.set_id` is grouping only.
  Any number of rows may carry it — the feed is one flat
  `ORDER BY pinned DESC, created_at DESC`, so pinning re-sorts and never
  filters, and "only one pin" is a rule that would have to be enforced
  somewhere and would then have to be un-enforced on the next request.

`set_announcement_flags` deliberately does **not** touch `updated_at`: that
column is the *text's* timestamp and the feed shows it, so pinning a month-old
notice must not make it look rewritten. It is also why editing and toggling are
two writers rather than one whole-record update — the editor owns title/body,
the list rows own the flags, and a pin click in a list loaded ten minutes ago
would otherwise write that stale text back over an edit made since.

**Media is one table for both kinds**, unlike the deliberate `proxy_videos` /
`file_attachments` split. That split exists because the two are read by
different hot routes and merging them would put a `WHERE kind =` on
`/api/proxy`. Here both are read by the *same* query on the *same* route, so a
`kind` column would be a filter nobody runs plus a second thing to keep in sync
with `content_type`. The renderer decides: `image/`, `video/` and `audio/` go
inline, everything else becomes a download.

- **There is no announcement serve route**, for the same reason attachments
  have none: `/api/file/*key` does no D1 read and already re-clamps any
  non-media stored type to `application/octet-stream`, so
  `/api/file/{key}?download=1&name={filename}` serves a PDF safely today.
- `sanitize_announcement_content_type()` is the **union** of the two existing
  clamps — an announcement carries both an image and a PDF, so neither fits
  alone. Like `sanitize_attachment_content_type` it is D1/R2 metadata only, and
  the serve path must keep ignoring it.
- The feed therefore renders media as `<img>` / `<video>` / `<audio>` / `<a
  download>` and **never `<iframe>` or `<object>`**. Those two execute their
  content, which is what would reopen the stored-XSS hole on `/admin`'s origin.
- The feed's two statements — the listing and the media — take the **same
  LIMIT/OFFSET**, so the media query describes exactly the page that was
  returned. One query per row instead would put an N-way fan-out on the
  gallery's first paint.

**Create is its own step, before any upload.** Media hangs off an
`announcements.id`, so the row has to exist first; `is_published` defaults to
false so the sequence is write → attach → publish, and an unfinished notice is
never on the homepage. `POST /admin/api/announcements` refuses only when title
*and* body are both empty — "has media" cannot be a requirement at create time.

Deleting fans out like the file delete and for the same reasons: R2 objects
first, media rows next, the announcement row **last**, because while that row
survives the whole route can be replayed and every step is idempotent. A failed
object delete must **not** drop its row — the row is the only surviving name
for that key, and nothing else enumerates these objects. Failures are collected
and answered 502 with everything still listed.

`/announcement/complete` re-checks that the announcement still exists, aborts
the multipart upload and 409s if it does not. Same stale-decision class as
`/proxy/complete` and `/attachment/complete`, and the same 409 contract: fatal,
so the client never consults `uploadLanded()` and no Resume banner appears over
an already-aborted upload.

### The uploader's fourth mode binds to an id, not a path

`ATTACH_SPECS.announcement` is the fourth mode of the one uploader (see "One
uploader, three modes" above — it is now four, and the `attachSpec()` rule is
what made adding one cheap). It gets resume, the progress bar, the wake lock
and the retry set for free.

What is new is that **an attach target is no longer always a file path**.
Proxies and attachments hang off `files.path`; announcement media hangs off an
`announcements.id`. So every request that carries the target names it through
`spec.targetParam` — `/start`, `/complete`, and the listing behind
`uploadLanded()`. A hardcoded `?file_path=` anywhere in that path is a bug that
appears only in the announcement mode, and only as a reconcile failure: the
listing 400s, `uploadLanded()` returns null, and two of those send the admin to
Discard over an object that is sitting in the bucket. That is the expensive one
to get wrong, exactly as it was when the third mode landed.

The session still stores the target under `attachFilePath` and reads it back
through `sessionAttachTarget()`. Keeping the old field name is what lets an
upload that was in flight when this version shipped still resume — same reason
the accessor also reads the pre-rename `proxyFilePath`.

The shared target `<select>` is repopulated by `applyUploadMode()` on **every**
mode change, because the two populations come from different lists (files vs
announcements). Without that, switching to 公告附件 leaves a file path selected
and the first upload posts it as an `announcement_id`. `admin.js` also loads
the announcement list once at startup for that dropdown — it is the one attach
target that is not in the file listing.

### The gallery's notice feed is a button and a modal

The feed is **not** on the page. A single `📢 公告 (N)` button rides **inside the
filter row** (`.filter-row` wraps `.filter-bar` and the launcher), and the
announcements themselves live in `#notice-modal`. The inline version — even
capped at three cards with a reveal for the rest — still pushed the gallery grid
off the first screen, which is the opposite of what the gallery is for, and a
launcher on a line of its own cost a full band of vertical space above the fold
for one pill. It now costs nothing whether there are two announcements or forty.

The launcher stays outside the `<nav>` — it is not a filter — and only shares
the row. Below ~560px the four filter pills already wrap to two lines on their
own, because finger-sized targets are gated on `(pointer: coarse)`, so a fifth
control cannot share the line there. That is wrapping, not waste: the space
between the lines is the row's own `gap`. What must stay true is that there is
never an *empty* band, which is exactly what an outer margin on `.notice-launcher`
reintroduces — that margin is what the screenshot of the wasted strip showed.

This replaced a collapse-with-persisted-state design. Do not bring that back:
the button *is* the collapsed state, and it needs no `localStorage` key, no
restore-on-load path and no third "hidden because empty" state to disambiguate.
The launcher is simply `hidden` when the feed is empty, and the page is then
exactly what it was before announcements existed.

- **The count on the button is the point.** "公告" alone says nothing about
  whether anything changed; the number is the only signal a viewer gets without
  opening it.
- **Cards are built once, at load, into the hidden dialog.** Images inside carry
  `loading="lazy"`, so a viewer who never opens the modal never fetches a single
  announcement image — which only became true once the feed stopped rendering
  inline.
- **Three ways out** — close button, backdrop, Escape — and the Escape handler
  is ordered: the preview modal opens over the notice modal, so it closes first.
  One Escape, one layer.
- **The scroll lock is released only if the preview modal is not also open.**
  Both write `document.body.style.overflow`, and closing the top one blindly
  would let the page scroll behind the one still open.
- Focus moves to the close button on open and back to the launcher on close.
  Without the return, a keyboard user is dropped at the top of the document.
- The dialog is capped in `dvh` and the list scrolls inside it (`max-height:
  min(70dvh, 40rem)`), for the reason documented under "Responsive bands": iOS
  Safari's `vh` is the address-bar-collapsed height, so a `vh`-capped dialog
  overflows while the bar is showing.

The body still renders `white-space: pre-wrap` through `textContent` — the admin
types into a textarea, so their line breaks are the formatting, and this is the
same origin as `/admin`, so no Markdown and no linkification. `overflow-wrap:
anywhere` is still load-bearing: a pasted URL is one unbreakable token, and it
now sets the *dialog's* min-content rather than the page's.

Dates are **not** parsed with `Date`. D1 writes `datetime('now')`, i.e.
`YYYY-MM-DD HH:MM:SS` with no zone marker: Safari refuses it and Chrome reads it
as *local* time, so a shared timestamp would be wrong by the viewer's offset.
`formatNoticeDate` takes the date part as text, which is the only field a notice
actually needs.

The admin page keeps its per-section collapse (`.admin-section`), applied from
JS rather than written into the markup eight times, so a ninth section gets it
for free. Two rules there:

- **Nothing ever collapses itself.** The stored set only ever grows from a click.
- **An upload force-opens `#sec-upload`** (`expandUploadSection()`, called from
  `runUpload`). A section collapsed in a previous visit is restored collapsed at
  load, so without this the progress bar, the wake-lock hint and the resume
  banner spend the whole transfer behind a shut header.

The collapse hides `> *:not(h2)` rather than a wrapper element, because wrapping
would move `#attach-target` and `#attach-label`, which `admin.js` binds at
module scope.

### Covers live on the `files` row and may be borrowed

Migration 0008 adds `files.cover_key`. A column, not a table: it is exactly one
image per file, and a `file_covers` table would add a fifth thing keyed on
`files.path` — a fifth entry in `repoint_file_path`, a fifth
`delete_*_for_path` — to store one nullable value. Living on the row also means
**rename cannot detach it**, which is the failure mode every other attached
thing has to be defended against.

The key may point at either kind of object, and this is the part to get right:

- an object minted by `/admin/api/cover/complete` under `covers/…`, which
  nothing else names, or
- **one of the file's own attachments**, when the admin picks an image they had
  already uploaded. Nothing is copied — R2 has no cheap copy, and an image
  already in the bucket does not need a second copy of its bytes to be pointed
  at.

So a cover object is **never deleted unconditionally**. `release_cover_object()`
asks `attachment_exists`, `proxy_exists` and `cover_ref_count` — three
membership questions — and only then deletes. Never test the `covers/` prefix:
it records which uploader minted the object, not who needs it now, exactly as
`promote` established for `proxies/`.

Three more rules:

- **`POST /admin/api/files/cover` validates the key against *this path's*
  attachments**, never `attachment_exists`, which is a global "is this an
  attachment anywhere". With the global check a cover could point at another
  file's object, and deleting that file would silently blank this card — the
  same bug class as `promote_key`, one level over.
- **`/cover/start` refuses a non-image before the bytes move**, using
  `sanitize_content_type`, which has already dropped `image/svg+xml` — the one
  image type that can carry script on `/admin`'s origin.
- **In the delete fan-out the cover goes after the attachment rows are gone**,
  and this row's own reference is cleared first. Otherwise the reference count
  it checks still includes the file being deleted, and a cover that *is* one of
  its attachments would never be released. A failed release counts as stranded,
  like every other object in that route.

The gallery draws the cover for video and audio (an image is already its own
thumbnail) with a `.card-kind` badge, so a card with a poster still reads as
playable, and an `onerror` fallback to the emoji — a picked attachment that was
not really an image must not leave a blank card. The preview `<video>` also
takes it as `poster`, which is what stands there when a HEVC file cannot decode.

An attachment is stored `application/octet-stream` whatever it is, so the
*stored* type cannot tell the picker which attachments are images: it filters on
the filename extension. A wrong guess costs nothing — the preview fails to load
and the admin picks another. Verified in a browser that `<img>` renders an
octet-stream response despite `nosniff`; that header blocks scripts and
stylesheets with the wrong type, not images.

### Metrics are counters, and they are a beacon, not a side effect of serving

Migration 0007 adds `file_metrics(file_path, day, plays, downloads)`, one row
per file per UTC day, written by an upsert.

**Counting does not happen in `/api/file/*key`**, and both reasons are
independent:

- That route is the Range path — dozens of requests per video playback,
  deliberately with no D1 read at all. A write there would put a database round
  trip on every seek.
- It is served `public, max-age=31536000, immutable`. `?download=1` is its own
  cache key, so a download the browser or the edge answers from cache never
  reaches the Worker to be counted. Server-side counting would silently
  undercount exactly the popular files.

So `POST /api/metrics` is a fire-and-forget beacon from the page. Three things
about it:

- **The body is read with `req.text()` + `serde_json::from_str`, never
  `req.json()`.** `navigator.sendBeacon` cannot set a Content-Type, and a
  handler that insists on `application/json` drops every beacon sent that way.
  The client uses `fetch(..., {keepalive: true})` — same delivery guarantee,
  and it can set the header — but the route must not depend on that.
- **Unknown events and unknown paths answer `{"ok": false}`, not 4xx.** Nothing
  reads the response; an error status would only produce console noise on a
  page where counting is not the point.
- **`record_metric`'s `WHERE EXISTS` is the only thing keeping the table
  clean.** A public endpoint that inserted whatever path it was handed would let
  anyone mint unbounded rows.

**One play per opened file**, counted where the file is opened (`openPreview`,
and `init` on the clip page) rather than from a `play` listener on the element.
`selectSource`/`switchSource` reuse the media element for video→video and
replace it for video↔audio, so an element-bound listener either fires again on
a quality switch (double count) or stops firing entirely (miss) — the same
staleness trap `onSourceError` documents, with the same two causes.

**"Download" means the file itself** — the gallery's 💾 and the clip page's
full-file download, counted against `files.path` even when the bytes come from
a proxy, because downloading the 360p is still downloading this video.
Attachments and the clip exporter deliberately do not count; folding four
different acts into one number makes it unreadable. The dashboard says so on
screen, which is the only reason the number means anything.

Metrics key on `file_path`, so they are in `repoint_file_path` — a rename that
left them behind would reset a video's history to zero *and* leave orphan rows
counting toward nothing. In the delete fan-out they sit on the **same side of
the bail as the clips**: they own no R2 object, so dropping them is pure
irreversible loss and must not happen on a run that is about to be retried.

They are deliberately **not** in `count_attached`. That number is the "this is
what you are about to destroy" confirmation and it lists user content; a view
counter is not something the admin is being asked to weigh.

Days are UTC buckets (`date('now')`), because that is the only clock D1 has,
and the dashboard labels them as UTC rather than pretending otherwise.

### The admin dashboard

`GET /admin/api/dashboard?days=` returns the tiles, the daily series and the
busiest files in one response — three queries the admin always wants together,
where three round trips would be three spinners. `days` is clamped 1–365.

The chart is CSS, not a charting library: this project has no build step and
ships no external requests, and two series over at most 90 buckets is a flexbox.
It scrolls inside its own `overflow-x: auto` box — 90 columns has a min-content
far past a phone, and the page must not scroll sideways.

Both series share one scale (the tallest single bar). Scaling them
independently would draw downloads as tall as plays at a tenth the count, which
is the one thing a two-series chart must not do.

Three rules keep the geometry honest, and the first two exist because breaking
them produced a bug that read as a browser glitch:

- **The client fills every day in the window**, present in the response or not.
  The server only returns days that have rows, so a fresh install returned
  *one* — and one `flex: 1` column fills the whole panel, drawing its two bars
  as a ~500px half-pink half-blue slab. It was reported as a Safari rendering
  bug at ~1000px; it was the chart faithfully rendering one very wide day.
  Filling the range also makes the x-axis mean something: a gap is a quiet day,
  not a missing column.
- **Columns are capped (`max-width: 44px`) and the row is `justify-content:
  flex-start`.** Without both, any short series stretches into slabs again the
  moment the panel is wide.
- **No percentage height resolves against a flex-sized box.** `.chart-bars`
  carries a fixed `height: 120px` so the per-bar `height: N%` set from JS
  resolves identically everywhere — the same trap documented for `.modal-media`,
  and the one Safari is strictest about. Do not "simplify" it back to
  `height: 100%` on the column.

Labels thin to about a dozen across the window; the tooltip still names every
day exactly, and says UTC.

`overview()` uses scalar subqueries rather than joins for the same reason
`count_attached` does: they count unrelated things, and a join would multiply
them together. `total_size` comes back REAL — the sum of a 40 GB archive
overflows an i32 long before the row count does.

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
files too. Post-failure diagnosis is the correct use of `canPlayType`; pre-flight
gating is not.

The codec table, the probe and the panel body live in `static/codecs.js`, because
there are **two** players and they must answer identically. Each page attaches its
own `error` listener and appends its own actions:

- Gallery (`app.js`, in `openPreview`) replaces the whole `<video>` with the
  notice — the modal is torn down on close, so nothing else refers to it.
- Clip page (`clip.js`, in `switchSource` → `onSourceError`) **hides** the media
  element instead of removing it. `⟵ 当前`, `▶ 预览` and `switchSource` itself all
  dereference `el.video`; removing it turns an undecodable source into a page
  full of `TypeError`s. It also adds a 换用 button when another source exists —
  an AV1 original this device can't decode usually sits beside a proxy it can.

Three things in the clip page's version that look incidental:

- The listener is attached **inside `switchSource`, on every switch**, not once at
  load. An audio↔video switch replaces the element, so a listener bound to the
  page's initial `<video>` silently stops firing after the first swap. It is
  `onerror =` rather than `addEventListener`, because a video→video switch keeps
  the same element and would otherwise stack one live handler per switch.
- `onSourceError` bails on a stale event, and needs **two** checks to do it,
  because there are two ways to go stale. A video↔audio switch *replaces* the
  element, so the abandoned node's handler still closes over the old `opt` —
  `activeProxy` catches that. A video→video switch *reuses* the element and
  rearms `onerror` with the new `opt`, so that check passes and only the src the
  handler was armed for (`vid.src !== wantSrc`) tells them apart. Either one
  alone lets a failing source paint its notice over one that is playing fine,
  which reads as the feature being broken.
- `⟵ 当前` and `▶ 预览` refuse while the notice is up (`playerUnavailable()`).
  There is no decoder behind that box, so the first would write a confident
  `0:00.0` off a media element that never loaded and the second would `play()` a
  `display: none` element — both silently, both looking like the control is
  broken rather than the source.
- `.preview-area` gets `has-notice` (→ `flex-shrink: 0`) while the notice is up.
  Under 1024px `.stage-card` is a `62dvh`-capped scrolling flex column, so its
  children shrink to fit and `.preview-area`'s `overflow: hidden` clips the
  bottom of the notice — measured at 390px it ate 14px, and on a shorter phone
  that is the button row, i.e. the only way out of the state.

The AV1 row probes `av01.0.05M.10` (10-bit), matching the `-pix_fmt yuv420p10le`
encode the archive uses. A software decoder answers the same for both depths, so
it is behaviour-neutral on Chrome and Firefox — it is not a bit-depth detector,
it just probes what is actually served.

Deliberately not implemented: parsing the MP4 `stsd` box (via a Range fetch) to
name the file's actual codec. It ends at the same download button, and needs a
moov-at-tail fallback for files without `+faststart`.

### Resumable uploads live in the client, because they have to

worker-rs 0.8.5's `MultipartUpload` is `upload_part` / `abort` / `complete` and
nothing else — **there is no `list_parts`**. The server therefore cannot tell a
returning client which parts already landed, so the part etags are persisted in
`localStorage` under `zcll.upload.session.<upload_id>` and replayed at
`/upload/complete`. Do not "move this to the server"; there is no API to move
it to.

**One storage key per session**, plus `zcll.upload.sessions` holding the ids —
deliberately not one map under one key. A map is a read-modify-write, and with
several tasks each writing after every part, one `await` between the read and
the write silently reverts a sibling's part list. Separate keys also stop a
5000-part session being re-serialised every time some *other* upload lands a
part. `zcll.upload.session` (no suffix) is what the single-session version
wrote; `migrateLegacySession()` adopts it once, on load, so an upload that was
in flight when the queue shipped is still resumable.

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

### An upload is a task in a queue, not a mode of the page

Picking files and clicking 上传 hands them to a queue and gives the form
straight back, so several uploads — in different modes, against different
targets — run at once and each is paused, resumed or cancelled on its own. The
picker is `multiple` in every mode but 封面 (one cover per file, so N uploads
would leave only the last).

The state machine is the design. `ACTIVE_STATES` is exactly the set that holds
a concurrency slot, and everything else follows from it:

- **`awaiting-overwrite` is not active.** The duplicate prompt moved from a
  page-wide banner into the row that raised it, precisely so a task waiting on
  a decision cannot stall the rest of the queue — and so two collisions can be
  answered independently rather than one dialog being overwritten by the next.
- **`pausing` *is* active**, because the task is still unwinding an in-flight
  part. Freeing the slot at the click would briefly run one more upload than
  the limit allows.
- `uploadInProgress` — which owns the wake lock's lifetime and the
  `beforeunload` guard — is **derived** from that set by `syncActivity()` and
  assigned nowhere else. As a flag one upload owned, task 1 finishing dropped
  the lock while 2–4 were still transferring.

**Concurrency defaults to 2 and is capped at 4, and the ceiling is not
arbitrary.** 8 MB parts were chosen against the *whole* upstream, because
Cloudflare's edge drops a body that arrives too slowly (the 408 in
`isRetryable`). N parallel parts divide that upstream by N, so each part sits
in the timing envelope a part N times its size would have: at 4, an 8 MB part
is as exposed as the 32 MB one that made 408s routine. Raising it trades a slow
link's reliability for fewer requests.

Three things that look incidental and are not:

- **`openUpload` must not abort any other session.** The single-session version
  evicted whatever was stored when a new upload started, and aborted it so its
  parts were not stranded. That same line in a queue aborts a *sibling task's*
  multipart upload on every enqueue, and the sibling then fails at `/complete`
  having transferred everything. Sessions are independent now; each is cleaned
  up by its own task.
- **Pause and cancel are delivered by `xhr.abort()`, which is indistinguishable
  from a dropped connection** — both report status 0, which `isRetryable` says
  to retry. So `throwIfInterrupted()` runs as the *first* statement in the
  retry catch, before the retry test, and throws a control error that bypasses
  both the retry budget and the resumable/fatal branch.
- **A cancel that lands while `/start` is in flight has nothing to abort yet.**
  `runTask` therefore re-checks `cancelRequested` after `openUpload` returns
  and aborts what it just opened. Without that the upload sits in R2 with no
  row, no task and nothing that knows its `upload_id` — a leak only the
  lifecycle rule ever collects. The attach modes are where this actually
  bites: they skip check-key, so `/start` is the first `await` and a cancel
  in the same tick as the click lands squarely inside it.

Pause is offered only from `queued` and `uploading` (`canPause`). The states in
between are short round trips with nothing to interrupt, and honouring a pause
in `checking` would leave `pauseRequested` set on a task that then asks about
an overwrite — which would throw the moment the admin answered.

A session restored from `localStorage` has no `File` (a handle cannot survive a
reload), so it lands as a `needs-file` row with **its own picker**. Not the
form's: that input is the enqueue path now, and one file can match two
abandoned attempts at the same upload, so "which task did you mean" has to be
answered by which row was clicked rather than inferred.

**A row names its destination, not just its source** (`taskTarget`). The two
are routinely different — a plain upload is listed under a minted
`uploads/{day}/…` display name, and an attached upload never becomes a file at
all — so a queue showing only the names off the admin's disk cannot answer
"which of these is the proxy for the concert video". Every row reads 目标 —
they all answer *where is this going* — and the noun after it says which kind:
`逻辑目标路径` for a plain upload, `目标文件` for a proxy/related file/cover,
`目标公告` for announcement media. A bare 目标 on all of them would be one word
meaning two things a line apart. Three things follow:

- A file upload's path is **exact only once `/start` has answered**. Before
  that it is derivable only when the admin typed one; an empty custom path is
  minted server-side, and guessing it here would print a name the row never
  gets. So it says 自动生成 until `session.path` exists, and
  `renderTask` re-reads it every time rather than caching it.
- The announcement mode resolves its id to the notice's own title through
  `noticeData`, which is empty on first paint — hence `refreshTaskTargets()`
  when the announcement list lands. It branches on `spec.targetParam`, not on
  the mode name, for the reason in the modes section above.
- **Adopting stored sessions is the last thing this file does.** It builds
  rows, a row reads `noticeData`, and `noticeData` is declared far below the
  queue code — adopting where the queue is defined reads it inside its
  temporal dead zone and throws before the page has drawn anything.

`spec.labelless` is why 封面 shows no label beside its target: a cover is one
image per file and its label field is inert, so printing the placeholder would
be worse than printing nothing.

## Frontend

Plain HTML/CSS/JS, no build step. Each page is three files:

| page | logic | styles |
|---|---|---|
| `index.html` (gallery + clip rank) | `app.js` | `style.css` |
| `clip.html` | `clip.js` | `style.css` + `clip.css` |
| `admin.html` | `admin.js` | `style.css` + `admin.css` |

Plus two shared scripts, `mp4clip.js` and `codecs.js`, loaded by both
`index.html` and `clip.html` — **before** their own script in both, since they
call into them at click time and at media-error time. Both namespace themselves
(`window.MP4Clip`, `window.VideoCodecs`) rather than declaring top-level names:
classic scripts share one global lexical scope, so a bare `const` here would be
a `SyntaxError` the moment a page script picked the same name, and that takes
the whole page down, not just the collision.

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
- `POST /api/metrics` is public and unauthenticated, so anyone can inflate a
  real file's play or download count by replaying it. The `WHERE EXISTS` guard
  only stops rows being minted for paths that name no file. Unfixed on purpose:
  the number steers an admin's attention, nothing else reads it, and every
  cheap defence (an identity cookie, a per-IP cap) is either trivially
  sidestepped or costs a D1 read on a path whose whole point is to be free.
  If it ever matters, the fix is a rate limit at the edge, not in this Worker.
- An overwrite upload leaves the old file's proxies, attachments, clips and clip
  sets attached to the path, now pointing at different bytes. Nothing is
  orphaned — everything is silently *mis*-attached: the old proxy is offered as
  a playback source for the new video, and a shared clip's time range indexes
  content nobody chose. Unfixed because both answers are defensible: an admin
  re-uploading a corrected encode of the same video wants the clips kept, and
  purging them is destructive and surprising in that case. Deciding needs a
  product call, not a code change.
