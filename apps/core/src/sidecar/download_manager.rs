//! Generic sidecar download manager.
//!
//! Handles downloading, checksum verification, atomic installation, and version
//! tracking for all Ryu sidecar binaries (ZeroClaw, llama.cpp,
//! Screenpipe).
//!
//! Git and Rust toolchain are **build dependencies** for ZeroClaw (it is
//! compiled from source). They are not downloaded here but checked via
//! [`BuildDependency`] before any source-build is attempted.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use futures_util::StreamExt;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::win_process::NoWindow;

// ── Platform helpers ──────────────────────────────────────────────────────────

pub(crate) fn ryu_dir() -> PathBuf {
    crate::paths::ryu_dir()
}

pub(crate) fn bin_dir() -> PathBuf {
    ryu_dir().join("bin")
}

fn tmp_dir() -> PathBuf {
    ryu_dir().join("tmp")
}

fn versions_path() -> PathBuf {
    ryu_dir().join("versions.json")
}

// ── Shared download utilities ─────────────────────────────────────────────────

/// Build a shared `reqwest::Client` with the standard ryu user-agent.
pub(crate) fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("ryu-core/0.1")
        .build()
        .expect("reqwest client")
}

/// Retry `f` up to `max_attempts` times with exponential backoff.
/// `label` is used only in log messages (e.g. `"zeroclaw"`).
pub(crate) async fn retry_download<F, Fut, T>(
    label: &str,
    max_attempts: u32,
    mut f: F,
) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<T>>,
{
    let mut last_err = anyhow::anyhow!("no attempts made");
    for attempt in 1..=max_attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = e;
                if attempt < max_attempts {
                    let delay = std::time::Duration::from_secs(1u64 << (attempt - 1));
                    tracing::warn!(
                        "{label}: attempt {attempt}/{max_attempts} failed, retrying in {}s: {last_err:#}",
                        delay.as_secs()
                    );
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
    Err(last_err)
}

/// Issue a GET, attaching the Hugging Face access token for Hub hosts and
/// turning a gated `401`/`403` into an actionable error (token + license terms),
/// rather than a bare HTTP status. Non-HF hosts pass through unchanged.
async fn hf_aware_get(client: &reqwest::Client, url: &str) -> anyhow::Result<reqwest::Response> {
    let mut req = client.get(url);
    let is_hf = crate::hf_auth::is_hf_url(url);
    if is_hf {
        req = crate::hf_auth::authorize(req);
    }
    let response = req.send().await.with_context(|| format!("GET {url}"))?;
    let status = response.status();
    if is_hf
        && (status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN)
    {
        anyhow::bail!(
            "Hugging Face refused this download (HTTP {}). This model is gated — \
             set a Hugging Face access token in Settings → Integrations and accept \
             the model's terms on its Hugging Face page, then try again.",
            status.as_u16()
        );
    }
    response
        .error_for_status()
        .with_context(|| format!("HTTP error for {url}"))
}

/// Download `url` entirely into memory, emitting progress events tagged with `name`.
pub(crate) async fn download_to_memory(
    client: &reqwest::Client,
    url: &str,
    name: &str,
    on_progress: Option<&ProgressCallback>,
) -> anyhow::Result<Vec<u8>> {
    let response = hf_aware_get(client, url).await?;

    let total = response.content_length();
    let mut downloaded: u64 = 0;
    let mut data = Vec::with_capacity(total.unwrap_or(0) as usize);
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("stream error")?;
        data.extend_from_slice(&chunk);
        downloaded += chunk.len() as u64;

        if let Some(cb) = on_progress {
            cb(ProgressEvent {
                name: name.to_string(),
                total_bytes: total,
                downloaded_bytes: downloaded,
                done: false,
            });
        }
    }

    if let Some(cb) = on_progress {
        cb(ProgressEvent {
            name: name.to_string(),
            total_bytes: total,
            downloaded_bytes: downloaded,
            done: true,
        });
    }

    Ok(data)
}

/// Extract a named binary from a `.tar.gz` archive.
pub(crate) fn extract_from_tar_gz(data: &[u8], binary_name: &str) -> anyhow::Result<Vec<u8>> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    use tar::Archive;

    let gz = GzDecoder::new(data);
    let mut archive = Archive::new(gz);

    for entry in archive.entries().context("reading tar entries")? {
        let mut entry = entry.context("reading tar entry")?;
        let path = entry.path().context("getting entry path")?;
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        if file_name == binary_name {
            let mut bytes = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .context("reading entry bytes")?;
            return Ok(bytes);
        }
    }

    anyhow::bail!("binary '{binary_name}' not found in archive")
}

/// Default decompression-bomb cap for [`extract_tar_gz_to_dir`]: 500 MB of
/// expanded bytes. Appropriate for skill/tool tarballs; model-class archives
/// legitimately expand past this and must pass an explicit larger cap.
pub(crate) const DEFAULT_EXTRACT_CAP_BYTES: u64 = 500 * 1024 * 1024;

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
        if rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
            || rel.is_absolute()
        {
            tracing::warn!("skipping unsafe tar entry path: {}", rel.display());
            continue;
        }

        let out_path = dest_dir.join(&rel);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&out_path)
                .with_context(|| format!("creating dir {}", out_path.display()))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating dir {}", parent.display()))?;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .context("reading entry bytes")?;
        total_bytes += bytes.len() as u64;
        if total_bytes > max_total_bytes {
            anyhow::bail!(
                "archive expands past the {max_total_bytes}-byte cap (decompression bomb?)"
            );
        }
        std::fs::write(&out_path, &bytes)
            .with_context(|| format!("writing {}", out_path.display()))?;
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

        if rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
            || rel.is_absolute()
        {
            tracing::warn!("skipping unsafe tar entry path: {}", rel.display());
            continue;
        }

        let out_path = dest_dir.join(&rel);
        if entry.header().entry_type().is_dir() {
            std::fs::create_dir_all(&out_path)
                .with_context(|| format!("creating dir {}", out_path.display()))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating dir {}", parent.display()))?;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .context("reading entry bytes")?;
        total_bytes += bytes.len() as u64;
        if total_bytes > max_total_bytes {
            anyhow::bail!(
                "archive expands past the {max_total_bytes}-byte cap (decompression bomb?)"
            );
        }
        std::fs::write(&out_path, &bytes)
            .with_context(|| format!("writing {}", out_path.display()))?;
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
        let entry_name = file.name().to_string();
        if entry_name.ends_with('/') {
            let rel = std::path::Path::new(&entry_name);
            // Reject traversal AND absolute paths: an absolute directory entry
            // (`/abs/…/`) would make `dest_dir.join(rel)` replace the base and
            // `create_dir_all` outside the sandbox (`PathBuf::join` semantics).
            // Mirror the file branch below, which already guards both.
            if rel
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
                || rel.is_absolute()
            {
                continue;
            }
            std::fs::create_dir_all(dest_dir.join(rel))
                .with_context(|| format!("creating dir {}", entry_name))?;
            continue;
        }
        let rel = std::path::Path::new(&entry_name);
        if rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
            || rel.is_absolute()
        {
            tracing::warn!("skipping unsafe zip entry path: {entry_name}");
            continue;
        }
        let out_path = dest_dir.join(rel);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating dir {}", parent.display()))?;
        }
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .context("reading zip entry bytes")?;
        total_bytes += bytes.len() as u64;
        if total_bytes > max_total_bytes {
            anyhow::bail!(
                "archive expands past the {max_total_bytes}-byte cap (decompression bomb?)"
            );
        }
        std::fs::write(&out_path, &bytes)
            .with_context(|| format!("writing {}", out_path.display()))?;
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

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).context("reading zip entry")?;
        let name = file.name().to_string();
        if name.ends_with(binary_name) || name.ends_with(&format!("{binary_name}.exe")) {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .context("reading zip entry bytes")?;
            return Ok(bytes);
        }
    }

    anyhow::bail!("binary '{binary_name}' not found in zip archive")
}

