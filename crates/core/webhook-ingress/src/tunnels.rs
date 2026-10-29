//! Concrete [`WebhookIngress`] sources and their enum-dispatch wrapper.
//!
//! The project has no `async-trait` dep on this hot path, so the
//! [`WebhookIngress`] trait declares native `async fn` methods (not object-safe).
//! Heterogeneous storage is a small closed [`Ingress`] enum, match-dispatched —
//! never `Box<dyn ..>`. (The kernel-coupling host seam is the one `async-trait`
//! boundary — see [`super::WebhookIngressHost`].)
//!
//! Every source points Composio at Core's **existing** public webhook handler
//! (`POST /api/composio/webhook`); the tunnel only provides the publicly-reachable
//! base URL. Core's handler (reached via the host) fires agents unchanged.

use std::collections::HashSet;
use std::future::Future;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::host::host;
use super::{IngressKind, WebhookIngress};
use crate::win_process::NoWindow;

/// The path Composio is pointed at. Every tunnel/relay appends this to its public
/// base so an inbound webhook lands on Core's existing handler.
pub const WEBHOOK_PATH: &str = "/api/composio/webhook";

/// The only path prefixes a Tailscale Funnel publishes to the internet.
///
/// Funnel mounts are prefixes with no wildcard, so the per-workflow webhook route
/// (`/api/workflows/<id>/webhook`) can only be reached through its `/api/workflows/`
/// prefix. Every other Core route (chat, vault, settings, sidecar proxies) stays off the
/// public edge; the routes under the workflow prefix other than the webhook still demand
/// the node bearer, which loopback no longer substitutes for while the mesh daemon runs.
pub const FUNNEL_PUBLIC_MOUNTS: [&str; 2] =
    [WEBHOOK_PATH, super::dispatch::WORKFLOW_WEBHOOK_PREFIX];

/// Whether a Funnel serving [`FUNNEL_PUBLIC_MOUNTS`] would forward `path`, with the same
/// prefix semantics Tailscale applies to a mount point: a mount ending in `/` covers
/// everything beneath it, any other mount covers itself and its `/`-separated children.
pub fn funnel_mount_covers(path: &str) -> bool {
    FUNNEL_PUBLIC_MOUNTS.iter().any(|mount| {
        if mount.ends_with('/') {
            path.starts_with(mount)
        } else {
            path == *mount
                || path
                    .strip_prefix(mount)
                    .is_some_and(|rest| rest.starts_with('/'))
        }
    })
}

/// Join a public base URL with [`WEBHOOK_PATH`], collapsing a trailing slash so
/// `https://x.com/` and `https://x.com` both yield `https://x.com/api/composio/webhook`.
fn join_webhook(base: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), WEBHOOK_PATH)
}

/// **OwnRelay** — the BYO ingress: the user already exposes Core (or a reverse
/// proxy) at a public URL and configures it here. The base comes from the env
/// `RYU_WEBHOOK_INGRESS_URL` (preferred) or the value handed at construction
/// (e.g. a pref). `public_url()` appends the webhook path.
#[derive(Clone, Debug)]
pub struct OwnRelaySource {
    /// The public base URL Core is reachable at (no path). May be empty when
    /// nothing is configured, in which case `public_url()` errors.
    pub base_url: String,
}

/// The env var a BYO operator sets to declare Core's public base URL.
pub const OWN_RELAY_URL_ENV: &str = "RYU_WEBHOOK_INGRESS_URL";

impl OwnRelaySource {
    /// Build from the env override first, falling back to the supplied base
    /// (typically the pref or the resolved local `server_url`).
    pub fn new(fallback_base: impl Into<String>) -> Self {
        let env_base = std::env::var(OWN_RELAY_URL_ENV)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty());
        Self {
            base_url: env_base.unwrap_or_else(|| fallback_base.into()),
        }
    }
}

impl WebhookIngress for OwnRelaySource {
    fn kind(&self) -> IngressKind {
        IngressKind::OwnRelay
    }

    async fn start(&self) -> Result<()> {
        if self.base_url.trim().is_empty() {
            bail!(
                "own-relay ingress: no public URL set (env {OWN_RELAY_URL_ENV} \
                 or the webhook.ingress.url pref)"
            );
        }
        Ok(())
    }

