pub mod derived;
pub mod downloader;
pub use downloader::OllamaDownloader;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

/// Default host:port that `ollama serve` binds to.
const OLLAMA_ADDR: &str = "127.0.0.1:11434";
const OLLAMA_HEALTH_URL: &str = "http://127.0.0.1:11434/api/version";
/// Native (non-OpenAI) API root, used for `/api/show` and `/api/create`.
const OLLAMA_API_BASE: &str = "http://127.0.0.1:11434";

/// Lifecycle manager for the ollama sidecar process.
///
/// `ollama serve` launches an HTTP server on `127.0.0.1:11434`. The binary is
/// downloaded by [`OllamaDownloader`]; this manager owns the running process via
/// the shared [`ProcessHandle`] and probes `/api/version` for health.
pub struct OllamaManager {
    process: ProcessHandle,
    /// `true` when ollama was already running before we tried to start it (e.g.
    /// a system-installed background service). We don't own that process, so
    /// `stop` is a no-op for it, but health still reports green.
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl OllamaManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
            adopted_external: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .expect("reqwest client"),
            downloads: None,
        }
    }

    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }

    fn binary_path() -> std::path::PathBuf {
        downloader::bin_path()
    }

    /// Env for a Ryu-spawned `ollama serve`: point `OLLAMA_MODELS` at the data
    /// dir's `models/chat/ollama`, unless the user set `OLLAMA_MODELS`
    /// themselves (then the inherited value wins).
    fn serve_env() -> anyhow::Result<Vec<(String, String)>> {
        if std::env::var_os("OLLAMA_MODELS").is_some_and(|v| !v.is_empty()) {
            return Ok(Vec::new());
        }
        let models = downloader::models_dir();
        std::fs::create_dir_all(&models)
            .with_context(|| format!("creating {}", models.display()))?;
        Ok(vec![(
            "OLLAMA_MODELS".to_string(),
            models.to_string_lossy().into_owned(),
        )])
    }

    /// Returns `true` if an ollama server is already answering on its port.
    async fn server_reachable(client: &reqwest::Client) -> bool {
        matches!(
            client.get(OLLAMA_HEALTH_URL).send().await,
            Ok(resp) if resp.status().is_success()
        )
    }
}

/// Apply the per-model launch config (#mtp-advanced-inference) to the Ollama
/// model Ryu serves.
///
/// Ollama's daemon serves many models and takes no per-model launch CLI flags,
/// and its OpenAI-compat endpoint accepts no `options` passthrough, so launch
/// knobs are baked into a derived model (`FROM <base>` + `PARAMETER` lines, see
/// [`derived`]). Inference for the base name is then routed to the derived name
/// (Core's OpenAI proxy and, through the Gateway spawn env, the Gateway's
/// `local` provider). Fail-soft: on any error the base model keeps serving and
/// the sidecar reports `Degraded` with the reason the settings were not applied.
async fn apply_launch_config(client: &reqwest::Client) {
    derived::clear_routes();
    derived::set_launch_status(None);

    let base = crate::model_catalog::active_model_ref_for_engine("ollama").await;
    let prefs = match crate::server::preferences::PreferencesStore::open_default() {
        Ok(prefs) => prefs,
        Err(e) => {
            tracing::warn!("could not open preferences for ollama launch config: {e}");
            return;
        }
    };
    let cfg = prefs
        .resolve_launch_config(base.as_deref().unwrap_or(""), "ollama")
        .await;
    let params = cfg.to_ollama_modelfile();
    if params.is_empty() {
        return;
    }
    let Some(base) = base else {
        tracing::info!(
            "ollama launch config present ({params:?}) but no Ollama model is selected; \
             it is applied when a model is activated on the Ollama engine"
        );
        return;
    };

    match derived::ensure_derived_model(client, OLLAMA_API_BASE, &base, &params).await {
        Ok(name) => {
            tracing::info!(
                base = %base,
                derived = %name,
                "ollama launch config applied via derived model"
            );
            derived::set_routes(&base, &name);
        }
        Err(e) => {
            tracing::warn!(
                base = %base,
                "could not create ollama derived model ({e:#}); serving the base model \
                 without launch settings"
            );
            derived::set_launch_status(Some(format!(
                "launch settings for '{base}' were not applied: {e:#}"
            )));
        }
    }
}

