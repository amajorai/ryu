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
const AGENT_LANE_PROOF_DOMAIN: &str = "ryu-agent-lane-v1";

type AgentLaneMac = Hmac<Sha256>;

fn agent_lane_payload(agent_id: &str, method: &str, path_and_query: &str) -> String {
    format!("{AGENT_LANE_PROOF_DOMAIN}\n{method}\n{path_and_query}\n{agent_id}")
}

/// Stamp a Core-generated agent-lane request. The proof is tied to the active
/// node bearer and the exact method/path/query, so a sidecar never trusts a
/// caller-supplied lane query on its own.
pub(crate) fn sign_agent_lane(
    agent_id: &str,
    method: &str,
    path_and_query: &str,
) -> Option<String> {
    let token = crate::node_token::active_token()?;
    let mut mac = AgentLaneMac::new_from_slice(token.trim().as_bytes()).ok()?;
    mac.update(agent_lane_payload(agent_id, method, path_and_query).as_bytes());
    Some(hex::encode(mac.finalize().into_bytes()))
}

fn verify_agent_lane(agent_id: &str, method: &str, path_and_query: &str, proof: &str) -> bool {
    let Some(token) = crate::node_token::active_token() else {
        return false;
    };
    let Ok(bytes) = hex::decode(proof.trim()) else {
        return false;
    };
    let Ok(mut mac) = AgentLaneMac::new_from_slice(token.trim().as_bytes()) else {
        return false;
    };
    mac.update(agent_lane_payload(agent_id, method, path_and_query).as_bytes());
    mac.verify_slice(&bytes).is_ok()
}

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

/// Match an incoming sub-path against a declared route pattern. Supports `:param`
/// (one non-empty segment) and a trailing `*rest` (the remainder). Pure + unit-tested
/// because this IS the gate: undeclared paths must 404, and a parametric route like
/// `/inboxes/:id` must still match `/inboxes/abc` (naive string-equality would 404 it,
/// naive prefix-match would wrongly admit undeclared subpaths).
///
/// `pub(crate)` because [`crate::ext_api::lower`] intersects an app's OpenAPI
/// operations against the same declared patterns before minting derived tools —
/// an operation this matcher would 404 must not become a tool that always fails.
/// It calls THIS function rather than carrying its own copy: two definitions of
/// one security gate is exactly how the gate quietly stops matching the thing it
/// was written to catch. Do not re-privatize.
pub(crate) fn route_matches(pattern: &str, actual: &str) -> bool {
    let pat: Vec<&str> = pattern.trim_start_matches('/').split('/').collect();
    let act: Vec<&str> = actual.trim_start_matches('/').split('/').collect();
    for (i, p) in pat.iter().enumerate() {
        if p.starts_with('*') {
            // Trailing wildcard: matches the remainder (including empty).
            return true;
        }
        let Some(a) = act.get(i) else {
            return false; // pattern longer than the actual path.
        };
        if let Some(_param) = p.strip_prefix(':') {
            if a.is_empty() {
                return false;
            }
        } else if p != a {
            return false;
        }
    }
    // No wildcard consumed the tail ⇒ lengths must match exactly.
    pat.len() == act.len()
}

/// Reject any path carrying a `.` or `..` segment. The auth decision is taken from
/// the pattern matching the RAW sub-path, but reqwest normalizes `..` on the URL it
/// forwards — so `/webhook/..%2fadmin` could match a Public `/webhook/*rest` route
/// (no node bearer) yet reach the sidecar's protected `/admin` mount carrying a valid
/// Core-stamped bearer. Reject dot-segments up front so match and forward can never
/// disagree.
///
/// ## Why this decodes in a loop rather than trusting the extractor
///
/// This used to compare each segment against the literal `"."`/`".."` on the stated
/// grounds that "`%2e`/`%2E` are already decoded to `.` by the axum path extractor".
/// That is true, but it is true exactly ONCE, and one decode is not enough as soon as
/// a caller controls a path parameter's VALUE rather than the route.
///
/// A derived (OpenAPI-generated) tool fills `{id}` from model-supplied arguments, and
/// `build_rest_request` percent-encodes that value on the way in — so a model that
/// sends `%2e%2e` produces `%252e%252e`, the extractor decodes it once back to
/// `%2e%2e`, and a literal comparison against `".."` sees an ordinary-looking segment
/// and waves it through. The sidecar's own framework then decodes a second time and
/// gets `..`. The gate and the thing it is guarding disagreed about how many times to
/// decode, which is the whole bug.
///
/// So: decode until it stops changing (bounded — a decode loop on attacker-supplied
/// input must not be unbounded), and reject if ANY round shows a dot segment.
fn has_dot_segment(sub_path: &str) -> bool {
    /// Enough to cover realistic multi-encoding while staying a hard bound. Real
    /// traffic needs zero or one round; anything approaching this is an attack.
    const MAX_DECODE_ROUNDS: usize = 8;

    let mut current = sub_path.to_owned();
    for _ in 0..MAX_DECODE_ROUNDS {
        if current
            .trim_start_matches('/')
            .split('/')
            .any(|seg| seg == "." || seg == "..")
        {
            return true;
        }
        if current.contains('\\') {
            return true;
        }
        let decoded = match urlencoding::decode(&current) {
            Ok(next) => next.into_owned(),
            // Not valid percent-encoding (or not UTF-8 once decoded). Nothing
            // downstream will get a cleaner read of it than we just did.
            Err(_) => return true,
        };
        // A segment separator that only APPEARS after decoding (`..%2fadmin`) means
        // the pre-decode split never saw the boundary. Re-splitting on the next
        // round is what catches it.
        if decoded.matches('/').count() != current.matches('/').count() || decoded.contains('\\') {
            return true;
        }
        if decoded == current {
            return false;
        }
        current = decoded;
    }
    // Still changing after the bound: pathologically nested encoding. Refuse rather
    // than hand a path we have not finished understanding to the forwarder.
    true
}

/// Whether `sub_path` holds a `?` or `#`, literally or under any layer of percent
/// encoding.
///
/// Axum has already decoded the path once, so a caller's `%3F` arrives here as a
/// literal `?`. The route and permission gates would match the path WITH it (and gate
/// on a resource id such as `job-1?`), but the forward builds a URL from the same
/// string, where the first `?` starts the query and `#` the fragment: the sidecar
/// would serve the shorter path (`job-1`) the gates never saw. A deeper layer
/// (`%253F`) is refused for the same reason the dot-segment guard decodes until the
/// path stops changing: the sidecar's own framework may decode once more.
fn has_query_or_fragment_delimiter(sub_path: &str) -> bool {
    const MAX_DECODE_ROUNDS: usize = 8;

    let mut current = sub_path.to_owned();
    for _ in 0..MAX_DECODE_ROUNDS {
        if current.contains(['?', '#']) {
            return true;
        }
        let decoded = match urlencoding::decode(&current) {
            Ok(next) => next.into_owned(),
            Err(_) => return true,
        };
        if decoded == current {
            return false;
        }
        current = decoded;
    }
    true
}

/// Whether `sub_path` holds a tab, LF or CR, literally or under any layer of percent
/// encoding.
///
/// The gates match `sub_path` as given, but the forward hands
/// `http://127.0.0.1:<port><mount><sub_path><query>` to reqwest, whose URL parser
/// deletes every tab, LF and CR BEFORE it collapses dot segments. So
/// `/webhook/.<TAB>./admin` (sent as `.%09.`) has no literal `..` for
/// [`has_dot_segment`] to refuse and matches a Public `/webhook/*rest` route, yet the
/// sidecar is asked for `/admin` carrying Core's hop bearer. Deletion alone renames a
/// path too: under a Public `/*rest`, `/ad<TAB>min` is forwarded as the Protected
/// `/admin`. A deeper layer (`%09`) is refused for the same reason the dot-segment
/// guard decodes until the path stops changing: the sidecar's own framework may
/// decode once more. Other C0 controls are not refused here: the parser
/// percent-encodes them inside the path, so they reach the sidecar as matched (a
/// trailing one is trimmed instead; see [`forward_url_trims_path_end`]).
fn has_url_parser_deleted_character(sub_path: &str) -> bool {
    const MAX_DECODE_ROUNDS: usize = 8;

    let mut current = sub_path.to_owned();
    for _ in 0..MAX_DECODE_ROUNDS {
        if current.contains(['\t', '\n', '\r']) {
            return true;
        }
        let decoded = match urlencoding::decode(&current) {
            Ok(next) => next.into_owned(),
            Err(_) => return true,
        };
        if decoded == current {
            return false;
        }
        current = decoded;
    }
    true
}

/// Whether the HTTP forward's URL parser would trim the end of `sub_path` off the path
/// it requests from the sidecar.
///
/// reqwest's URL parser trims C0 controls and spaces off the end of the WHOLE URL. The
/// forward appends `?<query>` whenever the request had one (even an empty one), so the
/// path is the end of that URL exactly when `query` is `None`. Only then is anything
/// trimmed, and then it always is: `/webhook/..<SPACE>` is forwarded as `/webhook/..`
/// and collapses to the mount root, and under a Public `/*rest` route `/admin<SPACE>`
/// is forwarded as the Protected `/admin`. So this refuses only a path the forward
/// would already send to a different place from the one the gates matched. A space
/// anywhere else, or one followed by a query, is percent-encoded and reaches the
/// sidecar as matched, and a still-encoded `%20` is never trimmed.
///
/// The WebSocket lane needs no such check: its bridge parses the upstream URL as an
/// `http::Uri`, which rejects a literal space or control character outright, so such
/// a socket is closed without ever reaching the sidecar.
fn forward_url_trims_path_end(sub_path: &str, query: Option<&str>) -> bool {
    query.is_none() && sub_path.ends_with(|c: char| c <= ' ')
}

/// The value captured by a named `:param` of `pattern` from `actual`, or `None` when
/// the pattern has no such param (or the paths do not line up). Split out from
/// [`route_matches`] because only the permission gate needs the captured value, and
/// the matcher itself stays a pure yes/no on the security-critical 404 path.
fn captured_param(pattern: &str, actual: &str, name: &str) -> Option<String> {
    let act: Vec<&str> = actual.trim_start_matches('/').split('/').collect();
    for (index, segment) in pattern.trim_start_matches('/').split('/').enumerate() {
        // A wildcard swallows an unknown number of segments, so nothing after it
        // lines up positionally any more. Give up rather than read whatever
        // happens to sit at this index — a wrong capture would resolve the ACL
        // against a resource id the caller effectively chose.
        if segment.starts_with('*') {
            return None;
        }
        if segment.strip_prefix(':') == Some(name) {
            return act
                .get(index)
                .filter(|value| !value.is_empty())
                .map(|value| (*value).to_owned());
        }
    }
    None
}

/// The permission a matched route demands, paired with the resource id it applies
/// to — `None` for a route the app did not annotate, which is every route shipping
/// today and must keep proxying exactly as before.
///
/// The resource id falls back to the plugin id when the rule names no
/// [`RouteSpec::resource_param`] (or the param captured nothing), so an admin can
/// always express "this person may use this app" even for a route that identifies no
/// object. Pure, so the rule this returns is unit-testable without a server.
fn required_permission_for(
    route: &crate::plugin_manifest::schema::RouteSpec,
    sub_path: &str,
    plugin_id: &str,
) -> Option<(String, String)> {
    let permission = route.permission.clone()?;
    let resource_id = route
        .resource_param
        .as_deref()
        .and_then(|param| captured_param(&route.path, sub_path, param))
        .unwrap_or_else(|| plugin_id.to_owned());
    Some((permission, resource_id))
}

/// The agent a request runs for, when Core's HTTP-tool seam stamped one.
///
/// Browser managed-Bot lanes are an internal Core capability, not a public
/// query selector. Accept the query only when the Core HTTP-tool seam supplied
/// a proof tied to the exact request; direct ext-proxy callers are refused.
///
/// Every other app learns its agent from [`HDR_CALLER_AGENT_ID`], which counts
/// only with a [`HDR_CALLER_AGENT_PROOF`] tied to the same agent, method, path
/// and query. A named agent with a missing or bad proof is refused rather than
/// forwarded as an agent-less call, so an agent can never shed its account
/// access by mangling the proof.
fn verified_agent_lane(req: &Request, plugin_id: &str) -> Result<Option<String>, Response> {
    if plugin_id != "@ryu/browser" {
        return verified_agent_header(req);
    }
    let query = req.uri().query().unwrap_or_default();
    let agent_ids: Vec<String> = url::form_urlencoded::parse(query.as_bytes())
        .filter(|(name, _)| name == "agent_id")
        .map(|(_, value)| value.into_owned())
        .collect();
    let Some(agent_id) = agent_ids.first() else {
        return Ok(None);
    };
    if agent_ids.len() != 1 || agent_id.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            "browser agent_id must be supplied exactly once",
        )
            .into_response());
    }
    let Some(proof) = req
        .headers()
        .get(HDR_CALLER_AGENT_PROOF)
        .and_then(|value| value.to_str().ok())
    else {
        return Err((
            StatusCode::FORBIDDEN,
            "browser agent lanes require a Core-issued capability proof",
        )
            .into_response());
    };
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or_else(|| req.uri().path());
    if !verify_agent_lane(agent_id, req.method().as_str(), path_and_query, proof) {
        return Err((StatusCode::FORBIDDEN, "browser agent lane proof is invalid").into_response());
    }
    Ok(Some(agent_id.clone()))
}

/// Whether a request that resolved to a `Public` route must be refused because its
/// ORIGINAL (still percent-encoded) URI path hides a dot segment, a backslash, or a
/// separator that only appears after decoding.
///
/// Axum has already decoded the Path capture that [`resolve_route`] sees, so a
/// separator encoded once (`/slug%2F..%2Fadmin`, `/slug%2Fsessions`) is invisible
/// there. Public routes are reachable without any credential, and the satellites
/// behind them (Forms, Bot Flows, inbound webhooks, …) resolve slugs against their
/// own stores, so the raw URI must be unambiguous before it reaches them. This holds
/// for every plugin's public routes; there is deliberately no per-app branch.
/// Protected routes keep the decoded-path check only: they already require the node
/// bearer, and some legitimately carry encoded separators in ids.
fn public_route_raw_path_is_unsafe(auth: RouteAuth, raw_path: &str) -> bool {
    auth == RouteAuth::Public && has_dot_segment(raw_path)
}

fn verified_agent_header(req: &Request) -> Result<Option<String>, Response> {
    let mut named = req.headers().get_all(HDR_CALLER_AGENT_ID).iter();
    let Some(agent_id) = named.next() else {
        return Ok(None);
    };
    let agent_id = agent_id
        .to_str()
        .ok()
        .map(str::trim)
        .filter(|value| !value.is_empty() && named.next().is_none())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "the calling agent must be named exactly once",
            )
                .into_response()
        })?;
    let Some(proof) = req
        .headers()
        .get(HDR_CALLER_AGENT_PROOF)
        .and_then(|value| value.to_str().ok())
    else {
        return Err((
            StatusCode::FORBIDDEN,
            "a calling agent requires a Core-issued capability proof",
        )
            .into_response());
    };
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or_else(|| req.uri().path());
    if !verify_agent_lane(agent_id, req.method().as_str(), path_and_query, proof) {
        return Err((StatusCode::FORBIDDEN, "calling agent proof is invalid").into_response());
    }
    Ok(Some(agent_id.to_owned()))
}

/// Find the most-specific declared route on `manifest` that matches `sub_path`,
/// returning the matched sidecar spec, its http spec, and the matched route. Equal
/// specificity is rejected so auth posture never depends on declaration order.
///
/// The whole ROUTE comes back rather than just its auth posture: the permission gate
/// reads the same matched entry the forward decision came from, so the two can never
/// be resolved against different routes.
fn resolve_route<'a>(
    manifest: &'a crate::plugin_manifest::PluginManifest,
    sub_path: &str,
    method: &str,
) -> Option<(
    &'a SidecarSpec,
    &'a HttpProxySpec,
    &'a crate::plugin_manifest::schema::RouteSpec,
)> {
    if has_dot_segment(sub_path)
        || has_query_or_fragment_delimiter(sub_path)
        || has_url_parser_deleted_character(sub_path)
    {
        return None;
    }
    let mut best: Option<(
        &SidecarSpec,
        &HttpProxySpec,
        &crate::plugin_manifest::schema::RouteSpec,
    )> = None;
    for spec in &manifest.sidecars {
        let Some(http) = &spec.http else { continue };
        for route in &http.routes {
            let method_matches = route
                .method
                .as_deref()
                .is_none_or(|declared| declared.eq_ignore_ascii_case(method));
            if method_matches && route_matches(&route.path, sub_path) {
                let candidate = (spec, http, route);
                if best.is_none_or(|(_, _, current)| {
                    crate::plugin_manifest::route_specificity(&route.path)
                        > crate::plugin_manifest::route_specificity(&current.path)
                }) {
                    best = Some(candidate);
                } else if best.is_some_and(|(_, _, current)| {
                    crate::plugin_manifest::route_specificity(&route.path)
                        == crate::plugin_manifest::route_specificity(&current.path)
                }) {
                    // A tie is ambiguous even when the manifest bypassed validation.
                    return None;
                }
            }
        }
    }
    best
}

// ── Hop-by-hop header handling (mirrors mail.rs) ──────────────────────────────

fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host" | "content-length" | "connection" | "transfer-encoding" | "keep-alive" | "upgrade"
    )
}

/// Browser-context headers describing the ORIGINAL caller (the desktop webview's
/// cross-origin `fetch` to Core), not the Core→sidecar hop. Sidecar loopback
/// control servers 403 any request carrying a non-empty `Origin` as CSRF /
/// DNS-rebind defense (the island-pattern hardening, e.g. the browser sidecar's
/// `isTrustedLocalRequest`), so forwarding it would make Core's own
/// authenticated proxy hop indistinguishable from a drive-by browser request.
fn is_browser_context(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "origin" | "referer")
}

fn is_caller_credential(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "x-ryu-user-jwt" | "x-ryu-node-token" | "cookie"
    )
}

/// Return only the app-owned cookies a manifest explicitly opted into.
///
/// Core authentication cookies never cross the process boundary. A sidecar can
/// still use an HttpOnly browser session, but only by declaring the cookie name in
/// its own manifest namespace; unknown names and malformed cookie fragments are
/// discarded before the loopback hop is built.
fn forwarded_cookie_header(
    src: &HeaderMap,
    allowed_cookie_names: &[String],
) -> Option<reqwest::header::HeaderValue> {
    if allowed_cookie_names.is_empty() {
        return None;
    }
    let allowed: HashSet<&str> = allowed_cookie_names.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    let mut pairs = Vec::new();
    for value in src.get_all("cookie").iter() {
        let Ok(raw) = value.to_str() else { continue };
        for fragment in raw.split(';') {
            let pair = fragment.trim();
            let Some((name, _cookie_value)) = pair.split_once('=') else {
                continue;
            };
            let name = name.trim();
            if allowed.contains(name) && seen.insert(name.to_owned()) {
                pairs.push(pair.to_owned());
            }
        }
    }
    if pairs.is_empty() {
        return None;
    }
    reqwest::header::HeaderValue::from_str(&pairs.join("; ")).ok()
}

fn copy_headers(
    src: &HeaderMap,
    dst: &mut reqwest::header::HeaderMap,
    allowed_cookie_names: &[String],
) {
    let forwarded_cookie = forwarded_cookie_header(src, allowed_cookie_names);
    for (name, value) in src.iter() {
        if is_hop_by_hop(name.as_str())
            || is_browser_context(name.as_str())
            || is_caller_credential(name.as_str())
            || name
                .as_str()
                .eq_ignore_ascii_case(HDR_FORWARDED_AUTHORIZATION)
            || name.as_str().eq_ignore_ascii_case(HDR_CALLER_USER_ID)
            || name.as_str().eq_ignore_ascii_case(HDR_CALLER_ORG_ID)
            || name.as_str().eq_ignore_ascii_case(HDR_CALLER_EMAIL)
            || name.as_str().eq_ignore_ascii_case(HDR_CALLER_RESOURCE_IDS)
            || name.as_str().eq_ignore_ascii_case(HDR_CALLER_RATE_SUBJECT)
            || name
                .as_str()
                .eq_ignore_ascii_case(crate::sidecar::deferred_authorization::PRINCIPAL_HEADER)
            || name.as_str().eq_ignore_ascii_case(HDR_CALLER_AGENT_ID)
            || name.as_str().eq_ignore_ascii_case(HDR_CALLER_AGENT_PROOF)
            || name
                .as_str()
                .eq_ignore_ascii_case(crate::sidecar::deferred_authorization::AGENT_GRANT_HEADER)
            || name.as_str().eq_ignore_ascii_case(HDR_WEB_DELEGATION)
            || name.as_str().eq_ignore_ascii_case(HDR_APP_CALLER)
            || name.as_str().eq_ignore_ascii_case(HDR_EVENT_DELIVERY)
        {
            continue;
        }
        if let (Ok(n), Ok(v)) = (
            reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()),
            reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            dst.append(n, v);
        }
    }
    if let Some(cookie) = forwarded_cookie {
        dst.insert(reqwest::header::HeaderName::from_static("cookie"), cookie);
    }
}

/// Preserve an MPP credential only for a manifest-public route. Bearer tokens and
/// every other authorization scheme remain hop-local and are never forwarded.
fn forwarded_payment_authorization(
    headers: &HeaderMap,
    allow: bool,
) -> Option<reqwest::header::HeaderValue> {
    if !allow {
        return None;
    }
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let (scheme, credential) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("Payment") || credential.trim().is_empty() {
        return None;
    }
    reqwest::header::HeaderValue::from_str(value).ok()
}

// ── Inbound proxy (/api/ext/:plugin_id/*rest) ─────────────────────────────────

/// The ext-proxy sub-router. Registered on the PUBLIC router; carries its OWN copy of
/// the node-token `Extension<Option<String>>` (the identical value `require_auth`
/// reads on the protected router) so [`ext_proxy`] replicates the exact node-bearer
/// check — including the `None` (no token configured) ⇒ allow branch — without
/// re-deriving the token by hand (which is how such a check silently drifts).
pub fn ext_routes(auth_token: Option<String>) -> Router<ServerState> {
    Router::new()
        // The bare `/api/ext/:plugin_id` exact route is registered ALONGSIDE the
        // `/*rest` catch-all: axum's `*rest` cannot match an empty tail, so without it
        // the plugin ROOT (a third-party app whose list/create lives at "/") 404s. No
        // trailing-slash form (`/api/ext/:plugin_id/`) — axum panics on it; the bare
        // route forwards sub_path "/", which `upstream_path_for` maps to the bare mount.
        .route("/api/ext/:plugin_id", any(ext_root_proxy))
        .route("/api/ext/:plugin_id/*rest", any(ext_proxy))
        // WebSocket twin of the HTTP ext-proxy: `/api/ext/ws/<plugin>/<route>` upgrades
        // the caller and bridges to the sidecar's declared WS endpoint on loopback. The
        // desktop noVNC stream rides this (the interactive remote-desktop panel); any
        // manifest sidecar can declare a WS route the same way it declares HTTP ones.
        .route("/api/ext/ws/:plugin_id", get(ext_ws_root_proxy))
        .route("/api/ext/ws/:plugin_id/*rest", get(ext_ws_proxy))
        .layer(Extension(auth_token))
}

/// Carried in a per-route `Extension` so a **public-mount** route (whose path does
/// NOT contain the plugin id) can tell [`proxy_for_plugin`] which plugin it fronts.
#[derive(Clone)]
struct PublicMountPlugin(String);

/// Build the **public-mount** sub-router for the built-in manifests in `manifests`.
///
/// A built-in app may own a stable, externally-committed public URL prefix (e.g. mail
/// serves `/api/mail/*`) that cannot live under the generic `/api/ext/<id>/*` catch-all
/// — external callers (a mail forwarder) have the URL baked in. Such a sidecar declares
/// `http.public_mount`; Core registers `<public_mount>/*rest` at router-build time and
/// dispatches it through the SAME [`proxy_for_plugin`] machinery (enabled-gate +
/// per-route auth + declared-route-404 + provider-token hop) as `/api/ext`, keyed by
/// the owning plugin id via [`PublicMountPlugin`].
///
/// Build-time registration is deliberate: axum routers are immutable after serve, so a
/// custom public prefix is expressible for manifests known in the startup snapshot.
/// Runtime-installed apps that arrive after serving still use `/api/ext/<id>/*`.
/// Nothing is hardcoded per-app: this iterates whatever startup manifest declares a
/// `public_mount`.
pub fn public_mount_routes(
    manifests: &[crate::plugin_manifest::PluginManifest],
    auth_token: Option<String>,
) -> Result<Router<ServerState>, String> {
    let mut router = Router::new();
    let mut seen: HashSet<String> = HashSet::new();
    for manifest in manifests {
        for spec in &manifest.sidecars {
            let Some(http) = &spec.http else { continue };
            let Some(mount) = http.public_mount.as_deref() else {
                continue;
            };
            let mount = mount.trim_end_matches('/');
            if mount.is_empty() {
                continue;
            }
            // Guard against two built-ins claiming the same public prefix. Choosing
            // the first owner would silently route one app's auth/ownership policy
            // through another app's public URL.
            if !seen.insert(mount.to_owned()) {
                return Err(format!(
                    "public-mount '{mount}' is claimed by more than one built-in manifest"
                ));
            }
            let plugin = PublicMountPlugin(manifest.id.clone());
            // Register BOTH the wildcard `<mount>/*rest` (sub-paths) AND the bare
            // `<mount>` exact route: axum's `/*rest` requires a non-empty tail, so
            // without the exact route the mount ROOT (a sidecar's declared "/" route,
            // e.g. the teams/recipes list endpoint) 404s. The trailing-slash form
            // `<mount>/` is deliberately NOT registered (axum panics on it). Both
            // routes share the same per-manifest Extension(plugin).
            router = router.merge(
                Router::new()
                    .route(mount, any(public_mount_root_proxy))
                    .route(&format!("{mount}/*rest"), any(public_mount_proxy))
                    .layer(Extension(plugin)),
            );
        }
    }
    Ok(router.layer(Extension(auth_token)))
}

/// Reverse-proxy one `/api/ext/<plugin_id>/<rest>` request to the owning plugin's
/// declared sidecar, verbatim. See the module docs for the auth/route model.
async fn ext_proxy(
    State(state): State<ServerState>,
    Path((plugin_id, rest)): Path<(String, String)>,
    Extension(expected_node_token): Extension<Option<String>>,
    req: Request,
) -> Response {
    let (plugin_id, rest) = split_scoped_plugin_path(plugin_id, rest);
    proxy_for_plugin(
        &state,
        &plugin_id,
        &format!("/{rest}"),
        expected_node_token,
        req,
    )
    .await
}

/// Same as [`ext_proxy`] but for the bare `/api/ext/:plugin_id` root: a separate handler
/// is required because that exact route has no `*rest` wildcard, so `Path<(String,String)>`
/// would fail — only `plugin_id` is extracted and the sub-path is fixed to `/` (the
/// plugin's declared root route).
async fn ext_root_proxy(
    State(state): State<ServerState>,
    Path(plugin_id): Path<String>,
    Extension(expected_node_token): Extension<Option<String>>,
    req: Request,
) -> Response {
    proxy_for_plugin(&state, &plugin_id, "/", expected_node_token, req).await
}

/// Reunite a **scoped** plugin id that the router split across two path segments.
///
/// A scoped id contains a slash (`@ryu/meetings`), and `/api/ext/:plugin_id/*rest`
/// binds `:plugin_id` to ONE segment — so `/api/ext/@ryu/meetings/health` arrives as
/// `plugin_id = "@ryu"`, `rest = "meetings/health"`. This takes the first segment of
/// `rest` back as the name half.
///
/// Keyed on the leading `@`, which is unambiguous: a legacy flat id can never start
/// with one ([`crate::plugin_manifest::validate_plugin_id`] permits `@` only as the
/// scoped marker), so a legacy id keeps its old single-segment routing untouched.
///
/// This is why the id needs no percent-encoding anywhere: the slash inside a scoped
/// id IS a path separator, so it round-trips through a URL as itself. `%2F` would
/// have been the alternative, and reverse proxies routinely normalize it away.
fn split_scoped_plugin_path(plugin_id: String, rest: String) -> (String, String) {
    if !plugin_id.starts_with('@') {
        return (plugin_id, rest);
    }
    match rest.split_once('/') {
        // `@ryu` + `meetings/health` → `@ryu/meetings` + `health`
        Some((name, tail)) => (format!("{plugin_id}/{name}"), tail.to_owned()),
        // `@ryu` + `meetings` → the plugin ROOT of `@ryu/meetings`. `proxy_for_plugin`
        // maps an empty sub-path to the bare mount the same way `ext_root_proxy` does.
        None => (format!("{plugin_id}/{rest}"), String::new()),
    }
}

/// The public-mount handler: same job as [`ext_proxy`], but the plugin id comes from
/// the per-route [`PublicMountPlugin`] extension (the path is `<mount>/*rest`, not
/// `/api/ext/:id/*`), and the sub-path is the wildcard tail.
async fn public_mount_proxy(
    State(state): State<ServerState>,
    Extension(PublicMountPlugin(plugin_id)): Extension<PublicMountPlugin>,
    Extension(expected_node_token): Extension<Option<String>>,
    Path(rest): Path<String>,
    req: Request,
) -> Response {
    proxy_for_plugin(
        &state,
        &plugin_id,
        &format!("/{rest}"),
        expected_node_token,
        req,
    )
    .await
}

/// Same as [`public_mount_proxy`] but for the bare `<mount>` root: a separate handler
/// is required because that exact route has no `*rest` wildcard, so a `Path` extractor
/// would fail — the sub-path is fixed to `/` (the sidecar's declared root route).
async fn public_mount_root_proxy(
    State(state): State<ServerState>,
    Extension(PublicMountPlugin(plugin_id)): Extension<PublicMountPlugin>,
    Extension(expected_node_token): Extension<Option<String>>,
    req: Request,
) -> Response {
    proxy_for_plugin(&state, &plugin_id, "/", expected_node_token, req).await
}

/// The upstream path a proxied request forwards to. Root special-case: sidecars
/// nest their routers at the bare mount and axum does no trailing-slash redirect,
/// so `{mount}/` would 404 upstream — the declared "/" route resolves as usual but
/// forwards to the bare mount (both the public-mount root and `/api/ext/:id/` with
/// an empty tail produce a "/" sub-path).
fn upstream_path_for(mount: &str, sub_path: &str) -> String {
    if sub_path == "/" {
        mount.to_owned()
    } else {
        format!("{mount}{sub_path}")
    }
}

// ── Web-delegated admission ───────────────────────────────────────────────────

