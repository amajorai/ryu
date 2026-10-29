pub mod installer;
pub mod process;

pub use process::SglangProcess;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;

use super::engine_child;
use super::readiness;
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use crate::win_process::NoWindow;
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

/// The model SGLang binds at launch: explicit `with_model` > the user's
/// active-model selection for this engine > `RYU_SGLANG_MODEL` > the small default.
/// Also answers which model a route that left `model` unset should request.
pub(crate) async fn launch_model(explicit: Option<String>) -> String {
    super::resolve_launch_model("sglang", explicit, "RYU_SGLANG_MODEL", DEFAULT_SGLANG_MODEL).await
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
                    "SGLang",
                    engine_child::READY_TIMEOUT,
                )
                .await?;
                running.store(true, Ordering::Relaxed);
                tracing::info!("sglang already running — nothing to start");
                return Ok(());
            }

            // Resolve the model: explicit `with_model` > the user's active-model
            // selection when it targets SGLang > `RYU_SGLANG_MODEL` env > a
            // sensible small default. SGLang cannot start without one, so we
            // never error here. `with_model` stays first (documented contract).
            let model = launch_model(model).await;

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
            readiness::ensure_port_free("sglang", port).await?;
            // Serve the installed snapshot from disk when there is one.
            let weights = crate::sidecar::providers::python_engine_model(&model);
            let mut proc = SglangProcess::new(python, weights.model_arg, port)
                .with_served_model_name(weights.served_name)
                .with_launch(launch);
            proc.start().await.context("spawning SGLang process")?;
            *process.lock().unwrap() = Some(proc);

            // Readiness is the live child answering the OpenAI API with the
            // model it was asked to serve — never a bare TCP connect, which a
            // stale listener on the port would satisfy.
            let probe = readiness::ReadyProbe {
                engine: "sglang",
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
                return Err(error).context("SGLang readiness check failed");
            }

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
                .no_window()
                .status()
                .await
            {
                Ok(s) if s.success() => tracing::info!("sglang pip package removed"),
                Ok(s) => tracing::warn!("pip uninstall sglang exited with {s}"),
                Err(e) => tracing::warn!("could not run pip uninstall sglang: {e}"),
            }

            crate::sidecar::remove_from_version_store("sglang");

            // `delete_data` deletes nothing outside Ryu, and nothing shared: the
            // weights live in the catalog's `models/chat/snapshots/` (removed
            // through the catalog) and the shared `models/hf` Hub cache that
            // every Ryu Python runtime uses. Never `~/.cache/huggingface`.
            let _ = delete_data;

            tracing::info!("sglang uninstalled");
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
        let mgr = SglangManager::new().with_port(port);
        let child = tokio::process::Command::new("/bin/sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleeping child fixture");
        *mgr.process.lock().unwrap() = Some(SglangProcess::from_child_for_test(child));
        let pid = || {
            mgr.process
                .lock()
                .unwrap()
                .as_ref()
                .and_then(SglangProcess::pid)
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
