use super::*;

/// Only machine identity fields count. Email/display label and a bare successful
/// command cannot establish identity. Unknown vendor shapes stay disconnected.
pub fn parse_identity(bytes: &[u8]) -> Result<NativeIdentity> {
    if bytes.len() > 64 * 1024 {
        bail!("Native identity output exceeds limit");
    }
    let value: Value =
        serde_json::from_slice(bytes).context("Native CLI did not return machine identity")?;
    let subject = value
        .get("userId")
        .or_else(|| value.get("subject"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 2048)
        .ok_or_else(|| {
            anyhow!("Native CLI identity format is not verified; account remains disconnected")
        })?;
    let issuer = value
        .get("issuer")
        .or_else(|| value.get("identityProvider"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= 2048)
        .ok_or_else(|| {
            anyhow!("Native CLI identity issuer is unavailable; account remains disconnected")
        })?;
    Ok(NativeIdentity {
        subject: subject.to_owned(),
        issuer: issuer.to_owned(),
    })
}
