pub mod active_engine;
pub mod adapters;
pub mod agent_runner;
pub mod agents;
pub mod cli_shims;
pub mod control_plane;
pub mod deno_runtime;
pub mod download_manager;
pub mod env_scrub;
pub mod ext_proxy;
pub mod external_runtime;
pub mod gateway;
pub mod gateway_policy;
pub mod headroom;
pub mod install_state;
pub mod manager;
pub mod manifest_sidecar;
pub mod mcp;
pub mod onboarding;
pub mod path_manager;
pub mod plugin_credentials;
pub mod process;
pub mod providers;
pub mod resources;
/// The sandbox execution primitive, extracted into the `ryu-sandbox` crate
/// (in-process default). Re-exported at its historical path so consumers
/// (`server`, the MCP sandbox front) and every
/// `crate::sidecar::sandbox::*` call site are unchanged. Core installs the
/// crate's host seam (Gateway metering url/bearer, ryu-dir, org, default
/// budget) once at startup via [`crate::sandbox_host`].
pub use ryu_sandbox as sandbox;
pub mod tailcat;
pub mod tailcat_downloader;
pub mod tailscale;
pub mod tools;
pub mod untrusted;

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
    /// Stable name, also the [`SidecarManager`] map key. Built-in sidecars return
    /// a `&'static str` literal; a manifest-declared sidecar
    /// ([`manifest_sidecar::ManifestSidecar`]) returns its owned, plugin-namespaced
    /// name — hence `&str`, not `&'static str`.
    fn name(&self) -> &str;
    fn is_required(&self) -> bool;
    fn start(&self) -> BoxFuture<anyhow::Result<()>>;
    fn stop(&self) -> BoxFuture<anyhow::Result<()>>;
    fn health_check(&self) -> BoxFuture<HealthStatus>;
    fn is_running(&self) -> bool;

    /// Whether a child this sidecar spawned is held **and** has already exited —
    /// i.e. the process died on its own rather than being stopped.
    ///
    /// Default `false`, which reads as "I hold no child, so I cannot tell" — the
    /// honest answer for every sidecar that runs in-process, shells out per request,
    /// or adopted an external server. Only implementations backed by a
    /// [`process::ProcessHandle`] can answer, and they delegate to it.
    ///
    /// The health monitor uses this (not `!is_running()`) to decide a sidecar
    /// crashed: [`process::ProcessHandle::stop`] takes the child, so a deliberate
    /// stop — plugin disable, idle scale-to-zero — leaves this `false` and is never
    /// recorded as a failure. It is also what cancels the monitor, which matters
    /// because the probe presents the plugin's `RYU_EXT_TOKEN` to whoever holds the
    /// port every 30s; against a crashed sidecar's vacated port that is a credential
    /// handed to a stranger with no request from anyone.
    fn has_exited(&self) -> bool {
        false
    }

    /// Release everything that only makes sense while this sidecar's process is
    /// alive, after the health monitor has positively detected that it **crashed**
    /// (see [`has_exited`]). Default: nothing to release.
    ///
    /// This is the crash-path counterpart of [`Sidecar::stop`]. A clean stop runs
    /// `stop()` and can tear its own state down there; a crash runs *nothing* — the
    /// child is simply gone — so any state whose validity is tied to a live process
    /// would otherwise survive until the next Core boot. For
    /// [`manifest_sidecar::ManifestSidecar`] that state is the registered model
    /// provider: `models.json` keeps
    /// `{ baseUrl: "http://127.0.0.1:<port>/v1", apiKey: "<the plugin's ext token>" }`,
    /// and Pi dials that `baseUrl` **directly** — never through the ext proxy, so the
    /// proxy's registration gate cannot help. The moment the crashed child's port is
    /// free, any other local process that binds it is handed the plugin's minted token
    /// and every inference request body. The boot-time
    /// [`crate::pi_config::purge_sidecar_providers`] sweep closes the same lane only
    /// for an unclean *Core* exit; a crashed child under a healthy Core never reaches
    /// it.
    ///
    /// Contract for implementors, because the caller is the health-monitor loop:
    /// **must not panic and must not block for long.** Do small, synchronous,
    /// best-effort cleanup and log failures rather than propagating them.
    ///
    /// [`has_exited`]: Sidecar::has_exited
    fn on_crash_detected(&self) {}

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

    /// The fixed TCP port this sidecar's server binds to, when it has one. The
    /// [`SidecarManager`]'s port registry uses it to reject a manifest sidecar
    /// whose declared port would collide with a built-in (already bound) or another
    /// plugin. Default `None` — built-in sidecars derive their port internally and
    /// opt out of the registry; only manifest-declared sidecars
    /// ([`manifest_sidecar::ManifestSidecar`]) return `Some`.
    fn port(&self) -> Option<u16> {
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
    /// True when this sidecar is a **lazy** (spawn-on-first-use) manifest sidecar
    /// that is currently scaled to zero — registered and reachable, its process
    /// started on the next proxy/broker hit. Lets status UIs distinguish an
    /// intentional scale-to-zero (`running: false, lazy: true`) from a crash
    /// (`running: false, lazy: false`). Always present; `false` for eager/built-in
    /// sidecars (additive — existing readers ignore it).
    pub lazy: bool,
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
    /// Why this manifest sidecar could not be REGISTERED, when that is what happened
    /// (e.g. `port 8003 is already in use on the host (bind probe failed: ...)`).
    ///
    /// Distinct from `running: false`, which means "registered, process down" — a
    /// normal state for a lazy sidecar. A registration failure means Core never took
    /// ownership of the port at all, so the row is SYNTHESIZED: without it the sidecar
    /// would be missing from this list entirely (there is no `Sidecar` to report on),
    /// which is exactly how the condition used to be invisible while the app merely
    /// looked broken. Omitted on every healthy sidecar.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
}