    async fn public_url(&self) -> Result<String> {
        let base = self.base_url.trim();
        if base.is_empty() {
            bail!(
                "own-relay ingress: no public URL set (env {OWN_RELAY_URL_ENV} \
                 or the webhook.ingress.url pref)"
            );
        }
        Ok(join_webhook(base))
    }
}

/// **TailscaleFunnel** — publishes Core's webhook paths ([`FUNNEL_PUBLIC_MOUNTS`], not
/// the whole bind port) to the public internet via the P5 mesh's Tailscale Funnel.
/// Consumes the host's `ensure_funnel` / `funnel_url`
/// (Core forwards to `crate::mesh`). When the mesh is not enabled/available — or
/// no host is installed — it errors with a message telling the operator to
/// enable the mesh, so this still runs standalone.
#[derive(Clone, Debug)]
pub struct TailscaleFunnelSource {
    /// Core's local bind port, the target the Funnel serves.
    pub port: u16,
}

impl TailscaleFunnelSource {
    pub fn new(port: u16) -> Self {
        Self { port }
    }
}

impl WebhookIngress for TailscaleFunnelSource {
    fn kind(&self) -> IngressKind {
        IngressKind::TailscaleFunnel
    }

    async fn start(&self) -> Result<()> {
        // ensure_funnel itself bails clearly when the mesh is disabled (or no host
        // is installed); that is the graceful path until the mesh daemon is
        // enrolled on this node.
        let url = host()?.ensure_funnel(self.port).await.map_err(|e| {
            anyhow::anyhow!("Tailscale Funnel is not available: enable the mesh on this node ({e})")
        })?;
        let _ = url;
        Ok(())
    }

    async fn public_url(&self) -> Result<String> {
        match host()?.funnel_url(self.port).await {
            Some(base) => Ok(join_webhook(&base)),
            None => bail!(
                "Tailscale Funnel is not available: no active Funnel for port {}",
                self.port
            ),
        }
    }
}

/// **Cloudflared** — adopt-or-spawn a `cloudflared` quick tunnel pointed at
/// Core's local port. `start()` spawns `cloudflared tunnel --url
/// http://localhost:<port>`, parses the assigned `https://<sub>.trycloudflare.com`
/// base from its output, and holds the child alive for the process lifetime
/// (dropping the child tears the tunnel down). `public_url()` returns that base
/// joined with [`WEBHOOK_PATH`]. No account/login is needed — quick tunnels are
/// anonymous and ephemeral, which is exactly the BYO-public-URL contract this seam
/// needs. Requires the `cloudflared` binary on PATH; spawn failure errors clearly.
#[derive(Clone, Debug)]
pub struct CloudflaredSource {
    /// Core's local bind port, the target the tunnel forwards to.
    pub port: u16,
    binary: Option<PathBuf>,
    /// Core injects its centralized secret scrubber. Standalone consumers fall
    /// back to a conservative platform-environment allowlist below.
    env_scrubber: Option<fn(Vec<(String, String)>) -> Vec<(String, String)>>,
}

