//! llama.cpp downloader with zip extraction for all platforms, plus GGUF weight
//! download for the bundled local chat model.

use std::path::PathBuf;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use crate::registry::{LocalModelEntry, ModelRegistry};
use crate::sidecar::download_manager::{
    build_http_client, extract_from_zip, ryu_dir, ProgressCallback, VersionStore,
};

// ── Paths ──────────────────────────────────────────────────────────────────────

fn bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    ryu_dir().join("bin").join(name)
}

// b9670 is the first bundled build to include MTP (multi-token prediction)
// speculative decoding — `--spec-type draft-mtp` (PR #22673) plus Gemma-4 E2B/E4B
// MTP assist support (PR #24282). NOTE: b9xxx removed `--draft-max`/`--draft-min`
// in favour of `--spec-draft-n-max`/`--spec-draft-n-min` (see `inference::LaunchConfig`).
const TARGET_VERSION: &str = "b9670";

fn archive_url() -> String {
    let tag = TARGET_VERSION;
    let platform = llamacpp_platform();
    format!(
        "https://github.com/ggml-org/llama.cpp/releases/download/{tag}/llama-{tag}-bin-{platform}.zip"
    )
}

/// Maps ryu platform tags to llama.cpp platform names.
fn llamacpp_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        #[cfg(target_arch = "x86_64")]
        return "win-cpu-x64";
        #[cfg(target_arch = "aarch64")]
        return "win-cpu-arm64";
    }

    #[cfg(target_os = "macos")]
    {
        #[cfg(target_arch = "aarch64")]
        return "macos-arm64";
        #[cfg(not(target_arch = "aarch64"))]
        return "macos-x64";
    }

    #[cfg(target_os = "linux")]
    {
        #[cfg(target_arch = "x86_64")]
        return "ubuntu-x64";
        #[cfg(target_arch = "aarch64")]
        return "ubuntu-x64"; // llama.cpp may not have ARM Linux builds, fallback to x64
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return "ubuntu-x64";
}

// ── LlamaCppDownloader ─────────────────────────────────────────────────────────

pub struct LlamaCppDownloader {
    client: reqwest::Client,
    on_progress: Option<ProgressCallback>,
}

impl LlamaCppDownloader {
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

    /// Ensure the llama.cpp binary is installed at `~/.ryu/bin/llama-server`.
    ///
    /// The release archive downloads through the global [`DownloadCenter`] (#456)
    /// so it streams to disk and shows in the overlay; we then extract the binary
    /// from the downloaded archive and place it atomically.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<()> {
        let dest = bin_path();

        // Fast path: already installed with matching version.
        let store = VersionStore::load();
        if dest.exists() {
            if let Some(stored) = store.versions.get("llamacpp") {
                if stored == TARGET_VERSION {
                    tracing::info!("llama.cpp {} already installed — skipping", TARGET_VERSION);
                    return Ok(());
                }
                tracing::warn!(
                    "llama.cpp version mismatch (stored={}, target={}), re-downloading",
                    stored,
                    TARGET_VERSION
                );
            }
        }

        let url = archive_url();
        tracing::info!("downloading llama.cpp from {url}");

        // Download the archive through the center to a deterministic temp dest
        // (so its own `.part`/resume works), then read it back to extract.
        let archive_dest = ryu_dir()
            .join("tmp")
            .join(format!("llamacpp-{TARGET_VERSION}.zip"));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Engine,
                label: "llama.cpp".to_string(),
                url,
                dest: archive_dest,
                sha256: None,
                version_record: None,
            })
            .await
            .context("downloading llama.cpp archive")?;
        let archive_data = tokio::fs::read(&archive_path)
            .await
            .context("reading downloaded llama.cpp archive")?;

        // Extract binary from the archive (blocking I/O on thread-pool thread).
        let binary_name = "llama-server";
        let extracted =
            tokio::task::spawn_blocking(move || extract_from_zip(&archive_data, binary_name))
                .await
                .context("spawn_blocking for zip extraction")??;

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

        // Record version atomically — never clobbers a concurrently-installed engine.
        VersionStore::set_version_persisted("llamacpp", TARGET_VERSION)
            .context("writing versions.json")?;

        // The extracted binary is in place; drop the temp archive.
        let _ = tokio::fs::remove_file(&archive_path).await;

        // Ensure PATH includes ~/.ryu/bin
        if let Err(e) = crate::sidecar::path_manager::PathManager::add_to_path() {
            tracing::warn!("Failed to add ~/.ryu/bin to PATH: {}", e);
        }

        tracing::info!(
            "llama.cpp {} installed at {}",
            TARGET_VERSION,
            dest.display()
        );
        Ok(())
    }

    /// Ensure the `llama-tts` text-to-speech binary is installed at
    /// `~/.ryu/bin/llama-tts`. Shares the same llama.cpp release archive as
    /// `llama-server`; used by the OuteTTS voice engine. Idempotent: skips the
    /// download when the binary already exists.
    pub async fn ensure_tts_binary(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<PathBuf> {
        let name = if cfg!(target_os = "windows") {
            "llama-tts.exe"
        } else {
            "llama-tts"
        };
        let dest = ryu_dir().join("bin").join(name);
        if dest.exists() {
            return Ok(dest);
        }

        let url = archive_url();
        tracing::info!("downloading llama.cpp (for llama-tts) from {url}");
        // Download the archive through the center (shows in the overlay), then
        // extract llama-tts. Shares the llama-server release zip.
        let archive_dest = ryu_dir()
            .join("tmp")
            .join(format!("llamacpp-tts-{TARGET_VERSION}.zip"));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Voice,
                label: "llama-tts".to_string(),
                url,
                dest: archive_dest,
                sha256: None,
                version_record: None,
            })
            .await
            .context("downloading llama.cpp archive for llama-tts")?;
        let archive_data = tokio::fs::read(&archive_path)
            .await
            .context("reading downloaded llama-tts archive")?;

        let extracted =
            tokio::task::spawn_blocking(move || extract_from_zip(&archive_data, "llama-tts"))
                .await
                .context("spawn_blocking for zip extraction")??;

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
        let _ = tokio::fs::remove_file(&archive_path).await;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&dest)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dest, perms)?;
        }

        tracing::info!("llama-tts installed at {}", dest.display());
        Ok(dest)
    }
}

impl Default for LlamaCppDownloader {
    fn default() -> Self {
        Self::new()
    }
}
