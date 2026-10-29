//! Local Speech Processing engine — a dedicated llama.cpp instance for cleanup.
//!
//! The speech-processing engine runs alongside Chat, Voice Recognition, and
//! Embeddings. It serves the small S1-mini text normalizer on its own loopback
//! port so a cleanup request never evicts the resident chat model or changes
//! the ASR engine. The model is downloaded by Core onboarding and this sidecar
//! only loads and serves the file.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;

use crate::sidecar::providers::llamacpp::{
    process::{LlamaCppProcess, LlamaCppStartOptions},
    stop_held_child, wait_for_ready, LlamaCppDownloader,
};
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// Stable sidecar name used by the Core route, onboarding, and desktop layer.
pub const SPEECH_PROCESSING_SIDECAR_NAME: &str = "llamacpp-speech";

/// Stable engine id exposed to clients and persisted in the speech-processing
/// preference. It is separate from the sidecar name because one sidecar may
/// serve more than one model in a future release.
pub const SPEECH_PROCESSING_ENGINE_ID: &str = "s1-mini";

/// Canonical release port for the Speech Processing engine. Profile-aware
/// development runs use the same offset as the other llama.cpp satellites.
pub const SPEECH_PROCESSING_PORT_BASE: u16 = 8088;

/// Profile-aware Speech Processing port.
pub fn speech_processing_port() -> u16 {
    crate::profile::port(SPEECH_PROCESSING_PORT_BASE)
}

/// Loopback base URL for the Speech Processing engine.
pub fn speech_processing_base_url() -> String {
    format!("http://127.0.0.1:{}", speech_processing_port())
}

/// Lifecycle manager for the dedicated S1-mini llama.cpp server.
/// The Speech Processing launch config: saved settings over S1-mini's serving
/// contract. S1-mini is trained with Qwen3 thinking disabled and greedy
/// decoding, so those flags lead the raw args unless the user sets reasoning or
/// the template kwargs explicitly; saved raw args follow and win where
/// llama-server parses last-value-wins. Thinking is turned off with
/// `--reasoning off` (setting `enable_thinking` through the template kwargs is
/// deprecated upstream).
fn speech_launch_config(saved: crate::inference::LaunchConfig) -> crate::inference::LaunchConfig {
    let mut launch = saved;
    launch.ctx_size.get_or_insert(4096);
    launch.jinja.get_or_insert(true);
    let mut contract = Vec::new();
    let user_sets_thinking = ["reasoning", "chat_template_kwargs"].iter().any(|key| {
        launch
            .native
            .get(*key)
            .is_some_and(|value| !value.is_null())
    });
    if !user_sets_thinking {
        contract.extend(["--reasoning".to_owned(), "off".to_owned()]);
    }
    contract.extend(["--temp".to_owned(), "0".to_owned()]);
    contract.append(&mut launch.extra_args);
    launch.extra_args = contract;
    launch
}

pub struct LlamaCppSpeechManager {
    running: Arc<AtomicBool>,
    process: Arc<Mutex<Option<LlamaCppProcess>>>,
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl LlamaCppSpeechManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            process: Arc::new(Mutex::new(None)),
            adopted_external: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .expect("reqwest client"),
            downloads: None,
        }
    }

    /// Inject the global download center used to ensure the shared llama.cpp
    /// binary is present before this sidecar starts.
    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }

    fn binary_path() -> std::path::PathBuf {
        super::variant::server_path()
    }

    fn holds_own_child(process: &Mutex<Option<LlamaCppProcess>>) -> bool {
        process
            .lock()
            .unwrap()
            .as_ref()
            .and_then(LlamaCppProcess::pid)
            .is_some()
    }

    fn server_reachable(client: &reqwest::Client) -> impl std::future::Future<Output = bool> + '_ {
        async move {
            client
                .get(format!("{}/health", speech_processing_base_url()))
                .send()
                .await
                .map(|response| response.status().is_success())
                .unwrap_or(false)
        }
    }

    /// Stop a child left in the handle by a failed or superseded start.
    async fn stop_stale_child(process: &Mutex<Option<LlamaCppProcess>>) {
        let stale = process.lock().unwrap().take();
        if let Some(mut child) = stale {
            let _ = child.stop().await;
        }
    }
}