/// Extract **every** file entry from a `.zip` archive into `dest_dir`, flattening
/// any directory prefix (e.g. `Release/whisper-server.exe` → `whisper-server.exe`).
/// Returns the list of written file names.
///
/// Unlike [`extract_from_zip`] (which pulls a single binary), this is for
/// multi-file release archives — e.g. whisper.cpp's Windows build, where the
/// server binary links against sibling DLLs that must land next to it.
pub(crate) fn extract_all_to_dir(data: &[u8], dest_dir: &Path) -> anyhow::Result<Vec<String>> {
    use std::io::{Cursor, Read};
    use zip::ZipArchive;

    std::fs::create_dir_all(dest_dir)
        .with_context(|| format!("creating {}", dest_dir.display()))?;

    let reader = Cursor::new(data);
    let mut archive = ZipArchive::new(reader).context("reading zip archive")?;
    let mut written = Vec::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).context("reading zip entry")?;
        let entry_name = file.name().to_string();
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

        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)
            .context("reading zip entry bytes")?;

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
pub(crate) fn extract_binary_with_libs(
    data: &[u8],
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
    data: &[u8],
    binary_name: &str,
    dest_dir: &Path,
) -> anyhow::Result<PathBuf> {
    use std::io::{Cursor, Read};
    use zip::ZipArchive;

    let reader = Cursor::new(data);
    let mut archive = ZipArchive::new(reader).context("reading zip archive")?;
    let mut binary_path = None;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).context("reading zip entry")?;
        let entry_name = file.name().to_string();
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
    data: &[u8],
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

/// Current OS + architecture tag used to select the right release asset.
#[cfg(target_os = "macos")]
pub(crate) fn platform_tag() -> &'static str {
    #[cfg(target_arch = "aarch64")]
    return "macos-arm64";
    #[cfg(not(target_arch = "aarch64"))]
    return "macos-x86_64";
}

#[cfg(target_os = "linux")]
pub(crate) fn platform_tag() -> &'static str {
    "linux-x86_64"
}

#[cfg(target_os = "windows")]
pub(crate) fn platform_tag() -> &'static str {
    "windows-x86_64"
}

// ── SidecarManifest trait ─────────────────────────────────────────────────────

/// Describes how to download and install one sidecar binary.
pub trait SidecarManifest: Send + Sync {
    /// Short identifier, e.g. `"zeroclaw"`.
    fn name(&self) -> &str;

    /// URL of the release archive or binary to download.
    fn release_url(&self) -> String;

    /// Name of the final binary file (without path).
    fn binary_name(&self) -> &str;

    /// Directory where the binary should be installed.
    fn install_dir(&self) -> PathBuf {
        bin_dir()
    }

    /// Full path to the installed binary.
    fn binary_path(&self) -> PathBuf {
        self.install_dir().join(self.binary_name())
    }

    /// Expected SHA-256 checksum (hex) for the downloaded asset, if known.
    /// `None` means verification is skipped (not recommended for production).
    fn expected_checksum(&self) -> Option<&str> {
        None
    }

    /// Version this manifest targets.
    fn target_version(&self) -> &str;
}

// ── Manifest implementations ──────────────────────────────────────────────────

pub struct ZeroClawManifest;

impl SidecarManifest for ZeroClawManifest {
    fn name(&self) -> &str {
        "zeroclaw"
    }

    fn release_url(&self) -> String {
        let tag = self.target_version();
        let platform = platform_tag();
        format!(
            "https://github.com/zeroclaw-labs/zeroclaw/releases/download/{tag}/zeroclaw-{platform}.tar.gz"
        )
    }

    fn binary_name(&self) -> &str {
        if cfg!(target_os = "windows") {
            "zeroclaw.exe"
        } else {
            "zeroclaw"
        }
    }

    fn target_version(&self) -> &str {
        "v0.1.0"
    }
}

pub struct LlamaCppManifest;

impl SidecarManifest for LlamaCppManifest {
    fn name(&self) -> &str {
        "llamacpp"
    }

    fn release_url(&self) -> String {
        let tag = self.target_version();
        let platform = platform_tag();
        format!(
            "https://github.com/ggml-org/llama.cpp/releases/download/{tag}/llama-{tag}-bin-{platform}.zip"
        )
    }

    fn binary_name(&self) -> &str {
        if cfg!(target_os = "windows") {
            "llama-server.exe"
        } else {
            "llama-server"
        }
    }

    fn target_version(&self) -> &str {
        // Keep in sync with `providers::llamacpp::downloader::TARGET_VERSION`
        // (the canonical install path). b9670 adds MTP speculative decoding.
        "b9670"
    }
}

pub struct ScreenpipeManifest;

impl SidecarManifest for ScreenpipeManifest {
    fn name(&self) -> &str {
        "screenpipe"
    }

    fn release_url(&self) -> String {
        let tag = self.target_version();
        let platform = platform_tag();
        format!(
            "https://github.com/mediar-ai/screenpipe/releases/download/{tag}/screenpipe-{platform}.tar.gz"
        )
    }

    fn binary_name(&self) -> &str {
        if cfg!(target_os = "windows") {
            "screenpipe.exe"
        } else {
            "screenpipe"
        }
    }

    fn target_version(&self) -> &str {
        "v0.1.0"
    }
}

// ── Build dependencies (git + rust) ──────────────────────────────────────────

/// A tool that must exist in PATH before ZeroClaw can be built from source.
pub trait BuildDependency: Send + Sync {
    fn name(&self) -> &str;
    /// Returns `Ok(version_string)` if found, `Err` with install guidance if not.
    fn check(&self) -> Result<String>;
    /// Human-readable install instructions for this platform.
    fn install_guide(&self) -> &str;
    /// Attempt to install the dependency automatically.
    fn install(&self) -> Result<()>;
}

pub struct GitDep;

impl BuildDependency for GitDep {
    fn name(&self) -> &str {
        "git"
    }

