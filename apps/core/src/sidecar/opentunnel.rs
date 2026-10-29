//! OpenTunnel lifecycle for the node Tunnel toolkit.
//!
//! [OpenTunnel](https://github.com/anomalyco/opentunnel) gives each device a
//! stable `<id>.opentunnel.xyz` hostname and terminates TLS locally, so the
//! relay never sees plaintext. Unlike a Cloudflare Quick Tunnel the hostname
//! survives restarts: the identity (token + private key) is persisted once and
//! reused.
//!
//! Core owns the process, not the OS. The stock CLI's `up` registers a systemd
//! or launchd unit that would keep Core public after Ryu quits, so Core instead:
//!
//! 1. points the CLI at private `XDG_*` directories under `<RYU_DIR>/opentunnel`
//!    (a dedicated identity that never collides with the user's own profiles);
//! 2. writes the profile's route file itself — one unguessable 16-hex route to
//!    Core's port, matching OpenTunnel's own default naming;
//! 3. provisions a missing identity with `opentunnel up` run with an empty
//!    `PATH`, which hides `systemctl`/`launchctl` so the CLI falls back to a
//!    plain background process, then immediately `down`s it;
//! 4. runs `opentunnel serve` as a `kill_on_drop` child, so stopping the
//!    sidecar (or Core exiting) tears the tunnel down.
//!
//! The URL is not authentication: anyone holding it reaches Core's listener,
//! where the node token still gates every protected route. While the tunnel is
//! (or may be) forwarding, [`forwarding_active`] tells Core to stop treating
//! loopback peers as local, because OpenTunnel re-originates remote traffic
//! over loopback.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, RwLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use tokio::process::Command;
use tokio::task::JoinHandle;

use crate::sidecar::opentunnel_downloader;
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

pub const SIDECAR_NAME: &str = "opentunnel";

/// Operator override for the CLI binary (otherwise PATH, then the managed copy).
const ENV_BIN: &str = "RYU_OPENTUNNEL_BIN";
/// Operator override for a self-hosted OpenTunnel API (passed as `--api`).
const ENV_API: &str = "RYU_OPENTUNNEL_API";
/// The CLI profile Core owns inside its private XDG directories.
const PROFILE: &str = "ryu";
/// First-run provisioning waits on DNS-01 certificate issuance, which the CLI
/// itself says "can take a few minutes".
const PROVISION_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const DOWN_TIMEOUT: Duration = Duration::from_secs(30);
/// How often a running tunnel re-proves that its public URL reaches this Core.
const PROBE_INTERVAL: Duration = Duration::from_secs(30);
/// How often a connecting (or reconnecting) tunnel is re-probed.
const PROBE_RETRY: Duration = Duration::from_secs(2);
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
/// Upper bound on the health body read back through the relay.
const PROBE_BODY_LIMIT: usize = 64 * 1024;

/// Lifecycle phase surfaced through `GET /api/mesh/status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    Stopped,
    Starting,
    /// Creating the tunnel identity and waiting for its certificate.
    Provisioning,
    Running,
    Failed,
}

impl Phase {
    /// The `BackendState` string `ryu_mesh::parse_status_json` reads; only
    /// `Running` counts as reachable.
    fn backend_state(self) -> &'static str {
        match self {
            Self::Stopped => "Stopped",
            Self::Starting => "Starting",
            Self::Provisioning => "Provisioning",
            Self::Running => "Running",
            Self::Failed => "Failed",
        }
    }
}

#[derive(Debug, Clone)]
struct Snapshot {
    phase: Phase,
    url: Option<String>,
    error: Option<String>,
}

static SNAPSHOT: RwLock<Snapshot> = RwLock::new(Snapshot {
    phase: Phase::Stopped,
    url: None,
    error: None,
});
static TASK: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
/// Serializes start and stop so two concurrent enables can never both spawn a
/// `serve` task, and a stop can never interleave with a half-registered start.
static LIFECYCLE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Fail-closed forwarding flag: set before any OpenTunnel process can exist and
/// cleared only once Core has stopped them.
static FORWARDING: AtomicBool = AtomicBool::new(false);

fn set_snapshot(phase: Phase, url: Option<String>, error: Option<String>) {
    if let Ok(mut guard) = SNAPSHOT.write() {
        *guard = Snapshot { phase, url, error };
    }
}

fn snapshot() -> Snapshot {
    SNAPSHOT
        .read()
        .map(|guard| guard.clone())
        .unwrap_or(Snapshot {
            phase: Phase::Stopped,
            url: None,
            error: None,
        })
}

