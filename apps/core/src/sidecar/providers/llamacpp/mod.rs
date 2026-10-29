pub mod classify;
pub mod downloader;
pub mod embed;
pub mod guard;
pub mod process;
pub mod rerank;
mod satellite;
pub mod speech;
pub mod variant;

pub use classify::LlamaCppClassifyManager;
pub use downloader::LlamaCppDownloader;
pub use embed::LlamaCppEmbedManager;
pub use guard::LlamaCppGuardManager;
pub use process::LlamaCppProcess;
pub use rerank::LlamaCppRerankManager;
pub use speech::LlamaCppSpeechManager;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// Lifecycle manager for the llama.cpp sidecar process.
pub struct LlamaCppManager {
    running: Arc<std::sync::atomic::AtomicBool>,
    process: Arc<Mutex<Option<LlamaCppProcess>>>,
    client: reqwest::Client,
    /// Global download center (#456), injected at construction in `main.rs`.
    /// Routes the binary install through the center so it shows in the overlay.
    /// (`DownloadCenter` is itself a cheap `Arc` wrapper.)
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl LlamaCppManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            process: Arc::new(Mutex::new(None)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .expect("reqwest client"),
            downloads: None,
        }
    }

    /// Inject the global download center (called at the `main.rs` build site).
    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }
}

impl Default for LlamaCppManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve `(model_id, gguf_path)` for the GGUF llama.cpp should serve.
///
/// Precedence: a user-selected active model override stored in preferences
/// (`ACTIVE_MODEL_PREF`, the local stem of an installed file) when that file is
/// present on disk, else the registry default (`RYU_LOCAL_CHAT_MODEL_ID`, env-only —
/// `registry.json` has no key for it, because this function resolves the weight at
/// *serve* time and `sidecar::onboarding` downloaded it at a different moment; see
/// `registry::LocalModelEntry`). This keeps the served model a swappable runtime
/// choice — never hardcoded — while still degrading safely if the override points at
/// a file that was since deleted.
async fn resolve_active_chat_model(
    registry: &crate::registry::ModelRegistry,
) -> (String, std::path::PathBuf) {
    use crate::model_catalog::installed;

    if let Ok(prefs) = crate::server::preferences::PreferencesStore::open_default() {
        if let Ok(Some(raw)) = prefs.get(installed::ACTIVE_MODEL_PREF).await {
            // The pref is now a structured {engine, format, ref}; the legacy
            // bare-stem form is parsed as GGUF by `parse_active_pref`. llama.cpp
            // only serves GGUF, so honour the override only for a GGUF selection
            // (`ref` = stem); a non-GGUF selection belongs to another engine.
            if let Some(active) = installed::parse_active_pref(&raw) {
                if active.format == crate::model_format::ModelFormat::Gguf {
                    let stem = active.r#ref.trim();
                    if !stem.is_empty() {
                        let path = installed::model_file_path(stem);
                        if path.exists() {
                            return (stem.to_string(), path);
                        }
                        tracing::warn!(
                            "active local chat model override '{stem}' set but file missing; \
                             falling back to registry default"
                        );
                    }
                }
            }
        }
    }
    (
        registry.local_chat_model.id.clone(),
        registry.local_chat_model.weight_path(),
    )
}

/// Whether the GGUF weight file the chat sidecar would serve — the user's active
/// model override if one is set and its file exists, else the registry default —
/// is present on disk. A cheap disk stat: no download, no process start, and it
/// mirrors exactly what [`resolve_active_chat_model`] resolves at spawn, so it is
/// a faithful "can llama.cpp serve a completion right now?" predicate (weights
/// present ⇒ the sidecar lazily starts and serves; absent ⇒ every completion
/// 503s). Used by the chat router's fresh-node degradation guard.
pub async fn active_chat_model_present(registry: &crate::registry::ModelRegistry) -> bool {
    resolve_active_chat_model(registry).await.1.exists()
}

/// Preference key holding the resident chat engine's idle scale-to-zero timeout
/// in **seconds**. Passed to llama-server as `--sleep-idle-seconds` so the loaded
/// model unloads itself (weights + KV cache) from RAM/VRAM after this many
/// seconds of inactivity and transparently reloads on the next request — the LM
/// Studio "eject" / Ollama `OLLAMA_KEEP_ALIVE` behaviour, but automatic.
pub const SLEEP_IDLE_SECS_PREF: &str = "engine.llamacpp.sleep-idle-seconds";

