pub mod downloader;
pub use downloader::ZeroClawDownloader;

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

pub struct ZeroClawManager {
    process: ProcessHandle,
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl ZeroClawManager {
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

impl Sidecar for ZeroClawManager {
    fn name(&self) -> &'static str {
        "zeroclaw"
    }

    fn is_required(&self) -> bool {
        true
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let downloads = self.downloads.clone();
        Box::pin(async move {
            let downloads =
                downloads.expect("zeroclaw manager: download center not wired (main.rs)");
            ZeroClawDownloader::new()
                .ensure_installed(&downloads)
                .await?;

            let binary = downloader::binary_path();
            if !binary.exists() {
                anyhow::bail!("zeroclaw binary not found at {}", binary.display());
            }

            tracing::info!("starting zeroclaw gateway");
            process.start_with_args(&binary, &["gateway"]).await?;
            tracing::info!("zeroclaw started");
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
            if !process.is_running() {
                return HealthStatus::Unhealthy("zeroclaw not running".into());
            }

            // Check if the gateway is responding on port 42617
            match reqwest::get("http://127.0.0.1:42617/health").await {
                Ok(resp) if resp.status().is_success() => HealthStatus::Healthy,
                Ok(resp) => HealthStatus::Degraded(format!("gateway unhealthy: {}", resp.status())),
                Err(e) => HealthStatus::Degraded(format!("gateway not responding: {}", e)),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running()
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_ryu_binary("zeroclaw").await;
            crate::sidecar::remove_from_version_store("zeroclaw");

            if delete_data {
                if let Some(home) = dirs::home_dir() {
                    crate::sidecar::remove_dir(&home.join(".zeroclaw")).await;
                }
            }

            tracing::info!("zeroclaw uninstalled");
            Ok(())
        })
    }
}