impl CloudflaredSource {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            binary: None,
            env_scrubber: None,
        }
    }

    /// Use Core's managed Cloudflared binary when one is available.
    pub fn with_binary(mut self, binary: impl Into<PathBuf>) -> Self {
        self.binary = Some(binary.into());
        self
    }

    /// Inject the host's canonical environment scrubber without coupling this
    /// extracted crate to apps/core.
    pub fn with_env_scrubber(
        mut self,
        scrubber: fn(Vec<(String, String)>) -> Vec<(String, String)>,
    ) -> Self {
        self.env_scrubber = Some(scrubber);
        self
    }

    /// Start or share the process for a particular Core-owned consumer.
    pub async fn start_for(&self, owner: CloudflaredOwner) -> Result<()> {
        let _lifecycle = CLOUDFLARED_LIFECYCLE.lock().await;
        let mut owners = {
            let mut guard = CLOUDFLARED
                .write()
                .map_err(|_| anyhow!("cloudflared state lock is poisoned"))?;
            if let Some(state) = guard.as_mut() {
                let has_url = state.base_url.is_some();
                let child_is_active = match state.child.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(None) | Err(_) => has_url,
                        Ok(Some(_)) => false,
                    },
                    None => false,
                };
                if child_is_active {
                    if state.owners.insert(owner) {
                        tracing::info!(?owner, "cloudflared: sharing the active Quick Tunnel");
                    }
                    return Ok(());
                }
            }
            guard.take().map(|state| state.owners).unwrap_or_default()
        };
        owners.insert(owner);
        {
            let mut guard = CLOUDFLARED
                .write()
                .map_err(|_| anyhow!("cloudflared state lock is poisoned"))?;
            *guard = Some(CloudflaredState {
                base_url: None,
                child: None,
                owners: owners.clone(),
            });
        }
        // Fail closed: mark the process as forwarding before it exists. Every
        // early return below drops (and so kills) the child, and the guard
        // clears the flag on the way out.
        let forwarding = ForwardingGuard::arm();

        let binary = self
            .binary
            .clone()
            .unwrap_or_else(|| PathBuf::from("cloudflared"));
        let inherited_env = std::env::vars().collect();
        let scrubbed_env =
            self.env_scrubber.unwrap_or(default_cloudflared_child_env)(inherited_env);
        let mut child = Command::new(&binary)
            .env_clear()
            .envs(scrubbed_env)
            .arg("tunnel")
            .arg("--no-autoupdate")
            .arg("--url")
            .arg(format!("http://localhost:{}", self.port))
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .no_window()
            .spawn()
            .map_err(|e| {
                anyhow!(
                    "cloudflared ingress: failed to spawn {} ({e}) — install Cloudflared or use another tunnel backend",
                    binary.display()
                )
            })?;

        // Drain stdout so its pipe never fills (cloudflared logs there too).
        if let Some(out) = child.stdout.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(out).lines();
                while let Ok(Some(_)) = lines.next_line().await {}
            });
        }

        // cloudflared prints the assigned URL to stderr. Read until we find it,
        // hand it back via a oneshot, then keep draining so the pipe never blocks.
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow!("cloudflared ingress: no stderr handle on child"))?;
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut tx = Some(tx);
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(url) = extract_trycloudflare_url(&line) {
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(url);
                    }
                }
            }
        });

        let url = tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .map_err(|_| {
                anyhow!("cloudflared ingress: timed out waiting for the tunnel URL; check network access and whether a default config.yaml is preventing a Quick Tunnel")
            })?
            .map_err(|_| {
                anyhow!("cloudflared ingress: process exited before reporting a tunnel URL; Quick Tunnels do not support a default config.yaml")
            })?;

        let mut guard = CLOUDFLARED
            .write()
            .map_err(|_| anyhow!("cloudflared state lock is poisoned"))?;
        let state = guard
            .as_mut()
            .ok_or_else(|| anyhow!("cloudflared lifecycle state disappeared"))?;
        state.base_url = Some(url);
        state.child = Some(child);
        state.owners = owners;
        forwarding.keep();
        tracing::info!(
            ?owner,
            port = self.port,
            "cloudflared: Quick Tunnel started"
        );
        Ok(())
    }

    /// Release one consumer. The shared process stops when no consumer still
    /// needs the public URL.
    pub async fn stop_for(owner: CloudflaredOwner) -> Result<()> {
        Self::stop_for_and_if_last(owner, || async { Ok(()) })
            .await
            .map(|_| ())
    }

    /// Release one consumer and run final cleanup while start/stop operations
    /// are still serialized, but only when no other consumer retains a lease.
    pub async fn stop_for_and_if_last<F, Fut>(owner: CloudflaredOwner, cleanup: F) -> Result<bool>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        let _lifecycle = CLOUDFLARED_LIFECYCLE.lock().await;
        let final_owner = {
            let mut guard = CLOUDFLARED
                .write()
                .map_err(|_| anyhow!("cloudflared state lock is poisoned"))?;
            let final_owner = match guard.as_mut() {
                Some(state) => release_cloudflared_owner(&mut state.owners, owner),
                None => true,
            };
            if final_owner {
                // Dropping the state drops the `kill_on_drop` child.
                guard.take();
                CLOUDFLARED_FORWARDING.store(false, Ordering::Release);
            }
            final_owner
        };
        if final_owner {
            cleanup().await?;
            tracing::info!(
                ?owner,
                "cloudflared: Quick Tunnel stopped after its final owner released it"
            );
        }
        Ok(final_owner)
    }

    /// Whether a Quick Tunnel process may currently be forwarding public
    /// traffic to Core, whichever consumer started it.
    ///
    /// Cloudflared re-originates every tunneled request from loopback, so the
    /// host must not treat a loopback peer as local while this is true. Cheap
    /// enough for a per-request auth check (one atomic load, no lock). It turns
    /// true before the process is spawned and false once Core has dropped the
    /// child; a child that crashes on its own is noticed by the next URL read
    /// (`active_base_url` / `owned_base_url`), so until then the flag stays
    /// conservatively true.
    pub fn forwarding_active() -> bool {
        CLOUDFLARED_FORWARDING.load(Ordering::Acquire)
    }

    /// The active public base URL, if a Quick Tunnel is running.
    pub fn active_base_url() -> Option<String> {
        cloudflared_url_for(None)
    }

    /// The active URL only when a specific Core consumer still owns it.
    pub fn owned_base_url(owner: CloudflaredOwner) -> Option<String> {
        cloudflared_url_for(Some(owner))
    }
}