/// The default idle timeout when the user hasn't chosen one: 5 minutes, matching
/// Ollama's `OLLAMA_KEEP_ALIVE` default (the de-facto industry standard for local
/// model keep-alive).
pub const DEFAULT_SLEEP_IDLE_SECS: u32 = 300;

/// Resolve the sleep-idle timeout for the resident chat engine from preferences.
/// Absent/unparseable ⇒ [`DEFAULT_SLEEP_IDLE_SECS`]; `0` ⇒ disabled (`None`, no
/// flag emitted); `n > 0` ⇒ `Some(n)` seconds. This is a **node-level lifecycle
/// policy**, not a per-model tuning knob, so it is authoritative over any value a
/// per-model launch config happens to carry for the field.
async fn resolve_sleep_idle_secs() -> Option<u32> {
    match crate::server::preferences::PreferencesStore::open_default() {
        Ok(prefs) => match prefs.get(SLEEP_IDLE_SECS_PREF).await {
            Ok(Some(raw)) => match raw.trim().parse::<u32>() {
                Ok(0) => None,
                Ok(n) => Some(n),
                Err(_) => Some(DEFAULT_SLEEP_IDLE_SECS),
            },
            _ => Some(DEFAULT_SLEEP_IDLE_SECS),
        },
        Err(_) => Some(DEFAULT_SLEEP_IDLE_SECS),
    }
}

/// Is the child in this slot still alive? Reaps an exited child (clearing the
/// handle), so a crashed server reads `false` and the next start respawns it.
/// The llama.cpp satellites (`classify`, `embed`, `rerank`) share this as their
/// "our child is still starting or serving" gate.
fn process_is_running(process: &Mutex<Option<LlamaCppProcess>>) -> bool {
    process
        .lock()
        .unwrap()
        .as_mut()
        .map(|process| process.is_running())
        .unwrap_or(false)
}

/// Take and stop whatever child the slot holds. A start that gives up on
/// readiness calls this so the next start spawns afresh instead of finding a
/// useless child still alive behind the [`process_is_running`] gate.
async fn stop_held_child(process: &Mutex<Option<LlamaCppProcess>>) {
    let held = process.lock().unwrap().take();
    if let Some(mut child) = held {
        let _ = child.stop().await;
    }
}

fn normalized_model_id(value: &str) -> Option<String> {
    let value = value.trim().replace('\\', "/");
    let leaf = value.rsplit('/').next().unwrap_or_default();
    let leaf = leaf.strip_suffix(".gguf").unwrap_or(leaf).trim();
    (!leaf.is_empty()).then(|| leaf.to_ascii_lowercase())
}

pub(crate) fn served_model_ids(payload: &serde_json::Value) -> Vec<String> {
    payload
        .get("data")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_owned)
        .collect()
}

pub(crate) fn model_identity_matches(expected: &str, payload: &serde_json::Value) -> bool {
    let Some(expected) = normalized_model_id(expected) else {
        return false;
    };
    served_model_ids(payload)
        .iter()
        .filter_map(|id| normalized_model_id(id))
        .any(|id| id == expected)
}

