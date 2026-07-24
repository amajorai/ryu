//! Webhook ingress — the swappable public-reachability seam (P6a of the
//! unified-tool-gateway epic, #479). Extracted from `apps/core` into its own
//! crate (program §3/§4 W3); the kernel couplings are inverted through
//! [`WebhookIngressHost`], so this crate has ZERO dependency on `apps/core`.
//!
//! Composio triggers are **webhook-delivered**: there is no event-pull API, so a
//! local Core bound to `127.0.0.1` never receives them. This crate is the
//! swappable seam that gives Core a publicly-reachable URL pointed at its existing
//! handler (`POST /api/composio/webhook`, reached via the host), so a trigger
//! fires unchanged. Public webhook *routes* stay kernel-ingress in Core (program
//! §5) and forward into this engine.
//!
//! Core vs Gateway (CLAUDE.md §1): exposing a tunnel + deciding which backend runs
//! is *what runs* → **Core**. There is no policy here.
//!
//! "Nothing hardcoded" (CLAUDE.md §1): the backend is a swappable [`Ingress`]
//! enum selected by the `webhook.ingress.backend` pref, with an
//! `RYU_WEBHOOK_INGRESS_URL` env override for the BYO (OwnRelay) case. The default
//! is the managed [`IngressKind::RyuRelay`].
//!
//! Backend dispatch uses native `async fn` trait methods (not object-safe) + a
//! closed [`Ingress`] enum match-dispatched — no `async-trait`, no `dyn`. See
//! [`tunnels`]. (The host seam is the one `dyn`/`async-trait` boundary.)

mod dispatch;
mod host;
mod ryu_relay;
mod tunnels;
mod win_process;

pub use dispatch::{
    deliver_inbound, deliver_workflow_webhook, first_http_delivery, last_delivery, record_delivery,
    timestamp_fresh, workflow_webhook_path, InboundOutcome, WorkflowWebhookOutcome,
};
pub use host::{set_global_host, WebhookIngressHost, WorkflowWebhookSecret};
pub use ryu_relay::{ensure_relay_started, relay_inbound_url};
pub use tunnels::{
    CloudflaredSource, Ingress, OwnRelaySource, RyuRelaySource, TailscaleFunnelSource,
    OWN_RELAY_URL_ENV, WEBHOOK_PATH,
};

use std::str::FromStr;
use std::sync::RwLock;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

/// The pref key selecting the active ingress backend (`webhook.ingress.backend`).
pub const INGRESS_BACKEND_PREF: &str = "webhook.ingress.backend";

/// The pref key holding the BYO public base URL (the OwnRelay fallback when the
/// `RYU_WEBHOOK_INGRESS_URL` env override is absent).
pub const INGRESS_URL_PREF: &str = "webhook.ingress.url";

/// The four ingress backends. Serializes kebab-case so the wire form and the pref
/// value round-trip (`ryu-relay` / `tailscale-funnel` / `cloudflared` /
/// `own-relay`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IngressKind {
    RyuRelay,
    TailscaleFunnel,
    Cloudflared,
    OwnRelay,
}

impl IngressKind {
    /// The default backend on a fresh install: the managed RyuRelay push.
    pub const DEFAULT: IngressKind = IngressKind::RyuRelay;

    /// Every kind, for selector listings.
    pub const ALL: [IngressKind; 4] = [
        IngressKind::RyuRelay,
        IngressKind::TailscaleFunnel,
        IngressKind::Cloudflared,
        IngressKind::OwnRelay,
    ];

    /// The kebab-case wire form (also the pref value). Kept in lockstep with the
    /// serde derive and [`FromStr`] so the parse + serialize paths never drift.
    pub fn as_str(&self) -> &'static str {
        match self {
            IngressKind::RyuRelay => "ryu-relay",
            IngressKind::TailscaleFunnel => "tailscale-funnel",
            IngressKind::Cloudflared => "cloudflared",
            IngressKind::OwnRelay => "own-relay",
        }
    }
}

