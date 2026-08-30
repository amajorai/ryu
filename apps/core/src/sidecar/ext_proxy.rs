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

use axum::body::Body;
use axum::extract::{
    ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    Path, Query, Request, State,
};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, post};
use axum::{Extension, Json, Router};
use serde_json::json;
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

/// Bound on waking a lazy/idle-stopped sidecar (start + health warm-up) before the
/// proxy gives up with a 503. A resumable (`.part`) download means a later request
/// warms a slow-to-fetch binary sidecar.
const WAKE_WARMUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

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

// ── Sidecar port resolution ───────────────────────────────────────────────────

/// Resolve a manifest-declared sidecar's loopback port, profile-shifted EXACTLY the
/// way [`ext_proxy`] forwards ([`crate::profile::port`]) — so a Core-side loopback
/// driver hits the same shifted port the sidecar was told to bind under a dev/custom
/// profile.
///
/// This is the single seam every Core-side reverse-coupling (`*_client.rs`) resolves
/// its port through. It exists so no Core module re-declares an app's port: AGENTS.md
/// forbids baking a `com.ryu.<app>` fallback port into Core, and each of those clients
/// used to carry its own `*_FALLBACK_PORT` const that could silently drift from the
/// fixture it claimed to mirror.
///
/// **This is a bind-time answer, not a dial-time one — and its callers still treat it as
/// dial-time.** The ext-proxy, the capability broker and `document.parse` no longer
/// resolve a port this way: they go through
/// [`crate::sidecar::SidecarManager::forward_target`], which returns only a port the
/// manager holds a live claim on, so a sidecar whose `claim_port` was refused is refused
/// rather than handed Core-authenticated traffic and its minted `RYU_EXT_TOKEN` (see
/// [`ForwardTarget`]). The legacy `*_client.rs` drivers listed above have NOT been moved
/// onto that gate; each caches the manifest port at construction and dials it directly
/// with the plugin's ext token, so each is still exposed to a port squatted before Core
/// registered the sidecar. Moving them is a follow-on: the fix is to resolve
/// `forward_target` per call instead of caching a port, not to add a check here (this
/// function cannot see the manager). Do not add new callers.
///
/// `None` means the manifest does not declare that sidecar at all. For a **built-in**
/// that is a build-time invariant, not a runtime condition — the fixture is
/// `include_str!`d into `BUILTIN_MANIFESTS` and `load()` always parses it — so built-in
/// callers `expect` rather than invent a port. (The runtime fail-open those clients
/// document is a separate failure mode: an *unreachable* sidecar, still handled per
/// call.)
pub fn sidecar_port(
    manifests: &[crate::plugin_manifest::PluginManifest],
    plugin_id: &str,
    sidecar_name: &str,
) -> Option<u16> {
    manifests
        .iter()
        .find(|m| m.id == plugin_id)
        .and_then(|m| m.sidecars.iter().find(|s| s.name == sidecar_name))
        .map(|s| crate::profile::port(s.port))
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
        let decoded = match urlencoding::decode(&current) {
            Ok(next) => next.into_owned(),
            // Not valid percent-encoding (or not UTF-8 once decoded). Nothing
            // downstream will get a cleaner read of it than we just did.
            Err(_) => return false,
        };
        // A segment separator that only APPEARS after decoding (`..%2fadmin`) means
        // the pre-decode split never saw the boundary. Re-splitting on the next
        // round is what catches it.
        if decoded == current {
            return false;
        }
        current = decoded;
    }
    // Still changing after the bound: pathologically nested encoding. Refuse rather
    // than hand a path we have not finished understanding to the forwarder.
    true
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
    if has_dot_segment(sub_path) {
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

fn copy_headers(src: &HeaderMap, dst: &mut reqwest::header::HeaderMap) {
    for (name, value) in src.iter() {
        if is_hop_by_hop(name.as_str())
            || is_browser_context(name.as_str())
            || name
                .as_str()
                .eq_ignore_ascii_case(HDR_FORWARDED_AUTHORIZATION)
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
    let Some((spec, http, route)) = resolve_route(manifest, sub_path, &request_method) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let auth = route.auth;
    // Resolved while the manifest guard is still held, since the gate below runs
    // after it is dropped.
    let required = required_permission_for(route, sub_path, plugin_id);
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
            if provided != Some(expected) {
                return StatusCode::UNAUTHORIZED.into_response();
            }
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
        let caller = crate::server::verified_caller_from_headers(req.headers()).await;
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
                Err(e) => {
                    tracing::warn!("ext proxy: waking sidecar '{sidecar_name}' failed: {e}");
                    return (
                        StatusCode::SERVICE_UNAVAILABLE,
                        "sidecar warming up, retry shortly",
                    )
                        .into_response();
                }
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

    let (parts, body) = req.into_parts();
    let body_bytes = match axum::body::to_bytes(body, max_body).await {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                "ext proxy: request body too large",
            )
                .into_response()
        }
    };

    let query = parts
        .uri
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let upstream_path = upstream_path_for(&mount, sub_path);

    forward_to_sidecar(ForwardArgs {
        target,
        upstream_path: &upstream_path,
        query: &query,
        method: parts.method,
        src_headers: &parts.headers,
        body: body_bytes.to_vec(),
        hop_plugin_id: plugin_id,
        forward_payment_authorization: auth == RouteAuth::Public,
    })
    .await
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
    } = args;

    let hop_token = ext_token(node_token().as_deref(), hop_plugin_id);
    let port = target.port();
    let target = format!("http://127.0.0.1:{port}{upstream_path}{query}");

    // Connect-timeout only — NO total-request timeout: the response body may be a
    // long-lived SSE stream that never completes (see [`PROXY_CONNECT_TIMEOUT`]).
    let client = reqwest::Client::builder()
        .connect_timeout(PROXY_CONNECT_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut headers = reqwest::header::HeaderMap::new();
    let payment_authorization =
        forwarded_payment_authorization(src_headers, forward_payment_authorization);
    copy_headers(src_headers, &mut headers);
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
    (status, out, Body::from_stream(resp.bytes_stream())).into_response()
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

/// Query param the client may present the node token on (browsers cannot set custom
/// headers on a WS upgrade — mirrors `realtime_ws`/`voice_ws`).
const WS_TOKEN_PARAM: &str = "token";

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
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let (plugin_id, rest) = split_scoped_plugin_path(plugin_id, rest);
    ext_ws_tunnel(
        &state,
        &plugin_id,
        &format!("/{rest}"),
        expected_node_token,
        &query,
        &headers,
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
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    ext_ws_tunnel(
        &state,
        &plugin_id,
        "/",
        expected_node_token,
        &query,
        &headers,
        ws,
    )
    .await
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
    headers: &HeaderMap,
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

    // Node-token gate, mirroring `require_auth` + `realtime_ws`. A protected route
    // requires the node bearer; browsers present it via `?token=` (the query), and
    // non-browser clients may use the Authorization header instead. None configured
    // (loopback dev) ⇒ allow.
    if auth == RouteAuth::Protected {
        let active_node_token = crate::node_token::active_token();
        if let Some(expected) = active_node_token.as_deref() {
            let provided = query.get(WS_TOKEN_PARAM).map(String::as_str).or_else(|| {
                headers
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.strip_prefix("Bearer "))
            });
            if provided != Some(expected) {
                return StatusCode::UNAUTHORIZED.into_response();
            }
        }
    }

    // WebSocket upgrades cannot carry the REST user-JWT header from a browser,
    // so accept the same verified JWT in `?jwt=` that the realtime socket uses.
    // The route permission must be checked before waking the sidecar or accepting
    // the upgrade; otherwise a view-only caller could reach the control stream.
    if let Some((permission, resource_id)) = required {
        let caller = match query
            .get("jwt")
            .map(String::as_str)
            .filter(|token| !token.trim().is_empty())
        {
            Some(token) => crate::server::verified_caller_from_token(token).await,
            None => crate::server::verified_caller_from_headers(headers).await,
        };
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
                Err(e) => {
                    tracing::warn!("ext ws proxy: waking sidecar '{sidecar_name}' failed: {e}");
                    return (
                        StatusCode::SERVICE_UNAVAILABLE,
                        "sidecar warming up, retry shortly",
                    )
                        .into_response();
                }
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

    ws.on_upgrade(move |socket| bridge_ws_to_sidecar(socket, port, upstream_path, hop_token))
}

/// Bridge one accepted client socket to the sidecar's loopback WS endpoint, pumping
/// bytes (binary and text) both ways until either side closes. The hop bearer is
/// re-stamped on the upstream dial, exactly like the HTTP lane.
async fn bridge_ws_to_sidecar(
    mut client: WebSocket,
    port: u16,
    upstream_path: String,
    hop_token: String,
) {
    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

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
        .route("/api/host/rpc", post(host_rpc))
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
    let approved: HashSet<String> = record.approved_grants.into_iter().collect();
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
/// capability the Deno turn-hook sandbox and the in-desktop bridge use (one
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
/// [`PluginHookBridge`](crate::plugin_host::PluginHookBridge) the Deno turn-hook
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

    let bridge = crate::plugin_host::PluginHookBridge::new(plugin_id, grants, state);
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
    /// `None` means "the Gateway's reviewed host-primitive vocabulary has no word for
    /// this yet", NOT "unguarded". Every kernel capability is still (a) authenticated
    /// by the caller's minted [`ext_token`] and (b) pinned to its owning app by the
    /// handler itself (each one re-runs [`authenticate_sidecar`] and 403s a caller
    /// that is not the app it serves). That pair IS the gate the retired per-app route
    /// had, so a `None` row is exactly as tight as before and never looser. Adding the
    /// missing vocabulary is a Gateway governance change (`reserved_namespaces` +
    /// `default_grant_allowlist`), not a Core one.
    grant: Option<&'static str>,
}

/// The kernel-capability table — the Core-implemented half of the broker.
///
/// Every row here replaces one retired `/api/host/<app>/*` route. The handlers still
/// live in the `*_client.rs` loopback shims and still pin their calling app, so the
/// *routing* is generic today and the *tenancy* stays single-app until those shims
/// are retired; nothing in this table names an app.
const KERNEL_CAPABILITIES: &[KernelCapability] = &[
    // Run one MCP tool through Core's shared `McpRegistry`, which no sidecar can host
    // (it owns the stdio child processes). Body `{ tool, args }` → `{ result }`.
    // `tools.invoke` is the reviewed MCP tool-plane scope in the Gateway allowlist;
    // the `tools` namespace is reserved, so it can never be self-granted by name.
    KernelCapability {
        cap: "mcp.callTool",
        grant: Some("tools.invoke"),
    },
    // Raise a host notification: fan it out through the kernel notify store (per-app
    // channels + mobile push + `notification` plugin hooks) and record it on the
    // unified activity feed. Body `{ alert, targets }`.
    //
    // The one `grant: None` row. There is no host-primitive scope for "raise a
    // notification" in the Gateway's reviewed vocabulary (`notifications.*` maps to
    // `approvals:crud`, which is owner-scoped to the Approvals app and not a
    // notification-raising grant), and minting one is a Gateway change. Requiring an
    // ill-fitting scope here would be worse than none: fan-out reaches every channel
    // the user has configured, so it must not ride a grant an unrelated app can hold.
    // Until the vocabulary exists, the gate stays exactly what the retired
    // `/api/host/monitors/alert` had — minted token + the handler's app pin.
    KernelCapability {
        cap: "notify.fanout",
        grant: None,
    },
    // Deliver a user-targeted notification into the app-inbox feed on behalf of
    // the calling app. Body `{ title, body?, level?, target_user_id? }`. Unlike
    // `notify.fanout` (monitors' EXTERNAL channel fan-out), this writes the row
    // the desktop's Inbox renders, so the app's icon/name shows there. The
    // `source_app_id` stamped on the row is the AUTHENTICATED caller, never a body
    // field. `grant: None` for the same reason as `notify.fanout`: the Gateway
    // vocabulary has no reviewed "raise a notification" scope, and writing to the
    // user's own inbox is the seam's entire purpose — the gate is the minted token
    // + the enabled-app check, exactly as `events.emit` (which is also `None`).
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
    // File a notes document into a Core-owned system Space under the background
    // owner. Core owns the `SpaceStore` + its tenancy, so a sidecar cannot do this
    // itself. Body `{ title, markdown }` → `{ space_id, doc_id }`.
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
    let plugin_id = match authenticate_sidecar(&state, &headers).await {
        Ok((id, _)) => id,
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
/// re-routing rather than a rewrite). Each re-runs [`authenticate_sidecar`] and
/// refuses a caller that is not the app it serves; that pin is deliberately preserved
/// (see [`KernelCapability::grant`]).
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
            crate::monitors_client::host_spider_crawl(
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
        "node.readings" => {
            crate::server::host_chat::host_node_readings(
                State(state),
                headers,
                body!(crate::server::host_chat::ReadingsBody),
            )
            .await
        }
        "notify.fanout" => {
            crate::monitors_client::host_monitor_alert(
                State(state),
                headers,
                body!(crate::monitors_client::AlertFanoutBody),
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
        "spaces.fileNotes" => {
            crate::meetings_client::host_save_notes(
                State(state),
                headers,
                body!(crate::meetings_client::SaveNotesBody),
            )
            .await
        }
        "ghost.replay" => {
            crate::recipes_client::host_recipes_run(State(state), headers, body!(serde_json::Value))
                .await
        }
        "ghost.recordStart" => {
            crate::recipes_client::host_recipes_record_start(
                State(state),
                headers,
                body!(serde_json::Value),
            )
            .await
        }
        "ghost.recordStatus" => {
            crate::recipes_client::host_recipes_record_status(State(state), headers).await
        }
        "ghost.recordStop" => {
            crate::recipes_client::host_recipes_record_stop(State(state), headers).await
        }
        "events.emit" => host_events_emit(state, headers, body!(EventEmitBody)).await,
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
                return (StatusCode::PAYLOAD_TOO_LARGE, "capability body too large").into_response()
            }
        };
        return dispatch_kernel_capability(&cap, state, parts.headers, &bytes).await;
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
                .into_response()
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
            Err(e) => {
                tracing::warn!("broker: waking provider '{wake}' failed: {e}");
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({ "error": "provider sidecar warming up, retry shortly" })),
                )
                    .into_response();
            }
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
            return (StatusCode::PAYLOAD_TOO_LARGE, "capability body too large").into_response()
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
        upstream_path: format!("{mount}{route}"),
        wake_name,
    })
}

