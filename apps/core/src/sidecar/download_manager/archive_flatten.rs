//! Flattening extraction for release archives whose binary needs the shared
//! libraries shipped beside it (`@loader_path` / `$ORIGIN` / Windows DLLs).

use std::path::{Path, PathBuf};

use anyhow::Context;

use super::DEFAULT_EXTRACT_CAP_BYTES;

/// Extract **every** file entry from a `.zip` archive into `dest_dir`, flattening
/// any directory prefix (e.g. `Release/whisper-server.exe` → `whisper-server.exe`).
/// Returns the list of written file names.
///
/// Unlike [`extract_from_zip`] (which pulls a single binary), this is for
/// multi-file release archives — e.g. whisper.cpp's Windows build, where the
/// server binary links against sibling DLLs that must land next to it.
///
/// In-memory form of [`extract_all_to_dir_from`].
pub(crate) fn extract_all_to_dir(data: &[u8], dest_dir: &Path) -> anyhow::Result<Vec<String>> {
    extract_all_to_dir_from(std::io::Cursor::new(data), dest_dir)
}

/// Streaming form: reads the archive from any seekable reader (e.g. an open file).
pub(crate) fn extract_all_to_dir_from(
    data: impl std::io::Read + std::io::Seek,
    dest_dir: &Path,
) -> anyhow::Result<Vec<String>> {
    use std::io::Read;
    use zip::ZipArchive;

    std::fs::create_dir_all(dest_dir)
        .with_context(|| format!("creating {}", dest_dir.display()))?;

    let reader = data;
    let mut archive = ZipArchive::new(reader).context("reading zip archive")?;
    let mut written = Vec::new();
    let mut total_bytes = 0u64;
    const MAX_ENTRIES: usize = 50_000;

    for i in 0..archive.len() {
        if i >= MAX_ENTRIES {
            anyhow::bail!("archive has too many entries (cap {MAX_ENTRIES})");
        }
        let mut file = archive.by_index(i).context("reading zip entry")?;
        let entry_name = file
            .name()
            .context("zip entry has an invalid name")?
            .into_owned();
        // Skip directory entries (zip dirs end with '/').
        if entry_name.ends_with('/') {
            continue;
        }
        let file_name = entry_name
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&entry_name)
            .to_string();
        if file_name.is_empty() {
            continue;
        }

        let remaining = DEFAULT_EXTRACT_CAP_BYTES.saturating_sub(total_bytes);
        let mut bytes = Vec::new();
        file.take(remaining.saturating_add(1))
            .read_to_end(&mut bytes)
            .context("reading zip entry bytes")?;
        if bytes.len() as u64 > remaining {
            anyhow::bail!(
                "archive expands past the {DEFAULT_EXTRACT_CAP_BYTES}-byte cap (decompression bomb?)"
            );
        }
        total_bytes += bytes.len() as u64;

        let dest = dest_dir.join(&file_name);
        let tmp = dest.with_extension("download-tmp");
        std::fs::write(&tmp, &bytes).with_context(|| format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, &dest)
            .with_context(|| format!("rename {} -> {}", tmp.display(), dest.display()))?;
        written.push(file_name);
    }

    Ok(written)
}

/// The basename of a release-archive entry path (last component after `/` or `\`).
fn archive_basename(entry_name: &str) -> &str {
    entry_name.rsplit(['/', '\\']).next().unwrap_or(entry_name)
}

/// True when `file_name` is the wanted binary itself.
fn is_wanted_binary(file_name: &str, binary_name: &str) -> bool {
    file_name == binary_name || file_name == format!("{binary_name}.exe")
}

/// True when `file_name` is a shared library that must sit beside the binary so
/// its same-directory rpath (`@loader_path` / `$ORIGIN`) resolves at launch.
fn is_shared_library(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    lower.ends_with(".dylib")
        || lower.ends_with(".dll")
        || lower.ends_with(".so")
        || lower.contains(".so.")
}

/// Write `bytes` to `dest_dir/file_name` via a temp file + atomic rename.
fn write_flattened(dest_dir: &Path, file_name: &str, bytes: &[u8]) -> anyhow::Result<PathBuf> {
    let dest = dest_dir.join(file_name);
    let tmp = dest.with_extension("download-tmp");
    std::fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, &dest)
        .with_context(|| format!("rename {} -> {}", tmp.display(), dest.display()))?;
    Ok(dest)
}

/// Recreate a shared-library alias (`libfoo.dylib` -> `libfoo.N.dylib`) as a
/// symlink at `dest_dir/link_name` pointing at `target` (flattened to a bare
/// basename so it resolves in the same directory).
///
/// llama.cpp release archives ship the unversioned / major-version dylib names
/// as *symlink* entries, which carry no data body. Extracting them by reading
/// bytes yields a 0-byte regular file that shadows the real versioned lib, so
/// the binary fails at launch with a dyld "Library not loaded: @rpath/..."
/// error. Recreate the link instead of writing empty bytes; a dangling link is
/// fine here — the target lib may extract later in the same archive.
fn write_symlink_flattened(
    dest_dir: &Path,
    link_name: &str,
    target: &str,
) -> anyhow::Result<PathBuf> {
    let dest = dest_dir.join(link_name);
    let target_basename = archive_basename(target).to_string();
    // Replace any stale entry (e.g. a previous broken 0-byte extraction).
    if std::fs::symlink_metadata(&dest).is_ok() {
        std::fs::remove_file(&dest).ok();
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target_basename, &dest)
            .with_context(|| format!("symlink {} -> {}", dest.display(), target_basename))?;
    }
    #[cfg(not(unix))]
    {
        // Windows assets ship DLLs (no symlinks); copy the target if present.
        let src = dest_dir.join(&target_basename);
        if src.exists() {
            std::fs::copy(&src, &dest)
                .with_context(|| format!("copy {} -> {}", src.display(), dest.display()))?;
        }
    }
    Ok(dest)
}