impl FromStr for IngressKind {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "ryu-relay" | "ryurelay" => Ok(IngressKind::RyuRelay),
            "tailscale-funnel" | "tailscalefunnel" | "funnel" => Ok(IngressKind::TailscaleFunnel),
            "cloudflared" => Ok(IngressKind::Cloudflared),
            "own-relay" | "ownrelay" => Ok(IngressKind::OwnRelay),
            other => bail!("unknown webhook ingress backend `{other}`"),
        }
    }
}

/// The webhook-ingress trait every backend implements. Native `async fn` (not
/// object-safe) → stored via the closed [`Ingress`] enum, never `dyn`.
pub trait WebhookIngress {
    /// Which backend this is.
    fn kind(&self) -> IngressKind;
    /// Start (or adopt) the backend so webhooks can arrive. May be a no-op (the
    /// OwnRelay case) or error gracefully when the backing infra is absent.
    async fn start(&self) -> Result<()>;
    /// The public URL Composio should POST to (ends in [`WEBHOOK_PATH`]).
    async fn public_url(&self) -> Result<String>;
}

/// Process-global public URL, set by `main.rs` (and re-settable, so a later
/// rebuild can update it). A re-settable lock (not `OnceLock`) keeps the
/// `set_public_url`/`public_url` round-trip stable under cargo's parallel test
/// runner.
static PUBLIC_URL: RwLock<Option<String>> = RwLock::new(None);

/// Publish the resolved public ingress URL for `GET /api/webhook-ingress/status`.
pub fn set_public_url(url: Option<String>) {
    if let Ok(mut guard) = PUBLIC_URL.write() {
        *guard = url;
    }
}

/// The current public ingress URL, if one has been resolved.
pub fn public_url() -> Option<String> {
    PUBLIC_URL.read().ok().and_then(|g| g.clone())
}

/// The resolved public **origin** base URL (no webhook path) — but ONLY when the
/// active ingress is a true reverse-proxy origin that forwards *every* path to
/// Core. `None` otherwise.
///
/// The webhook registry (`GET /api/webhooks`) uses this to build a per-endpoint
/// URL (`base + /api/workflows/<id>/webhook`, …) — the fix for the desktop
/// showing a `localhost` URL for a workflow webhook.
///
/// The discriminator is whether [`public_url`] is [`WEBHOOK_PATH`]-suffixed:
/// - **Tunnel backends** (Cloudflared / TailscaleFunnel / OwnRelay) publish
///   `<origin>/api/composio/webhook`. Stripping the suffix yields a real origin
///   that forwards every path, so `base + <any-path>` is directly reachable.
/// - **Managed RyuRelay** publishes a relay-ingress endpoint
///   (`…/api/composio-relay/ingress/<token>`) that is NOT path-composable —
///   appending `/api/workflows/<id>/webhook` would produce a dead URL. So this
///   returns `None` for the relay, and the registry advertises `null` for the
///   per-path (workflow) URLs (they are genuinely not path-addressable until the
///   server emits the generic inbound frame — see [`dispatch`] + the server
///   handoff). The relay's own composio ingress URL is still surfaced verbatim
///   via [`public_url`].
pub fn public_base_url() -> Option<String> {
    let u = public_url()?;
    let base = u.strip_suffix(WEBHOOK_PATH)?;
    Some(base.trim_end_matches('/').to_owned())
}

/// The configured backend kind, resolved from (1) the `RYU_WEBHOOK_INGRESS_URL`
/// env override ⇒ [`IngressKind::OwnRelay`], else (2) the `backend_pref`
/// (`webhook.ingress.backend`), else (3) the [`IngressKind::DEFAULT`]
/// (`RyuRelay`). Shared by [`from_prefs`], the backend selector, and the status
/// handler so they never disagree.
///
/// `backend_pref` is the raw `webhook.ingress.backend` pref value (Core reads it;
/// this crate is `PreferencesStore`-free — the primitive must not know the store).
pub fn configured_kind(backend_pref: Option<&str>) -> IngressKind {
    let env_url = std::env::var(OWN_RELAY_URL_ENV)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty());
    if env_url.is_some() {
        return IngressKind::OwnRelay;
    }
    match backend_pref {
        Some(raw) => IngressKind::from_str(raw).unwrap_or(IngressKind::DEFAULT),
        None => IngressKind::DEFAULT,
    }
}

