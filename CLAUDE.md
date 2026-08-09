# CLAUDE.md — file_worker (zcll-worker)

Rust Cloudflare Worker (`worker-rs` 0.8) serving a media gallery from R2 + D1.
`src/lib.rs` routes, `src/auth.rs` Access JWT, `src/db.rs` D1, `src/s3_copy.rs`
R2 S3-API CopyObject, `static/` frontend.

## Build / check

```bash
cargo check --target wasm32-unknown-unknown   # fast loop; always run before claiming done
npx wrangler deploy                            # runs worker-build --release
npx wrangler tail                              # the only way to see runtime errors
```

There are no tests. `cargo check` passing says nothing about runtime behaviour —
most bugs in this project are JS-interop or S3-signature bugs that only appear in
`wrangler tail`.

## Hard-won constraints — do not re-break these

### Secrets Store bindings are not string secrets

`[[secrets_store_secrets]]` bindings (`CLIENT_ID`, `CLIENT_SECRET`) are
Fetcher-shaped objects with an async `get()`. `env.secret(name)` casts to
`String` and returns `Err("Binding cannot be cast to the type String from
Fetcher")` on **every** call. Always use:

```rust
ctx.env.secret_store("BINDING")?.get().await?   // -> Result<Option<String>>
```

`env.secret()` is only for `wrangler secret put` plaintext secrets.
`env.var()` is only for `[vars]`.

### R2 has no server-side copy in the Workers binding

`R2Bucket` (and therefore `worker::Bucket`) exposes only head/get/put/delete/
delete_multiple/list/create_multipart_upload/resume_multipart_upload. There is
**no** `copy`. Renaming requires either:

- `bucket.get(old).bytes()` → `bucket.put(new, bytes)` — buffers the whole file
  in the Worker's 128 MB heap. OOMs on any real video. This is what the code did
  before; do not go back to it.
- S3 `CopyObject` against `<account_id>.r2.cloudflarestorage.com` — server-side,
  zero bytes through the Worker. This is what `src/s3_copy.rs` does.

`ObjectBody::stream()` exists but pumps every byte through WASM (CPU-billed) and
worker-rs 0.8.5 gives no way to hand the raw `ReadableStream` back to
`bucket.put`, so there is no cheap streaming middle ground.

### SigV4 canonicalisation (src/s3_copy.rs)

The signature only matches if the signed strings are byte-identical to what is
sent. Three things that silently produce `403 SignatureDoesNotMatch`:

1. Canonical URI must be the **full request path** `/{bucket}/{encoded_key}` —
   with the leading slash and the bucket, not just the key.
2. Percent-encoding must leave the unreserved set `A-Za-z0-9-._~` alone.
   `percent_encoding::NON_ALPHANUMERIC` encodes `-._~` and is wrong here; use the
   `AWS_UNRESERVED` set defined in the module.
3. `x-amz-copy-source` must be percent-encoded and the canonical-headers block
   must carry the identical value. Build each string once and reuse it.

Region is `auto`, service is `s3`, payload hash is SHA-256("") for a body-less PUT.
`hmac_sha256`'s `key.len() > 64` branch is live — R2 secret keys are 64 hex chars,
so `"AWS4" + secret` is 68 bytes. Don't delete it as dead code.

### Header values are ByteStrings

`Headers::set` with any code point above U+00FF throws. Filenames here are
routinely Chinese, so never interpolate a key/filename into a header raw. Use
`content_disposition()` in `lib.rs` (RFC 5987 `filename*=UTF-8''…` plus an
ASCII-sanitised fallback). Same reason `x-amz-copy-source` is percent-encoded.

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

`Cache-Control` on that route is `public, max-age=3600`, deliberately not
`immutable` + 1 year: `?overwrite=1` and rename both reuse keys. Raise the
max-age if you want more edge caching; do not re-add `immutable`.

### Multi-step mutations need an order

R2 and D1 are not transactional together. Rename is copy → D1 update → delete
old, with a best-effort delete of the new key if D1 fails. Never delete the old
object before D1 points at the new one.

## Frontend

`static/admin.html` and `static/app.js` are plain inline JS, no build step.
Object keys are user-controlled: build list rows with DOM APIs and
`addEventListener`, never `innerHTML` with `onclick="fn('${key}')"` — HTML
entities (`&#39;`) escape out of that regardless of quote-escaping.

## Known-unfixed, documented on purpose

- `/api/files` and `/api/file/*key` are fully public by design.
- An unknown `kid` forces a JWKS reload (external fetch + KV write) on every
  request, so an unauthenticated caller can amplify subrequests.
- `/admin/api/files` fetches 1000 rows unpaginated.
- The rename rollback deletes `new_key` when the D1 update fails. The
  `bucket.head(new_key)` guard makes this safe in the normal case, but a
  concurrent rename landing between that head and our CopyObject can still make
  the rollback delete an object another row legitimately owns. Narrow; noted
  rather than restructured with a lock.
