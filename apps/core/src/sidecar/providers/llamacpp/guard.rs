//! Local **guard tier**: an opt-in llama.cpp instance serving a guard model
//! for the node's own hazard screener (managed guardrails screener addendum,
//! build step G6).
//!
//! Modelled on the classify tier (`classify.rs`) but separate from it on
//! purpose. The classify tier's 270M judge is not a hazard classifier and its
//! 4096-token context cannot hold a screened chunk plus its context, so the
//! guard model gets its own process, its own port and a larger context.
//!
//! - **Off by default.** Not in `startup_order`, and onboarding never downloads
//!   its weights. It starts only when the operator opts the node in to the
//!   guard screener kind (`crate::sidecar::node_screener`), and that start
//!   downloads the pinned GGUF (sha256-checked) on first use.
//! - **Not a provider.** Core publishes its URL, model id and weights hash to
//!   the Gateway as screener environment variables, which a `[screening]`
//!   backend table names. It is never registered as a routable provider, so a
//!   request can never reach it through routing or `/v1/models`.
//! - **Never Ryu's floor.** A node's screener runs at node tier. Ryu's
//!   platform floor binds only the hosted fleet.
//!
//! The default model is Qwen3Guard-Gen 0.6B (`registry::local_guard_model`),
//! answered in the Gateway's `qwen3guard` dialect. `--jinja` is required: the
//! guard grammar comes from the GGUF's embedded chat template, and under a
//! generic template every reply is malformed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use anyhow::Context;

use crate::sidecar::providers::llamacpp::{
    process::{LlamaCppProcess, LlamaCppStartOptions},
    LlamaCppDownloader,
};
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// The name this sidecar is registered under. The installed-set gate in
/// `sidecar::onboarding` and the opt-in start in `sidecar::node_screener`
/// spell it through this const, never a literal.
pub const GUARD_SIDECAR_NAME: &str = "llamacpp-guard";

/// Canonical (release) loopback port of the guard server. Distinct from every
/// other llama.cpp satellite (8080 to 8083, 8088). Reserved in the plugin
/// manifest port check so no manifest sidecar can take it.
pub const GUARD_PORT_BASE: u16 = 8092;

/// Context window. Holds one 2048-token screened chunk, 2048 tokens of prior
/// context and the guard template, with a single slot.
pub const GUARD_CTX_SIZE: u32 = 8192;

/// Profile-aware guard port (release 8092, dev 9092).
pub fn guard_port() -> u16 {
    crate::profile::port(GUARD_PORT_BASE)
}

/// The OpenAI-compatible base the Gateway's guard backend dials.
pub fn guard_base_url() -> String {
    format!("http://127.0.0.1:{}/v1", guard_port())
}

