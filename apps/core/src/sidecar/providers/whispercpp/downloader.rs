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

use ryu_sidecar_runtime::layout::{EngineGroup, Modality};

use crate::sidecar::download_manager::{
    build_http_client, engine_dir, extract_all_to_dir_from, model_family_dir, ProgressCallback,
    VersionStore,
};

/// Pinned whisper.cpp release that ships the Windows server asset.
/// The release tag this build installs — pinned; see
/// `catalog::registry::installer_pin`.
pub const TARGET_VERSION: &str = "v1.8.6";

/// Default GGML speech-to-text model (small English base — CPU-friendly).
const DEFAULT_MODEL_FILE: &str = "ggml-base.en.bin";
const DEFAULT_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const MODEL_STORE_KEY: &str = "whisper-model:ggml-base.en";

/// `<data dir>/engines/audio/whispercpp` — the release archive (server binary
/// plus its ggml/whisper shared libraries) is extracted here as one unit.
pub fn install_dir() -> PathBuf {
    engine_dir(EngineGroup::Audio, "whispercpp")
}

/// Path of the installed `whisper-server` executable inside [`install_dir`].
pub fn server_binary_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "whisper-server.exe"
    } else {
        "whisper-server"
    };
    install_dir().join(name)
}

/// `<data dir>/models/speech-to-text/whisper` — whisper GGML weights.
pub fn models_dir() -> PathBuf {
    model_family_dir(Modality::SpeechToText, "whisper")
}

/// The default GGML model (`models/speech-to-text/whisper/ggml-base.en.bin`).
pub fn model_path() -> PathBuf {
    models_dir().join(DEFAULT_MODEL_FILE)
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
        // An engine is executed, so DownloadCenter refuses it unverified: read the
        // digest the pinned release publishes for this asset.
        let release = crate::sidecar::download_manager::fetch_github_release(
            &self.client,
            "ggml-org/whisper.cpp",
            Some(TARGET_VERSION),
        )
        .await
        .context("fetching the whisper.cpp release")?;
        let archive_sha256 = crate::sidecar::download_manager::require_release_asset_sha256(
            &self.client,
            &release,
            "whisper-bin-x64.zip",
        )
        .await?;

        // Download the archive through the center to a deterministic temp dest
        // (so its own `.part`/resume works), then read it back to extract.
        let archive_dest = crate::sidecar::download_manager::tmp_dir()
            .join(format!("whispercpp-{TARGET_VERSION}.zip"));
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Voice,
                role: crate::downloads::DownloadRole::Engine,
                label: "whisper.cpp".to_string(),
                url,
                dest: archive_dest,
                sha256: Some(archive_sha256),
                version_record: None,
            })
            .await
            .context("downloading whisper.cpp archive")?;
        // Streamed from disk rather than read whole into memory first.
        let archive = std::io::BufReader::new(
            std::fs::File::open(&archive_path).context("opening downloaded whisper.cpp archive")?,
        );

        // Extract the whole archive — the server binary links against the
        // sibling DLLs, so they must all land together in the engine's own dir
        // (Windows resolves a DLL from the executable's directory first). Clear
        // the previous build so an upgrade never mixes two sets of DLLs.
        let engine = install_dir();
        if engine.exists() {
            tokio::fs::remove_dir_all(&engine)
                .await
                .with_context(|| format!("clearing {}", engine.display()))?;
        }
        let written =
            tokio::task::spawn_blocking(move || extract_all_to_dir_from(archive, &engine))
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

    /// Download the default GGML model into `models/speech-to-text/whisper/` if absent. Honors a
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
        let models_dir = models_dir();
        tokio::fs::create_dir_all(&models_dir)
            .await
            .with_context(|| format!("creating {}", models_dir.display()))?;

        // The model is a single file placed directly at its final path; route it
        // through the center (no temp/extract). The center records the version +
        // checksum on completion via `version_record`, preserving the fast-path
        // skip above (`checksums.contains_key(MODEL_STORE_KEY)`).
        downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Voice,
                role: crate::downloads::DownloadRole::SpeechModel,
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
