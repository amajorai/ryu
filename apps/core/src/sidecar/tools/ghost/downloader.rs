//! Ghost binary downloader — downloads pre-built binaries from GitHub releases.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    build_http_client, compute_sha256, extract_from_tar_gz, extract_from_zip, ryu_dir,
    ProgressCallback, VersionStore,
};

// ── Paths ──────────────────────────────────────────────────────────────────────

fn bin_path() -> PathBuf {
    super::ghost_bin_path()
}

// ── Release URL ────────────────────────────────────────────────────────────────

/// Env knob carrying the full per-platform Ghost release archive URL ("nothing
/// hardcoded"). There is no public Ghost release repo yet, so this is the only
/// way to point the downloader at a real artifact.
const GHOST_RELEASE_URL_ENV: &str = "RYU_GHOST_RELEASE_URL";

/// The platform/arch artifact filename, used in the actionable error so the
/// operator knows which archive `RYU_GHOST_RELEASE_URL` must point at.
fn artifact_name() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "ghost-windows-x64.zip";

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "ghost-macos-arm64.tar.gz";

    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    return "ghost-macos-x64.tar.gz";

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "ghost-linux-x64.tar.gz";

    #[cfg(not(any(
        target_os = "windows",
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", not(target_arch = "aarch64")),
        all(target_os = "linux", target_arch = "x86_64"),
    )))]
    return "ghost-<unsupported-platform>";
}

/// Resolve the release archive URL for this platform from
/// [`GHOST_RELEASE_URL_ENV`]. There is no public Ghost release repo configured,
/// so without the env override this fails with an actionable error rather than
/// pointing at a non-existent URL.
fn archive_url() -> Result<String> {
    if let Ok(url) = std::env::var(GHOST_RELEASE_URL_ENV) {
        let url = url.trim();
        if !url.is_empty() {
            return Ok(url.to_owned());
        }
    }
    anyhow::bail!(
        "no Ghost release source configured: set {GHOST_RELEASE_URL_ENV} to the URL of the \
         `{}` release archive (no public Ghost release repo exists yet), or build ghost from \
         source (apps/ghost)",
        artifact_name()
    )
}

// ── GhostDownloader ────────────────────────────────────────────────────────────

pub struct GhostDownloader {
    client: reqwest::Client,
    on_progress: Option<ProgressCallback>,
}

impl GhostDownloader {
    pub fn new() -> Self {
        Self {
            client: build_http_client(),
            on_progress: None,
        }
    }

    pub fn with_progress(mut self, cb: ProgressCallback) -> Self {
        self.on_progress = Some(cb);
        self
    }

    /// Ensure the Ghost binary is installed at `~/.ryu/bin/ghost`.
    ///
    /// The GitHub release archive downloads through the global
    /// [`DownloadCenter`] (#456) so it streams to disk and shows in the overlay;
    /// we then extract the binary from the downloaded archive and place it
    /// atomically.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<()> {
        let dest = bin_path();

        // Fast path: already installed with a matching checksum.
        let store = VersionStore::load();
        if dest.exists() {
            if let Some(stored) = store.installed_checksum("ghost") {
                let actual = compute_sha256(&dest).await?;
                if actual == stored {
                    tracing::info!("ghost already installed and checksum valid — skipping");
                    return Ok(());
                }
                tracing::warn!(
                    "ghost checksum mismatch (stored={stored} actual={actual}), re-downloading"
                );
            }
        }

        let url = archive_url().context("resolving the Ghost release archive URL")?;
        tracing::info!("downloading ghost binary from {url}");