fn cloudflared_url_for(owner: Option<CloudflaredOwner>) -> Option<String> {
    let mut guard = match CLOUDFLARED.write() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(state) = guard.as_mut() {
        let exited = state
            .child
            .as_mut()
            .map(|child| matches!(child.try_wait(), Ok(Some(_))))
            .unwrap_or(false);
        if exited {
            state.child = None;
            state.base_url = None;
            CLOUDFLARED_FORWARDING.store(false, Ordering::Release);
        }
    }
    guard.as_ref().and_then(|state| {
        let active = state.child.is_some() && state.base_url.is_some();
        let owned = owner.is_none_or(|owner| state.owners.contains(&owner));
        (active && owned).then(|| state.base_url.clone()).flatten()
    })
}

/// Core-owned consumers of the one shared Quick Tunnel process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CloudflaredOwner {
    WebhookIngress,
    TunnelToolkit,
}

/// A Cloudflared Quick Tunnel needs only a small set of platform variables.
/// Core replaces this fallback with its shared secret scrubber in production.
fn default_cloudflared_child_env(inherited: Vec<(String, String)>) -> Vec<(String, String)> {
    const ALLOWED: &[&str] = &[
        "PATH",
        "HOME",
        "USERPROFILE",
        "SYSTEMROOT",
        "WINDIR",
        "SYSTEMDRIVE",
        "COMSPEC",
        "PATHEXT",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LANGUAGE",
        "TERM",
        "SHELL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ];
    inherited
        .into_iter()
        .filter(|(key, _)| {
            ALLOWED
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(key))
        })
        .collect()
}

/// Process-global state for the one shared Quick Tunnel. Owners are retained
/// across startup failures so a later owner can retry with an installed binary.
struct CloudflaredState {
    base_url: Option<String>,
    child: Option<tokio::process::Child>,
    owners: HashSet<CloudflaredOwner>,
}

static CLOUDFLARED: RwLock<Option<CloudflaredState>> = RwLock::new(None);
/// See [`CloudflaredSource::forwarding_active`].
static CLOUDFLARED_FORWARDING: AtomicBool = AtomicBool::new(false);

/// Clears [`CLOUDFLARED_FORWARDING`] unless the start succeeded and kept it.
struct ForwardingGuard {
    armed: bool,
}

impl ForwardingGuard {
    fn arm() -> Self {
        CLOUDFLARED_FORWARDING.store(true, Ordering::Release);
        Self { armed: true }
    }

    /// The child now lives in the shared state; leave the flag set.
    fn keep(mut self) {
        self.armed = false;
    }
}

