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

`static/admin.html` and `static/app.js` are plain inline JS, no build step.

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
