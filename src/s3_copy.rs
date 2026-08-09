use sha2::{Digest, Sha256};
use worker::*;

/// SHA-256 of the empty string — the payload hash for a body-less PUT (CopyObject).
const EMPTY_PAYLOAD_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// AWS SigV4 leaves the "unreserved" set (`A-Za-z0-9-._~`) un-encoded.
/// `NON_ALPHANUMERIC` encodes those four too, which breaks the signature.
const AWS_UNRESERVED: percent_encoding::AsciiSet = percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// HMAC-SHA256 — manual implementation since we have `sha2` but not `hmac` in WASM.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> Vec<u8> {
    const BLOCK: usize = 64;
    let mut k_pad = [0u8; BLOCK];
    if key.len() > BLOCK {
        let h = Sha256::digest(key);
        k_pad[..32].copy_from_slice(&h);
    } else {
        k_pad[..key.len()].copy_from_slice(key);
    }

    let mut ipad = k_pad;
    let mut opad = k_pad;
    for b in ipad.iter_mut() {
        *b ^= 0x36;
    }
    for b in opad.iter_mut() {
        *b ^= 0x5c;
    }

    let inner_hash = Sha256::new().chain_update(ipad).chain_update(msg).finalize();
    let outer_hash = Sha256::new()
        .chain_update(opad)
        .chain_update(&inner_hash)
        .finalize();
    outer_hash.to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// S3 URL-path-encode an object key.
