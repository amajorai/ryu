//! Ghost sidecar — MCP server providing AI eyes and hands for desktop apps.

pub mod downloader;
pub mod process;

pub use downloader::GhostDownloader;
pub use process::GhostProcess;

use std::path::PathBuf;

/// Absolute path to the installed Ghost binary (`~/.ryu/bin/ghost[.exe]`).
///
/// Single source of truth for where the Ghost binary lives, reused by the
/// downloader, the lifecycle manager, and the MCP registry built-in (U14) so
/// the spawn target never drifts between them.
pub fn ghost_bin_path() -> PathBuf {
    let name = if cfg!(target_os = "windows") {
        "ghost.exe"
    } else {
        "ghost"
    };
    crate::paths::ryu_dir().join("bin").join(name)
}

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// Lifecycle manager for the Ghost MCP sidecar process.
pub struct GhostManager {
    running: Arc<std::sync::atomic::AtomicBool>,
    process: Arc<Mutex<Option<GhostProcess>>>,
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl GhostManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            process: Arc::new(Mutex::new(None)),
            downloads: None,
        }
    }

    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }
}

impl Default for GhostManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for GhostManager {
    fn name(&self) -> &'static str {
        "ghost"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        let downloads = self.downloads.clone();
        Box::pin(async move {
            let downloads = downloads.expect("ghost manager: download center not wired (main.rs)");

            // Download binary if not already installed.
            GhostDownloader::new()
                .ensure_installed(&downloads)
                .await
                .context("installing ghost binary")?;

            // Ensure ghost's working directory exists.
            let ghost_dir = dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(".ghost");
            tokio::fs::create_dir_all(&ghost_dir)
                .await
                .context("creating ~/.ghost")?;

            // Construct and start the process.
            let binary_path = ghost_bin_path();

            tracing::info!("ghost sidecar starting");
            let mut proc = GhostProcess::new(binary_path);
            proc.start().await.context("spawning ghost process")?;
            *process.lock().unwrap() = Some(proc);

            running.store(true, Ordering::Relaxed);
            tracing::info!("ghost sidecar started (MCP stdio)");
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
                    tracing::warn!("ghost stop error: {e}");
                }
            }
            running.store(false, Ordering::Relaxed);
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let running = Arc::clone(&self.running);
        let process = Arc::clone(&self.process);
        Box::pin(async move {
            if !running.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("process not running".into());
            }
            let mut guard = process.lock().unwrap();
            if guard.as_mut().map(|p| p.is_running()).unwrap_or(false) {
                HealthStatus::Healthy
            } else {
                HealthStatus::Unhealthy("ghost process exited".into())
            }
        })
    }

    fn is_running(&self) -> bool {
        let mut guard = self.process.lock().unwrap();
        guard.as_mut().map(|p| p.is_running()).unwrap_or(false)
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_ryu_binary("ghost").await;
            crate::sidecar::remove_from_version_store("ghost");

            if delete_data {
                if let Some(home) = dirs::home_dir() {
                    crate::sidecar::remove_dir(&home.join(".ghost")).await;
                }
            }

            tracing::info!("ghost uninstalled");
            Ok(())
        })
    }
}
