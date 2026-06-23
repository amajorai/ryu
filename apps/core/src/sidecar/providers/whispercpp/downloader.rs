//! whisper.cpp downloader: fetches the prebuilt server binary (plus the ggml /
//! whisper DLLs it links against) and the default GGML speech-to-text model.
//!
//! whisper.cpp only publishes prebuilt **Windows** server binaries in its GitHub
//! releases — the `whisper-bin-x64.zip` archive bundles `whisper-server.exe`
//! alongside `whisper.dll` and the `ggml*.dll` files it depends on, so all of
//! them must be extracted next to each other. macOS / Linux have no prebuilt
//! server asset, so on those platforms we return a clear "build from source"
//! error rather than silently marking the engine installed (the latent
//! `mark_installed`-on-skip bug this downloader is wired in to fix).
//!
//! Pinning a release tag (not `/latest`) keeps installs reproducible and the
//! asset name known-good. The model file is a swappable default, not a lock:
//! `RYU_WHISPER_MODEL` overrides the path the server loads.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    build_http_client, extract_all_to_dir, ryu_dir, ProgressCallback, VersionStore,
};

/// Pinned whisper.cpp release that ships the Windows server asset.
const TARGET_VERSION: &str = "v1.8.6";

/// Default GGML speech-to-text model (small English base — CPU-friendly).
const DEFAULT_MODEL_FILE: &str = "ggml-base.en.bin";
const DEFAULT_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const MODEL_STORE_KEY: &str = "whisper-model:ggml-base.en";

fn server_binary_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "whisper-server.exe"
    } else {
        "whisper-server"
    };
    ryu_dir().join("bin").join(name)
}

fn model_path() -> PathBuf {
    ryu_dir().join("models").join(DEFAULT_MODEL_FILE)
}

/// whisper.cpp Windows release asset (plain CPU x64 build — no BLAS/CUDA, so it
/// runs without extra runtimes).
#[cfg(target_os = "windows")]
fn archive_url() -> String {
    format!(
        "https://github.com/ggml-org/whisper.cpp/releases/download/{TARGET_VERSION}/whisper-bin-x64.zip"
    )
}

pub struct WhisperCppDownloader {
    client: reqwest::Client,
    on_progress: Option<ProgressCallback>,
}

impl WhisperCppDownloader {
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

    /// Ensure both the whisper server binary and the default GGML model are
    /// present. Returns the installed version string on success.
    ///
    /// Both artifacts (the prebuilt server archive and the default GGML model)
    /// download through the global [`DownloadCenter`] (#456) so they stream to
    /// disk and show in the overlay.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<String> {
        self.ensure_binary(downloads).await?;
        self.ensure_model(downloads).await?;
        Ok(TARGET_VERSION.to_string())
    }

    #[cfg(target_os = "windows")]
    async fn ensure_binary(&self, downloads: &crate::downloads::DownloadCenter) -> Result<()> {
        let dest = server_binary_path();
        let store = VersionStore::load();
        if dest.exists()
            && store.versions.get("whispercpp").map(String::as_str) == Some(TARGET_VERSION)
        {
            tracing::info!("whisper-server {TARGET_VERSION} already installed — skipping");
            return Ok(());
        }

        let url = archive_url();
        tracing::info!("downloading whisper.cpp from {url}");

        // Download the archive through the center to a deterministic temp dest
        // (so its own `.part`/resume works), then read it back to extract.
        let archive_dest = ryu_dir()
            .join("tmp")
            .join(format!("whispercpp-{TARGET_VERSION}.zip"));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Voice,
                label: "whisper.cpp".to_string(),
                url,
                dest: archive_dest,
                sha256: None,
                version_record: None,
            })
            .await
            .context("downloading whisper.cpp archive")?;
        let archive = tokio::fs::read(&archive_path)
            .await
            .context("reading downloaded whisper.cpp archive")?;

        // Extract the whole archive — the server binary links against the
        // sibling DLLs, so they must all land in ~/.ryu/bin together.
        let bin = ryu_dir().join("bin");
        let written = tokio::task::spawn_blocking(move || extract_all_to_dir(&archive, &bin))
            .await
            .context("spawn_blocking for zip extraction")??;

        if !written.iter().any(|f| f == "whisper-server.exe") {
            anyhow::bail!(
                "whisper.cpp archive did not contain whisper-server.exe (got: {})",
                written.join(", ")
            );
        }

        VersionStore::set_version_persisted("whispercpp", TARGET_VERSION)
            .context("writing versions.json")?;

        // Extraction succeeded; drop the temp archive.
        let _ = tokio::fs::remove_file(&archive_path).await;

        if let Err(e) = crate::sidecar::path_manager::PathManager::add_to_path() {
            tracing::warn!("Failed to add ~/.ryu/bin to PATH: {e}");
        }
        tracing::info!(
            "whisper.cpp {TARGET_VERSION} installed ({} files) at {}",
            written.len(),
            dest.display()
        );
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    async fn ensure_binary(&self, _downloads: &crate::downloads::DownloadCenter) -> Result<()> {
        let dest = server_binary_path();
        if dest.exists() {
            return Ok(());
        }
        anyhow::bail!(
            "whisper.cpp publishes prebuilt server binaries for Windows only. On this \
             platform, build it from source (e.g. `cmake -B build -DWHISPER_BUILD_SERVER=ON \
             && cmake --build build --config Release`) and place the resulting \
             `whisper-server` binary at {}.",
            dest.display()
        );
    }

    /// Download the default GGML model into ~/.ryu/models if absent. Honors a
    /// `RYU_WHISPER_MODEL` override pointing at an existing file.
    async fn ensure_model(&self, downloads: &crate::downloads::DownloadCenter) -> Result<()> {
        if let Ok(custom) = std::env::var("RYU_WHISPER_MODEL") {
            if PathBuf::from(&custom).exists() {
                tracing::info!(
                    "RYU_WHISPER_MODEL set to existing {custom} — skipping model download"
                );
                return Ok(());
            }
        }

        let dest = model_path();
        if dest.exists() && VersionStore::load().checksums.contains_key(MODEL_STORE_KEY) {
            tracing::info!("whisper model already installed — skipping");
            return Ok(());
        }

        tracing::info!("downloading whisper model from {DEFAULT_MODEL_URL}");
        let models_dir = ryu_dir().join("models");
        tokio::fs::create_dir_all(&models_dir)
            .await
            .context("creating ~/.ryu/models")?;

        // The model is a single file placed directly at its final path; route it
        // through the center (no temp/extract). The center records the version +
        // checksum on completion via `version_record`, preserving the fast-path
        // skip above (`checksums.contains_key(MODEL_STORE_KEY)`).
        downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Voice,
                label: "whisper.cpp model".to_string(),
                url: DEFAULT_MODEL_URL.to_string(),
                dest: dest.clone(),
                sha256: None,
                version_record: Some(crate::downloads::VersionRecord {
                    store_key: MODEL_STORE_KEY.to_string(),
                    version: DEFAULT_MODEL_FILE.to_string(),
                }),
            })
            .await
            .context("downloading whisper GGML model")?;

        tracing::info!("whisper model installed at {}", dest.display());
        Ok(())
    }
}

impl Default for WhisperCppDownloader {
    fn default() -> Self {
        Self::new()
    }
}