/// Whether an OpenTunnel process may currently be forwarding public traffic to
/// Core over loopback.
pub(crate) fn forwarding_active() -> bool {
    FORWARDING.load(Ordering::Acquire)
}

/// The public URL once the tunnel is running.
pub(crate) fn public_url() -> Option<String> {
    let current = snapshot();
    (current.phase == Phase::Running)
        .then_some(current.url)
        .flatten()
}

/// The provider snapshot `CoreMeshHost::status_json` hands to `ryu_mesh`.
pub(crate) fn status_json() -> serde_json::Value {
    let current = snapshot();
    serde_json::json!({
        "Backend": "opentunnel",
        "BackendState": current.phase.backend_state(),
        "Self": {
            "PublicUrl": if current.phase == Phase::Running { current.url } else { None },
        },
        "Error": current.error,
    })
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn find_on_path() -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|directory| directory.join("opentunnel"))
        .find(|path| path.is_file())
}

/// Resolve an operator-provided, system-installed, or Ryu-managed executable.
pub fn resolve_binary() -> Result<PathBuf> {
    if !platform_supported() {
        bail!("OpenTunnel runs on macOS and Linux only; pick another tunnel on Windows");
    }
    if let Some(path) = env_value(ENV_BIN) {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = find_on_path() {
        return Ok(path);
    }
    let managed = opentunnel_downloader::managed_path();
    if managed.is_file() {
        return Ok(managed);
    }
    bail!(
        "OpenTunnel is not installed. Enable the OpenTunnel tunnel to install the pinned \
         release, or install it from https://github.com/anomalyco/opentunnel and retry."
    )
}

/// Core's private OpenTunnel directory tree.
#[derive(Debug, Clone)]
struct Dirs {
    root: PathBuf,
}

impl Dirs {
    fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn config_home(&self) -> PathBuf {
        self.root.join("config")
    }
    fn data_home(&self) -> PathBuf {
        self.root.join("data")
    }
    fn state_home(&self) -> PathBuf {
        self.root.join("state")
    }
    fn runtime_dir(&self) -> PathBuf {
        self.root.join("run")
    }

    /// `$XDG_CONFIG_HOME/opentunnel/<profile>.toml` — the CLI's route file.
    fn route_file(&self) -> PathBuf {
        self.config_home()
            .join("opentunnel")
            .join(format!("{PROFILE}.toml"))
    }

    /// `$XDG_DATA_HOME/opentunnel/<profile>/tunnel.json` — the provisioned identity.
    fn identity_file(&self) -> PathBuf {
        self.data_home()
            .join("opentunnel")
            .join(PROFILE)
            .join("tunnel.json")
    }

    fn create(&self) -> Result<()> {
        for dir in [
            self.config_home(),
            self.data_home(),
            self.state_home(),
            self.runtime_dir(),
        ] {
            std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
            restrict_dir(&dir)?;
        }
        Ok(())
    }

    /// The child environment: the scrubbed parent env with `PATH` emptied (so
    /// `up` cannot register a login service) and every XDG root redirected.
    fn child_env(&self) -> Vec<(String, String)> {
        let inherited: Vec<(String, String)> = std::env::vars()
            .filter(|(key, _)| {
                !key.eq_ignore_ascii_case("PATH")
                    && !key.starts_with("XDG_")
                    && !key.starts_with("OPENTUNNEL_")
            })
            .collect();
        let mut env = crate::sidecar::env_scrub::scrub_child_env(inherited, &[]);
        let path_string = |path: PathBuf| path.to_string_lossy().into_owned();
        env.extend([
            ("PATH".to_owned(), String::new()),
            (
                "XDG_CONFIG_HOME".to_owned(),
                path_string(self.config_home()),
            ),
            ("XDG_DATA_HOME".to_owned(), path_string(self.data_home())),
            ("XDG_STATE_HOME".to_owned(), path_string(self.state_home())),
            (
                "XDG_RUNTIME_DIR".to_owned(),
                path_string(self.runtime_dir()),
            ),
        ]);
        env
    }
}

fn default_dirs() -> Dirs {
    Dirs::new(crate::paths::service_dir("opentunnel"))
}

fn restrict_dir(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("restricting {}", dir.display()))?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// A fresh unguessable route name: 16 lowercase hex characters, the same shape
/// as the CLI's own default, and a valid DNS label.
fn random_route_name() -> String {
    format!("{:016x}", rand::random::<u64>())
}

/// Ensure the profile routes exactly Core's listener (`host:port`, no scheme),
/// reusing an existing route name for the same target so the public URL stays
/// stable across restarts.
fn ensure_route(dirs: &Dirs, target: &str) -> Result<String> {
    let path = dirs.route_file();
    let existing = std::fs::read_to_string(&path)
        .ok()
        .and_then(|content| content.parse::<toml::Table>().ok())
        .and_then(|table| table.get("routes").and_then(|r| r.as_table()).cloned())
        .and_then(|routes| {
            routes
                .iter()
                .find(|(_, value)| value.as_str() == Some(target))
                .map(|(name, _)| name.clone())
        });
    let name = existing.unwrap_or_else(random_route_name);

    let mut routes = toml::Table::new();
    routes.insert(name.clone(), toml::Value::String(target.to_owned()));
    let mut document = toml::Table::new();
    document.insert("routes".to_owned(), toml::Value::Table(routes));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    crate::atomic_file::write_atomic(&path, toml::to_string(&document)?.as_bytes())
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(name)
}

/// The provisioned tunnel hostname (`<id>.opentunnel.xyz`), if any.
fn identity_hostname(dirs: &Dirs) -> Option<String> {
    let raw = std::fs::read_to_string(dirs.identity_file()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("hostname")
        .and_then(|h| h.as_str())
        .map(str::trim)
        .filter(|h| is_valid_hostname(h))
        .map(str::to_owned)
}

/// A conservative hostname check so a corrupted identity file can never inject
/// anything but a DNS name into the URL Core publishes.
fn is_valid_hostname(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

fn public_url_for(route: &str, hostname: &str) -> String {
    format!("https://{route}.{hostname}")
}

fn base_command(binary: &Path, dirs: &Dirs, args: &[&str]) -> Command {
    let mut command = Command::new(binary);
    command.args(["--profile", PROFILE]);
    if let Some(api) = env_value(ENV_API) {
        command.args(["--api", &api]);
    }
    command
        .args(args)
        .env_clear()
        .envs(dirs.child_env())
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

/// Run a one-shot CLI command, returning its combined output on failure.
async fn run_once(binary: &Path, dirs: &Dirs, args: &[&str], limit: Duration) -> Result<()> {
    let output = tokio::time::timeout(
        limit,
        base_command(binary, dirs, args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output(),
    )
    .await
    .map_err(|_| anyhow!("`opentunnel {}` timed out", args.join(" ")))?
    .with_context(|| format!("running `opentunnel {}`", args.join(" ")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("`opentunnel {}` failed: {}", args.join(" "), stderr.trim());
    }
    Ok(())
}

/// Checks that a public URL reaches this Core end to end.
type ReadinessProbe = fn(String) -> BoxFuture<bool>;

/// `GET <url>/api/health` through the relay must answer as THIS Core: the
/// process exiting is not the only failure, because the CLI keeps reconnecting
/// after relay errors while staying alive.
fn probe_public_url(url: String) -> BoxFuture<bool> {
    Box::pin(async move {
        let Ok(client) = reqwest::Client::builder().timeout(PROBE_TIMEOUT).build() else {
            return false;
        };
        let Ok(response) = client.get(format!("{url}/api/health")).send().await else {
            return false;
        };
        if !response.status().is_success() {
            return false;
        }
        let Ok(body) = crate::sidecar::read_body_capped(response, PROBE_BODY_LIMIT).await else {
            return false;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) else {
            return false;
        };
        is_this_core_health(&value)
    })
}

fn is_this_core_health(value: &serde_json::Value) -> bool {
    let nonce_matches = crate::required_update_runtime::nonce()
        .is_none_or(|nonce| value["updateRuntimeNonce"].as_str() == Some(nonce));
    value["status"] == "ok"
        && value["version"] == serde_json::json!(crate::capabilities::version())
        && nonce_matches
}

/// Publish the URL only once it is proven reachable, and withdraw it while the
/// CLI is reconnecting. Runs until the task is aborted.
async fn monitor_readiness(url: String, probe: ReadinessProbe) {
    loop {
        let reachable = probe(url.clone()).await;
        let phase = snapshot().phase;
        if reachable {
            if phase != Phase::Running {
                tracing::info!("opentunnel: the public URL reaches Core");
                set_snapshot(Phase::Running, Some(url.clone()), None);
            }
            tokio::time::sleep(PROBE_INTERVAL).await;
        } else {
            if phase == Phase::Running {
                tracing::warn!("opentunnel: the public URL stopped reaching Core; reconnecting");
                set_snapshot(
                    Phase::Starting,
                    None,
                    Some("OpenTunnel lost its relay connection; reconnecting".to_owned()),
                );
            }
            tokio::time::sleep(PROBE_RETRY).await;
        }
    }
}

async fn run_tunnel(binary: PathBuf, dirs: Dirs, target: String, probe: ReadinessProbe) {
    if let Err(error) = run_tunnel_inner(&binary, &dirs, &target, probe).await {
        tracing::warn!("opentunnel: {error:#}");
        set_snapshot(Phase::Failed, None, Some(format!("{error:#}")));
    }
    // The serve child (kill_on_drop) is gone by now; reap any background
    // service a provisioning `up` may have left behind.
    let _ = run_once(&binary, &dirs, &["down"], DOWN_TIMEOUT).await;
    FORWARDING.store(false, Ordering::Release);
}

async fn run_tunnel_inner(
    binary: &Path,
    dirs: &Dirs,
    target: &str,
    probe: ReadinessProbe,
) -> Result<()> {
    dirs.create()?;
    let route = ensure_route(dirs, target)?;

    if identity_hostname(dirs).is_none() {
        set_snapshot(Phase::Provisioning, None, None);
        tracing::info!("opentunnel: provisioning the node's tunnel identity");
        run_once(binary, dirs, &["up"], PROVISION_TIMEOUT).await?;
        // `up` leaves a detached service running; Core owns the process instead.
        run_once(binary, dirs, &["down"], DOWN_TIMEOUT).await?;
    }
    let hostname = identity_hostname(dirs)
        .context("OpenTunnel finished provisioning without a tunnel hostname")?;

    let mut child = base_command(binary, dirs, &["serve"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("starting `opentunnel serve`")?;
    let url = public_url_for(&route, &hostname);
    tracing::info!("opentunnel: serve started; waiting for the relay to reach Core");
    set_snapshot(Phase::Starting, None, None);

    tokio::select! {
        status = child.wait() => {
            let status = status.context("waiting on `opentunnel serve`")?;
            bail!("`opentunnel serve` exited ({status})")
        }
        () = monitor_readiness(url, probe) => bail!("OpenTunnel readiness monitor stopped"),
    }
}

/// Stop the tunnel task and any process it owns.
async fn stop_tunnel() {
    let _lifecycle = LIFECYCLE.lock().await;
    let handle = TASK.lock().ok().and_then(|mut guard| guard.take());
    if let Some(handle) = handle {
        handle.abort();
        let _ = handle.await;
    }
    if forwarding_active() {
        // The task was aborted before its own cleanup ran.
        if let Ok(binary) = resolve_binary() {
            let _ = run_once(&binary, &default_dirs(), &["down"], DOWN_TIMEOUT).await;
        }
        FORWARDING.store(false, Ordering::Release);
    }
    set_snapshot(Phase::Stopped, None, None);
}

/// Process manager for the selected OpenTunnel backend.
pub struct OpenTunnelManager {
    port: u16,
    /// Where Core listens (`host:port`), derived from its bind address.
    target: String,
}

impl OpenTunnelManager {
    pub fn new(port: u16, target: String) -> Self {
        Self { port, target }
    }
}

/// OpenTunnel ships no Windows CLI.
pub(crate) fn platform_supported() -> bool {
    !cfg!(windows)
}

impl Sidecar for OpenTunnelManager {
    fn name(&self) -> &'static str {
        SIDECAR_NAME
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<Result<()>> {
        let port = self.port;
        let target = self.target.clone();
        Box::pin(async move {
            if port == 0 {
                bail!("OpenTunnel needs Core to use a fixed HTTP port");
            }
            if !ryu_mesh::is_enabled() {
                bail!("network disabled: enable OpenTunnel in the desktop");
            }
            if crate::sidecar::tailscale::mesh_backend().await.0
                != crate::sidecar::tailscale::MeshBackend::OpenTunnel
            {
                bail!("OpenTunnel is not the selected tunnel backend");
            }
            let binary = resolve_binary()?;
            let _lifecycle = LIFECYCLE.lock().await;
            let mut guard = TASK
                .lock()
                .map_err(|_| anyhow!("OpenTunnel state lock is poisoned"))?;
            if guard.as_ref().is_some_and(|handle| !handle.is_finished()) {
                return Ok(());
            }
            // Fail closed: loopback stops being trusted before any process exists.
            FORWARDING.store(true, Ordering::Release);
            set_snapshot(Phase::Starting, None, None);
            // Provisioning can take minutes, so the HTTP request that enabled the
            // tunnel returns now and the status endpoint reports progress. The
            // check, spawn, and store happen under one lock so a concurrent start
            // can never leave an untracked `serve` task behind.
            *guard = Some(tokio::spawn(run_tunnel(
                binary,
                default_dirs(),
                target,
                probe_public_url,
            )));
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<Result<()>> {
        Box::pin(async {
            stop_tunnel().await;
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        Box::pin(async {
            let current = snapshot();
            match current.phase {
                Phase::Running => HealthStatus::Healthy,
                Phase::Starting | Phase::Provisioning => {
                    HealthStatus::Unhealthy("OpenTunnel is still starting".to_owned())
                }
                Phase::Stopped => HealthStatus::Unhealthy("OpenTunnel is not running".to_owned()),
                Phase::Failed => HealthStatus::Unhealthy(
                    current
                        .error
                        .unwrap_or_else(|| "OpenTunnel failed".to_owned()),
                ),
            }
        })
    }

    fn is_running(&self) -> bool {
        TASK.lock()
            .ok()
            .is_some_and(|guard| guard.as_ref().is_some_and(|handle| !handle.is_finished()))
    }

    fn has_exited(&self) -> bool {
        false
    }

    fn pid(&self) -> Option<u32> {
        None
    }

    fn uninstall(&self, delete_data: bool) -> BoxFuture<Result<()>> {
        Box::pin(async move {
            stop_tunnel().await;
            crate::sidecar::remove_ryu_binary(SIDECAR_NAME).await;
            crate::sidecar::remove_from_version_store(SIDECAR_NAME);
            if delete_data {
                // Dropping the identity forfeits the stable hostname.
                let _ = tokio::fs::remove_dir_all(default_dirs().root).await;
            }
            tracing::info!("opentunnel: managed binary uninstalled");
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes the tests that touch the process-global snapshot.
    static SNAPSHOT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn temp_dirs() -> (tempfile::TempDir, Dirs) {
        let temp = tempfile::tempdir().expect("tempdir");
        let dirs = Dirs::new(temp.path().join("opentunnel"));
        (temp, dirs)
    }

    #[test]
    fn manager_uses_the_opentunnel_sidecar_name() {
        let manager = OpenTunnelManager::new(7980, "127.0.0.1:7980".to_owned());
        assert_eq!(manager.name(), SIDECAR_NAME);
        assert!(!manager.is_required());
    }

    #[test]
    fn route_is_random_unguessable_and_stable_for_the_same_port() {
        let (_temp, dirs) = temp_dirs();
        dirs.create().unwrap();
        let first = ensure_route(&dirs, "127.0.0.1:7980").unwrap();
        assert_eq!(first.len(), 16);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(
            ensure_route(&dirs, "127.0.0.1:7980").unwrap(),
            first,
            "a restart must keep the same public URL"
        );
        let written = std::fs::read_to_string(dirs.route_file()).unwrap();
        let table: toml::Table = written.parse().unwrap();
        assert_eq!(
            table["routes"][first.as_str()].as_str(),
            Some("127.0.0.1:7980")
        );

        let moved = ensure_route(&dirs, "127.0.0.1:7981").unwrap();
        assert_ne!(moved, first, "a different target gets a fresh route");
        let table: toml::Table = std::fs::read_to_string(dirs.route_file())
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(
            table["routes"].as_table().unwrap().len(),
            1,
            "Core's profile routes only Core's port"
        );
    }

    #[test]
    fn identity_hostname_reads_tunnel_json_and_rejects_garbage() {
        let (_temp, dirs) = temp_dirs();
        assert!(identity_hostname(&dirs).is_none());
        let path = dirs.identity_file();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"{"id":"abc","hostname":"abcdefghjkmn.opentunnel.xyz"}"#,
        )
        .unwrap();
        assert_eq!(
            identity_hostname(&dirs).as_deref(),
            Some("abcdefghjkmn.opentunnel.xyz")
        );
        std::fs::write(&path, r#"{"hostname":"evil.example/path?x"}"#).unwrap();
        assert!(identity_hostname(&dirs).is_none());
    }

    #[test]
    fn public_url_joins_route_and_hostname() {
        assert_eq!(
            public_url_for("0123456789abcdef", "abcdefghjkmn.opentunnel.xyz"),
            "https://0123456789abcdef.abcdefghjkmn.opentunnel.xyz"
        );
    }

    #[test]
    fn child_env_hides_service_managers_and_secrets_and_isolates_xdg() {
        let (_temp, dirs) = temp_dirs();
        let env = dirs.child_env();
        let get = |key: &str| env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
        assert_eq!(
            get("PATH"),
            Some(""),
            "an empty PATH hides systemctl/launchctl"
        );
        assert_eq!(
            get("XDG_CONFIG_HOME").map(PathBuf::from),
            Some(dirs.config_home())
        );
        assert_eq!(
            get("XDG_RUNTIME_DIR").map(PathBuf::from),
            Some(dirs.runtime_dir())
        );
        assert!(!env.iter().any(|(key, _)| key == "RYU_TOKEN"));
        assert_eq!(env.iter().filter(|(k, _)| k == "PATH").count(), 1);
    }

    #[test]
    fn readiness_requires_this_cores_health_answer() {
        let ours = serde_json::json!({
            "status": "ok",
            "version": crate::capabilities::version(),
            "updateRuntimeNonce": crate::required_update_runtime::nonce(),
        });
        assert!(is_this_core_health(&ours));
        let relay_error = serde_json::json!({ "error": "route offline" });
        assert!(!is_this_core_health(&relay_error));
        let other_core = serde_json::json!({ "status": "ok", "version": "0.0.0-other" });
        assert!(!is_this_core_health(&other_core));
    }

    #[tokio::test]
    async fn an_unreachable_url_is_never_published() {
        let _guard = SNAPSHOT_LOCK.lock().await;
        set_snapshot(Phase::Starting, None, None);
        let monitor = tokio::spawn(monitor_readiness("https://x.y".to_owned(), |_| {
            Box::pin(async { false })
        }));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(snapshot().phase, Phase::Starting);
        assert!(public_url().is_none());
        monitor.abort();
        let _ = monitor.await;
        set_snapshot(Phase::Stopped, None, None);
    }

    #[tokio::test]
    async fn status_snapshot_only_exposes_the_url_while_running() {
        let _guard = SNAPSHOT_LOCK.lock().await;
        set_snapshot(Phase::Provisioning, Some("https://x.y".to_owned()), None);
        let value = status_json();
        assert_eq!(value["Backend"], "opentunnel");
        assert_eq!(value["BackendState"], "Provisioning");
        assert!(value["Self"]["PublicUrl"].is_null());
        set_snapshot(Phase::Stopped, None, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn provisioning_and_serve_run_against_a_cli_stub() {
        use std::os::unix::fs::PermissionsExt;
        let _guard = SNAPSHOT_LOCK.lock().await;
        let (temp, dirs) = temp_dirs();
        // A stub CLI that records its argv and environment, provisions an
        // identity on `up`, and serves until killed.
        let log = temp.path().join("calls.log");
        let stub = temp.path().join("opentunnel-stub");
        std::fs::write(
            &stub,
            format!(
                "#!/bin/sh\n\
                 echo \"$* PATH=[$PATH] XDG=$XDG_DATA_HOME\" >> {log}\n\
                 case \"$3\" in\n\
                 up) /bin/mkdir -p \"$XDG_DATA_HOME/opentunnel/ryu\" && \
                     echo '{{\"hostname\":\"abcdefghjkmn.opentunnel.xyz\"}}' \
                     > \"$XDG_DATA_HOME/opentunnel/ryu/tunnel.json\" ;;\n\
                 serve) exec /bin/sleep 30 ;;\n\
                 esac\n",
                log = log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();

        let task = tokio::spawn(run_tunnel(
            stub.clone(),
            dirs.clone(),
            "127.0.0.1:7980".to_owned(),
            |_| Box::pin(async { true }),
        ));
        let mut running = None;
        for _ in 0..100 {
            if let Some(url) = public_url() {
                running = Some(url);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let url = running
            .unwrap_or_else(|| panic!("the stub tunnel never reached Running: {:?}", snapshot()));
        let route = ensure_route(&dirs, "127.0.0.1:7980").unwrap();
        assert_eq!(url, format!("https://{route}.abcdefghjkmn.opentunnel.xyz"));

        task.abort();
        let _ = task.await;
        set_snapshot(Phase::Stopped, None, None);
        let calls = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = calls.lines().collect();
        assert!(lines[0].starts_with("--profile ryu up PATH=[]"), "{calls}");
        assert!(lines[1].starts_with("--profile ryu down"), "{calls}");
        assert!(lines[2].starts_with("--profile ryu serve"), "{calls}");
        assert!(lines[0].contains(&dirs.data_home().display().to_string()));
    }
}
