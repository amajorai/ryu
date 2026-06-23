//! Lifecycle manager for the Restate durable-execution sidecar.
//!
//! Restate is the App-tier default durable engine (locked decision 6). It is
//! opt-in: when disabled Core boots and chat/workflows still run on the existing
//! petgraph-based fallback path. Enable via the sidecar catalog UI or the
//! install/start API (`POST /api/sidecars/restate/start`).
//!
//! Binary: `restate-server` from <https://github.com/restatedev/restate>.
//! Admin health endpoint: `GET http://localhost:9070/health` (200 == ready).

pub mod downloader;
pub mod process;

pub use downloader::RestateDownloader;
pub use process::RestateProcess;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// Lifecycle manager for the Restate server sidecar.
pub struct RestateManager {
    running: Arc<std::sync::atomic::AtomicBool>,
    process: Arc<Mutex<Option<RestateProcess>>>,
    client: reqwest::Client,
}

impl RestateManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            process: Arc::new(Mutex::new(None)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(Duration::from_secs(3))
                .build()
                .expect("reqwest client"),
        }
    }
}

impl Default for RestateManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for RestateManager {
    fn name(&self) -> &'static str {
        "restate"
    }

    fn is_required(&self) -> bool {
        // Opt-in: Core starts headless with the petgraph DAG fallback when
        // Restate is not installed. Never block Core startup.
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        Box::pin(async move {
            // Download binary if not already installed.
            RestateDownloader::new()
                .ensure_installed()
                .await
                .context("installing restate-server")?;

            let binary_path = downloader::bin_path();

            tracing::info!("restate sidecar starting");
            let mut proc = RestateProcess::new(binary_path);
            proc.start().await.context("spawning restate process")?;
            *process.lock().unwrap() = Some(proc);

            // Wait for the admin health endpoint to respond (timeout 30 s).
            let admin_url = restate_admin_url();
            let client = reqwest::Client::builder()
                .timeout(Duration::from_millis(500))
                .build()
                .unwrap_or_default();

            tokio::time::timeout(Duration::from_secs(30), async {
                loop {
                    if let Ok(resp) = client.get(&admin_url).send().await {
                        if resp.status().is_success() {
                            break;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            })
            .await
            .context("restate did not become healthy within 30s")?;

            running.store(true, Ordering::Relaxed);
            tracing::info!("restate sidecar started");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        Box::pin(async move {
            // Take the process out to avoid holding the mutex across awaits.
            let proc = process.lock().unwrap().take();
            if let Some(mut p) = proc {
                if let Err(e) = p.stop().await {
                    tracing::warn!("restate stop error: {e}");
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

            let url = restate_admin_url();
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => HealthStatus::Healthy,
                Ok(resp) => HealthStatus::Unhealthy(format!(
                    "restate admin health returned {}",
                    resp.status()
                )),
                Err(e) => HealthStatus::Unhealthy(format!("restate health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        let mut guard = self.process.lock().unwrap();
        guard.as_mut().map(|p| p.is_running()).unwrap_or(false)
    }

    fn uninstall(&self, delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_ryu_binary("restate-server").await;
            crate::sidecar::remove_from_version_store("restate");

            if delete_data {
                crate::sidecar::remove_dir(&crate::paths::ryu_dir().join("restate")).await;
            }

            tracing::info!("restate uninstalled");
            Ok(())
        })
    }
}

/// Returns the Restate admin health URL, configurable via `RYU_RESTATE_ADMIN_URL`.
pub fn restate_admin_url() -> String {
    std::env::var("RYU_RESTATE_ADMIN_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{}/health", process::RESTATE_ADMIN_PORT))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restate_manager_name() {
        let mgr = RestateManager::new();
        assert_eq!(mgr.name(), "restate");
    }

    #[test]
    fn restate_is_not_required() {
        let mgr = RestateManager::new();
        assert!(!mgr.is_required(), "restate must be opt-in (not required)");
    }

    #[test]
    fn restate_admin_url_default() {
        if std::env::var("RYU_RESTATE_ADMIN_URL").is_err() {
            let url = restate_admin_url();
            assert!(
                url.contains("9070"),
                "default admin URL should use port 9070, got {url}"
            );
        }
    }

    #[test]
    fn restate_admin_url_env_override() {
        let prev = std::env::var("RYU_RESTATE_ADMIN_URL").ok();
        std::env::set_var("RYU_RESTATE_ADMIN_URL", "http://example.test:9999/health");
        assert_eq!(restate_admin_url(), "http://example.test:9999/health");
        match prev {
            Some(v) => std::env::set_var("RYU_RESTATE_ADMIN_URL", v),
            None => std::env::remove_var("RYU_RESTATE_ADMIN_URL"),
        }
    }
}