/// A resolved broker target: where to forward + how to wake the provider sidecar.
///
/// `pub(crate)` alongside [`resolve_provider_route`] — the facade in
/// [`crate::document_parse`] holds one of these across its submit/poll hops.
#[derive(Debug)]
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
        // become "reject anything with a percent sign", or ordinary ids with spaces or
        // slashes in them stop working.
        assert!(!has_dot_segment("/records/my%20record/fields"));
        assert!(!has_dot_segment("/records/a%2Eb/fields"));
        assert!(!has_dot_segment("/search/%7Bquery%7D"));
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
    fn public_mount_routes_include_bootstrap_apps() {
        let installed = crate::plugin_manifest::PluginManifestLoader::load_builtins()
            .into_iter()
            .filter(|manifest| manifest.id == "@ryu/mail")
            .collect::<Vec<_>>();
        let bootstrap = crate::plugin_manifest::PluginManifestLoader::load_bootstrap();
        let manifests =
            crate::plugin_manifest::PluginManifestLoader::for_router(&installed, &bootstrap);

        assert!(
            manifests.iter().any(|manifest| manifest.id == "@ryu/mail"),
            "installed Mail manifest must be available when the router is built"
        );
        for id in ["@ryu/meetings", "@ryu/teams", "@ryu/dashboards"] {
            assert!(
                manifests.iter().any(|manifest| manifest.id == id),
                "bootstrap manifest {id} must be available when the router is built"
            );
        }

        // Build the actual public-mount router: these manifests must reach route
        // construction even when production BUILTIN_MANIFESTS is system-only.
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
        src.insert("host", "127.0.0.1:9999".parse().unwrap());
        src.insert("connection", "keep-alive".parse().unwrap());
        src.insert("x-ryu-plugin-id", "com.acme.app".parse().unwrap());
        src.insert(
            HDR_FORWARDED_AUTHORIZATION,
            "Payment forged".parse().unwrap(),
        );

        let mut dst = reqwest::header::HeaderMap::new();
        copy_headers(&src, &mut dst);

        // End-to-end app headers are forwarded.
        assert_eq!(
            dst.get("content-type").map(|v| v.to_str().unwrap()),
            Some("application/json")
        );
        assert_eq!(
            dst.get("x-ryu-plugin-id").map(|v| v.to_str().unwrap()),
            Some("com.acme.app")
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

    /// Every Core-side loopback driver resolves its port from the built-in manifest
    /// ALONE — no `*_FALLBACK_PORT` const survives in Core (AGENTS.md: never bake a
    /// `com.ryu.<app>` port into Core outside the fixture).
    ///
    /// This locks the invariant those `expect`s rest on. Each `sidecar_port` panics
    /// when its fixture stops declaring the sidecar, so without this test that
    /// regression would first surface as a Core **boot panic** on a developer's
    /// machine; here it is a red build. `load_builtins` (not `load`) so the assertion
    /// does not depend on whatever the developer happens to have in `~/.ryu/plugins`.
    #[test]
    fn every_loopback_driver_resolves_its_port_from_the_builtin_manifest() {
        let manifests = crate::plugin_manifest::PluginManifestLoader::load_builtins();
        let resolved = [
            (
                "dashboards",
                crate::dashboards_client::sidecar_port(&manifests),
            ),
            ("finetune", crate::finetune_client::sidecar_port(&manifests)),
            ("healing", crate::healing_client::sidecar_port(&manifests)),
            ("meetings", crate::meetings_client::sidecar_port(&manifests)),
            ("monitors", crate::monitors_client::sidecar_port(&manifests)),
            ("quests", crate::quests_client::sidecar_port(&manifests)),
            ("teams", crate::teams_client::sidecar_port(&manifests)),
        ];
        for (app, port) in resolved {
            assert_ne!(port, 0, "{app}: manifest must declare a real sidecar port");
        }
        // Two sidecars sharing a port means whichever binds second dies and its
        // driver silently talks to the wrong app — worth catching at fixture-edit
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

    /// An app whose manifest does not declare the named sidecar resolves to `None`
    /// rather than to an invented port — the property that lets the built-in callers
    /// treat absence as a build-time invariant instead of carrying a fallback.
    #[test]
    fn sidecar_port_is_none_for_an_undeclared_sidecar() {
        let m = provider_manifest(9099, None);
        assert!(sidecar_port(std::slice::from_ref(&m), &m.id, "no-such-sidecar").is_none());
        assert!(sidecar_port(&[], "@ryu/teams", "ryu-teams").is_none());
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
                "spaces.fileNotes",
                "chat.startTurn",
                "node.readings",
                "ghost.replay",
                "ghost.recordStart",
                "ghost.recordStatus",
                "ghost.recordStop",
                "events.emit",
                "realtime.publish",
            ],
            "KERNEL_CAPABILITIES changed — add the matching arm to \
             `dispatch_kernel_capability` (a missing arm 501s) and update this list"
        );
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
        let manifest = fixture(include_str!("../../../../apps-store/recipes/manifest.json"));
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
        let cases: [(&str, &str, &crate::plugin_manifest::PluginManifest); 6] = [
            (
                "mcp.callTool",
                "monitors",
                &fixture(include_str!(
                    "../../../../apps-store/monitors/manifest.json"
                )),
            ),
            (
                "spaces.fileNotes",
                "meetings",
                &fixture(include_str!(
                    "../../../../apps-store/meetings/manifest.json"
                )),
            ),
            (
                "ghost.recordStart",
                "recipes",
                &fixture(include_str!("../../../../apps-store/recipes/manifest.json")),
            ),
            (
                "email.send",
                "mail",
                &fixture(include_str!("../../../../apps-store/mail/manifest.json")),
            ),
            (
                "email.status",
                "mail",
                &fixture(include_str!("../../../../apps-store/mail/manifest.json")),
            ),
            (
                "egress.fetch",
                "mpp",
                &fixture(include_str!("../../../../apps-store/mpp/manifest.json")),
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
                manifest.permission_grants.iter().any(|g| g == grant),
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
