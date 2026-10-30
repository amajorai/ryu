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
//!
//! **Lean builds never claim to be running.** A build compiled without
//! `voice-parakeet` cannot transcribe at all, so this lifecycle refuses to start
//! and reports [`HealthStatus::Unhealthy`] naming the missing feature (see
//! [`FEATURE_MISSING`]). It used to download the model, `warn!` once, and then
//! mark itself loaded — which made `health_check()` say `Healthy`, `is_running()`
//! say `true`, and the desktop's `VoiceInputSettings` print "Running" for an
//! engine whose every transcription 500s. A capability the binary does not have
//! must be visibly absent, not silently broken.

pub mod downloader;

pub use downloader::{model_dir, model_present, ParakeetDownloader, MODEL_DIR_NAME};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// The one message every lean-build (`voice-parakeet` off) path reports, so
/// `start()`'s error and `health_check()`'s reason read identically wherever they
/// surface (sidecar list, Store row, `/api/voice/*` error body). Names the exact
/// remedy: pick whisper, or rebuild with the feature.
///
/// Only compiled where inference is absent — with it built, nothing references
/// it. That is a lean build, or Intel macOS: ONNX Runtime ships no
/// `x86_64-apple-darwin` build, so `ryu-stt` declares transcribe-rs for every
/// other target and the feature compiles no engine there (the release still
/// passes the same `--features` string at every build site).
#[cfg(not(feature = "voice-parakeet"))]
pub const FEATURE_MISSING: &str = "this Core build was compiled without the `voice-parakeet` \
     feature, so parakeet cannot transcribe on this node. Use the `whisper` voice engine, or \
     rebuild Core with `--features voice-parakeet` (see apps/core/package.json `build`).";
#[cfg(all(
    feature = "voice-parakeet",
    target_os = "macos",
    target_arch = "x86_64"
))]
pub const FEATURE_MISSING: &str = "ONNX Runtime has no Intel macOS build, so `voice-parakeet` \
     compiles no inference engine into this Core and parakeet cannot transcribe on this node. \
     Use the `whisper` voice engine.";

