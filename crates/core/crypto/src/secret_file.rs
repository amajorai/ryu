//! Single-secret files: a bearer token, an API key or a signing seed stored
//! alone in a file (`secrets/node-control.token`, `gateway-relay.token`,
//! `marketplace-signing-key`, ...).
//!
//! The file body is one sealed envelope (`enc:v1:` / `encc:v1:` / `encp:v1:`)
//! from the caller's [`SecretSealer`]. The migration contract is the shared one:
//!
//! * [`read_secret_file`] accepts a legacy plaintext body (reported with
//!   `needs_reseal`) and a sealed body (which must open, or the read fails: a
//!   sealed file never reads as missing or empty).
//! * [`write_secret_file`] seals before any byte reaches disk and fails closed
//!   when sealing fails. The write is atomic (owner-only temp file in the same
//!   directory, fsync, rename), so a crash never leaves a truncated secret and
//!   no plaintext temp file is ever written.
//! * [`reseal_secret_file`] rewrites a legacy plaintext body sealed, once.
//!
//! Symlinks are refused on read and write, and a body larger than
//! [`MAX_SECRET_FILE_BYTES`] is refused, so a planted link or a huge file cannot
//! redirect or exhaust a reader.

use std::io::{Read as _, Write as _};
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};

use crate::{looks_sealed, Opened, SecretSealer};

/// Largest accepted secret-file body. Envelopes of the secrets this module
/// stores are a few hundred bytes.
pub const MAX_SECRET_FILE_BYTES: u64 = 16 * 1024;

/// Read and open the secret stored in `path`.
///
/// * `Ok(None)`: the file does not exist, or holds only whitespace.
/// * `Ok(Some(opened))`: the trimmed value; `needs_reseal` is true when the body
///   was legacy plaintext.
/// * `Err`: the file is a symlink or too large, or the body is sealed and
///   `sealer` is `None` or cannot open it (wrong key, corrupt, another scheme's
///   envelope).
pub fn read_secret_file(path: &Path, sealer: Option<&dyn SecretSealer>) -> Result<Option<Opened>> {
    let Some(body) = read_body(path)? else {
        return Ok(None);
    };
    if !looks_sealed(&body) {
        return Ok(Some(Opened {
            value: body,
            needs_reseal: true,
        }));
    }
    let sealer = sealer.ok_or_else(|| {
        anyhow!(
            "{} is sealed and no key to open it is available in this process",
            path.display()
        )
    })?;
    let value = sealer
        .open(&body)
        .with_context(|| format!("opening sealed secret {}", path.display()))?;
    Ok(Some(Opened {
        value: value.trim().to_owned(),
        needs_reseal: false,
    }))
}

/// Seal `value` with `sealer` and atomically replace `path` with the envelope
/// (mode 0600 on Unix). Fails closed: nothing is written when sealing fails.
pub fn write_secret_file(path: &Path, value: &str, sealer: &dyn SecretSealer) -> Result<()> {
    let sealed = sealer
        .seal(value)
        .with_context(|| format!("sealing secret for {}", path.display()))?;
    write_body(path, &sealed)
}

/// Rewrite `path` sealed when it still holds a legacy plaintext body. Returns
/// whether the file was rewritten. A missing, empty or already sealed file is
/// left alone.
pub fn reseal_secret_file(path: &Path, sealer: &dyn SecretSealer) -> Result<bool> {
    match read_secret_file(path, Some(sealer))? {
        Some(opened) if opened.needs_reseal => {
            write_secret_file(path, &opened.value, sealer)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn read_body(path: &Path) -> Result<Option<String>> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("inspecting secret {}", path.display()))
        }
    };
    if metadata.file_type().is_symlink() {
        bail!("secret file {} must not be a symlink", path.display());
    }
    if !metadata.is_file() {
        bail!("secret file {} is not a regular file", path.display());
    }
    if metadata.len() > MAX_SECRET_FILE_BYTES {
        bail!("secret file {} is too large", path.display());
    }
    let mut body = String::new();
    std::fs::File::open(path)
        .with_context(|| format!("opening secret {}", path.display()))?
        .take(MAX_SECRET_FILE_BYTES + 1)
        .read_to_string(&mut body)
        .with_context(|| format!("reading secret {}", path.display()))?;
    let trimmed = body.trim();
    Ok((!trimmed.is_empty()).then(|| trimmed.to_owned()))
}

