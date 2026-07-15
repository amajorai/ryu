//! Concrete [`WebhookIngress`] sources and their enum-dispatch wrapper.
//!
//! Dispatch design mirrors [`crate::catalog_source::sources::Source`] and
//! [`crate::mesh`]: the project has no `async-trait` dep, so the
//! [`WebhookIngress`] trait declares native `async fn` methods (not object-safe).
//! Heterogeneous storage is a small closed [`Ingress`] enum, match-dispatched —
//! never `Box<dyn ..>`.
//!
//! Every source points Composio at Core's **existing** public webhook handler
//! (`POST /api/composio/webhook`, [`crate::composio_triggers`]); the tunnel only
//! provides the publicly-reachable base URL. The handler fires agents unchanged.

use std::process::Stdio;
use std::sync::RwLock;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::{IngressKind, WebhookIngress};
use crate::win_process::NoWindow;

/// The path Composio is pointed at. Every tunnel/relay appends this to its public
/// base so an inbound webhook lands on Core's existing handler.
pub const WEBHOOK_PATH: &str = "/api/composio/webhook";

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

/// **TailscaleFunnel** — exposes Core's bind port to the public internet via the
/// P5 mesh's Tailscale Funnel. Consumes [`crate::mesh::ensure_funnel`] /
/// [`crate::mesh::funnel_url`]. When the mesh is not enabled/available it
/// stub-errors with a clear "Phase 5" message so P6 compiles + runs standalone.
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
        // ensure_funnel itself bails clearly when the mesh is disabled; that is
        // the graceful "mesh funnel not available — Phase 5" path until P5's
        // daemon is enrolled on this node.
        let url = crate::mesh::ensure_funnel(self.port)
            .await
            .map_err(|e| anyhow::anyhow!("mesh funnel not available — Phase 5 ({e})"))?;
        let _ = url;
        Ok(())
    }

    async fn public_url(&self) -> Result<String> {
        match crate::mesh::funnel_url(self.port).await {
            Some(base) => Ok(join_webhook(&base)),
            None => bail!("mesh funnel not available — Phase 5 (no active Funnel for this port)"),
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
}

impl CloudflaredSource {
    pub fn new(port: u16) -> Self {
        Self { port }
    }
}

/// Process-global state for the single managed cloudflared quick tunnel: the
/// resolved public base URL plus the held child. The child is kept here (and never
/// dropped) so the tunnel stays up; `kill_on_drop` ensures it dies with Core.
struct CloudflaredState {
    base_url: String,
    #[allow(dead_code)]
    child: tokio::process::Child,
}

static CLOUDFLARED: RwLock<Option<CloudflaredState>> = RwLock::new(None);

/// The current cloudflared base URL, if a tunnel is active.
fn cloudflared_base_url() -> Option<String> {
    CLOUDFLARED
        .read()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.base_url.clone()))
}

/// Extract a `https://<sub>.trycloudflare.com` URL from a single output line, if
/// present. cloudflared prints the assigned quick-tunnel URL on its own banner
/// line (to stderr); this finds it regardless of surrounding box-drawing chars.
fn extract_trycloudflare_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches('/');
    if url.ends_with(".trycloudflare.com") {
        Some(url.to_owned())
    } else {
        None
    }
}

impl WebhookIngress for CloudflaredSource {
    fn kind(&self) -> IngressKind {
        IngressKind::Cloudflared
    }

    async fn start(&self) -> Result<()> {
        // Idempotent: a tunnel is already up.
        if cloudflared_base_url().is_some() {
            return Ok(());
        }

        let mut child = Command::new("cloudflared")
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
                    "cloudflared ingress: failed to spawn `cloudflared` ({e}) — install \
                     cloudflared and ensure it is on PATH, or use own-relay / tailscale-funnel"
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
                anyhow!("cloudflared ingress: timed out waiting for the tunnel URL (is cloudflared healthy?)")
            })?
            .map_err(|_| {
                anyhow!("cloudflared ingress: process exited before reporting a tunnel URL")
            })?;

        if let Ok(mut guard) = CLOUDFLARED.write() {
            *guard = Some(CloudflaredState {
                base_url: url,
                child,
            });
        }
        Ok(())
    }

    async fn public_url(&self) -> Result<String> {
        match cloudflared_base_url() {
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
        // Lines without a URL yield nothing.
        assert_eq!(extract_trycloudflare_url("starting tunnel"), None);
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
        if cloudflared_base_url().is_none() {
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
        }
    }

    #[tokio::test]
    async fn tailscale_funnel_stub_errors_when_mesh_off() {
        // In the test process RYU_MESH_ENABLED is unset → mesh off → both paths
        // surface the clear Phase-5 stub error rather than panicking.
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
