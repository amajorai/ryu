//! Generic **app ⇄ HTTP** loader: turn a manifest-declared managed sidecar
//! ([`crate::sidecar::manifest_sidecar`]) into a full first-class *app* — a proxied
//! HTTP surface (`/api/ext/<plugin_id>/*`) plus an authenticated host-API callback
//! (`/api/host/*`) — driven entirely by manifest data.
//!
//! This is the generalization of what used to be the hand-coded `ryu-mail` proxy:
//! where that hardcoded its route list, its shared-secret bearer, and its verbatim
//! body/header pass-through, this module reads the SAME shape from a sidecar's
//! declarative [`HttpProxySpec`]/[`HostApiSpec`]. Mail itself now rides this engine
//! (the `@ryu/mail` app + a `public_mount` — see [`public_mount_routes`]); the
//! dedicated `sidecar/mail.rs` was retired (Track C).
//!
//! ## The two lanes
//!
//! - **Inbound proxy** (`/api/ext/<plugin_id>/*rest`, client → Core → sidecar). One
//!   catch-all registered on the PUBLIC router — a single catch-all path cannot be
//!   gated two ways by router middleware, and the public|protected decision is
//!   per-route manifest data. So [`ext_proxy`] itself enforces the node bearer, from
//!   the matched route's declared [`RouteAuth`], using the SAME `Option<String>`
//!   node-token Extension `require_auth` reads (layered onto the ext sub-router). A
//!   sub-path matching NONE of the declared routes is refused (404) — undeclared
//!   paths are never forwarded (mail's exact-route safety, expressed as data).
//!
//! - **Host-API callback** (`/api/host/*`, sidecar → Core). The sidecar process does
//!   NOT hold the node bearer, so these live on the PUBLIC router and authenticate
//!   in-handler with the plugin's minted [`ext_token`]: the sidecar presents its
//!   `x-ryu-plugin-id` + `Authorization: Bearer <RYU_EXT_TOKEN>`, Core recomputes
//!   that plugin's expected token and constant-time-compares, then intersects the
//!   requested capability's grant with BOTH the sidecar's declared `host_api.grants`
//!   and the plugin's Gateway-*approved* grants (never the manifest claim).
//!
//! ## The minted token (closes the live gap)
//!
//! [`ext_token`] derives a per-plugin secret from the node token + plugin id (a hash,
//! not a concatenation, so plugin A's token can never yield plugin B's). Core injects
//! it into the sidecar at spawn (`RYU_EXT_TOKEN`), presents it on the (previously
//! unauthenticated) health probe, and re-stamps it on every proxied hop — so a
//! well-behaved sidecar can refuse any loopback caller that did not come through
//! Core. Sidecars SHOULD bind loopback only.
//!
//! ## Web-delegated requests
//!
//! The web app's server tier forwards a signed-in browser's `app.request` calls here
//! with the server-held node token, which Core would otherwise read as the node
//! owner. It therefore stamps [`HDR_WEB_DELEGATION`] on every such request, and Core
//! narrows those requests in [`web_delegated_admission`]: a verified member of a
//! bound node, a route the app annotated with a `permission`, a target app that
//! supports the web surface, and a named calling app ([`HDR_APP_CALLER`]) that is
//! enabled, web-capable, has a Companion and holds the reviewed `app:http` (own app)
//! or `app:http:<target>` (another app) grant. The marker only ever narrows: a request
//! without it is handled exactly as before.

use axum::body::Body;
use axum::extract::{
    ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    Path, Query, Request, State,
};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Extension, Json, Router};
use hmac::{Hmac, Mac};
use serde_json::json;
use sha2::Sha256;
use std::collections::{HashMap, HashSet};

use crate::plugin_manifest::schema::{HttpProxySpec, RouteAuth, SidecarSpec};
use crate::server::ServerState;
use crate::sidecar::manager::{ForwardDenied, ForwardTarget};

pub(crate) mod egress_policy;
mod forward;
mod header_policy;
mod host_api;
mod host_capability;
mod host_events;
mod kernel_caps;
mod kernel_dispatch;
mod lane;
mod member_admission;
mod mounts;
mod plugin_proxy;
mod principal_lane;
mod provider_route;
mod response_cookies;
mod response_hardening;
mod route_match;
mod web_delegation;
mod ws_bridge;
mod ws_tunnel;

