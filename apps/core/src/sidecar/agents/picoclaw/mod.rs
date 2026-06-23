pub mod downloader;
pub use downloader::PicoClawDownloader;
pub mod process;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use process::ProcessHandle;

pub struct PicoClawManager {
    process: ProcessHandle,
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl PicoClawManager {
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

impl Sidecar for PicoClawManager {
    fn name(&self) -> &'static str {
        "picoclaw"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let downloads = self.downloads.clone();
        Box::pin(async move {
            let downloads =
                downloads.expect("picoclaw manager: download center not wired (main.rs)");
            PicoClawDownloader::new()
                .ensure_installed(&downloads)
                .await?;
            let binary = downloader::binary_path();
            if !binary.exists() {
                anyhow::bail!("picoclaw binary not found at {}", binary.display());
            }
            tracing::info!("starting picoclaw");
            process.start(&binary).await?;
            tracing::info!("picoclaw started");
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
                HealthStatus::Unhealthy("picoclaw not running".into())
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running()
    }
}
