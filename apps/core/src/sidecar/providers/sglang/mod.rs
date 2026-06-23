pub mod installer;
pub mod process;

pub use process::SglangProcess;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use process::DEFAULT_PORT;

/// Default model SGLang serves when none is configured. Like vLLM, SGLang binds
/// to a specific model at launch, so activation needs *a* model to start at all.
/// This is a sensible small default, not a lock: override it with the
/// `RYU_SGLANG_MODEL` env var (any HuggingFace repo id), or `with_model(...)`.
const DEFAULT_SGLANG_MODEL: &str = "Qwen/Qwen2.5-1.5B-Instruct";

pub struct SglangManager {
    model: Option<String>,
    port: u16,
    running: Arc<AtomicBool>,
    process: Arc<Mutex<Option<SglangProcess>>>,
    client: reqwest::Client,
}

impl SglangManager {
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

    /// Override the default port (30000).
    pub fn with_port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }
}

impl Default for SglangManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for SglangManager {
    fn name(&self) -> &'static str {
        "sglang"
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
            // Resolve the model: explicit `with_model` > the user's active-model
            // selection when it targets SGLang > `RYU_SGLANG_MODEL` env > a
            // sensible small default. SGLang cannot start without one, so we
            // never error here. `with_model` stays first (documented contract).
            let model = match model {
                Some(m) => m,
                None => match crate::model_catalog::active_model_ref_for_engine("sglang").await {
                    Some(r) => r,
                    None => std::env::var("RYU_SGLANG_MODEL")
                        .unwrap_or_else(|_| DEFAULT_SGLANG_MODEL.to_string()),
                },
            };

            installer::ensure_installed()
                .await
                .context("installing SGLang")?;

            let python = installer::python_cmd()
                .await
                .context("locating Python for SGLang")?;

            tracing::info!("starting sglang with model {model} on port {port}");

            // Advanced per-model launch config (#mtp-advanced-inference).
            let launch = match crate::server::preferences::PreferencesStore::open_default() {
                Ok(prefs) => prefs.resolve_launch_config(&model, "sglang").await,
                Err(e) => {
                    tracing::warn!("could not open preferences for sglang launch config: {e}");
                    crate::inference::LaunchConfig::default()
                }
            };
            let mut proc = SglangProcess::new(python, model, port).with_launch(launch);
            proc.start().await.context("spawning SGLang process")?;
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
            .context("SGLang did not start within 120 s")?;

            running.store(true, Ordering::Relaxed);
            tracing::info!("sglang started");
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
                    tracing::warn!("sglang stop error: {e}");
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
                return HealthStatus::Unhealthy("sglang process not running".into());
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
            // SGLang is a Python package — uninstall via pip.
            let python = installer::python_cmd()
                .await
                .unwrap_or_else(|_| "python3".to_string());

            tracing::info!("uninstalling sglang via pip");
            match tokio::process::Command::new(&python)
                .args(["-m", "pip", "uninstall", "-y", "sglang"])
                .status()
                .await
            {
                Ok(s) if s.success() => tracing::info!("sglang pip package removed"),
                Ok(s) => tracing::warn!("pip uninstall sglang exited with {s}"),
                Err(e) => tracing::warn!("could not run pip uninstall sglang: {e}"),
            }

            crate::sidecar::remove_from_version_store("sglang");

            if delete_data {
                // SGLang downloads models via HuggingFace Hub into
                // ~/.cache/huggingface/hub. Removing ~/.cache/huggingface clears
                // all downloaded model weights.
                if let Some(home) = dirs::home_dir() {
                    crate::sidecar::remove_dir(&home.join(".cache").join("huggingface")).await;
                }
            }

            tracing::info!("sglang uninstalled");
            Ok(())
        })
    }
}