/// The facts [`web_delegated_admission`] needs from the manifest snapshot, captured
/// while [`proxy_for_plugin`] still holds the manifest guard (the gate itself runs
/// after the guard is dropped, so it never nests a second read of the same lock).
#[derive(Debug, Clone, PartialEq, Eq)]
struct WebDelegationFacts {
    /// Whether the matched route declares a per-route `permission`.
    route_declares_permission: bool,
    /// Whether the TARGET app strictly supports the web surface.
    target_supports_web: bool,
    /// The named calling app, when the header held a valid id of an installed app.
    caller_app: Option<WebCallerApp>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WebCallerApp {
    id: String,
    supports_web: bool,
    has_companion: bool,
}

/// Whether `manifest` declares the web surface at `full` or `limited`.
///
/// Deliberately NOT [`crate::plugin_manifest::PluginManifest::supports_surface`]: that
/// reads an absent `surfaces` map with empty legacy `targets` as "every surface" and an
/// unknown support level as supported, which is the right listing default but the wrong
/// answer for a credential-bearing web hop. Here an absent map, an absent key, and every
/// other level fail closed.
fn strictly_supports_web(manifest: &crate::plugin_manifest::PluginManifest) -> bool {
    use crate::plugin_manifest::{Surface, SurfaceSupport};
    let Some(entry) = manifest
        .surfaces
        .as_ref()
        .and_then(|surfaces| surfaces.get(&Surface::Web))
    else {
        return false;
    };
    match entry.support {
        SurfaceSupport::Full | SurfaceSupport::Limited => true,
        SurfaceSupport::List
        | SurfaceSupport::Commands
        | SurfaceSupport::None
        | SurfaceSupport::Unknown => false,
    }
}

/// Capture the web-delegation facts for `target` from the manifest snapshot.
fn web_delegation_facts(
    manifests: &[crate::plugin_manifest::PluginManifest],
    target: &crate::plugin_manifest::PluginManifest,
    route_declares_permission: bool,
    headers: &HeaderMap,
) -> WebDelegationFacts {
    let caller_app = headers
        .get(HDR_APP_CALLER)
        .and_then(|value| value.to_str().ok())
        .filter(|id| crate::plugin_manifest::validate_plugin_id(id).is_ok())
        .and_then(|id| manifests.iter().find(|manifest| manifest.id == id))
        .map(|manifest| WebCallerApp {
            id: manifest.id.clone(),
            supports_web: strictly_supports_web(manifest),
            has_companion: manifest
                .runnables
                .iter()
                .any(|entry| entry.kind == crate::runnable::RunnableKind::Companion),
        });
    WebDelegationFacts {
        route_declares_permission,
        target_supports_web: strictly_supports_web(target),
        caller_app,
    }
}

/// The manifest half of the web-delegated gate. Every refusal is a 404, the same
/// answer as an undeclared route or a disabled app, so a web caller cannot enumerate
/// which routes exist but are not web-reachable.
fn web_delegated_route_gate(facts: &WebDelegationFacts) -> Result<&WebCallerApp, StatusCode> {
    if !(facts.route_declares_permission && facts.target_supports_web) {
        return Err(StatusCode::NOT_FOUND);
    }
    let caller_app = facts.caller_app.as_ref().ok_or(StatusCode::NOT_FOUND)?;
    if !(caller_app.supports_web && caller_app.has_companion) {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(caller_app)
}

/// The one reviewed grant edge a web-delegated request rides: `app:http` for the
/// calling app's own sidecar, or exactly `app:http:<target>` for another app's.
fn web_caller_required_grant(caller_app: &str, target: &str) -> String {
    if caller_app == target {
        APP_HTTP_GRANT.to_owned()
    } else {
        format!("{APP_HTTP_GRANT}:{target}")
    }
}

/// The named calling app must be enabled and hold the exact grant edge in its CURRENT
/// approved set (approved AND still declared by its manifest), never the manifest claim.
async fn web_caller_app_admitted(
    state: &ServerState,
    caller_app: &str,
    target: &str,
) -> Result<(), StatusCode> {
    let record = match state.app_store.get(caller_app).await {
        Ok(Some(record)) if record.enabled => record,
        Ok(_) => return Err(StatusCode::NOT_FOUND),
        Err(e) => {
            tracing::warn!("ext proxy: app_store lookup for caller app '{caller_app}' failed: {e}");
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };
    let approved =
        crate::plugin_host::current_approved_grants(state, caller_app, &record.approved_grants)
            .await;
    if approved.contains(&web_caller_required_grant(caller_app, target)) {
        Ok(())
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}

/// Admission for a request the web tier forwarded for a browser ([`HDR_WEB_DELEGATION`]).
///
/// The web tier reaches Core with the server-held node token, which on its own reads as
/// the node owner, so the boundary has to live here where the caller and the grants are
/// known. Runs before the per-route permission check, the registration/wake gate and the
/// body buffer, so a refused web caller can neither wake a sidecar nor push a body.
async fn web_delegated_admission(
    state: &ServerState,
    target: &str,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    facts: &WebDelegationFacts,
) -> Result<(), StatusCode> {
    let Some(user) = caller.as_ref() else {
        return Err(StatusCode::FORBIDDEN);
    };
    // A shared web portal must never inherit the unbound-node owner semantics.
    crate::server::web_delegated_candidate(caller)?;
    let caller_app = web_delegated_route_gate(facts)?;
    web_caller_app_admitted(state, &caller_app.id, target).await?;
    tracing::info!(
        plugin = %target,
        caller_app = %caller_app.id,
        user_id = %user.user_id,
        "ext proxy: admitted a web-delegated request"
    );
    Ok(())
}

/// The shared reverse-proxy core: enabled-gate → resolve the declared route
/// (undeclared ⇒ 404) → per-route auth → forward to the sidecar with the plugin's
/// minted token. Used by BOTH the `/api/ext/:id/*` catch-all and the build-time
/// public-mount routes, so the two lanes can never drift on the security-critical
/// gates.
async fn proxy_for_plugin(
    state: &ServerState,
    plugin_id: &str,
    sub_path: &str,
    _startup_node_token: Option<String>,
    req: Request,
) -> Response {
    let request_method = req.method().as_str().to_owned();
    // Enabled gate (secrecy: a disabled/absent plugin's proxied surface must not exist).
    match state.app_store.get(plugin_id).await {
        Ok(Some(rec)) if rec.enabled => {}
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            tracing::warn!("ext proxy: app_store lookup for '{plugin_id}' failed: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    // Resolve the manifest → sidecar spec + matched route (undeclared path ⇒ 404).
    let manifests = state.app_manifests.read().await;
    let Some(manifest) = manifests.iter().find(|m| m.id == plugin_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // The forward below appends `?<query>` exactly when the request carries one.
    if forward_url_trims_path_end(sub_path, req.uri().query()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some((spec, http, route)) = resolve_route(manifest, sub_path, &request_method) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let auth = route.auth;
    if public_route_raw_path_is_unsafe(auth, req.uri().path()) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    // Resolved while the manifest guard is still held, since the gate below runs
    // after it is dropped.
    let required = required_permission_for(route, sub_path, plugin_id);
    // Only a web-delegated request pays for (or is affected by) these facts.
    let web_facts = req
        .headers()
        .contains_key(HDR_WEB_DELEGATION)
        .then(|| web_delegation_facts(&manifests, manifest, required.is_some(), req.headers()));
    let caller_agent_id = match verified_agent_lane(&req, plugin_id) {
        Ok(value) => value,
        Err(response) => return response,
    };
    // Only an agent whose account access is restricted needs the app's
    // provider calls tied to its grant; an unrestricted one may use every
    // account the user's own (grant-less) calls use. A store error counts as
    // restricted.
    let caller_agent_restricted = match caller_agent_id.as_deref() {
        Some(agent_id) => {
            crate::agent_access::account_confinement_for_agent(&state.agent_store, agent_id)
                .await
                .is_confined()
        }
        None => false,
    };
    let caller = crate::server::verified_caller_from_headers(req.headers()).await;
    if crate::sidecar::control_plane::is_managed_node()
        && matches!(
            plugin_id,
            "@ryu/docling" | "@ryu/markitdown" | "@ryu/mineru" | "@ryu/unstructured"
        )
    {
        return (
            StatusCode::FORBIDDEN,
            "document sidecar jobs require per-job tenant binding on managed nodes",
        )
            .into_response();
    }
    // NOTE: the manifest supplies mount, routes, auth, permission and max_body_bytes —
    // everything EXCEPT the port. The port comes from the manager's claim registry
    // (`forward_target`, below), never from `spec.port`: see [`ForwardTarget`] for why
    // those two facts must not be allowed to disagree at a hop.
    let mount = http
        .mount
        .as_deref()
        .map(|m| m.trim_end_matches('/').to_owned())
        .unwrap_or_default();
    let max_body = http.max_body_bytes.unwrap_or(DEFAULT_MAX_PROXY_BYTES);
    let forward_cookie_names = http.forward_cookie_names.clone();
    let forward_caller_email = http.forward_caller_email;
    let forward_caller_rate_subject = http.forward_caller_rate_subject;
    let caller_resource_scope = http.caller_resource_scope.clone();
    // The manager key for this sidecar.
    let sidecar_name = crate::sidecar::manifest_sidecar::namespaced_name(plugin_id, &spec.name);
    drop(manifests);
    // Whether this sidecar opted into on-demand start — resolved from the manager's
    // registered state (lazy-registered, or carrying an idle-stop timeout so it may
    // have been scaled to zero), the single source of truth the reaper also uses.
    let wake_eligible = state.manager.is_wake_eligible(&sidecar_name);

    // Per-route auth: a Protected route requires the node bearer, checked exactly as
    // `require_auth` does (None ⇒ allow, for loopback dev with no token configured).
    if auth == RouteAuth::Protected {
        let active_node_token = crate::node_token::active_token();
        if let Some(expected) = active_node_token.as_deref() {
            let provided = req
                .headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "));
            if provided
                .as_deref()
                .is_none_or(|candidate| !crate::server::ct_eq(candidate, expected))
            {
                return StatusCode::UNAUTHORIZED.into_response();
            }
        }
    }

    // A request the web tier forwarded for a browser carries the node token, so on its
    // own it would read as the owner. Narrow it to a verified member of a bound node, a
    // permission-annotated route, and a reviewed grant edge of a web-capable Companion
    // app. A request without the marker skips this entirely, byte for byte as before.
    if let Some(facts) = web_facts.as_ref() {
        if let Err(status) = web_delegated_admission(state, plugin_id, &caller, facts).await {
            return status.into_response();
        }
    }

    // App-declared per-route permission. Manifest data, because only the app knows
    // which of its routes are destructive; enforced HERE, because only Core knows who
    // the caller is (the sidecar sees Core's minted hop token, never a human).
    //
    // Runs through the SAME `enforce_permission_on` the kernel's own per-resource
    // routes use, deliberately not a copy: the anonymous/org rules a personal node
    // depends on (anonymous + unbound node ⇒ allowed) are exactly the rules that must
    // not fork, and a second implementation is how they silently would.
    //
    // A route the app did not annotate never reaches this branch — no permission
    // lookup, no JWT verification, no behaviour change for any app shipping today.
    if let Some((permission, resource_id)) = required {
        // The plugin id is the resource KIND, so an app's resource ids live in their
        // own keyspace and can never be confused with the kernel's (`space:abc`) or
        // another app's.
        if let Err(status) = crate::server::enforce_permission_on(
            state,
            &caller,
            &permission,
            plugin_id,
            &resource_id,
        )
        .await
        {
            return status.into_response();
        }
    }

    let caller_resource_ids = match caller_resource_scope.as_deref() {
        None => None,
        Some("conversation") => {
            let (user_id, org_id, team_ids_json, node_bound) =
                crate::server::tenancy_filter_args(&caller);
            // Ids and source versions only (no summary decryption), newest first,
            // so the bounded header below keeps the caller's most recently active
            // conversations. Each entry is `<version>:<id>`: the version changes
            // when a conversation is deleted and another is created under the same
            // id, so the sidecar never serves the old one's derived data to it.
            let visible = state
                .conversations
                .visible_conversation_versions_for_teams(
                    user_id.as_deref(),
                    org_id.as_deref(),
                    node_bound,
                    team_ids_json.as_deref(),
                )
                .await;
            let visible = match visible {
                Ok(visible) => visible,
                Err(error) => {
                    tracing::warn!(%error, "ext proxy: caller resource scope lookup failed");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            };
            let entries: Vec<String> = visible
                .iter()
                .map(|(id, version)| format!("{version}:{id}"))
                .collect();
            let (encoded, omitted) = encode_caller_resource_ids(
                entries.iter().map(String::as_str),
                MAX_CALLER_RESOURCE_IDS_BYTES,
            );
            if omitted > 0 {
                tracing::warn!(
                    plugin_id,
                    omitted,
                    "ext proxy: caller resource scope truncated to the most recently updated resources"
                );
            }
            Some(encoded)
        }
        Some(_) => return StatusCode::FORBIDDEN.into_response(),
    };

    // ── Registration gate + wake-on-demand ────────────────────────────────────
    //
    // STRICTLY AFTER the auth and permission checks above, so neither an
    // unauthenticated nor an unauthorized caller can spin a process (both also
    // short-circuit before the body is buffered, so a refused caller cannot push
    // `max_body_bytes` through Core either).
    //
    // The gate: the ONLY port we will ever dial is one the manager holds a live claim
    // on for this sidecar. Before this existed, the proxy dialed `profile::port(spec.port)`
    // unconditionally — so a sidecar whose `claim_port` was REFUSED (an unrelated host
    // process already listening on the declared port; very plausible in the dev profile's
    // +1000 band) had Core deliver authenticated requests, full bodies, cookies and the
    // plugin's minted `RYU_EXT_TOKEN` straight to that foreign process, while the app
    // merely looked broken. `is_wake_eligible` did NOT cover this: `lazy_registered` is
    // populated only AFTER a successful claim, so a failed-claim LAZY sidecar reads as
    // not-wake-eligible and fell through to the same blind forward as an eager one.
    //
    // Registration and running-ness are two different questions, which is why the arms
    // below are not one flat check: `register()` claims the port and inserts into the
    // registry WITHOUT starting the process, so "registered, claim held, not running" is
    // the normal resting state of a lazy sidecar and must still wake. Only "never
    // registered" is a refusal, and it must never wake — `wake_sidecar` would error
    // "unknown sidecar" anyway, and forwarding is the vulnerability itself.
    let mut target = match state.manager.forward_target(&sidecar_name) {
        Ok(t) => Some(t),
        // Never registered ⇒ refuse without dialing anything. 503 (not 502): 502 in this
        // file means "we dialed upstream and it failed"; 503 means "we never dialed".
        Err(denied @ ForwardDenied::NotRegistered { .. }) => return sidecar_unavailable(&denied),
        // Registered but down. Wake-eligible ⇒ the pre-existing wake path, byte-identical.
        Err(denied @ ForwardDenied::NotRunning { .. }) => {
            if !wake_eligible {
                // Eager sidecar mid-download or crash-looping. It used to forward blind
                // into whatever holds its port; now it is a clean, named 503.
                return sidecar_unavailable(&denied);
            }
            None
        }
    };

    // The `_activity` guard pins the sidecar alive + feeds its idle clock while Core sets
    // up the forward, making idle-stop real for manifest sidecars. Keyed on
    // `wake_eligible` — NOT on which arm above we took — because a WARM lazy/idle-stop
    // sidecar (the `Ok` arm) needs the guard just as much as a cold one, or the idle
    // reaper can stop it mid-request. NOTE: `forward_to_sidecar` returns the response at
    // HEADER-arrival (its body streams), so this guard drops when headers land, not at
    // body-end. That is fine today because every SSE-serving sidecar
    // (dashboards/meetings/quests/monitors) is EAGER, so `wake_eligible` is false here and
    // the guard is `None`. A future lazy/idle-stop sidecar that serves a long-lived stream
    // would need this guard moved INTO the response `Body` so the idle reaper cannot kill
    // it mid-stream.
    let _activity = if wake_eligible {
        if target.is_none() {
            match state
                .manager
                .wake_and_await_healthy(&sidecar_name, WAKE_WARMUP_TIMEOUT)
                .await
            {
                Ok(woke) => {
                    if woke {
                        // Cold-start edge: register any `onRoute`-gated Runnables.
                        fire_lazy_activation(state, ACTIVATION_ON_ROUTE);
                    }
                }
                Err(e) => return wake_failed_response("ext proxy", &sidecar_name, &e, false),
            }
            // Re-resolve rather than trusting the wake's return: a wake that reports
            // success but leaves the process down must 503, never fall back to a blind
            // forward at the declared port.
            target = match state.manager.forward_target(&sidecar_name) {
                Ok(t) => Some(t),
                Err(denied) => return sidecar_unavailable(&denied),
            };
        }
        Some(state.manager.enter_request(&sidecar_name))
    } else {
        None
    };

    let Some(target) = target else {
        // Unreachable: every arm above either set `target` or returned. Belt-and-braces
        // so a future edit that adds an arm fails closed rather than dialing blind.
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "sidecar unavailable, retry shortly",
        )
            .into_response();
    };

    let caller_rate_subject = forward_caller_rate_subject
        .then(|| rate_subject_for(plugin_id, caller.as_ref(), request_client_ip(&req)));
    let (parts, body) = req.into_parts();
    let body_bytes = match axum::body::to_bytes(body, max_body).await {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                "ext proxy: request body too large",
            )
                .into_response();
        }
    };

    let query = parts
        .uri
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let upstream_path = upstream_path_for(&mount, sub_path);

    let mut response = forward_to_sidecar(ForwardArgs {
        target,
        upstream_path: &upstream_path,
        query: &query,
        method: parts.method,
        src_headers: &parts.headers,
        body: body_bytes.to_vec(),
        hop_plugin_id: plugin_id,
        forward_payment_authorization: auth == RouteAuth::Public,
        forward_cookie_names: &forward_cookie_names,
        forward_caller_email,
        caller: caller.as_ref(),
        caller_resource_ids: caller_resource_ids.as_deref(),
        caller_rate_subject: caller_rate_subject.as_deref(),
        caller_agent_id: caller_agent_id.as_deref(),
        caller_agent_restricted,
        event_delivery: None,
    })
    .await;
    if web_facts.is_some() {
        mark_web_delegation_admitted(&mut response);
    }
    response
}

/// The echo [`mark_web_delegation_admitted`] stamps on a web-delegated forward.
const WEB_DELEGATION_ADMITTED: &str = "admitted";

/// Tell the web tier this node ran [`web_delegated_admission`] for the request. The
/// web tier forwards only after `GET /api/version` advertised
/// [`crate::update::FEATURE_WEB_DELEGATED_EXT`]; this echo is its second check, and
/// any response without it is withheld. Overwrites a value the sidecar may have sent.
fn mark_web_delegation_admitted(response: &mut Response) {
    response.headers_mut().insert(
        HDR_WEB_DELEGATION,
        axum::http::HeaderValue::from_static(WEB_DELEGATION_ADMITTED),
    );
}

/// The refusal every "I never dialed" path in this file returns: **503**, naming the
/// sidecar key, the port and the reason.
///
/// The 502/503 split is the file's discriminator and is load-bearing for whoever reads
/// the log: 502 (in [`forward_to_sidecar`]) means Core dialed a sidecar it legitimately
/// owns and the hop failed; 503 means Core refused to dial at all because it does not own
/// that port. Naming the port is deliberate — the apps-store manifests publish them
/// already, so there is nothing to redact, and without it the operator cannot tell which
/// port to free. The durable half of the diagnosis (why registration failed, visible even
/// with no request in flight) rides `/api/sidecar/status` as `failure_reason`.
fn sidecar_unavailable(denied: &ForwardDenied) -> Response {
    let name = denied.name();
    let reason = denied.reason();
    tracing::warn!(sidecar = %name, port = ?denied.port(), "ext proxy refused to forward: {reason}");
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({
            "error": "sidecar unavailable",
            "sidecar": name,
            "port": denied.port(),
            "reason": reason,
        })),
    )
        .into_response()
}

/// Inputs to [`forward_to_sidecar`]. Grouped in a struct so the shared forwarder is
/// not an 8-argument function (both the inbound ext-proxy and the capability broker
/// call it).
struct ForwardArgs<'a> {
    /// Proof that the manager registered this sidecar, still holds its port claim, and
    /// the owning process is alive — carrying the port to dial. NOT a bare `u16` on
    /// purpose: the only way to build one is [`crate::sidecar::SidecarManager::forward_target`]
    /// (outside `#[cfg(test)]`), so no caller can forward to a manifest-derived port that
    /// some *other* process on the host happens to be squatting on. See [`ForwardTarget`].
    target: ForwardTarget,
    /// The full upstream path on the sidecar (mount + sub-path, no query).
    upstream_path: &'a str,
    /// The query string including the leading `?`, or empty.
    query: &'a str,
    /// The forwarded HTTP method.
    method: reqwest::Method,
    /// The caller's headers (hop-by-hop stripped, bearer re-stamped).
    src_headers: &'a HeaderMap,
    /// The request body to forward verbatim.
    body: Vec<u8>,
    /// The plugin id whose minted [`ext_token`] is stamped as the upstream bearer —
    /// for the inbound proxy this is the target plugin; for the broker it is the
    /// PROVIDER (so the consumer never sees the provider's token).
    hop_plugin_id: &'a str,
    /// Whether a caller-supplied `Authorization: Payment` credential may cross this
    /// hop in the reserved internal header. Enabled only for manifest-public routes.
    forward_payment_authorization: bool,
    /// App-owned browser cookie names explicitly declared by the manifest. Core
    /// forwards only these names; all other cookies remain hop-local.
    forward_cookie_names: &'a [String],
    /// Whether the manifest opted this sidecar into the verified caller email
    /// ([`HttpProxySpec::forward_caller_email`]). Only an address the token marks
    /// `email_verified` is stamped; caller-supplied copies of the header are
    /// stripped for every sidecar regardless.
    forward_caller_email: bool,
    /// Verified human identity, if Core resolved one. Caller-controlled copies
    /// of the corresponding headers are stripped before this is stamped.
    caller: Option<&'a crate::identity_verify::VerifiedCaller>,
    /// Current ids in the manifest-requested resource scope. This value is
    /// derived by Core after authenticating the caller and replaces any inbound
    /// header with the same name.
    caller_resource_ids: Option<&'a str>,
    /// Pseudonymous per-client rate subject ([`rate_subject_for`]), for a
    /// sidecar that opted in. Replaces any inbound header with the same name.
    caller_rate_subject: Option<&'a str>,
    /// Core-verified calling agent (see [`verified_agent_lane`]). Caller-controlled
    /// lane and grant headers are stripped before this value and its agent grant
    /// are stamped.
    caller_agent_id: Option<&'a str>,
    /// Whether `caller_agent_id`'s account access is restricted (or could not
    /// be read). Only then does the forward open the agent-request context in
    /// which the app's grant-less `providers.call`s are refused.
    caller_agent_restricted: bool,
    /// The delivery id of a Core event delivery, stamped as [`HDR_EVENT_DELIVERY`]
    /// (any caller-supplied copy is stripped first). `None` on every other hop.
    event_delivery: Option<&'a str>,
}

/// The pseudonymous rate subject Core stamps as [`HDR_CALLER_RATE_SUBJECT`]:
///
/// - `user:<24 hex>` for a verified caller (their user id);
/// - `peer:<24 hex>` for an anonymous caller, from the client address Core
///   resolved (the socket peer, or `X-Forwarded-For` only behind a configured
///   trusted proxy). IPv6 addresses are reduced to their /64 prefix, which one
///   client typically controls whole;
/// - `unknown` when Core cannot tell clients apart: no connect info, a loopback
///   peer behind the forwarding tunnel, or a resolved address that is not a
///   plausible end-client address ([`is_shared_or_local_address`]). The last
///   case is a reverse proxy on the same host or network that Core was not told
///   to trust (nginx, Caddy or a user-run tunnel on loopback, a LAN proxy): every
///   visitor would arrive from that one address, so a per-client bucket keyed on
///   it would let one visitor exhaust the bound for all of them.
///
/// Each hash is `SHA-256` over a domain tag, the plugin id and the value, so two
/// apps cannot correlate one visitor and no app receives the raw address.
fn rate_subject_for(
    plugin_id: &str,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    client_ip: Option<std::net::IpAddr>,
) -> String {
    let (kind, value) = if let Some(caller) = caller {
        ("user", caller.user_id.clone())
    } else if let Some(ip) = client_ip
        .map(|ip| ip.to_canonical())
        .filter(|ip| !is_shared_or_local_address(*ip))
    {
        let network = match ip {
            std::net::IpAddr::V4(v4) => v4.to_string(),
            std::net::IpAddr::V6(v6) => {
                let segments = v6.segments();
                format!(
                    "{:x}:{:x}:{:x}:{:x}::/64",
                    segments[0], segments[1], segments[2], segments[3]
                )
            }
        };
        ("peer", network)
    } else {
        return "unknown".to_owned();
    };
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"ryu-caller-rate-subject-v1\0");
    hasher.update(plugin_id.as_bytes());
    hasher.update([0]);
    hasher.update(kind.as_bytes());
    hasher.update([0]);
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    format!("{kind}:{}", hex::encode(&digest[..12]))
}

/// Whether `ip` is a loopback, unspecified, private (RFC 1918 / ULA),
/// link-local, shared carrier-grade NAT (RFC 6598) or broadcast address. Such an
/// address is not a distinct public client: it is Core's own host, a proxy on the
/// same host or network, or a NAT that many clients share. `ip` must already be
/// canonical (IPv4-mapped IPv6 unwrapped).
fn is_shared_or_local_address(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let [first, second, ..] = v4.octets();
            v4.is_loopback()
                || v4.is_unspecified()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                // 100.64.0.0/10, shared address space for carrier-grade NAT.
                || (first == 100 && (second & 0b1100_0000) == 64)
        }
        std::net::IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                // fc00::/7, unique local addresses.
                || (first & 0xfe00) == 0xfc00
                // fe80::/10, link-local unicast.
                || (first & 0xffc0) == 0xfe80
        }
    }
}

/// The client address of an inbound proxy request, resolved the same way the
/// vault's CIDR binding does ([`crate::vault::tokens::resolve_client_ip`]).
fn request_client_ip(req: &Request) -> Option<std::net::IpAddr> {
    let peer = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip());
    let forwarded = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok());
    crate::vault::tokens::resolve_client_ip(
        peer,
        forwarded,
        &crate::vault::tokens::trusted_proxies(),
        crate::sidecar::forwarding_tunnel_active(),
    )
}

/// Upper bound for the `x-ryu-caller-resource-ids` header. Sized well inside the
/// default HTTP/1 header buffer of a hyper/axum sidecar (~408 KiB) while holding
/// several thousand UUID conversation ids.
const MAX_CALLER_RESOURCE_IDS_BYTES: usize = 256 * 1024;

/// Encode the caller's authorized resource ids as a JSON array no longer than
/// `max_bytes`. `ids` must arrive in priority order (newest first): when the full
/// set does not fit, the tail is dropped and its length is returned, so the
/// sidecar sees FEWER ids than the caller may read, never more. Fails closed
/// without refusing every request of a caller who can see many resources.
fn encode_caller_resource_ids<'a>(
    ids: impl Iterator<Item = &'a str>,
    max_bytes: usize,
) -> (String, usize) {
    let mut encoded = String::from("[");
    let mut omitted = 0usize;
    for id in ids {
        if omitted > 0 {
            omitted += 1;
            continue;
        }
        let quoted = ascii_json_string(id);
        let separator = usize::from(encoded.len() > 1);
        // +1 for the closing bracket.
        if encoded.len() + separator + quoted.len() + 1 > max_bytes {
            omitted += 1;
            continue;
        }
        if separator == 1 {
            encoded.push(',');
        }
        encoded.push_str(&quoted);
    }
    encoded.push(']');
    (encoded, omitted)
}

/// A JSON string literal that is pure printable ASCII, so it is always a valid
/// header value: control and non-ASCII characters become `\uXXXX` escapes
/// (surrogate pairs above the BMP), which any JSON parser decodes back exactly.
fn ascii_json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            ' '..='~' => out.push(character),
            _ => {
                let mut units = [0u16; 2];
                for unit in character.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
        }
    }
    out.push('"');
    out
}

/// Reuse connection pools across proxy hops; credentials stay on each request.
fn proxy_http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(PROXY_CONNECT_TIMEOUT)
            .pool_max_idle_per_host(8)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Forward one buffered request to a sidecar on loopback, re-stamping the hop
/// plugin's minted token, and translate the upstream response back. The single
/// place the Core→sidecar hop is performed — shared by [`ext_proxy`] and the
/// capability broker so their auth/token/hop-header handling can never drift.
async fn forward_to_sidecar(args: ForwardArgs<'_>) -> Response {
    let ForwardArgs {
        target,
        upstream_path,
        query,
        method,
        src_headers,
        body,
        hop_plugin_id,
        forward_payment_authorization,
        forward_cookie_names,
        forward_caller_email,
        caller,
        caller_resource_ids,
        caller_rate_subject,
        caller_agent_id,
        caller_agent_restricted,
        event_delivery,
    } = args;

    let hop_token = ext_token(node_token().as_deref(), hop_plugin_id);
    let port = target.port();
    let target = format!("http://127.0.0.1:{port}{upstream_path}{query}");

    // Connect-timeout only — NO total-request timeout: the response body may be a
    // long-lived SSE stream that never completes (see [`PROXY_CONNECT_TIMEOUT`]).
    let client = proxy_http_client();
    let mut headers = reqwest::header::HeaderMap::new();
    let payment_authorization =
        forwarded_payment_authorization(src_headers, forward_payment_authorization);
    copy_headers(src_headers, &mut headers, forward_cookie_names);
    if let Some(proof) = crate::sidecar::deferred_authorization::principal_proof(
        hop_plugin_id,
        caller,
        src_headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer ")),
    ) {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&proof) {
            headers.insert(
                crate::sidecar::deferred_authorization::PRINCIPAL_HEADER,
                value,
            );
        }
    }
    if let Some(caller) = caller {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&caller.user_id) {
            headers.insert(HDR_CALLER_USER_ID, value);
        }
        if let Some(org_id) = caller.org_id.as_deref() {
            if let Ok(value) = reqwest::header::HeaderValue::from_str(org_id) {
                headers.insert(HDR_CALLER_ORG_ID, value);
            }
        }
        // An unverified address is the identity provider's claim, not proof of
        // mailbox ownership, so it never reaches a sidecar that grants access by
        // email. No header is safer than an unverified one.
        if let Some(email) = caller.verified_email().filter(|_| forward_caller_email) {
            if let Ok(value) = reqwest::header::HeaderValue::from_str(email) {
                headers.insert(HDR_CALLER_EMAIL, value);
            }
        }
    }
    if let Some(resource_ids) = caller_resource_ids {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(resource_ids) {
            headers.insert(HDR_CALLER_RESOURCE_IDS, value);
        } else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }
    if let Some(subject) = caller_rate_subject {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(subject) {
            headers.insert(HDR_CALLER_RATE_SUBJECT, value);
        }
    }
    // While the app serves a restricted agent's request, its `providers.call`s
    // must carry that agent's grant; one without it is refused rather than run
    // with the user's accounts. Held until the response body ends. An
    // unrestricted agent may use every account a grant-less call uses, so its
    // requests do not hold up the app's other work.
    let agent_context = caller_agent_id
        .filter(|_| caller_agent_restricted)
        .map(|_| crate::sidecar::deferred_authorization::enter_agent_request(hop_plugin_id));
    if let Some(agent_id) = caller_agent_id {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(agent_id) {
            headers.insert(HDR_CALLER_AGENT_ID, value);
        }
        // The app hands this back on `providers.call` (also for work it defers),
        // so Core can apply the agent's account access there.
        if let Some(value) =
            crate::sidecar::deferred_authorization::agent_grant(hop_plugin_id, agent_id)
                .and_then(|grant| reqwest::header::HeaderValue::from_str(&grant).ok())
        {
            headers.insert(
                crate::sidecar::deferred_authorization::AGENT_GRANT_HEADER,
                value,
            );
        }
    }
    if let Some(delivery_id) = event_delivery {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(delivery_id) {
            headers.insert(HDR_EVENT_DELIVERY, value);
        }
    }
    if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {hop_token}")) {
        headers.insert(reqwest::header::AUTHORIZATION, val);
    }
    if let Some(value) = payment_authorization {
        headers.insert(HDR_FORWARDED_AUTHORIZATION, value);
    }

    let upstream = client
        .request(method, &target)
        .headers(headers)
        .body(body)
        .send()
        .await;

    let resp = match upstream {
        Ok(r) => r,
        Err(e) => {
            // A dead/absent sidecar 502s on ITS OWN route only — Core is never blocked.
            tracing::warn!("sidecar for '{hop_plugin_id}' unreachable at {target}: {e}");
            return (StatusCode::BAD_GATEWAY, "sidecar unreachable").into_response();
        }
    };

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut out = HeaderMap::new();
    for (name, value) in resp.headers().iter() {
        if is_hop_by_hop(name.as_str())
            || name
                .as_str()
                .eq_ignore_ascii_case(HDR_FORWARDED_AUTHORIZATION)
        {
            continue;
        }
        if let (Ok(n), Ok(v)) = (
            axum::http::HeaderName::from_bytes(name.as_str().as_bytes()),
            axum::http::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            out.append(n, v);
        }
    }
    // Stream the upstream body straight through rather than buffering it. An SSE
    // endpoint's body never ends, so the old `resp.bytes().await` held back ALL response
    // headers until the whole body arrived — i.e. forever — which is why the SSE feeds
    // (dashboards `/events`, meetings `/stream`, quests/monitors events) hung with no
    // response headers. `bytes_stream()` → `Body::from_stream` emits status + headers
    // immediately and pipes each chunk as it lands. The response is streamed UNBOUNDED
    // (matching the old unbounded `resp.bytes()` — there was never a response-size cap to
    // preserve); only the REQUEST body stays capped (`to_bytes(body, max_body)`).
    // content-length + transfer-encoding are stripped as hop-by-hop above, so hyper
    // re-frames the outgoing stream itself.
    let body = match agent_context {
        Some(context) => {
            use futures_util::StreamExt as _;
            Body::from_stream(resp.bytes_stream().map(move |chunk| {
                let _held_until_the_body_ends = &context;
                chunk
            }))
        }
        None => Body::from_stream(resp.bytes_stream()),
    };
    (status, out, body).into_response()
}

// ── WebSocket tunnel (/api/ext/ws/*) ──────────────────────────────────────────
//
// The HTTP ext-proxy (`reqwest`) cannot carry a WebSocket upgrade, so an interactive
// sidecar stream — the desktop's live noVNC remote-desktop feed — needs its own lane.
// This is that lane: it shares the SAME route-allowlist + auth model as the HTTP
// proxy (a sidecar declares a `ws` route the same way it declares HTTP ones), then
// bridges the caller's socket to the sidecar's loopback WS endpoint byte-for-byte.
//
// Transport rationale: noVNC speaks RFB over WebSocket, and the remote node (managed
// cloud / self-hosted) exposes only Core's port, so the stream MUST ride through Core
// rather than the sidecar's loopback port. Bridging WS→WS at Core keeps every app
// (the `@ryu/desktop` sidecar) a self-contained satellite: Core is a dumb pipe that
// knows nothing about VNC, exactly like the HTTP lane.

/// Query param carrying the opaque one-use ticket minted by Core's HTTP issuer.
/// Node and user credentials are deliberately rejected on this WebSocket lane.
const WS_TICKET_PARAM: &str = "ticket";

/// The tungstenite message type used by the WS tunnel's upstream hop. Aliased once
/// at module scope so both the bridge and the two converters name the same type.
type TsMessage = tokio_tungstenite::tungstenite::Message;

/// The upstream path a WS tunnel forwards to (same mount rule as the HTTP lane).
fn ws_upstream_path(mount: &str, sub_path: &str) -> String {
    upstream_path_for(mount, sub_path)
}

/// Handler for `/api/ext/ws/:plugin_id/*rest` — the WS twin of [`ext_proxy`]. The
/// `WebSocketUpgrade` extractor runs the enabled-gate + route-allowlist + node-token
/// checks BEFORE the upgrade is accepted, so an unauthenticated or undeclared socket
/// never reaches the sidecar.
async fn ext_ws_proxy(
    State(state): State<ServerState>,
    Path((plugin_id, rest)): Path<(String, String)>,
    Extension(expected_node_token): Extension<Option<String>>,
    Query(query): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    let (plugin_id, rest) = split_scoped_plugin_path(plugin_id, rest);
    ext_ws_tunnel(
        &state,
        &plugin_id,
        &format!("/{rest}"),
        expected_node_token,
        &query,
        ws,
    )
    .await
}

/// Handler for the bare `/api/ext/ws/:plugin_id` root (see [`ext_root_proxy`] for why
/// the exact route needs its own handler).
async fn ext_ws_root_proxy(
    State(state): State<ServerState>,
    Path(plugin_id): Path<String>,
    Extension(expected_node_token): Extension<Option<String>>,
    Query(query): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    ext_ws_tunnel(&state, &plugin_id, "/", expected_node_token, &query, ws).await
}

