//! Tailcat point-to-point network lifecycle.
//!
//! Tailcat is intentionally a separate backend from the Tailscale/Headscale
//! mesh. It has no control plane, account, tailnet, or persistent node list:
//! Core runs a short-lived `tailcat --serve=<Core port>` listener and exposes
//! the generated address through the authenticated mesh-status endpoint. A
//! remote client can then use that address with the Tailcat CLI.
//!
//! The generated address is a bearer for the connection. It is kept in a
//! profile-scoped file with restrictive permissions, never written to logs,
//! and removed when the sidecar stops. `--key=new` makes every Core start use a
//! fresh ephemeral key even if the user's Tailcat installation has a saved
//! default key.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Context;
use std::io::Read;

use crate::sidecar::process::ProcessHandle;
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

pub const SIDECAR_NAME: &str = "tailcat";

const ENV_TAILCAT_BIN: &str = "RYU_TAILCAT_BIN";
const ENV_DERP_MAP_URL: &str = "RYU_TAILCAT_DERP_MAP_URL";
const ADDRESS_FILE_NAME: &str = "tailcat.address";
const CORE_PORT_DEFAULT: u16 = 7980;

/// The free function status bridge is called by `CoreMeshHost`, while the
/// manager owns the process handle. This flag is only a fast process-global
/// indication; `health_check` clears it when the child exits.
static RUNNING: AtomicBool = AtomicBool::new(false);

/// A missing Tailcat executable is structured so the mesh config endpoint can
/// return an actionable response without scraping a spawn error string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MissingTailcat;

impl std::fmt::Display for MissingTailcat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Tailcat is not installed: `tailcat` was not found. Install it with "
        )?;
        write!(
            f,
            "`go install github.com/tailscale/tailcat/cmd/tailcat@latest` "
        )?;
        write!(
            f,
            "or download a release from https://github.com/tailscale/tailcat/releases, "
        )?;
        write!(f, "then retry enabling Tailcat or set {ENV_TAILCAT_BIN}.")
    }
}

impl From<MissingTailcat> for anyhow::Error {
    fn from(missing: MissingTailcat) -> Self {
        anyhow::anyhow!(missing.to_string())
    }
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn mesh_dir() -> PathBuf {
    crate::paths::ryu_dir().join("mesh")
}

/// The local file Tailcat writes through `TAILCAT_ADDR_FILE`.
pub(crate) fn address_path() -> PathBuf {
    mesh_dir().join(ADDRESS_FILE_NAME)
}

fn canonical_or_original(path: PathBuf) -> PathBuf {
    std::fs::canonicalize(&path).unwrap_or(path)
}

fn parse_address(raw: &str) -> Option<String> {
    let value = raw.trim();
    (value.len() > 2
        && value.len() <= 16 * 1024
        && value.starts_with("tc")
        && !value.chars().any(char::is_whitespace))
    .then(|| value.to_owned())
}

fn lookup_in_path(bin: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(bin))
        .find(|candidate| candidate.is_file())
        .map(canonical_or_original)
}

/// Resolve the Tailcat executable from an explicit override or `PATH`.
///
/// Tailcat is deliberately adopted rather than auto-installed. Its upstream
/// CLI and wire format currently carry no stability promise, and macOS uses a
/// source/Go-toolchain install path while Linux and Windows also publish
/// release archives. Keeping installation outside Core avoids pretending those
/// distribution paths are one managed artifact.
pub(crate) fn resolve_binary() -> Result<PathBuf, MissingTailcat> {
    if let Some(raw) = env_value(ENV_TAILCAT_BIN) {
        let path = PathBuf::from(&raw);
        if path.is_file() {
            return Ok(canonical_or_original(path));
        }
        if !raw.contains('/') {
            if let Some(path) = lookup_in_path(&raw) {
                return Ok(path);
            }
        }
    }
    lookup_in_path("tailcat").ok_or(MissingTailcat)
}

/// Return the Tailcat address only while the Core-owned listener is live.
///
/// The file is a secret-bearing connection token. Do not log its value. The
/// status route is already protected by Core's node bearer, and the desktop
/// renders it only as an explicit copy/share action.
pub(crate) fn address() -> Option<String> {
    if !RUNNING.load(Ordering::Relaxed) {
        return None;
    }
    let raw = read_address_file()?;
    // Tailcat connection blobs are `tc`-prefixed, case-sensitive tokens. This
    // validation prevents a partial/error file from being advertised as a
    // usable address without attempting to parse the upstream wire format.
    parse_address(&raw)
}

