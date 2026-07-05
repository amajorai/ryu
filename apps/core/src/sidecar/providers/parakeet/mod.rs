//! Parakeet v3 voice (STT) engine — ONNX-based, runs **alongside** whisper.cpp.
//!
//! Why a separate engine: parakeet is an NVIDIA FastConformer-TDT model that runs
//! on ONNX Runtime, not GGML — whisper.cpp cannot load it. We embed the Rust
//! `transcribe-rs` library (the same engine Handy uses) in-process to run it.
//! Because ONNX Runtime is a heavy native dependency, the actual inference is
//! gated behind the `voice-parakeet` cargo feature; the model download, catalog,
//! lifecycle, and `/api/voice/transcribe` routing are always present so enabling
//! the feature is the only step needed to light it up.
//!
//! Unlike whisper (an external `whisper-server` process Core proxies over HTTP),
//! parakeet is a library with no server, so there is no process to spawn — the
//! "engine" is an in-process, lazily-loaded model. The Sidecar lifecycle here
//! maps to *model loaded in memory* (start = ensure downloaded + load; stop =
//! unload). It is opt-in (not in `startup_order`), matching the voice-engine
//! download-only default.

pub mod downloader;

pub use downloader::{model_dir, model_present, ParakeetDownloader, MODEL_DIR_NAME};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// Lifecycle manager for the in-process parakeet STT engine.
pub struct ParakeetManager {
    /// `true` once the model has been ensured present (and, with the feature on,
    /// loaded into memory). Reflects "ready to transcribe".
    loaded: Arc<AtomicBool>,
    /// Global download center (#456), injected at construction in `main.rs`.
    /// Routes the model bundle download through the center so it shows in the
    /// overlay. (`DownloadCenter` is itself a cheap `Arc` wrapper.)
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl ParakeetManager {
    pub fn new() -> Self {
        Self {
            loaded: Arc::new(AtomicBool::new(false)),
            downloads: None,
        }
    }

    /// Inject the global download center (called at the `main.rs` build site).
    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }
}

impl Default for ParakeetManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for ParakeetManager {
    fn name(&self) -> &'static str {
        "parakeet"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let loaded = Arc::clone(&self.loaded);
        let downloads = self.downloads.clone();
        Box::pin(async move {
            // Ensure the ONNX model bundle is on disk (downloads on first start)
            // through the download center (#456) so it shows in the overlay.
            let downloads =
                downloads.expect("parakeet manager: download center not wired (main.rs)");
            ParakeetDownloader::new()
                .ensure_model(&downloads)
                .await
                .map_err(|e| anyhow::anyhow!("downloading parakeet model: {e:#}"))?;

            // With the inference feature on, preload the model so the first
            // transcription is fast. Without it, the model is downloaded but
            // transcription will return a clear "feature not built" error.
            #[cfg(feature = "voice-parakeet")]
            {
                engine::preload().map_err(|e| anyhow::anyhow!("loading parakeet model: {e:#}"))?;
                tracing::info!("parakeet engine loaded (ONNX inference enabled)");
            }
            #[cfg(not(feature = "voice-parakeet"))]
            {
                tracing::warn!(
                    "parakeet model downloaded, but this Core build was compiled without the \
                     `voice-parakeet` feature — transcription via parakeet will return an error. \
                     Rebuild Core with `--features voice-parakeet` to enable ONNX inference."
                );
            }

            loaded.store(true, Ordering::Relaxed);
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let loaded = Arc::clone(&self.loaded);
        Box::pin(async move {
            #[cfg(feature = "voice-parakeet")]
            engine::unload();
            loaded.store(false, Ordering::Relaxed);
            tracing::info!("parakeet engine unloaded");
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let loaded = Arc::clone(&self.loaded);
        Box::pin(async move {
            if loaded.load(Ordering::Relaxed) {
                HealthStatus::Healthy
            } else {
                HealthStatus::Unhealthy("parakeet model not loaded".into())
            }
        })
    }

    fn is_running(&self) -> bool {
        self.loaded.load(Ordering::Relaxed)
    }

    fn uninstall(&self, delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_from_version_store("parakeet");
            if delete_data {
                crate::sidecar::remove_dir(&model_dir()).await;
                tracing::info!("parakeet model files removed");
            }
            tracing::info!("parakeet uninstalled");
            Ok(())
        })
    }
}

/// Transcribe audio bytes (a WAV upload) with parakeet. Used by the
/// `/api/voice/transcribe` data path when the parakeet engine is selected.
///
/// Without the `voice-parakeet` feature this returns a clear, actionable error
/// rather than silently failing.
pub async fn transcribe(audio: Vec<u8>, _filename: String) -> anyhow::Result<String> {
    #[cfg(feature = "voice-parakeet")]
    {
        // Inference is CPU-bound and blocking — run it off the async runtime.
        tokio::task::spawn_blocking(move || engine::transcribe_wav_bytes(&audio))
            .await
            .map_err(|e| anyhow::anyhow!("parakeet transcribe task panicked: {e}"))?
    }
    #[cfg(not(feature = "voice-parakeet"))]
    {
        let _ = audio;
        anyhow::bail!(
            "parakeet inference is not built into this Core build. Rebuild Core with \
             `--features voice-parakeet` (pulls ONNX Runtime via transcribe-rs), or use the \
             whisper.cpp voice engine instead."
        )
    }
}

// ── In-process ONNX inference (feature-gated) ─────────────────────────────────
//
// transcribe-rs is a git-only crate (cjpais/transcribe-rs) pulling ort 2.x +
// ONNX Runtime. It is added under the `voice-parakeet` feature in Cargo.toml so
// the default Core build stays free of the native dependency. This module is the
// only place that touches it.
#[cfg(feature = "voice-parakeet")]
mod engine {
    use std::io::Write;
    use std::sync::Mutex;

