pub mod installer;
pub mod process;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use process::ProcessHandle;

pub struct NemoClawManager {
    process: ProcessHandle,
}

impl NemoClawManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
        }
    }
}

impl Sidecar for NemoClawManager {
    fn name(&self) -> &'static str {
        "nemoclaw"
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
                anyhow::bail!("nemoclaw binary not found at {}", binary.display());
            }
            tracing::info!("starting nemoclaw");
            process.start(&binary).await?;
            tracing::info!("nemoclaw started");
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
                HealthStatus::Unhealthy("nemoclaw not running".into())
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running()
    }
}
