pub mod installer;
pub mod process;

pub use process::VllmProcess;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;

use super::engine_child;
use super::readiness;
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use crate::win_process::NoWindow;
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

/// The model vLLM binds at launch: explicit `with_model` > the user's
/// active-model selection for this engine > `RYU_VLLM_MODEL` > the small default.
/// Also answers which model a route that left `model` unset should request.
pub(crate) async fn launch_model(explicit: Option<String>) -> String {
    super::resolve_launch_model("vllm", explicit, "RYU_VLLM_MODEL", DEFAULT_VLLM_MODEL).await
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
        let client = self.client.clone();

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
                    "vLLM",
                    engine_child::READY_TIMEOUT,
                )
                .await?;
                running.store(true, Ordering::Relaxed);
                tracing::info!("vllm already running — nothing to start");
                return Ok(());
            }

            // Resolve the model to serve, in precedence order: explicit
            // `with_model` (caller override) > the user's active-model selection
            // when it targets vLLM > `RYU_VLLM_MODEL` env > a sensible small
            // default. vLLM cannot start without one, so we never error here —
            // activation always has a model to bind. Keeping `with_model` first
            // preserves the documented contract.
            let model = launch_model(model).await;

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
            readiness::ensure_port_free("vllm", port).await?;
            // Serve the installed snapshot from disk when there is one.
            let weights = crate::sidecar::providers::python_engine_model(&model);
            let mut proc = VllmProcess::new(python, weights.model_arg, port)
                .with_served_model_name(weights.served_name)
                .with_launch(launch);
            proc.start().await.context("spawning vLLM process")?;
            *process.lock().unwrap() = Some(proc);

            // Readiness is the live child answering the OpenAI API with the
            // model it was asked to serve — never a bare TCP connect, which a
            // stale listener on the port would satisfy.
            let probe = readiness::ReadyProbe {
                engine: "vllm",
                port,
                health_path: Some("/health"),
                expected_model: Some(model.as_str()),
                timeout: std::time::Duration::from_secs(120),
            };
            if let Err(error) = readiness::wait_for_child(&client, &probe, &process).await {
                let failed_child = process.lock().unwrap().take();
                if let Some(mut child) = failed_child {
                    let _ = child.stop().await;
                }
                return Err(error).context("vLLM readiness check failed");
            }

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
                .no_window()
                .status()
                .await
            {
                Ok(s) if s.success() => tracing::info!("vllm pip package removed"),
                Ok(s) => tracing::warn!("pip uninstall vllm exited with {s}"),
                Err(e) => tracing::warn!("could not run pip uninstall vllm: {e}"),
            }

            crate::sidecar::remove_from_version_store("vllm");

            // `delete_data` deletes nothing outside Ryu, and nothing shared: the
            // weights live in the catalog's `models/chat/snapshots/` (removed
            // through the catalog) and the shared `models/hf` Hub cache that
            // every Ryu Python runtime uses. Never `~/.cache/huggingface`.
            let _ = delete_data;

            tracing::info!("vllm uninstalled");
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
        let mgr = VllmManager::new().with_port(port);
        let child = tokio::process::Command::new("/bin/sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleeping child fixture");
        *mgr.process.lock().unwrap() = Some(VllmProcess::from_child_for_test(child));
        let pid = || {
            mgr.process
                .lock()
                .unwrap()
                .as_ref()
                .and_then(VllmProcess::pid)
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
