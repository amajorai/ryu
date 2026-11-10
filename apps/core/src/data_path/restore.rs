//! Per-entry rules an import applies: what is restored and how keys are adopted.

use super::*;

pub(super) fn path_contains_symlink(root: &Path, target: &Path) -> bool {
    let mut current = root.to_path_buf();
    match std::fs::symlink_metadata(&current) {
        Ok(metadata) if metadata.file_type().is_symlink() => return true,
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return true,
        _ => {}
    }
    let Ok(relative) = target.strip_prefix(root) else {
        return true;
    };
    for component in relative.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return true,
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return true,
            _ => {}
        }
    }
    false
}

pub(super) fn copy_declared_backup_entry(
    reader: &mut impl Read,
    writer: &mut impl Write,
    declared_size: u64,
    remaining_planned: u64,
) -> std::io::Result<u64> {
    let copied = std::io::copy(
        &mut reader.take(declared_size.min(remaining_planned) + 1),
        writer,
    )?;
    if copied > declared_size || copied > remaining_planned {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "data backup expands beyond its declared size",
        ));
    }
    Ok(copied)
}

/// Largest key bundle accepted from an archive.
const MAX_KEY_BUNDLE_BYTES: u64 = 64 * 1024;

/// Read the archive's sealed key bundle, if it has one.
pub(super) fn read_key_bundle<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
) -> std::io::Result<Option<String>> {
    let entry = match zip.by_name(KEY_BUNDLE_ENTRY) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(std::io::Error::other(error.to_string())),
    };
    if entry.size() > MAX_KEY_BUNDLE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "data backup key bundle is too large",
        ));
    }
    let mut text = String::new();
    entry.take(MAX_KEY_BUNDLE_BYTES).read_to_string(&mut text)?;
    Ok(Some(text.trim().to_owned()))
}

/// How an import takes over the archive's master key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum KeyAdoption {
    /// Nothing to adopt: the archive carries no key (its files are restored).
    None,
    /// The archive's sealed key bundle.
    Bundle,
    /// The raw key files of an archive made before key bundles.
    RawFiles,
}

/// Raw key files an archive without a key bundle may carry.
pub(super) const RAW_MASTER_KEY_ENTRY: &str = "secrets/master.key";
pub(super) const RAW_LEGACY_KEY_ENTRY: &str = "secrets/memory.key";
/// Largest raw key file read from an archive (base64 of 32 bytes is 44).
pub(super) const MAX_RAW_KEY_FILE_BYTES: u64 = 4 * 1024;

/// Key records a bundle-less archive without a raw key never restores over the
/// target's own: the archive's key check value names a key the target does not
/// hold, so restoring it would make the target's key mismatch at the next boot.
pub(super) const KEY_RECORD_KCV_ENTRY: &str = "state/master-key.kcv";
const KEY_RECORD_RETIRED_ENTRY: &str = "state/retired-keys.json";

/// Whether an archive entry is restored into `target`: the key bundle never is,
/// and the key custody files are not when the archive's key was adopted (which
/// retires the target's key instead of overwriting it). With nothing adopted the
/// archive's key check value is never restored, and its retired-key index only
/// when the target has none of its own, so the target's key records always
/// describe the key the target holds.
pub(super) fn is_restored_entry(rel: &Path, adoption: KeyAdoption, target: &Path) -> bool {
    if is_backup_excluded(rel) {
        return false;
    }
    let name = rel.to_string_lossy().replace('\\', "/");
    if name.eq_ignore_ascii_case(KEY_BUNDLE_ENTRY) {
        return false;
    }
    let superseded = match adoption {
        KeyAdoption::None => {
            name.eq_ignore_ascii_case(KEY_RECORD_KCV_ENTRY)
                || (name.eq_ignore_ascii_case(KEY_RECORD_RETIRED_ENTRY)
                    && std::fs::symlink_metadata(target.join(KEY_RECORD_RETIRED_ENTRY)).is_ok())
        }
        KeyAdoption::Bundle => KEY_CUSTODY_ENTRIES
            .iter()
            .any(|entry| name.eq_ignore_ascii_case(entry)),
        KeyAdoption::RawFiles => {
            name.eq_ignore_ascii_case(RAW_LEGACY_KEY_ENTRY)
                || KEY_CUSTODY_ENTRIES
                    .iter()
                    .any(|entry| name.eq_ignore_ascii_case(entry))
        }
    };
    !superseded
}

/// The raw key files of a bundle-less archive, as a key bundle sealed under a
/// fresh wrapping key: `secrets/master.key` is the current key (else the
/// legacy `secrets/memory.key`), and a different legacy key is carried as
/// retired. `None` when the archive carries neither.
pub(super) fn raw_key_bundle(
    master: Option<&str>,
    legacy: Option<&str>,
) -> std::io::Result<Option<([u8; 32], String)>> {
    let decode = |text: &str| {
        ryu_crypto::custody::decode_key_file(text).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup carries a malformed master key",
            )
        })
    };
    let master = master.map(decode).transpose()?;
    let legacy = legacy.map(decode).transpose()?;
    let (current, retired) = match (master, legacy) {
        (Some(master), legacy) => (master, legacy.into_iter().collect::<Vec<_>>()),
        (None, Some(legacy)) => (legacy, Vec::new()),
        (None, None) => return Ok(None),
    };
    let mut wrap = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut wrap);
    let sealed = ryu_crypto::custody::seal_raw_key_bundle(
        &ryu_crypto::FieldCipher::new(&wrap),
        &current,
        &retired,
    )
    .map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(Some((wrap, sealed)))
}
