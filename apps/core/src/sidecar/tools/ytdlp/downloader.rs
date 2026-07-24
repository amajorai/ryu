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
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes the tests that mutate this downloader's process-global env vars so
    /// they never race each other under cargo's in-process parallel runner.
    static YTDLP_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        YTDLP_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Snapshot + restore a var so a test that mutates process env never leaks.
    struct EnvGuard {
        key: &'static str,
        prev: Option<String>,
    }
    impl EnvGuard {
        fn set(key: &'static str, val: &str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::set_var(key, val);
            Self { key, prev }
        }
        fn clear(key: &'static str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, prev }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn artifact_name_is_a_single_file_binary() {
        // Whatever the target, the asset is a single executable, never an archive.
        let name = artifact_name();
        assert!(!name.is_empty());
        assert!(!name.ends_with(".zip") && !name.ends_with(".tar.gz"));
    }

    #[test]
    fn target_version_defaults_and_env_override() {
        let _lock = lock_env();
        let _g = EnvGuard::clear(YTDLP_VERSION_ENV);
        assert_eq!(target_version(), TARGET_VERSION);
        let _o = EnvGuard::set(YTDLP_VERSION_ENV, "  2025.01.01  ");
        // Trimmed.
        assert_eq!(target_version(), "2025.01.01");
    }

    #[test]
    fn target_version_ignores_blank_env() {
        let _lock = lock_env();
        let _g = EnvGuard::set(YTDLP_VERSION_ENV, "   ");
        // A whitespace-only override is treated as unset → the pinned default.
        assert_eq!(target_version(), TARGET_VERSION);
    }

    #[test]
    fn archive_url_builds_github_release_path() {
        let _lock = lock_env();
        let _u = EnvGuard::clear(YTDLP_URL_ENV);
        let _v = EnvGuard::set(YTDLP_VERSION_ENV, "2024.12.13");
        let url = archive_url();
        assert!(url.starts_with("https://github.com/yt-dlp/yt-dlp/releases/download/2024.12.13/"));
        assert!(url.ends_with(artifact_name()));
    }

    #[test]
    fn archive_url_env_fully_overrides() {
        let _lock = lock_env();
        let _u = EnvGuard::set(YTDLP_URL_ENV, "https://mirror.test/yt-dlp");
        assert_eq!(archive_url(), "https://mirror.test/yt-dlp");
    }

    #[test]
    fn archive_url_blank_env_falls_back_to_github() {
        let _lock = lock_env();
        let _u = EnvGuard::set(YTDLP_URL_ENV, "  ");
        let url = archive_url();
        assert!(url.contains("github.com/yt-dlp/yt-dlp/releases"));
    }
}
