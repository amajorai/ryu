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
//! Homebrew on macOS; Windows has no automatic leg — see that module's doc).
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
//! - **Userspace mode exposes a local SOCKS5 + HTTP proxy** (`--socks5-server`,
//!   `--outbound-http-proxy-listen`) on loopback so Core/CLI dial tailnet peers
//!   through it. Inbound peers proxy *to* `127.0.0.1`, which is exactly why
//!   loopback-admin gates must be neutralized under mesh — see
//!   `gateway::gateway_spawn_env` (`RYU_MESH_ENABLED`) and the Core fail-closed
//!   gate in `server::create_router`.
//! - **Authkey never reaches ANY child env.** `main()` calls
//!   [`scrub_authkey_to_keyfile`] once at startup — *before any child process is
//!   spawned* (gateway, headroom, ACP `npx` agents, the `tailscaled` daemon
//!   itself) — which reads `RYU_MESH_AUTHKEY`, writes it to a `0600` keyfile, and
//!   removes it from this process's env (`std::env::remove_var`). So no spawned
//!   child can read the secret from `/proc/self/environ`. `start()` then gates
//!   enrollment on the *keyfile's existence* (not the scrubbed env var) and passes
//!   it to `tailscale up` via `--authkey=file:<p>`. The keyfile is deleted
//!   immediately after a successful one-shot `tailscale up` (enrollment is
//!   one-shot, so there is no reason to retain a long-lived secret on disk).

pub mod downloader;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;

use crate::sidecar::process::ProcessHandle;
use crate::sidecar::tailscale::downloader::{exe_name, CLI_BIN, DAEMON_BIN};
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};
use crate::win_process::NoWindow;

/// Loopback address + port the userspace SOCKS5 proxy listens on. Clients (the
/// CLI `mesh_client`, Core's own dials) point a `socks5h://` proxy at this.
pub const DEFAULT_SOCKS5_ADDR: &str = "127.0.0.1:1055";
/// Loopback address + port the userspace outbound HTTP proxy listens on.
pub const DEFAULT_HTTP_PROXY_ADDR: &str = "127.0.0.1:1056";

/// Env overriding the SOCKS5 listen address (nothing hardcoded).
const ENV_SOCKS5_ADDR: &str = "RYU_MESH_SOCKS5_ADDR";
/// Env overriding the HTTP proxy listen address.
const ENV_HTTP_PROXY_ADDR: &str = "RYU_MESH_HTTP_PROXY_ADDR";
/// Env carrying the (single-use, ephemeral preferred) tailnet auth key.
const ENV_AUTHKEY: &str = "RYU_MESH_AUTHKEY";
/// Env pointing at a Headscale (or alternate) control server via
/// `tailscale up --login-server`. Unset = Tailscale SaaS.
const ENV_LOGIN_SERVER: &str = "RYU_MESH_LOGIN_SERVER";
/// Env overriding the `tailscaled` binary (otherwise resolved on PATH).
/// Overrides the name this node registers on the tailnet with (see
/// [`mesh_hostname`]). Unset = derived from the OS hostname.
const ENV_HOSTNAME: &str = "RYU_MESH_HOSTNAME";
const ENV_TAILSCALED_BIN: &str = "RYU_TAILSCALED_BIN";
/// Env overriding the `tailscale` CLI binary (otherwise resolved on PATH).
const ENV_TAILSCALE_BIN: &str = "RYU_TAILSCALE_BIN";
/// Env overriding the tunnel backend (`headscale` | `tailscale` | `tailcat`), outranking the
/// `mesh-backend` pref exactly as the other mesh envs outrank their prefs.
const ENV_BACKEND: &str = "RYU_MESH_BACKEND";

/// Which private-network backend this node uses. Headscale is self-hosted by
/// default: Ryu's whole point is that the hard, private thing is the normal thing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeshBackend {
    /// Self-hosted Headscale — `tailscale up --login-server=<url>`.
    Headscale,
    /// Tailscale's SaaS coordination server — no `--login-server` at all.
    Tailscale,
    /// Tailcat's short-lived point-to-point server — no control plane or login.
    Tailcat,
}

impl MeshBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Headscale => "headscale",
            Self::Tailscale => "tailscale",
            Self::Tailcat => "tailcat",
        }
    }

    /// The sidecar that owns this backend's process lifecycle.
    pub fn sidecar_name(self) -> &'static str {
        match self {
            Self::Headscale | Self::Tailscale => "tailscale",
            Self::Tailcat => crate::sidecar::tailcat::SIDECAR_NAME,
        }
    }
}

