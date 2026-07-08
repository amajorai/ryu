//! Apple Foundation Models via [apfel](https://github.com/Arthur-Ficial/apfel).
//!
//! apfel is a Swift CLI that exposes Apple's on-device `SystemLanguageModel`
//! (Apple Intelligence) as an **OpenAI-compatible HTTP server** — `apfel --serve`
//! binds `http://127.0.0.1:11434/v1` and reports a single model,
//! `apple-foundationmodel`. That makes it a drop-in *local engine* for Ryu: the
//! gateway's `local` provider forwards to it exactly like llama.cpp/Ollama, so
//! chat routed to `apple-foundationmodel` runs fully on-device with no API key.
//!
//! Lifecycle mirrors [`crate::sidecar::providers::OllamaManager`] (adopt-a-binary,
//! not download-a-weight): if a server is already answering on the port we adopt
//! it; otherwise we PATH-resolve/`brew install` apfel and spawn `apfel --serve`.
//! Apple FM is a built-in OS model, so there is never a weight file to fetch or a
//! per-model launch flag to pass — one process serves the one model.
//!
//! Placement (CLAUDE.md §1 Core-vs-Gateway): this is **Core** — it decides *what
//! runs* (which local engine renders a turn). Governance of the resulting model
//! call stays in the Gateway.
//!
//! Port note: apfel has no `--port` override and binds `:11434`, the same port
//! Ollama uses. The two are mutually exclusive — only one local engine is ever
//! resident (see [`crate::sidecar::active_engine`]) — mirroring the documented
//! oMLX/vLLM `:8000` share. If an *external* server already holds the port, the
//! adopt-check verifies it is really apfel (via `/health`) before trusting it.

pub mod installer;

/// The single model id apfel serves (Apple's on-device Foundation Model). apfel
/// validates the request's `model` field against this exact id, so Ryu must send
/// it verbatim — unlike llama.cpp/Ollama, which ignore the field. The gateway
/// router maps this id to the `local` provider; Pi advertises + sends it.
pub const APPLE_FM_MODEL_ID: &str = "apple-foundationmodel";

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

/// host:port `apfel --serve` binds (fixed; apfel exposes no `--port` flag).
const APFEL_ADDR: &str = "127.0.0.1:11434";
/// apfel's availability endpoint (reports Apple Intelligence readiness + context
/// window). Distinct from Ollama's `/api/version`, so a 200 here confirms the
/// server on the shared port is really apfel and not a stray Ollama daemon.
const APFEL_HEALTH_URL: &str = "http://127.0.0.1:11434/health";

/// Lifecycle manager for the apfel sidecar (Apple Foundation Models server).
pub struct ApfelManager {
    process: ProcessHandle,
    /// `true` when apfel was already serving before we tried to start it (e.g. a
    /// `brew services start apfel` background service). We don't own that process,
    /// so `stop` leaves it running, but health still reports green.
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
}

impl ApfelManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
            adopted_external: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .expect("reqwest client"),
        }
    }

    /// Returns `true` if an apfel server is already answering `/health`.
    async fn server_reachable(client: &reqwest::Client) -> bool {
        matches!(
            client.get(APFEL_HEALTH_URL).send().await,
            Ok(resp) if resp.status().is_success()
        )
    }
}

impl Default for ApfelManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for ApfelManager {
    fn name(&self) -> &'static str {
        "apfel"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            // Node-gate: Apple FM only runs on Apple Silicon macOS 26+. Refuse here
            // (not just at the install route) so the auto-start/swap path can never
            // spawn it on an unsupported node.
            installer::ensure_supported()
                .context("Apple Foundation Models are not supported on this node")?;

            // Adopt an already-running server (e.g. `brew services start apfel`)
            // rather than spawning a competitor that would fail to bind :11434.
            if Self::server_reachable(&client).await {
                adopted_external.store(true, Ordering::Relaxed);
                tracing::info!("apfel already running on {APFEL_ADDR} — adopting existing server");
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            installer::ensure_installed()
                .await
                .context("installing apfel")?;

            tracing::info!("apfel sidecar starting (apfel --serve)");
            // `--serve` starts the OpenAI-compat server; `--permissive` relaxes
            // Apple's guardrails so benign agent prompts aren't refused as
            // false-positives. apfel binds 127.0.0.1:11434 (loopback only), so no
            // auth token is needed — same posture as llama.cpp/Ollama.
            process
                .start_path_with_args("apfel", &["--serve".into(), "--permissive".into()])
                .await
                .context("spawning `apfel --serve`")?;

            // Wait up to 60 s for the HTTP port to accept connections. Apple FM is
            // resident on the device, so first-token latency is model-warmup, not a
            // download — 60 s is generous headroom.
            tokio::time::timeout(std::time::Duration::from_secs(60), async {
                loop {
                    if tokio::net::TcpStream::connect(APFEL_ADDR).await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            })
            .await
            .context("apfel did not start within 60 s")?;

            tracing::info!("apfel sidecar started");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            // We never spawned an adopted external server, so we must not kill it.
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!("apfel was an adopted external server — leaving it running");
                return Ok(());
            }
            process.stop().await.context("stopping apfel process")?;
            tracing::info!("apfel sidecar stopped");
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            let owned_running = process.is_running();
            if !owned_running && !adopted_external.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("apfel process not running".into());
            }
            match client.get(APFEL_HEALTH_URL).send().await {
                Ok(resp) if resp.status().is_success() => HealthStatus::Healthy,
                Ok(resp) => {
                    HealthStatus::Unhealthy(format!("health endpoint returned {}", resp.status()))
                }
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running() || self.adopted_external.load(Ordering::Relaxed)
    }

    fn uninstall(&self, _delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // apfel is a Homebrew-managed binary; best-effort `brew uninstall`.
            // Apple FM's weights are part of the OS and are never removed here.
            match tokio::process::Command::new("brew")
                .args(["uninstall", "apfel"])
                .status()
                .await
            {
                Ok(s) if s.success() => tracing::info!("apfel Homebrew formula removed"),
                Ok(s) => tracing::warn!("`brew uninstall apfel` exited with {s}"),
                Err(e) => tracing::warn!("could not run `brew uninstall apfel`: {e}"),
            }
            crate::sidecar::remove_from_version_store("apfel");
            tracing::info!("apfel uninstalled");
            Ok(())
        })
    }
}
