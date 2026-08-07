use base64::Engine;
use rsa::{pkcs1v15::Pkcs1v15Sign, BoxedUint, RsaPublicKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use worker::*;

// ── base64url engine (no padding) ──
const B64: base64::engine::GeneralPurpose =
    base64::engine::general_purpose::URL_SAFE_NO_PAD;

// ── KV cache config ──
const JWKS_BINDING: &str = "JWKS_CACHE";
const JWKS_KEY: &str = "jwks";
const JWKS_TTL: u64 = 3600; // 1 hour

// ── Types ──
#[derive(Debug, Deserialize)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
}

#[derive(Debug, Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Debug, Deserialize)]
struct JwtHeader {
    kid: String,
    alg: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct AccessClaims {
    #[serde(default)]
    pub aud: serde_json::Value,
    pub iss: String,
    pub exp: u64,
    pub nbf: Option<u64>,
    pub email: Option<String>,
    pub sub: Option<String>,
}

// ── Helpers ──

fn now_secs() -> u64 {
    Date::now().as_millis() / 1000
}

fn b64url(s: &str) -> Option<Vec<u8>> {
    B64.decode(s).ok()
}

// ── JWKS loading with KV cache ──

async fn load_jwks(env: &Env, team_domain: &str, force: bool) -> Option<Jwks> {
    let kv = env.kv(JWKS_BINDING).ok()?;

    if !force {
        if let Ok(Some(text)) = kv.get(JWKS_KEY).text().await {
            if let Ok(j) = serde_json::from_str::<Jwks>(&text) {
                return Some(j);
            }
        }
    }

    let url = format!("https://{team_domain}/cdn-cgi/access/certs");
    let mut resp = Fetch::Url(url.parse().ok()?).send().await.ok()?;
    let text = resp.text().await.ok()?;
    let jwks: Jwks = serde_json::from_str(&text).ok()?;

    if let Ok(builder) = kv.put(JWKS_KEY, &text) {
        let _ = builder.expiration_ttl(JWKS_TTL).execute().await;
    }
    Some(jwks)
}

// ── JWT verification ──

pub async fn verify_access_jwt(
    req: &Request,
    ctx: &RouteContext<()>,
) -> Result<AccessClaims> {
    let env = &ctx.env;
    let team_domain = ctx.var("CF_ACCESS_TEAM_DOMAIN")?.to_string();
    let expected_aud = ctx.var("CF_ACCESS_AUD")?.to_string();
    let now = now_secs();

    // Extract JWT from CF_Authorization cookie
    let cookie_header = req.headers().get("Cookie")?.unwrap_or_default();
    let token = extract_cookie(&cookie_header, "CF_Authorization")
        .ok_or_else(|| err("missing CF_Authorization cookie"))?;

    verify(token, env, &team_domain, &expected_aud, now).await
}

async fn verify(
    token: &str,
    env: &Env,
    team_domain: &str,
    expected_aud: &str,
    now: u64,
) -> Result<AccessClaims> {
    let mut parts = token.split('.');
    let (h, p, s) = (
        parts.next().ok_or_else(|| err("missing header"))?,
        parts.next().ok_or_else(|| err("missing payload"))?,
        parts.next().ok_or_else(|| err("missing signature"))?,
    );
    if parts.next().is_some() {
        return Err(err("trailing JWT parts"));
    }

    // Parse header, check alg
    let header: JwtHeader =
        serde_json::from_slice(&b64url(h).ok_or_else(|| err("bad header b64"))?)
            .map_err(|e| err_msg("bad header json", e))?;
    if header.alg != "RS256" {
        return Err(err("unsupported alg"));
    }

    // Load JWKS, find matching key
    let (n_bytes, e_bytes) = {
        let cached = load_jwks(env, team_domain, false)
            .await
            .ok_or_else(|| err("failed to load JWKS"))?;
        let found = cached.keys.into_iter().find(|k| k.kid == header.kid);
        match found {
            Some(j) => (j.n, j.e),
            None => {
                let fresh = load_jwks(env, team_domain, true)
                    .await
                    .ok_or_else(|| err("failed to reload JWKS"))?;
                let j = fresh
                    .keys
                    .into_iter()
                    .find(|k| k.kid == header.kid)
                    .ok_or_else(|| err("unknown kid"))?;
                (j.n, j.e)
            }
        }
    };

    let n = BoxedUint::from_be_slice_vartime(
        &b64url(&n_bytes).ok_or_else(|| err("bad JWK n"))?,
    );
    let e = BoxedUint::from_be_slice_vartime(
        &b64url(&e_bytes).ok_or_else(|| err("bad JWK e"))?,
    );
    let key = RsaPublicKey::new(n, e).map_err(|e| err_msg("bad RSA key", e))?;

    // Verify signature
    let signing_input = format!("{h}.{p}");
    let digest = Sha256::digest(signing_input.as_bytes());
    let sig_bytes = b64url(s).ok_or_else(|| err("bad signature b64"))?;
    key.verify(Pkcs1v15Sign::new::<Sha256>(), &digest, &sig_bytes)
        .map_err(|e| err_msg("signature verification failed", e))?;

    // Parse and validate claims
    let claims: AccessClaims =
        serde_json::from_slice(&b64url(p).ok_or_else(|| err("bad payload b64"))?)
            .map_err(|e| err_msg("bad payload json", e))?;

    // exp
    if claims.exp < now {
        return Err(err("JWT expired"));
    }
    // nbf
    if matches!(claims.nbf, Some(nbf) if nbf > now) {
        return Err(err("JWT not yet valid"));
    }
    // iss
    let expected_iss = format!("https://{team_domain}");
    if claims.iss.trim_end_matches('/') != expected_iss.trim_end_matches('/') {
        return Err(err("invalid issuer"));
    }
    // aud
    let aud_ok = match &claims.aud {
        serde_json::Value::String(a) => a == expected_aud,
        serde_json::Value::Array(arr) => arr.iter().any(|v| v.as_str() == Some(expected_aud)),
        _ => false,
    };
    if !aud_ok {
        return Err(err("invalid audience"));
    }

    Ok(claims)
}

// ── Cookie extraction ──

fn extract_cookie<'a>(cookie_header: &'a str, name: &str) -> Option<&'a str> {
    let prefix = format!("{}=", name);
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        if trimmed.starts_with(&prefix) {
            return Some(trimmed[prefix.len()..].trim());
        }
    }
    None
}

// ── Error helpers ──

fn err(msg: &str) -> worker::Error {
    worker::Error::RustError(msg.into())
}

fn err_msg(msg: &str, e: impl std::fmt::Display) -> worker::Error {
    worker::Error::RustError(format!("{msg}: {e}"))
}
