pub mod installer;
pub mod process;

pub use process::VllmProcess;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use process::DEFAULT_PORT;

/// Default model vLLM serves when none is configured. vLLM (unlike llama.cpp /
/// Ollama) binds to a specific model at launch, so activation needs *a* model to
/// start at all. This is a sensible small default, not a lock: override it with
/// the `RYU_VLLM_MODEL` env var (any HuggingFace repo id), or `with_model(...)`.
const DEFAULT_VLLM_MODEL: &str = "Qwen/Qwen2.5-1.5B-Instruct";

pub struct VllmManager {
    model: Option<String>,
    port: u16,
    running: Arc<AtomicBool>,
    process: Arc<Mutex<Option<VllmProcess>>>,
    client: reqwest::Client,
}

impl VllmManager {
    pub fn new() -> Self {
        Self {
            model: None,
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

    /// Set the model to serve (e.g. `"Qwen/Qwen2.5-1.5B-Instruct"`).
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// Override the default port (8000).
    pub fn with_port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }
}

impl Default for VllmManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for VllmManager {
    fn name(&self) -> &'static str {
        "vllm"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let model = self.model.clone();
        let port = self.port;
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);

        Box::pin(async move {
            // Resolve the model to serve, in precedence order: explicit
            // `with_model` (caller override) > the user's active-model selection
            // when it targets vLLM > `RYU_VLLM_MODEL` env > a sensible small
            // default. vLLM cannot start without one, so we never error here —
            // activation always has a model to bind. Keeping `with_model` first
            // preserves the documented contract.
            let model = match model {
                Some(m) => m,
                None => match crate::model_catalog::active_model_ref_for_engine("vllm").await {
                    Some(r) => r,
                    None => std::env::var("RYU_VLLM_MODEL")
                        .unwrap_or_else(|_| DEFAULT_VLLM_MODEL.to_string()),
                },
            };

            installer::ensure_installed()
                .await
                .context("installing vLLM")?;

            let python = installer::python_cmd()
                .await
                .context("locating Python for vLLM")?;

            tracing::info!("starting vllm with model {model} on port {port}");

            // Advanced per-model launch config (#mtp-advanced-inference).
            let launch = match crate::server::preferences::PreferencesStore::open_default() {
                Ok(prefs) => prefs.resolve_launch_config(&model, "vllm").await,
                Err(e) => {
                    tracing::warn!("could not open preferences for vllm launch config: {e}");
                    crate::inference::LaunchConfig::default()
                }
            };
            let mut proc = VllmProcess::new(python, model, port).with_launch(launch);
            proc.start().await.context("spawning vLLM process")?;
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
            .context("vLLM did not start within 120 s")?;

            running.store(true, Ordering::Relaxed);
            tracing::info!("vllm started");
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
                    tracing::warn!("vllm stop error: {e}");
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
                return HealthStatus::Unhealthy("vllm process not running".into());
            }

            let url = format!("http://127.0.0.1:{port}/health");
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => HealthStatus::Healthy,
                Ok(resp) => {
                    HealthStatus::Unhealthy(format!("health endpoint returned {}", resp.status()))
                }
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        let mut guard = self.process.lock().unwrap();
        guard.as_mut().map(|p| p.is_running()).unwrap_or(false)
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // vLLM is a Python package — uninstall via pip.
            let python = installer::python_cmd()
                .await
                .unwrap_or_else(|_| "python3".to_string());

            tracing::info!("uninstalling vllm via pip");
            match tokio::process::Command::new(&python)
                .args(["-m", "pip", "uninstall", "-y", "vllm"])
                .status()
                .await
            {
                Ok(s) if s.success() => tracing::info!("vllm pip package removed"),
                Ok(s) => tracing::warn!("pip uninstall vllm exited with {s}"),
                Err(e) => tracing::warn!("could not run pip uninstall vllm: {e}"),
            }

            crate::sidecar::remove_from_version_store("vllm");

            if delete_data {
                // vLLM downloads models via HuggingFace Hub into ~/.cache/huggingface/hub.
                // Removing ~/.cache/huggingface clears all downloaded model weights.
                if let Some(home) = dirs::home_dir() {
                    crate::sidecar::remove_dir(&home.join(".cache").join("huggingface")).await;
                }
            }

            tracing::info!("vllm uninstalled");
            Ok(())
        })
    }
}
