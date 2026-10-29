//! Tailscale / Headscale mesh daemon lifecycle (P5 of #478).
//!
//! Wraps the **official** `tailscaled` + `tailscale` binaries (no FFI, no
//! reimplementation) in **userspace networking** mode so a Ryu node can reach a
//! remote node over the tailnet without a kernel TUN device or root. This is the
//! "what runs" half of the mesh (Core); the read side + Funnel helpers live in
//! the extracted [`ryu_mesh`] crate (Core bridges to these shell-outs via the
//! `MeshHost` shim in [`crate::mesh_host`]).
//!
//! Opt-in only: `TailscaleManager` is registered in `all_sidecars` and listed in
//! `startup_order`, but `start_all` skips it unless `main()` marked it installed —
//! which happens only when `ryu_mesh::is_enabled()` (the `RYU_MESH_ENABLED` env OR
//! the `mesh-enabled` pref the desktop's Gateway → Integrations toggle writes).
//!
//! **PATH adoption first, managed install second.** An official `tailscale` +
//! `tailscaled` pair already on PATH always wins — Ryu never shadows a client the
//! user installed. Only when there is no such pair does [`downloader`] install a
//! Ryu-managed one under the profile's `bin/` (pinned upstream archive on Linux,
//! Ryu release assets on clean macOS/Windows, with Homebrew as a macOS fallback).
//! `required_platforms("tailscale")` is unconstrained and stays that way: adoption
//! works everywhere, and the per-platform difference lives in the downloader.
//!
//! Resolution is **same-origin** and returns ABSOLUTE paths
//! ([`resolve_mesh_pair`]): a PATH `tailscale` is never paired with a managed
//! `tailscaled`. On macOS `/usr/local/bin/tailscale` is a shim into `Tailscale.app`
//! with no sibling daemon, so a per-binary search would silently pair a GUI-app CLI
//! with Ryu's daemon.
//!
//! Security (folded review fixes, all HIGH/MED):
//! - **Userspace mode can expose a local SOCKS5 + HTTP proxy**
//!   (`--socks5-server`, `--outbound-http-proxy-listen`), but Core no longer starts
//!   them. They are unauthenticated, and inbound tailnet peers arrive from
//!   `127.0.0.1`, so a peer could dial through them as this node. Nothing in Ryu
//!   dials through either listener, so they are opt-in only: set
//!   `RYU_MESH_SOCKS5_ADDR` / `RYU_MESH_HTTP_PROXY_ADDR` to a loopback address (or
//!   `1` for the legacy default port). Inbound peers proxy *to* `127.0.0.1`, which
//!   is also why loopback-admin gates must be neutralized under mesh: see
//!   `gateway::gateway_spawn_env` (`RYU_MESH_ENABLED`),
//!   [`daemon_active`], and the Core fail-closed gate in `server::create_router`.
//! - **Authkey never reaches ANY child env.** `main()` calls
//!   [`scrub_authkey_to_keyfile`] once at startup — *before any child process is
//!   spawned* (gateway, headroom, ACP `npx` agents, the `tailscaled` daemon
//!   itself) — which reads `RYU_MESH_AUTHKEY`, keeps it in Core's memory, and
//!   removes it from this process's env (`std::env::remove_var`). So no spawned
//!   child can read the secret from `/proc/self/environ`. `start()` then gates
//!   enrollment on the in-memory key and passes it to `tailscale up` via
//!   `--authkey=file:<p>`, a one-shot owner-only file created just before that
//!   command and deleted when it returns (or on any earlier error). The key is
//!   never on disk between Core starting and enrollment.

pub mod downloader;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;

use crate::sidecar::process::ProcessHandle;
use crate::sidecar::tailscale::downloader::{exe_name, CLI_BIN, DAEMON_BIN};
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use crate::win_process::NoWindow;

/// Loopback address + port the userspace SOCKS5 proxy listens on when an operator opts in
/// with `RYU_MESH_SOCKS5_ADDR=1`.
pub const DEFAULT_SOCKS5_ADDR: &str = "127.0.0.1:1055";
/// Loopback address + port the userspace outbound HTTP proxy listens on when an operator
/// opts in with `RYU_MESH_HTTP_PROXY_ADDR=1`.
pub const DEFAULT_HTTP_PROXY_ADDR: &str = "127.0.0.1:1056";

/// Env opting in to the SOCKS5 listener. Unset = no listener (the default).
const ENV_SOCKS5_ADDR: &str = "RYU_MESH_SOCKS5_ADDR";
/// Env opting in to the outbound HTTP proxy listener. Unset = no listener.
const ENV_HTTP_PROXY_ADDR: &str = "RYU_MESH_HTTP_PROXY_ADDR";
/// Env carrying the (single-use, ephemeral preferred) tailnet auth key.
const ENV_AUTHKEY: &str = "RYU_MESH_AUTHKEY";
/// Env pointing at a Headscale (or alternate) control server via
/// `tailscale up --login-server`. Unset = Tailscale SaaS.
const ENV_LOGIN_SERVER: &str = "RYU_MESH_LOGIN_SERVER";
/// Overrides the name this node registers on the tailnet with (see
/// [`mesh_hostname`]). Unset = derived from the OS hostname.
const ENV_HOSTNAME: &str = "RYU_MESH_HOSTNAME";
/// Env overriding the `tailscaled` binary (otherwise resolved on PATH).
const ENV_TAILSCALED_BIN: &str = "RYU_TAILSCALED_BIN";
/// Env overriding the `tailscale` CLI binary (otherwise resolved on PATH).
const ENV_TAILSCALE_BIN: &str = "RYU_TAILSCALE_BIN";
/// Env overriding the tunnel backend (`headscale` | `tailscale` | `tailcat` | `cloudflared` |
/// `opentunnel` | `plugin`), outranking the
/// `mesh-backend` pref exactly as the other mesh envs outrank their prefs.
const ENV_BACKEND: &str = "RYU_MESH_BACKEND";

/// Which tunnel backend this node uses. Tailcat remains the fresh-install
/// default because it needs no account, control server, or persistent tailnet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeshBackend {
    /// Self-hosted Headscale — `tailscale up --login-server=<url>`.
    Headscale,
    /// Tailscale's SaaS coordination server — no `--login-server` at all.
    Tailscale,
    /// Tailcat's short-lived point-to-point server — no control plane or login.
    Tailcat,
    /// Cloudflare's temporary public Quick Tunnel.
    Cloudflared,
    /// OpenTunnel's stable, locally TLS-terminated public hostname.
    OpenTunnel,
    /// The bound `network.tunnel` provider: a third-party tunnel adapter
    /// contributed by a plugin (see `crate::sidecar::plugin_tunnel`).
    Plugin,
}

impl MeshBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Headscale => "headscale",
            Self::Tailscale => "tailscale",
            Self::Tailcat => "tailcat",
            Self::Cloudflared => "cloudflared",
            Self::OpenTunnel => "opentunnel",
            Self::Plugin => "plugin",
        }
    }

    /// The sidecar that owns this backend's process lifecycle.
    pub fn sidecar_name(self) -> &'static str {
        match self {
            Self::Headscale | Self::Tailscale => "tailscale",
            Self::Tailcat => crate::sidecar::tailcat::SIDECAR_NAME,
            Self::Cloudflared => crate::sidecar::cloudflared::SIDECAR_NAME,
            Self::OpenTunnel => crate::sidecar::opentunnel::SIDECAR_NAME,
            Self::Plugin => crate::sidecar::plugin_tunnel::SIDECAR_NAME,
        }
    }
}

/// Whether `backend` runs on this module's `tailscaled` + `tailscale` pair.
fn uses_tailscaled(backend: MeshBackend) -> bool {
    matches!(backend, MeshBackend::Headscale | MeshBackend::Tailscale)
}

/// True from just before Core spawns (or adopts) its `tailscaled` until `stop()`
/// finishes. Fail-closed: an error while stopping leaves it set.
static DAEMON_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Whether the backend [`mesh_backend`] last resolved runs on `tailscaled`. Kept as a
/// plain flag so the synchronous loopback-trust predicate can read it without
/// touching the preference store.
static BACKEND_USES_TAILSCALED: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
tokio::task_local! {
    /// Test-only: scope a request as if Core's `tailscaled` were running, without
    /// flipping process-global state under parallel tests.
    pub(crate) static FORCE_DAEMON_ACTIVE_FOR_TEST: bool;
}

/// The pure rule behind [`daemon_active`].
fn daemon_active_from(
    daemon_running: bool,
    mesh_enabled: bool,
    backend_runs_tailscaled: bool,
) -> bool {
    daemon_running || (mesh_enabled && backend_runs_tailscaled)
}

/// Whether Core's `tailscaled` may currently be handing tailnet peers to Core.
///
/// In userspace-networking mode `tailscaled` has no TUN device: every inbound tailnet
/// connection is re-originated by the daemon itself, so the peer Core sees is
/// `127.0.0.1` no matter which node on the tailnet sent it. That makes a loopback peer
/// meaningless as proof of a local caller. `crate::sidecar::forwarding_tunnel_active`
/// reads this alongside Tailcat, Cloudflared, OpenTunnel and plugin tunnels, so every
/// loopback-trust decision treats the mesh daemon as a forwarder.
///
/// True while the daemon runs (or is starting), and whenever the mesh is enabled with a
/// Tailscale/Headscale backend, which covers the gap before the daemon is up and an
/// adopted daemon Core did not spawn.
pub(crate) fn daemon_active() -> bool {
    #[cfg(test)]
    if FORCE_DAEMON_ACTIVE_FOR_TEST
        .try_with(|forced| *forced)
        .unwrap_or(false)
    {
        return true;
    }
    let backend_runs_tailscaled = match env_bin(ENV_BACKEND) {
        Some(raw) => uses_tailscaled(parse_backend(Some(&raw))),
        None => BACKEND_USES_TAILSCALED.load(Ordering::Relaxed),
    };
    daemon_active_from(
        DAEMON_ACTIVE.load(Ordering::Acquire),
        ryu_mesh::is_enabled(),
        backend_runs_tailscaled,
    )
}

/// The default when nothing has ever been chosen: a short-lived Tailcat link.
pub const DEFAULT_MESH_BACKEND: MeshBackend = MeshBackend::Tailcat;

/// Resolve the tunnel backend from the env override and the stored pref.
///
/// Precedence: [`ENV_BACKEND`] → the `mesh-backend` pref → [`DEFAULT_MESH_BACKEND`].
/// An unrecognized value falls through to the default rather than failing the
/// start — a typo in a pref must not strand a node off its tailnet.
pub fn parse_backend(raw: Option<&str>) -> MeshBackend {
    match raw.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("tailscale") => MeshBackend::Tailscale,
        Some("headscale") => MeshBackend::Headscale,
        Some("tailcat") => MeshBackend::Tailcat,
        Some("cloudflared") => MeshBackend::Cloudflared,
        Some("opentunnel") => MeshBackend::OpenTunnel,
        Some("plugin") => MeshBackend::Plugin,
        _ => DEFAULT_MESH_BACKEND,
    }
}

/// Parse only an explicitly supplied backend choice. Unlike [`parse_backend`],
/// this returns `None` for an unknown value so an HTTP config request cannot
/// silently turn a typo into a different network backend.
pub fn parse_backend_choice(raw: &str) -> Option<MeshBackend> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "tailscale" => Some(MeshBackend::Tailscale),
        "headscale" => Some(MeshBackend::Headscale),
        "tailcat" => Some(MeshBackend::Tailcat),
        "cloudflared" => Some(MeshBackend::Cloudflared),
        "opentunnel" => Some(MeshBackend::OpenTunnel),
        "plugin" => Some(MeshBackend::Plugin),
        _ => None,
    }
}

