pub mod active_engine;
pub mod adapters;
pub mod agent_runner;
pub mod agents;
pub mod control_plane;
pub mod download_manager;
pub mod external_runtime;
pub mod gateway;
pub mod gateway_policy;
pub mod headroom;
pub mod install_state;
pub mod manager;
pub mod mcp;
pub mod onboarding;
pub mod path_manager;
pub mod process;
pub mod providers;
pub mod resources;
pub mod sandbox;
pub mod tailscale;
pub mod tools;

pub use process::ProcessHandle;

use std::future::Future;
use std::pin::Pin;

pub use manager::SidecarManager;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthStatus {
    Healthy,
    Degraded(String),
    Unhealthy(String),
}

/// Trait implemented by each sidecar process.
pub trait Sidecar: Send + Sync {
    fn name(&self) -> &'static str;
    fn is_required(&self) -> bool;
    fn start(&self) -> BoxFuture<anyhow::Result<()>>;
    fn stop(&self) -> BoxFuture<anyhow::Result<()>>;
    fn health_check(&self) -> BoxFuture<HealthStatus>;
    fn is_running(&self) -> bool;

    /// OS process id of this sidecar's resident child, when Core spawned and
    /// still owns one. Default `None` — overridden only by sidecars that hold a
    /// child process whose memory/CPU the resource sampler can attribute.
    ///
    /// Returns `None` (correctly, not as a failure) for sidecars that have no
    /// resident process to sample: ones that shell out per request (OuteTTS),
    /// run in-process (parakeet), or *adopted* an external server they did not
    /// spawn (whisper/sdcpp pointed at an already-running port).
    fn pid(&self) -> Option<u32> {
        None
    }

    /// Uninstall this sidecar: stop it, remove its binary from `~/.ryu/bin/`,
    /// and clear its entry in `versions.json`.
    ///
    /// If `delete_data` is `true`, also remove the sidecar's data directory
    /// (model files, databases, caches, etc.). This is irreversible.
    ///
    /// The default implementation removes `~/.ryu/bin/<name>[.exe]` and the
    /// VersionStore entry. Sidecars with non-standard binary names or data
    /// directories override this method.
    fn uninstall(&self, _delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        let name = self.name().to_string();
        Box::pin(async move {
            remove_ryu_binary(&name).await;
            remove_from_version_store(&name);
            tracing::info!("{name} uninstalled");
            Ok(())
        })
    }
}

/// Remove `~/.ryu/bin/<stem>` and `~/.ryu/bin/<stem>.exe` if they exist.
pub(crate) async fn remove_ryu_binary(stem: &str) {
    let bin_dir = crate::paths::ryu_dir().join("bin");
    let exe = format!("{stem}.exe");
    for candidate in [stem, exe.as_str()] {
        let path = bin_dir.join(candidate);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => tracing::info!("removed {}", path.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!("could not remove {}: {e}", path.display()),
        }
    }
}

/// Remove the named entry from `~/.ryu/versions.json`.
pub(crate) fn remove_from_version_store(name: &str) {
    if let Err(e) = download_manager::VersionStore::remove_persisted(name) {
        tracing::warn!("could not update versions.json: {e}");
    }
}

/// Remove a directory and all its contents, logging a warning on failure.
pub(crate) async fn remove_dir(path: &std::path::Path) {
    match tokio::fs::remove_dir_all(path).await {
        Ok(()) => tracing::info!("removed {}", path.display()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("could not remove {}: {e}", path.display()),
    }
}

#[derive(serde::Serialize)]
pub struct SidecarStatus {
    pub name: String,
    pub running: bool,
    /// OS process id, when Core owns a resident child for this sidecar. Omitted
    /// otherwise (adopt-mode / serverless / in-process engines).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    /// Resident-set memory of the process in bytes, sampled by the background
    /// resource sampler. Omitted when there is no owned PID or no sample yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_bytes: Option<u64>,
    /// CPU usage as a percentage of one core (can exceed 100 on multi-threaded
    /// engines), sampled across the sampler's refresh interval. Omitted like
    /// [`Self::memory_bytes`]; reads 0 until the second sample lands.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_percent: Option<f32>,
}
