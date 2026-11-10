//! The per-session credential projection (uth.json) a Pi instance reads.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::path::Path;

pub(super) fn private_dir(path: &Path) -> Result<()> {
    reject_link(path)?;
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub(super) fn reject_link(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("Pi account projection cannot use symbolic links")
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn publish_credential(
    directory: &Path,
    auth_key: &str,
    credential: &Value,
) -> Result<()> {
    let mut projection = credential
        .as_object()
        .context("OAuth credential is invalid")?
        .clone();
    if projection.get("type").and_then(Value::as_str) != Some("oauth")
        || projection
            .get("access")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        bail!("OAuth credential is unavailable");
    }
    projection.insert("refresh".into(), Value::String(String::new()));
    if projection.get("expires").and_then(Value::as_u64).is_none() {
        let expires = super::super::oauth_expires_at(credential)
            .context("OAuth expiration is unavailable")?;
        projection.insert("expires".into(), json!(expires.saturating_mul(1000)));
    }
    let expiry = projection
        .get("expires")
        .and_then(Value::as_u64)
        .context("OAuth expiration is invalid")?;
    if expiry
        <= super::super::now_unix()
            .saturating_mul(1000)
            .saturating_add(300_000)
    {
        bail!("Captured Pi account needs Core refresh before entering the SDK validity window");
    }
    publish_auth(directory, auth_key, Value::Object(projection))
}

pub(super) fn publish_api_key(directory: &Path, auth_key: &str, credential: &Value) -> Result<()> {
    credential
        .as_str()
        .or_else(|| credential.get("key").and_then(Value::as_str))
        .filter(|key| !key.trim().is_empty())
        .context("Captured Pi API key is unavailable")?;
    // The key reaches Pi in its spawn environment (`SessionAccount::secret_env`);
    // the projected file names it by reference only.
    publish_auth(
        directory,
        auth_key,
        json!({
            "type": "api_key",
            "key": super::super::secret_env::reference(super::super::secret_env::SESSION_KEY_ENV),
        }),
    )
}

pub(super) fn publish_auth(directory: &Path, auth_key: &str, projection: Value) -> Result<()> {
    private_dir(directory)?;
    reject_link(&directory.join("auth.json"))?;
    let auth = serde_json::Map::from_iter([(auth_key.to_owned(), projection)]);
    // `write_secret_file` already stages an owner-only temp file in this
    // directory and renames it over `auth.json`. Staging a second temp file
    // here and replacing it while its handle is open fails on Windows.
    super::super::write_secret_file(&directory.join("auth.json"), &serde_json::to_string(&auth)?)
        .context("Publish captured Pi account credential")
}