/// Synthetic status input consumed by `ryu_mesh::parse_status_json`.
///
/// The shared mesh crate owns the wire-shaping contract. Returning a provider
/// snapshot here keeps that ownership intact while allowing the Core-side host
/// to select between the Tailscale JSON CLI and Tailcat's address file.
pub(crate) fn status_json() -> anyhow::Result<serde_json::Value> {
    let address = address().ok_or_else(|| anyhow::anyhow!("Tailcat listener is not running"))?;
    Ok(serde_json::json!({
        "BackendState": "Running",
        "Backend": "tailcat",
        "Self": {
            "TailcatAddress": address
        }
    }))
}

fn parse_port_from_bind(value: &str) -> Option<u16> {
    value
        .rsplit_once(':')
        .and_then(|(_, port)| port.trim().parse::<u16>().ok())
}

/// The port Tailcat forwards to on this machine. It follows the same
/// `--bind=` → `RYU_BIND` → profile default precedence Core uses for its
/// listener. The command-line value is read directly because Core resolves its
/// bind just before opening the listener and Tailcat starts from the sidecar
/// startup task earlier in boot.
fn core_port() -> u16 {
    std::env::args()
        .skip(1)
        .find_map(|arg| arg.strip_prefix("--bind=").and_then(parse_port_from_bind))
        .or_else(|| {
            std::env::var("RYU_BIND")
                .ok()
                .and_then(|value| parse_port_from_bind(&value))
        })
        .unwrap_or_else(|| crate::profile::port(CORE_PORT_DEFAULT))
}

fn derp_map_arg() -> Option<String> {
    env_value(ENV_DERP_MAP_URL).map(|url| format!("--derpmap-url={url}"))
}

fn restrict_address_perms(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
            tracing::warn!("tailcat: failed to chmod address file 0600: {error}");
        }
    }
}

async fn prepare_address_file() -> anyhow::Result<()> {
    let path = address_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .context("creating ~/.ryu/mesh for Tailcat")?;
    }
    // A previous process may have died without cleanup. Never advertise its
    // old bearer after starting a new ephemeral listener.
    let _ = tokio::fs::remove_file(path).await;
    Ok(())
}

async fn wait_for_address(daemon: &ProcessHandle) -> anyhow::Result<()> {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        loop {
            if address_from_file().is_some() {
                restrict_address_perms(&address_path());
                return Ok(());
            }
            if !daemon.is_running() {
                anyhow::bail!("Tailcat exited before publishing its connection address");
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    })
    .await
    .context("Tailcat did not publish a connection address within 30s")?
}

fn address_from_file() -> Option<String> {
    let raw = read_address_file()?;
    parse_address(&raw)
}

fn read_address_file() -> Option<String> {
    const MAX_ADDRESS_FILE_BYTES: u64 = 16 * 1024;
    let mut file = std::fs::File::open(address_path()).ok()?;
    let mut raw = String::new();
    file.by_ref()
        .take(MAX_ADDRESS_FILE_BYTES + 1)
        .read_to_string(&mut raw)
        .ok()?;
    (raw.len() as u64 <= MAX_ADDRESS_FILE_BYTES).then_some(raw)
}

/// Lifecycle manager for a Core-owned Tailcat server.
pub struct TailcatManager {
    daemon: ProcessHandle,
}

impl TailcatManager {
    pub fn new() -> Self {
        Self {
            daemon: ProcessHandle::new(),
        }
    }
}

impl Default for TailcatManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TailcatManager {
    fn drop(&mut self) {
        // Core's process shutdown path can drop the sidecar manager without
        // awaiting every async `stop()` future. Remove the bearer synchronously
        // as a final defense; the child handle's `kill_on_drop` still stops the
        // listener itself.
        RUNNING.store(false, Ordering::Relaxed);
        let _ = std::fs::remove_file(address_path());
    }
}

