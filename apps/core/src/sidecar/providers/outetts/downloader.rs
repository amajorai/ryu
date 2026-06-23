//! OuteTTS downloader: ensures the shared `llama-tts` binary plus the two GGUF
//! models text-to-speech needs — the OuteTTS language model and the WavTokenizer
//! vocoder that turns its output tokens into audio.
//!
//! TTS reuses the llama.cpp release machinery: `llama-tts` ships in the same zip
//! as `llama-server` (extracted via [`LlamaCppDownloader::ensure_tts_binary`]),
//! so no new engine binary is introduced. The models are swappable defaults, not
//! locks: `RYU_OUTETTS_MODEL` / `RYU_OUTETTS_VOCODER` override the paths.

use std::path::PathBuf;

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use crate::sidecar::download_manager::{
    build_http_client, ryu_dir, ProgressCallback, VersionStore,
};
use crate::sidecar::providers::llamacpp::LlamaCppDownloader;

/// OuteTTS language model (0.2 500M, Q4_K_M GGUF — ~400 MB, CPU-friendly).
const MODEL_FILE: &str = "OuteTTS-0.2-500M-Q4_K_M.gguf";
const MODEL_URL: &str =
    "https://huggingface.co/OuteAI/OuteTTS-0.2-500M-GGUF/resolve/main/OuteTTS-0.2-500M-Q4_K_M.gguf";
const MODEL_STORE_KEY: &str = "outetts-model:oute-0.2-500m-q4_k_m";

/// WavTokenizer vocoder (F16 GGUF — ~130 MB) that decodes OuteTTS output to audio.
const VOCODER_FILE: &str = "WavTokenizer-Large-75-F16.gguf";
const VOCODER_URL: &str =
    "https://huggingface.co/ggml-org/WavTokenizer/resolve/main/WavTokenizer-Large-75-F16.gguf";
const VOCODER_STORE_KEY: &str = "outetts-vocoder:wavtokenizer-large-75-f16";

pub fn model_path() -> PathBuf {
    std::env::var("RYU_OUTETTS_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|_| ryu_dir().join("models").join(MODEL_FILE))
}

pub fn vocoder_path() -> PathBuf {
    std::env::var("RYU_OUTETTS_VOCODER")
        .map(PathBuf::from)
        .unwrap_or_else(|_| ryu_dir().join("models").join(VOCODER_FILE))
}

pub struct OuteTtsDownloader {
    client: reqwest::Client,
    on_progress: Option<ProgressCallback>,
}

impl OuteTtsDownloader {
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

    /// Ensure the llama-tts binary and both GGUF models are present. Returns the
    /// installed marker string on success.
    pub async fn ensure_installed(
        &self,
        downloads: &crate::downloads::DownloadCenter,
    ) -> Result<String> {
        LlamaCppDownloader::new()
            .ensure_tts_binary(downloads)
            .await
            .context("installing llama-tts binary")?;
        self.ensure_file(
            MODEL_URL,
            &model_path(),
            MODEL_STORE_KEY,
            MODEL_FILE,
            "OuteTTS",
            downloads,
        )
        .await?;
        self.ensure_file(
            VOCODER_URL,
            &vocoder_path(),
            VOCODER_STORE_KEY,
            VOCODER_FILE,
            "OuteTTS",
            downloads,
        )
        .await?;
        Ok("installed".to_string())
    }

    /// Download a single GGUF into `dest` if absent, recording its checksum.
    ///
    /// The model file streams through the global [`DownloadCenter`] (#456) straight
    /// to `dest` (no temp/extract — it is the final artifact), so it shows in the
    /// overlay; we then compute the checksum and record it in `versions.json`.
    async fn ensure_file(
        &self,
        url: &str,
        dest: &PathBuf,
        store_key: &str,
        file_name: &str,
        label: &str,
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
                label: label.to_string(),
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
            .context("writing versions.json after model install")?;
        tracing::info!("{file_name} installed at {}", dest.display());
        Ok(())
    }
}

impl Default for OuteTtsDownloader {
    fn default() -> Self {
        Self::new()
    }
}