/// Shared core of the two WS handlers: enabled-gate → route-allowlist → node-token →
/// wake → upgrade+bridge. Every refusal is a plain HTTP response that axum sends
/// instead of accepting the upgrade.
async fn ext_ws_tunnel(
    state: &ServerState,
    plugin_id: &str,
    sub_path: &str,
    _startup_node_token: Option<String>,
    query: &HashMap<String, String>,
    ws: WebSocketUpgrade,
) -> Response {
    // Enabled gate (secrecy: a disabled/absent plugin's proxied surface must not exist).
    match state.app_store.get(plugin_id).await {
        Ok(Some(rec)) if rec.enabled => {}
        Ok(_) => return StatusCode::NOT_FOUND.into_response(),
        Err(e) => {
            tracing::warn!("ext ws proxy: app_store lookup for '{plugin_id}' failed: {e}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    // Route allowlist (undeclared path ⇒ 404) + sidecar + mount + max_body (unused for
    // WS, kept for parity of the resolve call).
    let manifests = state.app_manifests.read().await;
    let Some(manifest) = manifests.iter().find(|m| m.id == plugin_id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some((spec, http, route)) = resolve_route(manifest, sub_path, "GET") else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let auth = route.auth;
    let required = required_permission_for(route, sub_path, plugin_id);
    let mount = http
        .mount
        .as_deref()
        .map(|m| m.trim_end_matches('/').to_owned())
        .unwrap_or_default();
    let sidecar_name = crate::sidecar::manifest_sidecar::namespaced_name(plugin_id, &spec.name);
    drop(manifests);

    if query.contains_key("token") || query.contains_key("jwt") {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let ticket = if auth == RouteAuth::Protected {
        let expected_path = format!("/api/ext/ws/{plugin_id}{sub_path}");
        match crate::server::ws_ticket::consume(
            query.get(WS_TICKET_PARAM).map(String::as_str),
            crate::server::ws_ticket::WsTicketRoute::Extension,
            Some(&expected_path),
        ) {
            Some(ticket) => Some(ticket),
            None => return StatusCode::UNAUTHORIZED.into_response(),
        }
    } else {
        None
    };
    let revocation = match ext_ws_revocation_for(ticket.as_ref()) {
        Ok(revocation) => revocation,
        Err(status) => return status.into_response(),
    };

    // The ticket carries the verified caller from the HTTP exchange. The route
    // permission must be checked before waking the sidecar or accepting the
    // upgrade; otherwise a view-only caller could reach the control stream.
    if let Some((permission, resource_id)) = required {
        let caller = ticket.as_ref().and_then(|ticket| ticket.caller.clone());
        if let Err(status) = crate::server::enforce_permission_on(
            state,
            &caller,
            &permission,
            plugin_id,
            &resource_id,
        )
        .await
        {
            return status.into_response();
        }
    }

    let wake_eligible = state.manager.is_wake_eligible(&sidecar_name);

    // Registration gate + wake-on-demand — identical semantics to the HTTP lane.
    let mut target = match state.manager.forward_target(&sidecar_name) {
        Ok(t) => Some(t),
        Err(denied @ ForwardDenied::NotRegistered { .. }) => return sidecar_unavailable(&denied),
        Err(denied @ ForwardDenied::NotRunning { .. }) => {
            if !wake_eligible {
                return sidecar_unavailable(&denied);
            }
            None
        }
    };

    let _activity = if wake_eligible {
        if target.is_none() {
            match state
                .manager
                .wake_and_await_healthy(&sidecar_name, WAKE_WARMUP_TIMEOUT)
                .await
            {
                Ok(woke) => {
                    if woke {
                        fire_lazy_activation(state, ACTIVATION_ON_ROUTE);
                    }
                }
                Err(e) => return wake_failed_response("ext ws proxy", &sidecar_name, &e, false),
            }
            target = match state.manager.forward_target(&sidecar_name) {
                Ok(t) => Some(t),
                Err(denied) => return sidecar_unavailable(&denied),
            };
        }
        Some(state.manager.enter_request(&sidecar_name))
    } else {
        None
    };

    let Some(target) = target else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "sidecar unavailable, retry shortly",
        )
            .into_response();
    };

    let port = target.port();
    let upstream_path = ws_upstream_path(&mount, sub_path);
    let hop_token = ext_token(node_token().as_deref(), plugin_id);

    ws.on_upgrade(move |socket| {
        let revoked =
            wait_for_ext_ws_revocation(revocation, crate::node_token::subscribe_generation());
        bridge_ws_to_sidecar(socket, port, upstream_path, hop_token, revoked)
    })
}

/// The authorization a Protected tunnel was opened under: the caller's JWT expiry
/// and the node-token generation the WS ticket was minted in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ExtWsRevocation {
    jwt_expires_at: Option<i64>,
    node_generation: u64,
}

/// The pre-upgrade lifetime gate for a consumed WS ticket. A ticket outlives nothing
/// it was minted from: an identity that has already expired is refused with 401
/// here, exactly as the realtime and voice sockets refuse it. Otherwise it returns
/// what ends the tunnel's authorization once it is open. A Public route has no
/// ticket (`None`), so nothing revokes it beyond the sockets themselves.
fn ext_ws_revocation_for(
    ticket: Option<&crate::server::ws_ticket::WsTicketClaims>,
) -> Result<Option<ExtWsRevocation>, StatusCode> {
    let Some(ticket) = ticket else {
        return Ok(None);
    };
    if ticket
        .jwt_expires_at
        .is_some_and(|expires_at| expires_at <= chrono::Utc::now().timestamp())
    {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(Some(ExtWsRevocation {
        jwt_expires_at: ticket.jwt_expires_at,
        node_generation: ticket.node_generation,
    }))
}

/// WebSocket close code 1008 (policy violation), the code the realtime and voice
/// sockets close with when the caller's authorization lapses.
const WS_CLOSE_POLICY: u16 = 1008;

/// Resolves when a Protected tunnel's authorization lapses: the caller's JWT expires,
/// or the node token rotates away from the generation the ticket was minted in (or
/// its watch closes, which fails closed). `None` (a Public route) never resolves.
/// The permission gate runs once before the upgrade, so without this signal a socket
/// would keep reaching the sidecar under Core's hop bearer for as long as it stayed
/// open.
async fn wait_for_ext_ws_revocation(
    revocation: Option<ExtWsRevocation>,
    mut generation_updates: tokio::sync::watch::Receiver<u64>,
) {
    let Some(revocation) = revocation else {
        std::future::pending::<()>().await;
        return;
    };
    let rotation = async move {
        loop {
            if *generation_updates.borrow_and_update() != revocation.node_generation {
                return;
            }
            if generation_updates.changed().await.is_err() {
                return;
            }
        }
    };
    tokio::select! {
        () = crate::server::ws_ticket::wait_for_jwt_expiry(revocation.jwt_expires_at) => {}
        () = rotation => {}
    }
}

/// Bridge one accepted client socket to the sidecar's loopback WS endpoint, pumping
/// bytes (binary and text) both ways until either side closes or `revoked` resolves
/// (for a Protected route, the caller's authorization lapsed:
/// [`wait_for_ext_ws_revocation`]), which closes the client with 1008 and drops the
/// upstream socket. The hop bearer is re-stamped on the upstream dial, exactly like
/// the HTTP lane.
async fn bridge_ws_to_sidecar(
    mut client: WebSocket,
    port: u16,
    upstream_path: String,
    hop_token: String,
    revoked: impl std::future::Future<Output = ()> + Send,
) {
    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    tokio::pin!(revoked);

    let url = format!("ws://127.0.0.1:{port}{upstream_path}");
    let mut request = match url.clone().into_client_request() {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("ext ws tunnel: bad upstream URL '{url}': {e}");
            let _ = client.close().await;
            return;
        }
    };
    let mut headers = request.headers_mut();
    if let Ok(value) = axum::http::HeaderValue::from_str(&format!("Bearer {hop_token}")) {
        headers.insert("authorization", value);
    }
    headers.insert(
        "x-ryu-plugin-id",
        axum::http::HeaderValue::from_static("ext-proxy-ws"),
    );

    let (mut upstream, _) = match tokio_tungstenite::connect_async(request).await {
        Ok(pair) => pair,
        Err(e) => {
            tracing::warn!("ext ws tunnel: sidecar WS unreachable at {url}: {e}");
            let _ = client.close().await;
            return;
        }
    };

    loop {
        tokio::select! {
            () = &mut revoked => {
                let _ = client
                    .send(WsMessage::Close(Some(axum::extract::ws::CloseFrame {
                        code: WS_CLOSE_POLICY,
                        reason: "authorization expired".into(),
                    })))
                    .await;
                break;
            }
            msg = client.recv() => {
                match msg {
                    Some(Ok(m)) => {
                        let converted = axum_to_tungstenite(m);
                        let is_close = matches!(converted, TsMessage::Close(_));
                        if upstream.send(converted).await.is_err() {
                            break;
                        }
                        if is_close {
                            break;
                        }
                    }
                    Some(Err(_)) | None => break,
                }
            }
            msg = upstream.next() => {
                match msg {
                    Some(Ok(m)) => {
                        let converted = tungstenite_to_axum(m);
                        let is_close = matches!(converted, WsMessage::Close(_));
                        if client.send(converted).await.is_err() {
                            break;
                        }
                        if is_close {
                            break;
                        }
                    }
                    Some(Err(_)) | None => break,
                }
            }
        }
    }

    // Best-effort close propagation on the way out.
    let _ = client.close().await;
    let _ = upstream.close(None).await;
}

/// Convert an axum WS message to the tokio-tungstenite shape (same wire content).
fn axum_to_tungstenite(msg: WsMessage) -> TsMessage {
    match msg {
        WsMessage::Text(s) => TsMessage::text(s),
        WsMessage::Binary(b) => TsMessage::binary(b),
        WsMessage::Ping(p) => TsMessage::Ping(p.into()),
        WsMessage::Pong(p) => TsMessage::Pong(p.into()),
        WsMessage::Close(Some(frame)) => {
            TsMessage::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: frame.code.into(),
                reason: frame.reason.into(),
            }))
        }
        WsMessage::Close(None) => TsMessage::Close(None),
    }
}

/// Convert a tokio-tungstenite WS message back to the axum shape.
fn tungstenite_to_axum(msg: TsMessage) -> WsMessage {
    match msg {
        TsMessage::Text(s) => WsMessage::Text(s.to_string()),
        TsMessage::Binary(b) => WsMessage::Binary(b.into()),
        TsMessage::Ping(p) => WsMessage::Ping(p.into()),
        TsMessage::Pong(p) => WsMessage::Pong(p.into()),
        TsMessage::Close(Some(frame)) => WsMessage::Close(Some(axum::extract::ws::CloseFrame {
            code: frame.code.into(),
            reason: frame.reason.into(),
        })),
        TsMessage::Close(None) => WsMessage::Close(None),
        // `Frame` is the fully-parsed variant tokio-tungstenite only yields when
        // reading raw streams; a `connect_async` socket yields the typed variants
        // above. Fall back to nothing-to-forward rather than inventing bytes.
        TsMessage::Frame(_) => WsMessage::Ping(Vec::new()),
    }
}

// ── Host-API callback (/api/host/*) ───────────────────────────────────────────

/// The host-API sub-router (sidecar → Core). Registered on the PUBLIC router because
/// the sidecar process holds only its minted [`ext_token`], not the node bearer;
/// [`authorize_host_call`] does the auth + grant intersection in-handler.
///
/// **Three routes, no app names.** Every sidecar → Core callback in the product goes
/// through one of them:
/// - `/api/host/model/complete` — the proven single-purpose model callback;
/// - `/api/host/rpc` — the extension-host RPC vocabulary (`ryu-kernel-contracts`);
/// - `/api/host/capability/:cap` — the capability broker, which serves BOTH the
///   app-provided capabilities (proxied to the bound provider's sidecar) AND the
///   **kernel** capabilities Core itself implements ([`KERNEL_CAPABILITIES`]).
///
/// This used to carry seven more rows — `/api/host/monitors/{spider,alert}`,
/// `/api/host/meetings/save-notes` and `/api/host/recipes/{run,record-start,
/// record-status,record-stop}` — i.e. an app id baked into Core's route table right
/// next to the generic seam built to replace it. They are now
/// [`KERNEL_CAPABILITIES`] rows reached as `POST /api/host/capability/<cap>`: the
/// sidecar names the *capability* it needs, Core dispatches from a table, and adding
/// an app never adds a route again.
pub fn host_routes() -> Router<ServerState> {
    Router::new()
        .route("/api/host/model/complete", post(host_model_complete))
        .route(
            "/api/host/model/stream",
            post(crate::server::model_stream::host_model_stream),
        )
        .route(
            "/api/host/rpc",
            post(host_rpc).layer(axum::extract::DefaultBodyLimit::max(
                crate::backups::MAX_APP_BYTES + 64 * 1024,
            )),
        )
        .route("/api/host/capability/:cap", post(host_capability))
}

/// The grant a sidecar must hold (declared in `host_api.grants` AND Gateway-approved)
/// to call `POST /api/host/model/complete`.
const GRANT_MODEL_COMPLETE: &str = "hook:side-model";

/// Authenticate a host-API callback and resolve the caller's usable grant set.
///
/// Steps, fail-closed at each: read the `x-ryu-plugin-id` header + bearer; recompute
/// that plugin's expected [`ext_token`] and constant-time-compare; confirm the plugin
/// is enabled; then return the intersection of the sidecar's declared
/// `host_api.grants` with the plugin's Gateway-*approved* grants (never the manifest
/// claim). The `required_grant` must survive that intersection.
/// Authenticate a sidecar callback: verify `x-ryu-plugin-id` + minted-token bearer,
/// confirm the plugin is enabled, and return its id + Gateway-approved grants. The
/// shared front half of every `/api/host/*` handler — both [`authorize_host_call`]
/// (kernel-primitive grant intersection) and the capability broker build on it.
pub(crate) async fn authenticate_sidecar(
    state: &ServerState,
    headers: &HeaderMap,
) -> Result<(String, HashSet<String>), (StatusCode, &'static str)> {
    let presented = headers
        .get(HDR_PLUGIN_ID)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or((StatusCode::UNAUTHORIZED, "missing plugin id"))?
        .to_owned();

    let provided = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or((StatusCode::UNAUTHORIZED, "missing bearer"))?;

    // The ONE site that must canonicalize explicitly. Everything else sees only
    // canonical ids (the manifest loader rewrites them), but this id arrives from
    // OUTSIDE — a sidecar sends whatever its manifest said when it was spawned, and
    // an older third-party sidecar still sends its legacy id.
    //
    // Credentials are minted only for canonical ids. Never mint or accept a
    // second caller-controlled alias credential at this trust boundary.
    let plugin_id = crate::plugin_manifest::canonical_plugin_id(&presented).to_owned();
    if !crate::sidecar::plugin_credentials::verifies(&plugin_id, provided) {
        return Err((StatusCode::UNAUTHORIZED, "bad token"));
    }

    // Enabled gate + Gateway-approved grants (disabled ⇒ approved_grants == [] ⇒
    // deny-all).
    let record = match state.app_store.get(&plugin_id).await {
        Ok(Some(rec)) if rec.enabled => rec,
        Ok(_) => return Err((StatusCode::NOT_FOUND, "plugin not enabled")),
        Err(_) => return Err((StatusCode::INTERNAL_SERVER_ERROR, "lookup failed")),
    };
    let approved =
        crate::plugin_host::current_approved_grants(state, &plugin_id, &record.approved_grants)
            .await;
    Ok((plugin_id, approved))
}

pub(crate) async fn authorize_host_call(
    state: &ServerState,
    headers: &HeaderMap,
    required_grant: &str,
) -> Result<(String, HashSet<String>), (StatusCode, &'static str)> {
    let (plugin_id, approved) = authenticate_sidecar(state, headers).await?;

    // The sidecar's declared host-API grant ceiling (union across its sidecars).
    let declared: HashSet<String> = {
        let manifests = state.app_manifests.read().await;
        let Some(manifest) = manifests.iter().find(|m| m.id == plugin_id) else {
            return Err((StatusCode::NOT_FOUND, "manifest not found"));
        };
        manifest
            .sidecars
            .iter()
            .filter_map(|s| s.host_api.as_ref())
            .flat_map(|h| h.grants.iter().cloned())
            .collect()
    };

    // Usable = declared ∩ approved. The requested capability must survive it.
    let usable: HashSet<String> = declared.intersection(&approved).cloned().collect();
    if !usable.contains(required_grant) {
        return Err((StatusCode::FORBIDDEN, "capability not granted"));
    }
    Ok((plugin_id, usable))
}

/// `POST /api/host/model/complete` — a sidecar's authenticated model-completion
/// callback, gated on `hook:side-model` and routed through the SAME
/// [`PluginHookBridge`](crate::plugin_host::PluginHookBridge) `host.sideModel`
/// capability the JS turn-hook sandbox and the in-desktop bridge use (one
/// implementation, one grant vocabulary, one Gateway-governed egress).
async fn host_model_complete(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(args): Json<serde_json::Value>,
) -> Response {
    let (plugin_id, grants) =
        match authorize_host_call(&state, &headers, GRANT_MODEL_COMPLETE).await {
            Ok(v) => v,
            Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
        };

    let bridge = crate::plugin_host::PluginHookBridge::new(plugin_id, grants, state);
    use crate::tool_exec::{InvokeOutcome, SandboxBridge};
    match bridge.handle("host.sideModel".to_owned(), args).await {
        InvokeOutcome::Result(r) if r.is_error => {
            let msg = r.error.unwrap_or_else(|| "completion failed".to_owned());
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": msg }))).into_response()
        }
        InvokeOutcome::Result(r) => Json(json!({ "result": r.value })).into_response(),
        InvokeOutcome::Suspend(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "completion cannot suspend" })),
        )
            .into_response(),
    }
}

/// `POST /api/host/rpc` — the **extension-host RPC** endpoint. A managed `kind:
/// "node"` sidecar (via the embedded bootstrap's `ctx.host.call`) invokes ONE
/// host-API method, which Core dispatches through the SAME
/// [`PluginHookBridge`](crate::plugin_host::PluginHookBridge) the JS turn-hook
/// sandbox and the iframe app-host use — arm-for-arm, one grant vocabulary, one
/// Gateway-governed egress.
///
/// No new vocabulary is minted: `method` MUST be a row in the single-sourced
/// kernel-contracts host-API table AND map to a bridge dispatch path
/// ([`crate::plugin_host::dispatch_path_for`]); anything else is `400`. Auth is the
/// standard three-way [`authenticate_sidecar`] (token → plugin identity + approved
/// grants) plus the declared∩approved intersection ([`authorize_host_call`]) on the
/// method's required grant — so a node backend can never exceed its plugin's
/// Gateway-approved authority.
async fn host_rpc(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<HostRpcBody>,
) -> Response {
    let method = body.method.trim();
    // Resolve grant + bridge path from the single source of truth. A method with no
    // grant (local UI caps like `widget.state`) or no bridge path is not dispatchable.
    let Some(required_grant) = ryu_kernel_contracts::host_api::grant_for(method) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("unknown or non-dispatchable host method '{method}'") })),
        )
            .into_response();
    };
    let Some(bridge_path) = crate::plugin_host::dispatch_path_for(method) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "error": format!("host method '{method}' is not dispatchable over rpc") }),
            ),
        )
            .into_response();
    };

    let (plugin_id, grants) = match authorize_host_call(&state, &headers, required_grant).await {
        Ok(v) => v,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };

    let caller = crate::server::verified_caller_from_headers(&headers).await;
    let bridge = crate::plugin_host::PluginHookBridge::new_for_request(
        plugin_id, grants, state, caller, None,
    );
    use crate::tool_exec::{InvokeOutcome, SandboxBridge};
    match bridge.handle(bridge_path.to_owned(), body.args).await {
        InvokeOutcome::Result(r) if r.is_error => {
            let msg = r.error.unwrap_or_else(|| "host call failed".to_owned());
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": msg }))).into_response()
        }
        InvokeOutcome::Result(r) => Json(json!({ "result": r.value })).into_response(),
        InvokeOutcome::Suspend(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "host call cannot suspend" })),
        )
            .into_response(),
    }
}

/// Request body for [`host_rpc`]: `{ method, args }`. `args` is forwarded to the
/// bridge VERBATIM — every bridge arm narrows its own fields defensively.
#[derive(serde::Deserialize)]
struct HostRpcBody {
    method: String,
    #[serde(default)]
    args: serde_json::Value,
}

// ── Kernel capabilities (Core-implemented rows of the broker) ─────────────────

/// One **kernel capability** — a host primitive Core itself implements, invoked over
/// the SAME `POST /api/host/capability/<cap>` seam an app-provided capability uses.
///
/// # Why these are not `provides` entries
///
/// The broker's provider path resolves a capability to another *app*'s sidecar route
/// through [`crate::plugins::binding`]. A kernel capability has no provider app: the
/// implementation is Core's own MCP registry / notify store / Spaces store /
/// recorder subprocess, so there is nothing to bind, nothing to wake, and no hop to
/// forward. It is dispatched IN-PROCESS from [`KERNEL_CAPABILITIES`] *before* the
/// binding registry is consulted.
///
/// Symmetrically, a sidecar must **not** name one in `requires.capabilities`: that
/// field lowers to a concrete app-id graph edge ([`crate::plugins::binding::lower_manifests`])
/// and an unbindable entry fails enable with `Unprovided`. A sidecar declares what it
/// needs through its `sidecars[].host_api.grants` instead — the same declaration
/// `/api/host/model/complete` and `/api/host/rpc` already read.
struct KernelCapability {
    /// The capability name the sidecar POSTs to (`/api/host/capability/<cap>`).
    /// Named for the **host primitive**, never for the calling app — that is the
    /// whole point of retiring the per-app `/api/host/<app>/*` rows.
    cap: &'static str,
    /// The grant the caller must hold: DECLARED in its `sidecars[].host_api.grants`
    /// **and** Gateway-approved (the [`authorize_host_call`] intersection — never the
    /// manifest claim alone).
    ///
    /// `None` means "no reviewed grant is required for this row", NOT "unguarded".
    /// Every kernel capability is still authenticated by the caller's minted
    /// [`ext_token`] (each handler re-runs [`authenticate_sidecar`]), and a `None` row
    /// carries its own tighter gate instead: ownership (`events.emit`), the active
    /// user's own inbox, or `notifications:send-to-user` for any other recipient
    /// (`notify.deliver`, checked in the handler), Core-derived tenancy
    /// (`billing.recordToolCharge` takes the organization from the registered node,
    /// never the body), or an app pin (`notify.fanout`).
    ///
    /// A `Some(grant)` row is not proof that the grant covers the handler's whole
    /// operation. Some handlers ALSO pin their calling app because the grant is
    /// necessary but not sufficient: `mcp.callTool` (`@ryu/monitors`),
    /// `spaces.fileNotes` (`@ryu/meetings`), `email.*` (`@ryu/mail`) and `ghost.*`
    /// (`@ryu/recipes`). A pin keeps its row single-app, so it is never looser than
    /// the retired per-app route it replaced. The pins are inventoried by
    /// `app_boundary_guard::no_new_kernel_handler_app_pins` and tracked in
    /// `docs/app-boundary-extraction-plan.md`. Replacing one needs reviewed
    /// vocabulary that fits the handler exactly (a Gateway governance change:
    /// `reserved_namespaces` + `default_grant_allowlist` + consent labels), not a Core
    /// one.
    grant: Option<&'static str>,
}

/// The kernel-capability table — the Core-implemented half of the broker.
///
/// Every row here replaces one retired `/api/host/<app>/*` route. The handlers live
/// beside the kernel code they expose (`server::app_*`, `recipes_host`), and some
/// still pin their calling app, so the *routing* is generic today and the *tenancy*
/// of a pinned row stays single-app until the Gateway vocabulary has a reviewed
/// grant for it; nothing in this table names an app.
const KERNEL_CAPABILITIES: &[KernelCapability] = &[
    // Run one MCP tool through Core's shared `McpRegistry`, which no sidecar can host
    // (it owns the stdio child processes). Body `{ tool, args }` → `{ result }`.
    // `tools.invoke` is the reviewed MCP tool-plane scope in the Gateway allowlist;
    // the `tools` namespace is reserved, so it can never be self-granted by name.
    //
    // `tools.invoke` is necessary but NOT sufficient here. The handler runs the tool
    // with no user, agent, agent allowlist or org policy (`call_tool(.., None)`),
    // unlike `tools.call` below, which requires a verified caller and that user's
    // agent permission. The `@ryu/monitors` pin plus the fixed tool allowlist in
    // `server::app_mcp_call` is the remaining gate; see that module's doc for why no
    // existing grant replaces it.
    KernelCapability {
        cap: "mcp.callTool",
        grant: Some("tools.invoke"),
    },
    // Fan a fired alert out through the kernel notify store (the caller-chosen
    // webhook / Telegram / Expo / email targets + node-wide mobile push +
    // `notification` plugin hooks), copy it into the app inbox, and record it on the
    // unified activity feed as a "monitors" item. Body `{ alert, targets }`.
    //
    // `grant: None` + the handler's `@ryu/monitors` pin. The Gateway's reviewed
    // notification grants each cover a narrower, single-recipient, in-product
    // delivery: `notifications:send` (one bounded notification for the active user,
    // no recipient or channel choice), `notifications:send-to-user` (one member of
    // the resolved org/team, for a verified org caller) and `native:notifications`
    // (a bounded native host effect). None covers caller-chosen external channels,
    // node-wide push, notification hooks and an attributed activity row, and riding
    // an ill-fitting grant would hand that reach to every app that holds it. So the
    // gate stays exactly what the retired `/api/host/monitors/alert` had: minted
    // token + the app pin (`server::app_notify::host_notify_fanout`).
    KernelCapability {
        cap: "notify.fanout",
        grant: None,
    },
    // Deliver a user-targeted notification into the app-inbox feed on behalf of
    // the calling app. Body `{ title, body?, level?, target_user_id? }`. Unlike
    // `notify.fanout` (monitors' EXTERNAL channel fan-out), this writes the row
    // the desktop's Inbox renders, so the app's icon/name shows there. The
    // `source_app_id` stamped on the row is the AUTHENTICATED caller, never a body
    // field. `grant: None` because the row-level gate depends on the recipient:
    // writing to the node's own active user needs only the minted token + the
    // enabled-app check, while naming any OTHER member requires the approved
    // `notifications:send-to-user` grant (checked in `app_notify::deliver_for_app`,
    // which the `events.emit` notify hint shares) plus org-roster membership on a
    // managed node.
    KernelCapability {
        cap: "notify.deliver",
        grant: None,
    },
    // Send through the node-owned email transport. The app supplies message facts;
    // Core owns SMTP preferences, secret custody, timeout, and relay execution.
    KernelCapability {
        cap: "email.send",
        grant: Some("mail:crud"),
    },
    KernelCapability {
        cap: "email.status",
        grant: Some("mail:crud"),
    },
    // Shared DNS-pinned outbound HTTP. App protocols retain their own
    // origin/payment semantics; Core owns URL screening and network safety.
    KernelCapability {
        cap: "egress.fetch",
        grant: Some("egress:http"),
    },
    // Record a provider-neutral external-tool charge. The handler derives the
    // organization from the registered node and forwards the report to Gateway;
    // a sidecar may describe work, but it cannot choose a wallet.
    KernelCapability {
        cap: "billing.recordToolCharge",
        grant: None,
    },
    // Route an app's provider-neutral operation through Core's managed Gateway.
    // The sidecar supplies no provider credential; Gateway resolves it from the
    // provider vault and owns the organization-wallet debit.
    KernelCapability {
        cap: "providers.status",
        grant: Some("tools.invoke"),
    },
    KernelCapability {
        cap: "providers.call",
        grant: Some("tools.invoke"),
    },
    // Ask whether the agent a grant names may use a provider, for an app that
    // reaches it with credentials it holds itself instead of `providers.call`.
    // Same account-access rules; nothing is called.
    KernelCapability {
        cap: "providers.authorize",
        grant: Some("tools.invoke"),
    },
    // Generic visitor-authenticated app tool dispatch. Never an owner/node fallback.
    KernelCapability {
        cap: "tools.call",
        grant: Some("tools.invoke"),
    },
    KernelCapability {
        cap: "plugins.installBundle",
        grant: Some("plugins:install"),
    },
    // File a notes document into a Core-owned system Space under the background
    // owner. Core owns the `SpaceStore` + its tenancy, so a sidecar cannot do this
    // itself. Body `{ title, markdown }` → `{ space_id, doc_id }`.
    //
    // `spaces:docs` is necessary but NOT sufficient: it covers an app's OWN
    // documents (`kind = "app:<plugin_id>"`) under the caller's Space ACL, not a
    // document no app owns, filed into the shared "Meetings" system Space under
    // `background_owner()` with no per-user Space access check. So the handler's
    // `@ryu/meetings` pin stays (`server::app_file_notes`).
    KernelCapability {
        cap: "spaces.fileNotes",
        grant: Some("spaces:docs"),
    },
    // Post a turn on the user's behalf into a REAL conversation. Core owns the chat
    // path + the conversation store, and a sidecar holds no node token, so this is
    // the only way an out-of-process app can send at all. Body
    // `{ text, agent_id?, conversation_id?, model? }` → `{ status, conversation_id }`
    // or `202 { status: "pending_approval", approval_id }`.
    //
    // `chat.sendFollowUp` is the EXISTING reserved sigil for exactly this power (the
    // Gateway's governance defines it as "post a chat turn on the user's behalf"),
    // so it is reused rather than duplicated under a second name. Being reserved is
    // what stops `com.evil.chat` from owner-scoping its way in.
    //
    // The grant is NOT the whole gate: `server::host_chat` additionally scans the
    // prompt through the exec firewall and, by default, routes the send through the
    // Approvals inbox. Spending a subscription unattended should cost more than one
    // approved grant.
    KernelCapability {
        cap: "chat.startTurn",
        grant: Some(crate::server::host_chat::GRANT_SEND_FOLLOW_UP),
    },
    // Projects › Bots/Groups › Sessions placement for an app's own turns: find or
    // create a project/bot/group main thread, put a conversation in a project, and
    // write project-scoped model defaults. They only shape where `chat.startTurn`
    // turns land and which model they use, so they reuse its grant
    // (`server::host_hierarchy`).
    KernelCapability {
        cap: "threads.ensureMainThread",
        grant: Some(crate::server::host_chat::GRANT_SEND_FOLLOW_UP),
    },
    KernelCapability {
        cap: "threads.placeInProject",
        grant: Some(crate::server::host_chat::GRANT_SEND_FOLLOW_UP),
    },
    KernelCapability {
        cap: "scopeDefaults.set",
        grant: Some(crate::server::host_chat::GRANT_SEND_FOLLOW_UP),
    },
    KernelCapability {
        cap: "scopeGuidance.set",
        grant: Some(crate::server::host_hierarchy::GRANT_PROJECT_GUIDANCE),
    },
    // The live facts an app needs to decide whether now is a good time to send: the
    // COUNT of active agent runs, and how full each named agent's usage windows
    // are. Core owns both (the conversation store; the vendor usage readers), and a
    // sidecar can reach neither on its own. Body `{ agent_ids: [] }` →
    // `{ running, usage: [{ agent_id, used_percent }] }`.
    //
    // Counts, never contents — see the handler for why that distinction is what
    // makes this safe without a per-user caller identity to ACL-filter by.
    KernelCapability {
        cap: "node.readings",
        grant: Some(crate::server::host_chat::GRANT_NODE_READINGS),
    },
    // Ghost capture/replay — the live native-desktop engine. Replay needs the shared
    // MCP registry; the recording session holds a dedicated recorder subprocess
    // (`McpSession`) in Core's process-global slot ACROSS separate HTTP calls, which
    // is precisely why it cannot live in a stateless sidecar. All four share
    // `ghost:record`, the Gateway's reviewed capture/replay scope.
    KernelCapability {
        cap: "ghost.replay",
        grant: Some("ghost:record"),
    },
    KernelCapability {
        cap: "ghost.recordStart",
        grant: Some("ghost:record"),
    },
    KernelCapability {
        cap: "ghost.recordStatus",
        grant: Some("ghost:record"),
    },
    KernelCapability {
        cap: "ghost.recordStop",
        grant: Some("ghost:record"),
    },
    // Raise an **app event** the calling plugin declared in its manifest
    // `contributes.hook_events`, fanning it out to every plugin hook and workflow
    // that subscribes to it. Body `{ event, payload? }` → `{ event, hooks, workflows }`.
    //
    // A `grant: None` row, for a stronger reason than `notify.fanout`'s: this
    // capability is authorized by **ownership**, which is tighter than any grant
    // could be. `may_emit_event` requires the authenticated caller to be the plugin
    // the event id is namespaced to AND to have declared that exact event in its own
    // manifest, so the widest possible abuse of a stolen grant is "an app emits its
    // own events" — which is the entire intended use. A coarse grant would only
    // blur that, since holding it could never let an app emit someone else's event
    // and lacking it would break the app's only way to emit its own.
    KernelCapability {
        cap: "events.emit",
        grant: None,
    },
    // Publish a bounded named event into the caller's own generic application
    // room. The room key is constructed from the authenticated plugin id, never
    // from the request body, so a sidecar cannot publish into another app's room.
    KernelCapability {
        cap: "realtime.publish",
        grant: Some("app:realtime"),
    },
    // Read Core's inbound-webhook registry and ingress status (Composio receiver +
    // workflow `Webhook` triggers, with resolved public URLs). Metadata only: the
    // signing-secret read/write stays on its per-user ACL-checked route. Gated by
    // the existing `webhooks:crud` grant (`server::app_webhooks`); the same
    // operations answer a Companion's `window.ryu.webhooks.*` through the app
    // host bridge.
    KernelCapability {
        cap: "webhooks.list",
        grant: Some(crate::server::app_webhooks::GRANT_WEBHOOKS),
    },
    KernelCapability {
        cap: "webhooks.ingressStatus",
        grant: Some(crate::server::app_webhooks::GRANT_WEBHOOKS),
    },
    // Warmup over Core's heartbeat scheduler (`server::app_warmup`): detect
    // subscription agents, and list / replace / run-now the CALLER's own jobs
    // (owner = the authenticated plugin id). Gated by the existing `warmup:crud`
    // grant; the scheduler's own `agent.view` / `agent.edit` checks still run, with
    // no user (so they pass only on an unbound single-operator node). The same
    // operations answer a Companion's `window.ryu.warmup.*` through the app host
    // bridge, with the signed-in user.
    KernelCapability {
        cap: "warmup.detect",
        grant: Some(crate::server::app_warmup::GRANT_WARMUP),
    },
    KernelCapability {
        cap: "warmup.list",
        grant: Some(crate::server::app_warmup::GRANT_WARMUP),
    },
    KernelCapability {
        cap: "warmup.apply",
        grant: Some(crate::server::app_warmup::GRANT_WARMUP),
    },
    KernelCapability {
        cap: "warmup.runNow",
        grant: Some(crate::server::app_warmup::GRANT_WARMUP),
    },
    // Run recovery (`server::app_runs`): what a `core#run.failed` subscriber (the
    // Self-Healing sidecar) acts through. Each rides its own reviewed grant:
    // queue a heal approval (closed set of kinds, deduped on the source); re-run a
    // failed agent run under a Core-minted `healrun_` id; re-run a FAILED workflow
    // run (the existing `workflows:runstate`, which `workflows.run` already rides).
    KernelCapability {
        cap: "approvals.request",
        grant: Some(crate::server::app_runs::GRANT_APPROVALS_REQUEST),
    },
    KernelCapability {
        cap: "runs.rerunAgent",
        grant: Some(crate::server::app_runs::GRANT_RERUN_AGENT),
    },
    KernelCapability {
        cap: "workflows.rerun",
        grant: Some(crate::server::app_runs::GRANT_WORKFLOW_RUNSTATE),
    },
    // Agent accounts (`crate::vault::agent_accounts`): release one field of an
    // agent's website account to the sidecar that types it into a page, or store
    // a 2FA seed the sidecar read off a setup page. Both bind to the page origin
    // the sidecar reports and are named for the vault primitive, not the app
    // that fills. The reviewed `vault:fill` grant (a reserved namespace) is the
    // gate; the node bearer never reaches these, so no tool result carries a
    // secret.
    KernelCapability {
        cap: "vault.credentialFill",
        grant: Some(crate::server::vault_agent_accounts_api::GRANT_VAULT_FILL),
    },
    KernelCapability {
        cap: "vault.totpEnroll",
        grant: Some(crate::server::vault_agent_accounts_api::GRANT_VAULT_FILL),
    },
];

/// The [`KernelCapability`] row for `cap`, or `None` when the name belongs to the
/// app-provided (binding-registry) half of the broker.
fn kernel_capability(cap: &str) -> Option<&'static KernelCapability> {
    KERNEL_CAPABILITIES.iter().find(|k| k.cap == cap)
}

