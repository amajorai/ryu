pub mod downloader;
pub mod process;

pub use downloader::ScreenpipeDownloader;
pub use process::ScreenpipeProcess;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// Lifecycle manager for the Screenpipe sidecar process.
/// ZeroClaw connects to Screenpipe via MCP for screen context.
pub struct ScreenpipeSidecar {
    running: Arc<std::sync::atomic::AtomicBool>,
    process: Arc<Mutex<Option<ScreenpipeProcess>>>,
}

impl ScreenpipeSidecar {
    pub fn new() -> Self {
        Self {
            running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            process: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for ScreenpipeSidecar {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for ScreenpipeSidecar {
    fn name(&self) -> &'static str {
        "screenpipe"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        Box::pin(async move {
            // Ensure node is available
            ScreenpipeDownloader::new()
                .ensure_installed()
                .await
                .context("installing screenpipe dependencies")?;

            tracing::info!("screenpipe sidecar starting");
            let mut proc = ScreenpipeProcess::new();
            proc.start().await.context("spawning screenpipe process")?;
            *process.lock().unwrap() = Some(proc);

            running.store(true, Ordering::Relaxed);
            tracing::info!("screenpipe sidecar started");
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
                    tracing::warn!("screenpipe stop error: {e}");
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

            // Screenpipe is CLI-based, check if process is alive
            HealthStatus::Healthy
        })
    }

    fn is_running(&self) -> bool {
        let mut guard = self.process.lock().unwrap();
        guard.as_mut().map(|p| p.is_running()).unwrap_or(false)
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_ryu_binary("screenpipe").await;
            crate::sidecar::remove_from_version_store("screenpipe");

            if delete_data {
                // Screenpipe stores its SQLite database, screenshots, audio chunks,
                // and pipe plugins in ~/.screenpipe/ on Linux, macOS, and Windows.
                if let Some(home) = dirs::home_dir() {
                    crate::sidecar::remove_dir(&home.join(".screenpipe")).await;
                }
            }

            tracing::info!("screenpipe uninstalled");
            Ok(())
        })
    }
}