use forward::*;
use header_policy::*;
pub use host_api::*;
use host_capability::*;
pub(crate) use host_events::*;
use kernel_caps::*;
use kernel_dispatch::*;
pub(crate) use lane::sign_agent_lane;
use lane::*;
pub use mounts::*;
use plugin_proxy::*;
pub(crate) use provider_route::*;
pub(crate) use route_match::*;
use web_delegation::*;
use ws_bridge::*;
use ws_tunnel::*;

#[cfg(test)]
mod tests;

/// Env var carrying the per-plugin shared secret Core injects into a sidecar and
/// re-stamps on every proxied hop / expects on the host-API callback.
pub const ENV_EXT_TOKEN: &str = "RYU_EXT_TOKEN";
/// Env var carrying the owning plugin id (so the sidecar can echo it back on the
/// host-API callback without guessing).
pub const ENV_EXT_PLUGIN_ID: &str = "RYU_EXT_PLUGIN_ID";
/// Header the sidecar sends on a host-API callback naming its own plugin id.
/// Also stamped by the generated capability CLI shims
/// ([`crate::sidecar::cli_shims`]) — the one definition both the HTTP callers and
/// the shim scripts read, so the header name can never drift.
pub(crate) const HDR_PLUGIN_ID: &str = "x-ryu-plugin-id";
/// Internal hop header used only to carry a caller's MPP credential alongside the
/// sidecar bearer. It is stripped from caller input and upstream responses.
const HDR_FORWARDED_AUTHORIZATION: &str = "x-ryu-forwarded-authorization";
const HDR_CALLER_USER_ID: &str = "x-ryu-caller-user-id";
const HDR_CALLER_ORG_ID: &str = "x-ryu-caller-org-id";
/// The verified caller's email from the signed identity token, stamped only when
/// the token also carries `email_verified: true`. Like the user and org headers,
/// a caller-supplied copy is stripped before Core stamps it, so a sidecar can
/// match email-addressed grants (named editors or viewers) without receiving the
/// caller's JWT, and never against an address the caller has not proven to own.
const HDR_CALLER_EMAIL: &str = "x-ryu-caller-email";
const HDR_CALLER_RESOURCE_IDS: &str = "x-ryu-caller-resource-ids";
/// Pseudonymous per-client rate subject, stamped only for sidecars whose
/// manifest sets `forward_caller_rate_subject` (see [`rate_subject_for`]).
/// Stripped from caller input for every sidecar.
const HDR_CALLER_RATE_SUBJECT: &str = "x-ryu-caller-rate-subject";
pub(crate) const HDR_CALLER_AGENT_ID: &str = "x-ryu-caller-agent-id";
pub(crate) const HDR_CALLER_AGENT_PROOF: &str = "x-ryu-caller-agent-proof";
/// The verified calling agent's egress allowlist (comma-separated hosts and
/// `*.` domains; empty allows none), stamped by Core from
/// [`crate::sidecar::ext_proxy::egress_policy`] beside [`HDR_CALLER_AGENT_ID`] and nowhere
/// else. A request that carries its own copy is refused, and the header is
/// stripped from every other hop. Apps that run network sessions for an agent
/// enforce it in their egress path.
pub(crate) const HDR_CALLER_EGRESS_ALLOWLIST: &str = "x-ryu-caller-egress-allowlist";
/// Opt-in marker the web app's server tier stamps on every ext request it forwards
/// for a browser. Its PRESENCE (any value) routes the request through
/// [`web_delegated_admission`]. It is deliberately separate from `x-ryu-surface`,
/// which is presentation-only. Stripped before the sidecar hop. The web tier also
/// stamps it on app host-bridge calls (`server::plugin_bridge_api`).
pub(crate) const HDR_WEB_DELEGATION: &str = "x-ryu-web-delegation";
/// Stamped by Core, with the delivery id, on an event delivery to a subscriber's
/// route ([`crate::sidecar::event_subscribers`]) and stripped from every other hop,
/// so a subscriber can tell Core's delivery from a caller that reached the same
/// declared route through this proxy.
pub(crate) const HDR_EVENT_DELIVERY: &str = "x-ryu-event-delivery";
/// The calling app the web host names for a web-delegated request. Browser-asserted,
/// so it is not identity: it pins each request to ONE reviewed grant edge on an
/// enabled, web-capable Companion app. Stripped before the sidecar hop.
const HDR_APP_CALLER: &str = "x-ryu-app-caller";
/// The own-app `app.request` grant; its reviewed per-target form is
/// `app:http:<scoped target id>`. Both are existing reviewed grants.
const APP_HTTP_GRANT: &str = "app:http";
/// Default max request body Core buffers + forwards when a sidecar's
/// [`HttpProxySpec::max_body_bytes`] is unset (10 MiB).
const DEFAULT_MAX_PROXY_BYTES: usize = 10 * 1024 * 1024;
/// CONNECT timeout on a single upstream (Core → sidecar) proxied hop, so an
/// unreachable sidecar fails fast (502). Deliberately a connect-only bound, NOT a
/// total-request timeout: the proxy must carry long-lived SSE streams (dashboards
/// `/events`, meetings `/stream`, quests/monitors event feeds) that never complete by
/// design — a total `.timeout()` would sever them mid-stream (and, worse, block their
/// HEADERS behind the never-arriving body-end). Once connected the response streams
/// through (see [`forward_to_sidecar`]); a hung sidecar still cannot stall Core (every
/// hop is its own task).
const PROXY_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// How long a request WAITS for a lazy/idle-stopped sidecar to wake (start + health
/// warm-up) before the proxy answers 503 + `Retry-After`. Only the wait: the start
/// runs detached in the manager with its own long budget, so a first start that is a
/// download or a `pip install` keeps going and a retry finds it warm (or joins it).
const WAKE_WARMUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// `Retry-After` (seconds) on a 503 for a sidecar that is still starting.
const WAKE_RETRY_AFTER_SECS: &str = "5";