/// The configured backend, reading the env first and the pref store second, plus
/// whether the choice was made EXPLICITLY (env or a stored pref) rather than
/// inherited from [`DEFAULT_MESH_BACKEND`].
///
/// The second half of that pair is not bookkeeping — it is what keeps the new
/// default from breaking an existing node. See the enrollment branch in
/// [`TailscaleManager::start`].
pub async fn mesh_backend() -> (MeshBackend, bool) {
    let resolved = resolve_mesh_backend().await;
    BACKEND_USES_TAILSCALED.store(uses_tailscaled(resolved.0), Ordering::Relaxed);
    resolved
}

async fn resolve_mesh_backend() -> (MeshBackend, bool) {
    if let Some(raw) = env_bin(ENV_BACKEND) {
        return (parse_backend(Some(&raw)), true);
    }
    let (backend_pref, login_server_pref) =
        match crate::server::preferences::PreferencesStore::open_default() {
            Ok(store) => (
                store
                    .get(crate::mesh_host::MESH_BACKEND_PREF_KEY)
                    .await
                    .ok()
                    .flatten()
                    .filter(|s| !s.trim().is_empty()),
                store
                    .get("mesh-login-server")
                    .await
                    .ok()
                    .flatten()
                    .filter(|s| !s.trim().is_empty()),
            ),
            Err(_) => (None, None),
        };
    if let Some(pref) = backend_pref {
        return (parse_backend(Some(&pref)), true);
    }

    // Tailcat is the new default for an untouched node. Preserve the old
    // implicit Tailscale/Headscale behavior for nodes that already carry the
    // old control-server preference or a Tailscale state/authkey file; only a
    // genuinely fresh node should switch to Tailcat without an explicit pick.
    let legacy_login_server = env_bin(ENV_LOGIN_SERVER)
        .filter(|value| !value.trim().is_empty())
        .or(login_server_pref);
    if legacy_login_server.is_some() || state_path().is_file() || authkey_keyfile_present() {
        return (
            if legacy_login_server.is_some() {
                MeshBackend::Headscale
            } else {
                MeshBackend::Tailscale
            },
            false,
        );
    }
    (DEFAULT_MESH_BACKEND, false)
}

/// Resolve one opt-in proxy listener from its raw env value.
///
/// `1`/`true`/`yes`/`on` selects `default`; a loopback `host:port` is used as given.
/// Anything else (blank, unparseable, or a non-loopback address that would hand the
/// unauthenticated proxy to the network) yields `None`, so a typo leaves the listener off.
fn parse_proxy_opt_in(raw: Option<&str>, default: &str) -> Option<String> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    if matches!(
        raw.to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    ) {
        return Some(default.to_owned());
    }
    match raw.parse::<std::net::SocketAddr>() {
        Ok(addr) if addr.ip().is_loopback() => Some(raw.to_owned()),
        _ => {
            tracing::warn!(
                value = raw,
                "tailscale: ignoring mesh proxy listener: it must be a loopback host:port"
            );
            None
        }
    }
}

/// The SOCKS5 listen address for the userspace proxy, or `None` (the default) when the
/// operator has not opted in via [`ENV_SOCKS5_ADDR`].
pub fn socks5_addr() -> Option<String> {
    parse_proxy_opt_in(env_bin(ENV_SOCKS5_ADDR).as_deref(), DEFAULT_SOCKS5_ADDR)
}

/// The outbound HTTP proxy listen address, or `None` (the default) when the operator has
/// not opted in via [`ENV_HTTP_PROXY_ADDR`].
pub fn http_proxy_addr() -> Option<String> {
    parse_proxy_opt_in(
        env_bin(ENV_HTTP_PROXY_ADDR).as_deref(),
        DEFAULT_HTTP_PROXY_ADDR,
    )
}

/// The argv for the userspace `tailscaled`.
///
/// Always `--tun=userspace-networking` (no TUN device, no root), and never an `--ssh`
/// flag or a kernel TUN: the daemon must not run an SSH server or touch the host's
/// network stack. The SOCKS5 and outbound HTTP proxies are included only when opted in.
fn daemon_spawn_args(
    socket: &Path,
    state: &Path,
    socks5: Option<&str>,
    http_proxy: Option<&str>,
) -> Vec<String> {
    let mut args = vec!["--tun=userspace-networking".to_owned()];
    if let Some(addr) = socks5 {
        args.push(format!("--socks5-server={addr}"));
    }
    if let Some(addr) = http_proxy {
        args.push(format!("--outbound-http-proxy-listen={addr}"));
    }
    args.push(format!("--socket={}", socket.display()));
    args.push(format!("--state={}", state.display()));
    args
}

/// The `~/.ryu/mesh/` directory holding the custom `tailscaled` socket + state so
/// Ryu's daemon never collides with a system-wide tailscaled.
fn mesh_dir() -> PathBuf {
    crate::paths::service_dir("mesh")
}

/// Make `dir` owner-only (`0700` on unix), failing closed.
///
/// `tailscaled.state` holds the node's private keys in tailscaled's own format, which
/// Ryu cannot seal, and the control socket in the same directory is an admin channel to
/// the daemon. If the mode cannot be set (a filesystem without unix permissions, a
/// directory owned by someone else) the keys would sit readable by other local users, so
/// the mesh does not start. A warning would be easy to miss; the error is the signal.
fn restrict_mesh_dir(dir: &Path) -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).with_context(
            || {
                format!(
                    "refusing to start the mesh: could not restrict {} to owner-only (0700). \
                     It holds the node's private keys; move RYU_DIR to a filesystem that \
                     supports unix permissions or fix the directory's ownership",
                    dir.display()
                )
            },
        )?;
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// The custom `tailscaled` control socket path (under `~/.ryu/mesh`).
pub fn socket_path() -> PathBuf {
    mesh_dir().join("tailscaled.sock")
}

/// The custom `tailscaled` state file path (under `~/.ryu/mesh`).
pub fn state_path() -> PathBuf {
    mesh_dir().join("tailscaled.state")
}

/// Where builds before in-memory custody kept the authkey between Core starting
/// and `tailscale up`. Read once (to migrate a key still waiting there) and then
/// deleted; nothing writes it any more.
fn legacy_authkey_path() -> PathBuf {
    mesh_dir().join("authkey")
}

/// The mesh authkey from `RYU_MESH_AUTHKEY`, held in Core's memory only until
/// `tailscale up` consumes it. It never sits on disk between those points.
static PENDING_AUTHKEY: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn pending_authkey() -> Option<String> {
    PENDING_AUTHKEY
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_else(|poisoned| poisoned.into_inner().clone())
}

fn set_pending_authkey(key: Option<String>) {
    match PENDING_AUTHKEY.lock() {
        Ok(mut guard) => *guard = key,
        Err(poisoned) => *poisoned.into_inner() = key,
    }
}

/// Write `key` to a fresh, owner-only file in `dir` for the single `tailscale up`
/// that reads it (`--authkey=file:`). The file is created empty, restricted, and
/// only then filled; it is deleted when the returned handle drops, so every exit
/// path (success, failure, an early return) removes it.
fn write_ephemeral_authkey(dir: &Path, key: &str) -> anyhow::Result<tempfile::NamedTempFile> {
    std::fs::create_dir_all(dir).context("creating the mesh directory")?;
    let mut file = tempfile::Builder::new()
        .prefix(".authkey-")
        .tempfile_in(dir)
        .context("creating the one-shot authkey file")?;
    restrict_keyfile_perms(file.path());
    std::io::Write::write_all(file.as_file_mut(), key.as_bytes())
        .context("writing the one-shot authkey file")?;
    file.as_file_mut()
        .sync_all()
        .context("flushing the one-shot authkey file")?;
    Ok(file)
}

/// The explicit override for one of the two binaries, trimmed; `None` when unset
/// or blank (a blank value in an env file must read as "unset", not as an empty
/// program name).
fn env_bin(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// The name this node registers on the tailnet with.
///
/// Tailscale derives a node name from the OS hostname by taking its FIRST DNS
/// label, which is actively wrong on a large class of machines: a DHCP box whose
/// hostname is `192.168.1.175` registers as **`192`** — meaningless in the node
/// picker, and COLLIDING with every other such machine on the tailnet (Headscale
/// then disambiguates with a suffix, so they are all indistinguishable). Sanitize
/// the WHOLE hostname into one DNS-safe label instead, so `192.168.1.175`
/// becomes `192-168-1-175` — still ugly, but unique and traceable to a machine.
///
/// Returns `None` when nothing usable can be derived, in which case the caller
/// omits `--hostname` and leaves Tailscale's own default in place.
fn mesh_hostname() -> Option<String> {
    let raw = std::env::var(ENV_HOSTNAME)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(sysinfo::System::host_name)?;
    let sanitized: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    // Collapse runs of separators and trim them from the ends — Tailscale rejects
    // a label that starts or ends with `-`.
    let cleaned = sanitized
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    // Tailscale caps a label at 63 characters.
    let capped: String = cleaned.chars().take(63).collect();
    let capped = capped.trim_end_matches('-').to_owned();
    (!capped.is_empty()).then_some(capped)
}

/// Whether a command name resolves to something executable — an absolute/relative
/// path that exists, or a bare name found on `PATH`.
pub(crate) fn binary_resolves(bin: &str) -> bool {
    if bin.contains(std::path::MAIN_SEPARATOR) || bin.contains('/') {
        return Path::new(bin).is_file();
    }
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(bin).is_file())
}

// ── Mesh binary resolution ────────────────────────────────────────────────────
//
// PATH ADOPTION MUST WIN. Ryu can now install its own `tailscaled`/`tailscale`
// pair (see [`downloader`]), and the whole point of the precedence below is that
// doing so never shadows a client the user installed themselves.
//
// The resolution is SAME-ORIGIN, not per-binary, and that is the load-bearing
// part. On macOS `/usr/local/bin/tailscale` is a shim into `Tailscale.app` with no
// sibling `tailscaled` at all; a per-binary search would happily pair that GUI-app
// CLI with Ryu's managed daemon, and the two do not agree about anything. So an
// origin supplies BOTH binaries or neither.
//
// "Origin" is deliberately coarse for PATH — anywhere on PATH counts, not one
// directory — because Linux packages legitimately split the pair (`/usr/bin/
// tailscale` + `/usr/sbin/tailscaled`). The mixing this guards against is
// PATH-vs-managed, which is where the semantics actually differ.
//
// Ordering is not left to PATH order: `PathManager::add_to_path` APPENDS on both
// platforms (`format!("{current};{bin}")` on Windows, `export PATH="$PATH:…"` on
// unix), so the user's own install already sorts first — but the managed dir is
// EXCLUDED from the PATH scan explicitly rather than relying on that.

/// A complete, absolute `tailscaled` + `tailscale` pair from ONE origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MeshPair {
    pub daemon: PathBuf,
    pub cli: PathBuf,
    /// Which origin supplied the pair, for the start-up log line. This is the only
    /// way the precedence is observable rather than inferred, and it is the first
    /// thing to look at when someone reports "it ran the wrong tailscale".
    pub origin: &'static str,
}

/// The verdict when no complete pair could be resolved.
///
/// Structured rather than a bare string because the desktop needs to branch on it:
/// `can_install` true means "start the managed install", false means "tell them
/// how to provide an operator-managed client". A dead-end toast was the previous
/// behaviour.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MissingMesh {
    pub missing: Vec<String>,
    pub can_install: bool,
}

impl std::fmt::Display for MissingMesh {
    /// Keeps the one actionable sentence the raw spawn failure never gave. Without
    /// it the only symptom of a missing client was "No such file or directory
    /// (os error 2)", which the desktop faithfully showed in a toast that told the
    /// user nothing about what to do.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the Tailscale client is not installed: {} not found. ",
            self.missing.join(" and ")
        )?;
        if self.can_install {
            write!(
                f,
                "Ryu is installing a managed client copy for this node automatically."
            )
        } else {
            write!(
                f,
                "Install the official client (macOS: `brew install tailscale`; \
                 https://tailscale.com/download) or point \
                 {ENV_TAILSCALED_BIN}/{ENV_TAILSCALE_BIN} at an existing install."
            )
        }
    }
}

