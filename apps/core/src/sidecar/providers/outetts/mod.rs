//! OuteTTS voice (text-to-speech) engine — generates speech audio from text.
//!
//! TTS is the generative counterpart to whisper/parakeet's transcription. Like
//! parakeet it has **no resident server**: each request shells out to the
//! `llama-tts` CLI (shipped in the same llama.cpp release as `llama-server`),
//! which runs the OuteTTS GGUF + WavTokenizer vocoder and writes a WAV file. So
//! the Sidecar lifecycle maps to *binary + models present* (start = ensure
//! installed; stop = mark not-ready), and it is opt-in (not in `startup_order`),
//! matching the voice-engine download-only default.
//!
//! Consumed by the Core `POST /api/voice/speak` data path (`server::voice`).
//! Placement is **Core** — it decides *what runs* (which local engine renders the
//! audio). Per-attribute Gateway routing of TTS slots is a future enhancement.

pub mod downloader;

pub use downloader::{model_path, vocoder_path, OuteTtsDownloader};

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use crate::win_process::NoWindow;

/// Per-process counter giving each synthesis a unique temp output path.
static TTS_SEQ: AtomicU64 = AtomicU64::new(0);

/// `llama-tts` ships in the same llama.cpp release archive as `llama-server`
/// and is installed beside it, inside the resident build's own directory — so
/// it resolves through the engine's variant resolver, not a bare `~/.ryu/bin`
/// path (which is where the pre-variant layout put it).
fn binary_path() -> std::path::PathBuf {
    crate::sidecar::providers::llamacpp::variant::tts_path()
}

/// Lifecycle manager for the OuteTTS (llama-tts) text-to-speech engine.
pub struct OuteTtsManager {
    /// `true` once the binary + models are confirmed present ("ready to speak").
    ready: Arc<AtomicBool>,
    /// Global download center (#456); wired by main.rs via [`with_downloads`].
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl OuteTtsManager {
    pub fn new() -> Self {
        Self {
            ready: Arc::new(AtomicBool::new(false)),
            downloads: None,
        }
    }

    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }
}

impl Default for OuteTtsManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for OuteTtsManager {
    fn name(&self) -> &'static str {
        "outetts"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let ready = Arc::clone(&self.ready);
        let downloads = self.downloads.clone();
        Box::pin(async move {
            let downloads =
                downloads.expect("outetts manager: download center not wired (main.rs)");
            OuteTtsDownloader::new()
                .ensure_installed(&downloads)
                .await
                .map_err(|e| anyhow::anyhow!("installing OuteTTS: {e:#}"))?;
            ready.store(true, Ordering::Relaxed);
            tracing::info!("OuteTTS ready (llama-tts + models present)");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let ready = Arc::clone(&self.ready);
        Box::pin(async move {
            ready.store(false, Ordering::Relaxed);
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let ready = Arc::clone(&self.ready);
        Box::pin(async move {
            if ready.load(Ordering::Relaxed) {
                HealthStatus::Healthy
            } else {
                HealthStatus::Unhealthy("OuteTTS not ready".into())
            }
        })
    }

    fn is_running(&self) -> bool {
        self.ready.load(Ordering::Relaxed)
    }

    fn uninstall(&self, delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_from_version_store("outetts");
            if delete_data {
                // OuteTTS's own weights folder only. `llama-tts` belongs to the
                // shared llama.cpp engine and stays.
                crate::sidecar::remove_dir(&downloader::models_dir()).await;
            }
            tracing::info!("outetts uninstalled");
            Ok(())
        })
    }
}

/// Synthesize speech from `text`, returning WAV bytes (16-bit PCM). Shells out to
/// `llama-tts -m <oute> -mv <wavtokenizer> -p <text> -o <tmp.wav>` and reads back
/// the generated file. Used by the `/api/voice/speak` data path.
pub async fn synthesize(text: &str) -> Result<Vec<u8>> {
    let binary = binary_path();
    if !binary.exists() {
        anyhow::bail!(
            "llama-tts binary not found at {}. Install + start the OuteTTS voice engine \
             from the Store first.",
            binary.display()
        );
    }
    let model = model_path();
    let vocoder = vocoder_path();
    if !model.exists() || !vocoder.exists() {
        anyhow::bail!(
            "OuteTTS models not found ({} / {}). Install the OuteTTS voice engine from the \
             Store first.",
            model.display(),
            vocoder.display()
        );
    }

    // Generate to a unique temp WAV path, then read the bytes back. Uniqueness
    // comes from the process id plus a per-process counter (no RNG dependency).
    let seq = TTS_SEQ.fetch_add(1, Ordering::Relaxed);
    let out_path = std::env::temp_dir().join(format!("ryu-tts-{}-{seq}.wav", std::process::id()));

    // Saved OuteTTS settings (threads, GPU offload, seed, …) ride after the
    // managed model, vocoder, prompt and output arguments.
    let launch = super::engine_launch_config("outetts").await;
    let mut tuning = crate::inference::native_args("outetts", &launch.native);
    tuning.extend(super::strip_managed_args(
        &launch.extra_args,
        &[
            "-m",
            "--model",
            "-mv",
            "--model-vocoder",
            "-p",
            "--prompt",
            "-o",
            "--output",
            "-f",
            "--file",
        ],
    ));

    let status = tokio::process::Command::new(&binary)
        .arg("-m")
        .arg(&model)
        .arg("-mv")
        .arg(&vocoder)
        .arg("-p")
        .arg(text)
        .arg("-o")
        .arg(&out_path)
        .args(&tuning)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .no_window()
        .status()
        .await
        .context("spawning llama-tts process")?;

    if !status.success() {
        anyhow::bail!("llama-tts exited with status {status}");
    }

    let bytes = tokio::fs::read(&out_path)
        .await
        .with_context(|| format!("reading generated wav at {}", out_path.display()))?;
    // Best-effort cleanup of the temp file; ignore failure.
    let _ = tokio::fs::remove_file(&out_path).await;
    if bytes.is_empty() {
        anyhow::bail!("llama-tts produced an empty audio file");
    }
    Ok(bytes)
}