/// The response for a wake that did not produce a warm sidecar.
///
/// "Still starting" (the caller's wait ran out; the start continues detached) is a
/// retryable 503 with `Retry-After`. A start that actually FAILED is a 503 without
/// it — retrying immediately will not help — and says so instead of "warming up".
/// The start's own error text is logged, not returned. `json_body` keeps each
/// lane's existing body shape (plain text on the proxy lanes, JSON on the broker).
fn wake_failed_response(who: &str, name: &str, err: &anyhow::Error, json_body: bool) -> Response {
    let still_starting = crate::sidecar::manager::is_still_starting(err);
    tracing::warn!("{who}: waking sidecar '{name}' failed: {err:#}");
    let message = if still_starting {
        "sidecar is still starting, retry shortly"
    } else {
        "sidecar failed to start"
    };
    let mut response = if json_body {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": message, "retryable": still_starting })),
        )
            .into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, message).into_response()
    };
    if still_starting {
        response.headers_mut().insert(
            axum::http::header::RETRY_AFTER,
            axum::http::HeaderValue::from_static(WAKE_RETRY_AFTER_SECS),
        );
    }
    response
}

/// Activation-event token fired (globally, like `onChat`/`onStartup`) the first time
/// a lazy sidecar is cold-started by an inbound proxy hit, so a plugin's Runnables
/// gated on `onRoute` register on first use. Bare token, consistent with the other
/// activation events; the manifest doc lists it as a recognised token.
const ACTIVATION_ON_ROUTE: &str = "onRoute";

/// Activation-event token fired the first time a lazy PROVIDER sidecar is cold-started
/// by a capability-broker hit (the `onCapabilityCall` analogue of [`ACTIVATION_ON_ROUTE`]).
const ACTIVATION_ON_CAPABILITY_CALL: &str = "onCapabilityCall";

/// Fire an activation event off the request path (spawned, never awaited) so a lazy
/// sidecar's cold-start never blocks on the register loop — mirrors the chat path's
/// `fire_on_chat_once`. Called only on the cold-start edge (a wake that actually
/// started the process), so it does not re-run per request.
fn fire_lazy_activation(state: &ServerState, event: &'static str) {
    let state = state.clone();
    tokio::spawn(async move {
        crate::server::fire_activation_event(&state, event).await;
    });
}

// ── Token derivation ──────────────────────────────────────────────────────────

/// The node token (`RYU_TOKEN`), trimmed + non-empty, or `None` (loopback dev with
/// no token configured — the same posture [`crate::server`]'s `require_auth` accepts,
/// where the `None` branch allows the request).
pub fn node_token() -> Option<String> {
    crate::node_token::active_token()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// Return the independently random, sealed credential assigned to this plugin.
///
/// The legacy node-token parameter remains in the signature while callers are
/// migrated, but it is deliberately ignored: a compromised plugin credential
/// must reveal nothing about the node-owner token or any sibling plugin.
pub fn ext_token(_node_token: Option<&str>, plugin_id: &str) -> String {
    crate::sidecar::plugin_credentials::token_for(plugin_id)
}

// ── Route matching (the 404-gate security property) ───────────────────────────