    fn check(&self) -> Result<String> {
        let out = std::process::Command::new("git")
            .arg("--version")
            .no_window()
            .output()
            .context("git not found in PATH")?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn install_guide(&self) -> &str {
        #[cfg(target_os = "windows")]
        return "Install Git from https://git-scm.com/download/win or run: winget install Git.Git";
        #[cfg(target_os = "macos")]
        return "Install Git via Homebrew: brew install git";
        #[cfg(target_os = "linux")]
        return "Install Git via your package manager: apt install git / dnf install git";
    }

    fn install(&self) -> Result<()> {
        #[cfg(target_os = "windows")]
        {
            let status = std::process::Command::new("winget")
                .args([
                    "install",
                    "--id",
                    "Git.Git",
                    "-e",
                    "--source",
                    "winget",
                    "--accept-source-agreements",
                    "--accept-package-agreements",
                ])
                .no_window()
                .status()
                .context("winget install failed")?;
            if !status.success() {
                anyhow::bail!(
                    "winget install git failed with exit code {:?}",
                    status.code()
                );
            }
            Ok(())
        }
        #[cfg(target_os = "macos")]
        {
            let status = std::process::Command::new("brew")
                .args(["install", "git"])
                .no_window()
                .status()
                .context("brew install failed")?;
            if !status.success() {
                anyhow::bail!("brew install git failed with exit code {:?}", status.code());
            }
            Ok(())
        }
        #[cfg(target_os = "linux")]
        {
            let status = std::process::Command::new("sh")
                .arg("-c")
                .arg("apt-get install -y git || dnf install -y git || yum install -y git")
                .no_window()
                .status()
                .context("package manager install failed")?;
            if !status.success() {
                anyhow::bail!(
                    "linux package manager install git failed with exit code {:?}",
                    status.code()
                );
            }
            Ok(())
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            anyhow::bail!("Git auto-install not supported on this platform");
        }
    }
}

pub struct RustDep;

impl BuildDependency for RustDep {
    fn name(&self) -> &str {
        "rust"
    }

    fn check(&self) -> Result<String> {
        let out = std::process::Command::new("cargo")
            .arg("--version")
            .no_window()
            .output()
            .context("cargo not found in PATH — is Rust installed?")?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn install_guide(&self) -> &str {
        "Install Rust via rustup: https://rustup.rs — run: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    }

    fn install(&self) -> Result<()> {
        #[cfg(target_os = "windows")]
        {
            let status = std::process::Command::new("powershell")
                .args([
                    "-Command",
                    "Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile \"$env:TEMP\\rustup-init.exe\"; & \"$env:TEMP\\rustup-init.exe\" -y --default-toolchain stable; Remove-Item \"$env:TEMP\\rustup-init.exe\""
                ])
                .no_window()
                .status()
                .context("powershell rustup install failed")?;
            if !status.success() {
                anyhow::bail!("rustup install failed with exit code {:?}", status.code());
            }
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            let status = std::process::Command::new("sh")
                .arg("-c")
                .arg("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable")
                .no_window()
                .status()
                .context("rustup install failed")?;
            if !status.success() {
                anyhow::bail!("rustup install failed with exit code {:?}", status.code());
            }
            Ok(())
        }
    }
}

// ── Version store ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VersionStore {
    #[serde(default)]
    pub versions: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub checksums: std::collections::HashMap<String, String>,
}

/// Process-wide lock guarding the read-modify-write cycle on `versions.json`.
///
/// Installs run concurrently (each `install_sidecar` request spawns a task), and
/// every downloader does `VersionStore::load()` → mutate → `save()`. Without this
/// lock two overlapping installs would each load the same snapshot and the last
/// `save()` would clobber the other engine's freshly written entry — meaning
/// installing a second local engine could drop the first from `versions.json`.
/// Serialize the whole cycle so multiple engines can be installed side by side.
static VERSIONS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

impl VersionStore {
    pub fn load() -> Self {
        let path = versions_path();
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<()> {
        let path = versions_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(&path, json)?;
        Ok(())
    }

    /// Atomically record one engine's version + checksum into `versions.json`.
    ///
    /// Reloads the latest on-disk store under [`VERSIONS_LOCK`], applies just this
    /// one key, and saves — so a concurrent install of another engine is never
    /// clobbered. Prefer this over `load()` → `record()` → `save()` in install paths.
    pub fn record_persisted(name: &str, version: &str, checksum: &str) -> Result<()> {
        let _guard = VERSIONS_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut store = Self::load();
        store.record(name, version, checksum);
        store.save()
    }

    /// Atomically set one engine's version (no checksum) in `versions.json`.
    ///
    /// Same concurrency guarantee as [`record_persisted`]; use for engines that
    /// only track a version string.
    pub fn set_version_persisted(name: &str, version: &str) -> Result<()> {
        let _guard = VERSIONS_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut store = Self::load();
        store.versions.insert(name.to_string(), version.to_string());
        store.save()
    }

    /// Atomically remove one engine's version + checksum from `versions.json`.
    ///
    /// Same lock as the install helpers, so uninstalling one engine never drops
    /// another engine being installed concurrently.
    pub fn remove_persisted(name: &str) -> Result<()> {
        let _guard = VERSIONS_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut store = Self::load();
        store.versions.remove(name);
        store.checksums.remove(name);
        store.save()
    }

    pub fn installed_version(&self, name: &str) -> Option<Version> {
        self.versions.get(name)?.parse().ok()
    }

    pub fn installed_checksum(&self, name: &str) -> Option<&str> {
        self.checksums.get(name).map(String::as_str)
    }

    pub fn record(&mut self, name: &str, version: &str, checksum: &str) {
        self.versions.insert(name.to_string(), version.to_string());
        self.checksums
            .insert(name.to_string(), checksum.to_string());
    }
}

#[cfg(test)]
mod version_store_tests {
    use super::*;

    /// Recording a second engine must not drop the first. This is the in-memory
    /// invariant the `*_persisted` helpers rely on to let multiple local engines
    /// (e.g. llama.cpp + ollama) coexist in versions.json.
    #[test]
    fn record_preserves_other_engines() {
        let mut store = VersionStore::default();
        store.record("llamacpp", "b8373", "aaa");
        store.record("ollama", "v0.5.0", "bbb");

        assert_eq!(store.versions.get("llamacpp"), Some(&"b8373".to_string()));
        assert_eq!(store.versions.get("ollama"), Some(&"v0.5.0".to_string()));
        assert_eq!(store.checksums.get("llamacpp"), Some(&"aaa".to_string()));
        assert_eq!(store.checksums.get("ollama"), Some(&"bbb".to_string()));
    }

    /// Setting a version (no checksum) must also leave sibling engines intact.
    #[test]
    fn insert_version_preserves_other_engines() {
        let mut store = VersionStore::default();
        store
            .versions
            .insert("llamacpp".to_string(), "b8373".to_string());
        store
            .versions
            .insert("ollama".to_string(), "v0.5.0".to_string());

        assert_eq!(store.versions.len(), 2);
        assert!(store.versions.contains_key("llamacpp"));
        assert!(store.versions.contains_key("ollama"));
    }