impl From<MissingMesh> for anyhow::Error {
    fn from(m: MissingMesh) -> Self {
        anyhow::anyhow!("{m}")
    }
}

/// Two paths refer to the same directory. Canonicalized where possible so a
/// symlinked or `..`-laden PATH entry cannot sneak the managed dir past the
/// exclusion; compared case-insensitively on Windows, where paths are.
fn same_dir(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (a, b) = (canon(a), canon(b));
    if cfg!(windows) {
        a.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
    } else {
        a == b
    }
}

/// Split a raw `PATH` value into origin dirs, minus the Ryu-managed bin dir.
///
/// Takes the raw value rather than reading the env so the exclusion is testable
/// against a constructed `PATH` — mutating the process's real `PATH` from a test
/// would race every other test in the crate that spawns a subprocess.
fn split_path_origins(raw: &std::ffi::OsStr, managed_dir: &Path) -> Vec<PathBuf> {
    std::env::split_paths(raw)
        .filter(|dir| !same_dir(dir, managed_dir))
        .collect()
}

/// The directories on this process's `PATH`, minus the Ryu-managed bin dir.
fn path_origin_dirs(managed_dir: &Path) -> Vec<PathBuf> {
    let Some(path) = std::env::var_os("PATH") else {
        return Vec::new();
    };
    split_path_origins(&path, managed_dir)
}

/// First `dirs` entry containing an executable named `bin`, as an absolute path.
fn lookup_in(dirs: &[PathBuf], bin: &str) -> Option<PathBuf> {
    let file = exe_name(bin);
    dirs.iter()
        .map(|dir| dir.join(&file))
        .find(|candidate| candidate.is_file())
        .map(|candidate| std::fs::canonicalize(&candidate).unwrap_or(candidate))
}

/// The pure resolver behind [`resolve_mesh_pair`], parameterized so the precedence
/// can be tested against temp dirs standing in for the two origins.
fn resolve_pair_in(
    path_dirs: &[PathBuf],
    managed_dir: &Path,
    env_daemon: Option<&str>,
    env_cli: Option<&str>,
) -> Result<MeshPair, MissingMesh> {
    // An explicit env override is per-binary and outranks everything: the operator
    // pointed at a specific file, so the same-origin rule (which exists to stop
    // *discovery* from mixing) does not apply to it.
    let explicit = |raw: Option<&str>| -> Option<PathBuf> {
        let raw = raw?;
        let p = PathBuf::from(raw);
        if p.is_file() {
            return Some(std::fs::canonicalize(&p).unwrap_or(p));
        }
        // A bare name in the override still resolves on PATH, as it did before.
        binary_resolves(raw)
            .then(|| lookup_in(path_dirs, raw))
            .flatten()
    };
    let env_daemon_path = explicit(env_daemon);
    let env_cli_path = explicit(env_cli);
    if let (Some(daemon), Some(cli)) = (&env_daemon_path, &env_cli_path) {
        return Ok(MeshPair {
            daemon: daemon.clone(),
            cli: cli.clone(),
            origin: "env",
        });
    }

    let managed_dirs = [managed_dir.to_path_buf()];
    let from = |dirs: &[PathBuf], origin: &'static str| -> Option<MeshPair> {
        // A half-override fills only its own slot; the other still comes from a
        // discovered origin.
        let daemon = env_daemon_path
            .clone()
            .or_else(|| lookup_in(dirs, DAEMON_BIN))?;
        let cli = env_cli_path.clone().or_else(|| lookup_in(dirs, CLI_BIN))?;
        Some(MeshPair {
            daemon,
            cli,
            origin,
        })
    };
    if let Some(pair) = from(path_dirs, "PATH") {
        return Ok(pair);
    }
    if let Some(pair) = from(&managed_dirs, "managed") {
        return Ok(pair);
    }

    // Report what is genuinely absent EVERYWHERE, which is what a user can act on.
    let mut missing: Vec<String> = [DAEMON_BIN, CLI_BIN]
        .into_iter()
        .filter(|bin| {
            lookup_in(path_dirs, bin).is_none() && lookup_in(&managed_dirs, bin).is_none()
        })
        .map(exe_name)
        .collect();
    if missing.is_empty() {
        // Both exist but only in DIFFERENT origins — the mixed pair the same-origin
        // rule refuses. Rare (a Ryu install always lands both), but naming neither
        // binary would produce a message that reads like a bug. Report both, and let
        // the install path lay down a complete managed pair.
        missing = [DAEMON_BIN, CLI_BIN].into_iter().map(exe_name).collect();
    }
    Err(MissingMesh {
        missing,
        can_install: downloader::can_install(),
    })
}

/// Resolve the absolute `tailscaled` + `tailscale` pair this node will run.
///
/// Precedence: explicit `RYU_TAILSCALED_BIN`/`RYU_TAILSCALE_BIN` → a complete pair
/// on `PATH` (excluding Ryu's own bin dir) → the Ryu-managed pair. See the section
/// comment above for why this is same-origin.
pub(crate) fn resolve_mesh_pair() -> Result<MeshPair, MissingMesh> {
    let managed_dir = crate::paths::bin_dir();
    let path_dirs = path_origin_dirs(&managed_dir);
    resolve_pair_in(
        &path_dirs,
        &managed_dir,
        env_bin(ENV_TAILSCALED_BIN).as_deref(),
        env_bin(ENV_TAILSCALE_BIN).as_deref(),
    )
}

/// Fail EARLY and ACTIONABLY when no complete Tailscale client pair is available.
///
/// PURE: it resolves and reports, it never downloads. `start()` runs from
/// `start_all()` at boot, and a 38 MB fetch during boot is the wrong behaviour —
/// installing is a user-initiated action, driven from
/// `POST /api/setup/tailscale/install` after `POST /api/mesh/config` reports
/// `can_install`.
pub(crate) fn ensure_mesh_binaries() -> Result<(), MissingMesh> {
    resolve_mesh_pair().map(|_| ())
}

/// Restrict the authkey file so only the current owner can read it.
///
/// On unix this is `chmod 0600`. On Windows — this repo's primary platform — a
/// unix mode bit is a no-op, so we replace the file's DACL via `icacls` to grant
/// only the current user (and remove inherited ACEs). It runs before the key is
/// written. Best-effort: a failure logs but does not abort enrollment (the file
/// exists only while `tailscale up` runs, so the at-rest window is minimal).
fn restrict_keyfile_perms(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        if let Err(e) = std::fs::set_permissions(path, perms) {
            tracing::warn!("tailscale: failed to chmod 0600 authkey file: {e}");
        }
    }
    #[cfg(windows)]
    {
        // `icacls <file> /inheritance:r /grant:r %USERNAME%:F` strips inherited
        // ACEs and grants only the current user. %USERNAME% resolves the owner.
        let user = std::env::var("USERNAME").unwrap_or_default();
        if user.is_empty() {
            tracing::warn!("tailscale: USERNAME unset; cannot restrict authkey ACL");
            return;
        }
        let out = std::process::Command::new("icacls")
            .arg(path)
            .arg("/inheritance:r")
            .arg("/grant:r")
            .arg(format!("{user}:F"))
            .no_window()
            .output();
        match out {
            Ok(o) if !o.status.success() => tracing::warn!(
                "tailscale: icacls on authkey file failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            ),
            Err(e) => tracing::warn!("tailscale: failed to run icacls on authkey file: {e}"),
            _ => {}
        }
    }
}

/// Whether a mesh authkey is waiting for enrollment (captured by
/// [`scrub_authkey_to_keyfile`]). `start()` uses this to decide whether to enroll
/// the node, since the env var was scrubbed in `main()`.
fn authkey_keyfile_present() -> bool {
    pending_authkey().is_some()
}

/// Read `RYU_MESH_AUTHKEY` once at startup, keep it in memory for the next
/// `tailscale up`, and scrub it from this process's environment so NO spawned
/// child (gateway, headroom, ACP agents, `tailscaled`) can inherit it via
/// `/proc/self/environ` (#478, security HIGH V2). Called from `main()` before
/// any child is spawned.
///
/// The key is not written to disk here. `tailscale up` reads it from a one-shot
/// owner-only file that exists only while that command runs. An `authkey` file
/// an older build left in the mesh directory is taken into memory (when the env
/// var is unset) and deleted.
pub async fn scrub_authkey_to_keyfile() {
    let legacy = legacy_authkey_path();
    let legacy_key = match tokio::fs::read_to_string(&legacy).await {
        Ok(body) => {
            if let Err(e) = tokio::fs::remove_file(&legacy).await {
                tracing::warn!("tailscale: could not delete the legacy authkey file: {e}");
            }
            Some(body.trim().to_owned()).filter(|key| !key.is_empty())
        }
        Err(_) => None,
    };
    let key = std::env::var(ENV_AUTHKEY)
        .ok()
        .filter(|s| !s.is_empty())
        .or(legacy_key);
    let Some(key) = key else {
        return;
    };
    set_pending_authkey(Some(key));
    // Scrub the secret from this process's env so children can't read it.
    std::env::remove_var(ENV_AUTHKEY);
    tracing::info!("tailscale: mesh authkey held in memory and scrubbed from env");
}

/// How long a `tailscale lock status` answer is reused. The status route is polled, and
/// Tailnet Lock changes on the scale of admin actions, not seconds.
const LOCK_STATUS_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// The last Tailnet Lock answer and when it was read.
static LOCK_STATUS_CACHE: std::sync::Mutex<Option<(std::time::Instant, Option<bool>)>> =
    std::sync::Mutex::new(None);

/// `Enabled` from `tailscale lock status --json` output, or `None` when it is not there.
fn parse_lock_status(stdout: &str) -> Option<bool> {
    serde_json::from_str::<serde_json::Value>(stdout.trim())
        .ok()?
        .get("Enabled")?
        .as_bool()
}

/// Whether Tailnet Lock is enabled on the tailnet this daemon is in, or `None` when the
/// client cannot say (an old client, a daemon that is not logged in). Cached briefly.
async fn tailnet_lock_enabled(cli: &Path) -> Option<bool> {
    let fresh = LOCK_STATUS_CACHE
        .lock()
        .ok()
        .and_then(|guard| *guard)
        .filter(|(read_at, _)| read_at.elapsed() < LOCK_STATUS_TTL);
    if let Some((_, enabled)) = fresh {
        return enabled;
    }
    let args = [
        format!("--socket={}", socket_path().display()),
        "lock".to_owned(),
        "status".to_owned(),
        "--json".to_owned(),
    ];
    let enabled = match cli_output(cli, &args).await {
        Ok(output) if output.status.success() => {
            parse_lock_status(&String::from_utf8_lossy(&output.stdout))
        }
        _ => None,
    };
    if let Ok(mut guard) = LOCK_STATUS_CACHE.lock() {
        *guard = Some((std::time::Instant::now(), enabled));
    }
    enabled
}

/// `tailscale status --json` plus the key posture the status route reports.
///
/// Adds a top-level `TailnetLock` object (`Enabled`) read from `tailscale lock status
/// --json`, because Tailnet Lock is not part of `status --json`. Only a running Tailscale
/// SaaS daemon is asked: Headscale has no Tailnet Lock, and a daemon that is not running has
/// no tailnet to ask about. The node key expiry is already in `Self.KeyExpiry`.
pub async fn status_json() -> anyhow::Result<serde_json::Value> {
    let mut raw = daemon_status_json().await?;
    let wants_lock = raw.get("BackendState").and_then(|v| v.as_str()) == Some("Running")
        && ryu_mesh::parse_status_json(true, &raw).backend.as_deref() == Some("tailscale");
    if wants_lock {
        if let Ok(pair) = resolve_mesh_pair() {
            if let Some(enabled) = tailnet_lock_enabled(&pair.cli).await {
                raw["TailnetLock"] = serde_json::json!({ "Enabled": enabled });
            }
        }
    }
    Ok(raw)
}

