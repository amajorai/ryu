//! Docker Model Runner (DMR) provider — an adopt-only local chat engine.
//!
//! DMR is Docker's built-in OpenAI-compatible model server. Unlike llama.cpp or
//! ollama, **Ryu does not download or spawn any binary for it**: it is part of
//! Docker Desktop (4.40+) / Docker Engine with the `model` plugin, and is enabled
//! by the user (Docker Desktop settings, or `docker desktop enable model-runner
//! --tcp 12434`). Once host TCP access is on, DMR serves an OpenAI-compatible API
//! at `http://localhost:12434/engines/v1`.
//!
//! This manager is therefore **pure adopt**: it detects whether DMR is reachable
//! and reports health/running off that, but never starts, stops, or installs the
//! Docker subsystem. The `/engines/v1` prefix is absorbed by the active-engine URL
//! mapping (`active_engine::local_engine_base_url` / `local_engine_url` return a
//! URL whose `/engines` segment makes the standard `{base}/v1/chat/completions`
//! and `{url}/chat/completions` joins resolve to DMR's real path), so no routing
//! code special-cases DMR.
//!
//! Known v1 limitation (shared with ollama): swapping to DMR re-points the engine
//! URL, but DMR expects its own model ids (`ai/<name>` for a model it has pulled),
//! not a local GGUF stem. Chatting against DMR therefore requires naming a model
//! DMR has pulled. Model pull/mapping is a tracked follow-on.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// Engine name (matches the catalog entry, `LOCAL_ENGINES`, and `startup_order`).
pub const ENGINE_NAME: &str = "docker-model-runner";

/// Default host TCP endpoint DMR serves on once host access is enabled. The
/// OpenAI-compatible API lives under `/engines/v1`; this is the bare host probed
/// for reachability.
const DMR_HOST: &str = "127.0.0.1:12434";
/// OpenAI-compatible models endpoint — a cheap GET used as the health probe.
const DMR_MODELS_URL: &str = "http://127.0.0.1:12434/engines/v1/models";

/// Lifecycle manager for the Docker Model Runner engine.
///
/// Pure adopt: holds no process. `running` tracks whether DMR was reachable at
/// the last `start`/`health_check`, so the sync `is_running()` can answer without
/// a network probe (mirrors ollama's `adopted_external` flag).
pub struct DockerModelRunnerManager {
    /// `true` once DMR has been adopted by `start` and is still reachable.
    /// Only `start` sets it; `stop` clears it and the health monitor must not
    /// re-adopt a stopped engine (mirrors llama-swap's `adopted` guard).
    running: Arc<AtomicBool>,
    client: reqwest::Client,
    models_url: String,
}

impl DockerModelRunnerManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .expect("reqwest client"),
            models_url: DMR_MODELS_URL.to_owned(),
        }
    }

    #[cfg(test)]
    fn with_models_url(mut self, models_url: String) -> Self {
        self.models_url = models_url;
        self
    }

    /// Returns `true` if DMR is answering on its OpenAI-compatible endpoint.
    pub async fn server_reachable(client: &reqwest::Client) -> bool {
        Self::models_reachable(client, DMR_MODELS_URL).await
    }

    async fn models_reachable(client: &reqwest::Client, models_url: &str) -> bool {
        matches!(
            client.get(models_url).send().await,
            Ok(resp) if resp.status().is_success()
        )
    }
}

impl Default for DockerModelRunnerManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for DockerModelRunnerManager {
    fn name(&self) -> &'static str {
        ENGINE_NAME
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let running = Arc::clone(&self.running);
        let client = self.client.clone();
        let models_url = self.models_url.clone();
        Box::pin(async move {
            // Adopt-only: Docker Desktop / Docker Engine owns the model runner.
            // We never spawn or install it — we only verify it is reachable.
            if Self::models_reachable(&client, &models_url).await {
                running.store(true, Ordering::Relaxed);
                tracing::info!("docker-model-runner reachable on {DMR_HOST} — adopting");
                return Ok(());
            }
            running.store(false, Ordering::Relaxed);
            Err(anyhow::anyhow!(
                "Docker Model Runner is not reachable on {DMR_HOST}. Enable it in Docker Desktop \
                 (Settings → AI → Model Runner) with host-side TCP access on port 12434, or run \
                 `docker desktop enable model-runner --tcp 12434`, then pull a model with \
                 `docker model pull ai/<model>`."
            ))
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let running = Arc::clone(&self.running);
        Box::pin(async move {
            // We never own the Docker subsystem, so stopping is just dropping our
            // adoption flag — Docker keeps the runner alive.
            running.store(false, Ordering::Relaxed);
            tracing::info!("docker-model-runner is externally managed — leaving it running");
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let running = Arc::clone(&self.running);
        let client = self.client.clone();
        let models_url = self.models_url.clone();
        Box::pin(async move {
            // A stopped engine must not be re-adopted by the health monitor.
            if !running.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy(
                    "docker-model-runner is not active in Ryu".to_owned(),
                );
            }
            if Self::models_reachable(&client, &models_url).await {
                HealthStatus::Healthy
            } else {
                running.store(false, Ordering::Relaxed);
                HealthStatus::Unhealthy(
                    "Docker Model Runner not reachable on 127.0.0.1:12434 (is it enabled with TCP host access?)".into(),
                )
            }
        })
    }

    fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    fn uninstall(&self, _delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        let running = Arc::clone(&self.running);
        Box::pin(async move {
            // Nothing to remove from disk — Ryu never installed a binary. Drop the
            // version-store marker so the engine no longer counts as installed, and
            // clear our adoption flag. Models pulled by `docker model` are Docker's
            // to manage, so `delete_data` is intentionally ignored.
            crate::sidecar::remove_from_version_store(ENGINE_NAME);
            running.store(false, Ordering::Relaxed);
            tracing::info!("docker-model-runner deregistered (Docker subsystem untouched)");
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_matches_engine_constant() {
        assert_eq!(
            DockerModelRunnerManager::new().name(),
            "docker-model-runner"
        );
        assert_eq!(ENGINE_NAME, "docker-model-runner");
    }

    #[test]
    fn is_not_required_and_starts_not_running() {
        let m = DockerModelRunnerManager::new();
        assert!(!m.is_required());
        assert!(!m.is_running());
    }

    #[tokio::test]
    async fn health_check_does_not_readopt_after_stop() {
        use axum::{routing::get, Json, Router};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route(
            "/engines/v1/models",
            get(|| async { Json(serde_json::json!({ "data": [] })) }),
        );
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let manager = DockerModelRunnerManager::new()
            .with_models_url(format!("http://127.0.0.1:{port}/engines/v1/models"));

        manager.start().await.expect("reachable DMR is adopted");
        assert!(manager.is_running());
        assert!(matches!(
            manager.health_check().await,
            HealthStatus::Healthy
        ));

        manager.stop().await.unwrap();
        // DMR is still reachable, but a stopped engine stays stopped.
        assert!(matches!(
            manager.health_check().await,
            HealthStatus::Unhealthy(_)
        ));
        assert!(!manager.is_running());
        server.abort();
    }
}