    /// Removing one engine leaves the others installed.
    #[test]
    fn remove_drops_only_named_engine() {
        let mut store = VersionStore::default();
        store.record("llamacpp", "b8373", "aaa");
        store.record("ollama", "v0.5.0", "bbb");

        store.versions.remove("ollama");
        store.checksums.remove("ollama");

        assert!(store.versions.contains_key("llamacpp"));
        assert!(!store.versions.contains_key("ollama"));
    }
}

// ── Progress reporting ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ProgressEvent {
    pub name: String,
    pub total_bytes: Option<u64>,
    pub downloaded_bytes: u64,
    pub done: bool,
}

pub type ProgressCallback = Arc<dyn Fn(ProgressEvent) + Send + Sync>;

// ── Download status ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadState {
    NotInstalled,
    Downloading,
    Verifying,
    Installed,
    Failed(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct SidecarDownloadStatus {
    pub name: String,
    pub state: DownloadState,
    pub installed_version: Option<String>,
    pub target_version: String,
}

// ── Core download logic ───────────────────────────────────────────────────────

pub(crate) async fn compute_sha256(path: &Path) -> Result<String> {
    let bytes = tokio::fs::read(path).await?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
}

async fn download_file(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    on_progress: Option<&ProgressCallback>,
    name: &str,
    pb: Option<&ProgressBar>,
) -> Result<String> {
    let response = hf_aware_get(client, url).await?;

    let total = response.content_length();

    if let Some(pb) = pb {
        if let Some(t) = total {
            pb.set_length(t);
        }
    }

    // Ensure tmp dir exists
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    let tmp_path = dest.with_extension("tmp");
    let mut file = tokio::fs::File::create(&tmp_path)
        .await
        .with_context(|| format!("creating {}", tmp_path.display()))?;

    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("stream error")?;
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;

        if let Some(pb) = pb {
            pb.set_position(downloaded);
        }
        if let Some(cb) = on_progress {
            cb(ProgressEvent {
                name: name.to_string(),
                total_bytes: total,
                downloaded_bytes: downloaded,
                done: false,
            });
        }
    }

    file.flush().await?;
    drop(file);

    let checksum = hex::encode(hasher.finalize());

    if let Some(pb) = pb {
        pb.finish_with_message(format!("{name} downloaded"));
    }
    if let Some(cb) = on_progress {
        cb(ProgressEvent {
            name: name.to_string(),
            total_bytes: total,
            downloaded_bytes: downloaded,
            done: true,
        });
    }

    // Atomic rename: tmp → final path
    tokio::fs::rename(&tmp_path, dest)
        .await
        .with_context(|| format!("rename {} → {}", tmp_path.display(), dest.display()))?;

    Ok(checksum)
}

// ── DownloadManager ───────────────────────────────────────────────────────────

pub struct DownloadManager {
    client: reqwest::Client,
    manifests: Vec<Arc<dyn SidecarManifest>>,
    build_deps: Vec<Arc<dyn BuildDependency>>,
    on_progress: Option<ProgressCallback>,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .build()
                .expect("reqwest client"),
            manifests: vec![
                Arc::new(ZeroClawManifest),
                Arc::new(LlamaCppManifest),
                Arc::new(ScreenpipeManifest),
            ],
            build_deps: vec![Arc::new(GitDep), Arc::new(RustDep)],
            on_progress: None,
        }
    }

    /// Attach a progress callback (e.g. to forward events to a UI via SSE).
    pub fn with_progress(mut self, cb: ProgressCallback) -> Self {
        self.on_progress = Some(cb);
        self
    }

    // ── Build dependency checks ───────────────────────────────────────────────

    /// Verify git and Rust are available for building ZeroClaw from source.
    /// Returns a list of errors (empty = all good).
    pub fn check_build_deps(&self) -> Vec<String> {
        self.build_deps
            .iter()
            .filter_map(|dep| match dep.check() {
                Ok(ver) => {
                    tracing::debug!("{} found: {ver}", dep.name());
                    None
                }
                Err(e) => {
                    let msg = format!("{} not found: {e}\n  → {}", dep.name(), dep.install_guide());
                    tracing::warn!("{msg}");
                    Some(msg)
                }
            })
            .collect()
    }

    /// Ensure all build dependencies are installed, auto-installing any missing ones.
    /// Returns a list of errors (empty = all good).
    pub fn ensure_build_deps(&self) -> Vec<String> {
        self.build_deps
            .iter()
            .filter_map(|dep| {
                // First check if already installed
                if let Ok(ver) = dep.check() {
                    tracing::debug!("{} found: {ver}", dep.name());
                    return None;
                }

                // Try to auto-install
                tracing::info!("{} not found, attempting auto-install...", dep.name());
                match dep.install() {
                    Ok(()) => {
                        // Re-check to confirm installation
                        match dep.check() {
                            Ok(ver) => {
                                tracing::info!("{} auto-installed successfully: {ver}", dep.name());
                                None
                            }
                            Err(e) => {
                                let msg = format!(
                                    "{} auto-install succeeded but check failed: {e}",
                                    dep.name()
                                );
                                tracing::error!("{msg}");
                                Some(msg)
                            }
                        }
                    }
                    Err(e) => {
                        let msg = format!(
                            "{} not found and auto-install failed: {e}\n  → {}",
                            dep.name(),
                            dep.install_guide()
                        );
                        tracing::error!("{msg}");
                        Some(msg)
                    }
                }
            })
            .collect()
    }

    // ── Status ────────────────────────────────────────────────────────────────

    pub fn status(&self) -> Vec<SidecarDownloadStatus> {
        let store = VersionStore::load();
        self.manifests
            .iter()
            .map(|m| {
                let installed_version = store.installed_version(m.name()).map(|v| v.to_string());
                let binary_exists = m.binary_path().exists();
                let state = if binary_exists && installed_version.is_some() {
                    DownloadState::Installed
                } else {
                    DownloadState::NotInstalled
                };
                SidecarDownloadStatus {
                    name: m.name().to_string(),
                    state,
                    installed_version,
                    target_version: m.target_version().to_string(),
                }
            })
            .collect()
    }

    // ── Verify ────────────────────────────────────────────────────────────────

    /// Check all binaries exist and their stored checksums match on-disk files.
    pub async fn verify_all(&self) -> Vec<(String, Result<()>)> {
        let store = VersionStore::load();
        let mut results = Vec::new();

        for m in &self.manifests {
            let name = m.name().to_string();
            let path = m.binary_path();

            let outcome = async {
                if !path.exists() {
                    anyhow::bail!("{} binary not found at {}", name, path.display());
                }
                if let Some(stored) = store.installed_checksum(&name) {
                    let actual = compute_sha256(&path).await?;
                    if actual != stored {
                        anyhow::bail!("{name} checksum mismatch: stored={stored} actual={actual}");
                    }
                }
                Ok(())
            }
            .await;

            results.push((name, outcome));
        }

        results
    }

