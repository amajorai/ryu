//! Kokoro 82M downloader: fetches the two model artifacts the Ryu **default** TTS
//! engine needs — the Kokoro ONNX weights and the voice pack — during onboarding,
//! exactly like the Gemma chat GGUF and the OuteTTS GGUFs.
//!
//! Kokoro runs through the Python TTS sidecar's `kokoro-onnx` backend
//! (`apps/tts-sidecar/ryu_tts/backends/kokoro.py`), which reads these files via the
//! `RYU_KOKORO_MODEL` / `RYU_KOKORO_VOICES` env vars Core injects at spawn. Onboarding
//! is the single owner of the download (the sidecar only *serves* the files, it never
//! downloads them) — the same "onboarding downloads, engine serves" split the
//! `llamacpp-embed` nomic GGUF uses.
//!
//! The files are CPU-friendly ONNX artifacts (~310 MB weights + ~27 MB voices), served
//! from the upstream `kokoro-onnx` release assets. Both URLs/paths are swappable
//! defaults, never locks: `RYU_KOKORO_MODEL_URL` / `RYU_KOKORO_VOICES_URL` override the
//! sources and `RYU_KOKORO_MODEL` / `RYU_KOKORO_VOICES` override the destinations.

use std::path::PathBuf;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use crate::sidecar::download_manager::{ryu_dir, VersionStore};

/// Kokoro 82M v1.0 ONNX weights (~310 MB). Override the source via `RYU_KOKORO_MODEL_URL`.
const MODEL_FILE: &str = "kokoro-v1.0.onnx";
const MODEL_URL: &str = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx";
const MODEL_STORE_KEY: &str = "kokoro-model:kokoro-82m-v1.0";

/// Kokoro voice pack (~27 MB) — the styles for every preset voice. Override the
/// source via `RYU_KOKORO_VOICES_URL`.
const VOICES_FILE: &str = "kokoro-voices-v1.0.bin";
const VOICES_URL: &str = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin";
const VOICES_STORE_KEY: &str = "kokoro-voices:kokoro-82m-v1.0";

/// Resolved path for the Kokoro ONNX weights (`~/.ryu/models/kokoro-v1.0.onnx`).
/// Overridable via `RYU_KOKORO_MODEL` (this is also the value injected into the
/// sidecar's `kokoro` backend).
pub fn model_path() -> PathBuf {
    std::env::var("RYU_KOKORO_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|_| ryu_dir().join("models").join(MODEL_FILE))
}

/// Resolved path for the Kokoro voice pack. Overridable via `RYU_KOKORO_VOICES`.
pub fn voices_path() -> PathBuf {
    std::env::var("RYU_KOKORO_VOICES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| ryu_dir().join("models").join(VOICES_FILE))
}

/// Whether both Kokoro artifacts are present on disk (used to gate the sidecar
/// spawn and to derive the onboarding "installed" flag).
pub fn is_model_present() -> bool {
    model_path().exists() && voices_path().exists()
}

/// Downloader for the Kokoro model artifacts. No binary to fetch (the runtime is the
/// Python sidecar's `kokoro-onnx`), so this only ensures the two model files.
pub struct KokoroDownloader;

impl KokoroDownloader {
    pub fn new() -> Self {
        Self
    }

    /// Ensure both Kokoro artifacts are present, downloading any that are missing.
    /// Idempotent: a present + checksum-recorded file is skipped. Returns the
    /// installed marker string on success.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<String> {
        let model_url =
            std::env::var("RYU_KOKORO_MODEL_URL").unwrap_or_else(|_| MODEL_URL.to_string());
        let voices_url =
            std::env::var("RYU_KOKORO_VOICES_URL").unwrap_or_else(|_| VOICES_URL.to_string());
        self.ensure_file(
            &model_url,
            &model_path(),
            MODEL_STORE_KEY,
            MODEL_FILE,
            downloads,
        )
        .await?;
        self.ensure_file(
            &voices_url,
            &voices_path(),
            VOICES_STORE_KEY,
            VOICES_FILE,
            downloads,
        )
        .await?;
        Ok("installed".to_string())
    }

    /// Download a single artifact into `dest` if absent, recording its checksum in
    /// `versions.json`. Streams through the global [`DownloadCenter`] so it shows in
    /// the overlay (mirrors [`super::super::outetts::OuteTtsDownloader`]).
    async fn ensure_file(
        &self,
        url: &str,
        dest: &PathBuf,
        store_key: &str,
        file_name: &str,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<()> {
        if dest.exists() && VersionStore::load().checksums.contains_key(store_key) {
            tracing::info!("{file_name} already installed — skipping");
            return Ok(());
        }

        tracing::info!("downloading {file_name} from {url}");
        let models_dir = ryu_dir().join("models");
        tokio::fs::create_dir_all(&models_dir)
            .await
            .context("creating ~/.ryu/models")?;

        let downloaded = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Voice,
                label: "Kokoro 82M".to_string(),
                url: url.to_string(),
                dest: dest.clone(),
                sha256: None,
                version_record: None,
            })
            .await
            .with_context(|| format!("downloading {file_name}"))?;

        let data = tokio::fs::read(&downloaded)
            .await
            .with_context(|| format!("reading downloaded {file_name}"))?;
        let checksum = {
            let mut hasher = Sha256::new();
            hasher.update(&data);
            hex::encode(hasher.finalize())
        };

        VersionStore::record_persisted(store_key, file_name, &checksum)
            .context("writing versions.json after Kokoro model install")?;
        tracing::info!("{file_name} installed at {}", dest.display());
        Ok(())
    }
}

impl Default for KokoroDownloader {
    fn default() -> Self {
        Self::new()
    }
}
