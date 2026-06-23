//! Shadow binary downloader — downloads pre-built binaries from GitHub releases.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    build_http_client, compute_sha256, extract_from_tar_gz, extract_from_zip, ryu_dir,
    ProgressCallback, VersionStore,
};

// ── Paths ──────────────────────────────────────────────────────────────────────

fn bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "shadow.exe"
    } else {
        "shadow"
    };
    ryu_dir().join("bin").join(name)
}

// ── Release URL ────────────────────────────────────────────────────────────────

/// Env knob carrying the full per-platform Shadow release archive URL ("nothing
/// hardcoded"). There is no public Shadow release repo yet, so this is the only
/// way to point the downloader at a real artifact.
const SHADOW_RELEASE_URL_ENV: &str = "RYU_SHADOW_RELEASE_URL";

/// The platform/arch artifact filename, used in the actionable error so the
/// operator knows which archive `RYU_SHADOW_RELEASE_URL` must point at.
fn artifact_name() -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "shadow-windows-x64.zip";

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "shadow-macos-arm64.tar.gz";

    #[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
    return "shadow-macos-x64.tar.gz";

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "shadow-linux-x64.tar.gz";

    #[cfg(not(any(
        target_os = "windows",
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", not(target_arch = "aarch64")),
        all(target_os = "linux", target_arch = "x86_64"),
    )))]
    return "shadow-<unsupported-platform>";
}

/// Resolve the release archive URL for this platform from
/// [`SHADOW_RELEASE_URL_ENV`]. There is no public Shadow release repo
/// configured, so without the env override this fails with an actionable error
/// rather than pointing at a non-existent URL.
fn archive_url() -> Result<String> {
    if let Ok(url) = std::env::var(SHADOW_RELEASE_URL_ENV) {
        let url = url.trim();
        if !url.is_empty() {
            return Ok(url.to_owned());
        }
    }
    anyhow::bail!(
        "no Shadow release source configured: set {SHADOW_RELEASE_URL_ENV} to the URL of the \
         `{}` release archive (no public Shadow release repo exists yet), or build shadow from \
         source (apps/shadow)",
        artifact_name()
    )
}

// ── ShadowDownloader ───────────────────────────────────────────────────────────

pub struct ShadowDownloader {
    client: reqwest::Client,
    on_progress: Option<ProgressCallback>,
}

impl ShadowDownloader {
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

    /// Ensure the Shadow binary is installed at `~/.ryu/bin/shadow`.
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
            if let Some(stored) = store.installed_checksum("shadow") {
                let actual = compute_sha256(&dest).await?;
                if actual == stored {
                    tracing::info!("shadow already installed and checksum valid — skipping");
                    return Ok(());
                }
                tracing::warn!(
                    "shadow checksum mismatch (stored={stored} actual={actual}), re-downloading"
                );
            }
        }

        let url = archive_url().context("resolving the Shadow release archive URL")?;
        tracing::info!("downloading shadow binary from {url}");

        // Download the archive through the center to a deterministic temp dest
        // (so its own `.part`/resume works), then read it back to extract.
        let archive_ext = if cfg!(target_os = "windows") {
            "zip"
        } else {
            "tar.gz"
        };
        let archive_dest = ryu_dir().join("tmp").join(format!("shadow.{archive_ext}"));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Tool,
                label: "Shadow".to_string(),
                url: url.to_string(),
                dest: archive_dest,
                sha256: None,
                version_record: None,
            })
            .await
            .context("downloading shadow archive")?;
        let archive_data = tokio::fs::read(&archive_path)
            .await
            .context("reading downloaded shadow archive")?;

        // Extract binary from the archive (blocking I/O on a thread-pool thread).
        let binary_name = if cfg!(target_os = "windows") {
            "shadow.exe"
        } else {
            "shadow"
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
        VersionStore::record_persisted("shadow", version, &checksum)
            .context("writing versions.json")?;

        // The extracted binary is in place; drop the temp archive.
        let _ = tokio::fs::remove_file(&archive_path).await;

        // Ensure PATH includes ~/.ryu/bin
        if let Err(e) = crate::sidecar::path_manager::PathManager::add_to_path() {
            tracing::warn!("Failed to add ~/.ryu/bin to PATH: {}", e);
        }

        tracing::info!("shadow installed at {}", dest.display());
        Ok(())
    }
}

impl Default for ShadowDownloader {
    fn default() -> Self {
        Self::new()
    }
}