/// Run `tailscale status --json` against Ryu's custom socket and return the
/// parsed JSON. Errors when the daemon is absent or returns non-JSON (the caller
/// maps that to an enabled-but-unreachable status).
async fn daemon_status_json() -> anyhow::Result<serde_json::Value> {
    let cli = resolve_mesh_pair()?.cli;
    let output = tokio::process::Command::new(&cli)
        .arg(format!("--socket={}", socket_path().display()))
        .arg("status")
        .arg("--json")
        .no_window()
        .output()
        .await
        .context("running `tailscale status --json`")?;
    // `tailscale status --json` prints the status object even when NeedsLogin, so
    // a non-zero exit can still carry valid JSON; try to parse stdout regardless.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .with_context(|| format!("parsing tailscale status json (exit {:?})", output.status))?;
    Ok(value)
}

/// The argv that mounts one public path of Core on the Funnel.
///
/// `tailscale funnel --bg --set-path <mount> http://127.0.0.1:<port><mount>`: a path-scoped
/// mount, never the bare `funnel --bg <port>` that publishes Core's whole port at `/`.
/// Tailscale strips the mount from the request path and joins the rest onto the target's
/// path, so the target carries the mount (without a trailing slash) to land the request
/// back on the same Core route. Verified against the 1.102.2 CLI and `ipn/ipnlocal/serve.go`.
fn funnel_mount_args(socket: &Path, mount: &str, port: u16) -> Vec<String> {
    vec![
        format!("--socket={}", socket.display()),
        "funnel".to_owned(),
        "--bg".to_owned(),
        "--set-path".to_owned(),
        mount.to_owned(),
        format!("http://127.0.0.1:{port}{}", mount.trim_end_matches('/')),
    ]
}

/// The argv that clears the whole Funnel/serve config (`tailscale funnel reset`).
fn funnel_reset_args(socket: &Path) -> Vec<String> {
    vec![
        format!("--socket={}", socket.display()),
        "funnel".to_owned(),
        "reset".to_owned(),
    ]
}

/// The argv that prints the current serve config as JSON.
fn funnel_status_args(socket: &Path) -> Vec<String> {
    vec![
        format!("--socket={}", socket.display()),
        "funnel".to_owned(),
        "status".to_owned(),
        "--json".to_owned(),
    ]
}

/// Run one `tailscale funnel` invocation, mapping a non-zero exit to its stderr.
async fn run_funnel(cli: &Path, args: &[String]) -> anyhow::Result<std::process::Output> {
    let output = cli_output(cli, args)
        .await
        .context("running `tailscale funnel`")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("tailscale funnel failed: {}", stderr.trim());
    }
    Ok(output)
}

/// Ensure a Tailscale Funnel publishes Core's webhook paths, returning the public URL.
///
/// Only [`ryu_webhook_ingress::FUNNEL_PUBLIC_MOUNTS`] are published, never Core's whole
/// port: each is a path-scoped `tailscale funnel --bg --set-path` mount (see
/// [`funnel_mount_args`]). Whatever the Funnel served before is cleared first, because an
/// older Ryu mounted the entire port at `/` and that mount outlives the process in the
/// daemon's state. If any mount fails the Funnel is torn down again rather than left half
/// applied. Requires the daemon Running with HTTPS provisioned; surfaces a clear error
/// otherwise so P6's ingress seam can fall back.
pub async fn ensure_funnel(port: u16) -> anyhow::Result<String> {
    let cli = resolve_mesh_pair()?.cli;
    let socket = socket_path();
    run_funnel(&cli, &funnel_reset_args(&socket)).await?;
    for mount in ryu_webhook_ingress::FUNNEL_PUBLIC_MOUNTS {
        if let Err(error) = run_funnel(&cli, &funnel_mount_args(&socket, mount, port)).await {
            if let Err(reset_error) = run_funnel(&cli, &funnel_reset_args(&socket)).await {
                tracing::warn!("tailscale: could not roll back a partial Funnel: {reset_error}");
            }
            return Err(error);
        }
    }
    funnel_url(port)
        .await
        .ok_or_else(|| anyhow::anyhow!("funnel started but no public URL is available"))
}

/// Turn the Funnel off: clear every serve/funnel mount on Ryu's mesh daemon.
///
/// Run when the mesh daemon stops (mesh disabled, backend switched, Core shutdown) and when
/// the configured webhook ingress is not the Funnel, so a public mount never outlives the
/// reason it was created. `funnel reset` clears the whole serve config, which Ryu does not
/// otherwise use.
pub async fn teardown_funnel() -> anyhow::Result<()> {
    let cli = resolve_mesh_pair()?.cli;
    run_funnel(&cli, &funnel_reset_args(&socket_path())).await?;
    Ok(())
}

/// What [`reconcile_funnel`] should do with the daemon's current serve config.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FunnelAction {
    Keep,
    Reset,
}

/// Decide whether the serve config in `config` (the JSON of `tailscale funnel status
/// --json`) may stay, given whether the Funnel is the configured webhook ingress.
///
/// Anything published when the Funnel is not wanted is reset. When it is wanted, the config
/// must publish only [`ryu_webhook_ingress::FUNNEL_PUBLIC_MOUNTS`]: a mount outside them (an
/// older build's whole-port `/`), a raw TCP forward, a service, or a foreground session is
/// reset so that [`ensure_funnel`] can rebuild it scoped.
fn funnel_action(config: &serde_json::Value, funnel_wanted: bool) -> FunnelAction {
    let non_empty = |key: &str| {
        config
            .get(key)
            .and_then(|value| value.as_object())
            .is_some_and(|map| !map.is_empty())
    };
    let handlers = config
        .get("Web")
        .and_then(|value| value.as_object())
        .into_iter()
        .flat_map(|hosts| hosts.values())
        .filter_map(|host| host.get("Handlers").and_then(|value| value.as_object()))
        .flat_map(|handlers| handlers.keys());
    let tcp_forwards = config
        .get("TCP")
        .and_then(|value| value.as_object())
        .into_iter()
        .flat_map(|ports| ports.values())
        .any(|port| port.get("TCPForward").is_some());
    let exposes_anything = non_empty("Web")
        || non_empty("AllowFunnel")
        || non_empty("Services")
        || non_empty("Foreground")
        || tcp_forwards;
    if !exposes_anything {
        return FunnelAction::Keep;
    }
    if !funnel_wanted {
        return FunnelAction::Reset;
    }
    let mut mounts_all_public = true;
    for mount in handlers {
        mounts_all_public &= ryu_webhook_ingress::FUNNEL_PUBLIC_MOUNTS.contains(&mount.as_str());
    }
    if mounts_all_public && !tcp_forwards && !non_empty("Services") && !non_empty("Foreground") {
        FunnelAction::Keep
    } else {
        FunnelAction::Reset
    }
}

/// Whether the configured webhook ingress is the Tailscale Funnel. A preference store that
/// cannot be read counts as "not wanted", the direction that publishes nothing.
async fn funnel_is_the_configured_ingress() -> bool {
    match crate::server::preferences::PreferencesStore::open_default() {
        Ok(store) => {
            crate::webhook_ingress::configured_kind(&store).await
                == crate::webhook_ingress::IngressKind::TailscaleFunnel
        }
        Err(_) => false,
    }
}

/// Bring the daemon's Funnel in line with the configured ingress once the daemon is
/// reachable: tear down a Funnel that is no longer the ingress, and one an older build left
/// publishing more than the webhook paths. Best-effort; the daemon keeps running if this
/// cannot read or reset the config, and the failure is logged.
async fn reconcile_funnel(cli: &Path) {
    let wanted = funnel_is_the_configured_ingress().await;
    let socket = socket_path();
    let status = match run_funnel(cli, &funnel_status_args(&socket)).await {
        Ok(output) => serde_json::from_slice::<serde_json::Value>(&output.stdout).ok(),
        Err(error) => {
            tracing::debug!("tailscale: could not read the Funnel config: {error}");
            None
        }
    };
    let action = match &status {
        Some(config) => funnel_action(config, wanted),
        // Unreadable: reset only when nothing should be published anyway.
        None if !wanted => FunnelAction::Reset,
        None => FunnelAction::Keep,
    };
    if action == FunnelAction::Reset {
        match run_funnel(cli, &funnel_reset_args(&socket)).await {
            Ok(_) => tracing::info!(
                funnel_wanted = wanted,
                "tailscale: cleared a Funnel that should not be publishing"
            ),
            Err(error) => tracing::warn!("tailscale: could not clear the Funnel: {error}"),
        }
    }
}

/// The active public Funnel URL, derived from this node's MagicDNS name, or `None` when the
/// daemon is not reachable.
///
/// Funnel is served on its default HTTPS port (443), whatever Core's own port is, so the
/// URL never carries `port`; the parameter stays only to match the host seam.
pub async fn funnel_url(_port: u16) -> Option<String> {
    let raw = daemon_status_json().await.ok()?;
    let dns = raw
        .get("Self")
        .and_then(|s| s.get("DNSName"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim_end_matches('.'))
        .filter(|s| !s.is_empty())?;
    Some(format!("https://{dns}"))
}

/// The argv for the one-shot enrollment `tailscale up`.
///
/// Always carries `--reset`. Without it, `tailscale up` refuses to run whenever
/// the daemon's stored prefs hold a non-default setting the new command does not
/// repeat ("requires mentioning all non-default flags") — exactly what happens
/// when a node switches between Headscale (`--login-server=<url>`) and Tailscale
/// SaaS (no `--login-server`). Ryu persists no record of the control URL it last
/// enrolled with, and this `up` only ever runs once per freshly supplied authkey
/// (the keyfile is deleted right after), so every call here IS a new enrollment
/// and resetting is the correct semantics rather than a heuristic.
///
/// `--reset` returns every pref this command does not name to its default, so
/// every pref Ryu relies on must be named here: the authkey, the control URL
/// (when Headscale), and the hostname. `--ssh=false` is named too: Ryu never runs
/// Tailscale SSH, which would let a tailnet peer open a shell as Core's user. Daemon-level settings (userspace TUN,
/// SOCKS5/HTTP proxies, socket, state path) are `tailscaled` flags, not prefs,
/// and Funnel lives in the separate serve config, so neither is affected.
fn enrollment_up_args(
    socket: &Path,
    keyfile: &Path,
    login_server: Option<&str>,
    hostname: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        format!("--socket={}", socket.display()),
        "up".to_owned(),
        "--reset".to_owned(),
        format!("--authkey=file:{}", keyfile.display()),
        // Tailscale SSH stays off. `--reset` already returns it to the default, but
        // stating it keeps that true if the reset ever stops covering it.
        "--ssh=false".to_owned(),
    ];
    if let Some(login) = login_server {
        args.push(format!("--login-server={login}"));
    }
    if let Some(host) = hostname {
        args.push(format!("--hostname={host}"));
    }
    args
}

// ── Client posture: SSH, root, version ────────────────────────────────────────

/// Oldest `tailscale` a PATH- or env-supplied client may be: the release that fixed
/// ts-2026-004. Ryu's own pinned client ([`downloader::TAILSCALE_TARGET_VERSION`]) is
/// above it; this guards the client a user installed themselves, which Ryu adopts
/// instead of replacing. Raise it to the first fixed release when a new advisory lands.
pub const MIN_SAFE_TAILSCALE: &str = "1.98.9";

