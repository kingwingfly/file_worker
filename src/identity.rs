use base64::Engine;
use sha2::{Digest, Sha256};
use worker::*;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// The claims inside an identity cookie.
///
/// `id` is a random identifier generated once per identity and never changes.
/// `nickname` is chosen by the user and shown alongside their public clips.
/// `iat` is seconds since epoch — not used for expiry currently, but staged
/// so we can add it later without migrating data.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct IdentityPayload {
    pub id: String,
    pub nickname: String,
    pub iat: u64,
}

/// HMAC-SHA256 (RFC 2104) implemented directly so we don't need an `hmac` crate
/// whose `digest` version inevitably conflicts with `sha2`'s.
fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    const BLOCK: usize = 64; // SHA-256 block size
    let mut k = [0u8; BLOCK];

    let key_eff = if key.len() > BLOCK {
        let d = Sha256::digest(key);
        k[..d.len()].copy_from_slice(&d);
        &k[..d.len()]
    } else {
        key
    };

    // zero-fill then XOR
    let mut k_ipad = [0x36u8; BLOCK];
    let mut k_opad = [0x5Cu8; BLOCK];
    for (i, &b) in key_eff.iter().enumerate() {
        k_ipad[i] ^= b;
        k_opad[i] ^= b;
    }

    let inner = Sha256::digest(&[&k_ipad[..], data].concat());
    Sha256::digest(&[&k_opad[..], &inner[..]].concat()).to_vec()
}

/// Sign an identity payload into a cookie-ready token.
///
/// The token is `base64url(JSON).base64url(HMAC-SHA256(secret, base64url(JSON)))`.
/// A missing or empty secret produces `None` rather than panicking.
pub fn sign_identity(id: &str, nickname: &str, secret: &[u8]) -> Option<String> {
    if secret.is_empty() {
        return None;
    }
    let payload = serde_json::json!({
        "id": id,
        "nickname": nickname,
        "iat": now_secs(),
    });
    let payload_str = serde_json::to_string(&payload).ok()?;
    let encoded = B64.encode(payload_str.as_bytes());

    let sig = B64.encode(&hmac_sha256(secret, encoded.as_bytes()));

    Some(format!("{}.{}", encoded, sig))
}

/// Verify an identity token and return the payload.
///
/// Returns `None` for any invalid token (bad format, bad signature, bad JSON).
/// Does **not** check expiry — there is none currently.
pub fn verify_identity(token: &str, secret: &[u8]) -> Option<IdentityPayload> {
    if secret.is_empty() {
        return None;
    }
    let (encoded, sig) = token.split_once('.')?;

    // Constant-time compare: `==` on &[u8] short-circuits on the first differing
    // byte, which leaks how much of a forged signature was correct.
    let expected_sig = B64.encode(&hmac_sha256(secret, encoded.as_bytes()));
    if !ct_eq(expected_sig.as_bytes(), sig.as_bytes()) {
        return None;
    }

    let payload_bytes = B64.decode(encoded).ok()?;
    serde_json::from_slice::<IdentityPayload>(&payload_bytes).ok()
}

/// Length-independent byte comparison with no early exit.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn now_secs() -> u64 {
    Date::now().as_millis() / 1000
}

/// Pull the `identity=` value out of a Cookie header.
pub fn extract_identity_cookie(cookie_header: &str) -> Option<&str> {
    let prefix = "identity=";
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        if trimmed.starts_with(prefix) {
            return Some(trimmed[prefix.len()..].trim());
        }
    }
    None
}
