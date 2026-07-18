//! Tailscale / Headscale mesh daemon lifecycle (P5 of #478).
//!
//! Wraps the **official** `tailscaled` + `tailscale` binaries (no FFI, no
//! reimplementation) in **userspace networking** mode so a Ryu node can reach a
//! remote node over the tailnet without a kernel TUN device or root. This is the
//! "what runs" half of the mesh (Core); the read side + Funnel helpers live in
//! the extracted [`ryu_mesh`] crate (Core bridges to these shell-outs via the
//! `MeshHost` shim in [`crate::mesh_host`]).
//!
//! Opt-in only: `TailscaleManager` is registered in `all_sidecars` but **never**
//! in `startup_order`. It starts when (and only when) `RYU_MESH_ENABLED` is set
//! and the user installs/starts it. There is **no auto-download yet** — the
//! sidecar PATH-adopts an official client install on every platform; the
//! `required_platforms("tailscale") => ["linux"]` label reserves the future
//! Linux-only downloader and gates the generic install route there.
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

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;

use crate::sidecar::process::ProcessHandle;
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
const ENV_TAILSCALED_BIN: &str = "RYU_TAILSCALED_BIN";
/// Env overriding the `tailscale` CLI binary (otherwise resolved on PATH).
const ENV_TAILSCALE_BIN: &str = "RYU_TAILSCALE_BIN";

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

fn tailscaled_bin() -> String {
    std::env::var(ENV_TAILSCALED_BIN)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "tailscaled".to_owned())
}

fn tailscale_bin() -> String {
    std::env::var(ENV_TAILSCALE_BIN)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "tailscale".to_owned())
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
    let output = tokio::process::Command::new(tailscale_bin())
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
    let status = tokio::process::Command::new(tailscale_bin())
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
                    "mesh disabled: set RYU_MESH_ENABLED=1 to start the Tailscale daemon"
                );
            }

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
                let bin = tailscaled_bin();
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
                if let Some(login) = login_server {
                    up_args.push(format!("--login-server={login}"));
                }
                let bin = tailscale_bin();
                tracing::info!(bin = %bin, "tailscale: enrolling node (`tailscale up`)");
                let out = tokio::process::Command::new(&bin)
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
            let _ = tokio::process::Command::new(tailscale_bin())
                .arg(format!("--socket={}", socket_path().display()))
                .arg("down")
                .no_window()
                .output()
                .await;
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
}
