//! Restore: extract a backup archive into a data folder.

use super::*;

const MAX_DATA_IMPORT_ENTRIES: usize = 100_000;
const MAX_DATA_IMPORT_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

// ── Import (restore from zip) ──────────────────────────────────────────────────────

/// Extract a backup archive into `to`, then point the data folder at `to`. Must run
/// offline (it overwrites the live DB files). The destination is created if needed;
/// existing files with the same name are overwritten. An encrypted export needs
/// its `passphrase`; a legacy plain-zip export imports without one.
///
/// When the archive carries a key bundle, the bundle's master key is adopted for
/// `to` before any file is replaced (the target's previous key is retired), and
/// the archive's own key file and key records are not extracted.
pub fn import_zip(archive: &Path, to: &Path, passphrase: Option<&str>) -> std::io::Result<()> {
    import_zip_with(archive, to, passphrase, &CustodyKeyBundles)
}

pub(super) fn import_zip_with(
    archive: &Path,
    to: &Path,
    passphrase: Option<&str>,
    keys: &dyn KeyBundlePort,
) -> std::io::Result<()> {
    let (file, archive_key) = open_data_archive_keyed(archive, to, passphrase)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| std::io::Error::other(e.to_string()))?;
    let key_bundle = read_key_bundle(&mut zip)?;
    let has_bundle = key_bundle.is_some();
    let listed = if has_bundle {
        KeyAdoption::Bundle
    } else {
        KeyAdoption::None
    };
    // Raw key files of an archive made before key bundles, read while it is
    // validated and adopted before anything is replaced.
    let mut raw_master: Option<String> = None;
    let mut raw_legacy: Option<String> = None;
    let total = zip.len();
    if total > MAX_DATA_IMPORT_ENTRIES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "data backup contains too many entries",
        ));
    }
    let mut seen = std::collections::BTreeMap::<String, bool>::new();
    let mut planned_bytes = 0u64;
    for i in 0..total {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let Some(rel) = entry.enclosed_name() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup contains an unsafe path",
            ));
        };
        if !is_restored_entry(&rel, listed, to) {
            continue;
        }
        let normalized = rel.to_string_lossy().replace('\\', "/");
        let normalized = normalized.trim_end_matches('/').to_ascii_lowercase();
        if seen.contains_key(&normalized) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup contains duplicate paths",
            ));
        }
        // A file cannot also be a directory for another archive entry. Detect
        // both entry orders before any current data-folder bytes are replaced.
        let has_file_ancestor = normalized
            .match_indices('/')
            .any(|(end, _)| seen.get(&normalized[..end]) == Some(&false));
        let prefix = format!("{normalized}/");
        let has_descendant = !entry.is_dir()
            && seen
                .range(prefix.clone()..)
                .next()
                .is_some_and(|(existing, _)| existing.starts_with(&prefix));
        if has_file_ancestor || has_descendant {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup contains conflicting file and directory paths",
            ));
        }
        // `normalized` is lowercase, like the raw key entry names.
        let raw_key_entry = if has_bundle {
            None
        } else if normalized == RAW_MASTER_KEY_ENTRY {
            Some(true)
        } else if normalized == RAW_LEGACY_KEY_ENTRY {
            Some(false)
        } else {
            None
        };
        seen.insert(normalized, entry.is_dir());
        if path_contains_symlink(to, &to.join(rel)) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "data backup destination contains a symbolic link",
            ));
        }
        if entry.is_dir() {
            continue;
        }
        if entry.size() > MAX_DATA_IMPORT_FILE_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup contains an oversized file",
            ));
        }
        planned_bytes = planned_bytes.checked_add(entry.size()).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup size is invalid",
            )
        })?;
        // Validate every retained entry before replacing any destination file.
        // A late CRC/decompression failure must not leave the active data folder
        // with an earlier database already restored and another still original.
        let declared_size = entry.size();
        let raw_slot = match raw_key_entry {
            Some(true) => Some(&mut raw_master),
            Some(false) => Some(&mut raw_legacy),
            None => None,
        };
        if let Some(slot) = raw_slot {
            if declared_size > MAX_RAW_KEY_FILE_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "data backup carries a malformed master key",
                ));
            }
            let mut bytes = Vec::new();
            copy_declared_backup_entry(&mut entry, &mut bytes, declared_size, declared_size)?;
            *slot = Some(String::from_utf8_lossy(&bytes).into_owned());
        } else {
            copy_declared_backup_entry(
                &mut entry,
                &mut std::io::sink(),
                declared_size,
                declared_size,
            )?;
        }
    }
    let available = paths::available_space_for(to);
    if available > 0 && planned_bytes > available {
        return Err(std::io::Error::new(
            std::io::ErrorKind::WriteZero,
            "not enough free space for the data backup",
        ));
    }
    // Adopt the backup's master key before any file is replaced: the target's
    // own key is retired, never overwritten, so a refusal here (retired set full,
    // unreadable key) leaves the folder exactly as it was.
    if let Some(bundle) = &key_bundle {
        let archive_key = archive_key.ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup carries a key bundle but is not encrypted",
            )
        })?;
        keys.adopt_into(to, &key_bundle_wrap(&archive_key), bundle)?;
    }
    // An archive made before key bundles carries the raw key files instead.
    // Restoring them would overwrite the target's key without retiring it, so
    // they are adopted the same way: the archive key becomes current and the
    // target's key is retired, then the files themselves are not extracted.
    let mut adoption = listed;
    if !has_bundle {
        if let Some((wrap, sealed)) = raw_key_bundle(raw_master.as_deref(), raw_legacy.as_deref())?
        {
            keys.adopt_into(to, &wrap, &sealed)?;
            adoption = KeyAdoption::RawFiles;
        }
    }
    emit(&Progress {
        phase: "extract",
        copied_bytes: 0,
        total_bytes: total as u64,
    });

    if let Ok(metadata) = std::fs::symlink_metadata(to) {
        if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "data backup destination must be a directory",
            ));
        }
    } else {
        std::fs::create_dir_all(to)?;
    }
    let mut extracted_bytes = 0u64;
    for i in 0..total {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let Some(rel) = entry.enclosed_name() else {
            continue; // path-traversal guard (zip-slip): skip unsafe names
        };
        if !is_restored_entry(&rel, adoption, to) {
            continue;
        }
        let out = to.join(rel);
        if path_contains_symlink(to, &out) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "data backup destination contains a symbolic link",
            ));
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let parent = out.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "data backup entry has no parent",
            )
        })?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".ryu-import-")
            .tempfile_in(parent)?;
        let declared_size = entry.size();
        let remaining_planned = planned_bytes.saturating_sub(extracted_bytes);
        let copied = copy_declared_backup_entry(
            &mut entry,
            temporary.as_file_mut(),
            declared_size,
            remaining_planned,
        )?;
        extracted_bytes += copied;
        temporary.as_file().sync_all()?;
        temporary.persist(&out).map_err(|error| error.error)?;
        if i % 16 == 0 || i + 1 == total {
            emit(&Progress {
                phase: "extract",
                copied_bytes: (i + 1) as u64,
                total_bytes: total as u64,
            });
        }
    }

    paths::set_data_dir(Some(to)).map_err(|e| {
        std::io::Error::other(format!("imported data but failed to update pointer: {e}"))
    })?;
    Ok(())
}