    // ── Single download ───────────────────────────────────────────────────────

    /// Download a specific sidecar by name. Skips if already installed with
    /// a valid checksum.
    pub async fn download_one(&self, name: &str) -> Result<()> {
        let manifest = self
            .manifests
            .iter()
            .find(|m| m.name() == name)
            .with_context(|| format!("unknown sidecar: {name}"))?;

        self.download_manifest(manifest.as_ref(), None).await
    }

    // ── Parallel download all ─────────────────────────────────────────────────

    /// Download all sidecars in parallel. Skips those already installed.
    pub async fn download_all(&self) -> Vec<(String, Result<()>)> {
        let multi = MultiProgress::new();
        let style = ProgressStyle::with_template(
            "{spinner:.cyan} {msg:20} [{bar:40.cyan/blue}] {bytes}/{total_bytes}",
        )
        .unwrap_or_else(|_| ProgressStyle::default_bar())
        .progress_chars("=>-");

        let mut handles = tokio::task::JoinSet::new();

        for manifest in &self.manifests {
            let pb = multi.add(ProgressBar::new(0));
            pb.set_style(style.clone());
            pb.set_message(manifest.name().to_string());

            let client = self.client.clone();
            let on_progress = self.on_progress.clone();
            let name = manifest.name().to_string();
            let url = manifest.release_url();
            let binary_path = manifest.binary_path();
            let expected_checksum = manifest.expected_checksum().map(str::to_string);
            let target_version = manifest.target_version().to_string();
            let install_dir = manifest.install_dir();

            handles.spawn(async move {
                let result = run_download(
                    &client,
                    &name,
                    &url,
                    &binary_path,
                    &install_dir,
                    expected_checksum.as_deref(),
                    &target_version,
                    on_progress.as_ref(),
                    Some(&pb),
                )
                .await;
                (name, result)
            });
        }

        let mut results = Vec::new();
        while let Some(res) = handles.join_next().await {
            match res {
                Ok(pair) => results.push(pair),
                Err(e) => results.push(("unknown".to_string(), Err(e.into()))),
            }
        }

        // Add ~/.ryu/bin to PATH after successful downloads
        if results.iter().any(|(_, r)| r.is_ok()) {
            if let Err(e) = crate::sidecar::path_manager::PathManager::add_to_path() {
                tracing::warn!("Failed to add ~/.ryu/bin to PATH: {}", e);
            } else {
                tracing::info!("Added ~/.ryu/bin to PATH");
            }
        }

        results
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    async fn download_manifest(
        &self,
        manifest: &dyn SidecarManifest,
        pb: Option<&ProgressBar>,
    ) -> Result<()> {
        run_download(
            &self.client,
            manifest.name(),
            &manifest.release_url(),
            &manifest.binary_path(),
            &manifest.install_dir(),
            manifest.expected_checksum(),
            manifest.target_version(),
            self.on_progress.as_ref(),
            pb,
        )
        .await
    }
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::new()
    }
}

// ── Shared download + verify + record logic ───────────────────────────────────

#[allow(clippy::too_many_arguments)]
async fn run_download(
    client: &reqwest::Client,
    name: &str,
    url: &str,
    binary_path: &Path,
    install_dir: &Path,
    expected_checksum: Option<&str>,
    target_version: &str,
    on_progress: Option<&ProgressCallback>,
    pb: Option<&ProgressBar>,
) -> Result<()> {
    // Skip if already installed and checksum matches.
    let store = VersionStore::load();
    if binary_path.exists() {
        if let Some(stored) = store.installed_checksum(name) {
            let actual = compute_sha256(binary_path).await?;
            if actual == stored {
                tracing::info!("{name} already installed and checksum valid — skipping");
                if let Some(pb) = pb {
                    pb.finish_with_message(format!("{name} up-to-date"));
                }
                return Ok(());
            }
        }
    }

    tracing::info!("Downloading {name} from {url}");
    tokio::fs::create_dir_all(install_dir).await?;

    let tmp = install_dir.join(format!("{name}.tmp"));
    let actual_checksum = download_file(client, url, &tmp, on_progress, name, pb).await?;

    // Verify against expected checksum if provided.
    if let Some(expected) = expected_checksum {
        if actual_checksum != expected {
            // Remove the corrupt download.
            let _ = tokio::fs::remove_file(&binary_path).await;
            anyhow::bail!("{name} checksum mismatch: expected={expected} actual={actual_checksum}");
        }
    }

    // Make executable on Unix.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(binary_path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(binary_path, perms)?;
    }

    // Persist version + checksum atomically (concurrency-safe; never clobbers a
    // sibling engine installed in parallel).
    VersionStore::record_persisted(name, target_version, &actual_checksum)
        .with_context(|| "writing versions.json")?;

    tracing::info!(
        "{name} installed at {} ({})",
        binary_path.display(),
        target_version
    );
    Ok(())
}

