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

use super::engine_child;
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use crate::win_process::NoWindow;
use process::default_port;

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

/// The model MLX-VLM binds at launch: explicit `with_model` > the user's
/// active-model selection for this engine > `RYU_MLX_VLM_MODEL` > the default.
/// Also answers which model a route that left `model` unset should request.
pub(crate) async fn launch_model(explicit: Option<String>) -> String {
    super::resolve_launch_model(
        "mlx-vlm",
        explicit,
        "RYU_MLX_VLM_MODEL",
        DEFAULT_MLX_VLM_MODEL,
    )
    .await
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
            // Never respawn a resident engine: storing a new child drops the
            // serving one (spawned with kill_on_drop(false)), orphaning it with
            // its port and GPU memory. A child still loading after an earlier
            // readiness timeout is waited on again. Model switches stop first
            // (restart_sidecar / set_active_local_engine).
            if engine_child::held_child_is_running(&process) {
                engine_child::wait_for_listener(
                    &process,
                    port,
                    "MLX-VLM",
                    engine_child::READY_TIMEOUT,
                )
                .await?;
                running.store(true, Ordering::Relaxed);
                tracing::info!("mlx-vlm already running — nothing to start");
                return Ok(());
            }

            // Node-gate: MLX-VLM only runs on Apple Silicon. Refuse here too (not
            // just at the install route) so the auto-start path can never spawn it
            // on an unsupported node.
            installer::ensure_supported().context("MLX-VLM is not supported on this node")?;

            // Resolve the model: explicit `with_model` > the user's active-model
            // selection when it targets MLX-VLM > `RYU_MLX_VLM_MODEL` env > a
            // sensible small default. The server cannot bind without one, so we
            // never error here. `with_model` stays first (documented contract).
            let model = launch_model(model).await;

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
            // Serve the installed snapshot from disk when there is one.
            let weights = crate::sidecar::providers::python_engine_model(&model);
            let mut proc = MlxVlmProcess::new(python, weights.model_arg, port).with_launch(launch);
            proc.start().await.context("spawning MLX-VLM process")?;
            *process.lock().unwrap() = Some(proc);

            // Ready once the HTTP server accepts connections while the child we
            // just spawned is alive (never on a foreign listener on this port).
            engine_child::wait_for_listener(&process, port, "MLX-VLM", engine_child::READY_TIMEOUT)
                .await?;

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
                .no_window()
                .status()
                .await
            {
                Ok(s) if s.success() => tracing::info!("mlx-vlm pip package removed"),
                Ok(s) => tracing::warn!("pip uninstall mlx-vlm exited with {s}"),
                Err(e) => tracing::warn!("could not run pip uninstall mlx-vlm: {e}"),
            }

            crate::sidecar::remove_from_version_store(installer::VERSION_KEY);

            // `delete_data` deletes nothing outside Ryu, and nothing shared: the
            // weights live in the catalog's `models/chat/snapshots/` (removed
            // through the catalog) and the shared `models/hf` Hub cache that
            // every Ryu Python runtime uses. Never `~/.cache/huggingface`.
            let _ = delete_data;

            tracing::info!("mlx-vlm uninstalled");
            Ok(())
        })
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A second start (start-all, the services panel) while the engine is
    /// resident keeps the serving child instead of spawning a competitor that
    /// would replace, and so orphan, it. Returning before install also proves
    /// no spawn path ran.
    #[tokio::test]
    async fn start_keeps_a_live_engine_instead_of_respawning() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mgr = MlxVlmManager::new().with_port(port);
        let child = tokio::process::Command::new("/bin/sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleeping child fixture");
        *mgr.process.lock().unwrap() = Some(MlxVlmProcess::from_child_for_test(child));
        let pid = || {
            mgr.process
                .lock()
                .unwrap()
                .as_ref()
                .and_then(MlxVlmProcess::pid)
        };
        let serving = pid();
        assert!(serving.is_some());

        mgr.start().await.expect("a live engine is already started");
        assert_eq!(pid(), serving, "the serving child must not be replaced");
        assert!(mgr.is_running());

        mgr.stop().await.expect("stop the fixture child");
        assert!(!mgr.is_running());
    }
}