    use anyhow::{Context, Result};
    use once_cell::sync::Lazy;
    use transcribe_rs::onnx::parakeet::ParakeetModel;
    use transcribe_rs::onnx::Quantization;
    use transcribe_rs::{SpeechModel, TranscribeOptions};

    use super::downloader::model_dir;

    /// Process-global model, lazily loaded. Parakeet inference is stateful
    /// (`&mut self`), so it is guarded by a Mutex and reused across requests.
    static MODEL: Lazy<Mutex<Option<ParakeetModel>>> = Lazy::new(|| Mutex::new(None));

    /// Load the model into memory if not already loaded. `ParakeetModel::load`
    /// both constructs and loads from the downloaded int8 model directory.
    pub fn preload() -> Result<()> {
        let mut guard = MODEL.lock().expect("parakeet model mutex");
        if guard.is_some() {
            return Ok(());
        }
        let model = ParakeetModel::load(&model_dir(), &Quantization::Int8)
            .map_err(|e| anyhow::anyhow!("{e}"))
            .context("loading parakeet ONNX model")?;
        *guard = Some(model);
        Ok(())
    }

    /// Drop the in-memory model.
    pub fn unload() {
        let mut guard = MODEL.lock().expect("parakeet model mutex");
        *guard = None;
    }

    /// Transcribe raw WAV bytes. The audio must be 16 kHz mono PCM (whisper-style
    /// uploads from the desktop already meet this); other formats are written
    /// through to `transcribe_file`, which reads via `hound`.
    pub fn transcribe_wav_bytes(audio: &[u8]) -> Result<String> {
        preload()?;
        let mut guard = MODEL.lock().expect("parakeet model mutex");
        let model = guard.as_mut().context("parakeet model not loaded")?;

        // transcribe-rs reads WAV from a path (hound). Stage the upload to a temp
        // file so we can reuse its decoding + the engine's resampling.
        let mut tmp = tempfile::Builder::new()
            .suffix(".wav")
            .tempfile()
            .context("creating temp wav for parakeet")?;
        tmp.write_all(audio).context("writing temp wav")?;
        let path = tmp.path().to_path_buf();

        let result = model
            .transcribe_file(&path, &TranscribeOptions::default())
            .map_err(|e| anyhow::anyhow!("{e}"))
            .context("parakeet transcription failed")?;
        Ok(result.text.trim().to_string())
    }
}
