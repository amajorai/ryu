//! Generic sidecar download manager.
//!
//! Handles downloading, checksum verification, atomic installation, and version
//! tracking for all Ryu sidecar binaries (ZeroClaw, Temporal, llama.cpp,
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

/// Extract **every** file entry from a `.tar.gz` archive into `dest_dir`,
/// preserving the archive's internal directory structure. Returns the list of
/// written relative paths.
///
/// Used for multi-file model bundles (e.g. the parakeet ONNX model archive from
/// blob.handy.computer, which expands to a `parakeet-tdt-0.6b-v3-int8/` dir with
/// encoder/decoder/nemo128 `.onnx` files + `vocab.txt`). Entries are sanitized to
/// stay within `dest_dir` (no `..` traversal).
pub(crate) fn extract_tar_gz_to_dir(data: &[u8], dest_dir: &Path) -> anyhow::Result<Vec<String>> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    use tar::Archive;

    std::fs::create_dir_all(dest_dir)
        .with_context(|| format!("creating {}", dest_dir.display()))?;

    // Decompression-bomb guard: cap both the total bytes written and the number
    // of entries so a tiny gzip can't expand to fill the disk.
    const MAX_TOTAL_BYTES: u64 = 500 * 1024 * 1024;
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
        if total_bytes > MAX_TOTAL_BYTES {
            anyhow::bail!(
                "archive expands past the {MAX_TOTAL_BYTES}-byte cap (decompression bomb?)"
            );
        }
        std::fs::write(&out_path, &bytes)
            .with_context(|| format!("writing {}", out_path.display()))?;
        written.push(rel.to_string_lossy().into_owned());
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

pub struct TemporalManifest;

impl SidecarManifest for TemporalManifest {
    fn name(&self) -> &str {
        "temporal"
    }

    fn release_url(&self) -> String {
        let tag = self.target_version();
        let platform = platform_tag();
        format!(
            "https://github.com/temporalio/cli/releases/download/{tag}/temporal_cli_{platform}.tar.gz"
        )
    }

    fn binary_name(&self) -> &str {
        if cfg!(target_os = "windows") {
            "temporal.exe"
        } else {
            "temporal"
        }
    }

    fn target_version(&self) -> &str {
        "v1.1.2"
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

pub struct SpiderManifest;

impl SidecarManifest for SpiderManifest {
    fn name(&self) -> &str {
        "spider"
    }

    fn release_url(&self) -> String {
        // Spider is installed via cargo, not downloaded as a binary
        String::new()
    }

    fn binary_name(&self) -> &str {
        if cfg!(target_os = "windows") {
            "spider.exe"
        } else {
            "spider"
        }
    }

    fn target_version(&self) -> &str {
        "2.30.4"
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
                Arc::new(TemporalManifest),
                Arc::new(LlamaCppManifest),
                Arc::new(ScreenpipeManifest),
                Arc::new(SpiderManifest),
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
