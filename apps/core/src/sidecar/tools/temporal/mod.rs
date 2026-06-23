pub mod downloader;
pub mod process;

pub use downloader::TemporalDownloader;
pub use process::TemporalProcess;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// Lifecycle manager for the Temporal CLI sidecar process.
pub struct TemporalManager {
    running: Arc<std::sync::atomic::AtomicBool>,
    process: Arc<Mutex<Option<TemporalProcess>>>,
    client: reqwest::Client,
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl TemporalManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            process: Arc::new(Mutex::new(None)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(Duration::from_secs(3))
                .build()
                .expect("reqwest client"),
            downloads: None,
        }
    }

    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }
}

impl Default for TemporalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for TemporalManager {
    fn name(&self) -> &'static str {
        "temporal"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        let downloads = self.downloads.clone();
        Box::pin(async move {
            let downloads =
                downloads.expect("temporal manager: download center not wired (main.rs)");
            // Download binary if not already installed.
            TemporalDownloader::new()
                .ensure_installed(&downloads)
                .await
                .context("installing temporal CLI")?;

            // Ensure the temporal working directory exists.
            let temporal_dir = crate::paths::ryu_dir().join("temporal");
            tokio::fs::create_dir_all(&temporal_dir)
                .await
                .context("creating ~/.ryu/temporal")?;

            // Construct and start the process.
            let binary_path = {
                let name = if cfg!(target_os = "windows") {
                    "temporal.exe"
                } else {
                    "temporal"
                };
                crate::paths::ryu_dir().join("bin").join(name)
            };

            tracing::info!("temporal sidecar starting");
            let mut proc = TemporalProcess::new(binary_path);
            proc.start().await.context("spawning temporal process")?;
            *process.lock().unwrap() = Some(proc);

            // Wait for the gRPC port to accept connections (timeout 30 s).
            tokio::time::timeout(Duration::from_secs(30), async {
                loop {
                    if tokio::net::TcpStream::connect("127.0.0.1:7233")
                        .await
                        .is_ok()
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await
            .context("temporal did not start within 30s")?;

            running.store(true, Ordering::Relaxed);
            tracing::info!("temporal sidecar started");
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
                    tracing::warn!("temporal stop error: {e}");
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

            match client
                .get("http://localhost:7234/api/v1/health")
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
        let mut guard = self.process.lock().unwrap();
        guard.as_mut().map(|p| p.is_running()).unwrap_or(false)
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_ryu_binary("temporal").await;
            crate::sidecar::remove_from_version_store("temporal");

            if delete_data {
                // Temporal dev server working directory and any SQLite db files
                // we store under <data>/temporal/.
                crate::sidecar::remove_dir(&crate::paths::ryu_dir().join("temporal")).await;
            }

            tracing::info!("temporal uninstalled");
            Ok(())
        })
    }
}