impl Sidecar for TailcatManager {
    fn name(&self) -> &'static str {
        SIDECAR_NAME
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let daemon = self.daemon.clone();
        Box::pin(async move {
            if !ryu_mesh::is_enabled() {
                anyhow::bail!(
                    "network disabled: enable Tailcat in the desktop or set RYU_MESH_ENABLED=1"
                );
            }
            if crate::sidecar::tailscale::mesh_backend().await.0
                != crate::sidecar::tailscale::MeshBackend::Tailcat
            {
                anyhow::bail!(
                    "Tailcat is not the selected network backend; select Tailcat before starting it"
                );
            }

            let binary = resolve_binary()?;
            if daemon.is_running() && address().is_some() {
                RUNNING.store(true, Ordering::Relaxed);
                return Ok(());
            }
            RUNNING.store(false, Ordering::Relaxed);
            if daemon.is_running() {
                let _ = daemon.stop().await;
            }
            prepare_address_file().await?;

            let mut args = vec![
                format!("--serve={}", core_port()),
                "--key=new".to_owned(),
                "--full-address".to_owned(),
            ];
            if let Some(derp_map) = derp_map_arg() {
                args.push(derp_map);
            }
            let env = vec![(
                "TAILCAT_ADDR_FILE".to_owned(),
                address_path().to_string_lossy().into_owned(),
            )];
            let binary_string = binary.to_string_lossy().into_owned();
            daemon
                .start_path_with_scrubbed_env_quiet(&binary_string, &args, &env)
                .await
                .with_context(|| format!("spawning Tailcat ({})", binary.display()))?;

            if let Err(error) = wait_for_address(&daemon).await {
                let _ = daemon.stop().await;
                let _ = tokio::fs::remove_file(address_path()).await;
                return Err(error);
            }
            RUNNING.store(true, Ordering::Relaxed);
            tracing::info!(
                binary = %binary.display(),
                port = core_port(),
                "tailcat: point-to-point listener started"
            );
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let daemon = self.daemon.clone();
        Box::pin(async move {
            RUNNING.store(false, Ordering::Relaxed);
            let _ = tokio::fs::remove_file(address_path()).await;
            daemon.stop().await
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let daemon = self.daemon.clone();
        Box::pin(async move {
            if !daemon.is_running() {
                RUNNING.store(false, Ordering::Relaxed);
                return HealthStatus::Unhealthy("Tailcat listener is not running".into());
            }
            if address().is_none() {
                RUNNING.store(false, Ordering::Relaxed);
                return HealthStatus::Degraded("Tailcat address is not available".into());
            }
            HealthStatus::Healthy
        })
    }

    fn is_running(&self) -> bool {
        self.daemon.is_running()
    }

    fn has_exited(&self) -> bool {
        self.daemon.has_exited()
    }

    fn pid(&self) -> Option<u32> {
        self.daemon.pid()
    }

    fn uninstall(&self, delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        let daemon = self.daemon.clone();
        Box::pin(async move {
            RUNNING.store(false, Ordering::Relaxed);
            let _ = daemon.stop().await;
            if delete_data {
                crate::sidecar::remove_dir(&mesh_dir()).await;
            } else {
                let _ = tokio::fs::remove_file(address_path()).await;
            }
            tracing::info!("tailcat network backend uninstalled");
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_tailcat_message_names_all_install_paths() {
        let message = MissingTailcat.to_string();
        assert!(message.contains("go install github.com/tailscale/tailcat/cmd/tailcat@latest"));
        assert!(message.contains("github.com/tailscale/tailcat/releases"));
        assert!(message.contains(ENV_TAILCAT_BIN));
    }

    #[test]
    fn address_from_file_accepts_only_tailcat_tokens() {
        assert_eq!(
            parse_address("tcExampleToken\n").as_deref(),
            Some("tcExampleToken")
        );

        for invalid in ["", "tc", "not-a-tailcat-address", "tc has-space"] {
            assert!(
                parse_address(invalid).is_none(),
                "invalid token: {invalid:?}"
            );
        }
        assert!(parse_address(&format!("tc{}", "x".repeat(16 * 1024))).is_none());
    }

    #[test]
    fn bind_port_parser_handles_ipv4_ipv6_and_invalid_values() {
        assert_eq!(parse_port_from_bind("127.0.0.1:8980"), Some(8980));
        assert_eq!(parse_port_from_bind("[::1]:8980"), Some(8980));
        assert_eq!(parse_port_from_bind(":8980"), Some(8980));
        assert_eq!(parse_port_from_bind("localhost"), None);
        assert_eq!(parse_port_from_bind("127.0.0.1:not-a-port"), None);
    }

    #[test]
    fn sidecar_name_is_stable() {
        assert_eq!(TailcatManager::new().name(), SIDECAR_NAME);
        assert!(!TailcatManager::new().is_required());
    }
}