/// The default when nothing has ever been chosen: self-hosted.
pub const DEFAULT_MESH_BACKEND: MeshBackend = MeshBackend::Headscale;

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
    if let Some(raw) = env_bin(ENV_BACKEND) {
        return (parse_backend(Some(&raw)), true);
    }
    let pref = match crate::server::preferences::PreferencesStore::open_default() {
        Ok(store) => store
            .get(crate::mesh_host::MESH_BACKEND_PREF_KEY)
            .await
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty()),
        Err(_) => None,
    };
    (parse_backend(pref.as_deref()), pref.is_some())
}

/// The SOCKS5 listen address for the userspace proxy (env override → default).
pub fn socks5_addr() -> String {
    std::env::var(ENV_SOCKS5_ADDR)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_SOCKS5_ADDR.to_owned())
}

/// The outbound HTTP proxy listen address (env override → default).
pub fn http_proxy_addr() -> String {
    std::env::var(ENV_HTTP_PROXY_ADDR)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_HTTP_PROXY_ADDR.to_owned())
}

/// The `~/.ryu/mesh/` directory holding the custom `tailscaled` socket + state so
/// Ryu's daemon never collides with a system-wide tailscaled.
fn mesh_dir() -> PathBuf {
    crate::paths::ryu_dir().join("mesh")
}

/// The custom `tailscaled` control socket path (under `~/.ryu/mesh`).
pub fn socket_path() -> PathBuf {
    mesh_dir().join("tailscaled.sock")
}

/// The custom `tailscaled` state file path (under `~/.ryu/mesh`).
pub fn state_path() -> PathBuf {
    mesh_dir().join("tailscaled.state")
}

/// The `0600` authkey file path (under `~/.ryu/mesh`). Written from
/// `RYU_MESH_AUTHKEY` once at start, never inherited by children.
fn authkey_path() -> PathBuf {
    mesh_dir().join("authkey")
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
/// `can_install` true means "offer to install it", false means "tell them how to
/// install it themselves". A dead-end toast was the previous behaviour.
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
                "Ryu can install a managed copy for this node — retry with the install \
                 action, or install the official client yourself \
                 (https://tailscale.com/download)."
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
    let managed_dir = crate::paths::ryu_dir().join("bin");
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
/// only the current user (and remove inherited ACEs). Best-effort: a failure logs
/// but does not abort enrollment (the keyfile is also deleted immediately after a
/// successful `tailscale up`, so the at-rest window is minimal regardless).
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

/// Whether a mesh authkey keyfile has been written by [`scrub_authkey_to_keyfile`].
/// `start()` uses this to decide whether to enroll the node, since the env var was
/// scrubbed in `main()` and is no longer readable here.
fn authkey_keyfile_present() -> bool {
    authkey_path().exists()
}

/// Read `RYU_MESH_AUTHKEY` once at startup, write it to a `0600` keyfile, and
/// scrub it from this process's environment so NO spawned child (gateway,
/// headroom, ACP agents, `tailscaled`) can inherit it via `/proc/self/environ`
/// (#478, security HIGH V2). Called from `main()` before any child is spawned.
///
/// No-op (and no env scrub needed) when the var is unset/empty. Best-effort: a
/// write failure logs and leaves the env var in place so enrollment can still be
/// attempted, rather than silently dropping the key.
pub async fn scrub_authkey_to_keyfile() {
    let key = match std::env::var(ENV_AUTHKEY).ok().filter(|s| !s.is_empty()) {
        Some(k) => k,
        None => return,
    };
    let path = authkey_path();
    let write_result = async {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .context("creating ~/.ryu/mesh")?;
        }
        tokio::fs::write(&path, key.as_bytes())
            .await
            .context("writing authkey file")?;
        anyhow::Ok(())
    }
    .await;
    match write_result {
        Ok(()) => {
            restrict_keyfile_perms(&path);
            // Scrub the secret from this process's env so children can't read it.
            std::env::remove_var(ENV_AUTHKEY);
            tracing::info!("tailscale: mesh authkey written to 0600 keyfile and scrubbed from env");
        }
        Err(e) => {
            tracing::warn!(
                "tailscale: failed to persist authkey to keyfile ({e}); leaving env var"
            );
        }
    }
}

