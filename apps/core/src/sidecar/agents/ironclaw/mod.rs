pub mod downloader;
pub use downloader::IronClawDownloader;

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

pub struct IronClawManager {
    process: ProcessHandle,
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl IronClawManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
            downloads: None,
        }
    }

    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }
}

impl Sidecar for IronClawManager {
    fn name(&self) -> &'static str {
        "ironclaw"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let downloads = self.downloads.clone();
        Box::pin(async move {
            let downloads =
                downloads.expect("ironclaw manager: download center not wired (main.rs)");
            IronClawDownloader::new()
                .ensure_installed(&downloads)
                .await?;

            let binary = downloader::binary_path();
            if !binary.exists() {
                anyhow::bail!("ironclaw binary not found at {}", binary.display());
            }

            tracing::info!("starting ironclaw");
            process.start(&binary).await?;
            tracing::info!("ironclaw started");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        Box::pin(async move { process.stop().await })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let process = self.process.clone();
        Box::pin(async move {
            if process.is_running() {
                HealthStatus::Healthy
            } else {
                HealthStatus::Unhealthy("ironclaw not running".into())
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running()
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_ryu_binary("ironclaw").await;
            crate::sidecar::remove_from_version_store("ironclaw");

            if delete_data {
                if let Some(home) = dirs::home_dir() {
                    crate::sidecar::remove_dir(&home.join(".ironclaw")).await;
                }
            }

            tracing::info!("ironclaw uninstalled");
            Ok(())
        })
    }
}