fn guard_addr() -> String {
    format!("127.0.0.1:{}", guard_port())
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The launch flags for the guard model. Pure, so the contract is testable
/// without spawning anything.
fn launch_config(model_id: &str) -> crate::inference::LaunchConfig {
    crate::inference::LaunchConfig {
        ctx_size: Some(GUARD_CTX_SIZE),
        // The guard grammar lives in the GGUF's embedded chat template.
        jinja: Some(true),
        // One slot: the whole context serves one screen at a time. The node
        // tier's volume is one operator's traffic, not a fleet's.
        parallel: Some(1),
        extra_args: vec![
            // Serve the registry id from `/v1/models`, which the Gateway's
            // readiness probe matches against the published model id.
            "--alias".to_owned(),
            model_id.to_owned(),
            // A classifier: deterministic decoding.
            "--temp".to_owned(),
            "0".to_owned(),
        ],
        ..Default::default()
    }
}

/// Lifecycle manager for the opt-in llama.cpp guard sidecar.
pub struct LlamaCppGuardManager {
    running: Arc<AtomicBool>,
    process: Arc<Mutex<Option<LlamaCppProcess>>>,
    /// `true` when the server on the guard port is one this manager did not
    /// spawn. Same contract as the classify tier: `stop` leaves it alone and
    /// `is_running` reports the adoption.
    adopted_external: Arc<AtomicBool>,
    /// Why the last start failed, cleared by a successful start. Surfaced in
    /// the health reason so "not running" says why.
    last_failure: Arc<Mutex<Option<String>>>,
    client: reqwest::Client,
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl LlamaCppGuardManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            process: Arc::new(Mutex::new(None)),
            adopted_external: Arc::new(AtomicBool::new(false)),
            last_failure: Arc::new(Mutex::new(None)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .unwrap_or_default(),
            downloads: None,
        }
    }

    /// Inject the global download center (called at the `main.rs` build site).
    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }

    fn binary_path() -> std::path::PathBuf {
        super::variant::server_path()
    }

    /// Do we hold an OS child handle for a server we spawned? Ownership is
    /// about the handle, not the binary on disk (see `classify.rs`).
    fn holds_own_child(process: &Mutex<Option<LlamaCppProcess>>) -> bool {
        lock(process)
            .as_ref()
            .and_then(LlamaCppProcess::pid)
            .is_some()
    }

    fn child_is_alive(process: &Mutex<Option<LlamaCppProcess>>) -> bool {
        lock(process)
            .as_mut()
            .map(LlamaCppProcess::is_running)
            .unwrap_or(false)
    }

    async fn stop_held_child(process: &Mutex<Option<LlamaCppProcess>>) {
        let held = lock(process).take();
        if let Some(mut child) = held {
            let _ = child.stop().await;
        }
    }

    async fn server_reachable(client: &reqwest::Client) -> bool {
        client
            .get(format!("http://{}/health", guard_addr()))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// The guard GGUF, downloaded and sha256-checked on first use. The tier
    /// is opt-in, so its first start (not onboarding) owns the download.
    async fn ensure_weights(
        downloads: &crate::downloads::DownloadCenter,
    ) -> anyhow::Result<std::path::PathBuf> {
        let model = crate::registry::local_guard_model();
        let path = model.weight_path();
        if path.exists() {
            return Ok(path);
        }
        tracing::info!(
            model = %model.id,
            "{GUARD_SIDECAR_NAME}: downloading the guard model on first use"
        );
        downloads
            .download_blocking(crate::model_catalog::gguf_download_spec(
                &model.id,
                &model.weight_url,
                &model.sha256,
                &format!("{} (guard model)", model.id),
                crate::downloads::DownloadRole::ClassifierModel,
            ))
            .await
            .with_context(|| format!("downloading guard model {}", model.id))
    }

    async fn spawn(
        process: &Mutex<Option<LlamaCppProcess>>,
        downloads: Option<crate::downloads::DownloadCenter>,
    ) -> anyhow::Result<()> {
        let downloads = downloads
            .ok_or_else(|| anyhow::anyhow!("{GUARD_SIDECAR_NAME}: download center not wired"))?;
        LlamaCppDownloader::new()
            .ensure_installed(&downloads)
            .await
            .context("installing llama.cpp for the guard tier")?;
        let model_path = Self::ensure_weights(&downloads).await?;
        let model_id = crate::registry::local_guard_model().id;

        let mut child = LlamaCppProcess::new(Self::binary_path());
        child
            .start_with(LlamaCppStartOptions {
                port: guard_port(),
                model_path: Some(model_path),
                mmproj_path: None,
                // Carried by `launch.ctx_size`.
                ctx_size: 0,
                embeddings: false,
                reranking: false,
                launch: launch_config(&model_id),
            })
            .await
            .context("spawning llama-server (guard)")?;
        *lock(process) = Some(child);

        let ready = tokio::time::timeout(std::time::Duration::from_secs(120), async {
            loop {
                if tokio::net::TcpStream::connect(guard_addr()).await.is_ok() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        })
        .await;
        if ready.is_err() {
            Self::stop_held_child(process).await;
        }
        ready.context(format!("{GUARD_SIDECAR_NAME} did not start within 120s"))
    }
}

impl Default for LlamaCppGuardManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for LlamaCppGuardManager {
    fn name(&self) -> &'static str {
        GUARD_SIDECAR_NAME
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        let adopted_external = Arc::clone(&self.adopted_external);
        let last_failure = Arc::clone(&self.last_failure);
        let client = self.client.clone();
        let downloads = self.downloads.clone();
        Box::pin(async move {
            let addr = guard_addr();
            if Self::server_reachable(&client).await {
                let own_child = Self::holds_own_child(&process);
                adopted_external.store(!own_child, Ordering::Relaxed);
                running.store(true, Ordering::Relaxed);
                *lock(&last_failure) = None;
                tracing::info!(
                    "guard server already running on {addr}: {}",
                    if own_child {
                        "our own child is serving it"
                    } else {
                        "adopting a server we did not spawn"
                    }
                );
                return Ok(());
            }
            // Our child is alive but still loading (`/health` answers 503
            // until the model is in memory). Spawning again would kill it.
            if Self::child_is_alive(&process) {
                tracing::info!("guard server on {addr} is still loading");
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);
            Self::stop_held_child(&process).await;

            match Self::spawn(&process, downloads).await {
                Ok(()) => {
                    running.store(true, Ordering::Relaxed);
                    *lock(&last_failure) = None;
                    tracing::info!("{GUARD_SIDECAR_NAME} sidecar started on {addr}");
                    Ok(())
                }
                Err(error) => {
                    *lock(&last_failure) = Some(format!("{error:#}"));
                    Err(error)
                }
            }
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            running.store(false, Ordering::Relaxed);
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!("guard server was not spawned by Core: leaving it running");
                return Ok(());
            }
            let held = lock(&process).take();
            if let Some(mut child) = held {
                if let Err(e) = child.stop().await {
                    tracing::warn!("{GUARD_SIDECAR_NAME} stop error: {e}");
                }
            }
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let running = Arc::clone(&self.running);
        let last_failure = Arc::clone(&self.last_failure);
        let client = self.client.clone();
        Box::pin(async move {
            if !running.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy(match lock(&last_failure).clone() {
                    Some(reason) => format!("guard process not running: {reason}"),
                    None => "guard process not running".to_owned(),
                });
            }
            match client
                .get(format!("http://{}/health", guard_addr()))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => HealthStatus::Healthy,
                Ok(resp) => {
                    HealthStatus::Unhealthy(format!("health endpoint returned {}", resp.status()))
                }
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        if self.adopted_external.load(Ordering::Relaxed) {
            return true;
        }
        Self::holds_own_child(&self.process)
    }

    fn pid(&self) -> Option<u32> {
        lock(&self.process).as_ref().and_then(LlamaCppProcess::pid)
    }

    fn uninstall(&self, _delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // llama-server is shared with Chat, so only the sidecar marker is
            // removed. The guard model stays for a later re-enable.
            crate::sidecar::remove_from_version_store(GUARD_SIDECAR_NAME);
            tracing::info!(
                "guard tier uninstalled (shared llama.cpp binary and guard model left intact)"
            );
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_identity_is_stable_and_off_until_started() {
        let manager = LlamaCppGuardManager::new();
        assert_eq!(manager.name(), GUARD_SIDECAR_NAME);
        assert_eq!(GUARD_SIDECAR_NAME, "llamacpp-guard");
        assert!(!manager.is_required());
        assert!(!manager.is_running());
        assert_eq!(manager.pid(), None);
    }

    #[test]
    fn guard_uses_its_own_profile_aware_loopback_port() {
        assert_eq!(guard_port(), crate::profile::port(GUARD_PORT_BASE));
        for other in [
            8080, 8081, 8082, 8083, 8084, 8085, 8086, 8088, 8089, 8090, 8091,
        ] {
            assert_ne!(guard_port(), crate::profile::port(other), "{other}");
        }
        assert_eq!(
            guard_base_url(),
            format!("http://127.0.0.1:{}/v1", guard_port())
        );
    }

    #[test]
    fn guard_launch_applies_the_embedded_template_and_serves_the_registry_id() {
        let launch = launch_config("qwen3guard-gen-0.6b-q4_k_m");
        assert_eq!(launch.jinja, Some(true));
        assert_eq!(launch.ctx_size, Some(GUARD_CTX_SIZE));
        assert!(GUARD_CTX_SIZE >= 2048 + 2048 + 1024);
        assert_eq!(launch.parallel, Some(1));
        let alias = launch
            .extra_args
            .iter()
            .position(|a| a == "--alias")
            .and_then(|i| launch.extra_args.get(i + 1));
        assert_eq!(
            alias.map(String::as_str),
            Some("qwen3guard-gen-0.6b-q4_k_m")
        );
        let args = launch.to_args(crate::inference::Engine::LlamaCpp);
        assert!(args.iter().any(|a| a == "--jinja"), "{args:?}");
    }

    #[test]
    fn the_default_guard_model_is_pinned() {
        let model = crate::registry::local_guard_model();
        assert_eq!(model.id, crate::registry::DEFAULT_LOCAL_GUARD_MODEL_ID);
        assert_eq!(model.sha256.len(), 64);
        assert!(model.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(model.weight_url.starts_with("https://huggingface.co/"));
        assert!(model.weight_url.contains("/resolve/"));
        assert!(model.weight_path().ends_with(std::path::Path::new(
            "models/classifier/qwen3guard-gen-0.6b-q4_k_m.gguf"
        )));
    }

    #[tokio::test]
    async fn a_start_without_a_download_center_fails_with_a_reason_not_a_panic() {
        let manager = LlamaCppGuardManager::new();
        // Only meaningful when nothing answers on the guard port.
        if LlamaCppGuardManager::server_reachable(&manager.client).await {
            return;
        }
        let Err(error) = manager.start().await else {
            panic!("a start without a download center must be refused");
        };
        assert!(error.to_string().contains("download center not wired"));
        match manager.health_check().await {
            HealthStatus::Unhealthy(reason) => {
                assert!(reason.contains("download center not wired"), "{reason}");
            }
            other => panic!("expected unhealthy, got {other:?}"),
        }
    }
}