        // Download the archive through the center to a deterministic temp dest
        // (so its own `.part`/resume works), then read it back to extract. The
        // archive extension matches the platform's release artifact.
        let archive_ext = if cfg!(target_os = "windows") {
            "zip"
        } else {
            "tar.gz"
        };
        let archive_dest = ryu_dir()
            .join("tmp")
            .join(format!("ghost-latest.{archive_ext}"));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Tool,
                label: "Ghost".to_string(),
                url: url.to_string(),
                dest: archive_dest,
                sha256: None,
                version_record: None,
            })
            .await
            .context("downloading ghost archive")?;
        let archive_data = tokio::fs::read(&archive_path)
            .await
            .context("reading downloaded ghost archive")?;

        // Extract binary from the archive (blocking I/O on a thread-pool thread).
        let binary_name = if cfg!(target_os = "windows") {
            "ghost.exe"
        } else {
            "ghost"
        };
        let extracted = tokio::task::spawn_blocking(move || {
            #[cfg(target_os = "windows")]
            {
                extract_from_zip(&archive_data, binary_name)
            }
            #[cfg(not(target_os = "windows"))]
            {
                extract_from_tar_gz(&archive_data, binary_name)
            }
        })
        .await
        .context("spawn_blocking for archive extraction")??;

        // Write extracted binary atomically.
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let atomic_tmp = dest.with_extension("tmp");
        tokio::fs::write(&atomic_tmp, &extracted)
            .await
            .with_context(|| format!("writing {}", atomic_tmp.display()))?;
        tokio::fs::rename(&atomic_tmp, &dest)
            .await
            .with_context(|| format!("rename {} → {}", atomic_tmp.display(), dest.display()))?;

        // Set executable bit on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&dest)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dest, perms)?;
        }

        // Compute checksum from in-memory bytes (avoids re-reading from disk).
        let checksum = {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(&extracted);
            hex::encode(hasher.finalize())
        };
        let version = "latest"; // TODO: Get actual version from binary
        VersionStore::record_persisted("ghost", version, &checksum)
            .context("writing versions.json")?;

        // The extracted binary is in place; drop the temp archive.
        let _ = tokio::fs::remove_file(&archive_path).await;

        // Ensure PATH includes ~/.ryu/bin
        if let Err(e) = crate::sidecar::path_manager::PathManager::add_to_path() {
            tracing::warn!("Failed to add ~/.ryu/bin to PATH: {}", e);
        }

        tracing::info!("ghost installed at {}", dest.display());
        Ok(())
    }
}

impl Default for GhostDownloader {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static GHOST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        GHOST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    struct EnvGuard {
        prev: Option<String>,
    }
    impl EnvGuard {
        fn set(val: &str) -> Self {
            let prev = std::env::var(GHOST_RELEASE_URL_ENV).ok();
            std::env::set_var(GHOST_RELEASE_URL_ENV, val);
            Self { prev }
        }
        fn clear() -> Self {
            let prev = std::env::var(GHOST_RELEASE_URL_ENV).ok();
            std::env::remove_var(GHOST_RELEASE_URL_ENV);
            Self { prev }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var(GHOST_RELEASE_URL_ENV, v),
                None => std::env::remove_var(GHOST_RELEASE_URL_ENV),
            }
        }
    }

    #[test]
    fn bin_path_is_the_shared_ghost_bin() {
        assert_eq!(bin_path(), super::super::ghost_bin_path());
    }

    #[test]
    fn artifact_name_names_a_release_archive() {
        // Each supported target names a platform archive (zip on Windows, tar.gz else),
        // used only in the actionable "set RYU_GHOST_RELEASE_URL" error.
        let name = artifact_name();
        assert!(name.starts_with("ghost-") || name.contains("unsupported"));
    }

    #[test]
    fn archive_url_errors_without_env_source() {
        // No public Ghost release repo exists, so the unset case must be an actionable
        // error, never a bogus URL.
        let _lock = lock_env();
        let _g = EnvGuard::clear();
        let err = archive_url().unwrap_err().to_string();
        assert!(err.contains(GHOST_RELEASE_URL_ENV), "got: {err}");
    }

    #[test]
    fn archive_url_uses_env_override_trimmed() {
        let _lock = lock_env();
        let _g = EnvGuard::set("  https://mirror.test/ghost.tar.gz  ");
        assert_eq!(archive_url().unwrap(), "https://mirror.test/ghost.tar.gz");
    }

    #[test]
    fn archive_url_blank_env_still_errors() {
        let _lock = lock_env();
        let _g = EnvGuard::set("   ");
        assert!(archive_url().is_err());
    }
}
