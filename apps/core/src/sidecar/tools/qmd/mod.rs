//! QMD sidecar — markdown knowledge base search tool.
//!
//! QMD (Query Markdown) is a tool for searching markdown knowledge bases,
//! notes, and documentation. It indexes markdown files and provides fast
//! semantic search capabilities.

pub mod installer;
pub mod process;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use process::ProcessHandle;

pub struct QmdManager {
    process: ProcessHandle,
}

impl QmdManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
        }
    }
}

impl Sidecar for QmdManager {
    fn name(&self) -> &'static str {
        "qmd"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        Box::pin(async move {
            installer::ensure_installed().await?;
            let binary = installer::binary_path();
            if !binary.exists() {
                anyhow::bail!("qmd binary not found at {}", binary.display());
            }
            tracing::info!("starting qmd");
            process.start(&binary).await?;
            tracing::info!("qmd started");
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
                HealthStatus::Unhealthy("qmd not running".into())
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running()
    }

    fn uninstall(&self, _delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // Remove the npm package from the ~/.ryu prefix.
            let prefix = crate::paths::ryu_dir();
            let prefix_str = prefix.to_string_lossy().into_owned();

            tracing::info!("removing @tobilu/qmd npm package from {prefix_str}");
            match tokio::process::Command::new("npm")
                .args(["uninstall", "--prefix", &prefix_str, "@tobilu/qmd"])
                .status()
                .await
            {
                Ok(s) if s.success() => tracing::info!("@tobilu/qmd npm package removed"),
                Ok(s) => tracing::warn!("npm uninstall @tobilu/qmd exited with {s}"),
                Err(e) => tracing::warn!("could not run npm uninstall: {e}"),
            }

            crate::sidecar::remove_from_version_store("qmd");
            tracing::info!("qmd uninstalled");
            Ok(())
        })
    }
}
