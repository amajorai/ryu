//! yt-dlp binary downloader — fetches the single-file release binary from the
//! yt-dlp GitHub releases through the modern [`DownloadCenter`] (#456).
//!
//! Mirrors Ghost's `ensure_installed` flow but drops the archive-extraction step:
//! a yt-dlp release asset IS the executable, so the center streams it straight to
//! `<dest>.part` and atomically renames it into place, recording `versions.json`
//! so the checksum fast-path skips re-downloads.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::downloads::{DownloadKind, DownloadSpec, VersionRecord};
use crate::sidecar::download_manager::{compute_sha256, VersionStore};
use crate::win_process::NoWindow;

/// Pinned default yt-dlp release. A date-based tag that exists on GitHub; update
/// here to move the bundled default, or override per-install with
/// `RYU_YTDLP_VERSION` / `RYU_YTDLP_URL` (nothing hardcoded).
const TARGET_VERSION: &str = "2024.12.13";

const YTDLP_VERSION_ENV: &str = "RYU_YTDLP_VERSION";
const YTDLP_URL_ENV: &str = "RYU_YTDLP_URL";

/// The version store key (also the `versions.json` entry name).
const STORE_KEY: &str = "ytdlp";

fn bin_path() -> PathBuf {
    super::ytdlp_bin_path()
}

/// The per-platform release asset filename.
fn artifact_name() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "yt-dlp.exe";

    #[cfg(target_os = "macos")]
    return "yt-dlp_macos";

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "yt-dlp";

    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        target_os = "macos",
        all(target_os = "linux", target_arch = "x86_64"),
    )))]
    return "yt-dlp";
}

/// Resolve the requested version (`RYU_YTDLP_VERSION` else the pinned default).
fn target_version() -> String {
    std::env::var(YTDLP_VERSION_ENV)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| TARGET_VERSION.to_owned())
}

/// Build the release download URL. `RYU_YTDLP_URL` fully overrides it; otherwise
/// it is `github.com/yt-dlp/yt-dlp/releases/download/<version>/<asset>`.
fn archive_url() -> String {
    if let Ok(url) = std::env::var(YTDLP_URL_ENV) {
        let url = url.trim();
        if !url.is_empty() {
            return url.to_owned();
        }
    }
    format!(
        "https://github.com/yt-dlp/yt-dlp/releases/download/{}/{}",
        target_version(),
        artifact_name()
    )
}

pub struct YtDlpDownloader;

impl YtDlpDownloader {
    pub fn new() -> Self {
        Self
    }

    /// Ensure the yt-dlp binary is installed at `~/.ryu/bin/yt-dlp[.exe]`.
    pub async fn ensure_installed(&self, downloads: &crate::downloads::DownloadCenter) -> Result<()> {
        let dest = bin_path();

        // Fast path: present with a matching recorded checksum.
        let store = VersionStore::load();
        if dest.exists() {
            if let Some(stored) = store.installed_checksum(STORE_KEY) {
                let actual = compute_sha256(&dest).await?;
                if actual == stored {
                    tracing::info!("yt-dlp already installed and checksum valid — skipping");
                    return Ok(());
                }
                tracing::warn!(
                    "yt-dlp checksum mismatch (stored={stored} actual={actual}), re-downloading"
                );
            }
        }

        let url = archive_url();
        let version = target_version();
        tracing::info!("downloading yt-dlp {version} from {url}");

        // Single-file binary: stream straight to `dest` (no archive extraction).
        // `version_record` MUST be set so the center records the checksum in
        // versions.json — otherwise the fast-path above never triggers again.
        downloads
            .download_blocking(DownloadSpec {
                kind: DownloadKind::Tool,
                label: "yt-dlp".to_string(),
                url,
                dest: dest.clone(),
                sha256: None,
                version_record: Some(VersionRecord {
                    store_key: STORE_KEY.to_string(),
                    version: version.clone(),
                }),
            })
            .await
            .context("downloading yt-dlp binary")?;

        // Make it executable on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&dest)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dest, perms)?;
        }

        // Ensure ~/.ryu/bin is on PATH (so a bare `yt-dlp` also resolves).
        if let Err(e) = crate::sidecar::path_manager::PathManager::add_to_path() {
            tracing::warn!("Failed to add ~/.ryu/bin to PATH: {e}");
        }

        // Best-effort: record the real reported version over the requested tag.
        if let Ok(out) = tokio::process::Command::new(&dest)
            .arg("--version")
            .no_window()
            .output()
            .await
        {
            let reported = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if out.status.success() && !reported.is_empty() {
                let _ = VersionStore::set_version_persisted(STORE_KEY, &reported);
            }
        }

        tracing::info!("yt-dlp installed at {}", dest.display());
        Ok(())
    }
}

impl Default for YtDlpDownloader {
    fn default() -> Self {
        Self::new()
    }
}
