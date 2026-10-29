//! Restate server downloader — fetches the official pre-built binary from
//! the Restate GitHub releases (restatedev/restate).

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    build_http_client, compute_sha256, download_to_memory, extract_from_tar_gz, extract_from_zip,
    retry_download, ProgressCallback, VersionStore,
};

/// Pinned Restate release version. Update here to upgrade the bundled release;
/// there is no runtime override, so every node installs the same tested build.
const RESTATE_VERSION: &str = "1.2.0";

// ── Paths ──────────────────────────────────────────────────────────────────────

pub fn bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "restate-server.exe"
    } else {
        "restate-server"
    };
    crate::paths::bin_dir().join(name)
}

// ── Release URL ────────────────────────────────────────────────────────────────

/// Returns the GitHub release download URL for the current platform/arch.
fn archive_url() -> String {
    let (platform, ext) = archive_platform();
    format!(
        "https://github.com/restatedev/restate/releases/download/v{RESTATE_VERSION}/{platform}.{ext}"
    )
}

/// Returns `(platform-arch-os, archive-extension)` for the current target.
fn archive_platform() -> (&'static str, &'static str) {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return ("restate-server.x86_64-pc-windows-msvc", "zip");

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return ("restate-server.aarch64-apple-darwin", "tar.gz");

    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    return ("restate-server.x86_64-apple-darwin", "tar.gz");

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return ("restate-server.aarch64-unknown-linux-musl", "tar.gz");

    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        target_os = "macos",
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    return ("restate-server.x86_64-unknown-linux-musl", "tar.gz");
}

// ── RestateDownloader ──────────────────────────────────────────────────────────

pub struct RestateDownloader {
    client: reqwest::Client,
    on_progress: Option<ProgressCallback>,
}

impl RestateDownloader {
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

    /// Ensure the Restate server binary is installed at `~/.ryu/bin/restate-server`.
    pub async fn ensure_installed(&self) -> Result<()> {
        let dest = bin_path();

        // Fast path: the target version is installed with a matching checksum.
        // The version term matters: the recorded checksum is the installed
        // binary's, so it alone would skip a bumped pin.
        let store = VersionStore::load();
        let recorded_is_target = store
            .versions
            .get("restate")
            .is_some_and(|version| version == RESTATE_VERSION);
        if dest.exists() && recorded_is_target {
            if let Some(stored) = store.installed_checksum("restate") {
                let actual = compute_sha256(&dest).await?;
                if actual == stored {
                    tracing::info!("restate already installed and checksum valid — skipping");
                    return Ok(());
                }
                tracing::warn!(
                    "restate checksum mismatch (stored={stored} actual={actual}), re-downloading"
                );
            }
        }

        let url = archive_url();
        tracing::info!("downloading restate server from {url}");

        // Download archive into memory with retry.
        let archive_data = retry_download("restate", 3, || {
            let client = self.client.clone();
            let on_progress = self.on_progress.clone();
            let url = url.clone();
            async move { download_to_memory(&client, &url, "restate", on_progress.as_ref()).await }
        })
        .await
        .context("downloading restate archive")?;

        // Extract binary from the archive (blocking I/O on a thread-pool thread).
        let binary_name = if cfg!(target_os = "windows") {
            "restate-server.exe"
        } else {
            "restate-server"
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
            .with_context(|| format!("rename {} -> {}", atomic_tmp.display(), dest.display()))?;

        // Set executable bit on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&dest)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dest, perms)?;
        }

        // Compute checksum from in-memory bytes and record version.
        let checksum = {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(&extracted);
            hex::encode(hasher.finalize())
        };
        VersionStore::record_persisted("restate", RESTATE_VERSION, &checksum)
            .context("writing versions.json")?;

        // Ensure PATH includes ~/.ryu/bin
        if let Err(e) = crate::sidecar::path_manager::PathManager::add_to_path() {
            tracing::warn!("Failed to add ~/.ryu/bin to PATH: {e}");
        }

        tracing::info!("restate installed at {}", dest.display());
        Ok(())
    }
}

impl Default for RestateDownloader {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bin_path_lands_in_ryu_bin() {
        let p = bin_path();
        assert!(p.ends_with(if cfg!(target_os = "windows") {
            "restate-server.exe"
        } else {
            "restate-server"
        }));
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "bin");
    }

    #[test]
    fn archive_platform_pairs_target_with_extension() {
        let (platform, ext) = archive_platform();
        assert!(platform.starts_with("restate-server."));
        // Windows ships a zip; every other target a tar.gz.
        if cfg!(target_os = "windows") {
            assert_eq!(ext, "zip");
        } else {
            assert_eq!(ext, "tar.gz");
        }
    }

    #[test]
    fn archive_url_uses_pinned_version() {
        let url = archive_url();
        assert!(url.starts_with("https://github.com/restatedev/restate/releases/download/v"));
        assert!(url.contains(RESTATE_VERSION));
        let (platform, ext) = archive_platform();
        assert!(url.ends_with(&format!("{platform}.{ext}")));
    }
}