/// Lifecycle manager for the in-process parakeet STT engine.
pub struct ParakeetManager {
    /// `true` once the model has been ensured present (and, with the feature on,
    /// loaded into memory). Reflects "ready to transcribe".
    loaded: Arc<AtomicBool>,
    /// Global download center (#456), injected at construction in `main.rs`.
    /// Routes the model bundle download through the center so it shows in the
    /// overlay. (`DownloadCenter` is itself a cheap `Arc` wrapper.)
    ///
    /// `main.rs` wires this on every build, but only the `voice-parakeet` arm of
    /// [`Sidecar::start`] reads it — a lean build refuses before downloading
    /// anything, so the field is legitimately write-only there.
    #[cfg_attr(
        not(all(
            feature = "voice-parakeet",
            not(all(target_os = "macos", target_arch = "x86_64"))
        )),
        allow(dead_code)
    )]
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

    /// Ensure the model bundle is on disk, then load it into memory.
    ///
    /// On a lean build (`voice-parakeet` off) this **fails** instead of half-
    /// succeeding. Two reasons it must fail rather than warn-and-continue:
    /// storing `loaded = true` is what made a build that cannot transcribe report
    /// `Healthy`/`is_running()` to every surface; and there is no point pulling a
    /// multi-hundred-MB ONNX bundle for an inference path that is not compiled
    /// in, so the refusal comes *before* the download.
    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        #[cfg(all(
            feature = "voice-parakeet",
            not(all(target_os = "macos", target_arch = "x86_64"))
        ))]
        {
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

                // Preload the model so the first transcription is fast. `loaded`
                // is only ever set once inference is genuinely ready.
                ryu_stt::parakeet::preload(&model_dir())
                    .map_err(|e| anyhow::anyhow!("loading parakeet model: {e:#}"))?;
                tracing::info!("parakeet engine loaded (ONNX inference enabled)");

                loaded.store(true, Ordering::Relaxed);
                Ok(())
            })
        }
        #[cfg(not(all(
            feature = "voice-parakeet",
            not(all(target_os = "macos", target_arch = "x86_64"))
        )))]
        {
            Box::pin(async move { anyhow::bail!(FEATURE_MISSING) })
        }
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let loaded = Arc::clone(&self.loaded);
        Box::pin(async move {
            #[cfg(all(
                feature = "voice-parakeet",
                not(all(target_os = "macos", target_arch = "x86_64"))
            ))]
            ryu_stt::parakeet::unload();
            loaded.store(false, Ordering::Relaxed);
            tracing::info!("parakeet engine unloaded");
            Ok(())
        })
    }

    /// `Healthy` only when inference is compiled in *and* the model is loaded.
    ///
    /// On a lean build this is always `Unhealthy` and says why. `start()` already
    /// refuses, so `loaded` can never be true there — but stating it in the health
    /// arm too means the "Running" claim cannot be resurrected by any future flag
    /// write, and the reason travels to whatever renders the status.
    fn health_check(&self) -> BoxFuture<HealthStatus> {
        #[cfg(all(
            feature = "voice-parakeet",
            not(all(target_os = "macos", target_arch = "x86_64"))
        ))]
        {
            let loaded = Arc::clone(&self.loaded);
            Box::pin(async move {
                if loaded.load(Ordering::Relaxed) {
                    HealthStatus::Healthy
                } else {
                    HealthStatus::Unhealthy("parakeet model not loaded".into())
                }
            })
        }
        #[cfg(not(all(
            feature = "voice-parakeet",
            not(all(target_os = "macos", target_arch = "x86_64"))
        )))]
        {
            Box::pin(async move { HealthStatus::Unhealthy(FEATURE_MISSING.into()) })
        }
    }

    fn is_running(&self) -> bool {
        // Compile-time false on a lean build (the `cfg!` short-circuits): an
        // engine that cannot transcribe must never report itself as running to
        // the sidecar list, the Store row, or `VoiceInputSettings`.
        cfg!(all(
            feature = "voice-parakeet",
            not(all(target_os = "macos", target_arch = "x86_64"))
        )) && self.loaded.load(Ordering::Relaxed)
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

// The parakeet in-process ONNX inference engine (`preload`/`unload`/`transcribe`)
// now lives in the extracted `ryu-stt` crate (`ryu_stt::parakeet`) — the
// genuinely in-process STT hot path, never IPC. This module keeps only the
// Sidecar *lifecycle* (download + load/unload + health), which is Core sidecar
// infra: `start`/`stop` above call `ryu_stt::parakeet::{preload,unload}`, and the
// `/api/voice/transcribe` data path routes through `ryu_stt::transcribe_wav*`
// (wired in `apps/core/src/stt_host.rs`).

#[cfg(test)]
mod tests {
    use super::*;

    /// The lean-build honesty contract. This is the arm that regressed: `start()`
    /// used to download the model, `warn!`, and still store `loaded = true`, so a
    /// binary with no ONNX inference reported `Healthy`/running while every
    /// transcription 500'd. Only compiled where it can actually be false — with
    /// the feature on there is no lean arm to assert.
    #[cfg(not(all(
        feature = "voice-parakeet",
        not(all(target_os = "macos", target_arch = "x86_64"))
    )))]
    #[tokio::test]
    async fn lean_build_refuses_to_start_and_never_reports_running() {
        // No download center wired ON PURPOSE: the refusal must land *before* the
        // download (the old code would have panicked on the `expect` here, which
        // is itself proof the download came first).
        let manager = ParakeetManager::new();

        let err = manager
            .start()
            .await
            .expect_err("a build without `voice-parakeet` must refuse to start");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("voice-parakeet"),
            "the start error must name the missing feature: {msg}"
        );

        assert!(
            !manager.is_running(),
            "an engine that cannot transcribe must never report itself running"
        );
        match manager.health_check().await {
            HealthStatus::Unhealthy(reason) => assert!(
                reason.contains("voice-parakeet"),
                "the health reason must name the missing feature: {reason}"
            ),
            other => panic!("lean build must be Unhealthy, got {other:?}"),
        }
    }

    /// The feature-on arm keeps its original contract: not loaded yet ⇒ not
    /// running and `Unhealthy("…not loaded")`. Pinned so the lean-arm fix above
    /// can never be "achieved" by making the engine unconditionally unhealthy.
    #[cfg(all(
        feature = "voice-parakeet",
        not(all(target_os = "macos", target_arch = "x86_64"))
    ))]
    #[tokio::test]
    async fn feature_build_is_unhealthy_until_the_model_is_loaded() {
        let manager = ParakeetManager::new();
        assert!(!manager.is_running());
        match manager.health_check().await {
            HealthStatus::Unhealthy(reason) => assert!(reason.contains("not loaded")),
            other => panic!("expected Unhealthy before load, got {other:?}"),
        }
    }
}