/// Extract `binary_name` **plus every sibling shared library** from a release
/// archive into `dest_dir`, flattening any internal directory prefix. Returns the
/// path to the extracted binary.
///
/// Modern llama.cpp builds split the engine across many `@loader_path`-relative
/// shared libs (libggml, libllama, libggml-metal, …); pulling out just the
/// `llama-server` binary yields a file that fails to launch with a dyld
/// "Library not loaded" error. Like [`extract_all_to_dir`] (used for whisper.cpp's
/// Windows DLLs) this co-locates the libs, but keeps the bin dir clean by skipping
/// the archive's other CLI tools. Handles `.zip` (Windows) and `.tar.gz`
/// (macOS/Linux).
///
/// In-memory form of [`extract_binary_with_libs_from`].
pub(crate) fn extract_binary_with_libs(
    data: &[u8],
    binary_name: &str,
    dest_dir: &Path,
    is_zip: bool,
) -> anyhow::Result<PathBuf> {
    extract_binary_with_libs_from(std::io::Cursor::new(data), binary_name, dest_dir, is_zip)
}

/// Streaming form: reads the archive from any seekable reader (e.g. an open file).
pub(crate) fn extract_binary_with_libs_from(
    data: impl std::io::Read + std::io::Seek,
    binary_name: &str,
    dest_dir: &Path,
    is_zip: bool,
) -> anyhow::Result<PathBuf> {
    std::fs::create_dir_all(dest_dir)
        .with_context(|| format!("creating {}", dest_dir.display()))?;

    if is_zip {
        extract_binary_with_libs_from_zip(data, binary_name, dest_dir)
    } else {
        extract_binary_with_libs_from_tar_gz(data, binary_name, dest_dir)
    }
}

fn extract_binary_with_libs_from_zip(
    data: impl std::io::Read + std::io::Seek,
    binary_name: &str,
    dest_dir: &Path,
) -> anyhow::Result<PathBuf> {
    use std::io::Read;
    use zip::ZipArchive;

    let reader = data;
    let mut archive = ZipArchive::new(reader).context("reading zip archive")?;
    let mut binary_path = None;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).context("reading zip entry")?;
        let entry_name = file
            .name()
            .context("zip entry has an invalid name")?
            .into_owned();
        if entry_name.ends_with('/') {
            continue;
        }
        let file_name = archive_basename(&entry_name).to_string();
        let is_binary = is_wanted_binary(&file_name, binary_name);
        if !(is_binary || is_shared_library(&file_name)) {
            continue;
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .context("reading zip entry bytes")?;
        let dest = write_flattened(dest_dir, &file_name, &bytes)?;
        if is_binary {
            binary_path = Some(dest);
        }
    }

    binary_path.ok_or_else(|| anyhow::anyhow!("binary '{binary_name}' not found in zip archive"))
}

fn extract_binary_with_libs_from_tar_gz(
    data: impl std::io::Read,
    binary_name: &str,
    dest_dir: &Path,
) -> anyhow::Result<PathBuf> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    use tar::Archive;

    let gz = GzDecoder::new(data);
    let mut archive = Archive::new(gz);
    let mut binary_path = None;

    for entry in archive.entries().context("reading tar entries")? {
        let mut entry = entry.context("reading tar entry")?;
        let path = entry.path().context("getting entry path")?;
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name.to_string(),
            None => continue,
        };
        let is_binary = is_wanted_binary(&file_name, binary_name);
        if !(is_binary || is_shared_library(&file_name)) {
            continue;
        }
        // Symlink/hardlink entries (the `libfoo.dylib` -> `libfoo.N.dylib`
        // aliases) carry no data body; reading them yields 0 bytes and would
        // clobber the alias into an empty file, breaking the binary's @rpath
        // resolution at launch. Recreate them as links pointing at the target.
        let entry_type = entry.header().entry_type();
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            if let Some(link) = entry.link_name().context("reading tar link name")? {
                let target = link.to_string_lossy().into_owned();
                let dest = write_symlink_flattened(dest_dir, &file_name, &target)?;
                if is_binary {
                    binary_path = Some(dest);
                }
            }
            continue;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .context("reading tar entry bytes")?;
        let dest = write_flattened(dest_dir, &file_name, &bytes)?;
        if is_binary {
            binary_path = Some(dest);
        }
    }

    binary_path.ok_or_else(|| anyhow::anyhow!("binary '{binary_name}' not found in archive"))
}

#[cfg(test)]
#[path = "archive_flatten_tests.rs"]
mod tests;