#[cfg(test)]
mod download_tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    // ── Archive builders (in-memory, hermetic) ──────────────────────────────

    /// Append one file entry, writing the name field directly so the write-side
    /// `..`/absolute-path rejection is bypassed — this reproduces a *malicious*
    /// archive exactly as it would arrive over the wire, which is the input the
    /// extractor's traversal guards must defend against.
    fn append_entry<W: Write>(builder: &mut tar::Builder<W>, name: &str, data: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        if let Some(gnu) = header.as_gnu_mut() {
            let bytes = name.as_bytes();
            let n = bytes.len().min(gnu.name.len());
            gnu.name[..n].copy_from_slice(&bytes[..n]);
        }
        header.set_cksum();
        builder.append(&header, data).expect("append tar entry");
    }

    /// Build a `.tar.gz` from `(path, bytes)` file entries.
    fn make_tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let gz = GzEncoder::new(Vec::new(), Compression::fast());
        let mut builder = tar::Builder::new(gz);
        for (name, data) in entries {
            append_entry(&mut builder, name, data);
        }
        let gz = builder.into_inner().expect("finish tar");
        gz.finish().expect("finish gz")
    }

    /// Build a `.tar.bz2` from `(path, bytes)` file entries.
    fn make_tar_bz2(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use bzip2::write::BzEncoder;
        use bzip2::Compression as BzCompression;
        let bz = BzEncoder::new(Vec::new(), BzCompression::fast());
        let mut builder = tar::Builder::new(bz);
        for (name, data) in entries {
            append_entry(&mut builder, name, data);
        }
        let bz = builder.into_inner().expect("finish tar");
        bz.finish().expect("finish bz2")
    }

    /// Build a `.zip`. `dir_entries` become directory records (name ends `/`),
    /// `file_entries` become file records. Names are written verbatim so tests
    /// can inject unsafe paths.
    fn make_zip(dir_entries: &[&str], file_entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Cursor;
        use zip::write::FileOptions;
        use zip::ZipWriter;
        let mut zw = ZipWriter::new(Cursor::new(Vec::new()));
        let opts = FileOptions::default();
        for name in dir_entries {
            // `start_file` with a trailing-slash name writes a directory-shaped
            // record while preserving the raw name (unlike `add_directory`,
            // which normalizes). This lets us inject absolute/`..` dir entries.
            zw.start_file(*name, opts).expect("start dir entry");
        }
        for (name, data) in file_entries {
            zw.start_file(*name, opts).expect("start file entry");
            zw.write_all(data).expect("write file bytes");
        }
        zw.finish().expect("finish zip").into_inner()
    }

    // ── extract_from_tar_gz / extract_from_zip (single binary) ──────────────

    #[test]
    fn extract_from_tar_gz_finds_named_binary() {
        let data = make_tar_gz(&[("junk", b"x"), ("mybin", b"ELF-payload")]);
        let out = extract_from_tar_gz(&data, "mybin").unwrap();
        assert_eq!(out, b"ELF-payload");
    }

    #[test]
    fn extract_from_tar_gz_missing_binary_errors() {
        let data = make_tar_gz(&[("other", b"x")]);
        let err = extract_from_tar_gz(&data, "mybin").unwrap_err();
        assert!(err.to_string().contains("mybin"));
    }

    #[test]
    fn extract_from_zip_matches_exe_suffix() {
        // The zip extractor accepts either the bare name or `<name>.exe`.
        let data = make_zip(&[], &[("dir/mybin.exe", b"win-payload")]);
        let out = extract_from_zip(&data, "mybin").unwrap();
        assert_eq!(out, b"win-payload");
    }

    #[test]
    fn extract_from_zip_missing_binary_errors() {
        let data = make_zip(&[], &[("readme.txt", b"hi")]);
        let err = extract_from_zip(&data, "mybin").unwrap_err();
        assert!(err.to_string().contains("mybin"));
    }

    // ── extract_tar_gz_to_dir ───────────────────────────────────────────────

    #[test]
    fn tar_gz_to_dir_preserves_structure() {
        let data = make_tar_gz(&[("a.txt", b"aaa"), ("sub/b.txt", b"bbb")]);
        let tmp = tempfile::tempdir().unwrap();
        let written = extract_tar_gz_to_dir(&data, tmp.path(), None).unwrap();
        assert_eq!(written.len(), 2);
        assert_eq!(std::fs::read(tmp.path().join("a.txt")).unwrap(), b"aaa");
        assert_eq!(
            std::fs::read(tmp.path().join("sub").join("b.txt")).unwrap(),
            b"bbb"
        );
    }

    #[test]
    fn tar_gz_to_dir_rejects_parent_traversal() {
        let data = make_tar_gz(&[("../evil.txt", b"pwn"), ("safe.txt", b"ok")]);
        let tmp = tempfile::tempdir().unwrap();
        let written = extract_tar_gz_to_dir(&data, tmp.path(), None).unwrap();
        // The `..` entry is skipped; only the safe file lands.
        assert_eq!(written, vec!["safe.txt".to_string()]);
        // Nothing escaped into the tempdir's parent.
        let escaped = tmp.path().parent().unwrap().join("evil.txt");
        assert!(!escaped.exists(), "traversal entry escaped the sandbox");
    }

    #[test]
    fn tar_gz_to_dir_enforces_decompression_cap() {
        // Two 100-byte files with a 150-byte cap → the second trips the guard.
        let data = make_tar_gz(&[("a.bin", &[0u8; 100]), ("b.bin", &[0u8; 100])]);
        let tmp = tempfile::tempdir().unwrap();
        let err = extract_tar_gz_to_dir(&data, tmp.path(), Some(150)).unwrap_err();
        assert!(err.to_string().contains("cap"));
    }

    // ── extract_tar_bz2_to_dir ──────────────────────────────────────────────

    #[test]
    fn tar_bz2_to_dir_extracts_and_guards() {
        let data = make_tar_bz2(&[("f.txt", b"payload"), ("../nope.txt", b"pwn")]);
        let tmp = tempfile::tempdir().unwrap();
        let written = extract_tar_bz2_to_dir(&data, tmp.path(), None).unwrap();
        assert_eq!(written, vec!["f.txt".to_string()]);
        assert_eq!(std::fs::read(tmp.path().join("f.txt")).unwrap(), b"payload");
    }

    #[test]
    fn tar_bz2_to_dir_enforces_cap() {
        let data = make_tar_bz2(&[("big.bin", &[7u8; 400])]);
        let tmp = tempfile::tempdir().unwrap();
        let err = extract_tar_bz2_to_dir(&data, tmp.path(), Some(100)).unwrap_err();
        assert!(err.to_string().contains("cap"));
    }

    // ── extract_zip_to_dir ──────────────────────────────────────────────────

    #[test]
    fn zip_to_dir_extracts_files_and_dirs() {
        let data = make_zip(&["sub/"], &[("sub/x.txt", b"hello"), ("root.txt", b"r")]);
        let tmp = tempfile::tempdir().unwrap();
        let written = extract_zip_to_dir(&data, tmp.path(), None).unwrap();
        assert!(written.iter().any(|w| w == "sub/x.txt"));
        assert_eq!(
            std::fs::read(tmp.path().join("sub").join("x.txt")).unwrap(),
            b"hello"
        );
    }

    #[test]
    fn zip_to_dir_rejects_parent_traversal_file() {
        let data = make_zip(&[], &[("../evil.txt", b"pwn"), ("ok.txt", b"ok")]);
        let tmp = tempfile::tempdir().unwrap();
        let written = extract_zip_to_dir(&data, tmp.path(), None).unwrap();
        assert_eq!(written, vec!["ok.txt".to_string()]);
        assert!(!tmp.path().parent().unwrap().join("evil.txt").exists());
    }

    #[test]
    fn zip_to_dir_enforces_cap() {
        let data = make_zip(&[], &[("a", &[0u8; 100]), ("b", &[0u8; 100])]);
        let tmp = tempfile::tempdir().unwrap();
        let err = extract_zip_to_dir(&data, tmp.path(), Some(150)).unwrap_err();
        assert!(err.to_string().contains("cap"));
    }

    /// Regression for the zip directory-entry sandbox escape: an **absolute**
    /// directory record (`/…/escape/`) must be rejected, not `create_dir_all`'d
    /// outside `dest_dir`. `PathBuf::join` replaces the base on an absolute
    /// component, so without an `is_absolute()` guard the dir is created outside
    /// the sandbox. The file branch already guarded this; the dir branch did not.
    #[cfg(unix)]
    #[test]
    fn zip_to_dir_rejects_absolute_directory_entry() {
        let escape_root = tempfile::tempdir().unwrap();
        let escape_dir = escape_root.path().join("escape");
        // A trailing-slash absolute name → treated as a directory entry.
        let entry = format!("{}/", escape_dir.display());
        let data = make_zip(&[&entry], &[("safe.txt", b"ok")]);

        let dest = tempfile::tempdir().unwrap();
        let written = extract_zip_to_dir(&data, dest.path(), None).unwrap();

        assert!(
            !escape_dir.exists(),
            "absolute zip directory entry escaped the sandbox and was created at {}",
            escape_dir.display()
        );
        assert!(written.iter().any(|w| w == "safe.txt"));
    }

    // ── extract_all_to_dir (flatten) ────────────────────────────────────────

    #[test]
    fn extract_all_flattens_and_skips_dirs() {
        let data = make_zip(
            &["Release/"],
            &[
                ("Release/whisper-server.exe", b"bin"),
                ("Release/ggml.dll", b"lib"),
            ],
        );
        let tmp = tempfile::tempdir().unwrap();
        let mut written = extract_all_to_dir(&data, tmp.path()).unwrap();
        written.sort();
        assert_eq!(written, vec!["ggml.dll", "whisper-server.exe"]);
        // Flattened: the `Release/` prefix is gone.
        assert!(tmp.path().join("whisper-server.exe").exists());
        assert!(!tmp.path().join("Release").exists());
    }

    // ── extract_binary_with_libs (tar.gz path) ──────────────────────────────

    #[test]
    fn binary_with_libs_colocates_shared_libs() {
        let data = make_tar_gz(&[
            ("build/bin/llama-server", b"server"),
            ("build/bin/libggml.dylib", b"lib1"),
            ("build/bin/libllama.so", b"lib2"),
            ("build/bin/other-tool", b"ignored"),
        ]);
        let tmp = tempfile::tempdir().unwrap();
        let bin = extract_binary_with_libs(&data, "llama-server", tmp.path(), false).unwrap();
        assert_eq!(bin, tmp.path().join("llama-server"));
        assert!(tmp.path().join("libggml.dylib").exists());
        assert!(tmp.path().join("libllama.so").exists());
        // Non-lib sibling tools are not co-located.
        assert!(!tmp.path().join("other-tool").exists());
    }

    #[test]
    fn binary_with_libs_missing_binary_errors() {
        let data = make_tar_gz(&[("build/libggml.dylib", b"lib")]);
        let tmp = tempfile::tempdir().unwrap();
        let err =
            extract_binary_with_libs(&data, "llama-server", tmp.path(), false).unwrap_err();
        assert!(err.to_string().contains("llama-server"));
    }

    #[test]
    fn binary_with_libs_zip_path() {
        let data = make_zip(
            &[],
            &[
                ("bin/llama-server.exe", b"server"),
                ("bin/ggml.dll", b"lib"),
            ],
        );
        let tmp = tempfile::tempdir().unwrap();
        let bin = extract_binary_with_libs(&data, "llama-server", tmp.path(), true).unwrap();
        assert_eq!(bin, tmp.path().join("llama-server.exe"));
        assert!(tmp.path().join("ggml.dll").exists());
    }

    /// A symlink alias entry (`libfoo.dylib` -> `libfoo.1.dylib`) must be
    /// recreated as a link, not written as a 0-byte file that shadows the real
    /// versioned lib and breaks `@rpath` resolution at launch.
    #[cfg(unix)]
    #[test]
    fn binary_with_libs_recreates_symlink_alias() {
        // Build a tar with the real versioned lib, a symlink alias, and the bin.
        let gz = GzEncoder::new(Vec::new(), Compression::fast());
        let mut builder = tar::Builder::new(gz);

        let bin = b"server";
        let mut h = tar::Header::new_gnu();
        h.set_size(bin.len() as u64);
        h.set_mode(0o755);
        h.set_cksum();
        builder
            .append_data(&mut h, "bin/llama-server", &bin[..])
            .unwrap();

        let lib = b"real-lib-bytes";
        let mut h = tar::Header::new_gnu();
        h.set_size(lib.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        builder
            .append_data(&mut h, "bin/libggml.1.dylib", &lib[..])
            .unwrap();

        // Symlink entry: libggml.dylib -> libggml.1.dylib (no data body).
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Symlink);
        h.set_size(0);
        h.set_link_name("libggml.1.dylib").unwrap();
        h.set_mode(0o777);
        h.set_cksum();
        builder
            .append_link(&mut h, "bin/libggml.dylib", "libggml.1.dylib")
            .unwrap();

        let data = builder.into_inner().unwrap().finish().unwrap();

        let tmp = tempfile::tempdir().unwrap();
        extract_binary_with_libs(&data, "llama-server", tmp.path(), false).unwrap();

        let alias = tmp.path().join("libggml.dylib");
        let meta = std::fs::symlink_metadata(&alias).unwrap();
        assert!(
            meta.file_type().is_symlink(),
            "alias must be a symlink, not a clobbered 0-byte file"
        );
        // The real versioned lib is present and non-empty.
        assert_eq!(
            std::fs::read(tmp.path().join("libggml.1.dylib")).unwrap(),
            lib
        );
    }

    // ── Pure helpers ────────────────────────────────────────────────────────

    #[test]
    fn archive_basename_handles_both_separators() {
        assert_eq!(archive_basename("a/b/c.txt"), "c.txt");
        assert_eq!(archive_basename("a\\b\\c.txt"), "c.txt");
        assert_eq!(archive_basename("bare"), "bare");
    }

    #[test]
    fn is_wanted_binary_matches_bare_and_exe() {
        assert!(is_wanted_binary("llama-server", "llama-server"));
        assert!(is_wanted_binary("llama-server.exe", "llama-server"));
        assert!(!is_wanted_binary("llama-serverX", "llama-server"));
        assert!(!is_wanted_binary("libllama.so", "llama-server"));
    }

    #[test]
    fn is_shared_library_recognizes_all_forms() {
        assert!(is_shared_library("libfoo.dylib"));
        assert!(is_shared_library("foo.DLL")); // case-insensitive
        assert!(is_shared_library("libbar.so"));
        assert!(is_shared_library("libbar.so.3")); // versioned soname
        assert!(!is_shared_library("llama-server"));
        assert!(!is_shared_library("notes.txt"));
    }

    #[test]
    fn write_flattened_writes_via_temp_rename() {
        let tmp = tempfile::tempdir().unwrap();
        let dest = write_flattened(tmp.path(), "out.bin", b"data").unwrap();
        assert_eq!(dest, tmp.path().join("out.bin"));
        assert_eq!(std::fs::read(&dest).unwrap(), b"data");
        // The temp sidecar file is cleaned up by the atomic rename.
        assert!(!tmp.path().join("out.download-tmp").exists());
    }

    #[cfg(unix)]
    #[test]
    fn write_symlink_flattened_creates_link_to_basename() {
        let tmp = tempfile::tempdir().unwrap();
        // Target given with a path prefix — must be flattened to a bare basename.
        let dest = write_symlink_flattened(tmp.path(), "libfoo.dylib", "sub/libfoo.1.dylib").unwrap();
        let meta = std::fs::symlink_metadata(&dest).unwrap();
        assert!(meta.file_type().is_symlink());
        assert_eq!(
            std::fs::read_link(&dest).unwrap(),
            std::path::PathBuf::from("libfoo.1.dylib")
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_symlink_flattened_replaces_stale_entry() {
        let tmp = tempfile::tempdir().unwrap();
        // A pre-existing broken 0-byte file at the alias name.
        std::fs::write(tmp.path().join("libfoo.dylib"), b"").unwrap();
        let dest = write_symlink_flattened(tmp.path(), "libfoo.dylib", "libfoo.1.dylib").unwrap();
        assert!(std::fs::symlink_metadata(&dest)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn platform_tag_is_known() {
        let t = platform_tag();
        assert!(
            ["macos-arm64", "macos-x86_64", "linux-x86_64", "windows-x86_64"].contains(&t),
            "unexpected platform tag: {t}"
        );
    }

    // ── SidecarManifest metadata ────────────────────────────────────────────

    #[test]
    fn zeroclaw_manifest_url_embeds_version_and_platform() {
        let m = ZeroClawManifest;
        assert_eq!(m.name(), "zeroclaw");
        assert_eq!(m.target_version(), "v0.1.0");
        let url = m.release_url();
        assert!(url.contains("v0.1.0"));
        assert!(url.contains(platform_tag()));
        assert!(url.ends_with(".tar.gz"));
    }

    #[test]
    fn llamacpp_manifest_metadata() {
        let m = LlamaCppManifest;
        assert_eq!(m.name(), "llamacpp");
        assert_eq!(m.target_version(), "b9670");
        let url = m.release_url();
        assert!(url.contains("b9670"));
        assert!(url.ends_with(".zip"));
        // binary_name is OS-conditional; both accepted forms end in the stem.
        assert!(m.binary_name().starts_with("llama-server"));
    }

    #[test]
    fn manifest_binary_path_joins_install_dir() {
        let m = ScreenpipeManifest;
        let p = m.binary_path();
        assert!(p.ends_with(m.binary_name()));
        // Default install dir is `<ryu>/bin`.
        assert!(p.parent().unwrap().ends_with("bin"));
    }

    #[test]
    fn expected_checksum_defaults_to_none() {
        assert!(ZeroClawManifest.expected_checksum().is_none());
    }

    // ── VersionStore (in-memory, no fs) ─────────────────────────────────────

    #[test]
    fn version_store_serde_round_trips() {
        let mut store = VersionStore::default();
        store.record("llamacpp", "b9670", "deadbeef");
        let json = serde_json::to_string(&store).unwrap();
        let back: VersionStore = serde_json::from_str(&json).unwrap();
        assert_eq!(back.versions.get("llamacpp"), Some(&"b9670".to_string()));
        assert_eq!(back.installed_checksum("llamacpp"), Some("deadbeef"));
    }

    #[test]
    fn installed_version_parses_semver_only() {
        let mut store = VersionStore::default();
        store.record("ollama", "0.5.1", "x");
        store.record("llamacpp", "b9670", "y"); // not semver
        assert_eq!(
            store.installed_version("ollama"),
            Some(semver::Version::new(0, 5, 1))
        );
        // Non-semver engine version strings yield None (still "installed" by key).
        assert!(store.installed_version("llamacpp").is_none());
        assert!(store.installed_version("absent").is_none());
    }

    #[test]
    fn record_overwrites_existing_entry() {
        let mut store = VersionStore::default();
        store.record("ollama", "0.5.0", "old");
        store.record("ollama", "0.6.0", "new");
        assert_eq!(store.versions.get("ollama"), Some(&"0.6.0".to_string()));
        assert_eq!(store.installed_checksum("ollama"), Some("new"));
    }

    #[test]
    fn version_store_load_defaults_on_bad_json() {
        // `from_str` failure path: garbage deserializes to the default store.
        let parsed: Option<VersionStore> = serde_json::from_str("{ not json").ok();
        assert!(parsed.is_none());
        assert!(VersionStore::default().versions.is_empty());
    }

    // ── compute_sha256 ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn compute_sha256_matches_known_vector() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("f");
        // SHA-256 of "abc".
        std::fs::write(&path, b"abc").unwrap();
        let got = compute_sha256(&path).await.unwrap();
        assert_eq!(
            got,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[tokio::test]
    async fn compute_sha256_missing_file_errors() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(compute_sha256(&tmp.path().join("nope")).await.is_err());
    }

    // ── retry_download ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn retry_download_succeeds_first_try() {
        let calls = std::sync::atomic::AtomicU32::new(0);
        let out: i32 = retry_download("t", 3, || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Ok(42) }
        })
        .await
        .unwrap();
        assert_eq!(out, 42);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retry_download_single_attempt_no_retry() {
        let calls = std::sync::atomic::AtomicU32::new(0);
        let res: anyhow::Result<i32> = retry_download("t", 1, || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { anyhow::bail!("boom") }
        })
        .await;
        assert!(res.is_err());
        // max_attempts=1 → exactly one call, no backoff sleep.
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn retry_download_retries_then_succeeds() {
        // One transient failure then success. `max_attempts=2` means a single
        // 1s backoff between the two calls (test-util virtual time is not enabled
        // in this crate, so this is a real — but bounded to one — 1s wait).
        let calls = std::sync::atomic::AtomicU32::new(0);
        let out: i32 = retry_download("t", 2, || {
            let n = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                if n < 1 {
                    anyhow::bail!("transient")
                } else {
                    Ok(7)
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(out, 7);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    // ── DownloadState / status serialization ────────────────────────────────

    #[test]
    fn download_state_serializes_snake_case() {
        assert_eq!(
            serde_json::to_value(DownloadState::NotInstalled).unwrap(),
            serde_json::json!("not_installed")
        );
        assert_eq!(
            serde_json::to_value(DownloadState::Installed).unwrap(),
            serde_json::json!("installed")
        );
        // The Failed variant carries its message as a single-field object.
        assert_eq!(
            serde_json::to_value(DownloadState::Failed("nope".into())).unwrap(),
            serde_json::json!({ "failed": "nope" })
        );
    }

    #[test]
    fn sidecar_download_status_serializes() {
        let s = SidecarDownloadStatus {
            name: "llamacpp".into(),
            state: DownloadState::Installed,
            installed_version: Some("b9670".into()),
            target_version: "b9670".into(),
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["name"], "llamacpp");
        assert_eq!(v["state"], "installed");
        assert_eq!(v["installed_version"], "b9670");
    }

    #[test]
    fn default_extract_cap_is_500mb() {
        assert_eq!(DEFAULT_EXTRACT_CAP_BYTES, 500 * 1024 * 1024);
    }

    // ── BuildDependency (pure surface only — never call install()) ───────────

    #[test]
    fn build_dependency_names_and_guides() {
        assert_eq!(GitDep.name(), "git");
        assert_eq!(RustDep.name(), "rust");
        assert!(!GitDep.install_guide().is_empty());
        assert!(RustDep.install_guide().to_lowercase().contains("rustup"));
    }
}