/// Each segment between `/` is percent-encoded (unreserved chars left alone);
/// `/` itself is preserved as a path separator.
fn s3_uri_encode(key: &str) -> String {
    key.split('/')
        .map(|seg| percent_encoding::utf8_percent_encode(seg, &AWS_UNRESERVED).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// AWS Signature V4 for S3 CopyObject to R2.
///
/// `canonical_uri` must be the exact, already-encoded path of the request
/// (`/{bucket}/{encoded_key}`) and `copy_source` the exact, already-encoded
/// value of the `x-amz-copy-source` header — the signature only matches if the
/// strings signed here are byte-identical to the ones actually sent.
#[allow(clippy::too_many_arguments)]
fn sign_s3_copy(
    access_key: &str,
    secret_key: &str,
    region: &str,
    amz_date: &str,   // YYYYMMDDTHHMMSSZ
    date_stamp: &str, // YYYYMMDD
    canonical_uri: &str,
    copy_source: &str,
    host: &str,
) -> String {
    let method = "PUT";
    let payload_hash = EMPTY_PAYLOAD_SHA256;

    // Canonical headers — must be lowercase and sorted alphabetically
    let canonical_headers = format!(
        "host:{}\nx-amz-content-sha256:{}\nx-amz-copy-source:{}\nx-amz-date:{}\n",
        host, payload_hash, copy_source, amz_date,
    );
    let signed_headers = "host;x-amz-content-sha256;x-amz-copy-source;x-amz-date";

    let canonical_request = format!(
        "{method}\n{uri}\n{qs}\n{ch}\n{sh}\n{ph}",
        method = method,
        uri = canonical_uri,
        qs = "",
        ch = canonical_headers,
        sh = signed_headers,
        ph = payload_hash,
    );

    let algorithm = "AWS4-HMAC-SHA256";
    let credential_scope = format!("{}/{}/{}/aws4_request", date_stamp, region, "s3");
    let cr_hash = hex(&Sha256::digest(canonical_request.as_bytes()));

    let string_to_sign = format!(
        "{alg}\n{date}\n{scope}\n{hash}",
        alg = algorithm,
        date = amz_date,
        scope = credential_scope,
        hash = cr_hash,
    );

    let k_date = hmac_sha256(
        format!("AWS4{}", secret_key).as_bytes(),
        date_stamp.as_bytes(),
    );
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        access_key, credential_scope, signed_headers, signature,
    )
}

/// Read one value out of the Secrets Store.
///
/// `[[secrets_store_secrets]]` bindings are *not* plain string bindings — the
/// binding object exposes an async `get()`. `env.secret()` casts to `String`
/// and therefore fails with "Binding cannot be cast to the type String".
async fn secret_value(ctx: &RouteContext<()>, binding: &str) -> Result<String> {
    let value = ctx
        .env
        .secret_store(binding)
        .map_err(|e| Error::RustError(format!("secrets store binding `{binding}`: {e}")))?
        .get()
        .await
        .map_err(|e| Error::RustError(format!("reading secret `{binding}`: {e}")))?
        .unwrap_or_default();

    if value.is_empty() {
        return Err(Error::RustError(format!(
            "secret `{binding}` is empty — check the secrets store"
        )));
    }
    Ok(value)
}

/// Read a `[vars]` entry, failing with a message that names the missing key.
/// `ctx.var()` on an undeclared binding errors with a generic "is undefined".
fn required_var(ctx: &RouteContext<()>, name: &str) -> Result<String> {
    let value = ctx
        .var(name)
        .map_err(|_| {
            Error::RustError(format!("`{name}` is not set in [vars] in wrangler.toml"))
        })?
        .to_string();
    if value.is_empty() {
        return Err(Error::RustError(format!(
            "`{name}` is empty in [vars] in wrangler.toml"
        )));
    }
    Ok(value)
}

/// Perform a server-side S3 CopyObject within R2.
/// Copies `old_key` to `new_key` without any data passing through the Worker.
pub async fn s3_copy(ctx: &RouteContext<()>, old_key: &str, new_key: &str) -> Result<()> {
    // Read R2 S3-API credentials from the Secrets Store
    let access_key = secret_value(ctx, "CLIENT_ID").await?;
    let secret_key = secret_value(ctx, "CLIENT_SECRET").await?;

    let account_id = required_var(ctx, "CF_ACCOUNT_ID")?;
    // Must match [[r2_buckets]].bucket_name in wrangler.toml
    let bucket = required_var(ctx, "R2_BUCKET_NAME")?;

    let region = "auto";

    // Build amz-date (YYYYMMDDTHHMMSSZ) and date-stamp (YYYYMMDD)
    let now = js_sys::Date::new_0();
    let (amz_date, date_stamp) = {
        let y = now.get_utc_full_year();
        let mo = now.get_utc_month() + 1;
        let d = now.get_utc_date();
        let h = now.get_utc_hours();
        let m = now.get_utc_minutes();
        let s = now.get_utc_seconds();
        (
            format!("{y:04}{mo:02}{d:02}T{h:02}{m:02}{s:02}Z"),
            format!("{y:04}{mo:02}{d:02}"),
        )
    };

    let host = format!("{}.r2.cloudflarestorage.com", account_id);

    // The canonical URI and the copy-source header must be percent-encoded and
    // must be the *same* strings that get signed, otherwise R2 answers 403
    // SignatureDoesNotMatch. Encoding also keeps both values pure ASCII, which
    // matters because header values are ByteStrings — a raw UTF-8 key (e.g. a
    // Chinese filename) would otherwise throw when set.
    let encoded_bucket = s3_uri_encode(&bucket);
    let canonical_uri = format!("/{}/{}", encoded_bucket, s3_uri_encode(new_key));
    let copy_source = format!("/{}/{}", encoded_bucket, s3_uri_encode(old_key));
    let url = format!("https://{}{}", host, canonical_uri);

    let auth_header = sign_s3_copy(
        &access_key,
        &secret_key,
        region,
        &amz_date,
        &date_stamp,
        &canonical_uri,
        &copy_source,
        &host,
    );

    let headers = Headers::new();
    headers.set("x-amz-copy-source", &copy_source)?;
    headers.set("x-amz-date", &amz_date)?;
    headers.set("x-amz-content-sha256", EMPTY_PAYLOAD_SHA256)?;
    headers.set("Authorization", &auth_header)?;

    let mut init = RequestInit::new();
    init.with_headers(headers).with_method(Method::Put);

    let request = Request::new_with_init(&url, &init)?;
    let mut response = Fetch::Request(request).send().await?;

    let status = response.status_code();
    if (200..300).contains(&status) {
        console_log!("S3 CopyObject ok: {} -> {}", old_key, new_key);
        Ok(())
    } else {
        // Log the upstream detail, but don't hand R2's raw response back to the client.
        let body = response.text().await.unwrap_or_default();
        console_error!(
            "S3 CopyObject failed ({}) {} -> {}: {}",
            status,
            old_key,
            new_key,
            body
        );
        Err(Error::RustError(format!(
            "S3 CopyObject failed with status {status}"
        )))
    }
}