fn write_body(path: &Path, body: &str) -> Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| anyhow!("secret path {} has no parent", path.display()))?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("creating secret dir {}", parent.display()))?;
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        bail!("secret file {} must not be a symlink", path.display());
    }
    // `NamedTempFile` creates the file 0600 on Unix before any byte is written.
    let mut temporary = tempfile::Builder::new()
        .prefix(".secret-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .with_context(|| format!("creating temporary secret in {}", parent.display()))?;
    temporary
        .as_file_mut()
        .write_all(body.as_bytes())
        .with_context(|| format!("writing temporary secret for {}", path.display()))?;
    temporary
        .as_file_mut()
        .sync_all()
        .with_context(|| format!("syncing temporary secret for {}", path.display()))?;
    temporary
        .persist(path)
        .map_err(|error| error.error)
        .with_context(|| format!("replacing secret {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("restricting secret {}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ComponentCipher, FieldCipher};

    const SECRET: &str = "rgw_control_0123456789abcdef0123456789";

    fn temp_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    fn raw_contains(path: &Path, needle: &str) -> bool {
        String::from_utf8_lossy(&std::fs::read(path).expect("read raw")).contains(needle)
    }

    #[test]
    fn round_trips_sealed_and_keeps_the_secret_off_disk() {
        let dir = temp_dir();
        let path = dir.path().join("secrets").join("node-control.token");
        let cipher = FieldCipher::new(&[3u8; 32]);
        write_secret_file(&path, SECRET, &cipher).unwrap();
        assert!(!raw_contains(&path, SECRET), "raw secret on disk");
        assert!(raw_contains(&path, "enc:v1:"));
        let opened = read_secret_file(&path, Some(&cipher)).unwrap().unwrap();
        assert_eq!(opened.value, SECRET);
        assert!(!opened.needs_reseal);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temporary secret left behind");
    }

    #[test]
    fn legacy_plaintext_reads_and_reseals_once() {
        let dir = temp_dir();
        let path = dir.path().join("gateway-relay.token");
        std::fs::write(&path, format!("{SECRET}\n")).unwrap();
        let cipher = ComponentCipher::from_subkey_b64(
            "gateway",
            "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        )
        .unwrap();
        // A plaintext body needs no key to read.
        let opened = read_secret_file(&path, None).unwrap().unwrap();
        assert_eq!(opened.value, SECRET);
        assert!(opened.needs_reseal);

        assert!(reseal_secret_file(&path, &cipher).unwrap());
        assert!(!raw_contains(&path, SECRET));
        assert!(raw_contains(&path, "encc:v1:"));
        assert!(!reseal_secret_file(&path, &cipher).unwrap(), "idempotent");
        let opened = read_secret_file(&path, Some(&cipher)).unwrap().unwrap();
        assert_eq!(opened.value, SECRET);
        assert!(!opened.needs_reseal);
    }

    #[test]
    fn sealed_files_never_read_as_missing() {
        let dir = temp_dir();
        let path = dir.path().join("bootstrap-ack.token");
        write_secret_file(&path, SECRET, &FieldCipher::new(&[4u8; 32])).unwrap();
        assert!(read_secret_file(&path, None).is_err(), "no key");
        assert!(
            read_secret_file(&path, Some(&FieldCipher::new(&[5u8; 32]))).is_err(),
            "wrong key"
        );
        let component = ComponentCipher::from_subkey_b64(
            "gateway",
            "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        )
        .unwrap();
        assert!(
            read_secret_file(&path, Some(&component)).is_err(),
            "another scheme"
        );
    }

    #[test]
    fn missing_and_blank_files_read_as_none() {
        let dir = temp_dir();
        let path = dir.path().join("absent.token");
        assert!(read_secret_file(&path, None).unwrap().is_none());
        std::fs::write(&path, " \n").unwrap();
        assert!(read_secret_file(&path, None).unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_refused() {
        let dir = temp_dir();
        let target = dir.path().join("target.token");
        std::fs::write(&target, SECRET).unwrap();
        let link = dir.path().join("link.token");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(read_secret_file(&link, None).is_err());
        assert!(write_secret_file(&link, SECRET, &FieldCipher::new(&[3u8; 32])).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), SECRET);
    }
}
