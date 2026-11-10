//! Backup: zip the data folder and write it passphrase-encrypted.

use super::*;

/// Zip the whole data folder `from` and write it, encrypted under `passphrase`,
/// to `out`. Read-only on the data folder, so it's safe to call while Core is
/// running (DB rows mid-write may land in an inconsistent snapshot — acceptable
/// for a manual backup). Refuses (fails closed) without a usable passphrase.
///
/// An export of the active data folder always carries its master key, retired
/// keys and key check value inside the encrypted stream (any custody); it fails
/// rather than write an archive that could not be restored.
pub fn export_zip(from: &Path, out: &Path, passphrase: &str) -> std::io::Result<u64> {
    export_zip_with(
        from,
        out,
        passphrase,
        crate::vault::snapshot::DEFAULT_ITERATIONS,
        &CustodyKeyBundles,
    )
}

#[cfg(test)]
pub(super) fn export_zip_with_iterations(
    from: &Path,
    out: &Path,
    passphrase: &str,
    iterations: u32,
) -> std::io::Result<u64> {
    export_zip_with(from, out, passphrase, iterations, &CustodyKeyBundles)
}

/// Whether the data folder `dir` carries key records (a key check value or
/// retired keys) that a bundle-less archive would silently drop. An unreadable
/// retired-key index counts as present, so the export fails closed.
fn holds_key_records(dir: &Path) -> bool {
    dir.join(KEY_RECORD_KCV_ENTRY).exists()
        || ryu_crypto::custody::read_retired_index(dir).map_or(true, |index| !index.is_empty())
}

pub(super) fn export_zip_with(
    from: &Path,
    out: &Path,
    passphrase: &str,
    iterations: u32,
    keys: &dyn KeyBundlePort,
) -> std::io::Result<u64> {
    check_export_passphrase(passphrase)?;
    let out = if out.is_absolute() {
        out.to_path_buf()
    } else {
        std::env::current_dir()?.join(out)
    };
    if paths::paths_overlap(from, &out) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "export destination cannot be inside the data folder",
        ));
    }
    let parent = out.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "export destination has no parent folder",
        )
    })?;
    std::fs::create_dir_all(parent)?;
    if let Ok(metadata) = std::fs::symlink_metadata(&out) {
        if metadata.file_type().is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "export destination cannot be a symbolic link",
            ));
        }
    }
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let archive_key = ExportKey::generate(passphrase, iterations);
    let key_bundle = keys.seal_for(from, &key_bundle_wrap(&archive_key.key))?;
    if key_bundle.is_none() && holds_key_records(from) {
        // A folder this process does not hold the key of cannot contribute its
        // retired keys (or a keychain-held current key) to the archive, and the
        // raw-file fallback on import skips them: the archive would not restore.
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "export the active data folder, or switch to this folder first, so its master and \
             retired keys can be included",
        ));
    }

    let mut written = 0u64;
    // The plaintext zip is an anonymous file in the data folder's owner-only
    // scratch, never on the destination medium: nothing can open it by name and
    // the OS reclaims it even if this process is killed mid-export. Only the
    // ciphertext below is written next to `out`.
    let mut plain = {
        let mut zip = zip::ZipWriter::new(plaintext_scratch(from, EXPORT_SCRATCH_OWNER)?);
        zip_dir(from, from, &mut zip, options, &mut written)?;
        if let Some(bundle) = &key_bundle {
            zip.start_file(KEY_BUNDLE_ENTRY, options)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            zip.write_all(bundle.as_bytes())?;
        }
        zip.finish()?
    };
    // `tempfile` creates the named output owner-only (0600 on Unix).
    let mut temporary = tempfile::Builder::new()
        .prefix(".ryu-backup-")
        .tempfile_in(parent)?;
    {
        let mut output = std::io::BufWriter::new(temporary.as_file_mut());
        seal_export(&mut plain, &mut output, &archive_key)?;
        output.flush()?;
    }
    drop(plain);
    temporary.as_file().sync_all()?;
    temporary.persist(&out).map_err(|error| error.error)?;
    Ok(written)
}

fn zip_dir<W: Write + std::io::Seek>(
    root: &Path,
    dir: &Path,
    zip: &mut zip::ZipWriter<W>,
    options: zip::write::SimpleFileOptions,
    written: &mut u64,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let ft = entry.file_type()?;
        let rel = path.strip_prefix(root).unwrap_or(&path);
        // The data folder's top-level `tmp/` holds this export's own plaintext
        // scratch (see `plaintext_scratch`), which Windows keeps as a named,
        // locked file, and is regenerable scratch on every OS.
        if is_backup_excluded(rel) || rel == Path::new(layout::top::TMP) {
            continue;
        }
        let name = rel.to_string_lossy().replace('\\', "/");
        if ft.is_dir() {
            zip_dir(root, &path, zip, options, written)?;
        } else if ft.is_file() {
            zip.start_file(name, options)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            let mut file = std::fs::File::open(&path)?;
            *written += std::io::copy(&mut file, zip)?;
        }
    }
    Ok(())
}