impl Default for LlamaCppSpeechManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for LlamaCppSpeechManager {
    fn name(&self) -> &'static str {
        SPEECH_PROCESSING_SIDECAR_NAME
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        let downloads = self.downloads.clone();
        Box::pin(async move {
            let addr = speech_processing_base_url();
            if Self::server_reachable(&client).await {
                let own_child = Self::holds_own_child(&process);
                adopted_external.store(!own_child, Ordering::Relaxed);
                running.store(true, Ordering::Relaxed);
                tracing::info!(
                    "Speech Processing server already running on {addr} — {}",
                    if own_child {
                        "our child is serving it"
                    } else {
                        "adopting an external server"
                    }
                );
                return Ok(());
            }

            adopted_external.store(false, Ordering::Relaxed);
            Self::stop_stale_child(&process).await;

            let downloads = downloads.ok_or_else(|| {
                anyhow::anyhow!("{SPEECH_PROCESSING_SIDECAR_NAME}: download center not wired")
            })?;
            LlamaCppDownloader::new()
                .ensure_installed(&downloads)
                .await
                .context("installing llama.cpp for Speech Processing")?;

            let registry = crate::registry::ModelRegistry::from_env();
            let model_path = registry.local_speech_model.weight_path();
            if !model_path.exists() {
                anyhow::bail!(
					"Speech Processing model not found at {} — onboarding may still be downloading S1-mini, or the download failed",
					model_path.display()
				);
            }

            let saved = crate::sidecar::providers::engine_launch_config("llamacpp-speech").await;
            let launch = speech_launch_config(saved);
            let mut child = LlamaCppProcess::new(Self::binary_path());
            child
                .start_with(LlamaCppStartOptions {
                    port: speech_processing_port(),
                    model_path: Some(model_path),
                    mmproj_path: None,
                    ctx_size: 0,
                    embeddings: false,
                    reranking: false,
                    launch,
                })
                .await
                .context("spawning llama-server (Speech Processing)")?;
            *process.lock().unwrap() = Some(child);

            // Require `/health` 2xx from a child that is still alive; a bare TCP
            // connect would accept a foreign listener after our child failed to bind.
            let ready = wait_for_ready(&client, &process, speech_processing_port(), None).await;
            if ready.is_err() {
                // Stop a child that never became ready so the next start spawns afresh.
                stop_held_child(&process).await;
            }
            ready.context("Speech Processing did not become ready")?;

            running.store(true, Ordering::Relaxed);
            tracing::info!("Speech Processing sidecar started on {addr} with S1-mini");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            running.store(false, Ordering::Relaxed);
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!(
                    "Speech Processing server was not spawned by Core — leaving it running"
                );
                return Ok(());
            }
            let child = process.lock().unwrap().take();
            if let Some(mut child) = child {
                child.stop().await?;
            }
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let running = Arc::clone(&self.running);
        let client = self.client.clone();
        Box::pin(async move {
            if !running.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("Speech Processing process not running".to_owned());
            }
            match client
                .get(format!("{}/health", speech_processing_base_url()))
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => HealthStatus::Healthy,
                Ok(response) => HealthStatus::Unhealthy(format!(
                    "Speech Processing health endpoint returned {}",
                    response.status()
                )),
                Err(error) => HealthStatus::Unhealthy(format!(
                    "Speech Processing health check failed: {error}"
                )),
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
        self.process
            .lock()
            .unwrap()
            .as_ref()
            .and_then(LlamaCppProcess::pid)
    }

    fn uninstall(&self, _delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // llama-server is shared with Chat, so only the sidecar marker is
            // removed. The model remains available for a later re-enable.
            crate::sidecar::remove_from_version_store(SPEECH_PROCESSING_SIDECAR_NAME);
            tracing::info!(
				"Speech Processing uninstalled (shared llama.cpp binary + S1-mini model left intact)"
			);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_launch_keeps_the_serving_contract_under_saved_settings() {
        let launch = speech_launch_config(crate::inference::LaunchConfig::default());
        assert_eq!(launch.ctx_size, Some(4096));
        assert_eq!(launch.jinja, Some(true));
        assert_eq!(launch.extra_args, vec!["--reasoning", "off", "--temp", "0"]);

        let saved = crate::inference::LaunchConfig {
            ctx_size: Some(2048),
            native: serde_json::json!({ "chat_template_kwargs": "{}" })
                .as_object()
                .cloned()
                .unwrap(),
            extra_args: vec!["--temp".to_owned(), "0.2".to_owned()],
            ..Default::default()
        };
        let launch = speech_launch_config(saved);
        assert_eq!(launch.ctx_size, Some(2048));
        assert_eq!(launch.extra_args, vec!["--temp", "0", "--temp", "0.2"]);
    }

    #[test]
    fn speech_engine_identity_is_stable() {
        let manager = LlamaCppSpeechManager::new();
        assert_eq!(manager.name(), "llamacpp-speech");
        assert_eq!(SPEECH_PROCESSING_ENGINE_ID, "s1-mini");
        assert_eq!(
            speech_processing_port(),
            crate::profile::port(SPEECH_PROCESSING_PORT_BASE)
        );
        assert!(!manager.is_required());
        assert!(!manager.is_running());
    }

    #[test]
    fn speech_engine_uses_a_separate_loopback_port() {
        assert_ne!(speech_processing_port(), crate::profile::port(8080));
        assert_ne!(speech_processing_port(), crate::profile::port(8081));
        assert_ne!(speech_processing_port(), crate::profile::port(8082));
        assert_ne!(speech_processing_port(), crate::profile::port(8083));
        assert_ne!(speech_processing_port(), crate::profile::port(8084));
    }
}
