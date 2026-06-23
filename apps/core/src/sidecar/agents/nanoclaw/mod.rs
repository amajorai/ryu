pub mod installer;
pub mod process;

use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use process::ProcessHandle;

pub struct NanoClawManager {
    process: ProcessHandle,
}

impl NanoClawManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
        }
    }
}

impl Sidecar for NanoClawManager {
    fn name(&self) -> &'static str {
        "nanoclaw"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move { anyhow::bail!("NanoClaw agent not yet implemented") })
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
                HealthStatus::Unhealthy("nanoclaw not running".into())
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running()
    }

    fn uninstall(&self, _delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // NanoClaw is installed via Docker — no binary lives in ~/.ryu/bin.
            // Remove the VersionStore entry and advise on Docker cleanup.
            crate::sidecar::remove_from_version_store("nanoclaw");
            tracing::info!(
                "nanoclaw uninstalled from Ryu. \
                 Docker images remain — remove them manually with: \
                 docker rmi $(docker images --filter=reference='nanoclaw*' -q)"
            );
            Ok(())
        })
    }
}
