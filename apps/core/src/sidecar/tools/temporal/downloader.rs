//! Temporal CLI downloader — uses the official temporal.download CDN which
//! always serves the latest release, avoiding GitHub API calls.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    build_http_client, compute_sha256, extract_from_tar_gz, extract_from_zip, ryu_dir,
    ProgressCallback, VersionStore,
};

// ── Paths ──────────────────────────────────────────────────────────────────────

fn bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "temporal.exe"
    } else {
        "temporal"
    };
    ryu_dir().join("bin").join(name)
}

// ── CDN URL ────────────────────────────────────────────────────────────────────

/// Returns the temporal.download CDN URL for the current platform/arch.
/// The CDN resolves "latest" automatically — no GitHub API call needed.
fn archive_url() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    return "https://temporal.download/cli/archive/latest?platform=windows&arch=arm64";

    #[cfg(all(target_os = "windows", not(target_arch = "aarch64")))]
    return "https://temporal.download/cli/archive/latest?platform=windows&arch=amd64";

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "https://temporal.download/cli/archive/latest?platform=darwin&arch=arm64";

    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    return "https://temporal.download/cli/archive/latest?platform=darwin&arch=amd64";

    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    return "https://temporal.download/cli/archive/latest?platform=linux&arch=arm64";

    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    return "https://temporal.download/cli/archive/latest?platform=linux&arch=amd64";
}

// ── TemporalDownloader ─────────────────────────────────────────────────────────

pub struct TemporalDownloader {
    client: reqwest::Client,
    on_progress: Option<ProgressCallback>,
}

impl TemporalDownloader {
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

    /// Ensure the Temporal CLI binary is installed at `~/.ryu/bin/temporal`.
    ///
    /// The release archive downloads through the global [`DownloadCenter`] (#456)
    /// so it streams to disk and shows in the overlay; we then extract the binary
    /// from the downloaded archive and place it atomically.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<()> {
        let dest = bin_path();

        // Fast path: already installed with a matching checksum.
        let store = VersionStore::load();
        if dest.exists() {
            if let Some(stored) = store.installed_checksum("temporal") {
                let actual = compute_sha256(&dest).await?;
                if actual == stored {
                    tracing::info!("temporal already installed and checksum valid — skipping");
                    return Ok(());
                }
                tracing::warn!(
                    "temporal checksum mismatch (stored={stored} actual={actual}), re-downloading"
                );
            }
        }

        let url = archive_url();
        tracing::info!("downloading temporal CLI from {url}");

        // Download the archive through the center to a deterministic temp dest
        // (so its own `.part`/resume works), then read it back to extract.
        let archive_ext = if cfg!(target_os = "windows") {
            "zip"
        } else {
            "tar.gz"
        };
        let archive_dest = ryu_dir()
            .join("tmp")
            .join(format!("temporal-latest.{archive_ext}"));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Tool,
                label: "Temporal".to_string(),
                url: url.to_string(),
                dest: archive_dest,
                sha256: None,
                version_record: None,
            })
            .await
            .context("downloading temporal CLI archive")?;
        let archive_data = tokio::fs::read(&archive_path)
            .await
            .context("reading downloaded temporal CLI archive")?;

        // Extract binary from the archive (blocking I/O on a thread-pool thread).
        let binary_name = if cfg!(target_os = "windows") {
            "temporal.exe"
        } else {
            "temporal"
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

        // Compute checksum from in-memory bytes and query the binary for its version.
        let checksum = {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(&extracted);
            hex::encode(hasher.finalize())
        };
        let version = Self::query_version(&dest)
            .await
            .unwrap_or_else(|_| "latest".to_string());
        VersionStore::record_persisted("temporal", &version, &checksum)
            .context("writing versions.json")?;

        // The extracted binary is in place; drop the temp archive.
        let _ = tokio::fs::remove_file(&archive_path).await;

        // Ensure PATH includes ~/.ryu/bin
        if let Err(e) = crate::sidecar::path_manager::PathManager::add_to_path() {
            tracing::warn!("Failed to add ~/.ryu/bin to PATH: {}", e);
        }

        tracing::info!("temporal installed at {}", dest.display());
        Ok(())
    }

    /// Run `temporal --version` and extract the version string (e.g. "1.3.0").
    /// Output format: `temporal version 1.3.0 (server ...)`
    async fn query_version(binary: &std::path::Path) -> Result<String> {
        let output = tokio::process::Command::new(binary)
            .arg("--version")
            .output()
            .await
            .context("running temporal --version")?;
        let text = String::from_utf8_lossy(&output.stdout);
        // "temporal version 1.3.0 ..."  → take the third whitespace token
        let version = text
            .split_whitespace()
            .nth(2)
            .unwrap_or("latest")
            .trim_end_matches(|c: char| !c.is_alphanumeric() && c != '.')
            .to_string();
        Ok(version)
    }
}

impl Default for TemporalDownloader {
    fn default() -> Self {
        Self::new()
    }
}
