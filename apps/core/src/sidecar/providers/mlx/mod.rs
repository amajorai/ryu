pub mod installer;
pub mod process;

pub use process::MlxProcess;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use crate::win_process::NoWindow;
use process::default_port;

/// Default model MLX serves when none is configured. Like vLLM/SGLang, MLX binds
/// to a specific model at launch, so activation needs *a* model to start at all.
/// MLX needs MLX-format weights — the idiomatic source is the `mlx-community/*`
/// org on the Hub, so the default is a small 4-bit Qwen there (not a raw
/// safetensors repo, which MLX cannot load). Not a lock: override with the
/// `RYU_MLX_MODEL` env var (any MLX-format Hub repo id), or `with_model(...)`.
const DEFAULT_MLX_MODEL: &str = "mlx-community/Qwen2.5-1.5B-Instruct-4bit";

pub struct MlxManager {
    model: Option<String>,
    port: u16,
    running: Arc<AtomicBool>,
    process: Arc<Mutex<Option<MlxProcess>>>,
    client: reqwest::Client,
}

impl MlxManager {
    pub fn new() -> Self {
        Self {
            model: None,
            port: default_port(),
            running: Arc::new(AtomicBool::new(false)),
            process: Arc::new(Mutex::new(None)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
        }
    }

    /// Set the model to serve (e.g. `"mlx-community/Qwen2.5-1.5B-Instruct-4bit"`).
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// Override the default port (8086).
    pub fn with_port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }
}

impl Default for MlxManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for MlxManager {
    fn name(&self) -> &'static str {
        "mlx"
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
            // Node-gate: MLX only runs on Apple Silicon. Refuse here too (not just
            // at the install route) so the auto-start path can never spawn it on an
            // unsupported node.
            installer::ensure_supported().context("MLX is not supported on this node")?;

            // Resolve the model: explicit `with_model` > the user's active-model
            // selection when it targets MLX > `RYU_MLX_MODEL` env > a sensible
            // small default. MLX cannot start without one, so we never error
            // here. `with_model` stays first (documented contract).
            let model = match model {
                Some(m) => m,
                None => match crate::model_catalog::active_model_ref_for_engine("mlx").await {
                    Some(r) => r,
                    None => std::env::var("RYU_MLX_MODEL")
                        .unwrap_or_else(|_| DEFAULT_MLX_MODEL.to_string()),
                },
            };

            installer::ensure_installed()
                .await
                .context("installing MLX")?;

            let python = installer::python_cmd()
                .await
                .context("locating Python for MLX")?;

            tracing::info!("starting mlx with model {model} on port {port}");

            // Advanced per-model launch config (#mtp-advanced-inference).
            let launch = match crate::server::preferences::PreferencesStore::open_default() {
                Ok(prefs) => prefs.resolve_launch_config(&model, "mlx").await,
                Err(e) => {
                    tracing::warn!("could not open preferences for mlx launch config: {e}");
                    crate::inference::LaunchConfig::default()
                }
            };
            let mut proc = MlxProcess::new(python, model, port).with_launch(launch);
            proc.start().await.context("spawning MLX process")?;
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
            .context("MLX did not start within 120 s")?;

            running.store(true, Ordering::Relaxed);
            tracing::info!("mlx started");
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
                    tracing::warn!("mlx stop error: {e}");
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
                return HealthStatus::Unhealthy("mlx process not running".into());
            }

            // `mlx_lm server` exposes a `/health` endpoint (verified against
            // ml-explore/mlx-lm `server.py`).
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
            // MLX is a Python package — uninstall via pip.
            let python = installer::python_cmd()
                .await
                .unwrap_or_else(|_| "python3".to_string());

            tracing::info!("uninstalling mlx via pip");
            match tokio::process::Command::new(&python)
                .args(["-m", "pip", "uninstall", "-y", installer::PIP_PACKAGE])
                .no_window()
                .status()
                .await
            {
                Ok(s) if s.success() => tracing::info!("mlx pip package removed"),
                Ok(s) => tracing::warn!("pip uninstall mlx-lm exited with {s}"),
                Err(e) => tracing::warn!("could not run pip uninstall mlx-lm: {e}"),
            }

            crate::sidecar::remove_from_version_store("mlx");

            if delete_data {
                // mlx-lm downloads models via HuggingFace Hub into
                // ~/.cache/huggingface/hub. Removing ~/.cache/huggingface clears
                // all downloaded model weights.
                if let Some(home) = dirs::home_dir() {
                    crate::sidecar::remove_dir(&home.join(".cache").join("huggingface")).await;
                }
            }

            tracing::info!("mlx uninstalled");
            Ok(())
        })
    }
}