/// Build the configured [`Ingress`] from the resolved pref values + the local
/// server URL.
///
/// Precedence (acceptance #1): the `RYU_WEBHOOK_INGRESS_URL` env override wins
/// (OwnRelay), else `backend_pref` (`webhook.ingress.backend`), else the default
/// (`RyuRelay`). `url_pref` is the `webhook.ingress.url` pref (the OwnRelay
/// fallback base). `server_url` is Core's own reachable base
/// (`http://host:port`), used to derive the Funnel/Cloudflared target port.
pub fn from_prefs(backend_pref: Option<&str>, url_pref: Option<&str>, server_url: &str) -> Ingress {
    let kind = configured_kind(backend_pref);
    let port = port_from_url(server_url).unwrap_or(7980);
    match kind {
        IngressKind::RyuRelay => Ingress::RyuRelay(RyuRelaySource::new()),
        IngressKind::TailscaleFunnel => Ingress::TailscaleFunnel(TailscaleFunnelSource::new(port)),
        IngressKind::Cloudflared => Ingress::Cloudflared(CloudflaredSource::new(port)),
        IngressKind::OwnRelay => {
            // OwnRelay base: env override (read inside OwnRelaySource::new) → the
            // `webhook.ingress.url` pref. There is deliberately NO `server_url`
            // fallback: the loopback bind addr is not publicly reachable, so
            // substituting it would let an unconfigured OwnRelay report a green
            // `up:true` with a `http://127.0.0.1:7980/...` URL Composio can never
            // reach. An empty base makes `start()`/`public_url()` error and `up`
            // read `false` until a real public URL is configured.
            let pref_base = url_pref
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .unwrap_or_default();
            Ingress::OwnRelay(OwnRelaySource::new(pref_base))
        }
    }
}