impl Drop for ForwardingGuard {
    fn drop(&mut self) {
        if self.armed {
            CLOUDFLARED_FORWARDING.store(false, Ordering::Release);
        }
    }
}
static CLOUDFLARED_LIFECYCLE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn release_cloudflared_owner(
    owners: &mut HashSet<CloudflaredOwner>,
    owner: CloudflaredOwner,
) -> bool {
    owners.remove(&owner);
    owners.is_empty()
}

/// Extract a `https://<sub>.trycloudflare.com` URL from a single output line, if
/// present. cloudflared prints the assigned quick-tunnel URL on its own banner
/// line (to stderr); this finds it regardless of surrounding box-drawing chars.
fn extract_trycloudflare_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || matches!(c, '|' | '"' | ')' | ']'))
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches('/');
    let host = url.strip_prefix("https://")?;
    if host
        .chars()
        .any(|character| matches!(character, '/' | '?' | '#' | '@' | ':'))
    {
        return None;
    }
    let lower_host = host.to_ascii_lowercase();
    let subdomain = lower_host.strip_suffix(".trycloudflare.com")?;
    if subdomain.is_empty()
        || subdomain.len() > 63
        || subdomain.contains('.')
        || subdomain.starts_with('-')
        || subdomain.ends_with('-')
        || !subdomain
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return None;
    }
    Some(format!("https://{host}"))
}

impl WebhookIngress for CloudflaredSource {
    fn kind(&self) -> IngressKind {
        IngressKind::Cloudflared
    }

    async fn start(&self) -> Result<()> {
        self.start_for(CloudflaredOwner::WebhookIngress).await
    }

    async fn public_url(&self) -> Result<String> {
        match Self::active_base_url() {
            Some(base) => Ok(join_webhook(&base)),
            None => bail!("cloudflared ingress: no active tunnel (call start first)"),
        }
    }
}

/// **RyuRelay** — the managed push relay (the default). Core opens an outbound
/// SSE subscription to `apps/server`; Composio POSTs to a public ingress URL and
/// the server fans the payload out over that stream, which Core dispatches
/// in-process. The register + SSE-client loop live in [`super::ryu_relay`]; this
/// source delegates to them.
#[derive(Clone, Debug, Default)]
pub struct RyuRelaySource;

impl RyuRelaySource {
    pub fn new() -> Self {
        Self
    }
}

impl WebhookIngress for RyuRelaySource {
    fn kind(&self) -> IngressKind {
        IngressKind::RyuRelay
    }

    async fn start(&self) -> Result<()> {
        // Registers with the relay server (publishing the public URL via the
        // process-global) and spawns the background SSE-client loop. Errors when
        // not logged in so `main.rs` logs a clear "not active".
        super::ryu_relay::start().await
    }

    async fn public_url(&self) -> Result<String> {
        // The loop publishes the ingress URL to the process-global once register
        // succeeds; until then there is no URL to report.
        super::public_url().ok_or_else(|| {
            anyhow::anyhow!("ryu-relay ingress: not registered yet (login required)")
        })
    }
}

/// The closed set of ingress backends, match-dispatched (no `async-trait`/`dyn`).
#[derive(Clone, Debug)]
pub enum Ingress {
    RyuRelay(RyuRelaySource),
    TailscaleFunnel(TailscaleFunnelSource),
    Cloudflared(CloudflaredSource),
    OwnRelay(OwnRelaySource),
}

impl Ingress {
    /// The backend kind this ingress represents.
    pub fn kind(&self) -> IngressKind {
        match self {
            Ingress::RyuRelay(s) => s.kind(),
            Ingress::TailscaleFunnel(s) => s.kind(),
            Ingress::Cloudflared(s) => s.kind(),
            Ingress::OwnRelay(s) => s.kind(),
        }
    }

    /// Start (or adopt) the backend so it is ready to receive webhooks.
    pub async fn start(&self) -> Result<()> {
        match self {
            Ingress::RyuRelay(s) => s.start().await,
            Ingress::TailscaleFunnel(s) => s.start().await,
            Ingress::Cloudflared(s) => s.start().await,
            Ingress::OwnRelay(s) => s.start().await,
        }
    }

