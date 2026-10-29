//! Owner-only key files: the standalone root, its pinned key check value, and
//! crash-safe private writes.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use rand::RngCore as _;

use super::{MASTER_KEY_ENV, STANDALONE_KCV_FILE, STANDALONE_ROOT_FILE};

fn read_standalone_kcv(path: &Path) -> Result<Option<String>> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    };
    let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|_| {
        anyhow!(
            "{} is unreadable; refusing to guess which key sealed this data",
            path.display()
        )
    })?;
    match parsed.get("kcv").and_then(serde_json::Value::as_str) {
        Some(kcv) if !kcv.is_empty() => Ok(Some(kcv.to_owned())),
        _ => bail!(
            "{} is malformed; refusing to guess which key sealed this data",
            path.display()
        ),
    }
}

/// Record (or check) the standalone root's key check value.
pub(super) fn pin_standalone_kcv(secrets: &Path, kcv: &str, source: &str) -> Result<()> {
    let path = secrets.join(STANDALONE_KCV_FILE);
    match read_standalone_kcv(&path)? {
        None => {
            create_private_dir(secrets)?;
            let body = serde_json::json!({ "v": 1, "kcv": kcv, "source": source });
            write_private_file(&path, format!("{body}\n").as_bytes())
        }
        Some(recorded) if recorded == kcv => Ok(()),
        Some(recorded) => bail!(
            "this app's standalone data was sealed under a different key (kcv {recorded}); \
             restore that {MASTER_KEY_ENV} or {STANDALONE_ROOT_FILE} instead of starting with \
             another key"
        ),
    }
}

pub(super) fn load_or_create_standalone_root(secrets: &Path) -> Result<[u8; 32]> {
    let path = secrets.join(STANDALONE_ROOT_FILE);
    match std::fs::read_to_string(&path) {
        Ok(encoded) => {
            let raw = base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .map_err(|_| anyhow!("{} is not base64", path.display()))?;
            return <[u8; 32]>::try_from(raw.as_slice())
                .map_err(|_| anyhow!("{} must hold exactly 32 bytes", path.display()));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
    }
    if secrets.join(STANDALONE_KCV_FILE).exists() {
        bail!(
            "this app's standalone data was sealed under {MASTER_KEY_ENV}; set it again instead \
             of generating a new key"
        );
    }
    create_private_dir(secrets)?;
    let mut root = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut root);
    let encoded = base64::engine::general_purpose::STANDARD.encode(root);
    write_new_private_file(&path, format!("{encoded}\n").as_bytes())?;
    Ok(root)
}

fn create_private_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("restricting {}", dir.display()))?;
    }
    Ok(())
}

fn write_new_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("creating {}", path.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

/// Write `bytes` to `path` through an owner-only temp file in the same
/// directory and a rename, so a crash never leaves a half-written file.
pub fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = temp_sibling(path);
    if let Err(error) = write_new_private_file(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    std::fs::rename(&tmp, path).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        anyhow!("replacing {}: {error}", path.display())
    })
}

fn temp_sibling(path: &Path) -> PathBuf {
    let mut nonce = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut nonce);
    let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.{suffix}.tmp"))
}