/// Wait for the newly spawned llama-server child and verify the model it actually
/// serves. A TCP listener alone is insufficient: when a previous Core left a
/// llama-server on the port, a new child can fail its bind while the readiness
/// probe connects to the stale listener and labels it with the new model.
async fn wait_for_ready(
    client: &reqwest::Client,
    process: &Mutex<Option<LlamaCppProcess>>,
    port: u16,
    expected_model: Option<&str>,
) -> anyhow::Result<()> {
    let health_url = format!("http://127.0.0.1:{port}/health");
    let models_url = format!("http://127.0.0.1:{port}/v1/models");
    tokio::time::timeout(std::time::Duration::from_secs(120), async {
        loop {
            if !process_is_running(process) {
                anyhow::bail!("llama.cpp process exited before becoming ready");
            }

            let health_ready = client
                .get(&health_url)
                .send()
                .await
                .map(|response| response.status().is_success())
                .unwrap_or(false);
            if !health_ready {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }

            // A no-model process is an intentional install-only/degraded mode:
            // health is the readiness contract because there is no expected model
            // id to compare. It still must be backed by the child we just spawned.
            let Some(expected_model) = expected_model else {
                if process_is_running(process) {
                    return Ok(());
                }
                anyhow::bail!("llama.cpp process exited before becoming ready");
            };

            let response = client.get(&models_url).send().await;
            let Ok(response) = response else {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            };
            if !response.status().is_success() {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
            let payload = response
                .json::<serde_json::Value>()
                .await
                .context("llama.cpp returned invalid /v1/models JSON")?;
            if !model_identity_matches(expected_model, &payload) {
                let served = served_model_ids(&payload);
                anyhow::bail!(
                    "llama.cpp served model mismatch: expected '{expected_model}', got [{}]",
                    served.join(", ")
                );
            }
            if process_is_running(process) {
                return Ok(());
            }
            anyhow::bail!("llama.cpp process exited after reporting its model");
        }
    })
    .await
    .context("llama.cpp did not become ready within 120s")?
}

impl Sidecar for LlamaCppManager {
    fn name(&self) -> &'static str {
        "llamacpp"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        let client = self.client.clone();
        let downloads = self.downloads.clone();
        Box::pin(async move {
            // Never respawn a resident engine: a second llama-server cannot bind
            // the port, and storing it in the slot drops (kills) the child that is
            // serving, mid-stream. A crashed child is reaped here and falls through
            // to a fresh spawn. Model switches use `restart_sidecar` (stop, then
            // start), so they never reach this with a live child.
            if process_is_running(&process) {
                tracing::info!("llama.cpp already running — nothing to start");
                return Ok(());
            }

            // Download binary if not already installed — through the download
            // center (#456) so it streams to disk and shows in the overlay.
            let downloads =
                downloads.expect("llama.cpp manager: download center not wired (main.rs)");
            LlamaCppDownloader::new()
                .ensure_installed(&downloads)
                .await
                .context("installing llama.cpp")?;

            // Resolve model path from the registry. The model file must have been
            // downloaded by onboarding (or by the user). If absent we start without
            // a model (the server still responds — every completion call will error
            // until a model is loaded, but the process health check passes).
            let registry = crate::registry::ModelRegistry::from_env();
            // Resolve which GGUF to serve: a user-selected active model override
            // (set via `POST /api/models/active` — the deep-link "switch" / "Use
            // this model" action) takes precedence over the registry default,
            // falling through whenever it is unset or its file is missing.
            let (chat_model_id, candidate_path) = resolve_active_chat_model(&registry).await;
            let model_path = {
                if candidate_path.exists() {
                    tracing::info!("llama.cpp will serve model: {}", candidate_path.display());
                    Some(candidate_path)
                } else {
                    tracing::warn!(
                        "GGUF model not found at {} — starting llama-server without a model",
                        candidate_path.display()
                    );
                    None
                }
            };

            // Construct and start the process. The binary lives inside the
            // installed build's own directory (`engines/chat/llamacpp/`), beside
            // that backend's `ggml-*` libraries.
            let binary_path = variant::server_path();

            // Advanced per-model launch config (#mtp-advanced-inference): resolve
            // the tuning flags for the model being served, falling back to a
            // per-engine config when the model has none. Opening a fresh handle to
            // the shared preferences DB keeps the Sidecar trait surface unchanged.
            let mut launch = match crate::server::preferences::PreferencesStore::open_default() {
                Ok(prefs) => {
                    prefs
                        .resolve_launch_config(&chat_model_id, "llamacpp")
                        .await
                }
                Err(e) => {
                    tracing::warn!("could not open preferences for launch config: {e}");
                    crate::inference::LaunchConfig::default()
                }
            };
            // Continuous-batching defaults (memory-aware) — applied at spawn when
            // the user hasn't pinned them, so the single resident engine batches
            // Ryu's fan-out (delegate / threads / teams) instead of serializing.
            // Kept out of persisted config so a different machine recomputes.
            launch.apply_llamacpp_batching_defaults();
            // Idle scale-to-zero: the resident chat model unloads itself after the
            // configured idle window (default 5 min) and transparently reloads on
            // the next request. Node-level policy, so it overrides the per-model
            // field. Emitted as `--sleep-idle-seconds`; omitted when disabled.
            launch.sleep_idle_secs = resolve_sleep_idle_secs().await;
            // A CPU build must not be asked to offload layers. On macOS this is
            // the ONLY thing separating a CPU run from a Metal one (upstream
            // ships a single Apple Silicon archive with Metal compiled in), and
            // on every platform it makes "CPU" mean CPU even when a stale
            // per-model `gpu_layers` is still persisted from a GPU run.
            let running_variant = variant::installed_variant();
            if running_variant == Some(variant::LlamaVariant::Cpu) {
                launch.gpu_layers = Some(0);
            }
            if !launch.is_empty() {
                tracing::info!(
                    "llama.cpp applying advanced launch config for model {}: {:?}",
                    chat_model_id,
                    launch.to_args(crate::inference::Engine::LlamaCpp)
                );
            }

            // Resolve the vision adapter bound to the served model by the on-disk
            // convention (`<model>.mmproj.gguf`). Present ⇒ launch with `--mmproj`
            // so a multimodal model accepts images; absent ⇒ plain text launch.
            // This runs for both the registry default and a runtime active-model
            // switch, since both arrive here via `model_path`.
            let mmproj_path = model_path.as_deref().and_then(process::mmproj_for_model);
            if let Some(mm) = &mmproj_path {
                tracing::info!("llama.cpp will load vision adapter: {}", mm.display());
            }

            tracing::info!("llama.cpp sidecar starting");
            let mut proc = LlamaCppProcess::new(binary_path);
            let expected_model = model_path.as_ref().map(|_| chat_model_id.as_str());
            let opts = process::LlamaCppStartOptions {
                // Profile-aware chat-engine port; the client resolves the same
                // `profile::port(8080)` in `active_engine`.
                port: crate::profile::port(8080),
                model_path,
                mmproj_path,
                ctx_size: 0,
                embeddings: false,
                reranking: false,
                launch,
            };
            proc.start_with(opts)
                .await
                .context("spawning llama.cpp process")?;
            *process.lock().unwrap() = Some(proc);

            // Model loading can be slow (tens of seconds for a 806 MB Q4 file),
            // so readiness allows up to 120s. The probe verifies both the child
            // liveness and the model returned by the actual OpenAI endpoint.
            if let Err(error) = wait_for_ready(
                &client,
                &process,
                crate::profile::port(8080),
                expected_model,
            )
            .await
            {
                stop_held_child(&process).await;
                return Err(error).context("llama.cpp readiness check failed");
            }

            running.store(true, Ordering::Relaxed);
            tracing::info!("llama.cpp sidecar started");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        Box::pin(async move {
            let proc = process.lock().unwrap().take();
            if let Some(mut p) = proc {
                if let Err(e) = p.stop().await {
                    tracing::warn!("llama.cpp stop error: {e}");
                }
            }
            running.store(false, Ordering::Relaxed);
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let running = Arc::clone(&self.running);
        let client = self.client.clone();
        Box::pin(async move {
            if !running.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("process not running".into());
            }

            // Probe the SAME profile-aware port the engine was spawned on
            // (release 8080, dev 9080, …). A hardcoded :8080 here reported the
            // engine permanently unhealthy under any non-release profile.
            let health_url = format!("http://127.0.0.1:{}/health", crate::profile::port(8080));
            match client.get(&health_url).send().await {
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

    fn pid(&self) -> Option<u32> {
        self.process.lock().unwrap().as_ref().and_then(|p| p.pid())
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // The whole installed build — binary, `llama-tts`, the backend's
            // `ggml-*` libraries and the variant marker — lives in one directory.
            crate::sidecar::remove_dir(&variant::install_dir()).await;
            crate::sidecar::remove_from_version_store("llamacpp");

            // `delete_data` removes nothing more: the chat GGUFs in
            // `models/chat/` are catalog installs shared with every other chat
            // engine and are removed through the catalog, not with the engine.
            let _ = delete_data;

            tracing::info!("llamacpp uninstalled");
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::Json, http::StatusCode, routing::get, Router};
    use serde_json::json;
    use tokio::net::TcpListener;

    #[cfg(unix)]
    async fn readiness_fixture(models: serde_json::Value) -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind readiness fixture");
        let port = listener
            .local_addr()
            .expect("read readiness fixture address")
            .port();
        let models = Arc::new(models);
        let app = Router::new()
            .route("/health", get(|| async { StatusCode::OK }))
            .route(
                "/v1/models",
                get({
                    let models = Arc::clone(&models);
                    move || {
                        let models = Arc::clone(&models);
                        async move { Json((*models).clone()) }
                    }
                }),
            );
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (port, task)
    }

    #[cfg(unix)]
    fn sleeping_process() -> Mutex<Option<LlamaCppProcess>> {
        let child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep fixture");
        Mutex::new(Some(LlamaCppProcess::from_child_for_test(child)))
    }

    #[cfg(unix)]
    async fn stop_process(process: &Mutex<Option<LlamaCppProcess>>) {
        let child = process.lock().unwrap().take();
        if let Some(mut child) = child {
            child.stop().await.expect("stop fixture child");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_accepts_the_model_reported_by_the_openai_endpoint() {
        let (port, fixture) = readiness_fixture(json!({
            "data": [{ "id": "/tmp/gemma-4-E2B-it-Q4_K_M.gguf" }]
        }))
        .await;
        let process = sleeping_process();

        wait_for_ready(
            &reqwest::Client::new(),
            &process,
            port,
            Some("gemma-4-E2B-it-Q4_K_M"),
        )
        .await
        .expect("matching model should be ready");

        stop_process(&process).await;
        fixture.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_rejects_a_stale_listener_serving_another_model() {
        let (port, fixture) = readiness_fixture(json!({
            "data": [{ "id": "gemma-3-270m-it-qat-Q4_0" }]
        }))
        .await;
        let process = sleeping_process();

        let error = wait_for_ready(
            &reqwest::Client::new(),
            &process,
            port,
            Some("gemma-4-E2B-it-Q4_K_M"),
        )
        .await
        .expect_err("a stale model must not satisfy readiness");
        assert!(error.to_string().contains("served model mismatch"));
        assert!(error.to_string().contains("gemma-4-E2B-it-Q4_K_M"));
        assert!(error.to_string().contains("gemma-3-270m-it-qat-Q4_0"));

        stop_process(&process).await;
        fixture.abort();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn no_model_mode_uses_health_readiness_without_an_identity_requirement() {
        let (port, fixture) = readiness_fixture(json!({ "data": [] })).await;
        let process = sleeping_process();

        wait_for_ready(&reqwest::Client::new(), &process, port, None)
            .await
            .expect("no-model install mode should use health readiness");

        stop_process(&process).await;
        fixture.abort();
    }

    /// A second start (start-all, the services panel) while the engine is
    /// resident must not spawn a competitor and replace — and so kill — the
    /// serving child. Returning before `downloads.expect` also proves no spawn
    /// path ran: this manager has no download center wired.
    #[cfg(unix)]
    #[tokio::test]
    async fn start_keeps_a_live_engine_instead_of_respawning() {
        let mgr = LlamaCppManager::new();
        *mgr.process.lock().unwrap() = sleeping_process().into_inner().unwrap();
        let pid = mgr.pid();
        assert!(pid.is_some());

        mgr.start().await.expect("a live engine is already started");
        assert_eq!(mgr.pid(), pid, "the serving child must not be replaced");
        assert!(mgr.is_running());

        stop_process(&mgr.process).await;
    }

    /// The live-child gate the satellites share reaps an exited child, so crash
    /// recovery still respawns instead of trusting a dead handle.
    #[cfg(unix)]
    #[test]
    fn process_is_running_reaps_an_exited_child() {
        let mut child = std::process::Command::new("/usr/bin/true")
            .spawn()
            .expect("spawn exited child fixture");
        child.wait().expect("wait exited child fixture");
        let process = Mutex::new(Some(LlamaCppProcess::from_child_for_test(child)));
        assert!(!process_is_running(&process));
        assert!(process
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|process| process.pid().is_none()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_held_child_empties_the_slot() {
        let process = sleeping_process();
        stop_held_child(&process).await;
        assert!(process.lock().unwrap().is_none());
        assert!(!process_is_running(&process));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_fails_when_the_new_child_exits_before_the_listener_answers() {
        let (port, fixture) = readiness_fixture(json!({ "data": [] })).await;
        let mut child = std::process::Command::new("/usr/bin/true")
            .spawn()
            .expect("spawn exited child fixture");
        child.wait().expect("wait exited child fixture");
        let process = Mutex::new(Some(LlamaCppProcess::from_child_for_test(child)));

        let error = wait_for_ready(&reqwest::Client::new(), &process, port, None)
            .await
            .expect_err("an exited child must not satisfy TCP readiness");
        assert!(error.to_string().contains("process exited"));
        assert!(process
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|process| process.pid().is_none()));

        fixture.abort();
    }
}
