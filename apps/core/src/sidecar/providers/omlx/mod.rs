//! oMLX provider — Apple-Silicon multi-model inference server (`omlx serve`).
//!
//! oMLX (jundot/omlx) is a high-performance local LLM inference server for Apple
//! Silicon with continuous batching and a two-tier (RAM + SSD) KV cache. It is
//! OpenAI- and Anthropic-compatible and serves text LLMs, VLMs, and embedding
//! models from a discovered model directory. Like the other chat engines it is a
//! swappable resident `Provider` (mutually exclusive with llamacpp/mlx-lm/…).
//!
//! Integration notes / honest caveats:
//!   - oMLX is **not on PyPI**; it is PATH-adopted with a best-effort install
//!     (Homebrew / `pip install git+…`) — see [`installer`].
//!   - It serves **nothing until a model is present** in its model dir, so a
//!     freshly-activated oMLX is an empty engine until the user adds a model
//!     (via oMLX's own `/admin` dashboard or by populating `~/.omlx/models`).
//!   - The exact `omlx serve` flag surface is **unverified here** (no Apple
//!     Silicon node to test on); we pass only the documented `--model-dir`.

pub mod installer;
pub mod process;

pub use process::OmlxProcess;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use process::DEFAULT_PORT;

pub struct OmlxManager {
    model_dir: Option<String>,
    port: u16,
    running: Arc<AtomicBool>,
    process: Arc<Mutex<Option<OmlxProcess>>>,
    client: reqwest::Client,
}

impl OmlxManager {
    pub fn new() -> Self {
        Self {
            model_dir: None,
            port: DEFAULT_PORT,
            running: Arc::new(AtomicBool::new(false)),
            process: Arc::new(Mutex::new(None)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
        }
    }

    /// Override the model directory oMLX discovers models from.
    pub fn with_model_dir(mut self, dir: impl Into<String>) -> Self {
        self.model_dir = Some(dir.into());
        self
    }
}

impl Default for OmlxManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for OmlxManager {
    fn name(&self) -> &'static str {
        "omlx"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let model_dir = self.model_dir.clone();
        let port = self.port;
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);

        Box::pin(async move {
            // Node-gate: oMLX only runs on Apple Silicon.
            installer::ensure_supported().context("oMLX is not supported on this node")?;

            // Ensure the binary is present (adopt or best-effort install).
            installer::ensure_installed()
                .await
                .context("installing oMLX")?;
            let binary = installer::omlx_binary()
                .await
                .context("oMLX binary not found after install")?;

            let model_dir = model_dir.unwrap_or_else(process::default_model_dir);
            tracing::info!("starting omlx (model-dir {model_dir}) on port {port}");

            let mut proc = OmlxProcess::new(binary, model_dir);
            proc.start().await.context("spawning oMLX process")?;
            *process.lock().unwrap() = Some(proc);

            // Wait up to 120 s for the HTTP server to become reachable.
            let addr = format!("127.0.0.1:{port}");
            tokio::time::timeout(std::time::Duration::from_secs(120), async {
                loop {
                    if tokio::net::TcpStream::connect(&addr).await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                }
            })
            .await
            .context("oMLX did not start within 120 s")?;

            running.store(true, Ordering::Relaxed);
            tracing::info!("omlx started");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        Box::pin(async move {
            let proc = { process.lock().unwrap().take() };
            if let Some(mut p) = proc {
                if let Err(e) = p.stop().await {
                    tracing::warn!("omlx stop error: {e}");
                }
            }
            running.store(false, Ordering::Relaxed);
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let running = Arc::clone(&self.running);
        let client = self.client.clone();
        let port = self.port;
        Box::pin(async move {
            if !running.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("omlx process not running".into());
            }

            // oMLX exposes the OpenAI-compatible `/v1/models` listing.
            let url = format!("http://127.0.0.1:{port}/v1/models");
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => HealthStatus::Healthy,
                Ok(resp) => {
                    HealthStatus::Unhealthy(format!("models endpoint returned {}", resp.status()))
                }
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        let mut guard = self.process.lock().unwrap();
        guard.as_mut().map(|p| p.is_running()).unwrap_or(false)
    }

    fn uninstall(&self, _delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // oMLX is user-installed (Homebrew / pip-git / .dmg); we don't own the
            // install, so we only drop our version record and leave removal to the
            // user's package manager (mirrors the Tailscale adopt model).
            crate::sidecar::remove_from_version_store(installer::VERSION_KEY);
            tracing::info!(
                "oMLX version record cleared; remove the binary via your installer \
                 (e.g. `brew uninstall omlx`) if desired"
            );
            Ok(())
        })
    }
}
