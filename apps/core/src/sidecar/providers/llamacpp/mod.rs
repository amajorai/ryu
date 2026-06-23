pub mod downloader;
pub mod embed;
pub mod process;

pub use downloader::LlamaCppDownloader;
pub use embed::LlamaCppEmbedManager;
pub use process::LlamaCppProcess;

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
/// present on disk, else the registry default (`registry.json`/env). This keeps
/// the served model a swappable runtime choice — never hardcoded — while still
/// degrading safely if the override points at a file that was since deleted.
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
        let downloads = self.downloads.clone();
        Box::pin(async move {
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

            // Construct and start the process.
            let binary_path = {
                let name = if cfg!(target_os = "windows") {
                    "llama-server.exe"
                } else {
                    "llama-server"
                };
                crate::paths::ryu_dir().join("bin").join(name)
            };

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
            let opts = process::LlamaCppStartOptions {
                port: 8080,
                model_path,
                mmproj_path,
                ctx_size: 0,
                embeddings: false,
                launch,
            };
            proc.start_with(opts)
                .await
                .context("spawning llama.cpp process")?;
            *process.lock().unwrap() = Some(proc);

            // Wait for the HTTP port to accept connections. Model loading can be
            // slow (tens of seconds for a 806 MB Q4 file), so we allow up to
            // 120 s before giving up.
            tokio::time::timeout(std::time::Duration::from_secs(120), async {
                loop {
                    if tokio::net::TcpStream::connect("127.0.0.1:8080")
                        .await
                        .is_ok()
                    {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            })
            .await
            .context("llama.cpp did not start within 120s")?;

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

            match client.get("http://localhost:8080/health").send().await {
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
            // Binary is "llama-server", not "llamacpp".
            crate::sidecar::remove_ryu_binary("llama-server").await;
            crate::sidecar::remove_from_version_store("llamacpp");

            if delete_data {
                // llama.cpp caches downloaded models in ~/.cache/llama.cpp
                if let Some(cache) = dirs::home_dir() {
                    crate::sidecar::remove_dir(&cache.join(".cache").join("llama.cpp")).await;
                }
            }

            tracing::info!("llamacpp uninstalled");
            Ok(())
        })
    }
}