/// Run `tailscale status --json` against Ryu's custom socket and return the
/// parsed JSON. Errors when the daemon is absent or returns non-JSON (the caller
/// maps that to an enabled-but-unreachable status).
pub async fn status_json() -> anyhow::Result<serde_json::Value> {
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

/// Ensure a Tailscale Funnel is serving `port`, returning the public URL.
///
/// Runs `tailscale funnel --bg <port>` then reads the served URL back. Requires
/// the daemon Running with HTTPS provisioned; surfaces a clear error otherwise so
/// P6's ingress seam can fall back.
pub async fn ensure_funnel(port: u16) -> anyhow::Result<String> {
    let cli = resolve_mesh_pair()?.cli;
    let status = tokio::process::Command::new(&cli)
        .arg(format!("--socket={}", socket_path().display()))
        .arg("funnel")
        .arg("--bg")
        .arg(port.to_string())
        .no_window()
        .output()
        .await
        .context("running `tailscale funnel`")?;
    if !status.status.success() {
        let stderr = String::from_utf8_lossy(&status.stderr);
        anyhow::bail!("tailscale funnel failed: {}", stderr.trim());
    }
    funnel_url(port)
        .await
        .ok_or_else(|| anyhow::anyhow!("funnel started but no public URL is available"))
}

/// The active public Funnel URL for `port`, derived from this node's MagicDNS
/// name, or `None` when the daemon is not reachable.
pub async fn funnel_url(port: u16) -> Option<String> {
    let raw = status_json().await.ok()?;
    let dns = raw
        .get("Self")
        .and_then(|s| s.get("DNSName"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim_end_matches('.'))
        .filter(|s| !s.is_empty())?;
    // Funnel serves on 443/8443/10000; Core requests the default 443 mapping.
    if port == 443 {
        Some(format!("https://{dns}"))
    } else {
        Some(format!("https://{dns}:{port}"))
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

            if crate::sidecar::tailscale::mesh_backend().await.0 == MeshBackend::Tailcat {
                anyhow::bail!(
                    "Tailcat is the selected network backend; use the Tailcat sidecar instead"
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

            // Ensure the per-node state dir exists.
            tokio::fs::create_dir_all(mesh_dir())
                .await
                .context("creating ~/.ryu/mesh")?;

            // Adopt an already-running Ryu mesh daemon (e.g. left over from a
            // prior run) instead of double-spawning.
            if status_json().await.is_ok() {
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
                    socks = %socks,
                    http_proxy = %http_proxy,
                    "tailscale: spawning tailscaled (userspace networking)"
                );
                // Userspace networking: no TUN, no root. The SOCKS5 + HTTP proxy
                // let Core/CLI dial peers. State + socket live under ~/.ryu/mesh.
                let args = vec![
                    "--tun=userspace-networking".to_owned(),
                    format!("--socks5-server={socks}"),
                    format!("--outbound-http-proxy-listen={http_proxy}"),
                    format!("--socket={}", socket_path().display()),
                    format!("--state={}", state_path().display()),
                ];
                // The authkey is NOT passed in the daemon env (it goes to the
                // one-shot `tailscale up` via a 0600 keyfile), so no secret env here.
                daemon
                    .start_path_with_env(&bin, &args, &[])
                    .await
                    .with_context(|| format!("spawning tailscaled ({bin})"))?;

                // Wait for the daemon's control socket to answer status.
                tokio::time::timeout(std::time::Duration::from_secs(30), async {
                    loop {
                        if status_json().await.is_ok() {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    }
                })
                .await
                .context("tailscaled did not become reachable within 30s")?;
            }

            // One-shot enrollment: `tailscale up` with the authkey file (and the
            // optional Headscale login server). The authkey was read + written to a
            // 0600 keyfile + scrubbed from the env back in `main()`
            // (`scrub_authkey_to_keyfile`), so enrollment is gated on the keyfile's
            // existence, not the (now-absent) env var. Skipped when no authkey is
            // configured (the user may enroll interactively / out-of-band). The
            // keyfile is deleted immediately after a successful `up` so a long-lived
            // secret never lingers on disk.
            if authkey_keyfile_present() {
                let keyfile = authkey_path();
                let mut up_args = vec![
                    format!("--socket={}", socket_path().display()),
                    "up".to_owned(),
                    format!("--authkey=file:{}", keyfile.display()),
                ];
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
                // The one exception is the migration case, and it is deliberate: a
                // node that has NEVER chosen a backend and has no URL is exactly the
                // pre-existing SaaS-with-authkey setup, which
                // [`DEFAULT_MESH_BACKEND`] would otherwise break on upgrade. It
                // keeps working, loudly.
                let (backend, explicit) = mesh_backend().await;
                match (backend, login_server) {
                    (MeshBackend::Headscale, Some(login)) => {
                        up_args.push(format!("--login-server={login}"));
                    }
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
                             tunnel in the node menu to make the choice explicit."
                        );
                    }
                    // SaaS coordinates through Tailscale's own servers; passing a
                    // stale Headscale URL here would send the node to the wrong
                    // control plane, so the URL is ignored on purpose.
                    (MeshBackend::Tailscale, _) => {}
                    (MeshBackend::Tailcat, _) => {
                        anyhow::bail!(
                            "Tailcat is the selected network backend; use the Tailcat sidecar"
                        );
                    }
                }
                // Register under a sanitized whole-hostname label rather than
                // letting Tailscale take the first one (see `mesh_hostname`).
                if let Some(host) = mesh_hostname() {
                    up_args.push(format!("--hostname={host}"));
                }
                let bin = pair.cli.display().to_string();
                tracing::info!(bin = %bin, "tailscale: enrolling node (`tailscale up`)");
                let out = tokio::process::Command::new(&pair.cli)
                    .args(&up_args)
                    .no_window()
                    .output()
                    .await
                    .with_context(|| format!("running `{bin} up`"))?;
                // Enrollment is one-shot; remove the keyfile regardless of outcome
                // so the secret's at-rest window is bounded to a single `up`.
                let _ = tokio::fs::remove_file(&keyfile).await;
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
                let _ = tokio::process::Command::new(&pair.cli)
                    .arg(format!("--socket={}", socket_path().display()))
                    .arg("down")
                    .no_window()
                    .output()
                    .await;
            }
            daemon.stop().await?;
            running.store(false, Ordering::Relaxed);
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let running = Arc::clone(&self.running);
        Box::pin(async move {
            if !running.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("daemon not running".into());
            }
            match status_json().await {
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
    fn socks5_addr_defaults() {
        if std::env::var(ENV_SOCKS5_ADDR).is_err() {
            assert_eq!(socks5_addr(), DEFAULT_SOCKS5_ADDR);
        }
    }

    #[test]
    fn http_proxy_addr_defaults() {
        if std::env::var(ENV_HTTP_PROXY_ADDR).is_err() {
            assert_eq!(http_proxy_addr(), DEFAULT_HTTP_PROXY_ADDR);
        }
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
    fn socks5_addr_env_overrides_default() {
        let _lock = lock_env();
        let _g = EnvGuard::set(ENV_SOCKS5_ADDR, "127.0.0.1:2000");
        assert_eq!(socks5_addr(), "127.0.0.1:2000");
    }

    #[test]
    fn socks5_addr_blank_env_falls_back_to_default() {
        let _lock = lock_env();
        let _g = EnvGuard::set(ENV_SOCKS5_ADDR, "");
        assert_eq!(socks5_addr(), DEFAULT_SOCKS5_ADDR);
    }

    #[test]
    fn http_proxy_addr_env_overrides_default() {
        let _lock = lock_env();
        let _g = EnvGuard::set(ENV_HTTP_PROXY_ADDR, "127.0.0.1:2001");
        assert_eq!(http_proxy_addr(), "127.0.0.1:2001");
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
        assert!(text.contains("tailscale.com/download"), "got: {text}");
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

    #[test]
    fn mesh_state_files_share_the_mesh_dir() {
        // The socket, state, and authkey files all live under the same per-node
        // `~/.ryu/mesh` dir so Ryu's daemon never collides with a system tailscaled.
        let dir = mesh_dir();
        assert!(dir.ends_with("mesh"));
        assert_eq!(socket_path().parent().unwrap(), dir);
        assert_eq!(state_path().parent().unwrap(), dir);
        assert_eq!(authkey_path().parent().unwrap(), dir);
        assert!(authkey_path().ends_with("authkey"));
    }

    #[test]
    fn unset_and_junk_backends_default_to_headscale() {
        // The DEFAULT is the claim worth pinning: self-hosted unless someone says
        // otherwise. The desktop's `parseMeshBackend` mirrors this exactly, so a
        // change here without one there makes the picker disagree with the daemon
        // about what an unconfigured node will do.
        assert_eq!(parse_backend(None), MeshBackend::Headscale);
        assert_eq!(parse_backend(Some("")), MeshBackend::Headscale);
        assert_eq!(parse_backend(Some("   ")), MeshBackend::Headscale);
        // A typo must not strand a node off its tailnet — it falls back, it does
        // not error.
        assert_eq!(parse_backend(Some("headscaleee")), MeshBackend::Headscale);
        // All real values round-trip, case- and whitespace-insensitively.
        assert_eq!(parse_backend(Some(" Headscale ")), MeshBackend::Headscale);
        assert_eq!(parse_backend(Some("TAILSCALE")), MeshBackend::Tailscale);
        assert_eq!(parse_backend(Some("TAILCAT")), MeshBackend::Tailcat);
        assert_eq!(
            parse_backend(Some(MeshBackend::Tailscale.as_str())),
            MeshBackend::Tailscale
        );
        assert_eq!(
            parse_backend(Some(MeshBackend::Headscale.as_str())),
            MeshBackend::Headscale
        );
        assert_eq!(DEFAULT_MESH_BACKEND, MeshBackend::Headscale);
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
        assert_eq!(parse_backend_choice("tailscalee"), None);
    }

    #[test]
    fn backend_sidecar_names_keep_tailscale_and_tailcat_separate() {
        assert_eq!(MeshBackend::Headscale.sidecar_name(), "tailscale");
        assert_eq!(MeshBackend::Tailscale.sidecar_name(), "tailscale");
        assert_eq!(MeshBackend::Tailcat.sidecar_name(), "tailcat");
    }
}
