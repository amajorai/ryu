//! MLX-VLM provider — Apple-Silicon vision/omni inference (`mlx_vlm.server`).
//!
//! This is the multimodal sibling of the `mlx` (mlx-lm) provider. It serves the
//! same OpenAI-compatible `/v1/chat/completions` surface, so it is a swappable
//! resident chat engine (a `Provider`, mutually exclusive with mlx-lm/llamacpp),
//! and adds image/audio/video *input* on top. NOTE: forwarding image content
//! blocks through Core's openai_compat adapter is a separate wire-up — today the
//! engine serves text end-to-end and vision is latent until that path lands.

pub mod installer;
pub mod process;

pub use process::MlxVlmProcess;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use process::DEFAULT_PORT;

/// Default model MLX-VLM serves when none is configured. Like mlx-lm/vLLM/SGLang,
/// the server binds to a specific model, so activation needs *a* model to start.
/// MLX-VLM needs MLX-format VLM weights — the idiomatic source is the
/// `mlx-community/*` org on the Hub, so the default is a small 4-bit Qwen-VL.
/// Not a lock: override with the `RYU_MLX_VLM_MODEL` env var (any MLX-format Hub
/// repo id), or `with_model(...)`.
const DEFAULT_MLX_VLM_MODEL: &str = "mlx-community/Qwen2.5-VL-3B-Instruct-4bit";

pub struct MlxVlmManager {
    model: Option<String>,
    port: u16,
    running: Arc<AtomicBool>,
    process: Arc<Mutex<Option<MlxVlmProcess>>>,
    client: reqwest::Client,
}

impl MlxVlmManager {
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

    /// Set the model to serve (e.g. `"mlx-community/Qwen2.5-VL-3B-Instruct-4bit"`).
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// Override the default port (8084).
    pub fn with_port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }
}

impl Default for MlxVlmManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for MlxVlmManager {
    fn name(&self) -> &'static str {
        "mlx-vlm"
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
            // Node-gate: MLX-VLM only runs on Apple Silicon. Refuse here too (not
            // just at the install route) so the auto-start path can never spawn it
            // on an unsupported node.
            installer::ensure_supported().context("MLX-VLM is not supported on this node")?;

            // Resolve the model: explicit `with_model` > the user's active-model
            // selection when it targets MLX-VLM > `RYU_MLX_VLM_MODEL` env > a
            // sensible small default. The server cannot bind without one, so we
            // never error here. `with_model` stays first (documented contract).
            let model = match model {
                Some(m) => m,
                None => match crate::model_catalog::active_model_ref_for_engine("mlx-vlm").await {
                    Some(r) => r,
                    None => std::env::var("RYU_MLX_VLM_MODEL")
                        .unwrap_or_else(|_| DEFAULT_MLX_VLM_MODEL.to_string()),
                },
            };

            installer::ensure_installed()
                .await
                .context("installing MLX-VLM")?;

            let python = installer::python_cmd()
                .await
                .context("locating Python for MLX-VLM")?;

            tracing::info!("starting mlx-vlm with model {model} on port {port}");

            // Advanced per-model launch config (#mtp-advanced-inference).
            let launch = match crate::server::preferences::PreferencesStore::open_default() {
                Ok(prefs) => prefs.resolve_launch_config(&model, "mlx-vlm").await,
                Err(e) => {
                    tracing::warn!("could not open preferences for mlx-vlm launch config: {e}");
                    crate::inference::LaunchConfig::default()
                }
            };
            let mut proc = MlxVlmProcess::new(python, model, port).with_launch(launch);
            proc.start().await.context("spawning MLX-VLM process")?;
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
            .context("MLX-VLM did not start within 120 s")?;

            running.store(true, Ordering::Relaxed);
            tracing::info!("mlx-vlm started");
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
                    tracing::warn!("mlx-vlm stop error: {e}");
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
                return HealthStatus::Unhealthy("mlx-vlm process not running".into());
            }

            // mlx_vlm.server exposes the OpenAI-compatible `/v1/models` listing;
            // a 200 there means the FastAPI app is up.
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

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // MLX-VLM is a Python package — uninstall via pip.
            let python = installer::python_cmd()
                .await
                .unwrap_or_else(|_| "python3".to_string());

            tracing::info!("uninstalling mlx-vlm via pip");
            match tokio::process::Command::new(&python)
                .args(["-m", "pip", "uninstall", "-y", installer::PIP_PACKAGE])
                .status()
                .await
            {
                Ok(s) if s.success() => tracing::info!("mlx-vlm pip package removed"),
                Ok(s) => tracing::warn!("pip uninstall mlx-vlm exited with {s}"),
                Err(e) => tracing::warn!("could not run pip uninstall mlx-vlm: {e}"),
            }

            crate::sidecar::remove_from_version_store(installer::VERSION_KEY);

            if delete_data {
                // mlx-vlm downloads models via HuggingFace Hub into
                // ~/.cache/huggingface/hub. Removing ~/.cache/huggingface clears
                // all downloaded model weights.
                if let Some(home) = dirs::home_dir() {
                    crate::sidecar::remove_dir(&home.join(".cache").join("huggingface")).await;
                }
            }

            tracing::info!("mlx-vlm uninstalled");
            Ok(())
        })
    }
}
