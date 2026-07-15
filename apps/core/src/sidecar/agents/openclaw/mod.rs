pub mod installer;
pub mod process;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use crate::win_process::NoWindow;
use process::ProcessHandle;

pub struct OpenClawManager {
    process: ProcessHandle,
}

impl OpenClawManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
        }
    }
}

impl Sidecar for OpenClawManager {
    fn name(&self) -> &'static str {
        "openclaw"
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
                anyhow::bail!("openclaw binary not found at {}", binary.display());
            }
            tracing::info!("starting openclaw");
            process.start(&binary).await?;
            tracing::info!("openclaw started");
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
                HealthStatus::Unhealthy("openclaw not running".into())
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

            tracing::info!("removing openclaw npm package from {prefix_str}");
            match tokio::process::Command::new("npm")
                .args(["uninstall", "--prefix", &prefix_str, "openclaw"])
                .no_window()
                .status()
                .await
            {
                Ok(s) if s.success() => tracing::info!("openclaw npm package removed"),
                Ok(s) => tracing::warn!("npm uninstall openclaw exited with {s}"),
                Err(e) => tracing::warn!("could not run npm uninstall: {e}"),
            }

            crate::sidecar::remove_from_version_store("openclaw");
            tracing::info!("openclaw uninstalled");
            Ok(())
        })
    }
}
