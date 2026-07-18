//! `ryu-mail` — the standalone, out-of-process mail sidecar.
//!
//! The tracer bullet for "apps as microservices": the self-host Agent Inboxes
//! feature (receive + store + send agent email) runs here as a SEPARATE PROCESS
//! that Core spawns, health-checks, and proxies to — exactly like Core already
//! runs the Gateway sidecar. Core does NOT contain this code, so mail scales and
//! fails independently of the rest of the node.
//!
//! Contract surface (byte-identical paths to Core's in-process routes):
//!   - `api::public_routes()`    → `POST /api/mail/inbound/:id`  (HMAC-authed)
//!   - `api::protected_routes()` → the authed `/api/mail/*` CRUD
//!
//! SECURITY: this binary binds LOOPBACK ONLY (127.0.0.1) AND guards its protected
//! routes with a shared-secret bearer (`RYU_MAIL_TOKEN`, injected by Core into this
//! child's spawn env exactly as the gateway sidecar receives `CORE_TOKEN`). Core
//! stays the auth front — it runs `require_auth`, then re-stamps
//! `Authorization: Bearer <RYU_MAIL_TOKEN>` on the loopback hop — so a request that
//! did NOT come through Core (any other local process on a shared host) is rejected
//! with 401. The gate is FAIL-CLOSED: with no token configured every protected
//! route rejects. The inbound webhook keeps its own per-inbox HMAC auth (public in
//! Core too), so it is reachable tokenless.
//!
//! Port: `RYU_MAIL_PORT` env, default `7996`. Data dir: resolved via the inlined
//! `paths::ryu_dir` (`RYU_DIR`-env-first), so it opens the SAME `mail.db` the node
//! uses. The sidecar OWNS the store; Core no longer opens it.

mod api;
mod email;
mod mime;
mod paths;
mod send;
mod store;

use std::net::{Ipv4Addr, SocketAddr};

use serde::{Deserialize, Serialize};

pub use store::MailStore;

/// Default loopback port for the mail sidecar (overridable via `RYU_MAIL_PORT`).
const DEFAULT_PORT: u16 = 7996;

/// Axum state for the mail sidecar: just the store. Cheap to clone (wraps `Arc`s).
/// This replaces Core's `ServerState` — the mail handlers touched ONLY `state.mail`,
/// so a single-field state is a faithful, decoupled substitute.
#[derive(Clone)]
pub struct MailState {
    pub mail: MailStore,
}

// ── Domain types (moved from `apps/core/src/mail/mod.rs`) ────────────────────

/// How a self-host inbox receives mail.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InboxProvider {
    /// A mail provider (own domain) forwards raw MIME to the node webhook.
    Webhook,
    /// The node polls an IMAP mailbox (v1: reserved; not yet driven).
    Imap,
}

impl InboxProvider {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Webhook => "webhook",
            Self::Imap => "imap",
        }
    }
    fn from_str(s: &str) -> Self {
        match s {
            "imap" => Self::Imap,
            _ => Self::Webhook,
        }
    }
}

/// One self-host inbox.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Inbox {
    pub id: String,
    pub name: String,
    /// The address that receives mail (BYO domain, operator-supplied).
    pub address: String,
    pub provider: InboxProvider,
    /// HMAC secret the inbound forwarder signs the raw body with.
    pub inbound_secret: String,
    pub created_at: String,
}

/// A stored message (inbound or outbound).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailMessage {
    pub id: String,
    pub inbox_id: String,
    /// "inbound" | "outbound".
    pub direction: String,
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_reply_to: Option<String>,
    pub from_addr: String,
    pub to_addrs: Vec<String>,
    #[serde(default)]
    pub cc_addrs: Vec<String>,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_message_id: Option<String>,
    pub attachments: Vec<AttachmentMeta>,
    pub created_at: String,
}

/// Attachment metadata (the bytes live on the filesystem, keyed by sha256).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentMeta {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub size: u64,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let port: u16 = std::env::var("RYU_MAIL_PORT")
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT);

    // Shared-secret bearer Core injects (mirrors the gateway sidecar's CORE_TOKEN).
    // The protected routes require it; the inbound webhook stays on per-inbox HMAC.
    // Shared-secret bearer. When Core spawns this via the GENERIC ext-proxy loader it
    // injects `RYU_EXT_TOKEN` (the per-plugin minted secret it stamps on every proxied
    // hop + the health probe); the legacy hand-coded path injected `RYU_MAIL_TOKEN`.
    // Prefer the generic var, fall back to the legacy one — so ryu-mail works under
    // both spawn paths during/after the migration.
    let token = std::env::var("RYU_EXT_TOKEN")
        .ok()
        .or_else(|| std::env::var("RYU_MAIL_TOKEN").ok())
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if token.is_some() {
        tracing::info!("ryu-mail: protected routes require the injected shared-secret bearer");
    } else {
        tracing::warn!(
            "ryu-mail: no RYU_EXT_TOKEN/RYU_MAIL_TOKEN set; protected /api/mail/* routes are FAIL-CLOSED (reject all). The inbound webhook remains available via its per-inbox HMAC. Core injects this token when it spawns the sidecar."
        );
    }

    let mail = MailStore::open_default()?;
    let state = MailState { mail };

    // Layer the shared-secret gate onto the protected routes only. `from_fn` closes
    // over the resolved token so no extra state field is needed; the inbound webhook
    // (public_routes) is merged UN-layered so its HMAC auth stands alone.
    let protected = api::protected_routes().layer(axum::middleware::from_fn(
        move |req: axum::extract::Request, next: axum::middleware::Next| {
            let expected = token.clone();
            async move { api::require_mail_token(req, next, expected.as_deref()).await }
        },
    ));
    let app = api::public_routes().merge(protected).with_state(state);

    // LOOPBACK ONLY (belt) + shared-secret bearer (suspenders): Core is the auth
    // front and re-stamps the bearer on the proxied hop.
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("ryu-mail sidecar listening on http://{addr}");

    axum::serve(listener, app).await?;
    Ok(())
}
