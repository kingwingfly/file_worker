use worker::{Headers, Result};

pub fn headers() -> Result<Headers> {
    let h = Headers::new();
    h.set("Access-Control-Allow-Origin", "*")?;
    h.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")?;
    h.set("Access-Control-Allow-Headers", "Content-Type, Authorization")?;
    h.set("Access-Control-Max-Age", "86400")?;
    Ok(h)
}

pub fn extend_headers(headers: &mut Headers) -> Result<()> {
    headers.set("Access-Control-Allow-Origin", "*")?;
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")?;
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization")?;
    Ok(())
}
