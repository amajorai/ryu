//! Parakeet v3 voice (STT) engine — ONNX-based, runs **alongside** whisper.cpp.
//!
//! Why a separate engine: parakeet is an NVIDIA FastConformer-TDT model that runs
//! on ONNX Runtime, not GGML — whisper.cpp cannot load it. We embed the Rust
//! `transcribe-rs` library (the same engine Handy uses) in-process to run it.
//! Because ONNX Runtime is a heavy native dependency, the actual inference is
//! gated behind the `voice-parakeet` cargo feature.
//!
//! Unlike whisper (an external `whisper-server` process Core proxies over HTTP),
//! parakeet is a library with no server, so there is no process to spawn — the
//! "engine" is an in-process, lazily-loaded model. This is the genuinely
//! in-process hot path of the STT primitive (never IPC).
//!
//! The extracted-model **directory** is resolved by the host (it is a `~/.ryu`
//! path the downloader in Core owns) and passed in, so this crate has ZERO
//! dependency on `apps/core`.

use std::path::Path;

/// Transcribe audio bytes (a WAV upload) with parakeet. Used by the STT dispatch
/// (`transcribe_wav_detailed`) when the parakeet engine is selected. `model_dir`
/// is the extracted ONNX model directory, resolved and owned by the host.
///
/// Without the `voice-parakeet` feature this returns a clear, actionable error
/// rather than silently failing.
pub async fn transcribe(audio: Vec<u8>, model_dir: std::path::PathBuf) -> anyhow::Result<String> {
    #[cfg(feature = "voice-parakeet")]
    {
        // Inference is CPU-bound and blocking — run it off the async runtime.
        tokio::task::spawn_blocking(move || engine::transcribe_wav_bytes(&audio, &model_dir))
            .await
            .map_err(|e| anyhow::anyhow!("parakeet transcribe task panicked: {e}"))?
    }
    #[cfg(not(feature = "voice-parakeet"))]
    {
        let _ = (audio, model_dir);
        anyhow::bail!(
            "parakeet inference is not built into this build. Rebuild with \
             `--features voice-parakeet` (pulls ONNX Runtime via transcribe-rs), or use the \
             whisper.cpp voice engine instead."
        )
    }
}

/// Ensure the parakeet model is loaded into memory (fast first-transcription).
/// A no-op error-free call when the `voice-parakeet` feature is off.
pub fn preload(model_dir: &Path) -> anyhow::Result<()> {
    #[cfg(feature = "voice-parakeet")]
    {
        engine::preload(model_dir)
    }
    #[cfg(not(feature = "voice-parakeet"))]
    {
        let _ = model_dir;
        Ok(())
    }
}

/// Drop the in-memory parakeet model. A no-op when the feature is off.
pub fn unload() {
    #[cfg(feature = "voice-parakeet")]
    engine::unload();
}

// ── In-process ONNX inference (feature-gated) ─────────────────────────────────
//
// transcribe-rs is a git-only crate (cjpais/transcribe-rs) pulling ort 2.x +
// ONNX Runtime. It is added under the `voice-parakeet` feature in Cargo.toml so
// the default build stays free of the native dependency. This module is the
// only place that touches it.
#[cfg(feature = "voice-parakeet")]
mod engine {
    use std::io::Write;
    use std::path::Path;
    use std::sync::Mutex;

    use anyhow::{Context, Result};
    use once_cell::sync::Lazy;
    use transcribe_rs::onnx::parakeet::ParakeetModel;
    use transcribe_rs::onnx::Quantization;
    use transcribe_rs::{SpeechModel, TranscribeOptions};

    /// Process-global model, lazily loaded. Parakeet inference is stateful
    /// (`&mut self`), so it is guarded by a Mutex and reused across requests.
    static MODEL: Lazy<Mutex<Option<ParakeetModel>>> = Lazy::new(|| Mutex::new(None));

    /// Load the model into memory if not already loaded. `ParakeetModel::load`
    /// both constructs and loads from the downloaded int8 model directory.
    pub fn preload(model_dir: &Path) -> Result<()> {
        let mut guard = MODEL.lock().expect("parakeet model mutex");
        if guard.is_some() {
            return Ok(());
        }
        let model = ParakeetModel::load(model_dir, &Quantization::Int8)
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
    pub fn transcribe_wav_bytes(audio: &[u8], model_dir: &Path) -> Result<String> {
        preload(model_dir)?;
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