/// Extract the port from a `scheme://host:port[/...]` URL. Returns `None` when no
/// explicit port is present (the caller defaults to Core's 7980).
fn port_from_url(url: &str) -> Option<u16> {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let authority = after_scheme.split('/').next().unwrap_or(after_scheme);
    // Strip an IPv6 literal's brackets so the `:port` split below is unambiguous.
    let authority = authority.rsplit(']').next().unwrap_or(authority);
    authority.rsplit(':').next().and_then(|p| p.parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_serde_kebab_round_trips() {
        for kind in IngressKind::ALL {
            let json = serde_json::to_value(kind).unwrap();
            let s = json.as_str().unwrap().to_owned();
            // The serde wire form equals as_str() and parses back via FromStr.
            assert_eq!(s, kind.as_str());
            let back: IngressKind = serde_json::from_value(json).unwrap();
            assert_eq!(back, kind);
            assert_eq!(IngressKind::from_str(&s).unwrap(), kind);
        }
    }

    #[test]
    fn kind_serde_wire_forms_are_kebab() {
        assert_eq!(
            serde_json::to_value(IngressKind::RyuRelay).unwrap(),
            serde_json::json!("ryu-relay")
        );
        assert_eq!(
            serde_json::to_value(IngressKind::TailscaleFunnel).unwrap(),
            serde_json::json!("tailscale-funnel")
        );
        assert_eq!(
            serde_json::to_value(IngressKind::OwnRelay).unwrap(),
            serde_json::json!("own-relay")
        );
    }

    #[test]
    fn from_str_unknown_errors() {
        assert!(IngressKind::from_str("nope").is_err());
    }

    /// Serializes the tests that mutate the process-global `PUBLIC_URL` (cargo
    /// runs them on parallel threads in one process; without this a sibling's
    /// `set_public_url` could flip the value mid-assertion).
    static PUBLIC_URL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn public_url_global_round_trips() {
        let _guard = PUBLIC_URL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Re-settable (not OnceLock): two sets both take effect.
        set_public_url(Some("https://a.example/api/composio/webhook".to_owned()));
        assert_eq!(
            public_url().as_deref(),
            Some("https://a.example/api/composio/webhook")
        );
        set_public_url(Some("https://b.example/api/composio/webhook".to_owned()));
        assert_eq!(
            public_url().as_deref(),
            Some("https://b.example/api/composio/webhook")
        );
        set_public_url(None);
        assert!(public_url().is_none());
    }

    #[test]
    fn public_base_url_only_for_true_origins() {
        let _guard = PUBLIC_URL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // A WEBHOOK_PATH-suffixed URL (tunnel/OwnRelay) yields a composable origin.
        set_public_url(Some("https://x.example/api/composio/webhook".to_owned()));
        assert_eq!(public_base_url().as_deref(), Some("https://x.example"));
        // A relay-ingress URL (RyuRelay) is NOT path-composable → None (never a
        // fabricated dead URL like `<ingress>/api/workflows/<id>/webhook`).
        set_public_url(Some(
            "https://s.example/api/composio-relay/ingress/tok123".to_owned(),
        ));
        assert!(public_base_url().is_none());
        // No ingress up → None.
        set_public_url(None);
        assert!(public_base_url().is_none());
    }

    #[test]
    fn port_from_url_parses() {
        assert_eq!(port_from_url("http://127.0.0.1:7980"), Some(7980));
        assert_eq!(port_from_url("http://localhost:3000/api"), Some(3000));
        assert_eq!(port_from_url("https://[::1]:7980"), Some(7980));
        assert_eq!(port_from_url("http://example.com"), None);
    }

    // ── from_prefs branches (acceptance #1) ──────────────────────────────────
    //
    // Pref values are passed as plain `Option<&str>` (Core reads the store; this
    // crate is `PreferencesStore`-free). Env-override branch is exercised inline.
    //
    // `OWN_RELAY_URL_ENV` is process-global; cargo runs these tests as parallel
    // threads in one process. Without serialization, `env_override_forces_own_relay`
    // can `set_var` the override while a sibling `from_prefs_*` test reads it,
    // flipping its branch to OwnRelay and failing. All three env-sensitive tests
    // acquire ENV_LOCK for their full duration so the env mutation is serialized
    // against the readers (an `is_err()` guard alone cannot win a concurrent race).
    // `unwrap_or_else(|e| e.into_inner())` recovers a poisoned lock so a single
    // failing assertion doesn't cascade into the other two and mask the real one.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[tokio::test]
    async fn from_prefs_defaults_to_ryu_relay() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // No env override, no pref → RyuRelay (the headline AC). Guard on the env
        // being unset so a CI machine with it set doesn't flip the branch.
        if std::env::var(OWN_RELAY_URL_ENV).is_err() {
            let ing = from_prefs(None, None, "http://127.0.0.1:7980");
            assert_eq!(ing.kind(), IngressKind::RyuRelay);
        }
    }

    #[tokio::test]
    async fn from_prefs_honours_pref() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        if std::env::var(OWN_RELAY_URL_ENV).is_err() {
            let ing = from_prefs(Some("tailscale-funnel"), None, "http://127.0.0.1:7980");
            assert_eq!(ing.kind(), IngressKind::TailscaleFunnel);

            let ing = from_prefs(
                Some("own-relay"),
                Some("https://relay.example.com"),
                "http://127.0.0.1:7980",
            );
            assert_eq!(ing.kind(), IngressKind::OwnRelay);
            assert_eq!(
                ing.public_url().await.unwrap(),
                "https://relay.example.com/api/composio/webhook"
            );
        }
    }

    #[tokio::test]
    async fn env_override_forces_own_relay() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Set the env override for this test only, then clear it. env is
        // process-global; ENV_LOCK serializes this mutation against the sibling
        // from_prefs_* readers (edition 2021, so set_var/remove_var are safe).
        std::env::set_var(OWN_RELAY_URL_ENV, "https://ovr.example.com");
        // Even with a conflicting pref, the env override wins.
        let kind = configured_kind(Some("cloudflared"));
        let ing = from_prefs(Some("cloudflared"), None, "http://127.0.0.1:7980");
        std::env::remove_var(OWN_RELAY_URL_ENV);
        assert_eq!(kind, IngressKind::OwnRelay);
        assert_eq!(ing.kind(), IngressKind::OwnRelay);
        assert_eq!(
            ing.public_url().await.unwrap(),
            "https://ovr.example.com/api/composio/webhook"
        );
    }
}