/// Body of the `events.emit` kernel capability.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct EventEmitBody {
    /// The fully-qualified event id (`<plugin id>#<event name>`). Must be one the
    /// calling plugin declared — see [`crate::plugin_host::may_emit_event`].
    event: String,
    /// The payload delivered to every consumer as `ctx.event`. Forwarded verbatim.
    #[serde(default)]
    payload: serde_json::Value,
    /// Optional conversation this event belongs to, when the emitter knows one (a
    /// meeting started from a chat, a workflow run kicked off by an agent). Carried
    /// into [`crate::plugin_host::HookContext::conversation_id`] so a consumer can
    /// key its own per-conversation state the same way a turn hook does.
    #[serde(default)]
    conversation_id: Option<String>,
    /// OPTIONAL user-facing notification to raise alongside the fan-out
    /// (`{ title, body?, level?, target_user_id? }`). Delivered into the app-inbox
    /// feed with `source_app_id` = the calling plugin (the desktop Inbox then shows
    /// the app's icon on the row) — the same delivery [`notify.deliver`] performs,
    /// so "emit an event AND ping the user" is one governed call. Best-effort: a
    /// delivery failure never fails the emit.
    #[serde(default)]
    notify: Option<EventEmitNotify>,
    /// OPTIONAL activity-feed row to record alongside the fan-out
    /// (`{ kind, title, body?, level?, metadata? }`). Recorded with `source` derived
    /// from the AUTHENTICATED caller (`@ryu/meetings` → `meetings`), never from the
    /// body, so an app can only ever write rows attributed to itself. This is how an
    /// out-of-process app feeds the unified activity feed without Core holding a
    /// per-app subscribe loop. Best-effort: an invalid hint or a failed write is
    /// logged and never fails the emit.
    #[serde(default)]
    activity: Option<crate::plugin_host::AppEventActivity>,
}

/// Body of the generic application-room sidecar publish capability. The caller
/// identity is authenticated from the ext token and supplies the app namespace;
/// `room_id` is the only room coordinate accepted from the sidecar.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct RealtimePublishBody {
    room_id: String,
    event: String,
    #[serde(default)]
    data: serde_json::Value,
}

async fn host_realtime_publish(
    state: ServerState,
    headers: HeaderMap,
    Json(body): Json<RealtimePublishBody>,
) -> Response {
    let plugin_id = match authenticate_sidecar(&state, &headers).await {
        Ok((id, _)) => id,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };
    let room_id = body.room_id.trim();
    if room_id.is_empty() || room_id.len() > 512 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "room_id must be 1..512 bytes" })),
        )
            .into_response();
    }
    let event = ryu_realtime::ApplicationEvent {
        name: body.event,
        payload: body.data,
    };
    if !ryu_realtime::is_valid_application_event(&event) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid or oversized application event" })),
        )
            .into_response();
    }
    state.realtime.publish_application_event(
        &plugin_id,
        room_id,
        event.name.clone(),
        event.payload,
    );
    Json(json!({ "published": true })).into_response()
}

/// `warmup.*` — Core's heartbeat scheduler, scoped to the caller's own jobs.
///
/// Re-authenticates the caller to pin the owner (never taken from the body),
/// then runs the shared [`crate::server::app_warmup::WarmupOp`] with no user:
/// the scheduler's `agent.view` / `agent.edit` checks treat a sidecar exactly as
/// an anonymous caller, so an app grant never stands in for a user permission.
async fn host_warmup(
    cap: &str,
    state: ServerState,
    headers: HeaderMap,
    args: serde_json::Value,
) -> Response {
    let plugin_id = match authenticate_sidecar(&state, &headers).await {
        Ok((id, _)) => id,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };
    let Some(op) = crate::server::app_warmup::WarmupOp::from_name(cap) else {
        return (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({ "error": "kernel capability has no implementation", "capability": cap })),
        )
            .into_response();
    };
    match op.run(&state, &plugin_id, &None, &args).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.into_capability_response(),
    }
}

/// The `notify` hint carried on an `events.emit` request.
#[derive(Debug, serde::Deserialize)]
pub(crate) struct EventEmitNotify {
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    level: Option<String>,
    #[serde(default)]
    target_user_id: Option<String>,
}

/// `events.emit` — fan an app event out to its subscribers.
///
/// Re-authenticates the caller (the kernel-capability contract: every handler pins
/// its own caller rather than trusting the broker's dispatch), then refuses anything
/// the caller does not own. Ownership is the whole gate here, so it is checked
/// before the payload is even looked at.
///
/// Two fan-outs, deliberately different in kind:
/// - **plugin hooks** run through [`crate::plugin_host::dispatch_app_event`], which
///   is awaited so the emitter learns how many consumers acted;
/// - **workflows** are started detached, because a workflow run can take minutes and
///   an emitter blocking on one would turn "my meeting ended" into a request timeout.
async fn host_events_emit(
    state: ServerState,
    headers: HeaderMap,
    Json(body): Json<EventEmitBody>,
) -> Response {
    let (plugin_id, grants) = match authenticate_sidecar(&state, &headers).await {
        Ok(caller) => caller,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };

    if !crate::plugin_host::may_emit_event(&state, &plugin_id, &body.event).await {
        // One message for "not yours" and "not declared" on purpose: distinguishing
        // them would let a caller probe which events other plugins have declared.
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "plugin may only emit events it declares in contributes.hook_events",
                "event": body.event,
            })),
        )
            .into_response();
    }

    let payload_len = serde_json::to_vec(&body.payload).map_or(0, |v| v.len());
    if payload_len > crate::plugin_host::MAX_EVENT_PAYLOAD_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({
                "error": "event payload too large",
                "limit_bytes": crate::plugin_host::MAX_EVENT_PAYLOAD_BYTES,
                "size_bytes": payload_len,
            })),
        )
            .into_response();
    }

    if let Some(activity) = &body.activity {
        crate::plugin_host::record_app_event_activity(&state, &plugin_id, &body.event, activity)
            .await;
    }

    // Sidecar subscribers (`subscribes`) are delivered off this request's path: the
    // fan-out queues per subscriber and returns immediately.
    if let Some(fanout) = crate::sidecar::event_subscribers::global() {
        fanout.publish(&body.event, body.payload.clone());
    }

    let ctx = crate::plugin_host::HookContext {
        conversation_id: body.conversation_id.clone(),
        event: Some(body.payload.clone()),
        ..Default::default()
    };
    let directives = crate::plugin_host::dispatch_app_event(&state, &body.event, &ctx).await;

    // Surface any `note` a consumer returned. An app event has no chat turn to
    // attach a note to, so the notify store is the only place it can legibly go —
    // and it is where a user already looks for "something happened".
    for directive in &directives {
        if let crate::plugin_host::HookDirective::Note { text } = directive {
            crate::plugin_host::notify_app_event_note(&state, &body.event, text).await;
        }
    }

    let workflows =
        crate::workflow::triggers::fire_event_workflows(&body.event, &body.payload).await;

    // Optional user-facing notification raised alongside the fan-out. Delivered
    // best-effort through the same kernel path `notify.deliver` uses, so the row
    // is stamped with the AUTHENTICATED caller — an event's notify hint can never
    // be attributed to a different app.
    if let Some(notify) = &body.notify {
        let title = notify.title.trim();
        if !title.is_empty() {
            let _ = crate::server::app_notify::deliver_for_app(
                &state.client,
                &plugin_id,
                &grants,
                notify.target_user_id.as_deref(),
                title,
                notify.body.as_deref().unwrap_or(""),
                notify.level.as_deref(),
            )
            .await;
        }
    }

    tracing::info!(
        event = %body.event,
        plugin = %plugin_id,
        hooks = directives.len(),
        workflows,
        "events.emit: app event fanned out"
    );

    Json(json!({
        "event": body.event,
        "hooks": directives.len(),
        "workflows": workflows,
    }))
    .into_response()
}

/// Whether `plugin_id` may exercise `grant`: the same declared∩approved intersection
/// [`authorize_host_call`] enforces, but taking the already-authenticated caller's
/// approved set so the kernel path does not re-run [`authenticate_sidecar`].
async fn holds_host_api_grant(
    state: &ServerState,
    plugin_id: &str,
    approved: &HashSet<String>,
    grant: &str,
) -> bool {
    let manifests = state.app_manifests.read().await;
    let Some(manifest) = manifests.iter().find(|m| m.id == plugin_id) else {
        return false;
    };
    host_api_grant_usable(manifest, approved, grant)
}

/// The pure predicate behind [`holds_host_api_grant`]: `grant` must be BOTH declared
/// in the manifest's `sidecars[].host_api.grants` (the app's own stated ceiling) AND
/// present in `approved` (what the Gateway actually approved at enable, as stored on
/// the app record). Either alone is not enough — a manifest cannot widen itself, and
/// an approval the app never asked for is not a licence to use it.
fn host_api_grant_usable(
    manifest: &crate::plugin_manifest::PluginManifest,
    approved: &HashSet<String>,
    grant: &str,
) -> bool {
    approved.contains(grant)
        && manifest
            .sidecars
            .iter()
            .filter_map(|s| s.host_api.as_ref())
            .any(|h| h.grants.iter().any(|g| g == grant))
}

/// Dispatch an authenticated + grant-checked kernel capability to its in-Core
/// implementation.
///
/// The handlers keep their existing `(State, HeaderMap, Json<Body>)` shape and are
/// called directly — no HTTP hop, no signature change (they are still the same
/// functions the retired per-app routes pointed at, which is what makes this a
/// re-routing rather than a rewrite). Each re-runs [`authenticate_sidecar`]; the
/// pinned ones (`mcp.callTool`, `notify.fanout`, `spaces.fileNotes`, `email.*`,
/// `ghost.*`) also refuse a caller that is not the app they serve. Those pins are
/// deliberately preserved (see [`KernelCapability::grant`]).
async fn dispatch_kernel_capability(
    cap: &str,
    state: ServerState,
    headers: HeaderMap,
    body: &[u8],
) -> Response {
    /// Deserialize a kernel-capability body, 400ing with the serde message rather
    /// than letting a malformed body surface as a bare rejection.
    fn parse<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T, Response> {
        // An empty body is a valid `{}` for the arg-less verbs.
        let raw = if body.is_empty() {
            b"{}".as_slice()
        } else {
            body
        };
        serde_json::from_slice::<T>(raw).map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid capability body: {e}") })),
            )
                .into_response()
        })
    }

    macro_rules! body {
        ($t:ty) => {
            match parse::<$t>(body) {
                Ok(v) => Json(v),
                Err(resp) => return resp,
            }
        };
    }

    match cap {
        "mcp.callTool" => {
            crate::server::app_mcp_call::host_mcp_call_tool(
                State(state),
                headers,
                body!(serde_json::Value),
            )
            .await
        }
        "chat.startTurn" => {
            crate::server::host_chat::host_chat_start_turn(
                State(state),
                headers,
                body!(crate::server::host_chat::StartTurnBody),
            )
            .await
        }
        "threads.ensureMainThread" => {
            crate::server::host_hierarchy::host_ensure_main_thread(
                State(state),
                headers,
                body!(crate::server::host_hierarchy::EnsureMainThreadBody),
            )
            .await
        }
        "threads.placeInProject" => {
            crate::server::host_hierarchy::host_place_in_project(
                State(state),
                headers,
                body!(crate::server::host_hierarchy::PlaceInProjectBody),
            )
            .await
        }
        "scopeDefaults.set" => {
            crate::server::host_hierarchy::host_set_scope_default(
                State(state),
                headers,
                body!(crate::server::host_hierarchy::SetScopeDefaultBody),
            )
            .await
        }
        "scopeGuidance.set" => {
            crate::server::host_hierarchy::host_set_scope_guidance(
                State(state),
                headers,
                body!(crate::server::host_hierarchy::SetScopeGuidanceBody),
            )
            .await
        }
        "node.readings" => {
            crate::server::host_chat::host_node_readings(
                State(state),
                headers,
                body!(crate::server::host_chat::ReadingsBody),
            )
            .await
        }
        "notify.fanout" => {
            crate::server::app_notify::host_notify_fanout(
                State(state),
                headers,
                body!(crate::server::app_notify::AlertFanoutBody),
            )
            .await
        }
        "notify.deliver" => {
            crate::server::app_notify::host_notify_deliver(
                State(state),
                headers,
                body!(crate::server::app_notify::DeliverBody),
            )
            .await
        }
        "email.send" => {
            crate::server::app_email::host_email_send(
                State(state),
                headers,
                body!(crate::server::app_email::SendBody),
            )
            .await
        }
        "email.status" => crate::server::app_email::host_email_status(State(state), headers).await,
        "vault.credentialFill" => {
            crate::server::vault_agent_accounts_api::host_credential_fill(
                State(state),
                headers,
                body!(crate::server::vault_agent_accounts_api::FillBody),
            )
            .await
        }
        "vault.totpEnroll" => {
            crate::server::vault_agent_accounts_api::host_totp_enroll(
                State(state),
                headers,
                body!(crate::server::vault_agent_accounts_api::EnrollBody),
            )
            .await
        }
        "egress.fetch" => {
            crate::server::app_egress::host_egress_fetch(
                State(state),
                headers,
                body!(crate::server::app_egress::FetchBody),
            )
            .await
        }
        "billing.recordToolCharge" => {
            crate::server::app_tool_usage::host_tool_usage_record(
                State(state),
                headers,
                body!(crate::server::app_tool_usage::ToolUsageBody),
            )
            .await
        }
        "providers.status" => {
            crate::server::provider_router::host_provider_status(
                State(state),
                headers,
                body!(crate::server::provider_router::ProviderStatusBody),
            )
            .await
        }
        "providers.call" => {
            crate::server::provider_router::host_provider_call(
                State(state),
                headers,
                body!(ryu_app_events::ManagedProviderCall),
            )
            .await
        }
        "providers.authorize" => {
            crate::server::provider_router::host_provider_authorize(
                State(state),
                headers,
                body!(crate::server::provider_router::ProviderAuthorizeBody),
            )
            .await
        }
        "tools.call" => {
            crate::server::call_tool_for_sidecar(
                state,
                headers,
                body!(crate::server::SidecarToolCall).0,
            )
            .await
        }
        "plugins.installBundle" => {
            crate::server::install_bundle_for_sidecar(state, headers, body!(serde_json::Value).0)
                .await
        }
        "spaces.fileNotes" => {
            crate::server::app_file_notes::host_file_notes(
                State(state),
                headers,
                body!(crate::server::app_file_notes::FileNotesBody),
            )
            .await
        }
        "ghost.replay" => {
            crate::recipes_host::host_recipes_run(State(state), headers, body!(serde_json::Value))
                .await
        }
        "ghost.recordStart" => {
            crate::recipes_host::host_recipes_record_start(
                State(state),
                headers,
                body!(serde_json::Value),
            )
            .await
        }
        "ghost.recordStatus" => {
            crate::recipes_host::host_recipes_record_status(State(state), headers).await
        }
        "ghost.recordStop" => {
            crate::recipes_host::host_recipes_record_stop(State(state), headers).await
        }
        "events.emit" => host_events_emit(state, headers, body!(EventEmitBody)).await,
        "webhooks.list" | "webhooks.ingressStatus" => {
            match crate::server::app_webhooks::WebhookOp::from_name(cap) {
                Some(op) => Json(op.run(&state).await).into_response(),
                None => (
                    StatusCode::NOT_IMPLEMENTED,
                    Json(json!({ "error": "kernel capability has no implementation", "capability": cap })),
                )
                    .into_response(),
            }
        }
        "warmup.detect" | "warmup.list" | "warmup.apply" | "warmup.runNow" => {
            host_warmup(cap, state, headers, body!(serde_json::Value).0).await
        }
        "approvals.request" | "runs.rerunAgent" | "workflows.rerun" => {
            crate::server::app_runs::host_run_recovery(
                cap,
                &state,
                &headers,
                body!(serde_json::Value).0,
            )
            .await
        }
        "realtime.publish" => {
            host_realtime_publish(state, headers, body!(RealtimePublishBody)).await
        }
        // Unreachable: the caller only gets here after `kernel_capability` matched,
        // and that reads the same table this match implements. Fail closed anyway so
        // a future row added to one and not the other cannot 500 or, worse, fall
        // through to the provider path ungated.
        _ => (
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({ "error": "kernel capability has no implementation", "capability": cap })),
        )
            .into_response(),
    }
}

// ── Capability broker (/api/host/capability/:cap) ─────────────────────────────

/// `POST /api/host/capability/:cap` — the **capability broker**. A consumer sidecar
/// invokes an *abstract* capability; Core resolves it to the bound provider app and
/// forwards the call to the provider's declared route using the PROVIDER's minted
/// token (the consumer never sees it). This is where a `requires: [rag]` edge turns
/// into a real call to whichever provider is bound.
///
/// Two kinds of capability share this one route:
///
/// - **Kernel** capabilities ([`KERNEL_CAPABILITIES`]) — host primitives Core itself
///   implements. Authenticated caller + the row's declared∩approved grant, then
///   dispatched IN-PROCESS. This is where the retired `/api/host/<app>/*` callbacks
///   now live.
/// - **App-provided** capabilities — resolved to a bound provider app and proxied to
///   its sidecar route with the PROVIDER's minted token (the consumer never sees it).
///   This is where a `requires: [rag]` edge turns into a real call.
///
/// A **fan-out** capability ([`crate::plugins::binding::FANOUT_CAPABILITIES`]) is
/// neither: Core calls it on every provider itself, and the broker refuses it (404)
/// whatever the caller declares or holds.
///
/// The provider path's three-way check, fail-closed at each step:
/// 1. the CALLER **declared** the edge (its `requires.capabilities` names `cap`) —
///    else 404;
/// 2. the bound **PROVIDER** `provides` `cap`, resolved via the binding registry
///    over the enabled set (Unprovided ⇒ 404, Ambiguous ⇒ 409);
/// 3. the caller **holds** the provider's declared `grant` (Gateway-approved) —
///    else 403.
///
/// A capability with no sidecar/route (in-process) is not broker-proxyable ⇒ 501.
async fn host_capability(
    State(state): State<ServerState>,
    Path(cap): Path<String>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();

    // 1. Authenticate the CALLER (consumer) sidecar.
    let (caller_id, caller_grants) = match authenticate_sidecar(&state, &parts.headers).await {
        Ok(v) => v,
        Err((status, msg)) => return (status, Json(json!({ "error": msg }))).into_response(),
    };

    // 1b. KERNEL capability — Core is the implementation, so there is no provider to
    //     bind and the binding registry (which would answer `Unprovided`) must never
    //     be reached. Gate on the row's grant, then dispatch in-process and return.
    if let Some(kernel) = kernel_capability(&cap) {
        if let Some(grant) = kernel.grant {
            if !holds_host_api_grant(&state, &caller_id, &caller_grants, grant).await {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({ "error": "capability grant not granted", "capability": cap, "grant": grant })),
                )
                    .into_response();
            }
        }
        let bytes = match axum::body::to_bytes(body, DEFAULT_MAX_PROXY_BYTES).await {
            Ok(b) => b,
            Err(_) => {
                return (StatusCode::PAYLOAD_TOO_LARGE, "capability body too large")
                    .into_response();
            }
        };
        return dispatch_kernel_capability(&cap, state, parts.headers, &bytes).await;
    }

    // 1c. FAN-OUT capability (`data.*`, `jobs.*`): served by every app for its OWN
    //     data or jobs, and called only by Core on each provider in turn. Never
    //     brokered: the ordinary ladder would bind a sole provider and let any
    //     sidecar that declared the edge read or run another app's data or jobs.
    if crate::plugins::binding::is_fanout_capability(&cap) {
        return (
            StatusCode::NOT_FOUND,
            Json(
                json!({ "error": "capability not callable through the broker", "capability": cap }),
            ),
        )
            .into_response();
    }

    // 2. The caller must have DECLARED this capability edge; capture its version floor.
    let required = {
        let manifests = state.app_manifests.read().await;
        manifests.iter().find(|m| m.id == caller_id).and_then(|m| {
            m.required_capabilities()
                .iter()
                .find(|r| r.capability == cap)
                .cloned()
        })
    };
    let Some(required) = required else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "capability not required by caller", "capability": cap })),
        )
            .into_response();
    };

    // 3. Resolve the bound provider over the ENABLED manifest set, then pin its
    //    sidecar route — all before any await, so no read guard is held across the
    //    upstream hop.
    let records = match state.app_store.list().await {
        Ok(r) => r,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "lookup failed" })),
            )
                .into_response();
        }
    };
    let enabled_ids: HashSet<String> = records
        .iter()
        .filter(|r| r.enabled)
        .map(|r| r.id.clone())
        .collect();

    let resolved: Result<ProviderRoute, Response> = {
        let manifests = state.app_manifests.read().await;
        let enabled: Vec<crate::plugin_manifest::PluginManifest> = manifests
            .iter()
            .filter(|m| enabled_ids.contains(&m.id))
            .cloned()
            .collect();
        let cfg = crate::plugins::binding::active_config();
        let registry = crate::plugins::binding::BindingRegistry::new(&cfg, &enabled);
        match registry.resolve(&required) {
            Ok(binding) => {
                let provider = enabled.iter().find(|m| m.id == binding.provider_id);
                let entry = provider.and_then(|p| {
                    p.provided_capabilities()
                        .iter()
                        .find(|e| e.capability == cap)
                        .map(|e| (p, e))
                });
                match entry {
                    Some((provider, entry)) => {
                        // Grant gate: the caller must hold the provider's declared grant.
                        if let Some(grant) = &entry.grant {
                            if !caller_grants.contains(grant) {
                                Err((
                                    StatusCode::FORBIDDEN,
                                    Json(json!({ "error": "capability grant not held", "grant": grant })),
                                )
                                    .into_response())
                            } else {
                                resolve_provider_route(provider, entry, &binding.provider_id)
                            }
                        } else {
                            resolve_provider_route(provider, entry, &binding.provider_id)
                        }
                    }
                    None => Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        Json(json!({ "error": "provider not enabled" })),
                    )
                        .into_response()),
                }
            }
            Err(e) => {
                use crate::plugins::binding::BindingError;
                let status = match e {
                    BindingError::Unprovided { .. } => StatusCode::NOT_FOUND,
                    _ => StatusCode::CONFLICT,
                };
                Err((
                    status,
                    Json(json!({ "error": e.to_string(), "code": e.code() })),
                )
                    .into_response())
            }
        }
    };
    let ProviderRoute {
        provider_id,
        sidecar_name,
        upstream_path,
        wake_name,
    } = match resolved {
        Ok(v) => v,
        Err(resp) => return resp,
    };

    // 3b. Wake a lazy/idle-stopped PROVIDER sidecar before forwarding — the broker
    //     analogue of the ext-proxy wake. Reached only after the full 3-way check
    //     (authenticated caller + declared edge + grant held), so no unauthenticated
    //     caller can spin a provider process. `_activity` pins it for the hop.
    let _activity = if let Some(wake) = &wake_name {
        match state
            .manager
            .wake_and_await_healthy(wake, WAKE_WARMUP_TIMEOUT)
            .await
        {
            Ok(woke) => {
                if woke {
                    fire_lazy_activation(&state, ACTIVATION_ON_CAPABILITY_CALL);
                }
            }
            Err(e) => return wake_failed_response("broker", wake, &e, true),
        }
        Some(state.manager.enter_request(wake))
    } else {
        None
    };

    // 3c. The SAME registration gate the inbound proxy applies. The broker used to be
    //     asymmetric with the proxy here: it derived its wake target from the MANIFEST
    //     spec (`spec.lazy || idle_stop_secs`), so a lazy provider that failed to
    //     register at least failed closed on the wake — but an EAGER provider had no
    //     gate at all and forwarded straight to `profile::port(spec.port)`, squatter or
    //     not. Resolving through the manager immediately before dialing closes that hole
    //     and removes the asymmetry: both lanes now dial only a claimed, live port.
    let target = match state.manager.forward_target(&sidecar_name) {
        Ok(t) => t,
        Err(denied) => return sidecar_unavailable(&denied),
    };

    // 4. Forward the caller's body to the provider's route, stamping the PROVIDER's
    //    minted token (forward_to_sidecar overwrites the caller's Authorization).
    let body_bytes = match axum::body::to_bytes(body, DEFAULT_MAX_PROXY_BYTES).await {
        Ok(b) => b.to_vec(),
        Err(_) => {
            return (StatusCode::PAYLOAD_TOO_LARGE, "capability body too large").into_response();
        }
    };
    let query = parts
        .uri
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    forward_to_sidecar(ForwardArgs {
        target,
        upstream_path: &upstream_path,
        query: &query,
        method: reqwest::Method::POST,
        src_headers: &parts.headers,
        body: body_bytes,
        hop_plugin_id: &provider_id,
        forward_payment_authorization: false,
        forward_cookie_names: &[],
        forward_caller_email: false,
        caller: None,
        caller_resource_ids: None,
        caller_rate_subject: None,
        caller_agent_id: None,
        caller_agent_restricted: false,
        event_delivery: None,
    })
    .await
}

/// Pin a provider's [`ProvidesEntry`] to a concrete [`ProviderRoute`] (provider id +
/// sidecar key + upstream path + optional wake target) — resolving the named sidecar's
/// mount + route. Returns a 501 for an in-process capability (no sidecar/route) the
/// broker cannot proxy.
///
/// Deliberately resolves NO port: the port is the manager's to hand out
/// ([`crate::sidecar::SidecarManager::forward_target`]), not the manifest's.
///
/// `pub(crate)` for [`crate::document_parse`], which resolves a `document.parse`
/// provider's sidecar route exactly the way the broker does rather than growing a
/// second, drifting copy of the mount+route+wake derivation.
pub(crate) fn resolve_provider_route(
    provider: &crate::plugin_manifest::PluginManifest,
    entry: &crate::plugin_manifest::ProvidesEntry,
    provider_id: &str,
) -> Result<ProviderRoute, Response> {
    let (Some(sc_name), Some(route)) = (&entry.sidecar, &entry.route) else {
        return Err((
            StatusCode::NOT_IMPLEMENTED,
            Json(json!({ "error": "capability is in-process, not broker-proxyable" })),
        )
            .into_response());
    };
    let Some(spec) = provider.sidecars.iter().find(|s| &s.name == sc_name) else {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "provider sidecar missing" })),
        )
            .into_response());
    };
    let mount = spec
        .http
        .as_ref()
        .and_then(|h| h.mount.as_deref())
        .map(|m| m.trim_end_matches('/').to_owned())
        .unwrap_or_default();
    // The manager key for the provider's sidecar. Computed UNCONDITIONALLY: it is now
    // the route's only handle on a port (the caller resolves it through
    // `SidecarManager::forward_target` right before dialing), separate from the
    // should-I-wake hint below which stays manifest-derived.
    let sidecar_name = crate::sidecar::manifest_sidecar::namespaced_name(provider_id, &spec.name);
    // If the provider sidecar opted into on-demand start, name it so the broker can
    // wake it before forwarding (the capability-broker analogue of the ext-proxy wake).
    let wake_name = (spec.lazy || spec.idle_stop_secs.is_some()).then(|| sidecar_name.clone());
    Ok(ProviderRoute {
        provider_id: provider_id.to_owned(),
        sidecar_name,
        // Same root rule as the inbound proxy: a declared `"/"` route forwards to the
        // bare mount, because sidecars nest their routers there and `{mount}/` 404s.
        upstream_path: upstream_path_for(&mount, route),
        wake_name,
    })
}

/// Wake (when lazy) and pin a resolved provider route to the manager's live,
/// registered target — the broker's step 3b + 3c, shared with the Core-as-consumer
/// helper ([`crate::sidecar::capability_consumer`]) so both lanes apply the SAME
/// registration gate before handing a provider its minted token. The returned guard
/// (if any) must stay alive across the hop so an idle-stop sidecar is not reaped
/// between the wake and the call.
pub(crate) async fn provider_target(
    manager: &std::sync::Arc<crate::sidecar::SidecarManager>,
    route: &ProviderRoute,
) -> Result<
    (
        ForwardTarget,
        Option<crate::sidecar::manager::ActivityGuard>,
    ),
    String,
> {
    let activity = if let Some(wake) = &route.wake_name {
        manager
            .wake_and_await_healthy(wake, WAKE_WARMUP_TIMEOUT)
            .await
            .map_err(|e| format!("waking provider '{wake}' failed: {e}"))?;
        Some(manager.enter_request(wake))
    } else {
        None
    };
    let target = manager
        .forward_target(&route.sidecar_name)
        .map_err(|denied| denied.reason())?;
    Ok((target, activity))
}

/// POST a JSON body to a resolved provider route through [`forward_to_sidecar`] —
/// the single Core→sidecar hop the ext-proxy and the broker share — stamping the
/// PROVIDER's minted token. No caller identity, cookies, or payment headers are
/// forwarded: Core itself is the consumer.
pub(crate) async fn post_to_provider(
    target: ForwardTarget,
    route: &ProviderRoute,
    body: Vec<u8>,
) -> Response {
    post_to_provider_hop(target, route, body, None).await
}

/// [`post_to_provider`] for a Core event delivery: also stamps
/// [`HDR_EVENT_DELIVERY`] with `delivery_id`, which no other hop can carry.
pub(crate) async fn post_event_delivery(
    target: ForwardTarget,
    route: &ProviderRoute,
    body: Vec<u8>,
    delivery_id: &str,
) -> Response {
    post_to_provider_hop(target, route, body, Some(delivery_id)).await
}

async fn post_to_provider_hop(
    target: ForwardTarget,
    route: &ProviderRoute,
    body: Vec<u8>,
    event_delivery: Option<&str>,
) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/json"),
    );
    forward_to_sidecar(ForwardArgs {
        target,
        upstream_path: &route.upstream_path,
        query: "",
        method: reqwest::Method::POST,
        src_headers: &headers,
        body,
        hop_plugin_id: &route.provider_id,
        forward_payment_authorization: false,
        forward_cookie_names: &[],
        forward_caller_email: false,
        caller: None,
        caller_resource_ids: None,
        caller_rate_subject: None,
        caller_agent_id: None,
        caller_agent_restricted: false,
        event_delivery,
    })
    .await
}

/// A resolved broker target: where to forward + how to wake the provider sidecar.
///
/// `pub(crate)` alongside [`resolve_provider_route`] — the facade in
/// [`crate::document_parse`] holds one of these across its submit/poll hops.
#[derive(Debug, Clone)]
pub(crate) struct ProviderRoute {
    pub(crate) provider_id: String,
    /// The manager key (`<plugin_id>/<local_name>`) of the provider's sidecar. NOT a
    /// port: every consumer resolves this through
    /// [`crate::sidecar::SidecarManager::forward_target`] immediately before dialing, so
    /// a provider that never registered (its declared port is held by some other host
    /// process) is refused instead of handed the caller's body and the provider's minted
    /// token. See [`ForwardTarget`].
    pub(crate) sidecar_name: String,
    pub(crate) upstream_path: String,
    /// The manager key to wake before forwarding, when the provider sidecar is
    /// lazy/idle-eligible; `None` for an eager provider (forward directly).
    pub(crate) wake_name: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End to end through the real `events.emit` handler: an app's own declared
    /// event carrying an `activity` hint lands on the activity feed attributed to
    /// the AUTHENTICATED caller; a `core#` kernel event is refused outright.
    #[tokio::test]
    async fn events_emit_records_owner_attributed_activity_and_refuses_kernel_events() {
        const APP: &str = "@example/feedapp";
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        state.app_store.insert(APP, "1.0.0").await.unwrap();
        state.app_store.set_enabled(APP, &[]).await.unwrap();
        let manifest: crate::plugin_manifest::PluginManifest = serde_json::from_value(json!({
            "id": APP, "name": "Feed", "version": "1.0.0", "runnables": [],
            "contributes": { "hook_events": [
                { "id": "@example/feedapp#thing.done", "title": "Thing done" }
            ] }
        }))
        .unwrap();
        state.app_manifests.write().await.push(manifest);
        let mut headers = HeaderMap::new();
        headers.insert(HDR_PLUGIN_ID, APP.parse().unwrap());
        headers.insert(
            "authorization",
            format!("Bearer {}", ext_token(None, APP)).parse().unwrap(),
        );

        let emit = |event: &str| EventEmitBody {
            event: event.to_owned(),
            payload: json!({ "id": "t1" }),
            conversation_id: None,
            notify: None,
            activity: Some(crate::plugin_host::AppEventActivity {
                kind: "thing".to_owned(),
                title: "Thing done: t1".to_owned(),
                body: None,
                level: Some("success".to_owned()),
                metadata: Some(json!({ "thing_id": "t1" })),
            }),
        };
        let ok = host_events_emit(
            state.clone(),
            headers.clone(),
            Json(emit("@example/feedapp#thing.done")),
        )
        .await;
        assert_eq!(ok.status(), StatusCode::OK);
        let rows = state.activity.list(10, None).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, "feedapp");
        assert_eq!(rows[0].title, "Thing done: t1");
        assert_eq!(rows[0].metadata["thing_id"], "t1");

