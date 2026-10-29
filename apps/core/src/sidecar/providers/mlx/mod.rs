pub mod installer;
pub mod process;

pub use process::MlxProcess;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;

use super::engine_child;
use super::readiness;
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

/// The model MLX binds at launch: explicit `with_model` > the user's
/// active-model selection for this engine > `RYU_MLX_MODEL` > the small default.
/// Also answers which model a route that left `model` unset should request.
pub(crate) async fn launch_model(explicit: Option<String>) -> String {
    super::resolve_launch_model("mlx", explicit, "RYU_MLX_MODEL", DEFAULT_MLX_MODEL).await
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
        let client = self.client.clone();

        Box::pin(async move {
            // Never respawn a resident engine: storing a new child drops the
            // serving one (spawned with kill_on_drop(false)), orphaning it with
            // its port and GPU memory. A child still loading after an earlier
            // readiness timeout is waited on again. Model switches stop first
            // (restart_sidecar / set_active_local_engine).
            if engine_child::held_child_is_running(&process) {
                engine_child::wait_for_listener(&process, port, "MLX", engine_child::READY_TIMEOUT)
                    .await?;
                running.store(true, Ordering::Relaxed);
                tracing::info!("mlx already running — nothing to start");
                return Ok(());
            }

            // Node-gate: MLX only runs on Apple Silicon. Refuse here too (not just
            // at the install route) so the auto-start path can never spawn it on an
            // unsupported node.
            installer::ensure_supported().context("MLX is not supported on this node")?;

            // Resolve the model: explicit `with_model` > the user's active-model
            // selection when it targets MLX > `RYU_MLX_MODEL` env > a sensible
            // small default. MLX cannot start without one, so we never error
            // here. `with_model` stays first (documented contract).
            let model = launch_model(model).await;

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
            readiness::ensure_port_free("mlx", port).await?;
            // Serve the installed snapshot from disk when there is one.
            let weights = crate::sidecar::providers::python_engine_model(&model);
            let mut proc = MlxProcess::new(python, weights.model_arg, port).with_launch(launch);
            proc.start().await.context("spawning MLX process")?;
            *process.lock().unwrap() = Some(proc);

            // Readiness is the live child answering `/health` and the OpenAI
            // API — never a bare TCP connect, which a stale listener on the port
            // would satisfy. `mlx_lm server`'s `/v1/models` lists only Hub-cache
            // repos with a sharded index (verified against ml-explore/mlx-lm
            // `server.py`), so the served model id cannot be required there; the
            // pre-spawn port check plus child liveness rule out a stale server.
            let probe = readiness::ReadyProbe {
                engine: "mlx",
                port,
                health_path: Some("/health"),
                expected_model: None,
                timeout: std::time::Duration::from_secs(120),
            };
            if let Err(error) = readiness::wait_for_child(&client, &probe, &process).await {
                let failed_child = process.lock().unwrap().take();
                if let Some(mut child) = failed_child {
                    let _ = child.stop().await;
                }
                return Err(error).context("MLX readiness check failed");
            }

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

            // `delete_data` deletes nothing outside Ryu, and nothing shared: the
            // weights live in the catalog's `models/chat/snapshots/` (removed
            // through the catalog) and the shared `models/hf` Hub cache that
            // every Ryu Python runtime uses. Never `~/.cache/huggingface`.
            let _ = delete_data;

            tracing::info!("mlx uninstalled");
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
        let mgr = MlxManager::new().with_port(port);
        let child = tokio::process::Command::new("/bin/sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleeping child fixture");
        *mgr.process.lock().unwrap() = Some(MlxProcess::from_child_for_test(child));
        let pid = || {
            mgr.process
                .lock()
                .unwrap()
                .as_ref()
                .and_then(MlxProcess::pid)
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
