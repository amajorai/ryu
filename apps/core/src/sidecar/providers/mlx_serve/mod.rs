//! mlx-serve as a swappable Ryu local engine.
//!
//! mlx-serve exposes the OpenAI-compatible API Ryu's Gateway already speaks.
//! This manager owns only the native server process and its loopback endpoint;
//! mlx-serve owns model discovery/loading in its own model directory. Ryu does
//! not expose mlx-serve's built-in agent/MCP loop as a second tool-execution
//! authority.

pub mod installer;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

/// Stable catalog and manager id.
pub const ENGINE_NAME: &str = "mlx-serve";
/// mlx-serve's documented release-profile default port.
pub const DEFAULT_PORT: u16 = 11234;
/// Explicit loopback bind; mlx-serve's upstream default has historically been
/// wider than Ryu's local-node boundary, so Core never relies on it.
pub const DEFAULT_HOST: &str = "127.0.0.1";

/// Profile-aware port used by both the child process and Ryu's Gateway URL.
pub fn default_port() -> u16 {
    crate::profile::port(DEFAULT_PORT)
}

fn health_url() -> String {
    format!("http://{DEFAULT_HOST}:{}/health", default_port())
}

fn models_url() -> String {
    format!("http://{DEFAULT_HOST}:{}/v1/models", default_port())
}

fn port_addr() -> String {
    format!("{DEFAULT_HOST}:{}", default_port())
}

fn model_dir() -> String {
    if let Ok(value) = std::env::var("RYU_MLX_SERVE_MODEL_DIR") {
        if !value.trim().is_empty() {
            return value;
        }
    }

    dirs::home_dir()
        .map(|home| {
            home.join(".mlx-serve")
                .join("models")
                .to_string_lossy()
                .into_owned()
        })
        .unwrap_or_else(|| "~/.mlx-serve/models".to_string())
}

pub struct MlxServeManager {
    process: ProcessHandle,
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
}

impl MlxServeManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
            adopted_external: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .expect("reqwest client"),
        }
    }

    /// Check the same local HTTP surface that Core will route to. `/health` is
    /// independent of model loading; `/v1/models` confirms the OpenAI surface
    /// is available even when the runtime has no model loaded yet.
    pub async fn server_reachable(client: &reqwest::Client) -> bool {
        let health_ok = matches!(
            client.get(health_url()).send().await,
            Ok(response) if response.status().is_success()
        );
        health_ok
            && matches!(
                client.get(models_url()).send().await,
                Ok(response) if response.status().is_success()
            )
    }

    async fn wait_until_reachable(client: &reqwest::Client) -> anyhow::Result<()> {
        tokio::time::timeout(std::time::Duration::from_secs(120), async {
            loop {
                if Self::server_reachable(client).await {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        })
        .await
        .context("mlx-serve did not expose /health and /v1/models within 120 seconds")
    }
}

impl Default for MlxServeManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for MlxServeManager {
    fn name(&self) -> &'static str {
        ENGINE_NAME
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            installer::ensure_supported().context("mlx-serve is not supported on this node")?;

            // A second start call must not reinterpret the child Core already
            // owns as an external server. This keeps stop ownership correct.
            if process.is_running() {
                adopted_external.store(false, Ordering::Relaxed);
                Self::wait_until_reachable(&client).await?;
                return Ok(());
            }

            // Adopt an already-running mlx-serve instance on the active profile
            // port. Ryu never stops an adopted process.
            if Self::server_reachable(&client).await {
                adopted_external.store(true, Ordering::Relaxed);
                tracing::info!("mlx-serve already reachable on {} — adopting", port_addr());
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            let binary = installer::ensure_installed()
                .await
                .context("installing or resolving mlx-serve")?;
            let port = default_port().to_string();
            let model_dir = model_dir();
            let args = vec![
                "--serve".to_string(),
                "--model-dir".to_string(),
                model_dir.clone(),
                "--host".to_string(),
                DEFAULT_HOST.to_string(),
                "--port".to_string(),
                port.clone(),
            ];
            tracing::info!(
                binary = %binary,
                %port,
                %model_dir,
                "starting mlx-serve"
            );
            process
                .start_path_with_clean_env(&binary, &args, &[])
                .await
                .context("spawning mlx-serve")?;

            Self::wait_until_reachable(&client).await?;
            tracing::info!("mlx-serve started on {}", port_addr());
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!("mlx-serve is externally managed — leaving adopted server running");
                return Ok(());
            }
            process.stop().await.context("stopping mlx-serve")
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            let owned_running = process.is_running();
            let adopted = adopted_external.load(Ordering::Relaxed);
            if !owned_running && !adopted {
                return HealthStatus::Unhealthy("mlx-serve process is not running".to_string());
            }
            if Self::server_reachable(&client).await {
                HealthStatus::Healthy
            } else {
                if adopted {
                    adopted_external.store(false, Ordering::Relaxed);
                }
                HealthStatus::Unhealthy(format!(
                    "mlx-serve /health or /v1/models is not reachable on {}",
                    port_addr()
                ))
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running() || self.adopted_external.load(Ordering::Relaxed)
    }

    fn uninstall(&self, _delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // Ryu does not own the Homebrew/release installation or
            // ~/.mlx-serve model cache. Uninstalling the Ryu entry clears only
            // our marker; package removal remains an operator action.
            crate::sidecar::remove_from_version_store(installer::VERSION_KEY);
            tracing::info!(
                "mlx-serve version record cleared; remove the binary via its installer if desired"
            );
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_name_and_port_are_stable() {
        assert_eq!(ENGINE_NAME, "mlx-serve");
        assert_eq!(DEFAULT_PORT, 11234);
        assert_eq!(DEFAULT_HOST, "127.0.0.1");
    }

    #[test]
    fn endpoint_helpers_use_profile_aware_loopback_urls() {
        assert!(health_url().starts_with("http://127.0.0.1:"));
        assert!(models_url().ends_with("/v1/models"));
        assert!(port_addr().starts_with("127.0.0.1:"));
    }

    #[test]
    fn manager_starts_stopped_and_is_optional() {
        let manager = MlxServeManager::new();
        assert!(!manager.is_required());
        assert!(!manager.is_running());
    }
}
