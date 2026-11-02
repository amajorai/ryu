//! Bounded, traversal-safe archive extraction (`.tar.gz`, `.tar.bz2`, `.zip`)
//! that keeps each archive's internal directory structure, or pulls one named
//! binary out of it.

use std::path::Path;

use anyhow::Context;

/// Extract a named binary from a `.tar.gz` archive.
pub(crate) fn extract_from_tar_gz(data: &[u8], binary_name: &str) -> anyhow::Result<Vec<u8>> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    use tar::Archive;

    let gz = GzDecoder::new(data);
    let mut archive = Archive::new(gz);
    const MAX_NAMED_BINARY_BYTES: u64 = 256 * 1024 * 1024;

    for entry in archive.entries().context("reading tar entries")? {
        let mut entry = entry.context("reading tar entry")?;
        let path = entry.path().context("getting entry path")?;
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        if file_name == binary_name {
            let mut bytes = Vec::new();
            entry
                .take(MAX_NAMED_BINARY_BYTES + 1)
                .read_to_end(&mut bytes)
                .context("reading entry bytes")?;
            if bytes.len() as u64 > MAX_NAMED_BINARY_BYTES {
                anyhow::bail!("binary entry exceeds the {MAX_NAMED_BINARY_BYTES}-byte cap");
            }
            return Ok(bytes);
        }
    }

    anyhow::bail!("binary '{binary_name}' not found in archive")
}

/// Default decompression-bomb cap for [`extract_tar_gz_to_dir`]: 500 MB of
/// expanded bytes. Appropriate for skill/tool tarballs; model-class archives
/// legitimately expand past this and must pass an explicit larger cap.
pub(crate) const DEFAULT_EXTRACT_CAP_BYTES: u64 = 500 * 1024 * 1024;

/// Whether an archive entry path stays inside the extraction directory when
/// joined onto it: only plain names (and `.`) are allowed.
///
/// Checking for `..` and `is_absolute()` is not enough on Windows, where a
/// rooted path without a drive (`\Windows\x`) and a drive-relative one (`C:x`)
/// are not "absolute" yet still make `dest_dir.join(rel)` discard `dest_dir`.
fn is_safe_archive_entry_path(rel: &std::path::Path) -> bool {
    rel.components().all(|component| {
        matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    })
}

/// Extract **every** file entry from a `.tar.gz` archive into `dest_dir`,
/// preserving the archive's internal directory structure. Returns the list of
/// written relative paths.
///
/// Used for multi-file model bundles (e.g. the parakeet ONNX model archive from
/// blob.handy.computer, which expands to a `parakeet-tdt-0.6b-v3-int8/` dir with
/// encoder/decoder/nemo128 `.onnx` files + `vocab.txt`). Entries are sanitized to
/// stay within `dest_dir` (no `..` traversal).
///
/// `max_total_bytes` is the decompression-bomb cap on total expanded bytes;
/// `None` uses [`DEFAULT_EXTRACT_CAP_BYTES`] (500 MB). Callers extracting
/// model-class archives (which legitimately expand into the GB range) should
/// pass an explicit, still-bounded cap instead of removing the guard.
pub(crate) fn extract_tar_gz_to_dir(
    data: &[u8],
    dest_dir: &Path,
    max_total_bytes: Option<u64>,
) -> anyhow::Result<Vec<String>> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    use tar::Archive;

    std::fs::create_dir_all(dest_dir)
        .with_context(|| format!("creating {}", dest_dir.display()))?;

    // Decompression-bomb guard: cap both the total bytes written and the number
    // of entries so a tiny gzip can't expand to fill the disk.
    let max_total_bytes = max_total_bytes.unwrap_or(DEFAULT_EXTRACT_CAP_BYTES);
    const MAX_ENTRIES: usize = 50_000;

    let gz = GzDecoder::new(data);
    let mut archive = Archive::new(gz);
    let mut written = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut entry_count: usize = 0;

    for entry in archive.entries().context("reading tar entries")? {
        entry_count += 1;
        if entry_count > MAX_ENTRIES {
            anyhow::bail!("archive has too many entries (cap {MAX_ENTRIES})");
        }
        let mut entry = entry.context("reading tar entry")?;
        let rel = entry.path().context("getting entry path")?.into_owned();

        // Reject path traversal: skip any component that is `..` or absolute.
        if !is_safe_archive_entry_path(&rel) {
            tracing::warn!("skipping unsafe tar entry path: {}", rel.display());
            continue;
        }

        // No-follow: a symlink planted under `dest_dir` must not redirect writes.
        if entry.header().entry_type().is_dir() {
            crate::sidecar::extract_guard::create_dir_confined(dest_dir, &rel)?;
            continue;
        }
        let remaining = max_total_bytes.saturating_sub(total_bytes);
        let mut bytes = Vec::new();
        entry
            .take(remaining.saturating_add(1))
            .read_to_end(&mut bytes)
            .context("reading entry bytes")?;
        if bytes.len() as u64 > remaining {
            anyhow::bail!(
                "archive expands past the {max_total_bytes}-byte cap (decompression bomb?)"
            );
        }
        total_bytes += bytes.len() as u64;
        crate::sidecar::extract_guard::write_file_confined(dest_dir, &rel, &bytes)?;
        written.push(rel.to_string_lossy().into_owned());
    }

    Ok(written)
}

