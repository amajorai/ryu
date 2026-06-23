//! Parakeet v3 model downloader.
//!
//! Parakeet (NVIDIA FastConformer-TDT) is **not** a GGML/whisper model — it runs
//! on ONNX Runtime, so it cannot be served by the whisper.cpp engine. We fetch
//! the int8 ONNX bundle Handy publishes (the same one `transcribe-rs` loads) and
//! extract it into `~/.ryu/models/parakeet-tdt-0.6b-v3-int8/`. Actual inference
//! is done in-process by the parakeet engine behind the `voice-parakeet` feature.
//!
//! The model URL is a swappable default (`RYU_PARAKEET_MODEL_URL`), not a lock.

use std::path::PathBuf;

use anyhow::{Context, Result};

use crate::sidecar::download_manager::{
    build_http_client, extract_tar_gz_to_dir, ryu_dir, ProgressCallback, VersionStore,
};

/// Directory name the extracted model lives in (transcribe-rs expects exactly this).
pub const MODEL_DIR_NAME: &str = "parakeet-tdt-0.6b-v3-int8";

/// Default int8 ONNX bundle (CPU-friendly, ~478 MB). Published by Handy; mirrors
/// istupakov's HF ONNX export. Swappable via `RYU_PARAKEET_MODEL_URL`.
const DEFAULT_MODEL_URL: &str = "https://blob.handy.computer/parakeet-v3-int8.tar.gz";
const MODEL_STORE_KEY: &str = "parakeet-model:v3-int8";

/// Resolved directory that holds the extracted ONNX model files.
pub fn model_dir() -> PathBuf {
    ryu_dir().join("models").join(MODEL_DIR_NAME)
}

/// The four files transcribe-rs needs to load the parakeet model.
fn required_files() -> [&'static str; 4] {
    [
        "encoder-model.int8.onnx",
        "decoder_joint-model.int8.onnx",
        "nemo128.onnx",
        "vocab.txt",
    ]
}

/// `true` if every required model file is already present on disk.
pub fn model_present() -> bool {
    let dir = model_dir();
    required_files().iter().all(|f| dir.join(f).exists())
}

fn model_url() -> String {
    std::env::var("RYU_PARAKEET_MODEL_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL_URL.to_string())
}

pub struct ParakeetDownloader {
    client: reqwest::Client,
    on_progress: Option<ProgressCallback>,
}

impl ParakeetDownloader {
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

    /// Ensure the parakeet ONNX model bundle is present. Returns the model
    /// directory. Idempotent: skips download when all required files exist.
    ///
    /// The tar.gz bundle downloads through the global [`DownloadCenter`] (#456)
    /// so it streams to disk and shows in the overlay; we then read it back and
    /// extract it into `~/.ryu/models/` exactly as before.
    pub async fn ensure_model(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<PathBuf> {
        let dir = model_dir();
        if model_present() && VersionStore::load().checksums.contains_key(MODEL_STORE_KEY) {
            tracing::info!(
                "parakeet model already installed at {} — skipping",
                dir.display()
            );
            return Ok(dir);
        }

        let url = model_url();
        tracing::info!("downloading parakeet model from {url}");

        // Download the archive through the center to a deterministic temp dest
        // (so its own `.part`/resume works), then read it back to extract.
        let archive_dest = ryu_dir().join("tmp").join("parakeet-v3-int8.tar.gz");
        let archive_path = downloads
            .download_blocking(crate::downloads::DownloadSpec {
                kind: crate::downloads::DownloadKind::Voice,
                label: "Parakeet v3".to_string(),
                url,
                dest: archive_dest,
                sha256: None,
                version_record: None,
            })
            .await
            .context("downloading parakeet model archive")?;
        let archive = tokio::fs::read(&archive_path)
            .await
            .context("reading downloaded parakeet model archive")?;

        let models_dir = ryu_dir().join("models");
        let written =
            tokio::task::spawn_blocking(move || extract_tar_gz_to_dir(&archive, &models_dir))
                .await
                .context("spawn_blocking for tar.gz extraction")??;

        if !model_present() {
            anyhow::bail!(
                "parakeet archive did not contain the expected model files in {} (got: {})",
                MODEL_DIR_NAME,
                written.join(", ")
            );
        }

        VersionStore::record_persisted(MODEL_STORE_KEY, MODEL_DIR_NAME, "v3-int8")
            .context("writing versions.json after parakeet model install")?;

        // The model is extracted in place; drop the temp archive.
        let _ = tokio::fs::remove_file(&archive_path).await;

        tracing::info!(
            "parakeet model installed at {} ({} files)",
            dir.display(),
            written.len()
        );
        Ok(dir)
    }
}

impl Default for ParakeetDownloader {
    fn default() -> Self {
        Self::new()
    }
}