        let refused = host_events_emit(state.clone(), headers, Json(emit("core#run.failed"))).await;
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        assert_eq!(state.activity.list(10, None).await.unwrap().len(), 1);
    }

    /// A sidecar reaches `warmup.*` only with `warmup:crud` both declared in its
    /// `host_api.grants` and approved; the owner is its authenticated id.
    #[tokio::test]
    async fn warmup_kernel_capability_requires_the_declared_and_approved_grant() {
        const APP: &str = "@example/pinger";
        let directory = tempfile::tempdir().unwrap();
        let jobs = directory.path().join("jobs");
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        state.app_store.insert(APP, "1.0.0").await.unwrap();
        state
            .app_store
            .set_enabled(APP, &["warmup:crud".to_owned()])
            .await
            .unwrap();
        let manifest = |host_grants: Vec<&str>| -> crate::plugin_manifest::PluginManifest {
            serde_json::from_value(json!({
                "id": APP, "name": "Pinger", "version": "1.0.0", "runnables": [],
                "permission_grants": ["warmup:crud"],
                "sidecars": [{ "name": "svc", "port": 18999,
                               "process": { "kind": "local", "command": "true" },
                               "host_api": { "grants": host_grants } }],
            }))
            .unwrap()
        };
        let call = |state: ServerState| async move {
            let request = Request::builder()
                .method("POST")
                .header(HDR_PLUGIN_ID, APP)
                .header("authorization", format!("Bearer {}", ext_token(None, APP)))
                .body(axum::body::Body::from("{}"))
                .unwrap();
            let response =
                host_capability(State(state), Path("warmup.list".to_owned()), request).await;
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .unwrap();
            (
                status,
                serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            )
        };
        crate::scheduler::store::with_test_jobs_directory(jobs, async {
            let mut foreign = crate::scheduler::store::ScheduledJob {
                id: "foreign".to_owned(),
                name: "foreign".to_owned(),
                schedule: crate::scheduler::store::Schedule::Every {
                    interval: "1h".to_owned(),
                },
                target: crate::scheduler::store::JobTarget::Agent {
                    agent_id: "a".to_owned(),
                    prompt: "p".to_owned(),
                    model: None,
                    conversation_id: None,
                },
                enabled: true,
                require_approval: false,
                owner_app: Some("@example/other".to_owned()),
                owner_user_id: None,
                org_id: None,
                created_at: "now".to_owned(),
                updated_at: "now".to_owned(),
                last_run_at: None,
                last_outcome: None,
                history: Vec::new(),
            };
            crate::scheduler::store::save_job(&foreign).unwrap();
            foreign.id = "own".to_owned();
            foreign.owner_app = Some(APP.to_owned());
            crate::scheduler::store::save_job(&foreign).unwrap();

            // Approved but not declared as a host-API grant: refused.
            state.app_manifests.write().await.push(manifest(vec![]));
            let (status, body) = call(state.clone()).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

            // Declared and approved: answers with the caller's own jobs only.
            state.app_manifests.write().await.clear();
            state
                .app_manifests
                .write()
                .await
                .push(manifest(vec!["warmup:crud"]));
            let (status, body) = call(state.clone()).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            let ids: Vec<&str> = body["jobs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|j| j["id"].as_str().unwrap())
                .collect();
            assert_eq!(ids, vec!["own"]);
        })
        .await;
    }

    /// Records what the run-recovery capabilities asked Core to do.
    #[derive(Default)]
    struct RecordingRunHost {
        approvals: std::sync::Mutex<Vec<crate::approvals::ApprovalRequest>>,
        agent_reruns: std::sync::Mutex<Vec<(Option<String>, String, String)>>,
        workflow_reruns: std::sync::Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl crate::server::app_runs::RunRecoveryHost for RecordingRunHost {
        async fn request_approval(
            &self,
            request: crate::approvals::ApprovalRequest,
        ) -> Result<Option<String>, crate::server::app_runs::RunOpError> {
            let id = request.id.clone();
            self.approvals.lock().unwrap().push(request);
            Ok(Some(id))
        }
        fn start_agent_rerun(
            &self,
            agent_id: Option<String>,
            run_id: String,
            prompt: String,
        ) -> Result<(), crate::server::app_runs::RunOpError> {
            self.agent_reruns
                .lock()
                .unwrap()
                .push((agent_id, run_id, prompt));
            Ok(())
        }
        fn start_workflow_rerun(
            &self,
            source_id: String,
        ) -> Result<(), crate::server::app_runs::RunOpError> {
            self.workflow_reruns.lock().unwrap().push(source_id);
            Ok(())
        }
    }

    /// Each run-recovery capability is refused unless its OWN grant is declared in
    /// `host_api.grants` and approved, and with it does exactly what
    /// `CoreHealingHost` did: the heal approval kinds, a `healrun_` agent re-run id
    /// Core mints, and a workflow re-run of the named run.
    #[tokio::test]
    async fn run_recovery_capabilities_are_each_gated_by_their_own_grant() {
        use crate::server::app_runs::{
            GRANT_APPROVALS_REQUEST, GRANT_RERUN_AGENT, GRANT_WORKFLOW_RUNSTATE, TEST_HOST,
        };
        const APP: &str = "@example/healer";
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        state.app_store.insert(APP, "1.0.0").await.unwrap();
        let all = [
            GRANT_APPROVALS_REQUEST,
            GRANT_RERUN_AGENT,
            GRANT_WORKFLOW_RUNSTATE,
        ];
        let manifest = |host_grants: &[&str]| -> crate::plugin_manifest::PluginManifest {
            serde_json::from_value(json!({
                "id": APP, "name": "Healer", "version": "1.0.0", "runnables": [],
                "permission_grants": all,
                "sidecars": [{ "name": "svc", "port": 18998,
                               "process": { "kind": "local", "command": "true" },
                               "host_api": { "grants": host_grants } }],
            }))
            .unwrap()
        };
        let call = |state: ServerState, cap: &'static str, body: serde_json::Value| async move {
            let request = Request::builder()
                .method("POST")
                .header(HDR_PLUGIN_ID, APP)
                .header("authorization", format!("Bearer {}", ext_token(None, APP)))
                .body(axum::body::Body::from(body.to_string()))
                .unwrap();
            let response = host_capability(State(state), Path(cap.to_owned()), request).await;
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .unwrap();
            (
                status,
                serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_default(),
            )
        };
        let cases: [(&'static str, &str, serde_json::Value); 3] = [
            (
                "approvals.request",
                GRANT_APPROVALS_REQUEST,
                json!({ "kind": "heal_fix", "source_id": "conv-1", "agent_id": "a1",
                        "diagnosis": "bad query", "corrected": "search for X" }),
            ),
            (
                "runs.rerunAgent",
                GRANT_RERUN_AGENT,
                json!({ "agent_id": "a1", "prompt": "search for X" }),
            ),
            (
                "workflows.rerun",
                GRANT_WORKFLOW_RUNSTATE,
                json!({ "source_id": "run-9" }),
            ),
        ];
        let host = std::sync::Arc::new(RecordingRunHost::default());
        TEST_HOST
            .scope(host.clone(), async {
                for (cap, grant, body) in &cases {
                    // Approved, but the sidecar declares every grant EXCEPT this one.
                    let others: Vec<&str> = all.iter().copied().filter(|g| g != grant).collect();
                    state
                        .app_store
                        .set_enabled(APP, &all.map(str::to_owned))
                        .await
                        .unwrap();
                    *state.app_manifests.write().await = vec![manifest(&others)];
                    let (status, _) = call(state.clone(), cap, body.clone()).await;
                    assert_eq!(status, StatusCode::FORBIDDEN, "{cap} without its grant");
                    // Declared, but the Gateway approved every grant EXCEPT this one.
                    *state.app_manifests.write().await = vec![manifest(&all)];
                    let approved: Vec<String> = others.iter().map(|g| (*g).to_owned()).collect();
                    state.app_store.set_enabled(APP, &approved).await.unwrap();
                    let (status, _) = call(state.clone(), cap, body.clone()).await;
                    assert_eq!(status, StatusCode::FORBIDDEN, "{cap} unapproved");
                }
                assert!(host.approvals.lock().unwrap().is_empty());
                assert!(host.agent_reruns.lock().unwrap().is_empty());
                assert!(host.workflow_reruns.lock().unwrap().is_empty());

                // Declared and approved: each one acts.
                state
                    .app_store
                    .set_enabled(APP, &all.map(str::to_owned))
                    .await
                    .unwrap();
                for (cap, _, body) in &cases {
                    let (status, reply) = call(state.clone(), cap, body.clone()).await;
                    assert!(status.is_success(), "{cap}: {status} {reply}");
                }
            })
            .await;

        let approvals = host.approvals.lock().unwrap();
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].kind, crate::approvals::ApprovalKind::HealFix);
        assert_eq!(approvals[0].source_ref.as_deref(), Some("conv-1"));
        let reruns = host.agent_reruns.lock().unwrap();
        assert_eq!(reruns.len(), 1);
        assert_eq!(reruns[0].0.as_deref(), Some("a1"));
        assert!(reruns[0].1.starts_with(ryu_healing_contracts::HEAL_PREFIX));
        assert_eq!(reruns[0].2, "search for X");
        assert_eq!(*host.workflow_reruns.lock().unwrap(), vec!["run-9"]);
    }

    /// A fan-out capability is never brokered: a sidecar that declares the edge
    /// and holds the provider's grant is still refused before any binding, so it
    /// cannot run or purge another app's jobs or data even when that app is the
    /// sole provider.
    #[tokio::test]
    async fn fanout_capabilities_are_refused_by_the_broker() {
        const CALLER: &str = "@example/curious";
        const PROVIDER: &str = "@example/owner";
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        for (id, grants) in [
            (
                CALLER,
                vec!["owner:jobs".to_owned(), "owner:data".to_owned()],
            ),
            (PROVIDER, Vec::new()),
        ] {
            state.app_store.insert(id, "1.0.0").await.unwrap();
            state.app_store.set_enabled(id, &grants).await.unwrap();
        }
        let caller: crate::plugin_manifest::PluginManifest = serde_json::from_value(json!({
            "id": CALLER, "name": "Curious", "version": "1.0.0", "runnables": [],
            "permission_grants": ["owner:jobs", "owner:data"],
            "requires": { "capabilities": [
                { "capability": "jobs.run" }, { "capability": "data.purge" }
            ] },
            "sidecars": [{ "name": "svc", "port": 18997,
                           "process": { "kind": "local", "command": "true" } }],
        }))
        .unwrap();
        let provider: crate::plugin_manifest::PluginManifest = serde_json::from_value(json!({
            "id": PROVIDER, "name": "Owner", "version": "1.0.0", "runnables": [],
            "sidecars": [{ "name": "svc", "port": 18996,
                           "process": { "kind": "local", "command": "true" },
                           "http": { "mount": "/api/owner", "routes": [
                               { "path": "/run", "method": "POST" },
                               { "path": "/purge", "method": "POST" }
                           ] } }],
            "provides": [
                { "capability": "jobs.run", "version": "1.0.0", "sidecar": "svc",
                  "route": "/run", "grant": "owner:jobs" },
                { "capability": "data.purge", "version": "1.0.0", "sidecar": "svc",
                  "route": "/purge", "grant": "owner:data" }
            ],
        }))
        .unwrap();
        *state.app_manifests.write().await = vec![caller, provider];
        for cap in ["jobs.run", "data.purge"] {
            let request = Request::builder()
                .method("POST")
                .header(HDR_PLUGIN_ID, CALLER)
                .header(
                    "authorization",
                    format!("Bearer {}", ext_token(None, CALLER)),
                )
                .body(axum::body::Body::from(r#"{"id":"j1","category":"x"}"#))
                .unwrap();
            let response =
                host_capability(State(state.clone()), Path(cap.to_owned()), request).await;
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .unwrap();
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(status, StatusCode::NOT_FOUND, "{cap}: {body}");
            assert_eq!(body["error"], "capability not callable through the broker");
            assert_eq!(body["capability"], cap);
        }
    }

    #[test]
    fn a_still_starting_wake_is_a_retryable_503_and_a_failed_start_is_not() {
        let starting = anyhow::Error::new(crate::sidecar::manager::SidecarStillStarting {
            name: "com.acme.tool/engine".to_owned(),
            waited: std::time::Duration::from_secs(20),
        });
        let response = wake_failed_response("test", "com.acme.tool/engine", &starting, false);
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            response.headers().get(axum::http::header::RETRY_AFTER),
            Some(&axum::http::HeaderValue::from_static(WAKE_RETRY_AFTER_SECS))
        );

        let failed = anyhow::anyhow!("pip install failed");
        let response = wake_failed_response("test", "com.acme.tool/engine", &failed, true);
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(response
            .headers()
            .get(axum::http::header::RETRY_AFTER)
            .is_none());
    }

    #[test]
    fn ext_token_is_random_per_plugin_and_owner_token_independent() {
        let a1 = ext_token(Some("node-secret"), "com.acme.a");
        let a2 = ext_token(Some("node-secret"), "com.acme.a");
        let b = ext_token(Some("node-secret"), "com.acme.b");
        assert_eq!(a1, a2, "one plugin keeps one credential");
        assert_ne!(a1, b, "plugin A's token must never equal plugin B's");
        assert_eq!(ext_token(Some("other"), "com.acme.a"), a1);
        assert!(a1.starts_with("ryux_"));
        assert_eq!(a1.len(), 69);
    }

    #[test]
    fn route_matches_literals_params_and_wildcards() {
        // Literal.
        assert!(route_matches("/status", "/status"));
        assert!(!route_matches("/status", "/other"));
        // `:param` matches exactly one non-empty segment (mail's /inboxes/:id).
        assert!(route_matches("/inboxes/:id", "/inboxes/abc"));
        assert!(!route_matches("/inboxes/:id", "/inboxes")); // too short
        assert!(!route_matches("/inboxes/:id", "/inboxes/abc/extra")); // too long
                                                                       // Undeclared subpath of a declared prefix is NOT admitted (no wildcard).
        assert!(!route_matches("/inboxes", "/inboxes/abc"));
        // Trailing wildcard matches the remainder.
        assert!(route_matches("/files/*rest", "/files/a/b/c"));
        assert!(route_matches("/files/*rest", "/files/a"));
        // Multi-segment literal + param.
        assert!(route_matches("/inboxes/:id/send", "/inboxes/xyz/send"));
        assert!(!route_matches("/inboxes/:id/send", "/inboxes/xyz/recv"));
    }

    #[test]
    fn route_resolution_prefers_a_specific_literal_over_a_broad_param() {
        let mut manifest = provider_manifest(9099, None);
        let http = manifest.sidecars[0]
            .http
            .as_mut()
            .expect("the provider fixture declares http");
        let mut broad = route("/:id", None, None);
        broad.auth = crate::plugin_manifest::schema::RouteAuth::Public;
        http.routes = vec![broad, route("/admin", None, None)];

        let (_, _, matched) = resolve_route(&manifest, "/admin", "GET").expect("a route resolves");
        assert_eq!(matched.path, "/admin");
        assert_eq!(
            matched.auth,
            crate::plugin_manifest::schema::RouteAuth::Protected
        );
    }

    #[test]
    fn route_resolution_fails_closed_on_equal_specificity_ties() {
        let mut manifest = provider_manifest(9099, None);
        let http = manifest.sidecars[0]
            .http
            .as_mut()
            .expect("the provider fixture declares http");
        http.routes = vec![route("/:id", None, None), route("/:slug", None, None)];

        assert!(
            resolve_route(&manifest, "/admin", "GET").is_none(),
            "equal-specificity routes must not fall back to declaration order"
        );
    }

    #[test]
    fn route_resolution_fails_closed_on_cross_sidecar_ties() {
        let mut manifest = provider_manifest(9099, None);
        manifest.sidecars[0]
            .http
            .as_mut()
            .expect("provider http")
            .routes = vec![route("/:id", None, None)];
        let mut second = manifest.sidecars[0].clone();
        second.name = "other".to_owned();
        second.port = 9100;
        second.http.as_mut().expect("provider http").routes = vec![route("/:slug", None, None)];
        manifest.sidecars.push(second);

        assert!(resolve_route(&manifest, "/admin", "GET").is_none());
    }

    #[test]
    fn dot_segments_are_rejected() {
        // The traversal-to-auth-confusion guard: any `.`/`..` segment is refused so a
        // raw sub-path can never match a Public route yet normalize onto a Protected
        // mount after reqwest collapses `..`.
        assert!(has_dot_segment("/webhook/../admin"));
        assert!(has_dot_segment("/webhook/..")); // trailing
        assert!(has_dot_segment("/a/./b"));
        assert!(has_dot_segment("..")); // no leading slash
                                        // Legitimate paths (including a dot INSIDE a segment) are untouched.
        assert!(!has_dot_segment("/webhook/abc"));
        assert!(!has_dot_segment("/files/a.b.c/d"));
        assert!(!has_dot_segment("/inboxes/:id"));
        assert!(!has_dot_segment(""));
    }

    #[test]
    fn multiply_encoded_dot_segments_are_rejected() {
        for path in [
            "/admin%2Fforms",
            "/admin%252Fforms",
            "/admin%5cforms",
            "/admin%255cforms",
        ] {
            assert!(has_dot_segment(path));
        }
        // The single-decode assumption this guard used to rest on holds for a route,
        // but not for a path parameter VALUE. A derived tool fills `{id}` from model
        // arguments and `build_rest_request` percent-encodes on the way in, so a model
        // sending `%2e%2e` arrives here as `%2e%2e` after the extractor's one decode —
        // which is not the literal `..`, but the sidecar's own framework will decode it
        // a second time and get one.
        assert!(has_dot_segment("/records/%2e%2e/admin"));
        assert!(has_dot_segment("/records/%2E%2E/admin"));
        assert!(has_dot_segment("/records/.%2e/admin"));
        assert!(has_dot_segment("/records/%2e./admin"));
        // Separator that only appears after decoding: the pre-decode split never saw
        // a boundary here, so only re-splitting on the next round catches it.
        assert!(has_dot_segment("/webhook/..%2fadmin"));
        assert!(has_dot_segment("/webhook/%2e%2e%2fadmin"));
        // Double-encoded, i.e. what `urlencoding::encode("%2e%2e")` actually produces.
        assert!(has_dot_segment("/records/%252e%252e/admin"));

        // Encoded content that is NOT a dot segment still passes — the guard must not
        // become "reject anything with a percent sign", or ordinary ids with spaces in them stop working. Encoded separators
        // remain ambiguous across the proxy and sidecar and are refused.
        assert!(!has_dot_segment("/records/my%20record/fields"));
        assert!(!has_dot_segment("/records/a%2Eb/fields"));
        assert!(!has_dot_segment("/search/%7Bquery%7D"));
    }

    /// Every plugin's public routes refuse a raw URI whose decoding would introduce a
    /// dot segment or a new separator, not just one app's. Protected routes are left
    /// to the decoded-path check in [`resolve_route`].
    #[test]
    fn public_routes_refuse_encoded_separators_in_the_raw_uri_for_every_plugin() {
        for raw in [
            "/bots/support%2F..%2Fadmin",
            "/f/contact/%2e%2e/admin",
            "/api/ext/@ryu/bot-flows/support%2Fsessions",
            "/api/ext/@ryu/anything/hook/..%5Cadmin",
            "/bots/support/../admin",
        ] {
            assert!(
                public_route_raw_path_is_unsafe(RouteAuth::Public, raw),
                "public route must refuse {raw}"
            );
            assert!(
                !public_route_raw_path_is_unsafe(RouteAuth::Protected, raw),
                "protected routes keep only the decoded-path check: {raw}"
            );
        }
        for raw in [
            "/bots/support",
            "/bots/support/embed.js",
            "/api/ext/@ryu/bot-flows/support/sessions/abc123/reply",
            "/f/my%20form",
        ] {
            assert!(
                !public_route_raw_path_is_unsafe(RouteAuth::Public, raw),
                "clean public path must pass: {raw}"
            );
        }
    }

    /// `GET /api/ext/<app>/<victim>%3F` reaches the proxy as the sub-path `/<victim>?`.
    /// The gates must never match it (they would check the resource `<victim>?`) while
    /// the forward ends the path at the `?` and the sidecar serves `/<victim>`.
    #[test]
    fn query_and_fragment_delimiters_in_a_sub_path_resolve_no_route() {
        let mut manifest = provider_manifest(9099, None);
        manifest.sidecars[0]
            .http
            .as_mut()
            .expect("the provider fixture declares http")
            .routes = vec![route("/:id", Some("jobs.view"), Some("id"))];

        let (_, _, matched) = resolve_route(&manifest, "/job-1", "GET").expect("plain id");
        assert_eq!(
            required_permission_for(matched, "/job-1", &manifest.id),
            Some(("jobs.view".to_owned(), "job-1".to_owned()))
        );
        for sub_path in [
            "/job-1?",
            "/job-1?x=1",
            "/job-1#",
            "/job-1#frag",
            "/job-1%3F",
            "/job-1%3f",
            "/job-1%23",
            "/job-1%253F",
        ] {
            assert!(
                resolve_route(&manifest, sub_path, "GET").is_none(),
                "{sub_path} must not resolve"
            );
        }
        assert!(has_query_or_fragment_delimiter("/a/b?c"));
        assert!(!has_query_or_fragment_delimiter("/records/my%20record"));
        assert!(!has_query_or_fragment_delimiter(""));
    }

    /// A manifest with a Public `/*rest`, a Public `/webhook/*rest` and a Protected
    /// `/admin`: the shape where a rewritten forward path crosses the auth boundary.
    fn public_wildcards_beside_a_protected_route() -> crate::plugin_manifest::PluginManifest {
        let mut manifest = provider_manifest(9099, None);
        let mut catch_all = route("/*rest", None, None);
        catch_all.auth = RouteAuth::Public;
        let mut webhook = route("/webhook/*rest", None, None);
        webhook.auth = RouteAuth::Public;
        manifest.sidecars[0]
            .http
            .as_mut()
            .expect("the provider fixture declares http")
            .routes = vec![catch_all, webhook, route("/admin", None, None)];
        manifest
    }

    /// `GET /api/ext/<app>/webhook/.%09./admin` reaches the proxy as the sub-path
    /// `/webhook/.<TAB>./admin`. No segment is literally `..`, so the Public
    /// `/webhook/*rest` route matches it, yet the URL parser behind the forward deletes
    /// the tab, sees `..`, and the sidecar serves the Protected `/admin` with Core's hop
    /// bearer. Deletion alone forwards `/ad<TAB>min` (matched by the Public `/*rest`)
    /// as `/admin`.
    #[test]
    fn tabs_and_newlines_the_forward_url_parser_deletes_resolve_no_route() {
        let manifest = public_wildcards_beside_a_protected_route();

        // The disagreement being guarded: the path the forward actually requests.
        for (forwarded, requested) in [
            ("http://127.0.0.1:9099/webhook/.\t./admin", "/admin"),
            ("http://127.0.0.1:9099/webhook/.\n./admin", "/admin"),
            ("http://127.0.0.1:9099/webhook/.\r./admin", "/admin"),
            ("http://127.0.0.1:9099/ad\tmin", "/admin"),
            // Other characters inside the path are percent-encoded, not dropped, so
            // the sidecar receives what the gates matched.
            ("http://127.0.0.1:9099/webhook/a\u{0}b", "/webhook/a%00b"),
            (
                "http://127.0.0.1:9099/webhook/my record",
                "/webhook/my%20record",
            ),
        ] {
            let url = url::Url::parse(forwarded).expect("the forward URL parses");
            assert_eq!(url.path(), requested, "{forwarded:?}");
        }

        for sub_path in [
            "/webhook/.\t./admin",
            "/webhook/.\n./admin",
            "/webhook/.\r./admin",
            "/ad\tmin",
            // One layer deeper: the sidecar's own framework may decode once more.
            "/webhook/.%09./admin",
            "/webhook/.%0A./admin",
            "/webhook/.%2509./admin",
        ] {
            assert!(
                has_url_parser_deleted_character(sub_path),
                "{sub_path:?} holds a deleted character"
            );
            assert!(
                resolve_route(&manifest, sub_path, "GET").is_none(),
                "{sub_path:?} must not resolve"
            );
        }

        // Ordinary paths, and characters the forward carries faithfully, still resolve.
        let (_, _, matched) = resolve_route(&manifest, "/admin", "GET").expect("/admin");
        assert_eq!(matched.path, "/admin");
        for sub_path in [
            "/webhook/abc",
            "/webhook/my record",
            "/webhook/my%20record",
            "/webhook/name ",
            "/webhook/a\u{0}b",
            "/webhook/a.b",
        ] {
            assert!(!has_url_parser_deleted_character(sub_path), "{sub_path:?}");
            let (_, _, matched) = resolve_route(&manifest, sub_path, "GET")
                .unwrap_or_else(|| panic!("{sub_path:?} must resolve"));
            assert_eq!(matched.path, "/webhook/*rest");
        }
    }

    /// The forward's URL parser trims spaces and C0 controls off the end of the WHOLE
    /// URL, so they come off the path when no query follows it, and only then. Each
    /// refused case is one the forward would already send to a different path.
    #[test]
    fn a_trailing_space_or_control_is_refused_only_where_the_forward_trims_it() {
        // Trimmed: the sidecar would be asked for a different path from the gated one.
        for (sub_path, forwarded, requested) in [
            ("/webhook/.. ", "http://127.0.0.1:9099/webhook/.. ", "/"),
            (
                "/webhook/..\u{0}",
                "http://127.0.0.1:9099/webhook/..\u{0}",
                "/",
            ),
            ("/admin ", "http://127.0.0.1:9099/admin ", "/admin"),
            (
                "/webhook/x ",
                "http://127.0.0.1:9099/webhook/x ",
                "/webhook/x",
            ),
            (
                "/webhook/x \u{1f}",
                "http://127.0.0.1:9099/webhook/x \u{1f}",
                "/webhook/x",
            ),
        ] {
            let url = url::Url::parse(forwarded).expect("the forward URL parses");
            assert_eq!(url.path(), requested, "{forwarded:?}");
            assert!(
                forward_url_trims_path_end(sub_path, None),
                "{sub_path:?} without a query must be refused"
            );
        }

        // Not trimmed: a query follows the path (even an empty one), or the space is
        // still encoded. The sidecar receives the path the gates matched.
        for (sub_path, query, forwarded, requested) in [
            (
                "/webhook/x ",
                Some("x=1"),
                "http://127.0.0.1:9099/webhook/x ?x=1",
                "/webhook/x%20",
            ),
            (
                "/webhook/x ",
                Some(""),
                "http://127.0.0.1:9099/webhook/x ?",
                "/webhook/x%20",
            ),
            (
                "/webhook/..\u{0}",
                Some("x=1"),
                "http://127.0.0.1:9099/webhook/..\u{0}?x=1",
                "/webhook/..%00",
            ),
            (
                "/webhook/x%20",
                None,
                "http://127.0.0.1:9099/webhook/x%20",
                "/webhook/x%20",
            ),
        ] {
            let url = url::Url::parse(forwarded).expect("the forward URL parses");
            assert_eq!(url.path(), requested, "{forwarded:?}");
            assert!(!forward_url_trims_path_end(sub_path, query), "{sub_path:?}");
        }
        assert!(!forward_url_trims_path_end("/", None));
        assert!(!forward_url_trims_path_end("/webhook/my record", None));
    }

    /// The WebSocket bridge parses its upstream URL as an `http::Uri`, which refuses a
    /// literal space or control character, so that lane can never forward a path the
    /// HTTP lane's parser would trim or delete characters from.
    #[test]
    fn the_ws_bridge_never_forwards_a_space_or_control_character() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        for url in [
            "ws://127.0.0.1:9099/admin ",
            "ws://127.0.0.1:9099/webhook/..\u{0}",
            "ws://127.0.0.1:9099/webhook/.\t./admin",
        ] {
            assert!(url.into_client_request().is_err(), "{url:?}");
        }
        assert!("ws://127.0.0.1:9099/webhook/x%20"
            .into_client_request()
            .is_ok());
    }

    /// End to end through the real `/api/ext` router, so axum's decoding of the request
    /// path is part of the test: every path the forward would rewrite is refused (404)
    /// before any auth decision or sidecar gate, while the forms the forward carries
    /// faithfully still reach the registration gate (503: no sidecar is registered in
    /// this isolated state).
    #[tokio::test]
    async fn the_ext_lane_refuses_paths_the_forward_would_rewrite() {
        use tower::ServiceExt as _;

        const APP: &str = "@acme/rewrite";
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        state.app_store.insert(APP, "1.0.0").await.unwrap();
        state.app_store.set_enabled(APP, &[]).await.unwrap();
        let mut manifest = web_app(APP, None, false, &[]);
        let mut webhook = route("/webhook/*rest", None, None);
        webhook.auth = RouteAuth::Public;
        manifest.sidecars[0]
            .http
            .as_mut()
            .expect("the web app fixture declares http")
            .routes = vec![webhook, route("/admin", None, None)];
        state.app_manifests.write().await.push(manifest);
        let router = ext_routes(None).with_state(state);

        for (path, expected) in [
            ("/webhook/.%09./admin", StatusCode::NOT_FOUND),
            ("/webhook/.%0A./admin", StatusCode::NOT_FOUND),
            ("/webhook/.%0D./admin", StatusCode::NOT_FOUND),
            ("/webhook/.%2509./admin", StatusCode::NOT_FOUND),
            ("/webhook/..%20", StatusCode::NOT_FOUND),
            ("/webhook/..%00", StatusCode::NOT_FOUND),
            ("/webhook/x%20", StatusCode::NOT_FOUND),
            ("/webhook/x%20?x=1", StatusCode::SERVICE_UNAVAILABLE),
            ("/webhook/x%20?", StatusCode::SERVICE_UNAVAILABLE),
            ("/webhook/name%2520", StatusCode::SERVICE_UNAVAILABLE),
            ("/webhook/my%20record", StatusCode::SERVICE_UNAVAILABLE),
            ("/webhook/abc", StatusCode::SERVICE_UNAVAILABLE),
        ] {
            let request = Request::builder()
                .method("GET")
                .uri(format!("/api/ext/{APP}{path}"))
                .body(Body::empty())
                .unwrap();
            let response = router.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), expected, "{path}");
        }
    }

    // ── App-declared route permissions ──────────────────────────────────────────

    fn route(
        path: &str,
        permission: Option<&str>,
        resource_param: Option<&str>,
    ) -> crate::plugin_manifest::schema::RouteSpec {
        crate::plugin_manifest::schema::RouteSpec {
            path: path.to_owned(),
            method: None,
            auth: Default::default(),
            permission: permission.map(str::to_owned),
            resource_param: resource_param.map(str::to_owned),
        }
    }

    fn route_for_method(
        path: &str,
        method: &str,
        permission: &str,
    ) -> crate::plugin_manifest::schema::RouteSpec {
        crate::plugin_manifest::schema::RouteSpec {
            path: path.to_owned(),
            method: Some(method.to_owned()),
            auth: Default::default(),
            permission: Some(permission.to_owned()),
            resource_param: None,
        }
    }

    /// The back-compat property the whole gate rests on: a route nobody annotated
    /// imposes NOTHING, so every app installed today keeps proxying unchanged.
    #[test]
    fn an_unannotated_route_imposes_no_permission() {
        assert_eq!(
            required_permission_for(
                &route("/tabs/:id", None, None),
                "/tabs/t-42",
                "com.acme.app"
            ),
            None
        );
    }

    #[test]
    fn a_rule_naming_no_resource_gates_on_the_app_itself() {
        // A route that identifies no object (`POST /settings`) is still grantable —
        // as the app. Without this fallback such a route could only be granted
        // node-wide or not at all.
        assert_eq!(
            required_permission_for(
                &route("/settings", Some("settings.write"), None),
                "/settings",
                "com.acme.app"
            ),
            Some(("settings.write".to_owned(), "com.acme.app".to_owned()))
        );
    }

    #[test]
    fn a_rule_naming_a_resource_param_gates_on_the_captured_value() {
        assert_eq!(
            required_permission_for(
                &route("/tabs/:id/close", Some("tabs.close"), Some("id")),
                "/tabs/t-42/close",
                "com.acme.app"
            ),
            Some(("tabs.close".to_owned(), "t-42".to_owned()))
        );
        // The param is positional, so a LATER param must not be read off the first
        // one's segment — that would gate every tab on the wrong id.
        assert_eq!(
            required_permission_for(
                &route("/w/:workspace/tabs/:id", Some("tabs.close"), Some("id")),
                "/w/main/tabs/t-42",
                "com.acme.app"
            ),
            Some(("tabs.close".to_owned(), "t-42".to_owned()))
        );
    }

    /// Validation rejects a `resource_param` its path does not contain, so this is
    /// the belt-and-braces case (a manifest that reached disk some other way). It
    /// must degrade to the APP, never to an empty resource id — `"<plugin>:"` would
    /// be a key an admin cannot see and cannot address.
    #[test]
    fn a_resource_param_that_captures_nothing_falls_back_to_the_app() {
        assert_eq!(
            required_permission_for(
                &route("/files/*rest", Some("files.read"), Some("id")),
                "/files/a/b",
                "com.acme.app"
            ),
            Some(("files.read".to_owned(), "com.acme.app".to_owned()))
        );
    }

    /// A `:param` sitting AFTER a wildcard cannot be captured positionally: the
    /// wildcard swallows an unknown number of segments, so the index the param
    /// occupies in the pattern no longer corresponds to anything in the actual
    /// path. Reading whatever happens to sit there would let the CALLER choose
    /// which resource the ACL is evaluated against — a request could name a
    /// resource it has an allow on while acting on a different one.
    ///
    /// Falling back to the app id is the fail-closed answer: the grant still has
    /// to exist, it is just scoped to the app rather than to a caller-chosen id.
    #[test]
    fn a_param_after_a_wildcard_captures_nothing_rather_than_the_wrong_segment() {
        assert_eq!(
            captured_param("/a/*rest/:id", "/a/one/two/three", "id"),
            None
        );
        assert_eq!(
            required_permission_for(
                &route("/a/*rest/:id", Some("x.edit"), Some("id")),
                "/a/one/two/three",
                "com.acme.app"
            ),
            Some(("x.edit".to_owned(), "com.acme.app".to_owned())),
            "must fall back to the app id, never to a caller-chosen segment"
        );
    }

    /// The rule and the forward decision must come from the SAME matched route:
    /// a request to an app's un-annotated route is not gated by the annotation on a
    /// sibling route, and the annotated one is.
    #[test]
    fn only_the_matched_route_imposes_its_own_rule() {
        let mut manifest = provider_manifest(9099, None);
        let http = manifest.sidecars[0]
            .http
            .as_mut()
            .expect("the provider fixture declares http");
        http.routes = vec![
            route("/health", None, None),
            route("/tabs/:id/close", Some("tabs.close"), Some("id")),
        ];

        let (_, _, health) =
            resolve_route(&manifest, "/health", "GET").expect("declared route resolves");
        assert_eq!(
            required_permission_for(health, "/health", &manifest.id),
            None,
            "an un-annotated route must not inherit a sibling's rule"
        );

        let (_, _, close) =
            resolve_route(&manifest, "/tabs/t-42/close", "POST").expect("declared route resolves");
        assert_eq!(
            required_permission_for(close, "/tabs/t-42/close", &manifest.id),
            Some(("tabs.close".to_owned(), "t-42".to_owned()))
        );

        // And an UNDECLARED path still resolves to nothing at all (404), which is
        // the gate that runs before any of this.
        assert!(resolve_route(&manifest, "/tabs/t-42/steal", "GET").is_none());
    }

    #[test]
    fn one_path_resolves_different_permissions_by_http_method() {
        let mut manifest = provider_manifest(9099, None);
        manifest.sidecars[0].http.as_mut().expect("http").routes = vec![
            route_for_method("/items", "GET", "items.view"),
            route_for_method("/items", "POST", "items.edit"),
        ];

        let (_, _, read) = resolve_route(&manifest, "/items", "GET").expect("GET route");
        let (_, _, write) = resolve_route(&manifest, "/items", "POST").expect("POST route");
        assert_eq!(read.permission.as_deref(), Some("items.view"));
        assert_eq!(write.permission.as_deref(), Some("items.edit"));
        assert!(resolve_route(&manifest, "/items", "DELETE").is_none());
    }

    /// The other half of the chain: the `(permission, resource_id)` the proxy hands
    /// to the resolver is one that actually DENIES by default and can be granted
    /// per-resource. Without this an app could declare a level that no role holds
    /// and no overwrite can reach — enforcement that is really just a wall.
    ///
    /// Drives the pure resolver (no disk, no process-global node-org state); the
    /// glue in between is `crate::server::enforce_permission_on`, which the kernel's
    /// own per-resource routes share.
    #[test]
    fn an_app_declared_level_denies_a_member_until_it_is_granted_on_the_resource() {
        use crate::acl::vocabulary::{build_vocabulary, builtin_role_catalog, DeclaredLevel};
        use crate::acl::{resolve, Decision, Overwrite, OverwriteTarget, Principal, ResourceAcl};

        let plugin_id = "com.acme.app";
        let (permission, resource_id) = required_permission_for(
            &route("/tabs/:id/close", Some("tabs.close"), Some("id")),
            "/tabs/t-42/close",
            plugin_id,
        )
        .expect("the route is annotated");

        let vocab = build_vocabulary(vec![DeclaredLevel {
            plugin_id: plugin_id.to_owned(),
            builtin: false,
            id: permission.clone(),
            label: "Can close tabs".to_owned(),
            description: "Closes tabs.".to_owned(),
            implies: Vec::new(),
        }]);
        let catalog = builtin_role_catalog();
        let member = Principal {
            user_id: "u1".to_owned(),
            org_id: Some("org1".to_owned()),
            team_ids: Default::default(),
            role_ids: ["member".to_owned()].into_iter().collect(),
        };

        // No built-in role knows what an app's own level means, so the default is
        // denial — an app cannot widen its callers' authority by declaring a level.
        assert_eq!(
            resolve(
                &vocab.registry,
                &catalog,
                &member,
                &ResourceAcl::new(),
                &permission
            ),
            Decision::Denied
        );

        // …and an admin granting it on exactly the resource the proxy computed is
        // what turns it on. A grant on a DIFFERENT id must not carry over.
        let granted = ResourceAcl::new().with(
            Overwrite::new(OverwriteTarget::Member(member.user_id.clone()))
                .allowing([permission.clone()]),
        );
        assert_eq!(resource_id, "t-42");
        assert_eq!(
            resolve(&vocab.registry, &catalog, &member, &granted, &permission),
            Decision::Allowed
        );
    }

    #[tokio::test]
    async fn sequential_proxy_requests_reuse_connections_and_keep_headers_per_request() {
        use axum::extract::ConnectInfo;
        use std::net::SocketAddr;
        use std::sync::Arc;

        let seen = Arc::new(tokio::sync::Mutex::new(Vec::<(SocketAddr, String)>::new()));
        let captured = seen.clone();
        let app = Router::new().route(
            "/pool",
            get(
                move |ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap| {
                    let captured = captured.clone();
                    async move {
                        let bearer = headers
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or_default()
                            .to_owned();
                        captured.lock().await.push((peer, bearer));
                        headers
                            .get("x-request-case")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or_default()
                            .to_owned()
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        for (plugin, value) in [
            ("com.test.pool-one", "first"),
            ("com.test.pool-two", "second"),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("x-request-case", value.parse().unwrap());
            let response = forward_to_sidecar(ForwardArgs {
                target: ForwardTarget::for_test(port),
                upstream_path: "/pool",
                query: "",
                method: reqwest::Method::GET,
                src_headers: &headers,
                body: Vec::new(),
                hop_plugin_id: plugin,
                forward_payment_authorization: false,
                forward_cookie_names: &[],
                forward_caller_email: false,
                caller: None,
                caller_resource_ids: None,
                caller_rate_subject: None,
                caller_agent_id: None,
                caller_agent_restricted: false,
                event_delivery: None,
            })
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let body = axum::body::to_bytes(response.into_body(), 1024)
                .await
                .unwrap();
            assert_eq!(body.as_ref(), value.as_bytes());
            tokio::task::yield_now().await;
        }
        let captured = seen.lock().await;
        assert_eq!(captured.len(), 2);
        assert_eq!(
            captured[0].0, captured[1].0,
            "sequential hops should reuse one TCP connection"
        );
        assert!(
            captured[0].1 != captured[1].1,
            "hop credentials must remain request-specific"
        );
        server.abort();
    }

    // ── Kill-isolation (the behavioral seam test) ───────────────────────────────

    /// A live sidecar's route works; when the sidecar dies, the SAME route 502s and
    /// nothing else is affected — Core is never blocked. This drives the REAL hop
    /// (`forward_to_sidecar`, shared by the inbound proxy AND the capability broker)
    /// against a REAL stub server on a real loopback port, then actually drops it.
    #[tokio::test]
    async fn dead_sidecar_502s_only_its_own_route() {
        use axum::routing::get;
        use axum::Router;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral loopback");
        let port = listener.local_addr().unwrap().port();
        let app = Router::new()
            .route("/ok", get(|| async { "UP" }))
            .route("/health", get(|| async { "OK" }));
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await
                .expect("stub server runs");
        });

        let call = || async {
            forward_to_sidecar(ForwardArgs {
                target: ForwardTarget::for_test(port),
                upstream_path: "/ok",
                query: "",
                method: reqwest::Method::GET,
                src_headers: &HeaderMap::new(),
                body: Vec::new(),
                hop_plugin_id: "com.test.app",
                forward_payment_authorization: false,
                forward_cookie_names: &[],
                forward_caller_email: false,
                caller: None,
                caller_resource_ids: None,
                caller_rate_subject: None,
                caller_agent_id: None,
                caller_agent_restricted: false,
                event_delivery: None,
            })
            .await
        };

        // Alive → the proxied route works.
        assert_eq!(call().await.status(), StatusCode::OK);

        // Kill the sidecar and wait for it to actually stop.
        let _ = shutdown_tx.send(());
        let _ = server.await;

        // Dead → the SAME route now 502s. The failure is isolated to this sidecar;
        // the forwarder itself is healthy (it returned a clean 502, not a panic/hang).
        assert_eq!(call().await.status(), StatusCode::BAD_GATEWAY);
    }

    /// Regression for the SSE header-hang: a sidecar endpoint whose body streams (one
    /// chunk, then a long pause before it ends) must yield response HEADERS at once, not
    /// after the whole body. The old `resp.bytes().await` buffered the full body first,
    /// so an unending stream never produced headers and `forward_to_sidecar` would block
    /// far past this test's 1s bound. With `bytes_stream()` → `Body::from_stream` the
    /// status + headers come back immediately, well inside the bound.
    #[tokio::test]
    async fn streaming_response_yields_headers_before_body_completes() {
        use axum::routing::get;
        use axum::Router;
        use std::time::Duration;

        async fn slow_stream() -> Response {
            // One chunk now, then a 3s gap before the stream ends — long past the 1s
            // assertion bound below, so a buffering proxy could not yet have returned.
            let s = async_stream::stream! {
                yield Ok::<_, std::convert::Infallible>(axum::body::Bytes::from("data: hi\n\n"));
                tokio::time::sleep(Duration::from_secs(3)).await;
            };
            Response::builder()
                .header(axum::http::header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from_stream(s))
                .unwrap()
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/events", get(slow_stream));
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let src_headers = HeaderMap::new();
        let fut = forward_to_sidecar(ForwardArgs {
            target: ForwardTarget::for_test(port),
            upstream_path: "/events",
            query: "",
            method: reqwest::Method::GET,
            src_headers: &src_headers,
            body: Vec::new(),
            hop_plugin_id: "com.test.sse",
            forward_payment_authorization: false,
            forward_cookie_names: &[],
            forward_caller_email: false,
            caller: None,
            caller_resource_ids: None,
            caller_rate_subject: None,
            caller_agent_id: None,
            caller_agent_restricted: false,
            event_delivery: None,
        });
        // Headers must arrive well before the body finishes (buffering ⇒ >3s ⇒ timeout).
        let resp = tokio::time::timeout(Duration::from_secs(1), fut)
            .await
            .expect("headers must arrive before the stream body completes");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(axum::http::header::CONTENT_TYPE)
                .expect("content-type passed through"),
            "text/event-stream"
        );
    }

    // ── Broker route resolution ─────────────────────────────────────────────────

    fn provider_manifest(port: u16, mount: Option<&str>) -> crate::plugin_manifest::PluginManifest {
        use crate::plugin_manifest::schema::{
            BinarySpec, HttpProxySpec, RouteSpec, SidecarProcess, SidecarSpec,
        };
        use crate::plugin_manifest::ProvidesEntry;
        crate::plugin_manifest::PluginManifest {
            id: "@ryu/rag".to_owned(),
            name: "RAG".to_owned(),
            version: "1.0.0".to_owned(),
            sidecars: vec![SidecarSpec {
                name: "rag".to_owned(),
                process: SidecarProcess::Binary(BinarySpec {
                    url: "https://example.com/rag".to_owned(),
                    version: "1.0.0".to_owned(),
                    sha256: None,
                    archive: None,
                    binary_name: None,
                    args: vec![],
                    env: Default::default(),
                }),
                port,
                health_path: "/health".to_owned(),
                http: Some(HttpProxySpec {
                    mount: mount.map(str::to_owned),
                    public_mount: None,
                    forward_cookie_names: Vec::new(),
                    forward_caller_email: false,
                    caller_resource_scope: None,
                    forward_caller_rate_subject: false,
                    routes: vec![RouteSpec {
                        path: "/query".to_owned(),
                        method: None,
                        auth: Default::default(),
                        permission: None,
                        resource_param: None,
                    }],
                    max_body_bytes: None,
                }),
                host_api: None,
                lazy: false,
                idle_stop_secs: None,
                provides_provider: None,
                sandbox: None,
            }],
            provides: vec![ProvidesEntry {
                capability: "rag".to_owned(),
                version: "1.0.0".to_owned(),
                sidecar: Some("rag".to_owned()),
                route: Some("/query".to_owned()),
                grant: Some("cap:rag".to_owned()),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn resolve_provider_route_maps_a_root_route_to_the_bare_mount() {
        // Sidecars nest their routers at the bare mount and axum does no
        // trailing-slash redirect, so a `"/"` capability route must not become
        // `{mount}/` (which 404s upstream) — same rule as the inbound proxy.
        let m = provider_manifest(9099, Some("/api/rag"));
        let mut entry = m.provided_capabilities()[0].clone();
        entry.route = Some("/".to_owned());
        let route = resolve_provider_route(&m, &entry, "@ryu/rag").expect("resolves");
        assert_eq!(route.upstream_path, "/api/rag");
    }

    #[test]
    fn resolve_provider_route_pins_sidecar_mount_and_path() {
        let m = provider_manifest(9099, Some("/api/rag/"));
        let entry = m.provided_capabilities()[0].clone();
        let route = resolve_provider_route(&m, &entry, "@ryu/rag").expect("resolves");
        assert_eq!(route.provider_id, "@ryu/rag");
        // The route carries the manager KEY, never a manifest-derived port: the port is
        // resolved through `forward_target` at the hop, so a provider whose declared port
        // is squatted by another process is refused rather than dialed.
        assert_eq!(route.sidecar_name, "@ryu/rag/rag");
        // Mount trailing slash trimmed, route appended.
        assert_eq!(route.upstream_path, "/api/rag/query");
        // The fixture provider is eager (lazy=false, no idle_stop_secs) ⇒ no wake.
        assert_eq!(route.wake_name, None);
    }

    /// The refusal body must be diagnosable on its own: the sidecar key, the port, and
    /// a reason that distinguishes "another process holds the port" from "our process
    /// is down". And it must be 503, never 502 — 502 in this file is reserved for "we
    /// dialed a sidecar we own and the hop failed", which is a different instruction to
    /// whoever is reading the log.
    #[tokio::test]
    async fn refusal_is_a_503_naming_the_sidecar_port_and_reason() {
        let not_registered = ForwardDenied::NotRegistered {
            name: "@ryu/monitors/ryu-monitors".to_owned(),
            declared_port: Some(8003),
        };
        let resp = sidecar_unavailable(&not_registered);
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["error"], "sidecar unavailable");
        assert_eq!(v["sidecar"], "@ryu/monitors/ryu-monitors");
        assert_eq!(v["port"], 8003);
        assert!(
            v["reason"]
                .as_str()
                .unwrap()
                .contains("held by another process"),
            "the not-registered reason must name the actual cause: {v}"
        );

        // The other arm is a DIFFERENT reason — a status panel (and a human) must be
        // able to tell "someone else owns this port" from "our own process crashed".
        let dead = ForwardDenied::NotRunning {
            name: "@ryu/monitors/ryu-monitors".to_owned(),
            port: 8003,
        };
        let resp = sidecar_unavailable(&dead);
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(resp.into_body(), 4096).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(v["reason"].as_str().unwrap().contains("not running"));
    }

    #[test]
    fn resolve_provider_route_names_wake_target_for_lazy_provider() {
        let mut m = provider_manifest(9099, Some("/api/rag"));
        m.sidecars[0].lazy = true;
        let entry = m.provided_capabilities()[0].clone();
        let route = resolve_provider_route(&m, &entry, "@ryu/rag").expect("resolves");
        // A lazy provider sidecar is named for the broker to wake before forwarding.
        assert_eq!(route.wake_name.as_deref(), Some("@ryu/rag/rag"));
    }

    #[test]
    fn public_mount_routes_rejects_duplicate_prefixes() {
        // Two built-ins claiming the SAME public_mount must fail closed rather than
        // silently routing the later owner's URL through the first owner's policy.
        let mut a = provider_manifest(9001, Some("/api/mail"));
        a.id = "@ryu/mail".to_owned();
        if let Some(http) = a.sidecars[0].http.as_mut() {
            http.public_mount = Some("/api/mail".to_owned());
        }
        let mut b = provider_manifest(9002, Some("/api/mail"));
        b.id = "com.other.dup".to_owned();
        if let Some(http) = b.sidecars[0].http.as_mut() {
            http.public_mount = Some("/api/mail".to_owned());
        }
        assert!(public_mount_routes(&[a, b], Some("tok".to_owned())).is_err());
    }

    #[test]
    fn public_mount_routes_registers_bare_root_route() {
        use crate::plugin_manifest::schema::RouteSpec;
        // A sidecar declaring public_mount "/api/x" and a root route "/" must be
        // reachable at the bare mount (GET /api/x), not only at sub-paths. The bare
        // exact route is registered alongside the `/*rest` wildcard; building the
        // router exercises the `mount` (no-wildcard) path in `public_mount_routes`
        // — a duplicate exact route (or a trailing-slash form) would panic here.
        let mut a = provider_manifest(9001, Some("/api/x"));
        a.id = "@ryu/teams".to_owned();
        if let Some(http) = a.sidecars[0].http.as_mut() {
            http.public_mount = Some("/api/x".to_owned());
            // The list endpoint the sidecar serves at the mount ROOT.
            http.routes = vec![RouteSpec {
                path: "/".to_owned(),
                method: None,
                auth: Default::default(),
                permission: None,
                resource_param: None,
            }];
        }
        // A second built-in with a different mount proves both mount roots can be
        // registered in one router without a duplicate-route panic.
        let mut b = provider_manifest(9002, Some("/api/x"));
        b.id = "com.other.dup".to_owned();
        if let Some(http) = b.sidecars[0].http.as_mut() {
            http.public_mount = Some("/api/y".to_owned());
        }
        let _router: Router<ServerState> =
            public_mount_routes(&[a, b], Some("tok".to_owned())).expect("unique mounts");
    }

    #[test]
    fn public_mount_routes_include_installed_and_compiled_apps() {
        let installed = crate::plugin_manifest::PluginManifestLoader::load_builtins()
            .into_iter()
            .filter(|manifest| manifest.id == "@ryu/mail")
            .collect::<Vec<_>>();
        let manifests = crate::plugin_manifest::PluginManifestLoader::for_router(&installed);

        assert!(
            manifests.iter().any(|manifest| manifest.id == "@ryu/mail"),
            "installed Mail manifest must be available when the router is built"
        );
        for id in ["@ryu/meetings", "@ryu/teams", "@ryu/dashboards"] {
            assert!(
                manifests.iter().any(|manifest| manifest.id == id),
                "compiled manifest {id} must be available when the router is built"
            );
        }
        assert!(
            manifests.iter().any(|manifest| manifest.id == "@ryu/rooms"),
            "compiled Rooms manifest must register its opt-in public guest mount"
        );

        // Build the actual public-mount router: these manifests must reach route
        // construction even when production BUILTIN_MANIFESTS is system-only.
        let _router: Router<ServerState> =
            public_mount_routes(&manifests, Some("tok".to_owned())).expect("unique mounts");
    }

    #[test]
    fn public_mount_routes_include_compiled_opt_in_sidecars() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::for_router(&[]);

        for id in [
            "@ryu/finetune",
            "@ryu/healing",
            "@ryu/research",
            "@ryu/clips",
            "@ryu/recipes",
        ] {
            assert!(
                manifests.iter().any(|manifest| manifest.id == id),
                "compiled opt-in sidecar {id} must be available when the router is built"
            );
        }

        let _router: Router<ServerState> =
            public_mount_routes(&manifests, Some("tok".to_owned())).expect("unique mounts");
    }

    /// The declared "/" route must forward to the BARE mount, never `{mount}/` —
    /// sidecars nest at the bare mount and axum does no trailing-slash redirect.
    #[test]
    fn upstream_path_root_forwards_bare_mount() {
        assert_eq!(upstream_path_for("/api/monitors", "/"), "/api/monitors");
        assert_eq!(
            upstream_path_for("/api/monitors", "/alerts"),
            "/api/monitors/alerts"
        );
        // No mount declared: the root forwards to the sidecar's own root.
        assert_eq!(upstream_path_for("", "/"), "");
        assert_eq!(upstream_path_for("", "/health"), "/health");
    }

    /// Regression for the trailing-slash root 404: a real sidecar-shaped stub (router
    /// nested at the bare mount, list endpoint at its root) must be reachable through
    /// the forwarder via [`upstream_path_for`]'s root form. The `{mount}/` form the
    /// proxy used to build 404s against the very same stub — asserted here so the
    /// bare-mount requirement stays pinned to observed sidecar behavior.
    #[tokio::test]
    async fn root_forward_reaches_bare_mount_nested_sidecar() {
        use axum::routing::get;
        use axum::Router;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let inner = Router::new().route("/", get(|| async { "ROOT-MARKER" }));
        let app = Router::new().nest("/api/x", inner);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        // The old proxy form (`{mount}/`) 404s against a bare-mount-nested sidecar.
        let trailing = reqwest::get(format!("http://127.0.0.1:{port}/api/x/"))
            .await
            .unwrap();
        assert_eq!(trailing.status(), reqwest::StatusCode::NOT_FOUND);

        let src_headers = HeaderMap::new();
        let resp = forward_to_sidecar(ForwardArgs {
            target: ForwardTarget::for_test(port),
            upstream_path: &upstream_path_for("/api/x", "/"),
            query: "",
            method: reqwest::Method::GET,
            src_headers: &src_headers,
            body: Vec::new(),
            hop_plugin_id: "com.test.root",
            forward_payment_authorization: false,
            forward_cookie_names: &[],
            forward_caller_email: false,
            caller: None,
            caller_resource_ids: None,
            caller_rate_subject: None,
            caller_agent_id: None,
            caller_agent_restricted: false,
            event_delivery: None,
        })
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], b"ROOT-MARKER");
    }

    /// Regression for the bare-root 404 in the generic `/api/ext/:plugin_id` lane:
    /// axum's `*rest` catch-all cannot match an empty tail, so the wildcard-only shape
    /// 404s the bare `/api/ext/:id` (a third-party app whose list/create lives at "/").
    /// Adding the exact route alongside the catch-all makes both the root and sub-paths
    /// resolve — pinned here at the routing layer (the same two-route shape `ext_routes`
    /// registers), which is where the bug lived.
    ///
    /// Uses a FLAT id deliberately: this pins raw axum matching, and a scoped id
    /// (`@ryu/teams`) spans two segments, so it would exercise the wildcard route
    /// rather than the bare-root one this regression is about. The scoped root is
    /// covered by `scoped_plugin_ids_are_reunited_from_two_path_segments`, which
    /// asserts the empty-tail rejoin.
    #[tokio::test]
    async fn ext_lane_bare_root_routes_with_exact_route() {
        use axum::routing::any;
        use axum::Router;

        // Wildcard-ONLY (the pre-fix shape): the bare `/api/ext/:id` 404s.
        let only_wild: Router<()> =
            Router::new().route("/api/ext/:plugin_id/*rest", any(|| async { "SUB" }));
        let l1 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let p1 = l1.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(l1, only_wild).await.unwrap() });
        let bare = reqwest::get(format!("http://127.0.0.1:{p1}/api/ext/com.acme.app"))
            .await
            .unwrap();
        assert_eq!(bare.status(), reqwest::StatusCode::NOT_FOUND);

        // Exact + wildcard (the fixed shape `ext_routes` builds): root AND sub resolve.
        let fixed: Router<()> = Router::new()
            .route("/api/ext/:plugin_id", any(|| async { "ROOT" }))
            .route("/api/ext/:plugin_id/*rest", any(|| async { "SUB" }));
        let l2 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let p2 = l2.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(l2, fixed).await.unwrap() });
        let root = reqwest::get(format!("http://127.0.0.1:{p2}/api/ext/com.acme.app"))
            .await
            .unwrap();
        assert_eq!(root.status(), reqwest::StatusCode::OK);
        assert_eq!(root.text().await.unwrap(), "ROOT");
        let sub = reqwest::get(format!("http://127.0.0.1:{p2}/api/ext/com.acme.app/42"))
            .await
            .unwrap();
        assert_eq!(sub.status(), reqwest::StatusCode::OK);
        assert_eq!(sub.text().await.unwrap(), "SUB");
    }

    // ── WS tunnel authorization lifetime ────────────────────────────────────────

    const RAG_WS_PATH: &str = "/api/ext/ws/@ryu/rag/query";

    fn ext_ws_ticket(jwt_expires_at: Option<i64>) -> crate::server::ws_ticket::WsTicketClaims {
        crate::server::ws_ticket::WsTicketClaims {
            app_id: None,
            caller: None,
            kind: None,
            path: Some(RAG_WS_PATH.to_owned()),
            member: false,
            peer_is_loopback: false,
            room_id: None,
            route: crate::server::ws_ticket::WsTicketRoute::Extension,
            jwt_expires_at,
            user_jwt: None,
            node_generation: crate::node_token::active_generation(),
        }
    }

    fn ext_ws_revocation(jwt_expires_at: Option<i64>, node_generation: u64) -> ExtWsRevocation {
        ExtWsRevocation {
            jwt_expires_at,
            node_generation,
        }
    }

    #[test]
    fn an_ext_ws_ticket_whose_identity_already_expired_is_refused() {
        let now = chrono::Utc::now().timestamp();
        for expired in [now - 60, now] {
            assert_eq!(
                ext_ws_revocation_for(Some(&ext_ws_ticket(Some(expired)))),
                Err(StatusCode::UNAUTHORIZED),
                "a ticket whose JWT expired at {expired} (now {now}) must not upgrade"
            );
        }

        let live = ext_ws_ticket(Some(now + 3_600));
        assert_eq!(
            ext_ws_revocation_for(Some(&live)),
            Ok(Some(ext_ws_revocation(
                Some(now + 3_600),
                live.node_generation
            ))),
            "a live identity upgrades, carrying its expiry and node generation"
        );
        let local = ext_ws_ticket(None);
        assert_eq!(
            ext_ws_revocation_for(Some(&local)),
            Ok(Some(ext_ws_revocation(None, local.node_generation))),
            "a node-token ticket upgrades and is still bound to its generation"
        );
        assert_eq!(
            ext_ws_revocation_for(None),
            Ok(None),
            "a Public route has no ticket to revoke"
        );
    }

    /// End to end through the real `/api/ext/ws` router: a Protected route's ticket
    /// whose JWT already expired is a 401 before the upgrade (and before any sidecar
    /// wake), while a live ticket clears the gate and reaches the sidecar gate.
    #[tokio::test]
    async fn an_expired_ext_ws_ticket_is_a_401_before_the_upgrade() {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        // The route is Protected (the default) and its sidecar is never registered.
        let manifest = provider_manifest(1, None);
        let app = manifest.id.clone();
        state.app_store.insert(&app, "1.0.0").await.unwrap();
        state.app_store.set_enabled(&app, &[]).await.unwrap();
        state.app_manifests.write().await.push(manifest);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = ext_routes(None).with_state(state);
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let handshake_status = |ticket: String| async move {
            let url = format!("ws://127.0.0.1:{port}{RAG_WS_PATH}?{WS_TICKET_PARAM}={ticket}");
            match tokio_tungstenite::connect_async(url).await {
                Err(tokio_tungstenite::tungstenite::Error::Http(response)) => response.status(),
                Ok(_) => panic!("the socket must not upgrade without a registered sidecar"),
                Err(other) => panic!("unexpected handshake failure: {other}"),
            }
        };

        let now = chrono::Utc::now().timestamp();
        let expired = crate::server::ws_ticket::mint_for_test(ext_ws_ticket(Some(now - 60)));
        assert_eq!(
            handshake_status(expired).await.as_u16(),
            StatusCode::UNAUTHORIZED.as_u16()
        );

        let live = crate::server::ws_ticket::mint_for_test(ext_ws_ticket(Some(now + 3_600)));
        assert_eq!(
            handshake_status(live).await.as_u16(),
            StatusCode::SERVICE_UNAVAILABLE.as_u16(),
            "a live ticket passes the identity gate and stops only at the unregistered sidecar"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_ext_ws_tunnel_is_revoked_when_the_node_token_rotates() {
        use std::time::Duration;
        use tokio::time::timeout;

        // Rotated between minting the ticket and the upgrade: revoked at once.
        let (_tx, rx) = tokio::sync::watch::channel(5_u64);
        let revoked = wait_for_ext_ws_revocation(Some(ext_ws_revocation(None, 4)), rx);
        assert!(timeout(Duration::from_millis(1), revoked).await.is_ok());

        // Rotated while the tunnel is open.
        let (tx, rx) = tokio::sync::watch::channel(4_u64);
        let revoked = wait_for_ext_ws_revocation(Some(ext_ws_revocation(None, 4)), rx);
        tokio::pin!(revoked);
        assert!(
            timeout(Duration::from_secs(86_400), &mut revoked)
                .await
                .is_err(),
            "an unrotated node token keeps the tunnel open"
        );
        tx.send(4).unwrap();
        assert!(
            timeout(Duration::from_secs(3_600), &mut revoked)
                .await
                .is_err(),
            "republishing the same generation is not a rotation"
        );
        tx.send(5).unwrap();
        assert!(timeout(Duration::from_millis(1), &mut revoked)
            .await
            .is_ok());

        // The generation watch closing fails closed.
        let (tx, rx) = tokio::sync::watch::channel(4_u64);
        let revoked = wait_for_ext_ws_revocation(Some(ext_ws_revocation(None, 4)), rx);
        tokio::pin!(revoked);
        assert!(timeout(Duration::from_secs(3_600), &mut revoked)
            .await
            .is_err());
        drop(tx);
        assert!(timeout(Duration::from_millis(1), &mut revoked)
            .await
            .is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn an_ext_ws_tunnel_is_revoked_when_the_callers_jwt_expires() {
        use std::time::Duration;
        use tokio::time::timeout;

        let now = chrono::Utc::now().timestamp();
        let (_tx, rx) = tokio::sync::watch::channel(7_u64);
        let revoked = wait_for_ext_ws_revocation(Some(ext_ws_revocation(Some(now + 600), 7)), rx);
        tokio::pin!(revoked);
        assert!(
            timeout(Duration::from_secs(540), &mut revoked)
                .await
                .is_err(),
            "still within the JWT's lifetime"
        );
        assert!(
            timeout(Duration::from_secs(120), &mut revoked)
                .await
                .is_ok(),
            "the tunnel's authorization ends with the JWT"
        );

        let (_tx, rx) = tokio::sync::watch::channel(7_u64);
        let revoked = wait_for_ext_ws_revocation(Some(ext_ws_revocation(Some(now - 1), 7)), rx);
        assert!(timeout(Duration::from_millis(1), revoked).await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn a_public_ext_ws_tunnel_is_never_revoked() {
        use std::time::Duration;
        use tokio::time::timeout;

        let (tx, rx) = tokio::sync::watch::channel(1_u64);
        let revoked = wait_for_ext_ws_revocation(None, rx);
        tokio::pin!(revoked);
        assert!(timeout(Duration::from_secs(86_400), &mut revoked)
            .await
            .is_err());
        let _ = tx.send(2);
        drop(tx);
        assert!(timeout(Duration::from_secs(86_400), &mut revoked)
            .await
            .is_err());
    }

    /// An open tunnel whose authorization is revoked tells the client why (1008,
    /// "authorization expired") and drops its upstream socket to the sidecar.
    #[tokio::test]
    async fn a_revoked_ext_ws_tunnel_closes_with_1008_and_drops_the_sidecar_socket() {
        use futures_util::{SinkExt as _, StreamExt as _};
        use std::time::Duration;
        use tokio::time::timeout;

        // Sidecar stub: echoes text frames and reports when its socket ends.
        let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        let (upstream_ended_tx, upstream_ended) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let (stream, _) = upstream.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(message)) = socket.next().await {
                if message.is_close() {
                    break;
                }
                if message.is_text() && socket.send(message).await.is_err() {
                    break;
                }
            }
            let _ = upstream_ended_tx.send(());
        });

        // Core side: the real bridge under a revocation the test fires by hand.
        let revoke = std::sync::Arc::new(tokio::sync::Notify::new());
        let handler_revoke = revoke.clone();
        let router = Router::new().route(
            "/ws",
            get(move |ws: WebSocketUpgrade| {
                let revoke = handler_revoke.clone();
                async move {
                    ws.on_upgrade(move |socket| {
                        bridge_ws_to_sidecar(
                            socket,
                            upstream_port,
                            "/".to_owned(),
                            "hop".to_owned(),
                            async move { revoke.notified().await },
                        )
                    })
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))
            .await
            .unwrap();
        client.send(TsMessage::text("ping")).await.unwrap();
        let echoed = timeout(Duration::from_secs(10), client.next())
            .await
            .expect("the tunnel carries frames while authorized")
            .expect("a frame")
            .unwrap();
        assert_eq!(echoed.into_text().unwrap(), "ping");

        revoke.notify_one();
        let closed = timeout(Duration::from_secs(10), client.next())
            .await
            .expect("the tunnel closes once revoked")
            .expect("a close frame")
            .unwrap();
        let TsMessage::Close(Some(frame)) = closed else {
            panic!("expected a close frame, got {closed:?}");
        };
        assert_eq!(u16::from(frame.code), WS_CLOSE_POLICY);
        assert_eq!(&*frame.reason, "authorization expired");
        timeout(Duration::from_secs(10), upstream_ended)
            .await
            .expect("the sidecar socket is dropped")
            .unwrap();
    }

    #[test]
    fn mail_builtin_declares_public_mount_and_local_process() {
        use crate::plugin_manifest::schema::SidecarProcess;
        let builtins = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let mail = builtins
            .iter()
            .find(|m| m.id == "@ryu/mail")
            .expect("@ryu/mail is a registered built-in");
        let sc = &mail.sidecars[0];
        // Spawned as a local sibling binary (ryu-mail), not a download; the child is
        // told its (profile-shifted) bind port via `port_env` so Core's proxy +
        // health target the same port across concurrent profiles.
        match &sc.process {
            SidecarProcess::Local(local) => {
                assert_eq!(local.command, "ryu-mail");
                assert_eq!(local.port_env.as_deref(), Some("RYU_MAIL_PORT"));
            }
            other => panic!("mail process must be Local, got {other:?}"),
        }
        assert_eq!(sc.port, 7996);
        // Health probes the public process liveness route; the bearer-gated
        // `/api/mail/status` remains the service-level status endpoint.
        assert_eq!(sc.health_path, "/health");
        let http = sc.http.as_ref().expect("mail declares http");
        assert_eq!(http.public_mount.as_deref(), Some("/api/mail"));
        assert_eq!(http.mount.as_deref(), Some("/api/mail"));
        // The inbound webhook is public (per-inbox HMAC); everything else Protected.
        let inbound = http
            .routes
            .iter()
            .find(|r| r.path == "/inbound/:id")
            .expect("declares inbound route");
        assert_eq!(inbound.auth, RouteAuth::Public);
        assert!(http
            .routes
            .iter()
            .any(|r| r.path == "/status" && r.auth == RouteAuth::Protected));
    }

    // ── Hop-by-hop + browser-context header handling (defense-in-depth) ─────────

    #[test]
    fn hop_by_hop_headers_are_recognized_case_insensitively() {
        for h in [
            "host",
            "Content-Length",
            "CONNECTION",
            "transfer-encoding",
            "Keep-Alive",
            "upgrade",
        ] {
            assert!(is_hop_by_hop(h), "{h} must be treated hop-by-hop");
        }
        // End-to-end headers survive.
        for h in ["authorization", "content-type", "x-ryu-plugin-id", "accept"] {
            assert!(!is_hop_by_hop(h), "{h} must NOT be hop-by-hop");
        }
    }

    #[test]
    fn browser_context_headers_are_origin_and_referer() {
        // These name the ORIGINAL cross-origin caller; forwarding them would make Core's
        // authenticated proxy hop indistinguishable from a drive-by browser request, so a
        // loopback sidecar's CSRF / DNS-rebind gate would 403 it.
        assert!(is_browser_context("origin"));
        assert!(is_browser_context("Referer"));
        assert!(is_browser_context("REFERER"));
        assert!(!is_browser_context("authorization"));
        assert!(!is_browser_context("content-type"));
    }

    #[test]
    fn copy_headers_strips_hop_and_browser_context_keeps_the_rest() {
        let mut src = HeaderMap::new();
        src.insert("content-type", "application/json".parse().unwrap());
        src.insert("origin", "https://evil.example".parse().unwrap());
        src.insert("referer", "https://evil.example/p".parse().unwrap());
        src.insert("x-ryu-user-jwt", "user-jwt-secret".parse().unwrap());
        src.insert("cookie", "better-auth.session=secret".parse().unwrap());
        src.insert("host", "127.0.0.1:9999".parse().unwrap());
        src.insert("connection", "keep-alive".parse().unwrap());
        src.insert("x-ryu-plugin-id", "com.acme.app".parse().unwrap());
        src.insert(
            crate::sidecar::deferred_authorization::PRINCIPAL_HEADER,
            "forged".parse().unwrap(),
        );
        src.insert(
            HDR_FORWARDED_AUTHORIZATION,
            "Payment forged".parse().unwrap(),
        );
        src.insert(
            HDR_CALLER_RESOURCE_IDS,
            r#"["forged-conversation"]"#.parse().unwrap(),
        );

        let mut dst = reqwest::header::HeaderMap::new();
        copy_headers(&src, &mut dst, &[]);
        assert!(dst
            .get(crate::sidecar::deferred_authorization::PRINCIPAL_HEADER)
            .is_none());

        // End-to-end app headers are forwarded.
        assert_eq!(
            dst.get("content-type").map(|v| v.to_str().unwrap()),
            Some("application/json")
        );
        assert_eq!(
            dst.get("x-ryu-plugin-id").map(|v| v.to_str().unwrap()),
            Some("com.acme.app")
        );
        assert!(dst.get("x-ryu-user-jwt").is_none());
        assert!(dst.get("cookie").is_none());
        assert!(
            dst.get(HDR_CALLER_RESOURCE_IDS).is_none(),
            "caller must not forge Core's resource scope"
        );
        // Browser-context + hop-by-hop headers are dropped.
        assert!(dst.get("origin").is_none(), "Origin must be stripped");
        assert!(dst.get("referer").is_none(), "Referer must be stripped");
        assert!(dst.get("host").is_none(), "Host must be stripped");
        assert!(
            dst.get(HDR_FORWARDED_AUTHORIZATION).is_none(),
            "caller must not forge the reserved authorization hop header"
        );
        assert!(
            dst.get("connection").is_none(),
            "Connection must be stripped"
        );
    }

    // ── Web-delegated admission ─────────────────────────────────────────────────

    /// A manifest fixture for the web-delegation gate: an optional `surfaces.web`
    /// level, an optional Companion runnable, declared grants, and one annotated
    /// (`/items`) and one unannotated (`/open`) route. Routes are `public` so these
    /// tests never depend on whichever node token the test process holds.
    fn web_app(
        id: &str,
        web: Option<&str>,
        companion: bool,
        grants: &[&str],
    ) -> crate::plugin_manifest::PluginManifest {
        let runnables = if companion {
            json!([{ "id": "panel", "name": "Panel", "kind": "companion",
                     "config": { "label": "Panel" } }])
        } else {
            json!([])
        };
        let mut value = json!({
            "id": id, "name": id, "version": "1.0.0",
            "runnables": runnables,
            "permission_grants": grants,
            "sidecars": [{ "name": "svc", "port": 18997,
                           "process": { "kind": "local", "command": "true" },
                           "http": { "mount": "/api/svc", "routes": [
                               { "path": "/items", "permission": "items.view", "auth": "public" },
                               { "path": "/open", "auth": "public" }
                           ] } }],
        });
        if let Some(level) = web {
            value["surfaces"] = json!({ "web": { "support": level } });
        }
        serde_json::from_value(value).expect("web app fixture parses")
    }

    fn caller_header(id: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(HDR_APP_CALLER, id.parse().unwrap());
        headers
    }

    #[test]
    fn a_web_delegated_forward_is_marked_admitted_over_any_sidecar_value() {
        let mut response = Response::builder()
            .header(HDR_WEB_DELEGATION, "forged-by-sidecar")
            .body(Body::empty())
            .unwrap();
        mark_web_delegation_admitted(&mut response);
        let values: Vec<_> = response
            .headers()
            .get_all(HDR_WEB_DELEGATION)
            .iter()
            .collect();
        assert_eq!(values, vec![WEB_DELEGATION_ADMITTED]);
    }

    #[test]
    fn copy_headers_strips_the_web_delegation_headers() {
        let mut src = HeaderMap::new();
        src.insert(HDR_WEB_DELEGATION, "1".parse().unwrap());
        src.insert(HDR_APP_CALLER, "@acme/caller".parse().unwrap());
        src.insert("accept", "application/json".parse().unwrap());
        let mut dst = reqwest::header::HeaderMap::new();
        copy_headers(&src, &mut dst, &[]);
        assert!(dst.get(HDR_WEB_DELEGATION).is_none());
        assert!(dst.get(HDR_APP_CALLER).is_none());
        assert!(dst.get("accept").is_some());
    }

    /// Only Core's own event fan-out may carry the delivery marker: a caller's copy
    /// never crosses a proxied hop, so a subscriber can trust it.
    #[test]
    fn copy_headers_strips_a_caller_supplied_event_delivery_marker() {
        let mut src = HeaderMap::new();
        src.insert(HDR_EVENT_DELIVERY, "forged".parse().unwrap());
        let mut dst = reqwest::header::HeaderMap::new();
        copy_headers(&src, &mut dst, &[]);
        assert!(dst.get(HDR_EVENT_DELIVERY).is_none());
    }

    /// Only an explicit `full` or `limited` web entry counts. The listing rule
    /// (`supports_surface`) admits legacy manifests and unknown levels; this gate must
    /// not.
    #[test]
    fn strict_web_support_admits_only_full_and_limited() {
        for (level, expected) in [
            (Some("full"), true),
            (Some("limited"), true),
            (Some("list"), false),
            (Some("commands"), false),
            (Some("none"), false),
            (Some("future-level"), false),
            (None, false),
        ] {
            let manifest = web_app("@acme/app", level, true, &[]);
            assert_eq!(
                strictly_supports_web(&manifest),
                expected,
                "web support {level:?}"
            );
        }
        // Legacy: no `surfaces` and an empty `targets` list is "every surface" for
        // listing, but never a credential-bearing web hop.
        let legacy = web_app("@acme/app", None, true, &[]);
        assert!(legacy.supports_surface(crate::plugin_manifest::Surface::Web));
        assert!(!strictly_supports_web(&legacy));
        // Another surface's entry does not stand in for web.
        let mut desktop_only = web_app("@acme/app", None, true, &[]);
        desktop_only.surfaces = serde_json::from_value(json!({
            "desktop": { "support": "full" }
        }))
        .unwrap();
        assert!(!strictly_supports_web(&desktop_only));
    }

    #[test]
    fn web_delegation_facts_read_only_a_valid_installed_caller_app() {
        let target = web_app("@acme/target", Some("full"), true, &[]);
        let caller = web_app("@acme/caller", Some("limited"), true, &["app:http"]);
        let headless = web_app("@acme/headless", Some("full"), false, &[]);
        let manifests = vec![target.clone(), caller, headless];

        let facts = web_delegation_facts(&manifests, &target, true, &caller_header("@acme/caller"));
        assert_eq!(
            facts,
            WebDelegationFacts {
                route_declares_permission: true,
                target_supports_web: true,
                caller_app: Some(WebCallerApp {
                    id: "@acme/caller".to_owned(),
                    supports_web: true,
                    has_companion: true,
                }),
            }
        );
        let facts =
            web_delegation_facts(&manifests, &target, true, &caller_header("@acme/headless"));
        assert_eq!(facts.caller_app.map(|app| app.has_companion), Some(false));
        // Missing, malformed and uninstalled caller ids name no app at all.
        for headers in [
            HeaderMap::new(),
            caller_header("@ACME/caller"),
            caller_header("@acme/caller/extra"),
            caller_header("@acme/missing"),
        ] {
            assert_eq!(
                web_delegation_facts(&manifests, &target, true, &headers).caller_app,
                None
            );
        }
    }

    #[test]
    fn web_delegated_route_gate_refuses_with_404_until_every_manifest_fact_holds() {
        let caller = WebCallerApp {
            id: "@acme/caller".to_owned(),
            supports_web: true,
            has_companion: true,
        };
        let admitted = WebDelegationFacts {
            route_declares_permission: true,
            target_supports_web: true,
            caller_app: Some(caller.clone()),
        };
        assert_eq!(web_delegated_route_gate(&admitted), Ok(&caller));

        let refusals = [
            WebDelegationFacts {
                route_declares_permission: false,
                ..admitted.clone()
            },
            WebDelegationFacts {
                target_supports_web: false,
                ..admitted.clone()
            },
            WebDelegationFacts {
                caller_app: None,
                ..admitted.clone()
            },
            WebDelegationFacts {
                caller_app: Some(WebCallerApp {
                    supports_web: false,
                    ..caller.clone()
                }),
                ..admitted.clone()
            },
            WebDelegationFacts {
                caller_app: Some(WebCallerApp {
                    has_companion: false,
                    ..caller.clone()
                }),
                ..admitted.clone()
            },
        ];
        for facts in refusals {
            assert_eq!(
                web_delegated_route_gate(&facts),
                Err(StatusCode::NOT_FOUND),
                "{facts:?}"
            );
        }
    }

    #[test]
    fn web_caller_grant_is_own_app_http_or_the_exact_target_edge() {
        assert_eq!(
            web_caller_required_grant("@ryu/finetune", "@ryu/finetune"),
            "app:http"
        );
        assert_eq!(
            web_caller_required_grant("@ryu/workflows", "@ryu/recipes"),
            "app:http:@ryu/recipes"
        );
    }

    /// The caller app must be enabled and hold the exact edge in its CURRENT approved
    /// set: plain `app:http` never reaches another app, a target grant never reaches
    /// the caller's own sidecar, a wildcard is not an edge, and an approval the
    /// manifest no longer declares does not count.
    #[tokio::test]
    async fn web_caller_app_admission_requires_the_exact_reviewed_grant() {
        const CALLER: &str = "@acme/caller";
        const TARGET: &str = "@acme/target";
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        state.app_manifests.write().await.push(web_app(
            CALLER,
            Some("full"),
            true,
            &["app:http", "app:http:@acme/target", "app:http:@acme/*"],
        ));

        // Not installed, then installed but disabled.
        assert_eq!(
            web_caller_app_admitted(&state, CALLER, CALLER).await,
            Err(StatusCode::NOT_FOUND)
        );
        state.app_store.insert(CALLER, "1.0.0").await.unwrap();
        assert_eq!(
            web_caller_app_admitted(&state, CALLER, CALLER).await,
            Err(StatusCode::NOT_FOUND)
        );

        let approve = |grants: &[&str]| grants.iter().map(|g| (*g).to_owned()).collect::<Vec<_>>();

        state
            .app_store
            .set_enabled(CALLER, &approve(&["app:http"]))
            .await
            .unwrap();
        assert_eq!(
            web_caller_app_admitted(&state, CALLER, CALLER).await,
            Ok(())
        );
        assert_eq!(
            web_caller_app_admitted(&state, CALLER, TARGET).await,
            Err(StatusCode::NOT_FOUND),
            "plain app:http never reaches another app"
        );

        state
            .app_store
            .set_enabled(CALLER, &approve(&["app:http:@acme/target"]))
            .await
            .unwrap();
        assert_eq!(
            web_caller_app_admitted(&state, CALLER, TARGET).await,
            Ok(())
        );
        assert_eq!(
            web_caller_app_admitted(&state, CALLER, CALLER).await,
            Err(StatusCode::NOT_FOUND),
            "a target grant does not cover the caller's own sidecar"
        );

        state
            .app_store
            .set_enabled(CALLER, &approve(&["app:http:@acme/*"]))
            .await
            .unwrap();
        assert_eq!(
            web_caller_app_admitted(&state, CALLER, TARGET).await,
            Err(StatusCode::NOT_FOUND),
            "a wildcard is not a reviewed edge"
        );

        // Approved but no longer declared by the manifest: not current.
        state
            .app_store
            .set_enabled(CALLER, &approve(&["app:http:@acme/other"]))
            .await
            .unwrap();
        assert_eq!(
            web_caller_app_admitted(&state, CALLER, "@acme/other").await,
            Err(StatusCode::NOT_FOUND)
        );
    }

    /// Anonymous callers and an unbound node (this test process) are refused before
    /// any manifest or grant fact is consulted, even when every one of them holds.
    #[tokio::test]
    async fn web_delegated_admission_refuses_anonymous_and_unbound_callers() {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let facts = WebDelegationFacts {
            route_declares_permission: true,
            target_supports_web: true,
            caller_app: Some(WebCallerApp {
                id: "@acme/target".to_owned(),
                supports_web: true,
                has_companion: true,
            }),
        };
        assert_eq!(
            web_delegated_admission(&state, "@acme/target", &None, &facts).await,
            Err(StatusCode::FORBIDDEN)
        );
        let member = crate::identity_verify::VerifiedCaller {
            user_id: "alice".to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org1".to_owned()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        };
        assert!(crate::sidecar::control_plane::registered_org().is_none());
        assert_eq!(
            web_delegated_admission(&state, "@acme/target", &Some(member), &facts).await,
            Err(StatusCode::FORBIDDEN)
        );
    }

    /// End to end through `proxy_for_plugin`: the marker refuses before the
    /// registration/wake gate (403, nothing dialed or woken), while the same request
    /// WITHOUT the marker is unchanged and reaches that gate (503: no sidecar is
    /// registered in this isolated state). The refusal is the same on an annotated
    /// and an unannotated route.
    #[tokio::test]
    async fn web_delegated_requests_are_refused_before_the_sidecar_gate() {
        const APP: &str = "@acme/target";
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        state.app_store.insert(APP, "1.0.0").await.unwrap();
        state
            .app_store
            .set_enabled(APP, &["app:http".to_owned()])
            .await
            .unwrap();
        state
            .app_manifests
            .write()
            .await
            .push(web_app(APP, Some("full"), true, &["app:http"]));

        let request = |path: &str, web: bool| {
            let mut builder = Request::builder()
                .method("GET")
                .uri(format!("/api/ext/{APP}{path}"));
            if web {
                builder = builder
                    .header(HDR_WEB_DELEGATION, "1")
                    .header(HDR_APP_CALLER, APP);
            }
            builder.body(Body::empty()).unwrap()
        };

        for path in ["/items", "/open"] {
            let refused = proxy_for_plugin(&state, APP, path, None, request(path, true)).await;
            assert_eq!(refused.status(), StatusCode::FORBIDDEN, "web {path}");

            let unchanged = proxy_for_plugin(&state, APP, path, None, request(path, false)).await;
            assert_eq!(
                unchanged.status(),
                StatusCode::SERVICE_UNAVAILABLE,
                "a request without the marker must reach the registration gate ({path})"
            );
        }
        assert!(
            !state.manager.is_wake_eligible("@acme/target/svc"),
            "nothing was registered or woken"
        );
    }

    fn org_bound_node(org: &str) -> crate::sidecar::control_plane::RegisteredNode {
        crate::sidecar::control_plane::RegisteredNode {
            org: crate::sidecar::control_plane::RegisteredOrg {
                id: org.to_owned(),
                name: org.to_owned(),
                slug: None,
            },
            node_id: "node-web".to_owned(),
            scope: crate::sidecar::control_plane::NodeScope::Org,
            team_id: None,
            owner_user_id: None,
        }
    }

    fn org_member(user: &str, org: &str) -> crate::identity_verify::VerifiedCaller {
        crate::identity_verify::VerifiedCaller {
            user_id: user.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some(org.to_owned()),
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        }
    }

    /// On a bound node the admission admits a member of the node's org on exactly the
    /// reviewed edge (`app:http` for the caller's own app, `app:http:<target>` for
    /// another), and refuses a caller from another org even when every fact holds.
    #[tokio::test]
    async fn web_delegated_admission_admits_a_bound_org_member_on_the_exact_edge() {
        const CALLER: &str = "@acme/webcaller";
        const TARGET: &str = "@acme/webtarget";
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        state.app_manifests.write().await.push(web_app(
            CALLER,
            Some("full"),
            true,
            &["app:http", "app:http:@acme/webtarget"],
        ));
        state.app_store.insert(CALLER, "1.0.0").await.unwrap();
        state
            .app_store
            .set_enabled(CALLER, &["app:http".to_owned()])
            .await
            .unwrap();
        let facts = WebDelegationFacts {
            route_declares_permission: true,
            target_supports_web: true,
            caller_app: Some(WebCallerApp {
                id: CALLER.to_owned(),
                supports_web: true,
                has_companion: true,
            }),
        };

        crate::sidecar::control_plane::with_test_node_binding(
            true,
            Some(org_bound_node("org1")),
            async {
                let member = Some(org_member("alice", "org1"));
                assert_eq!(
                    web_delegated_admission(&state, CALLER, &member, &facts).await,
                    Ok(()),
                    "own app under app:http"
                );
                assert_eq!(
                    web_delegated_admission(&state, TARGET, &member, &facts).await,
                    Err(StatusCode::NOT_FOUND),
                    "app:http never reaches another app"
                );
                let outsider = Some(org_member("mallory", "org2"));
                assert_eq!(
                    web_delegated_admission(&state, CALLER, &outsider, &facts).await,
                    Err(StatusCode::FORBIDDEN),
                    "a caller from another org"
                );

                state
                    .app_store
                    .set_enabled(CALLER, &["app:http:@acme/webtarget".to_owned()])
                    .await
                    .unwrap();
                assert_eq!(
                    web_delegated_admission(&state, TARGET, &member, &facts).await,
                    Ok(()),
                    "another app under its exact app:http:<target> edge"
                );
                assert_eq!(
                    web_delegated_admission(&state, TARGET, &outsider, &facts).await,
                    Err(StatusCode::FORBIDDEN)
                );
            },
        )
        .await;
    }

    /// End to end through `proxy_for_plugin` on a bound node, with real signed user
    /// JWTs and a registered fake sidecar: an admitted web request reaches the sidecar
    /// and is marked admitted; the same request without the marker is not marked; the
    /// route permission still applies to an admitted caller; an unannotated route and
    /// another org's caller are refused before the sidecar is dialed.
    #[tokio::test]
    async fn an_admitted_web_request_reaches_the_sidecar_and_is_marked_admitted() {
        use crate::server::multiplayer_journey_tests::TestIdentityProvider;
        use crate::sidecar::capability_consumer::test_support::{
            register_sidecar_for, reserve_port, serve,
        };
        const APP: &str = "@acme/webforward";
        const ORG: &str = "org-webforward";

        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let port = reserve_port();
        let mut manifest = web_app(APP, Some("full"), true, &["app:http"]);
        let sidecar = &mut manifest.sidecars[0];
        sidecar.name = "engine".to_owned();
        sidecar.port = port;
        // A kernel permission a member holds and a viewer does not.
        sidecar.http.as_mut().expect("fixture http").routes[0].permission =
            Some(crate::identity_verify::permissions::SPACE_WRITE.to_owned());
        state.app_manifests.write().await.push(manifest);
        state.app_store.insert(APP, "1.0.0").await.unwrap();
        state
            .app_store
            .set_enabled(APP, &["app:http".to_owned()])
            .await
            .unwrap();
        let _sidecar = register_sidecar_for(&state.manager, APP, port).await;
        let reached = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = reached.clone();
        let router = Router::new()
            .route(
                "/api/svc/items",
                get(move || {
                    let counter = counter.clone();
                    async move {
                        counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        Json(json!({ "items": ["a"] }))
                    }
                }),
            )
            .route(
                "/api/svc/open",
                get(|| async { Json(json!({ "open": true })) }),
            );
        let server = serve(port, router).await;

        let identity = TestIdentityProvider::start().await;
        let member = identity.mint("web-member", ORG, "member", &[]);
        let viewer = identity.mint("web-viewer", ORG, "viewer", &[]);
        let outsider = identity.mint("web-outsider", "org-elsewhere", "member", &[]);
        let request = |path: &str, jwt: &str, web: bool| {
            let mut builder = Request::builder()
                .method("GET")
                .uri(format!("/api/ext/{APP}{path}"))
                .header("x-ryu-user-jwt", jwt);
            if web {
                builder = builder
                    .header(HDR_WEB_DELEGATION, "1")
                    .header(HDR_APP_CALLER, APP);
            }
            builder.body(Body::empty()).unwrap()
        };

        crate::sidecar::control_plane::with_test_node_binding(
            true,
            Some(org_bound_node(ORG)),
            async {
                let admitted = proxy_for_plugin(
                    &state,
                    APP,
                    "/items",
                    None,
                    request("/items", &member, true),
                )
                .await;
                assert_eq!(admitted.status(), StatusCode::OK);
                assert_eq!(
                    admitted.headers().get(HDR_WEB_DELEGATION).unwrap(),
                    WEB_DELEGATION_ADMITTED
                );
                let body = axum::body::to_bytes(admitted.into_body(), 1024)
                    .await
                    .unwrap();
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                    json!({ "items": ["a"] })
                );
                assert_eq!(reached.load(std::sync::atomic::Ordering::SeqCst), 1);

                let direct = proxy_for_plugin(
                    &state,
                    APP,
                    "/items",
                    None,
                    request("/items", &member, false),
                )
                .await;
                assert_eq!(direct.status(), StatusCode::OK);
                assert!(
                    direct.headers().get(HDR_WEB_DELEGATION).is_none(),
                    "only a web-delegated forward is marked admitted"
                );
                assert_eq!(reached.load(std::sync::atomic::Ordering::SeqCst), 2);

                for (jwt, path, expected, why) in [
                    (&viewer, "/items", StatusCode::FORBIDDEN, "route permission"),
                    (&outsider, "/items", StatusCode::FORBIDDEN, "another org"),
                    (&member, "/open", StatusCode::NOT_FOUND, "unannotated route"),
                ] {
                    let refused =
                        proxy_for_plugin(&state, APP, path, None, request(path, jwt, true)).await;
                    assert_eq!(refused.status(), expected, "{why}");
                    assert!(refused.headers().get(HDR_WEB_DELEGATION).is_none(), "{why}");
                }
                assert_eq!(
                    reached.load(std::sync::atomic::Ordering::SeqCst),
                    2,
                    "no refused request reached the sidecar"
                );
            },
        )
        .await;
        server.abort();
    }

    /// The web tier forwards only to a Core whose `GET /api/version` advertises the
    /// admission this module runs.
    #[test]
    fn version_advertises_the_web_delegated_admission() {
        assert!(crate::update::version_info()
            .features
            .iter()
            .any(|feature| feature == crate::update::FEATURE_WEB_DELEGATED_EXT));
    }

    /// A derived-index sidecar (`caller_resource_scope: "conversation"`) must receive
    /// exactly the conversations the VERIFIED caller may read on a shared node: Bob
    /// never sees Alice's private chat id, and a caller-forged scope header is
    /// replaced, not trusted. This is the Core half of the Mission Control fix.
    #[tokio::test]
    async fn conversation_scope_carries_only_the_verified_callers_conversations() {
        use crate::server::conversations::Tenancy;
        use crate::server::multiplayer_journey_tests::TestIdentityProvider;
        use crate::sidecar::capability_consumer::test_support::{
            register_sidecar_for, reserve_port, serve,
        };
        const APP: &str = "@acme/derived-index";
        const ORG: &str = "org-derived";

        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let port = reserve_port();
        let mut manifest = web_app(APP, None, false, &["app:http"]);
        let sidecar = &mut manifest.sidecars[0];
        sidecar.name = "engine".to_owned();
        sidecar.port = port;
        let http = sidecar.http.as_mut().expect("fixture http");
        http.caller_resource_scope = Some("conversation".to_owned());
        http.routes[0].permission =
            Some(crate::identity_verify::permissions::SPACE_WRITE.to_owned());
        state.app_manifests.write().await.push(manifest);
        state.app_store.insert(APP, "1.0.0").await.unwrap();
        state
            .app_store
            .set_enabled(APP, &["app:http".to_owned()])
            .await
            .unwrap();
        for (conversation, owner) in [("alice-private", "alice"), ("bob-private", "bob")] {
            state
                .conversations
                .ensure_conversation(
                    conversation,
                    None,
                    Some(conversation),
                    Tenancy::Owned {
                        user_id: owner.to_owned(),
                        org_id: Some(ORG.to_owned()),
                    },
                )
                .await
                .unwrap();
        }
        let _sidecar = register_sidecar_for(&state.manager, APP, port).await;
        let seen = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<Option<String>>::new()));
        let captured = seen.clone();
        let router = Router::new().route(
            "/api/svc/items",
            get(move |headers: HeaderMap| {
                let captured = captured.clone();
                async move {
                    captured.lock().await.push(
                        headers
                            .get(HDR_CALLER_RESOURCE_IDS)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned),
                    );
                    Json(json!({ "items": [] }))
                }
            }),
        );
        let server = serve(port, router).await;

        let identity = TestIdentityProvider::start().await;
        let alice = identity.mint("alice", ORG, "member", &[]);
        let bob = identity.mint("bob", ORG, "member", &[]);
        let request = |jwt: &str| {
            Request::builder()
                .method("GET")
                .uri(format!("/api/ext/{APP}/items"))
                .header("x-ryu-user-jwt", jwt)
                // Forged: Bob claims Alice's conversation.
                .header(HDR_CALLER_RESOURCE_IDS, r#"["alice-private"]"#)
                .body(Body::empty())
                .unwrap()
        };

        crate::sidecar::control_plane::with_test_node_binding(
            true,
            Some(org_bound_node(ORG)),
            async {
                for jwt in [&bob, &alice] {
                    let response =
                        proxy_for_plugin(&state, APP, "/items", None, request(jwt)).await;
                    assert_eq!(response.status(), StatusCode::OK);
                }
                assert!(state
                    .conversations
                    .delete_conversation("alice-private")
                    .await
                    .unwrap());
                state
                    .conversations
                    .ensure_conversation(
                        "alice-private",
                        None,
                        Some("alice-private"),
                        Tenancy::Owned {
                            user_id: "bob".to_owned(),
                            org_id: Some(ORG.to_owned()),
                        },
                    )
                    .await
                    .unwrap();
                for jwt in [&bob, &alice] {
                    let response =
                        proxy_for_plugin(&state, APP, "/items", None, request(jwt)).await;
                    assert_eq!(response.status(), StatusCode::OK);
                }
            },
        )
        .await;
        server.abort();

        let seen = seen.lock().await.clone();
        let parse = |raw: &Option<String>| -> Vec<(String, String)> {
            let entries: Vec<String> =
                serde_json::from_str(raw.as_deref().expect("Core stamps the scope header"))
                    .expect("scope header is a JSON array");
            entries
                .into_iter()
                .map(|entry| {
                    let (version, id) = entry.split_once(':').expect("<version>:<id> entry");
                    (id.to_owned(), version.to_owned())
                })
                .collect()
        };
        assert_eq!(seen.len(), 4);
        let bob_scope = parse(&seen[0]);
        let alice_scope = parse(&seen[1]);
        assert_eq!(bob_scope.len(), 1);
        assert_eq!(bob_scope[0].0, "bob-private");
        assert_eq!(alice_scope.len(), 1);
        assert_eq!(alice_scope[0].0, "alice-private");
        assert_eq!(alice_scope[0].1.len(), 12);

        // Re-creation: Alice's conversation is deleted, and Bob creates a new one
        // under the SAME id. Bob now sees that id, but with a different source
        // version, so a derived index keyed on the version cannot hand him
        // Alice's old digest.
        let bob_recreated = parse(&seen[2]);
        let recreated = bob_recreated
            .iter()
            .find(|(id, _)| id == "alice-private")
            .expect("bob owns the re-created id");
        assert_ne!(
            recreated.1, alice_scope[0].1,
            "a re-created conversation must not reuse the deleted one's source version"
        );
        assert!(
            parse(&seen[3]).iter().all(|(id, _)| id != "alice-private"),
            "alice no longer sees the id bob re-created"
        );
    }

    /// A caller who may read more conversations than fit in one header keeps a
    /// working sidecar (no blanket 503): the scope is truncated to the newest ids,
    /// so it can only ever NARROW what the sidecar serves.
    #[test]
    fn caller_resource_ids_are_bounded_by_dropping_the_oldest() {
        let ids: Vec<String> = (0..20_000)
            .map(|index| format!("{index:08}-0000-4000-8000-000000000000"))
            .collect();
        let (encoded, omitted) = encode_caller_resource_ids(
            ids.iter().map(String::as_str),
            MAX_CALLER_RESOURCE_IDS_BYTES,
        );
        assert!(encoded.len() <= MAX_CALLER_RESOURCE_IDS_BYTES);
        assert!(reqwest::header::HeaderValue::from_str(&encoded).is_ok());
        let kept: Vec<String> = serde_json::from_str(&encoded).unwrap();
        assert!(omitted > 0);
        assert_eq!(kept.len() + omitted, ids.len());
        assert_eq!(
            kept[..],
            ids[..kept.len()],
            "the newest ids are kept, in order"
        );

        let (small, none_omitted) = encode_caller_resource_ids(["a", "b"].into_iter(), 64);
        assert_eq!((small.as_str(), none_omitted), (r#"["a","b"]"#, 0));
        let (empty, _) = encode_caller_resource_ids(std::iter::empty(), 64);
        assert_eq!(empty, "[]");
    }

    /// The source version binds an id to the row's immutable identity: stable for
    /// one row, different for a row re-created under the same id by anyone else
    /// or at another time.
    #[test]
    fn conversation_source_version_distinguishes_a_re_created_row() {
        use crate::server::conversations::conversation_source_version;
        let original = conversation_source_version("c1", 1_000, Some("alice"), Some("org"));
        assert_eq!(original.len(), 12);
        assert_eq!(
            original,
            conversation_source_version("c1", 1_000, Some("alice"), Some("org"))
        );
        for other in [
            conversation_source_version("c1", 1_000, Some("bob"), Some("org")),
            conversation_source_version("c1", 1_001, Some("alice"), Some("org")),
            conversation_source_version("c1", 1_000, Some("alice"), Some("other-org")),
            conversation_source_version("c1", 1_000, None, None),
        ] {
            assert_ne!(original, other);
        }
    }

    #[test]
    fn caller_resource_ids_stay_valid_header_values_for_any_id() {
        let ids = [
            "plain",
            "quote\"back\\slash",
            "café",
            "emoji-\u{1F600}",
            "tab\tnl\n",
        ];
        let (encoded, omitted) =
            encode_caller_resource_ids(ids.into_iter(), MAX_CALLER_RESOURCE_IDS_BYTES);
        assert_eq!(omitted, 0);
        assert!(encoded.is_ascii());
        assert!(reqwest::header::HeaderValue::from_str(&encoded).is_ok());
        let decoded: Vec<String> = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, ids);
    }

    #[test]
    fn copy_headers_strips_caller_supplied_identity_headers() {
        let mut src = HeaderMap::new();
        src.insert(HDR_CALLER_USER_ID, "forged-user".parse().unwrap());
        src.insert(HDR_CALLER_ORG_ID, "forged-org".parse().unwrap());
        src.insert(HDR_CALLER_EMAIL, "owner@example.com".parse().unwrap());
        src.insert(HDR_CALLER_AGENT_ID, "forged-agent".parse().unwrap());
        src.insert(HDR_CALLER_AGENT_PROOF, "forged-proof".parse().unwrap());
        src.insert(
            crate::sidecar::deferred_authorization::AGENT_GRANT_HEADER,
            "forged-grant".parse().unwrap(),
        );
        src.insert(HDR_CALLER_RATE_SUBJECT, "peer:forged".parse().unwrap());
        src.insert("content-type", "application/json".parse().unwrap());

        let mut dst = reqwest::header::HeaderMap::new();
        copy_headers(&src, &mut dst, &[]);

        for name in [
            HDR_CALLER_USER_ID,
            HDR_CALLER_ORG_ID,
            HDR_CALLER_EMAIL,
            HDR_CALLER_AGENT_ID,
            HDR_CALLER_AGENT_PROOF,
            crate::sidecar::deferred_authorization::AGENT_GRANT_HEADER,
            HDR_CALLER_RATE_SUBJECT,
        ] {
            assert!(
                dst.get(name).is_none(),
                "a caller must not forge the {name} hop header"
            );
        }
        assert!(dst.get("content-type").is_some());
    }

    /// The rate subject tells clients apart without carrying their address: one
    /// subject per IPv4 address or IPv6 /64, scoped to the plugin, keyed on the
    /// verified user when there is one, and `unknown` when Core cannot tell.
    #[test]
    fn rate_subject_distinguishes_clients_and_never_carries_the_address() {
        use std::net::IpAddr;
        let ip = |raw: &str| Some(raw.parse::<IpAddr>().unwrap());
        let app = "@ryu/feedback-board";
        let a = rate_subject_for(app, None, ip("203.0.113.7"));
        assert!(
            a.starts_with("peer:") && a.len() == "peer:".len() + 24,
            "{a}"
        );
        assert!(!a.contains("203.0.113.7"));
        assert_eq!(a, rate_subject_for(app, None, ip("203.0.113.7")));
        assert_ne!(a, rate_subject_for(app, None, ip("203.0.113.8")));
        assert_ne!(a, rate_subject_for("@ryu/other", None, ip("203.0.113.7")));
        // An IPv4-mapped IPv6 peer is the same client as its IPv4 form.
        assert_eq!(a, rate_subject_for(app, None, ip("::ffff:203.0.113.7")));
        // One /64 is one client: rotating the interface id does not mint subjects.
        assert_eq!(
            rate_subject_for(app, None, ip("2001:db8:1:2::1")),
            rate_subject_for(app, None, ip("2001:db8:1:2:ffff::9"))
        );
        assert_ne!(
            rate_subject_for(app, None, ip("2001:db8:1:2::1")),
            rate_subject_for(app, None, ip("2001:db8:1:3::1"))
        );
        assert_eq!(rate_subject_for(app, None, None), "unknown");
        let caller = crate::identity_verify::VerifiedCaller {
            user_id: "member-a".to_owned(),
            email: None,
            email_verified: false,
            org_id: None,
            role: crate::identity_verify::OrgRole::Member,
            teams: Vec::new(),
        };
        let user = rate_subject_for(app, Some(&caller), ip("203.0.113.7"));
        assert!(user.starts_with("user:"), "{user}");
        assert_eq!(
            user,
            rate_subject_for(app, Some(&caller), ip("198.51.100.1"))
        );
    }

    /// The subject Core stamps for an anonymous request, exactly as the forward
    /// path computes it (`rate_subject_for(.., request_client_ip(&req))`), for a
    /// request whose socket peer is `peer` and which carries `forwarded_for`.
    fn anonymous_subject_for_peer(peer: &str, forwarded_for: Option<&str>) -> String {
        let peer: std::net::SocketAddr = peer.parse().unwrap();
        let mut builder = Request::builder().uri("/api/ext/@ryu/feedback-board/x");
        if let Some(forwarded_for) = forwarded_for {
            builder = builder.header("x-forwarded-for", forwarded_for);
        }
        let mut req = builder.body(Body::empty()).unwrap();
        req.extensions_mut()
            .insert(axum::extract::ConnectInfo(peer));
        rate_subject_for("@ryu/feedback-board", None, request_client_ip(&req))
    }

    /// The round-2 gap: a reverse proxy on the same host (nginx, Caddy, a
    /// user-run cloudflared) or the LAN that Core was not told to trust is the
    /// socket peer of EVERY visitor. Keying a per-client bucket on it let one
    /// visitor spend the 5/hour bound for the whole board. Such a peer is not a
    /// distinct client, so its subject is `unknown` (the node-wide backstop), and
    /// a forged `X-Forwarded-For` through it still cannot pick a subject.
    #[test]
    fn a_local_or_private_peer_is_not_a_per_client_subject() {
        // Loopback with no forwarding tunnel: a same-host reverse proxy.
        assert!(!crate::sidecar::forwarding_tunnel_active());
        assert!(crate::vault::tokens::trusted_proxies().is_empty());
        for peer in [
            "127.0.0.1:50000",
            "[::1]:50000",
            "[::ffff:127.0.0.1]:50000",
            // RFC 1918, carrier-grade NAT, link-local, IPv6 ULA and link-local.
            "10.0.0.5:443",
            "172.16.4.2:443",
            "192.168.1.20:443",
            "100.64.1.1:443",
            "169.254.10.10:443",
            "[::ffff:10.0.0.5]:443",
            "[fd12:3456:789a::1]:443",
            "[fe80::1]:443",
        ] {
            assert_eq!(anonymous_subject_for_peer(peer, None), "unknown", "{peer}");
            // A visitor behind that proxy cannot pick a subject by forging the
            // header: the peer is not a trusted proxy, so it is ignored.
            assert_eq!(
                anonymous_subject_for_peer(peer, Some("203.0.113.9")),
                "unknown",
                "{peer}"
            );
        }
        // Visitors behind one untrusted local proxy therefore never share a
        // small per-client bucket keyed on the proxy's address.
        assert_eq!(
            anonymous_subject_for_peer("127.0.0.1:1", None),
            anonymous_subject_for_peer("127.0.0.1:2", None)
        );

        // A public peer is still its own client, and a forged header from it is
        // ignored rather than letting it rotate subjects.
        let public = anonymous_subject_for_peer("198.51.100.20:443", None);
        assert!(public.starts_with("peer:"), "{public}");
        assert_eq!(
            public,
            anonymous_subject_for_peer("198.51.100.20:443", Some("203.0.113.9"))
        );
        assert!(anonymous_subject_for_peer("[2001:db8:5::1]:443", None).starts_with("peer:"));
        // Behind a proxy Core does trust, the forwarded client address is the
        // subject: a public client is per-client, a private one is `unknown`.
        let trusted = [crate::vault::tokens::Cidr::parse("127.0.0.1/32").unwrap()];
        let via_trusted = |forwarded: &str| {
            rate_subject_for(
                "@ryu/feedback-board",
                None,
                crate::vault::tokens::resolve_client_ip(
                    Some("127.0.0.1".parse().unwrap()),
                    Some(forwarded),
                    &trusted,
                    false,
                ),
            )
        };
        assert!(via_trusted("203.0.113.9").starts_with("peer:"));
        assert_ne!(via_trusted("203.0.113.9"), via_trusted("203.0.113.10"));
        assert_eq!(via_trusted("10.1.2.3"), "unknown");
        // Boundary addresses just outside the local/shared ranges stay public.
        for peer in [
            "172.32.0.1:443",
            "100.128.0.1:443",
            "11.0.0.1:443",
            "[fe00::1]:443",
        ] {
            assert!(
                anonymous_subject_for_peer(peer, None).starts_with("peer:"),
                "{peer}"
            );
        }
    }

    /// With the forwarding tunnel active, a loopback peer is a remote client of
    /// unknown address: also `unknown`.
    #[tokio::test]
    async fn a_loopback_peer_behind_the_tunnel_is_unknown() {
        let subject = crate::sidecar::FORCE_FORWARDING_FOR_TEST
            .scope(true, async {
                anonymous_subject_for_peer("127.0.0.1:50000", None)
            })
            .await;
        assert_eq!(subject, "unknown");
    }

    /// Only Core's rate subject crosses the hop: a forged copy is replaced when
    /// the sidecar opted in and stripped when it did not.
    #[tokio::test]
    async fn forward_stamps_cores_rate_subject_over_a_forged_copy() {
        use axum::routing::get;
        use axum::Router;
        use std::sync::Arc;

        let seen = Arc::new(tokio::sync::Mutex::new(Vec::<Option<String>>::new()));
        let captured = seen.clone();
        let app = Router::new().route(
            "/who",
            get(move |headers: HeaderMap| {
                let captured = captured.clone();
                async move {
                    captured.lock().await.push(
                        headers
                            .get(HDR_CALLER_RATE_SUBJECT)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned),
                    );
                    "ok"
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut forged = HeaderMap::new();
        forged.insert(HDR_CALLER_RATE_SUBJECT, "peer:forged".parse().unwrap());
        for subject in [Some("peer:0123456789abcdef01234567"), None] {
            let response = forward_to_sidecar(ForwardArgs {
                target: ForwardTarget::for_test(port),
                upstream_path: "/who",
                query: "",
                method: reqwest::Method::GET,
                src_headers: &forged,
                body: Vec::new(),
                hop_plugin_id: "com.test.rate-subject",
                forward_payment_authorization: false,
                forward_cookie_names: &[],
                forward_caller_email: false,
                caller: None,
                caller_resource_ids: None,
                caller_rate_subject: subject,
                caller_agent_id: None,
                caller_agent_restricted: false,
                event_delivery: None,
            })
            .await;
            assert_eq!(response.status(), StatusCode::OK);
        }
        assert_eq!(
            *seen.lock().await,
            vec![Some("peer:0123456789abcdef01234567".to_owned()), None]
        );
        server.abort();
    }

    /// The rate subject is an explicit per-app opt-in, declared only by the public
    /// feedback board to bound anonymous vote identities per client.
    #[test]
    fn only_the_feedback_board_opts_into_the_rate_subject() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let opted_in: Vec<&str> = manifests
            .iter()
            .filter(|manifest| {
                manifest
                    .sidecars
                    .iter()
                    .filter_map(|sidecar| sidecar.http.as_ref())
                    .any(|http| http.forward_caller_rate_subject)
            })
            .map(|manifest| manifest.id.as_str())
            .collect();
        assert_eq!(opted_in, vec!["@ryu/feedback-board"]);
    }

    /// The hop carries the verified email from the signed identity token, never a
    /// caller-chosen copy, and omits the header when the token has no email or
    /// does not mark it `email_verified` (a forged copy is still stripped then).
    #[tokio::test]
    async fn forward_stamps_the_verified_caller_email_over_a_forged_copy() {
        use axum::routing::get;
        use axum::Router;
        use std::sync::Arc;

        let seen = Arc::new(tokio::sync::Mutex::new(Vec::<Option<String>>::new()));
        let captured = seen.clone();
        let app = Router::new().route(
            "/who",
            get(move |headers: HeaderMap| {
                let captured = captured.clone();
                async move {
                    captured.lock().await.push(
                        headers
                            .get(HDR_CALLER_EMAIL)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned),
                    );
                    "ok"
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut forged = HeaderMap::new();
        forged.insert(HDR_CALLER_EMAIL, "victim@example.com".parse().unwrap());
        let caller =
            |email: Option<&str>, email_verified: bool| crate::identity_verify::VerifiedCaller {
                user_id: "member-a".to_owned(),
                email: email.map(str::to_owned),
                email_verified,
                org_id: Some("org-1".to_owned()),
                role: crate::identity_verify::OrgRole::Member,
                teams: Vec::new(),
            };
        let verified = caller(Some("member@example.com"), true);
        // A valid session whose identity provider never proved the mailbox: the
        // address must not satisfy a sidecar's email-addressed grant.
        let unverified = caller(Some("unproven@example.com"), false);
        let without_email = caller(None, true);
        // (caller, manifest opted in): only an opted-in sidecar receives the
        // verified email, and the forged copy never crosses any hop.
        for (current, opted_in) in [
            (Some(&verified), true),
            (Some(&verified), false),
            (Some(&unverified), true),
            (Some(&without_email), true),
            (None, true),
        ] {
            let response = forward_to_sidecar(ForwardArgs {
                target: ForwardTarget::for_test(port),
                upstream_path: "/who",
                query: "",
                method: reqwest::Method::GET,
                src_headers: &forged,
                body: Vec::new(),
                hop_plugin_id: "com.test.caller-email",
                forward_payment_authorization: false,
                forward_cookie_names: &[],
                forward_caller_email: opted_in,
                caller: current,
                caller_resource_ids: None,
                caller_rate_subject: None,
                caller_agent_id: None,
                caller_agent_restricted: false,
                event_delivery: None,
            })
            .await;
            assert_eq!(response.status(), StatusCode::OK);
        }
        assert_eq!(
            *seen.lock().await,
            vec![
                Some("member@example.com".to_owned()),
                None,
                None,
                None,
                None
            ],
            "only an opted-in sidecar receives Core's verified email"
        );
        server.abort();
    }

    fn agent_lane_request(uri: &str, headers: &[(&str, &str)]) -> Request {
        let mut builder = axum::http::Request::builder().method("POST").uri(uri);
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(axum::body::Body::empty()).unwrap()
    }

    /// Any app learns its calling agent from a header signed over the exact
    /// request. A named agent without a valid proof is refused, never
    /// downgraded to an agent-less call.
    #[test]
    fn non_browser_agent_lane_requires_a_proof_for_the_exact_request() {
        let uri = "/api/ext/@ryu/social/posts?workspace_id=w1";
        let path_and_query = "/api/ext/@ryu/social/posts?workspace_id=w1";
        let proof = sign_agent_lane("agent-1", "POST", path_and_query)
            .expect("an isolated test node has a token");

        let signed = agent_lane_request(
            uri,
            &[
                (HDR_CALLER_AGENT_ID, "agent-1"),
                (HDR_CALLER_AGENT_PROOF, &proof),
            ],
        );
        assert_eq!(
            verified_agent_lane(&signed, "@ryu/social").ok().flatten(),
            Some("agent-1".to_owned())
        );

        let anonymous = agent_lane_request(uri, &[]);
        assert_eq!(
            verified_agent_lane(&anonymous, "@ryu/social").ok(),
            Some(None)
        );

        for headers in [
            vec![(HDR_CALLER_AGENT_ID, "agent-1")],
            vec![
                (HDR_CALLER_AGENT_ID, "agent-2"),
                (HDR_CALLER_AGENT_PROOF, proof.as_str()),
            ],
            vec![
                (HDR_CALLER_AGENT_ID, "agent-1"),
                (HDR_CALLER_AGENT_PROOF, "00"),
            ],
        ] {
            let response = verified_agent_lane(&agent_lane_request(uri, &headers), "@ryu/social")
                .expect_err("a bad agent lane is refused");
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{headers:?}");
        }
        // The proof covers the query, so it cannot be moved to another request.
        let moved = agent_lane_request(
            "/api/ext/@ryu/social/posts?workspace_id=w2",
            &[
                (HDR_CALLER_AGENT_ID, "agent-1"),
                (HDR_CALLER_AGENT_PROOF, &proof),
            ],
        );
        assert!(verified_agent_lane(&moved, "@ryu/social").is_err());
        let twice = agent_lane_request(
            uri,
            &[
                (HDR_CALLER_AGENT_ID, "agent-1"),
                (HDR_CALLER_AGENT_ID, "agent-1"),
                (HDR_CALLER_AGENT_PROOF, &proof),
            ],
        );
        assert_eq!(
            verified_agent_lane(&twice, "@ryu/social")
                .expect_err("a repeated agent header is refused")
                .status(),
            StatusCode::BAD_REQUEST
        );
        // The Browser keeps its query lane: a header alone names no lane there.
        assert_eq!(
            verified_agent_lane(
                &agent_lane_request(
                    "/api/ext/@ryu/browser/sessions",
                    &[(HDR_CALLER_AGENT_ID, "agent-1")]
                ),
                "@ryu/browser"
            )
            .ok(),
            Some(None)
        );
    }

    /// A verified calling agent reaches the app with a Core-signed grant bound
    /// to that app, which the app hands back on `providers.call`.
    #[tokio::test]
    async fn forward_stamps_an_agent_grant_bound_to_the_hop_plugin() {
        use axum::routing::get;
        use axum::Router;
        use std::sync::Arc;

        let seen = Arc::new(tokio::sync::Mutex::new(Vec::<(
            Option<String>,
            Option<String>,
        )>::new()));
        let captured = seen.clone();
        let app = Router::new().route(
            "/who",
            get(move |headers: HeaderMap| {
                let captured = captured.clone();
                async move {
                    let read = |name: &str| {
                        headers
                            .get(name)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned)
                    };
                    captured.lock().await.push((
                        read(HDR_CALLER_AGENT_ID),
                        read(crate::sidecar::deferred_authorization::AGENT_GRANT_HEADER),
                    ));
                    "ok"
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let mut forged = HeaderMap::new();
        forged.insert(
            crate::sidecar::deferred_authorization::AGENT_GRANT_HEADER,
            "forged-grant".parse().unwrap(),
        );
        for agent in [Some("agent-1"), None] {
            let response = forward_to_sidecar(ForwardArgs {
                target: ForwardTarget::for_test(port),
                upstream_path: "/who",
                query: "",
                method: reqwest::Method::GET,
                src_headers: &forged,
                body: Vec::new(),
                hop_plugin_id: "@ryu/social",
                forward_payment_authorization: false,
                forward_cookie_names: &[],
                forward_caller_email: false,
                caller: None,
                caller_resource_ids: None,
                caller_rate_subject: None,
                caller_agent_id: agent,
                caller_agent_restricted: agent.is_some(),
                event_delivery: None,
            })
            .await;
            assert_eq!(response.status(), StatusCode::OK);
        }
        server.abort();
        let seen = seen.lock().await;
        let (agent, grant) = &seen[0];
        assert_eq!(agent.as_deref(), Some("agent-1"));
        let grant = grant.as_deref().expect("a calling agent gets a grant");
        assert_eq!(
            crate::sidecar::deferred_authorization::verify_agent_grant(grant, "@ryu/social"),
            Ok("agent-1".to_owned())
        );
        assert!(
            crate::sidecar::deferred_authorization::verify_agent_grant(grant, "@ryu/ugc").is_err()
        );
        assert_eq!(seen[1], (None, None), "no agent, no grant, no forged copy");
    }

    /// While Core forwards a restricted agent's request, the app is marked as
    /// serving an agent, so its grant-less `providers.call`s are refused. The
    /// mark covers the whole response body and ends with it; a request with no
    /// agent, or from an unrestricted agent, sets none, so the app's own work
    /// (a user's widget refresh, a scheduled job) is never held up by it.
    #[tokio::test]
    async fn forward_marks_the_app_as_serving_an_agent_until_the_body_ends() {
        use crate::sidecar::deferred_authorization::has_active_agent_request;
        use axum::routing::get;
        use axum::Router;
        use std::sync::Arc;

        // Not an app constant: a test-only id no other test forwards to.
        let plugin: &'static str = "test.agent-context-forward";
        let seen = Arc::new(tokio::sync::Mutex::new(Vec::<bool>::new()));
        let captured = seen.clone();
        let app = Router::new().route(
            "/work",
            get(move || {
                let captured = captured.clone();
                async move {
                    captured.lock().await.push(has_active_agent_request(plugin));
                    "done"
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        for (agent, restricted) in [
            (Some("agent-1"), true),
            (Some("unrestricted-agent"), false),
            (None, false),
        ] {
            let response = forward_to_sidecar(ForwardArgs {
                target: ForwardTarget::for_test(port),
                upstream_path: "/work",
                query: "",
                method: reqwest::Method::GET,
                src_headers: &HeaderMap::new(),
                body: Vec::new(),
                hop_plugin_id: plugin,
                forward_payment_authorization: false,
                forward_cookie_names: &[],
                forward_caller_email: false,
                caller: None,
                caller_resource_ids: None,
                caller_rate_subject: None,
                caller_agent_id: agent,
                caller_agent_restricted: restricted,
                event_delivery: None,
            })
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                has_active_agent_request(plugin),
                restricted,
                "the mark lasts while the body is still unread"
            );
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(&body[..], b"done");
            assert!(
                !has_active_agent_request(plugin),
                "the mark ends with the body"
            );
        }
        server.abort();
        assert_eq!(*seen.lock().await, vec![true, false, false]);
    }

    /// The caller email is an explicit per-app opt-in. Sites declares it to match
    /// named editors and invited viewers; every other compiled app must not, so a
    /// new opt-in is a reviewed manifest change rather than a default.
    #[test]
    fn only_the_sites_manifest_opts_into_the_caller_email() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let opted_in: Vec<&str> = manifests
            .iter()
            .filter(|manifest| {
                manifest
                    .sidecars
                    .iter()
                    .filter_map(|sidecar| sidecar.http.as_ref())
                    .any(|http| http.forward_caller_email)
            })
            .map(|manifest| manifest.id.as_str())
            .collect();
        assert_eq!(opted_in, vec!["@ryu/sites"]);
    }

    /// The Sites database console actions are four-segment routes that the
    /// generic `/projects/:id/:action` route cannot reach. Pin that Core's own
    /// matcher, fed the shipped Sites manifest, admits them and nothing nearby.
    #[test]
    fn sites_manifest_declares_its_database_and_visitor_data_routes() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let sites = manifests
            .iter()
            .find(|manifest| manifest.id == "@ryu/sites")
            .expect("the Sites manifest is compiled into the catalog");
        for (path, method) in [
            ("/projects/site-1/database/connect", "POST"),
            ("/projects/site-1/database/query", "POST"),
            ("/projects/site-1/database", "GET"),
            ("/projects/site-1/visitors", "GET"),
            ("/projects/site-1/visitors/dmlzaXRvci1h/data", "DELETE"),
        ] {
            let (_, _, route) = resolve_route(sites, path, method)
                .unwrap_or_else(|| panic!("{method} {path} must resolve"));
            assert_eq!(route.permission.as_deref(), Some("sites.manage"), "{path}");
        }
        for (path, method) in [
            ("/projects/site-1/database/drop", "POST"),
            ("/projects/site-1/database/query", "GET"),
            ("/projects/site-1/visitors/dmlzaXRvci1h/data", "GET"),
            ("/projects/site-1/visitors/dmlzaXRvci1h/files", "DELETE"),
        ] {
            assert!(
                resolve_route(sites, path, method).is_none(),
                "{method} {path} must stay undeclared"
            );
        }
    }

    #[test]
    fn copy_headers_forwards_only_manifest_declared_app_cookies() {
        let mut src = HeaderMap::new();
        src.insert(
            "cookie",
            "better-auth.session=secret; com.acme.app_session=app-secret; unknown=drop"
                .parse()
                .unwrap(),
        );

        let allowed = vec!["com.acme.app_session".to_owned()];
        let mut dst = reqwest::header::HeaderMap::new();
        copy_headers(&src, &mut dst, &allowed);

        assert_eq!(
            dst.get("cookie").and_then(|value| value.to_str().ok()),
            Some("com.acme.app_session=app-secret")
        );

        // No declaration means no browser cookie crosses the process boundary.
        let mut empty = reqwest::header::HeaderMap::new();
        copy_headers(&src, &mut empty, &[]);
        assert!(empty.get("cookie").is_none());
    }

    #[test]
    fn payment_authorization_is_forwarded_only_for_public_routes() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Payment credential-proof".parse().unwrap(),
        );

        assert_eq!(
            forwarded_payment_authorization(&headers, true)
                .and_then(|value| value.to_str().ok().map(str::to_owned))
                .as_deref(),
            Some("Payment credential-proof")
        );
        assert!(forwarded_payment_authorization(&headers, false).is_none());

        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer node-secret".parse().unwrap(),
        );
        assert!(forwarded_payment_authorization(&headers, true).is_none());
    }

    #[test]
    fn resolve_provider_route_501s_for_in_process_capability() {
        use crate::plugin_manifest::ProvidesEntry;
        let m = provider_manifest(9099, None);
        // A provides entry with no sidecar/route is in-process → broker declines.
        let in_proc = ProvidesEntry {
            capability: "rag".to_owned(),
            version: "1.0.0".to_owned(),
            ..Default::default()
        };
        let resp = resolve_provider_route(&m, &in_proc, "@ryu/rag").unwrap_err();
        assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
    }

    /// Built-in sidecars need distinct nonzero bind ports. Dialing clients use
    /// the manager registry, so a missing app is unavailable rather than a boot panic.
    #[test]
    fn builtin_app_sidecars_declare_distinct_bind_ports() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let resolved = [
            "dashboards",
            "finetune",
            "healing",
            "meetings",
            "monitors",
            "quests",
            "teams",
        ]
        .map(|app| {
            let plugin_id = format!("@ryu/{app}");
            let sidecar_name = format!("ryu-{app}");
            let manifest = manifests
                .iter()
                .find(|manifest| manifest.id == plugin_id)
                .unwrap_or_else(|| panic!("missing built-in manifest {plugin_id}"));
            let spec = manifest
                .sidecars
                .iter()
                .find(|spec| spec.name == sidecar_name)
                .unwrap_or_else(|| panic!("missing sidecar {sidecar_name} in {plugin_id}"));
            (app, crate::profile::port(spec.port))
        });
        for (app, port) in resolved {
            assert_ne!(port, 0, "{app}: manifest must declare a real sidecar port");
        }
        // Two sidecars sharing a port means whichever binds second dies and its
        // driver becomes unavailable — worth catching at fixture-edit
        // time rather than at runtime.
        let mut ports: Vec<u16> = resolved.iter().map(|(_, p)| *p).collect();
        ports.sort_unstable();
        let before = ports.len();
        ports.dedup();
        assert_eq!(
            ports.len(),
            before,
            "two built-in sidecars declare the same port: {resolved:?}"
        );
    }

    // ── Kernel capabilities (the retired per-app /api/host/<app>/* rows) ─────────

    /// Parse one built-in fixture. Compiled in with `include_str!` so a fixture that
    /// stops declaring the grant its kernel capability needs is a BUILD-time link to
    /// the real file, not a path this test can silently fail to find.
    fn fixture(raw: &str) -> crate::plugin_manifest::PluginManifest {
        serde_json::from_str(raw).expect("built-in fixture parses")
    }

    /// A scoped id spans two router segments; a legacy id must be untouched.
    ///
    /// This is the whole reason the migration needs no `%2F` anywhere: the slash in
    /// `@ryu/meetings` is a real path separator, so the id round-trips through a URL
    /// as itself.
    #[test]
    fn scoped_plugin_ids_are_reunited_from_two_path_segments() {
        // `/api/ext/@ryu/meetings/health`
        assert_eq!(
            split_scoped_plugin_path("@ryu".into(), "meetings/health".into()),
            ("@ryu/meetings".to_owned(), "health".to_owned())
        );
        // Deeper tails keep their shape.
        assert_eq!(
            split_scoped_plugin_path("@ryu".into(), "meetings/a/b/c".into()),
            ("@ryu/meetings".to_owned(), "a/b/c".to_owned())
        );
        // `/api/ext/@ryu/meetings` — the plugin root, empty tail.
        assert_eq!(
            split_scoped_plugin_path("@ryu".into(), "meetings".into()),
            ("@ryu/meetings".to_owned(), String::new())
        );
        // A legacy flat id routes exactly as before — no `@`, no rejoin. Uses a
        // SYNTHETIC third-party id on purpose: every first-party legacy id now
        // canonicalizes to a scoped one, and this branch is about the ids that never
        // will (an un-migrated third-party plugin).
        assert_eq!(
            split_scoped_plugin_path("com.acme.app".into(), "health".into()),
            ("com.acme.app".to_owned(), "health".to_owned())
        );
        assert_eq!(
            split_scoped_plugin_path("legacy-plugin".into(), "a/b".into()),
            ("legacy-plugin".to_owned(), "a/b".to_owned())
        );
    }

    /// Every kernel capability resolves from the table, and an app-provided name does
    /// NOT — it must fall through to the binding-registry half of the broker.
    #[test]
    fn kernel_capability_table_lookup_is_exact() {
        for k in KERNEL_CAPABILITIES {
            assert_eq!(
                kernel_capability(k.cap).map(|r| r.cap),
                Some(k.cap),
                "'{}' must resolve from its own table",
                k.cap
            );
        }
        // An app-provided capability (the `rag` case the broker was built for) and a
        // near-miss must not be captured by the kernel branch.
        assert!(kernel_capability("rag").is_none());
        assert!(kernel_capability("ghost.record").is_none());
        assert!(kernel_capability("").is_none());
        // User-aware operations are app host-bridge methods only: a sidecar
        // carries no signed-in user to check or record as the reviewer.
        for user_aware in [
            "webhooks.secretGet",
            "webhooks.secretSet",
            "safeActions.request",
        ] {
            assert!(kernel_capability(user_aware).is_none(), "{user_aware}");
        }
    }

    /// Pin the exact contents of the kernel-capability table.
    ///
    /// `dispatch_kernel_capability` implements the same names in a `match`, and the two
    /// can drift: a row added here with no arm falls to the fail-closed `_ => 501`, which
    /// is safe but silently dead. Pinning the list forces whoever adds a row to touch
    /// this test, which points at the match.
    ///
    /// The first seven are the capabilities that replaced the seven retired
    /// `/api/host/<app>/*` routes. `events.emit` is the first row that is NOT a
    /// retired callback but a new host primitive — the app-event emit seam. That it
    /// arrived as a table row rather than a route is the point of the table.
    ///
    /// `chat.startTurn` + `node.readings` are the app-send pair: post a turn on the
    /// user's behalf, and read the live node facts needed to decide whether to. They
    /// are the first rows that let an out-of-process app ACT on the user's account
    /// rather than only fetch or record, which is why `chat.startTurn` carries a
    /// firewall scan and an enabled-by-default approval gate on top of its grant.
    #[test]
    fn kernel_capability_table_is_pinned() {
        let names: Vec<&str> = KERNEL_CAPABILITIES.iter().map(|k| k.cap).collect();
        assert_eq!(
            names,
            vec![
                "mcp.callTool",
                "notify.fanout",
                "notify.deliver",
                "email.send",
                "email.status",
                "egress.fetch",
                "billing.recordToolCharge",
                "providers.status",
                "providers.call",
                "providers.authorize",
                "tools.call",
                "plugins.installBundle",
                "spaces.fileNotes",
                "chat.startTurn",
                "threads.ensureMainThread",
                "threads.placeInProject",
                "scopeDefaults.set",
                "scopeGuidance.set",
                "node.readings",
                "ghost.replay",
                "ghost.recordStart",
                "ghost.recordStatus",
                "ghost.recordStop",
                "events.emit",
                "realtime.publish",
                "webhooks.list",
                "webhooks.ingressStatus",
                "warmup.detect",
                "warmup.list",
                "warmup.apply",
                "warmup.runNow",
                "approvals.request",
                "runs.rerunAgent",
                "workflows.rerun",
                "vault.credentialFill",
                "vault.totpEnroll",
            ],
            "KERNEL_CAPABILITIES changed — add the matching arm to \
             `dispatch_kernel_capability` (a missing arm 501s) and update this list"
        );
    }

    /// The rows whose handler ALSO pins its calling app keep exactly the grant they
    /// were reviewed with. On these rows the grant is necessary but not sufficient
    /// (or absent), and the app pin is the remaining gate, so changing the grant must
    /// be a deliberate edit made next to the pin rationale (`server::app_mcp_call`,
    /// `server::app_notify`, `server::app_file_notes`), never a drive-by cleanup.
    #[test]
    fn kernel_capability_grants_are_pinned() {
        for (cap, grant) in [
            ("mcp.callTool", Some("tools.invoke")),
            ("notify.fanout", None),
            ("spaces.fileNotes", Some("spaces:docs")),
        ] {
            let row = kernel_capability(cap)
                .unwrap_or_else(|| panic!("'{cap}' is not in KERNEL_CAPABILITIES"));
            assert_eq!(
                row.grant, grant,
                "'{cap}' changed its grant; its handler pins the calling app because no \
                 existing grant covers it (see docs/app-boundary-extraction-plan.md)"
            );
        }
    }

    /// The naming invariant that IS the point of this table: a kernel capability is
    /// named for the host primitive it exposes, never for the app that happens to call
    /// it. A row called `monitors.spider` would just be the retired per-app route with
    /// extra steps.
    #[test]
    fn kernel_capability_names_carry_no_app_name() {
        for k in KERNEL_CAPABILITIES {
            for app in ["monitors", "meetings", "recipes", "com.ryu"] {
                assert!(
                    !k.cap.contains(app),
                    "kernel capability '{}' names the app '{app}' — name the primitive instead",
                    k.cap
                );
            }
        }
    }

    /// The gate is the declared∩approved intersection, and BOTH halves are load-bearing:
    /// a manifest cannot widen itself past what the Gateway approved, and an approval the
    /// sidecar never declared in `host_api.grants` is not a licence to use it.
    #[test]
    fn host_api_grant_needs_both_declaration_and_approval() {
        let manifest = fixture(include_str!("../../../../generated/ryu-runtime/apps-store/recipes/manifest.json"));
        let approved: HashSet<String> = ["ghost:record".to_owned()].into_iter().collect();
        assert!(host_api_grant_usable(&manifest, &approved, "ghost:record"));

        // Approved but NOT declared by the sidecar ⇒ denied.
        let over_approved: HashSet<String> = ["ghost:record".to_owned(), "spaces:docs".to_owned()]
            .into_iter()
            .collect();
        assert!(!host_api_grant_usable(
            &manifest,
            &over_approved,
            "spaces:docs"
        ));

        // Declared but NOT approved (revoked, or never validated) ⇒ denied.
        assert!(!host_api_grant_usable(
            &manifest,
            &HashSet::new(),
            "ghost:record"
        ));
    }

    /// Drift guard: each sidecar that calls a grant-bearing kernel capability must
    /// DECLARE that grant in `sidecars[].host_api.grants`, or every call 403s at
    /// runtime. Fails if a fixture drops the declaration (or a table row changes its
    /// grant without the manifests following).
    #[test]
    fn callers_declare_the_grant_their_kernel_capability_requires() {
        let healing = fixture(include_str!("../../../../generated/ryu-runtime/apps-store/healing/manifest.json"));
        let cases: [(&str, &str, &crate::plugin_manifest::PluginManifest); 9] = [
            ("approvals.request", "healing", &healing),
            ("runs.rerunAgent", "healing", &healing),
            ("workflows.rerun", "healing", &healing),
            (
                "mcp.callTool",
                "monitors",
                &fixture(include_str!(
                    "../../../../generated/ryu-runtime/apps-store/monitors/manifest.json"
                )),
            ),
            (
                "spaces.fileNotes",
                "meetings",
                &fixture(include_str!(
                    "../../../../generated/ryu-runtime/apps-store/meetings/manifest.json"
                )),
            ),
            (
                "ghost.recordStart",
                "recipes",
                &fixture(include_str!("../../../../generated/ryu-runtime/apps-store/recipes/manifest.json")),
            ),
            (
                "email.send",
                "mail",
                &fixture(include_str!("../../../../generated/ryu-runtime/apps-store/mail/manifest.json")),
            ),
            (
                "email.status",
                "mail",
                &fixture(include_str!("../../../../generated/ryu-runtime/apps-store/mail/manifest.json")),
            ),
            (
                "egress.fetch",
                "mpp",
                &fixture(include_str!("../../../../generated/ryu-runtime/apps-store/mpp/manifest.json")),
            ),
        ];
        for (cap, app, manifest) in cases {
            let grant = kernel_capability(cap)
                .unwrap_or_else(|| panic!("'{cap}' is not in KERNEL_CAPABILITIES"))
                .grant
                .unwrap_or_else(|| panic!("'{cap}' unexpectedly needs no grant"));
            let approved: HashSet<String> = [grant.to_owned()].into_iter().collect();
            assert!(
                host_api_grant_usable(manifest, &approved, grant),
                "the '{app}' sidecar must declare host_api.grants = [\"{grant}\"] for '{cap}'"
            );
            // ...and the app must be able to HOLD it: the Gateway only approves a
            // grant the manifest also lists in `permission_grants`.
            assert!(
                manifest.declares_permission_grant(grant),
                "'{app}' declares '{grant}' on its sidecar but not in permission_grants, \
                 so the Gateway can never approve it"
            );
        }
    }

    /// A **pre-installed** caller never goes through `enable_app` on a fresh install —
    /// `plugins::seed` writes its record directly with a hardcoded grant list. So if a
    /// pre-installed app's sidecar declares a `host_api` grant, the SEED table must carry
    /// that same grant, or the app ships broken out of the box: 403 on every call to
    /// its kernel capability, with no user-visible cause and nothing pointing at the
    /// seed as the reason.
    ///
    /// Derived over `CORE_PREINSTALLED` rather than naming an app. It used to name
    /// `recipes`, which was the only pre-installed caller — and when recipes left the
    /// default set this test failed on its `expect`, reporting a premise that had
    /// simply expired rather than a defect. The property is about the pre-installed SET,
    /// so it is now computed from it: today no pre-installed app declares a `host_api`
    /// grant and the loop body runs zero times, which is correct and stays correct.
    /// Promote any grant-declaring app back into `CORE_PREINSTALLED` without adding its
    /// grants to `seed_overrides` and this turns red immediately.
    #[test]
    fn preinstalled_callers_are_seeded_with_their_kernel_capability_grant() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        for spec in crate::plugins::seed::preinstalled_specs() {
            let Some(manifest) = manifests.iter().find(|m| m.id == spec.id) else {
                continue;
            };
            for needed in manifest
                .sidecars
                .iter()
                .flat_map(|s| s.host_api.iter())
                .flat_map(|h| h.grants.iter())
            {
                assert!(
                    spec.grants.contains(&needed.as_str()),
                    "'{}' is pre-installed and its sidecar declares host_api grant \
                     '{needed}', but the seed writes {:?}. A pre-installed record is written \
                     directly by `plugins::seed` and never passes through `enable_app`, so \
                     the grant must be in `seed_overrides` — otherwise a fresh install 403s \
                     on every call to that capability",
                    spec.id,
                    spec.grants
                );
            }
        }
    }

    /// The other half of the same rule, and the one that made the test above stop
    /// naming `recipes`: an OPT-IN app must NOT depend on the seed for its grants. It
    /// is enabled through `enable_app`, which validates against the Gateway and
    /// persists the approved set, so what it needs is the grant in its manifest's
    /// `permission_grants` — a seed row would be inert (`preinstalled_specs` never looks
    /// up an id outside `CORE_PREINSTALLED`) and is not a substitute.
    #[test]
    fn an_opt_in_caller_carries_its_grant_in_the_manifest_not_the_seed() {
        let id = crate::plugins::builtins::RECIPES_PLUGIN_ID;
        assert!(
            !crate::plugins::builtins::CORE_PREINSTALLED.contains(&id),
            "'{id}' is opt-in — if it is pre-installed again, this test is testing nothing \
             and the sibling above is the one that must cover it"
        );
        let grant = kernel_capability("ghost.replay")
            .expect("ghost.replay is a kernel capability")
            .grant
            .expect("ghost.replay is grant-gated");
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let manifest = manifests
            .iter()
            .find(|m| m.id == id)
            .expect("recipes is a compiled-in built-in");
        assert!(
            manifest.permission_grants.iter().any(|g| g == grant),
            "'{id}' must declare '{grant}' in permission_grants — that is the ONLY thing \
             `enable_app` can approve from, and every replay/record call 403s without it"
        );
    }

    // ── WebSocket tunnel converters ────────────────────────────────────────────

    #[test]
    fn ws_message_converters_roundtrip_payloads() {
        use axum::extract::ws::CloseFrame as AxumClose;

        // Text.
        let text = WsMessage::Text("hello".into());
        let ts = axum_to_tungstenite(text.clone());
        assert!(matches!(ts, TsMessage::Text(ref s) if s.as_str() == "hello"));
        assert_eq!(tungstenite_to_axum(ts), text);

        // Binary (the RFB wire form — byte-exact is load-bearing for VNC).
        let binary = WsMessage::Binary(vec![1u8, 2, 3, 255]);
        let ts = axum_to_tungstenite(binary.clone());
        assert!(matches!(&ts, TsMessage::Binary(b) if **b == [1u8, 2, 3, 255]));
        assert_eq!(tungstenite_to_axum(ts), binary);

        // Ping / Pong are forwarded verbatim.
        let ping = WsMessage::Ping(vec![9u8]);
        assert_eq!(tungstenite_to_axum(axum_to_tungstenite(ping.clone())), ping);
        let pong = WsMessage::Pong(vec![8u8]);
        assert_eq!(tungstenite_to_axum(axum_to_tungstenite(pong.clone())), pong);

        // Close carries code + reason through both directions. axum's `CloseCode` is
        // a `u16`; tungstenite's is a distinct type, and both convert via `.into()`.
        let close = WsMessage::Close(Some(AxumClose {
            code: 1000,
            reason: "bye".into(),
        }));
        let ts = axum_to_tungstenite(close.clone());
        assert!(
            matches!(&ts, TsMessage::Close(Some(c)) if u16::from(c.code) == 1000 && c.reason.as_ref() == "bye")
        );
        let back = tungstenite_to_axum(ts);
        assert!(matches!(&back, WsMessage::Close(Some(c)) if c.code == 1000 && c.reason == "bye"));

        // No-reason close.
        assert!(matches!(
            tungstenite_to_axum(TsMessage::Close(None)),
            WsMessage::Close(None)
        ));
        // A `Frame` variant (only reachable via raw streams) degrades to Ping, never
        // invents bytes.
        let frame =
            TsMessage::Frame(tokio_tungstenite::tungstenite::protocol::frame::Frame::ping(vec![]));
        assert!(matches!(tungstenite_to_axum(frame), WsMessage::Ping(_)));
    }
}