/// How long any one posture probe of the CLI may take.
const CLI_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// `major.minor.patch` from the start of `tailscale version` output (`1.98.9`,
/// `1.98.9-t1234abcd-g5678`, or `v1.98.9`), or `None` when it does not parse.
fn parse_tailscale_version(raw: &str) -> Option<(u64, u64, u64)> {
    let token = raw.trim().lines().next()?.split_whitespace().next()?;
    let core = token
        .trim_start_matches('v')
        .split(['-', '+'])
        .next()
        .unwrap_or_default();
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Whether `tailscale version` output names a release below [`MIN_SAFE_TAILSCALE`], or
/// `None` when the output is not a version.
fn version_below_min_safe(version_output: &str) -> Option<bool> {
    let found = parse_tailscale_version(version_output)?;
    let floor = parse_tailscale_version(MIN_SAFE_TAILSCALE)?;
    Some(found < floor)
}

/// Run the mesh CLI with `args` and capture its output, bounded by [`CLI_PROBE_TIMEOUT`].
async fn cli_output(cli: &Path, args: &[String]) -> anyhow::Result<std::process::Output> {
    let run = tokio::process::Command::new(cli)
        .args(args)
        .no_window()
        .output();
    tokio::time::timeout(CLI_PROBE_TIMEOUT, run)
        .await
        .context("the tailscale CLI did not answer in time")?
        .with_context(|| format!("running `{}`", cli.display()))
}

/// Warn when an adopted (PATH or env) client is older than [`MIN_SAFE_TAILSCALE`].
///
/// Warn, never refuse: some users rely on their own install, and an unparseable version
/// (a distro build, a wrapper) is not evidence of a vulnerable one. The managed client is
/// pinned above the floor, so it is skipped.
async fn warn_if_client_below_min_safe(pair: &MeshPair) {
    if pair.origin == "managed" {
        return;
    }
    let output = match cli_output(&pair.cli, &["version".to_owned()]).await {
        Ok(output) if output.status.success() => output,
        Ok(_) | Err(_) => {
            tracing::warn!(
                cli = %pair.cli.display(),
                "tailscale: could not read the version of the adopted client"
            );
            return;
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    match version_below_min_safe(&stdout) {
        Some(true) => tracing::warn!(
            origin = pair.origin,
            cli = %pair.cli.display(),
            version = stdout.lines().next().unwrap_or_default().trim(),
            minimum = MIN_SAFE_TAILSCALE,
            "tailscale: the adopted client is older than the minimum safe release \
             (ts-2026-004). Upgrade it, or remove it from PATH so Ryu installs its \
             pinned client"
        ),
        Some(false) => {}
        None => tracing::warn!(
            cli = %pair.cli.display(),
            "tailscale: could not parse the adopted client's version, so it cannot be \
             checked against the minimum safe release ({MIN_SAFE_TAILSCALE})"
        ),
    }
}

/// The `RunSSH` pref from `tailscale debug prefs` output, or `None` when unreadable.
fn run_ssh_enabled(prefs_json: &str) -> Option<bool> {
    serde_json::from_str::<serde_json::Value>(prefs_json)
        .ok()?
        .get("RunSSH")?
        .as_bool()
}

/// Make sure Tailscale SSH is off on Ryu's mesh daemon.
///
/// `up --ssh=false` only runs on enrollment, and the daemon's prefs persist in its state
/// file, so an adopted daemon (or one a user once ran with `--ssh`) can still have SSH on.
/// In userspace mode that is a shell as Core's user for any peer the tailnet policy allows.
/// If it is on, turn it off and warn; if it cannot be turned off, refuse to continue.
async fn ensure_ssh_off(cli: &Path) -> anyhow::Result<()> {
    let socket = format!("--socket={}", socket_path().display());
    let prefs = cli_output(
        cli,
        &[socket.clone(), "debug".to_owned(), "prefs".to_owned()],
    )
    .await;
    let enabled = match &prefs {
        Ok(output) if output.status.success() => {
            run_ssh_enabled(&String::from_utf8_lossy(&output.stdout))
        }
        _ => None,
    };
    if enabled == Some(false) {
        return Ok(());
    }
    if enabled == Some(true) {
        tracing::warn!(
            "tailscale: Tailscale SSH is enabled on Ryu's mesh daemon; turning it off. Ryu \
             never runs Tailscale SSH, and with it on a tailnet peer could open a shell as \
             this user"
        );
    }
    let set = cli_output(cli, &[socket, "set".to_owned(), "--ssh=false".to_owned()]).await;
    let turned_off = matches!(&set, Ok(output) if output.status.success());
    if enabled == Some(true) && !turned_off {
        anyhow::bail!(
            "Tailscale SSH is enabled on Ryu's mesh daemon and could not be turned off \
             (`tailscale set --ssh=false` failed); refusing to run the mesh with a tailnet \
             shell exposed"
        );
    }
    Ok(())
}

/// Advisory printed when Core runs as root with the mesh on, or `None` when it does not.
///
/// A root Core makes `tailscaled` a root daemon too, so any daemon-level flaw (Tailscale
/// SSH, serve sockets) is a root flaw. Ryu's userspace mode needs no privileges.
fn mesh_root_advisory(running_as_root: bool) -> Option<&'static str> {
    running_as_root.then_some(
        "tailscale: Core is running as root with the mesh enabled, so tailscaled runs as root \
         too. Userspace networking needs no privileges; run Core as an unprivileged service user",
    )
}

fn running_as_root() -> bool {
    #[cfg(unix)]
    {
        // SAFETY: `geteuid` takes no arguments, has no preconditions and cannot fail.
        unsafe { libc::geteuid() == 0 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Lifecycle manager for the Tailscale/Headscale mesh daemon.
pub struct TailscaleManager {
    daemon: ProcessHandle,
    running: Arc<AtomicBool>,
    /// Global download center (#456), injected at construction in `main.rs`.
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl TailscaleManager {
    pub fn new() -> Self {
        Self {
            daemon: ProcessHandle::new(),
            running: Arc::new(AtomicBool::new(false)),
            downloads: None,
        }
    }

    /// Inject the global download center (called at the `main.rs` build site).
    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }
}

impl Default for TailscaleManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for TailscaleManager {
    fn name(&self) -> &'static str {
        "tailscale"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let daemon = self.daemon.clone();
        let running = Arc::clone(&self.running);
        Box::pin(async move {
            if !ryu_mesh::is_enabled() {
                anyhow::bail!(
                    "mesh disabled: enable the mesh in the desktop (Gateway → Integrations) or set RYU_MESH_ENABLED=1"
                );
            }

            // Refuse BEFORE spawning anything: a non-Tailscale backend used to
            // reach the enrollment branch only after `tailscaled` was already
            // running, leaving an orphan daemon (and its loopback proxies) behind.
            let selected = crate::sidecar::tailscale::mesh_backend().await.0;
            if !uses_tailscaled(selected) {
                anyhow::bail!(
                    "{} is the selected network backend; use the {} sidecar instead",
                    selected.as_str(),
                    selected.sidecar_name()
                );
            }

            // Resolved BEFORE anything else so a machine without a complete client
            // pair gets one clear sentence instead of an OS errno from deep in the
            // spawn path. Pure — `start()` runs at boot from `start_all()`, so it
            // must never download; the install is user-initiated (see
            // `resolve_mesh_pair`'s doc and `POST /api/mesh/config`).
            let pair = resolve_mesh_pair()?;
            // Log the RESOLVED ABSOLUTE PATHS and which origin won. Precedence is
            // otherwise unobservable, and "Ryu ran the wrong tailscale" is exactly
            // the report this line answers in one look — including the case where a
            // user with only half a pair on PATH now gets the managed pair for BOTH
            // binaries rather than a mixed one.
            tracing::info!(
                origin = pair.origin,
                daemon = %pair.daemon.display(),
                cli = %pair.cli.display(),
                "tailscale: resolved mesh binaries"
            );

            // A root Core makes tailscaled a root daemon; say so loudly. Not refused:
            // managed containers legitimately run as root.
            if let Some(advisory) = mesh_root_advisory(running_as_root()) {
                tracing::error!("{advisory}");
            }
            warn_if_client_below_min_safe(&pair).await;

            // Ensure the per-node state dir exists.
            tokio::fs::create_dir_all(mesh_dir())
                .await
                .context("creating ~/.ryu/mesh")?;
            // `tailscaled.state` holds the node's private keys in tailscaled's
            // own format, which Ryu cannot seal; keep the directory owner-only, and
            // refuse to run the daemon when that cannot be guaranteed.
            restrict_mesh_dir(&mesh_dir())?;

            // From here on Core's `tailscaled` may be handing tailnet peers to Core as
            // loopback, so loopback stops proving a local caller (see `daemon_active`).
            // Set BEFORE spawning so the daemon never listens while this reads false.
            DAEMON_ACTIVE.store(true, Ordering::Release);

            // Adopt an already-running Ryu mesh daemon (e.g. left over from a
            // prior run) instead of double-spawning.
            if daemon_status_json().await.is_ok() {
                tracing::info!("tailscale: daemon already reachable on custom socket, adopting");
                running.store(true, Ordering::Relaxed);
                // Still (re-)assert login state below so an adopted-but-logged-out
                // daemon enrolls.
            } else {
                let socks = socks5_addr();
                let http_proxy = http_proxy_addr();
                let bin = pair.daemon.display().to_string();
                tracing::info!(
                    bin = %bin,
                    socks = socks.as_deref().unwrap_or("off"),
                    http_proxy = http_proxy.as_deref().unwrap_or("off"),
                    "tailscale: spawning tailscaled (userspace networking)"
                );
                // Userspace networking: no TUN, no root. The SOCKS5 + HTTP proxies are
                // opt-in (see the module docs): nothing in Ryu dials through them and
                // they are unauthenticated. State + socket live under ~/.ryu/mesh.
                let args = daemon_spawn_args(
                    &socket_path(),
                    &state_path(),
                    socks.as_deref(),
                    http_proxy.as_deref(),
                );
                // The authkey is NOT passed in the daemon env (it goes to the
                // one-shot `tailscale up` via a 0600 keyfile), so no secret env here.
                if let Err(error) = daemon.start_path_with_env(&bin, &args, &[]).await {
                    // Nothing was spawned, so nothing is forwarding.
                    DAEMON_ACTIVE.store(false, Ordering::Release);
                    return Err(error).with_context(|| format!("spawning tailscaled ({bin})"));
                }

                // Wait for the daemon's control socket to answer status.
                tokio::time::timeout(std::time::Duration::from_secs(30), async {
                    loop {
                        if daemon_status_json().await.is_ok() {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    }
                })
                .await
                .context("tailscaled did not become reachable within 30s")?;
            }

            // The daemon is reachable (spawned or adopted). Its prefs persist, so make
            // sure Tailscale SSH is off before anything is enrolled.
            ensure_ssh_off(&pair.cli).await?;
            reconcile_funnel(&pair.cli).await;

            // One-shot enrollment: `tailscale up` with the authkey file (and the
            // optional Headscale login server). The authkey was taken into memory
            // and scrubbed from the env back in `main()` (`scrub_authkey_to_keyfile`),
            // so enrollment is gated on that in-memory key, not the (now-absent) env
            // var. Skipped when no authkey is configured (the user may enroll
            // interactively / out-of-band). The one-shot keyfile exists only while
            // `up` runs, so a long-lived secret never lingers on disk.
            if let Some(authkey) = pending_authkey() {
                // Env var takes precedence; fall back to the persisted pref so
                // the desktop UI setting is honoured without restarting Core.
                let login_server = std::env::var(ENV_LOGIN_SERVER)
                    .ok()
                    .filter(|s| !s.is_empty());
                let login_server = if login_server.is_some() {
                    login_server
                } else {
                    match crate::server::preferences::PreferencesStore::open_default() {
                        Ok(store) => store
                            .get("mesh-login-server")
                            .await
                            .ok()
                            .flatten()
                            .filter(|s| !s.is_empty()),
                        Err(_) => None,
                    }
                };
                // The Tunnel selection decides whether `--login-server` is passed
                // AT ALL, so the picker and the enrollment can never disagree.
                //
                // Before this existed the URL alone decided: empty meant SaaS. That
                // is a fine derivation but a terrible contract for a UI, because a
                // node showing "Headscale" with an empty URL would silently enroll
                // into Tailscale's SaaS instead. So Headscale + no URL is refused
                // with the sentence that fixes it, rather than quietly becoming the
                // other backend.
                //
                // A legacy node with no backend preference is resolved by
                // mesh_backend() before this branch: an old Headscale URL or
                // Tailscale state/authkey keeps its previous control plane. A
                // genuinely fresh node resolves to Tailcat and never reaches
                // this Tailscale-only enrollment path.
                let (backend, explicit) = mesh_backend().await;
                let control_url = match (backend, login_server) {
                    (MeshBackend::Headscale, Some(login)) => Some(login),
                    (MeshBackend::Headscale, None) if explicit => {
                        anyhow::bail!(
                            "the tunnel is set to Headscale but no control server URL is \
                             configured. Set one (Gateway → Network → Control server URL, or \
                             {ENV_LOGIN_SERVER}), or switch the tunnel to Tailscale in the node \
                             menu."
                        );
                    }
                    (MeshBackend::Headscale, None) => {
                        tracing::warn!(
                            "tailscale: no tunnel backend chosen and no control server URL — \
                             enrolling against Tailscale SaaS, as this node did before. Pick a \
                             backend under Toolkits > VPN in the desktop Computer dialog to make the \
                             choice explicit."
                        );
                        None
                    }
                    // SaaS coordinates through Tailscale's own servers; passing a
                    // stale Headscale URL here would send the node to the wrong
                    // control plane, so the URL is ignored on purpose.
                    (MeshBackend::Tailscale, _) => None,
                    (MeshBackend::Tailcat, _) => {
                        anyhow::bail!(
                            "Tailcat is the selected network backend; use the Tailcat sidecar"
                        );
                    }
                    (MeshBackend::Cloudflared, _) => {
                        anyhow::bail!(
                            "Cloudflared is the selected tunnel backend; use the Cloudflared sidecar"
                        );
                    }
                    (MeshBackend::OpenTunnel, _) => {
                        anyhow::bail!(
                            "OpenTunnel is the selected tunnel backend; use the OpenTunnel sidecar"
                        );
                    }
                    (MeshBackend::Plugin, _) => {
                        anyhow::bail!(
                            "a plugin tunnel is the selected tunnel backend; use the plugin tunnel"
                        );
                    }
                };
                // Register under a sanitized whole-hostname label rather than
                // letting Tailscale take the first one (see `mesh_hostname`).
                // The key reaches `tailscale up` through a one-shot owner-only
                // file that is removed when `keyfile` drops (after `up`, or on
                // any error before it).
                let keyfile = write_ephemeral_authkey(&mesh_dir(), &authkey)?;
                let up_args = enrollment_up_args(
                    &socket_path(),
                    keyfile.path(),
                    control_url.as_deref(),
                    mesh_hostname().as_deref(),
                );
                let bin = pair.cli.display().to_string();
                tracing::info!(bin = %bin, "tailscale: enrolling node (`tailscale up`)");
                let out = tokio::process::Command::new(&pair.cli)
                    .args(&up_args)
                    .no_window()
                    .output()
                    .await
                    .with_context(|| format!("running `{bin} up`"))?;
                // Enrollment is one-shot; remove the keyfile and forget the key
                // regardless of outcome, as before.
                drop(keyfile);
                set_pending_authkey(None);
                if !out.status.success() {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    anyhow::bail!("`tailscale up` failed: {}", stderr.trim());
                }
            } else {
                tracing::info!(
                    "tailscale: no mesh authkey keyfile present; daemon started but node is not enrolled"
                );
            }

            running.store(true, Ordering::Relaxed);
            tracing::info!("tailscale: mesh daemon started");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let daemon = self.daemon.clone();
        let running = Arc::clone(&self.running);
        Box::pin(async move {
            // Best-effort `tailscale down` so the node leaves the tailnet cleanly.
            // An unresolvable pair here is not an error for a stop request — there
            // is nothing enrolled to take down.
            if let Ok(pair) = resolve_mesh_pair() {
                // Take the public Funnel down first: it must not outlive the mesh.
                if let Err(error) = run_funnel(&pair.cli, &funnel_reset_args(&socket_path())).await
                {
                    tracing::debug!("tailscale: Funnel teardown on stop: {error}");
                }
                let _ = tokio::process::Command::new(&pair.cli)
                    .arg(format!("--socket={}", socket_path().display()))
                    .arg("down")
                    .no_window()
                    .output()
                    .await;
            }
            daemon.stop().await?;
            running.store(false, Ordering::Relaxed);
            DAEMON_ACTIVE.store(false, Ordering::Release);
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let running = Arc::clone(&self.running);
        Box::pin(async move {
            if !running.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("daemon not running".into());
            }
            match daemon_status_json().await {
                Ok(raw) => {
                    let state = raw
                        .get("BackendState")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown");
                    if state == "Running" {
                        HealthStatus::Healthy
                    } else {
                        HealthStatus::Degraded(format!("backend state: {state}"))
                    }
                }
                Err(e) => HealthStatus::Unhealthy(format!("status query failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.daemon.is_running()
    }

    fn uninstall(&self, delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_ryu_binary("tailscaled").await;
            crate::sidecar::remove_ryu_binary("tailscale").await;
            crate::sidecar::remove_from_version_store("tailscale");
            if delete_data {
                // The mesh dir holds the daemon state + (scrubbed) keyfile.
                crate::sidecar::remove_dir(&mesh_dir()).await;
            }
            tracing::info!("tailscale uninstalled");
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrollment_up_resets_and_names_every_pref_for_headscale() {
        let args = enrollment_up_args(
            Path::new("/m/tailscaled.sock"),
            Path::new("/m/authkey"),
            Some("https://hs.example"),
            Some("node-a"),
        );
        assert_eq!(
            args,
            vec![
                "--socket=/m/tailscaled.sock",
                "up",
                "--reset",
                "--authkey=file:/m/authkey",
                "--ssh=false",
                "--login-server=https://hs.example",
                "--hostname=node-a",
            ]
        );
    }

    #[test]
    fn enrollment_and_spawn_args_never_enable_ssh_or_a_kernel_tun() {
        let up = enrollment_up_args(
            Path::new("/m/tailscaled.sock"),
            Path::new("/m/authkey"),
            Some("https://hs.example"),
            Some("node-a"),
        );
        assert!(up.iter().any(|a| a == "--ssh=false"), "got: {up:?}");
        let spawn = daemon_spawn_args(
            Path::new("/m/tailscaled.sock"),
            Path::new("/m/tailscaled.state"),
            Some("127.0.0.1:1055"),
            Some("127.0.0.1:1056"),
        );
        for args in [&up, &spawn] {
            // `--ssh=false` is the only SSH flag Ryu ever passes.
            for arg in args.iter() {
                assert!(
                    !arg.starts_with("--ssh") || arg == "--ssh=false",
                    "unexpected ssh flag {arg:?} in {args:?}"
                );
                assert!(
                    !arg.starts_with("--tun=") || arg == "--tun=userspace-networking",
                    "unexpected tun flag {arg:?} in {args:?}"
                );
            }
        }
        assert!(spawn.iter().any(|a| a == "--tun=userspace-networking"));
        assert!(!up.iter().any(|a| a.starts_with("--tun")));
    }

    #[test]
    fn run_ssh_is_read_from_the_daemon_prefs() {
        assert_eq!(
            run_ssh_enabled(r#"{"RunSSH": true, "WantRunning": true}"#),
            Some(true)
        );
        assert_eq!(run_ssh_enabled(r#"{"RunSSH": false}"#), Some(false));
        // An unreadable or unfamiliar answer is "unknown", never "off".
        assert_eq!(run_ssh_enabled(r#"{"WantRunning": true}"#), None);
        assert_eq!(run_ssh_enabled("not json"), None);
        assert_eq!(run_ssh_enabled(""), None);
    }

    #[test]
    fn running_as_root_gets_an_advisory_and_an_unprivileged_core_does_not() {
        assert!(mesh_root_advisory(true)
            .expect("advisory for root")
            .contains("running as root"));
        assert_eq!(mesh_root_advisory(false), None);
    }

    #[test]
    fn tailscale_versions_parse_from_the_cli_output() {
        assert_eq!(
            parse_tailscale_version("1.98.9\n  tailscale commit: abc\n"),
            Some((1, 98, 9))
        );
        assert_eq!(
            parse_tailscale_version("1.102.2-t6cac91817-g6ff0ddc72"),
            Some((1, 102, 2))
        );
        assert_eq!(parse_tailscale_version("v1.98.9"), Some((1, 98, 9)));
        assert_eq!(
            parse_tailscale_version("  1.98.9+build5  \n"),
            Some((1, 98, 9))
        );
        for junk in [
            "",
            "tailscale",
            "1.98",
            "1.98.x",
            "1.98.9.1",
            "unknown version",
        ] {
            assert_eq!(parse_tailscale_version(junk), None, "{junk:?}");
        }
    }

    #[test]
    fn an_adopted_client_below_the_floor_is_flagged() {
        assert_eq!(MIN_SAFE_TAILSCALE, "1.98.9");
        assert_eq!(version_below_min_safe("1.98.8\n"), Some(true));
        assert_eq!(version_below_min_safe("1.96.0\n"), Some(true));
        assert_eq!(version_below_min_safe("0.99.99\n"), Some(true));
        assert_eq!(version_below_min_safe("1.98.9\n"), Some(false));
        assert_eq!(version_below_min_safe("1.98.10\n"), Some(false));
        assert_eq!(version_below_min_safe("1.99.0\n"), Some(false));
        assert_eq!(version_below_min_safe("2.0.0\n"), Some(false));
        assert_eq!(version_below_min_safe("garbage"), None);
        // The pinned managed client must itself clear the floor.
        assert_eq!(
            version_below_min_safe(downloader::TAILSCALE_TARGET_VERSION),
            Some(false)
        );
    }

    #[test]
    fn enrollment_up_resets_when_switching_back_to_tailscale_saas() {
        // No `--login-server`: `--reset` is what returns a node previously
        // enrolled with Headscale to the default (SaaS) control URL instead of
        // `tailscale up` refusing over the unmentioned non-default flag.
        let args = enrollment_up_args(
            Path::new("/m/tailscaled.sock"),
            Path::new("/m/authkey"),
            None,
            None,
        );
        assert_eq!(
            args,
            vec![
                "--socket=/m/tailscaled.sock",
                "up",
                "--reset",
                "--authkey=file:/m/authkey",
                "--ssh=false"
            ]
        );
        assert!(!args.iter().any(|a| a.starts_with("--login-server")));
    }

    #[test]
    fn the_mesh_daemon_counts_as_a_forwarding_tunnel_for_loopback_trust() {
        // Userspace networking re-originates every tailnet peer as 127.0.0.1, so the
        // daemon must read as a forwarder. Tailscale/Headscale were the only mesh
        // backends missing from `forwarding_tunnel_active`.
        assert!(daemon_active_from(true, false, false), "running daemon");
        assert!(
            daemon_active_from(false, true, true),
            "enabled + tailscaled backend"
        );
        assert!(
            !daemon_active_from(false, true, false),
            "enabled, other backend"
        );
        assert!(
            !daemon_active_from(false, false, true),
            "backend chosen, mesh off"
        );
        assert!(!daemon_active_from(false, false, false));
    }

    #[tokio::test]
    async fn forwarding_tunnel_active_includes_the_mesh_daemon() {
        let active = FORCE_DAEMON_ACTIVE_FOR_TEST
            .scope(true, async { crate::sidecar::forwarding_tunnel_active() })
            .await;
        assert!(active);
    }

    #[test]
    fn funnel_is_scoped_to_the_webhook_paths_never_the_whole_port() {
        let socket = Path::new("/m/tailscaled.sock");
        let composio = funnel_mount_args(socket, "/api/composio/webhook", 7980);
        assert_eq!(
            composio,
            vec![
                "--socket=/m/tailscaled.sock",
                "funnel",
                "--bg",
                "--set-path",
                "/api/composio/webhook",
                "http://127.0.0.1:7980/api/composio/webhook",
            ]
        );
        // A prefix mount maps onto the same prefix, without a doubled slash.
        let workflows = funnel_mount_args(socket, "/api/workflows/", 7980);
        assert_eq!(workflows[4], "/api/workflows/");
        assert_eq!(workflows[5], "http://127.0.0.1:7980/api/workflows");
        // Every published mount carries a path restriction, a numeric loopback port and no
        // unix: target. The bare `funnel --bg <port>` form is gone.
        for mount in ryu_webhook_ingress::FUNNEL_PUBLIC_MOUNTS {
            let args = funnel_mount_args(socket, mount, 7980);
            assert!(args.iter().any(|a| a == "--set-path"), "{args:?}");
            let target = args.last().expect("target");
            assert!(target.starts_with("http://127.0.0.1:7980/"), "{target}");
            assert!(!target.contains("unix:"), "{target}");
            assert!(args.iter().all(|a| a != "7980"), "{args:?}");
        }
    }

    #[test]
    fn funnel_teardown_uses_funnel_reset() {
        assert_eq!(
            funnel_reset_args(Path::new("/m/tailscaled.sock")),
            vec!["--socket=/m/tailscaled.sock", "funnel", "reset"]
        );
        assert_eq!(
            funnel_status_args(Path::new("/m/tailscaled.sock")),
            vec!["--socket=/m/tailscaled.sock", "funnel", "status", "--json"]
        );
    }

    fn funnel_config(mounts: &[&str]) -> serde_json::Value {
        let handlers: serde_json::Map<String, serde_json::Value> = mounts
            .iter()
            .map(|mount| {
                (
                    (*mount).to_owned(),
                    serde_json::json!({ "Proxy": "http://127.0.0.1:7980" }),
                )
            })
            .collect();
        serde_json::json!({
            "TCP": { "443": { "HTTPS": true } },
            "Web": { "node.tailnet.ts.net:443": { "Handlers": handlers } },
            "AllowFunnel": { "node.tailnet.ts.net:443": true }
        })
    }

    #[test]
    fn a_funnel_that_is_not_the_ingress_is_torn_down() {
        let scoped = funnel_config(&["/api/composio/webhook", "/api/workflows/"]);
        assert_eq!(funnel_action(&scoped, false), FunnelAction::Reset);
        // Nothing published: nothing to do either way.
        assert_eq!(
            funnel_action(&serde_json::Value::Null, false),
            FunnelAction::Keep
        );
        assert_eq!(
            funnel_action(&serde_json::json!({}), false),
            FunnelAction::Keep
        );
    }

    #[test]
    fn a_wanted_funnel_keeps_only_the_public_webhook_mounts() {
        let scoped = funnel_config(&["/api/composio/webhook", "/api/workflows/"]);
        assert_eq!(funnel_action(&scoped, true), FunnelAction::Keep);
        assert_eq!(
            funnel_action(&serde_json::Value::Null, true),
            FunnelAction::Keep
        );
        // An older build mounted the whole port at `/`; that must be rebuilt scoped.
        let whole_port = funnel_config(&["/"]);
        assert_eq!(funnel_action(&whole_port, true), FunnelAction::Reset);
        let extra = funnel_config(&["/api/composio/webhook", "/api/vault/"]);
        assert_eq!(funnel_action(&extra, true), FunnelAction::Reset);
        let tcp = serde_json::json!({
            "TCP": { "8443": { "TCPForward": "127.0.0.1:22" } },
            "AllowFunnel": { "node.tailnet.ts.net:8443": true }
        });
        assert_eq!(funnel_action(&tcp, true), FunnelAction::Reset);
        let foreground = serde_json::json!({ "Foreground": { "session": { "Web": {} } } });
        assert_eq!(funnel_action(&foreground, true), FunnelAction::Reset);
    }

    #[test]
    fn tailnet_lock_is_read_from_lock_status_output() {
        assert_eq!(
            parse_lock_status(r#"{"Enabled": true, "NodeKeySigned": true}"#),
            Some(true)
        );
        assert_eq!(
            parse_lock_status("{\n  \"Enabled\": false\n}\n"),
            Some(false)
        );
        assert_eq!(parse_lock_status(r#"{"NodeKeySigned": true}"#), None);
        assert_eq!(parse_lock_status("Tailnet Lock is not supported"), None);
        assert_eq!(parse_lock_status(""), None);
    }

    #[test]
    fn only_tailscale_backends_spawn_tailscaled() {
        for backend in [MeshBackend::Headscale, MeshBackend::Tailscale] {
            assert!(uses_tailscaled(backend));
            assert_eq!(backend.sidecar_name(), "tailscale");
        }
        for backend in [
            MeshBackend::Tailcat,
            MeshBackend::Cloudflared,
            MeshBackend::OpenTunnel,
            MeshBackend::Plugin,
        ] {
            assert!(!uses_tailscaled(backend), "{}", backend.as_str());
            assert_ne!(backend.sidecar_name(), "tailscale");
        }
    }

    /// Hostname sanitization. Kept as ONE test because `EnvGuard` mutates a
    /// process-global env var and `cargo test` runs test fns in parallel — three
    /// separate tests raced each other's `ENV_HOSTNAME` and failed at random.
    ///
    /// The regression this guards: a DHCP machine whose hostname is an IP
    /// registered on the tailnet as `192`, because Tailscale keeps only the first
    /// DNS label — so every such machine collided under one name.
    #[test]
    fn mesh_hostname_sanitizes_into_one_dns_label() {
        {
            let _g = EnvGuard::set(ENV_HOSTNAME, "192.168.1.175");
            assert_eq!(mesh_hostname().as_deref(), Some("192-168-1-175"));
        }
        {
            let _g = EnvGuard::set(ENV_HOSTNAME, "  My__Laptop.local  ");
            assert_eq!(mesh_hostname().as_deref(), Some("my-laptop-local"));
        }
        {
            // Tailscale rejects a label longer than 63 chars or ending in `-`.
            let _g = EnvGuard::set(ENV_HOSTNAME, &format!("{}.suffix", "a".repeat(63)));
            let name = mesh_hostname().expect("a name");
            assert!(name.len() <= 63, "label too long: {name}");
            assert!(!name.ends_with('-'), "label ends with a separator: {name}");
        }
    }

    #[test]
    fn the_proxy_listeners_are_off_unless_opted_in() {
        // Unauthenticated, and reachable by inbound tailnet peers (they arrive from
        // 127.0.0.1): nothing in Ryu uses them, so the default is no listener.
        assert_eq!(parse_proxy_opt_in(None, DEFAULT_SOCKS5_ADDR), None);
        assert_eq!(parse_proxy_opt_in(Some(""), DEFAULT_SOCKS5_ADDR), None);
        assert_eq!(parse_proxy_opt_in(Some("   "), DEFAULT_SOCKS5_ADDR), None);
        let args = daemon_spawn_args(
            Path::new("/m/tailscaled.sock"),
            Path::new("/m/tailscaled.state"),
            None,
            None,
        );
        assert!(
            !args
                .iter()
                .any(|a| a.starts_with("--socks5-server") || a.starts_with("--outbound-http-proxy")),
            "got: {args:?}"
        );
    }

    #[test]
    fn the_proxy_listeners_opt_in_to_loopback_addresses_only() {
        assert_eq!(
            parse_proxy_opt_in(Some("1"), DEFAULT_SOCKS5_ADDR).as_deref(),
            Some(DEFAULT_SOCKS5_ADDR)
        );
        assert_eq!(
            parse_proxy_opt_in(Some(" TRUE "), DEFAULT_HTTP_PROXY_ADDR).as_deref(),
            Some(DEFAULT_HTTP_PROXY_ADDR)
        );
        assert_eq!(
            parse_proxy_opt_in(Some("127.0.0.1:2000"), DEFAULT_SOCKS5_ADDR).as_deref(),
            Some("127.0.0.1:2000")
        );
        assert_eq!(
            parse_proxy_opt_in(Some("[::1]:2000"), DEFAULT_SOCKS5_ADDR).as_deref(),
            Some("[::1]:2000")
        );
        // A listener the network can reach would hand the proxy to every host.
        assert_eq!(
            parse_proxy_opt_in(Some("0.0.0.0:1055"), DEFAULT_SOCKS5_ADDR),
            None
        );
        assert_eq!(parse_proxy_opt_in(Some(":1055"), DEFAULT_SOCKS5_ADDR), None);
        assert_eq!(
            parse_proxy_opt_in(Some("192.168.1.5:1055"), DEFAULT_SOCKS5_ADDR),
            None
        );
        assert_eq!(
            parse_proxy_opt_in(Some("nonsense"), DEFAULT_SOCKS5_ADDR),
            None
        );
    }

    #[test]
    fn opted_in_proxies_are_passed_to_tailscaled() {
        let args = daemon_spawn_args(
            Path::new("/m/tailscaled.sock"),
            Path::new("/m/tailscaled.state"),
            Some("127.0.0.1:1055"),
            Some("127.0.0.1:1056"),
        );
        assert_eq!(
            args,
            vec![
                "--tun=userspace-networking",
                "--socks5-server=127.0.0.1:1055",
                "--outbound-http-proxy-listen=127.0.0.1:1056",
                "--socket=/m/tailscaled.sock",
                "--state=/m/tailscaled.state",
            ]
        );
    }

    #[test]
    fn socket_path_under_ryu_mesh() {
        let p = socket_path();
        assert!(p.ends_with("tailscaled.sock"));
        assert!(p.to_string_lossy().contains("mesh"));
    }

    #[test]
    fn state_path_under_ryu_mesh() {
        let p = state_path();
        assert!(p.ends_with("tailscaled.state"));
        assert!(p.to_string_lossy().contains("mesh"));
    }

    #[test]
    fn name_is_tailscale() {
        assert_eq!(TailscaleManager::new().name(), "tailscale");
    }

    #[test]
    fn not_required() {
        assert!(!TailscaleManager::new().is_required());
    }

    // Env vars here are tailscale-specific and disjoint from every other module's, so
    // a module-local lock is enough to serialize the get/restore against parallel runs.
    static MESH_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        MESH_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    struct EnvGuard {
        key: &'static str,
        prev: Option<String>,
    }
    impl EnvGuard {
        fn set(key: &'static str, val: &str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::set_var(key, val);
            Self { key, prev }
        }
        fn clear(key: &'static str) -> Self {
            let prev = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, prev }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn socks5_addr_reads_the_opt_in_env() {
        let _lock = lock_env();
        {
            let _g = EnvGuard::clear(ENV_SOCKS5_ADDR);
            assert_eq!(socks5_addr(), None);
        }
        {
            let _g = EnvGuard::set(ENV_SOCKS5_ADDR, "127.0.0.1:2000");
            assert_eq!(socks5_addr().as_deref(), Some("127.0.0.1:2000"));
        }
        {
            let _g = EnvGuard::set(ENV_SOCKS5_ADDR, "");
            assert_eq!(socks5_addr(), None);
        }
    }

    #[test]
    fn http_proxy_addr_reads_the_opt_in_env() {
        let _lock = lock_env();
        {
            let _g = EnvGuard::clear(ENV_HTTP_PROXY_ADDR);
            assert_eq!(http_proxy_addr(), None);
        }
        let _g = EnvGuard::set(ENV_HTTP_PROXY_ADDR, "127.0.0.1:2001");
        assert_eq!(http_proxy_addr().as_deref(), Some("127.0.0.1:2001"));
    }

    #[test]
    fn env_bin_is_unset_for_blank_values() {
        // A blank value in an env file must read as "unset", not as an empty program
        // name — otherwise `RYU_TAILSCALED_BIN=` would make the mesh unresolvable.
        let _lock = lock_env();
        let _a = EnvGuard::set(ENV_TAILSCALED_BIN, "   ");
        assert_eq!(env_bin(ENV_TAILSCALED_BIN), None);
        let _b = EnvGuard::set(ENV_TAILSCALE_BIN, "/opt/ts/tailscale");
        assert_eq!(
            env_bin(ENV_TAILSCALE_BIN).as_deref(),
            Some("/opt/ts/tailscale")
        );
    }

    // ── Same-origin pair resolution ───────────────────────────────────────────
    //
    // Exercised through the pure `resolve_pair_in` with temp dirs standing in for
    // the two origins: `crate::paths::ryu_dir()` is a cached `OnceLock`, so the
    // managed dir cannot be moved per-test, and a test that depended on the real
    // PATH would assert whatever happens to be installed on the runner.

    /// Create an executable-looking file for each name in `dir`.
    fn fake_bins(dir: &std::path::Path, names: &[&str]) {
        std::fs::create_dir_all(dir).expect("create origin dir");
        for name in names {
            std::fs::write(dir.join(exe_name(name)), b"#!/bin/true\n").expect("write fake bin");
        }
    }

    #[test]
    fn a_complete_path_pair_beats_the_managed_pair() {
        // PATH ADOPTION MUST WIN. Ryu installing its own copy must never shadow the
        // client the user installed themselves.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path_dir = tmp.path().join("usr-bin");
        let managed = tmp.path().join("ryu-bin");
        fake_bins(&path_dir, &[DAEMON_BIN, CLI_BIN]);
        fake_bins(&managed, &[DAEMON_BIN, CLI_BIN]);

        let pair = resolve_pair_in(&[path_dir.clone()], &managed, None, None).expect("a pair");
        assert_eq!(pair.origin, "PATH");
        assert!(pair
            .daemon
            .starts_with(std::fs::canonicalize(&path_dir).unwrap_or_else(|_| path_dir.clone())));
        assert!(pair
            .cli
            .starts_with(std::fs::canonicalize(&path_dir).unwrap_or_else(|_| path_dir.clone())));
    }

    #[test]
    fn a_half_pair_on_path_falls_through_to_the_managed_pair() {
        // The realistic macOS case: `/usr/local/bin/tailscale` is a shim into
        // Tailscale.app with no sibling daemon. Pairing that CLI with Ryu's managed
        // `tailscaled` is exactly the mix this refuses — BOTH must come from the
        // managed origin instead.
        let tmp = tempfile::tempdir().expect("tempdir");
        let path_dir = tmp.path().join("usr-local-bin");
        let managed = tmp.path().join("ryu-bin");
        fake_bins(&path_dir, &[CLI_BIN]); // CLI only — the app-bundle shim.
        fake_bins(&managed, &[DAEMON_BIN, CLI_BIN]);

        let pair = resolve_pair_in(&[path_dir], &managed, None, None).expect("a pair");
        assert_eq!(pair.origin, "managed");
        let managed_canon = std::fs::canonicalize(&managed).unwrap_or(managed);
        assert_eq!(pair.daemon.parent().unwrap(), managed_canon);
        assert_eq!(
            pair.cli.parent().unwrap(),
            managed_canon,
            "the CLI must come from the SAME origin as the daemon"
        );
    }

    #[test]
    fn spanning_path_dirs_is_still_one_origin() {
        // Debian-style packaging splits the pair across `/usr/bin` and `/usr/sbin`.
        // "Origin" is PATH-as-a-whole, not one directory, or every Linux adoption
        // would fall through to a managed install nobody asked for.
        let tmp = tempfile::tempdir().expect("tempdir");
        let bin = tmp.path().join("usr-bin");
        let sbin = tmp.path().join("usr-sbin");
        let managed = tmp.path().join("ryu-bin");
        fake_bins(&bin, &[CLI_BIN]);
        fake_bins(&sbin, &[DAEMON_BIN]);
        fake_bins(&managed, &[DAEMON_BIN, CLI_BIN]);

        let pair = resolve_pair_in(&[bin, sbin], &managed, None, None).expect("a pair");
        assert_eq!(pair.origin, "PATH");
    }

    #[test]
    fn the_env_override_beats_both_origins() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path_dir = tmp.path().join("usr-bin");
        let managed = tmp.path().join("ryu-bin");
        let explicit = tmp.path().join("opt-ts");
        fake_bins(&path_dir, &[DAEMON_BIN, CLI_BIN]);
        fake_bins(&managed, &[DAEMON_BIN, CLI_BIN]);
        fake_bins(&explicit, &[DAEMON_BIN, CLI_BIN]);

        let pair = resolve_pair_in(
            &[path_dir],
            &managed,
            Some(explicit.join(exe_name(DAEMON_BIN)).to_str().unwrap()),
            Some(explicit.join(exe_name(CLI_BIN)).to_str().unwrap()),
        )
        .expect("a pair");
        assert_eq!(pair.origin, "env");
        let explicit_canon = std::fs::canonicalize(&explicit).unwrap_or(explicit);
        assert_eq!(pair.daemon.parent().unwrap(), explicit_canon);
        assert_eq!(pair.cli.parent().unwrap(), explicit_canon);
    }

    #[test]
    fn nothing_anywhere_reports_both_binaries_as_missing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let empty = tmp.path().join("empty");
        let managed = tmp.path().join("ryu-bin");
        std::fs::create_dir_all(&empty).expect("mkdir");
        std::fs::create_dir_all(&managed).expect("mkdir");

        let missing = resolve_pair_in(&[empty], &managed, None, None).expect_err("no pair");
        assert_eq!(
            missing.missing,
            vec![exe_name(DAEMON_BIN), exe_name(CLI_BIN)]
        );
        // The message must stay one actionable sentence — the raw spawn failure
        // ("No such file or directory") is what this replaced.
        let text = missing.to_string();
        assert!(text.contains(&exe_name(DAEMON_BIN)), "got: {text}");
        assert!(
            text.contains("tailscale.com/download")
                || text.contains("Ryu is installing a managed client copy"),
            "got: {text}"
        );
    }

    #[test]
    fn the_managed_bin_dir_is_excluded_from_the_path_scan() {
        // Ryu's own bin dir may legitimately be ON PATH — other downloaders call
        // `PathManager::add_to_path`, and a user may have added it themselves. If it
        // counted as a PATH origin, a managed install would masquerade as an adopted
        // one and the precedence would be decided by PATH ordering instead of by
        // rule. So the managed dir is put on the constructed PATH here on purpose:
        // an exclusion tested against a dir that was never on PATH tests nothing.
        let tmp = tempfile::tempdir().expect("tempdir");
        let managed = tmp.path().join("ryu-bin");
        let other = tmp.path().join("usr-bin");
        fake_bins(&managed, &[DAEMON_BIN, CLI_BIN]);
        fake_bins(&other, &[]); // on PATH, but carries neither binary.
        let raw = std::env::join_paths([&managed, &other]).expect("join PATH");

        let dirs = split_path_origins(&raw, &managed);
        assert!(
            !dirs.iter().any(|d| same_dir(d, &managed)),
            "the managed dir must never appear as a PATH origin: {dirs:?}"
        );
        assert!(dirs.iter().any(|d| same_dir(d, &other)), "{dirs:?}");

        // And the pair still resolves as `managed`, never as an adopted PATH
        // install — which is the claim the exclusion exists to make true.
        let pair = resolve_pair_in(&dirs, &managed, None, None).expect("a pair");
        assert_eq!(pair.origin, "managed");
    }

    #[cfg(unix)]
    #[test]
    fn mesh_dir_is_restricted_to_the_owner() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("mesh");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        restrict_mesh_dir(&dir).expect("owner-only");
        let mode = std::fs::metadata(&dir).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[cfg(unix)]
    #[test]
    fn mesh_dir_that_cannot_be_restricted_fails_closed() {
        // A directory that cannot be chmod'ed (here: one that does not exist, the same
        // EPERM/ENOENT-class failure as a read-only or foreign-owned mount) must stop
        // the mesh rather than leave the node keys world-readable behind a warning.
        let tmp = tempfile::tempdir().expect("tempdir");
        let missing = tmp.path().join("not-there");
        let error = restrict_mesh_dir(&missing).expect_err("must fail closed");
        let text = format!("{error:#}");
        assert!(text.contains("refusing to start the mesh"), "got: {text}");
        assert!(text.contains("owner-only"), "got: {text}");
    }

    #[test]
    fn mesh_state_files_share_the_mesh_dir() {
        // The socket, state, and authkey files all live under the same per-node
        // `~/.ryu/mesh` dir so Ryu's daemon never collides with a system tailscaled.
        let dir = mesh_dir();
        assert!(dir.ends_with("mesh"));
        assert_eq!(socket_path().parent().unwrap(), dir);
        assert_eq!(state_path().parent().unwrap(), dir);
        assert_eq!(legacy_authkey_path().parent().unwrap(), dir);
        assert!(legacy_authkey_path().ends_with("authkey"));
    }

    #[test]
    fn one_shot_authkey_file_is_owner_only_and_removed_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let file = write_ephemeral_authkey(dir.path(), "tskey-auth-one-shot-3e7a").unwrap();
        let path = file.path().to_path_buf();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "tskey-auth-one-shot-3e7a"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        drop(file);
        assert!(
            !path.exists(),
            "the key never outlives the `up` that reads it"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn unset_and_junk_backends_default_to_tailcat() {
        // The DEFAULT is the claim worth pinning: a fresh node needs no account
        // or control server. The desktop parser mirrors this exactly, so a
        // change here without one there makes the picker disagree with the daemon
        // about what an unconfigured node will do.
        assert_eq!(parse_backend(None), MeshBackend::Tailcat);
        assert_eq!(parse_backend(Some("")), MeshBackend::Tailcat);
        assert_eq!(parse_backend(Some("   ")), MeshBackend::Tailcat);
        // A typo must not strand a node off its tailnet — it falls back, it does
        // not error.
        assert_eq!(parse_backend(Some("headscaleee")), MeshBackend::Tailcat);
        // All real values round-trip, case- and whitespace-insensitively.
        assert_eq!(parse_backend(Some(" Headscale ")), MeshBackend::Headscale);
        assert_eq!(parse_backend(Some("TAILSCALE")), MeshBackend::Tailscale);
        assert_eq!(parse_backend(Some("TAILCAT")), MeshBackend::Tailcat);
        assert_eq!(parse_backend(Some("CLOUDFLARED")), MeshBackend::Cloudflared);
        assert_eq!(parse_backend(Some(" OpenTunnel ")), MeshBackend::OpenTunnel);
        assert_eq!(parse_backend(Some("plugin")), MeshBackend::Plugin);
        assert_eq!(
            parse_backend(Some(MeshBackend::Tailscale.as_str())),
            MeshBackend::Tailscale
        );
        assert_eq!(
            parse_backend(Some(MeshBackend::Headscale.as_str())),
            MeshBackend::Headscale
        );
        assert_eq!(DEFAULT_MESH_BACKEND, MeshBackend::Tailcat);
    }

    #[test]
    fn explicit_backend_choices_reject_unknown_values() {
        assert_eq!(
            parse_backend_choice("headscale"),
            Some(MeshBackend::Headscale)
        );
        assert_eq!(
            parse_backend_choice(" TAILSCALE "),
            Some(MeshBackend::Tailscale)
        );
        assert_eq!(parse_backend_choice("tailcat"), Some(MeshBackend::Tailcat));
        assert_eq!(
            parse_backend_choice("opentunnel"),
            Some(MeshBackend::OpenTunnel)
        );
        assert_eq!(parse_backend_choice("PLUGIN"), Some(MeshBackend::Plugin));
        assert_eq!(
            parse_backend_choice(" cloudflared "),
            Some(MeshBackend::Cloudflared)
        );
        assert_eq!(parse_backend_choice("tailscalee"), None);
    }

    #[test]
    fn backend_sidecar_names_keep_tailscale_and_tailcat_separate() {
        assert_eq!(MeshBackend::Headscale.sidecar_name(), "tailscale");
        assert_eq!(MeshBackend::Tailscale.sidecar_name(), "tailscale");
        assert_eq!(MeshBackend::Tailcat.sidecar_name(), "tailcat");
        assert_eq!(MeshBackend::Cloudflared.sidecar_name(), "cloudflared");
        assert_eq!(MeshBackend::OpenTunnel.sidecar_name(), "opentunnel");
        assert_eq!(MeshBackend::Plugin.sidecar_name(), "tunnel-plugin");
    }
}