/// Like [`extract_tar_gz_to_dir`] but for `.tar.bz2` archives (e.g. goose releases).
pub(crate) fn extract_tar_bz2_to_dir(
    data: &[u8],
    dest_dir: &Path,
    max_total_bytes: Option<u64>,
) -> anyhow::Result<Vec<String>> {
    use bzip2::read::BzDecoder;
    use std::io::Read;
    use tar::Archive;

    std::fs::create_dir_all(dest_dir)
        .with_context(|| format!("creating {}", dest_dir.display()))?;

    let max_total_bytes = max_total_bytes.unwrap_or(DEFAULT_EXTRACT_CAP_BYTES);
    const MAX_ENTRIES: usize = 50_000;

    let decoder = BzDecoder::new(data);
    let mut archive = Archive::new(decoder);
    let mut written = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut entry_count: usize = 0;

    for entry in archive.entries().context("reading tar entries")? {
        entry_count += 1;
        if entry_count > MAX_ENTRIES {
            anyhow::bail!("archive has too many entries (cap {MAX_ENTRIES})");
        }
        let mut entry = entry.context("reading tar entry")?;
        let rel = entry.path().context("getting entry path")?.into_owned();

        if !is_safe_archive_entry_path(&rel) {
            tracing::warn!("skipping unsafe tar entry path: {}", rel.display());
            continue;
        }

        // No-follow: a symlink planted under `dest_dir` must not redirect writes.
        if entry.header().entry_type().is_dir() {
            crate::sidecar::extract_guard::create_dir_confined(dest_dir, &rel)?;
            continue;
        }
        let remaining = max_total_bytes.saturating_sub(total_bytes);
        let mut bytes = Vec::new();
        entry
            .take(remaining.saturating_add(1))
            .read_to_end(&mut bytes)
            .context("reading entry bytes")?;
        if bytes.len() as u64 > remaining {
            anyhow::bail!(
                "archive expands past the {max_total_bytes}-byte cap (decompression bomb?)"
            );
        }
        total_bytes += bytes.len() as u64;
        crate::sidecar::extract_guard::write_file_confined(dest_dir, &rel, &bytes)?;
        written.push(rel.to_string_lossy().into_owned());
    }

    Ok(written)
}

/// Extract **every** file entry from a `.zip` archive into `dest_dir`, preserving
/// the archive's internal directory structure (unlike [`extract_all_to_dir`]).
pub(crate) fn extract_zip_to_dir(
    data: &[u8],
    dest_dir: &Path,
    max_total_bytes: Option<u64>,
) -> anyhow::Result<Vec<String>> {
    use std::io::{Cursor, Read};
    use zip::ZipArchive;

    std::fs::create_dir_all(dest_dir)
        .with_context(|| format!("creating {}", dest_dir.display()))?;

    let max_total_bytes = max_total_bytes.unwrap_or(DEFAULT_EXTRACT_CAP_BYTES);
    const MAX_ENTRIES: usize = 50_000;

    let reader = Cursor::new(data);
    let mut archive = ZipArchive::new(reader).context("reading zip archive")?;
    let mut written = Vec::new();
    let mut total_bytes: u64 = 0;

    for i in 0..archive.len() {
        if i >= MAX_ENTRIES {
            anyhow::bail!("archive has too many entries (cap {MAX_ENTRIES})");
        }
        let mut file = archive.by_index(i).context("reading zip entry")?;
        let entry_name = file
            .name()
            .context("zip entry has an invalid name")?
            .into_owned();
        if entry_name.ends_with('/') {
            let rel = std::path::Path::new(&entry_name);
            // Reject traversal AND absolute paths: an absolute directory entry
            // (`/abs/…/`) would make `dest_dir.join(rel)` replace the base and
            // `create_dir_all` outside the sandbox (`PathBuf::join` semantics).
            // Mirror the file branch below, which already guards both.
            if !is_safe_archive_entry_path(&rel) {
                continue;
            }
            crate::sidecar::extract_guard::create_dir_confined(dest_dir, rel)?;
            continue;
        }
        let rel = std::path::Path::new(&entry_name);
        if !is_safe_archive_entry_path(&rel) {
            tracing::warn!("skipping unsafe zip entry path: {entry_name}");
            continue;
        }
        let remaining = max_total_bytes.saturating_sub(total_bytes);
        let mut bytes = Vec::new();
        file.take(remaining.saturating_add(1))
            .read_to_end(&mut bytes)
            .context("reading zip entry bytes")?;
        if bytes.len() as u64 > remaining {
            anyhow::bail!(
                "archive expands past the {max_total_bytes}-byte cap (decompression bomb?)"
            );
        }
        total_bytes += bytes.len() as u64;
        crate::sidecar::extract_guard::write_file_confined(dest_dir, rel, &bytes)?;
        written.push(entry_name);
    }

    Ok(written)
}

/// Extract a named binary from a `.zip` archive.
pub(crate) fn extract_from_zip(data: &[u8], binary_name: &str) -> anyhow::Result<Vec<u8>> {
    use std::io::{Cursor, Read};
    use zip::ZipArchive;

    let reader = Cursor::new(data);
    let mut archive = ZipArchive::new(reader).context("reading zip archive")?;
    const MAX_NAMED_BINARY_BYTES: u64 = 256 * 1024 * 1024;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).context("reading zip entry")?;
        let name = file
            .name()
            .context("zip entry has an invalid name")?
            .into_owned();
        if name.ends_with(binary_name) || name.ends_with(&format!("{binary_name}.exe")) {
            let mut bytes = Vec::new();
            file.take(MAX_NAMED_BINARY_BYTES + 1)
                .read_to_end(&mut bytes)
                .context("reading zip entry bytes")?;
            if bytes.len() as u64 > MAX_NAMED_BINARY_BYTES {
                anyhow::bail!("binary entry exceeds the {MAX_NAMED_BINARY_BYTES}-byte cap");
            }
            return Ok(bytes);
        }
    }

    anyhow::bail!("binary '{binary_name}' not found in zip archive")
}

#[cfg(test)]
#[path = "archive_tests.rs"]
pub(super) mod tests;
