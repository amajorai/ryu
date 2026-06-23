pub mod downloader;
pub mod process;

pub use downloader::SpiderDownloader;
pub use process::SpiderProcess;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// Lifecycle manager for the Spider CLI sidecar process.
pub struct SpiderManager {
    running: Arc<std::sync::atomic::AtomicBool>,
    process: Arc<Mutex<Option<SpiderProcess>>>,
}

impl SpiderManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            process: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for SpiderManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for SpiderManager {
    fn name(&self) -> &'static str {
        "spider"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        Box::pin(async move {
            // Download binary if not already installed.
            SpiderDownloader::new()
                .ensure_installed()
                .await
                .context("installing spider CLI")?;

            // Construct and start the process.
            let binary_path = {
                let name = if cfg!(target_os = "windows") {
                    "spider.exe"
                } else {
                    "spider"
                };
                crate::paths::ryu_dir().join("bin").join(name)
            };

            tracing::info!("spider sidecar starting");
            let mut proc = SpiderProcess::new(binary_path);
            proc.start().await.context("spawning spider process")?;
            *process.lock().unwrap() = Some(proc);

            running.store(true, Ordering::Relaxed);
            tracing::info!("spider sidecar started");
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
                    tracing::warn!("spider stop error: {e}");
                }
            }
            running.store(false, Ordering::Relaxed);
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let running = Arc::clone(&self.running);
        Box::pin(async move {
            if !running.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("process not running".into());
            }

            // Spider is a CLI tool, so we just check if the binary exists
            let binary_path = {
                let name = if cfg!(target_os = "windows") {
                    "spider.exe"
                } else {
                    "spider"
                };
                crate::paths::ryu_dir().join("bin").join(name)
            };

            if binary_path.exists() {
                HealthStatus::Healthy
            } else {
                HealthStatus::Unhealthy("spider binary not found".into())
            }
        })
    }

    fn is_running(&self) -> bool {
        let mut guard = self.process.lock().unwrap();
        guard.as_mut().map(|p| p.is_running()).unwrap_or(false)
    }
}
