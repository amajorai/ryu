//! stable-diffusion.cpp downloader: fetches the prebuilt server binary (plus the
//! `stable-diffusion.dll` it links against) and a default, CPU-friendly diffusion
//! model so image generation works right after install.
//!
//! Like whisper.cpp, stable-diffusion.cpp only publishes prebuilt **Windows**
//! binaries in its GitHub releases. The `sd-*-bin-win-avx2-x64.zip` archive
//! bundles `sd-server.exe` alongside `sd-cli.exe` and `stable-diffusion.dll`, so
//! all of them must be extracted next to each other. macOS / Linux have no
//! prebuilt server asset, so on those platforms we return a clear "build from
//! source" error rather than silently marking the engine installed (the latent
//! `mark_installed`-on-skip bug a real downloader is wired in to avoid).
//!
//! Pinning a release tag (not `/latest`) keeps installs reproducible. The model
//! file is a swappable default, not a lock: `RYU_SD_MODEL` overrides the path the
//! server loads, and the model catalog can install any other diffusion GGUF.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    build_http_client, extract_all_to_dir, ryu_dir, ProgressCallback, VersionStore,
};

/// Pinned stable-diffusion.cpp release that ships the Windows server asset.
const TARGET_VERSION: &str = "master-700-c2df4e1";

/// Windows CPU (AVX2) release asset name within [`TARGET_VERSION`]. The asset is
/// named after the commit (`master-c2df4e1`), not the full tag, so it is pinned
/// explicitly rather than derived.
#[cfg(target_os = "windows")]
const WINDOWS_ASSET: &str = "sd-master-c2df4e1-bin-win-avx2-x64.zip";

/// Default diffusion model: Stable Diffusion v1.4, Q8_0-quantized GGUF (~1.76 GB).
/// The smallest mainstream text-to-image checkpoint that runs on CPU — a sensible
/// default, not a lock. Override with `RYU_SD_MODEL` or install another via the
/// model catalog.
const DEFAULT_MODEL_FILE: &str = "stable-diffusion-v1-4-Q8_0.gguf";
const DEFAULT_MODEL_URL: &str =
    "https://huggingface.co/second-state/stable-diffusion-v-1-4-GGUF/resolve/main/stable-diffusion-v1-4-Q8_0.gguf";
const MODEL_STORE_KEY: &str = "sd-model:stable-diffusion-v1-4-q8_0";

fn server_binary_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "sd-server.exe"
    } else {
        "sd-server"
    };
    ryu_dir().join("bin").join(name)
}

pub fn default_model_path() -> PathBuf {
    ryu_dir().join("models").join(DEFAULT_MODEL_FILE)
}

/// stable-diffusion.cpp Windows release asset (CPU AVX2 build — no CUDA, so it
/// runs without extra runtimes). GPU users can swap in the CUDA build manually.
#[cfg(target_os = "windows")]
fn archive_url() -> String {
    format!(
        "https://github.com/leejet/stable-diffusion.cpp/releases/download/{TARGET_VERSION}/{WINDOWS_ASSET}"
    )
}

pub struct StableDiffusionDownloader {
    client: reqwest::Client,
    on_progress: Option<ProgressCallback>,
}

impl StableDiffusionDownloader {
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

    /// Ensure both the sd-server binary and the default model are present.
    /// Returns the installed version string on success.
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
        if dest.exists() && store.versions.get("sdcpp").map(String::as_str) == Some(TARGET_VERSION)
        {
            tracing::info!("sd-server {TARGET_VERSION} already installed — skipping");
            return Ok(());
        }

        let url = archive_url();
        tracing::info!("downloading stable-diffusion.cpp from {url}");

        // Download the archive through the center to a deterministic temp dest,
        // then read it back to extract.
        let archive_dest = ryu_dir()
            .join("tmp")
            .join(format!("sdcpp-{TARGET_VERSION}.zip"));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Media,
                label: "stable-diffusion.cpp".to_string(),
                url,
                dest: archive_dest,
                sha256: None,
                version_record: None,
            })
            .await
            .context("downloading stable-diffusion.cpp archive")?;
        let archive = tokio::fs::read(&archive_path)
            .await
            .context("reading downloaded stable-diffusion.cpp archive")?;

        // Extract the whole archive — sd-server links against the sibling
        // stable-diffusion.dll, so they must land in ~/.ryu/bin together.
        let bin = ryu_dir().join("bin");
        let written = tokio::task::spawn_blocking(move || extract_all_to_dir(&archive, &bin))
            .await
            .context("spawn_blocking for zip extraction")??;

        if !written.iter().any(|f| f == "sd-server.exe") {
            anyhow::bail!(
                "stable-diffusion.cpp archive did not contain sd-server.exe (got: {})",
                written.join(", ")
            );
        }

        VersionStore::set_version_persisted("sdcpp", TARGET_VERSION)
            .context("writing versions.json")?;

        // The extracted binaries are in place; drop the temp archive.
        let _ = tokio::fs::remove_file(&archive_path).await;

        if let Err(e) = crate::sidecar::path_manager::PathManager::add_to_path() {
            tracing::warn!("Failed to add ~/.ryu/bin to PATH: {e}");
        }
        tracing::info!(
            "stable-diffusion.cpp {TARGET_VERSION} installed ({} files) at {}",
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
            "stable-diffusion.cpp publishes prebuilt server binaries for Windows only. On \
             this platform, build it from source (e.g. `cmake -B build -DSD_BUILD_EXAMPLES=ON \
             && cmake --build build --config Release`) and place the resulting `sd-server` \
             binary at {}.",
            dest.display()
        );
    }

    /// Download the default diffusion model into ~/.ryu/models if absent. Honors a
    /// `RYU_SD_MODEL` override pointing at an existing file.
    async fn ensure_model(&self, downloads: &crate::downloads::DownloadCenter) -> Result<()> {
        if let Ok(custom) = std::env::var("RYU_SD_MODEL") {
            if PathBuf::from(&custom).exists() {
                tracing::info!("RYU_SD_MODEL set to existing {custom} — skipping model download");
                return Ok(());
            }
        }

        let dest = default_model_path();
        if dest.exists() && VersionStore::load().checksums.contains_key(MODEL_STORE_KEY) {
            tracing::info!("stable diffusion model already installed — skipping");
            return Ok(());
        }

        tracing::info!("downloading stable diffusion model from {DEFAULT_MODEL_URL}");
        let models_dir = ryu_dir().join("models");
        tokio::fs::create_dir_all(&models_dir)
            .await
            .context("creating ~/.ryu/models")?;

        // The model is a single file placed directly at its final path (no
        // extraction). The center writes it atomically and records the
        // `(MODEL_STORE_KEY, DEFAULT_MODEL_FILE)` version on completion with the
        // computed checksum — the same fast-path key the skip above checks.
        downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Media,
                label: "stable-diffusion.cpp model".to_string(),
                url: DEFAULT_MODEL_URL.to_string(),
                dest,
                sha256: None,
                version_record: Some(crate::downloads::VersionRecord {
                    store_key: MODEL_STORE_KEY.to_string(),
                    version: DEFAULT_MODEL_FILE.to_string(),
                }),
            })
            .await
            .context("downloading stable diffusion model")?;

        tracing::info!("stable diffusion model installed");
        Ok(())
    }
}

impl Default for StableDiffusionDownloader {
    fn default() -> Self {
        Self::new()
    }
}