    /// The public URL Composio should be pointed at (ends in [`WEBHOOK_PATH`]).
    pub async fn public_url(&self) -> Result<String> {
        match self {
            Ingress::RyuRelay(s) => s.public_url().await,
            Ingress::TailscaleFunnel(s) => s.public_url().await,
            Ingress::Cloudflared(s) => s.public_url().await,
            Ingress::OwnRelay(s) => s.public_url().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_cloudflared_child_environment_keeps_only_platform_variables() {
        let base = vec![
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            ("HOME".to_owned(), "/home/test".to_owned()),
            ("OPENAI_API_KEY".to_owned(), "secret".to_owned()),
            ("RYU_GATEWAY_TOKEN".to_owned(), "secret".to_owned()),
            ("HF_TOKEN".to_owned(), "secret".to_owned()),
            ("DATABASE_URL".to_owned(), "secret".to_owned()),
        ];

        let child_env = default_cloudflared_child_env(base);

        assert!(child_env.iter().any(|(key, _)| key == "PATH"));
        assert!(child_env.iter().any(|(key, _)| key == "HOME"));
        for secret_key in [
            "OPENAI_API_KEY",
            "RYU_GATEWAY_TOKEN",
            "HF_TOKEN",
            "DATABASE_URL",
        ] {
            assert!(
                child_env.iter().all(|(key, _)| key != secret_key),
                "{secret_key} should be scrubbed"
            );
        }
    }

    #[test]
    fn join_webhook_strips_trailing_slash() {
        assert_eq!(
            join_webhook("https://x.com"),
            "https://x.com/api/composio/webhook"
        );
        assert_eq!(
            join_webhook("https://x.com/"),
            "https://x.com/api/composio/webhook"
        );
    }

    #[tokio::test]
    async fn own_relay_public_url_appends_path() {
        let src = OwnRelaySource {
            base_url: "https://relay.example.com/".to_owned(),
        };
        assert_eq!(
            src.public_url().await.unwrap(),
            "https://relay.example.com/api/composio/webhook"
        );
        assert_eq!(src.kind(), IngressKind::OwnRelay);
    }

    #[tokio::test]
    async fn own_relay_empty_base_errors() {
        let src = OwnRelaySource {
            base_url: "   ".to_owned(),
        };
        assert!(src.public_url().await.is_err());
        assert!(src.start().await.is_err());
    }

    #[tokio::test]
    async fn ryu_relay_kind_is_ryu_relay() {
        // Network-free: do NOT call start() (it would register + spawn the SSE
        // loop against the live relay server when a ~/.ryu/auth.json token exists,
        // which is the case on a developer machine). public_url() reads the
        // process-global PUBLIC_URL, which other tests mutate in parallel, so it
        // is not asserted here. The frame-parser + register logic is unit-tested
        // in super::ryu_relay.
        let src = RyuRelaySource::new();
        assert_eq!(src.kind(), IngressKind::RyuRelay);
    }

    #[test]
    fn extract_trycloudflare_url_parses_banner() {
        // The real banner wraps the URL in box-drawing chars; parsing must ignore them.
        assert_eq!(
            extract_trycloudflare_url(
                "2024-01-01 INF |  https://random-words-1234.trycloudflare.com  |"
            ),
            Some("https://random-words-1234.trycloudflare.com".to_owned())
        );
        // Trailing slash is collapsed.
        assert_eq!(
            extract_trycloudflare_url("https://abc.trycloudflare.com/"),
            Some("https://abc.trycloudflare.com".to_owned())
        );
        // A non-trycloudflare https URL (e.g. the docs link cloudflared prints) is ignored.
        assert_eq!(
            extract_trycloudflare_url("Visit https://developers.cloudflare.com for docs"),
            None
        );
        assert_eq!(
            extract_trycloudflare_url("https://example.com/path.trycloudflare.com"),
            None
        );
        assert_eq!(
            extract_trycloudflare_url("https://user@abc.trycloudflare.com"),
            None
        );
        // Lines without a URL yield nothing.
        assert_eq!(extract_trycloudflare_url("starting tunnel"), None);
    }

    #[test]
    fn cloudflared_tunnel_stays_up_until_every_owner_releases_it() {
        let mut owners = HashSet::from([
            CloudflaredOwner::WebhookIngress,
            CloudflaredOwner::TunnelToolkit,
        ]);
        assert!(!release_cloudflared_owner(
            &mut owners,
            CloudflaredOwner::TunnelToolkit
        ));
        assert_eq!(owners, HashSet::from([CloudflaredOwner::WebhookIngress]));
        assert!(release_cloudflared_owner(
            &mut owners,
            CloudflaredOwner::WebhookIngress
        ));
    }

    #[tokio::test]
    async fn cloudflared_public_url_errors_without_tunnel() {
        // public_url() is deterministic + network-free: with no active tunnel it
        // errors. start() is NOT called here — on a dev machine that has
        // cloudflared on PATH it would spawn a real anonymous tunnel, which a unit
        // test must never do. The spawn-failure path is covered below only when the
        // binary is absent.
        let src = CloudflaredSource::new(7980);
        assert_eq!(src.kind(), IngressKind::Cloudflared);
        if CloudflaredSource::active_base_url().is_none() {
            assert!(src.public_url().await.is_err());
        }
    }

    #[tokio::test]
    async fn cloudflared_start_errors_when_binary_absent() {
        // Only exercise start() when `cloudflared` is NOT installed, so the test
        // asserts the graceful spawn-failure error without ever opening a live
        // tunnel on a machine that happens to have the binary.
        let has_binary = std::process::Command::new("cloudflared")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .no_window()
            .status()
            .is_ok();
        if !has_binary {
            let src = CloudflaredSource::new(7980);
            assert!(src.start().await.is_err());
            CloudflaredSource::stop_for(CloudflaredOwner::WebhookIngress)
                .await
                .unwrap();
        }
    }

    #[test]
    fn funnel_publishes_the_webhook_routes_and_nothing_else() {
        // Both public webhook routes are reachable through a mount...
        assert!(funnel_mount_covers(WEBHOOK_PATH));
        assert!(funnel_mount_covers(
            &crate::dispatch::workflow_webhook_path("wf_123")
        ));
        // ...and the rest of Core is not.
        for private in [
            "/",
            "/api/health",
            "/api/chat",
            "/api/vault/tokens",
            "/api/webhooks",
            "/api/webhooks/abc/secret",
            "/api/composio/webhooks",
            "/api/composio",
            "/api/workflow",
            "/api/mesh/status",
        ] {
            assert!(
                !funnel_mount_covers(private),
                "{private} must not be public"
            );
        }
    }

    #[test]
    fn funnel_mounts_are_clean_absolute_paths() {
        for mount in FUNNEL_PUBLIC_MOUNTS {
            assert!(mount.starts_with("/api/"), "{mount}");
            assert!(!mount.contains("//") && !mount.contains(".."), "{mount}");
            assert!(!mount.contains(' '), "{mount}");
        }
        assert!(FUNNEL_PUBLIC_MOUNTS.contains(&WEBHOOK_PATH));
    }

    #[tokio::test]
    async fn tailscale_funnel_stub_errors_when_mesh_off() {
        // In the test process RYU_MESH_ENABLED is unset → mesh off → both paths
        // surface the clear mesh-disabled error rather than panicking.
        if std::env::var("RYU_MESH_ENABLED").is_err() {
            let src = TailscaleFunnelSource::new(7980);
            assert_eq!(src.kind(), IngressKind::TailscaleFunnel);
            assert!(src.start().await.is_err());
            assert!(src.public_url().await.is_err());
        }
    }

    #[tokio::test]
    async fn enum_dispatch_routes_to_variant() {
        let ing = Ingress::OwnRelay(OwnRelaySource {
            base_url: "https://x.com".to_owned(),
        });
        assert_eq!(ing.kind(), IngressKind::OwnRelay);
        assert_eq!(
            ing.public_url().await.unwrap(),
            "https://x.com/api/composio/webhook"
        );
        assert!(ing.start().await.is_ok());

        let relay = Ingress::RyuRelay(RyuRelaySource::new());
        assert_eq!(relay.kind(), IngressKind::RyuRelay);
    }
}