impl Default for OllamaManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for OllamaManager {
    fn name(&self) -> &'static str {
        "ollama"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        let downloads = self.downloads.clone();
        Box::pin(async move {
            // If a server is already up (e.g. a system ollama service), adopt it
            // rather than spawning a competing process that would fail to bind.
            if Self::server_reachable(&client).await {
                // The answering server may be our own child from an earlier start;
                // only a server we did not spawn counts as adopted, or the next
                // stop() would leave our child running.
                let own_child = process.is_running();
                adopted_external.store(!own_child, Ordering::Relaxed);
                tracing::info!(
                    "ollama already running on {OLLAMA_ADDR} — {}",
                    if own_child {
                        "our child is serving it"
                    } else {
                        "adopting existing server"
                    }
                );
                apply_launch_config(&client).await;
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            // Download the binary if it isn't installed yet.
            let downloads = downloads.expect("ollama manager: download center not wired (main.rs)");
            OllamaDownloader::new()
                .ensure_installed(&downloads)
                .await
                .context("installing ollama")?;

            let binary_path = Self::binary_path();
            tracing::info!("ollama sidecar starting ({})", binary_path.display());

            // `ollama serve` starts the HTTP server; the bare binary just prints help.
            let mut env = Self::serve_env()?;
            // Saved server environment (flash attention, KV cache type, parallel
            // requests, keep-alive, …). Only a Ryu-started daemon receives it;
            // an inherited variable of the same name stays authoritative.
            let launch = super::engine_launch_config("ollama").await;
            env.extend(
                crate::inference::native_env("ollama", &launch.native)
                    .into_iter()
                    .filter(|(name, _)| std::env::var_os(name).is_none()),
            );
            process
                .start_path_with_env(&binary_path.to_string_lossy(), &["serve".to_string()], &env)
                .await
                .context("spawning ollama serve process")?;

            // Wait for the HTTP port to accept connections.
            tokio::time::timeout(std::time::Duration::from_secs(30), async {
                loop {
                    if tokio::net::TcpStream::connect(OLLAMA_ADDR).await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            })
            .await
            .context("ollama did not start within 30s")?;

            apply_launch_config(&client).await;

            tracing::info!("ollama sidecar started");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            // Derived-model routes only make sense while this engine serves them.
            derived::clear_routes();
            derived::set_launch_status(None);
            // We never spawned the adopted external server, so we must not kill it.
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!("ollama was an adopted external server — leaving it running");
                return Ok(());
            }
            process.stop().await.context("stopping ollama process")?;
            tracing::info!("ollama sidecar stopped");
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            let owned_running = process.is_running();
            if !owned_running && !adopted_external.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("process not running".into());
            }

            match client.get(OLLAMA_HEALTH_URL).send().await {
                Ok(resp) if resp.status().is_success() => match derived::launch_status_message() {
                    Some(message) => HealthStatus::Degraded(message),
                    None => HealthStatus::Healthy,
                },
                Ok(resp) => {
                    HealthStatus::Unhealthy(format!("health endpoint returned {}", resp.status()))
                }
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running() || self.adopted_external.load(Ordering::Relaxed)
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_dir(&downloader::install_dir()).await;
            crate::sidecar::remove_from_version_store("ollama");

            if delete_data {
                // Only the model store a Ryu-spawned `ollama serve` wrote. Never
                // `~/.ollama`: that belongs to the user's own Ollama install.
                crate::sidecar::remove_dir(&downloader::models_dir()).await;
            }

            tracing::info!("ollama uninstalled");
            Ok(())
        })
    }
}
