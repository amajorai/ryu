//! Generic **app ⇄ HTTP** loader: turn a manifest-declared managed sidecar
//! ([`crate::sidecar::manifest_sidecar`]) into a full first-class *app* — a proxied
//! HTTP surface (`/api/ext/<plugin_id>/*`) plus an authenticated host-API callback
//! (`/api/host/*`) — driven entirely by manifest data.
//!
//! This is the generalization of what used to be the hand-coded `ryu-mail` proxy:
//! where that hardcoded its route list, its shared-secret bearer, and its verbatim
//! body/header pass-through, this module reads the SAME shape from a sidecar's
//! declarative [`HttpProxySpec`]/[`HostApiSpec`]. Mail itself now rides this engine
//! (the `com.ryu.mail` app + a `public_mount` — see [`public_mount_routes`]); the
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
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, post};
use axum::{Extension, Json, Router};
use serde_json::json;
use std::collections::HashSet;

use crate::plugin_manifest::schema::{HttpProxySpec, RouteAuth, SidecarSpec};
use crate::server::ServerState;

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

// ── Token derivation ──────────────────────────────────────────────────────────

/// The node token (`RYU_TOKEN`), trimmed + non-empty, or `None` (loopback dev with
/// no token configured — the same posture [`crate::server`]'s `require_auth` accepts,
/// where the `None` branch allows the request).
pub fn node_token() -> Option<String> {
    std::env::var("RYU_TOKEN")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// The per-plugin shared secret Core injects into a sidecar and validates on the
/// host-API callback. Derived as `sha256(node_token || plugin_id)` (a hash, NOT a
/// concatenation Core forwards) so it is deterministic — the spawn env, the proxy
/// re-stamp, and the host-API check all recompute the same value — yet plugin A's
/// token can never yield plugin B's. In loopback dev with no node token a fixed
/// `"ryu-local"` base is used so the sidecar boundary is still consistent.
pub fn ext_token(node_token: Option<&str>, plugin_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let base = node_token
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("ryu-local");
    let mut hasher = Sha256::new();
    hasher.update(base.as_bytes());
    hasher.update(b"\x00ryu-ext\x00");
    hasher.update(plugin_id.as_bytes());
    hex::encode(hasher.finalize())
}

/// Constant-time byte comparison (no `subtle` dep). Both hex tokens are the same
/// length on the happy path; a length mismatch short-circuits to `false`, which
/// leaks only length (both are fixed-length SHA-256 hex, so it leaks nothing).
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ── Route matching (the 404-gate security property) ───────────────────────────

/// Match an incoming sub-path against a declared route pattern. Supports `:param`
/// (one non-empty segment) and a trailing `*rest` (the remainder). Pure + unit-tested
/// because this IS the gate: undeclared paths must 404, and a parametric route like
/// `/inboxes/:id` must still match `/inboxes/abc` (naive string-equality would 404 it,
/// naive prefix-match would wrongly admit undeclared subpaths).
fn route_matches(pattern: &str, actual: &str) -> bool {
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
/// disagree. `%2e`/`%2E` are already decoded to `.` by the axum path extractor.
fn has_dot_segment(sub_path: &str) -> bool {
    sub_path
        .trim_start_matches('/')
        .split('/')
        .any(|seg| seg == "." || seg == "..")
}

/// Find the first sidecar on `manifest` whose declared http routes match `sub_path`,
/// returning the matched sidecar spec, its http spec, and the route's auth posture.
fn resolve_route<'a>(
    manifest: &'a crate::plugin_manifest::PluginManifest,
    sub_path: &str,
) -> Option<(&'a SidecarSpec, &'a HttpProxySpec, RouteAuth)> {
    if has_dot_segment(sub_path) {
        return None;
    }
    for spec in &manifest.sidecars {
        let Some(http) = &spec.http else { continue };
        for route in &http.routes {
            if route_matches(&route.path, sub_path) {
                return Some((spec, http, route.auth));
            }
        }
    }
    None
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
        if is_hop_by_hop(name.as_str()) || is_browser_context(name.as_str()) {
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
/// custom public prefix is only expressible for a **built-in** manifest known at
/// startup — a runtime-installed third-party app still uses `/api/ext/<id>/*`. Nothing
/// is hardcoded per-app: this iterates whatever built-ins declare a `public_mount`.
pub fn public_mount_routes(
    manifests: &[crate::plugin_manifest::PluginManifest],
    auth_token: Option<String>,
) -> Router<ServerState> {
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
            // Guard against two built-ins claiming the same public prefix (axum would
            // panic on the duplicate route); first declaration wins, warn on the rest.
            if !seen.insert(mount.to_owned()) {
                tracing::warn!(
                    "public-mount '{mount}' declared by more than one built-in; '{}' ignored",
                    manifest.id
                );
                continue;
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
    router.layer(Extension(auth_token))
}

/// Reverse-proxy one `/api/ext/<plugin_id>/<rest>` request to the owning plugin's
/// declared sidecar, verbatim. See the module docs for the auth/route model.
async fn ext_proxy(
    State(state): State<ServerState>,
    Path((plugin_id, rest)): Path<(String, String)>,
    Extension(expected_node_token): Extension<Option<String>>,
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
    expected_node_token: Option<String>,
    req: Request,
) -> Response {
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
    let Some((spec, http, auth)) = resolve_route(manifest, sub_path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Profile-aware: proxy to the SAME shifted port the sidecar was told to bind
    // (identity in release; +offset in dev/custom profiles).
    let port = crate::profile::port(spec.port);
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
        if let Some(expected) = expected_node_token.as_deref() {
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

    // Wake-on-demand — STRICTLY AFTER the auth check above, so an unauthenticated
    // caller can never spin a process. Only sidecars that opted into on-demand start
    // are touched; a plain eager sidecar (mid-download at enable, say) is left alone.
    // The `_activity` guard pins it alive + feeds its idle clock while Core sets up the
    // forward, making idle-stop real for manifest sidecars. NOTE: `forward_to_sidecar`
    // now returns the response at HEADER-arrival (its body streams), so this guard drops
    // when headers land, not at body-end. That is fine today because every SSE-serving
    // sidecar (dashboards/meetings/quests/monitors) is EAGER, so `wake_eligible` is
    // false here and the guard is `None`. A future lazy/idle-stop sidecar that serves a
    // long-lived stream would need this guard moved INTO the response `Body` so the idle
    // reaper cannot kill it mid-stream.
    let _activity = if wake_eligible {
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
        Some(state.manager.enter_request(&sidecar_name))
    } else {
        None
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
        port,
        upstream_path: &upstream_path,
        query: &query,
        method: parts.method,
        src_headers: &parts.headers,
        body: body_bytes.to_vec(),
        hop_plugin_id: plugin_id,
    })
    .await
}

/// Inputs to [`forward_to_sidecar`]. Grouped in a struct so the shared forwarder is
/// not an 8-argument function (both the inbound ext-proxy and the capability broker
/// call it).
struct ForwardArgs<'a> {
    /// The loopback port of the target sidecar.
    port: u16,
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
}

/// Forward one buffered request to a sidecar on loopback, re-stamping the hop
/// plugin's minted token, and translate the upstream response back. The single
/// place the Core→sidecar hop is performed — shared by [`ext_proxy`] and the
/// capability broker so their auth/token/hop-header handling can never drift.
async fn forward_to_sidecar(args: ForwardArgs<'_>) -> Response {
    let ForwardArgs {
        port,
        upstream_path,
        query,
        method,
        src_headers,
        body,
        hop_plugin_id,
    } = args;

    let hop_token = ext_token(node_token().as_deref(), hop_plugin_id);
    let target = format!("http://127.0.0.1:{port}{upstream_path}{query}");

    // Connect-timeout only — NO total-request timeout: the response body may be a
    // long-lived SSE stream that never completes (see [`PROXY_CONNECT_TIMEOUT`]).
    let client = reqwest::Client::builder()
        .connect_timeout(PROXY_CONNECT_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut headers = reqwest::header::HeaderMap::new();
    copy_headers(src_headers, &mut headers);
    if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {hop_token}")) {
        headers.insert(reqwest::header::AUTHORIZATION, val);
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
        if is_hop_by_hop(name.as_str()) {
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

// ── Host-API callback (/api/host/*) ───────────────────────────────────────────

/// The host-API sub-router (sidecar → Core). Registered on the PUBLIC router because
/// the sidecar process holds only its minted [`ext_token`], not the node bearer;
/// [`authorize_host_call`] does the auth + grant intersection in-handler. Start
/// MINIMAL: one proven endpoint (`/api/host/model/complete`), the same
/// grant-scoped seam any future host endpoint reuses.
pub fn host_routes() -> Router<ServerState> {
    Router::new()
        .route("/api/host/model/complete", post(host_model_complete))
        .route("/api/host/rpc", post(host_rpc))
        .route("/api/host/capability/:cap", post(host_capability))
        // Monitors sidecar callbacks: Spider fetch through Core's McpRegistry, and
        // fired-alert fan-out through the kernel notify store + activity feed. Both
        // authenticate the sidecar with its minted ext token (see
        // [`authenticate_sidecar`]); the handlers live in `crate::monitors_client`.
        .route(
            "/api/host/monitors/spider",
            post(crate::monitors_client::host_spider_crawl),
        )
        .route(
            "/api/host/monitors/alert",
            post(crate::monitors_client::host_monitor_alert),
        )
        // Meetings sidecar callback: file a finalized meeting's notes into the
        // "Meetings" Space under the background owner (Core owns the SpaceStore +
        // tenancy the sidecar cannot host). Ext-token authed; handler in
        // `crate::meetings_client`.
        .route(
            "/api/host/meetings/save-notes",
            post(crate::meetings_client::host_save_notes),
        )
        // Recipes sidecar callbacks: replay + the recording session need the LIVE
        // Ghost engine — the shared MCP registry and a dedicated recorder subprocess
        // (`McpSession`) held across start..stop in Core's process-global slot. Both
        // are kernel machinery the sidecar cannot host, so the out-of-process
        // `ryu-recipes` app proxies these four verbs back here. Ext-token authed;
        // handlers in `crate::recipes_client`.
        .route(
            "/api/host/recipes/run",
            post(crate::recipes_client::host_recipes_run),
        )
        .route(
            "/api/host/recipes/record-start",
            post(crate::recipes_client::host_recipes_record_start),
        )
        .route(
            "/api/host/recipes/record-status",
            post(crate::recipes_client::host_recipes_record_status),
        )
        .route(
            "/api/host/recipes/record-stop",
            post(crate::recipes_client::host_recipes_record_stop),
        )
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
    let plugin_id = headers
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

    let expected = ext_token(node_token().as_deref(), &plugin_id);
    if !ct_eq(provided, &expected) {
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

async fn authorize_host_call(
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

// ── Capability broker (/api/host/capability/:cap) ─────────────────────────────

/// `POST /api/host/capability/:cap` — the **capability broker**. A consumer sidecar
/// invokes an *abstract* capability; Core resolves it to the bound provider app and
/// forwards the call to the provider's declared route using the PROVIDER's minted
/// token (the consumer never sees it). This is where a `requires: [rag]` edge turns
/// into a real call to whichever provider is bound.
///
/// The three-way check, fail-closed at each step:
/// 1. the CALLER **declared** the edge (its `requires.capabilities` names `cap`) —
///    else 404;
/// 2. the bound **PROVIDER** `provides` `cap`, resolved via the binding registry
///    over the enabled set (Unprovided ⇒ 404, Ambiguous ⇒ 409) — kernel primitives
///    keep the dedicated `/api/host/*` endpoints; only app-provided caps route here;
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
        port,
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
        port,
        upstream_path: &upstream_path,
        query: &query,
        method: reqwest::Method::POST,
        src_headers: &parts.headers,
        body: body_bytes,
        hop_plugin_id: &provider_id,
    })
    .await
}

/// Pin a provider's [`ProvidesEntry`] to a concrete [`ProviderRoute`] (provider id +
/// port + upstream path + optional wake target) — resolving the named sidecar's port
/// + mount + route. Returns a 501 for an in-process capability (no sidecar/route) the
/// broker cannot proxy.
fn resolve_provider_route(
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
    // If the provider sidecar opted into on-demand start, name it so the broker can
    // wake it before forwarding (the capability-broker analogue of the ext-proxy wake).
    let wake_name = (spec.lazy || spec.idle_stop_secs.is_some())
        .then(|| crate::sidecar::manifest_sidecar::namespaced_name(provider_id, &spec.name));
    Ok(ProviderRoute {
        provider_id: provider_id.to_owned(),
        port: crate::profile::port(spec.port),
        upstream_path: format!("{mount}{route}"),
        wake_name,
    })
}

/// A resolved broker target: where to forward + how to wake the provider sidecar.
#[derive(Debug)]
struct ProviderRoute {
    provider_id: String,
    port: u16,
    upstream_path: String,
    /// The manager key to wake before forwarding, when the provider sidecar is
    /// lazy/idle-eligible; `None` for an eager provider (forward directly).
    wake_name: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ext_token_is_deterministic_and_per_plugin() {
        let a1 = ext_token(Some("node-secret"), "com.acme.a");
        let a2 = ext_token(Some("node-secret"), "com.acme.a");
        let b = ext_token(Some("node-secret"), "com.acme.b");
        assert_eq!(a1, a2, "same inputs ⇒ same token (spawn/proxy/host agree)");
        assert_ne!(a1, b, "plugin A's token must never equal plugin B's");
        // Different node token ⇒ different secret.
        assert_ne!(ext_token(Some("other"), "com.acme.a"), a1);
        // No node token falls to the fixed dev base (still deterministic + non-empty).
        assert_eq!(ext_token(None, "x"), ext_token(Some("  "), "x"));
        assert_eq!(ext_token(None, "x").len(), 64); // sha256 hex
    }

    #[test]
    fn ct_eq_matches_only_equal_strings() {
        assert!(ct_eq("abc", "abc"));
        assert!(!ct_eq("abc", "abd"));
        assert!(!ct_eq("abc", "abcd"));
        assert!(!ct_eq("", "x"));
        assert!(ct_eq("", ""));
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
                port,
                upstream_path: "/ok",
                query: "",
                method: reqwest::Method::GET,
                src_headers: &HeaderMap::new(),
                body: Vec::new(),
                hop_plugin_id: "com.test.app",
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
            port,
            upstream_path: "/events",
            query: "",
            method: reqwest::Method::GET,
            src_headers: &src_headers,
            body: Vec::new(),
            hop_plugin_id: "com.test.sse",
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
            id: "com.ryu.rag".to_owned(),
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
                        auth: Default::default(),
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
            }],
            ..Default::default()
        }
    }

    #[test]
    fn resolve_provider_route_pins_port_mount_and_path() {
        let m = provider_manifest(9099, Some("/api/rag/"));
        let entry = m.provided_capabilities()[0].clone();
        let route = resolve_provider_route(&m, &entry, "com.ryu.rag").expect("resolves");
        assert_eq!(route.provider_id, "com.ryu.rag");
        assert_eq!(route.port, 9099);
        // Mount trailing slash trimmed, route appended.
        assert_eq!(route.upstream_path, "/api/rag/query");
        // The fixture provider is eager (lazy=false, no idle_stop_secs) ⇒ no wake.
        assert_eq!(route.wake_name, None);
    }

    #[test]
    fn resolve_provider_route_names_wake_target_for_lazy_provider() {
        let mut m = provider_manifest(9099, Some("/api/rag"));
        m.sidecars[0].lazy = true;
        let entry = m.provided_capabilities()[0].clone();
        let route = resolve_provider_route(&m, &entry, "com.ryu.rag").expect("resolves");
        // A lazy provider sidecar is named for the broker to wake before forwarding.
        assert_eq!(route.wake_name.as_deref(), Some("com.ryu.rag/rag"));
    }

    #[test]
    fn public_mount_routes_builds_and_dedups_duplicate_prefixes() {
        // Two built-ins claiming the SAME public_mount must NOT panic (axum panics on
        // a duplicate route) — the dedup guard drops the second. Build a router over
        // both; if the guard were missing, `Router::merge` would panic here.
        let mut a = provider_manifest(9001, Some("/api/mail"));
        a.id = "com.ryu.mail".to_owned();
        if let Some(http) = a.sidecars[0].http.as_mut() {
            http.public_mount = Some("/api/mail".to_owned());
        }
        let mut b = provider_manifest(9002, Some("/api/mail"));
        b.id = "com.other.dup".to_owned();
        if let Some(http) = b.sidecars[0].http.as_mut() {
            http.public_mount = Some("/api/mail".to_owned());
        }
        // Must not panic (the assertion IS that this line returns).
        let _router: Router<ServerState> = public_mount_routes(&[a, b], Some("tok".to_owned()));
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
        a.id = "com.ryu.teams".to_owned();
        if let Some(http) = a.sidecars[0].http.as_mut() {
            http.public_mount = Some("/api/x".to_owned());
            // The list endpoint the sidecar serves at the mount ROOT.
            http.routes = vec![RouteSpec {
                path: "/".to_owned(),
                auth: Default::default(),
            }];
        }
        // A second built-in with the SAME mount still dedups (both the bare and the
        // wildcard route of the duplicate are dropped by the single seen-guard).
        let mut b = provider_manifest(9002, Some("/api/x"));
        b.id = "com.other.dup".to_owned();
        if let Some(http) = b.sidecars[0].http.as_mut() {
            http.public_mount = Some("/api/x".to_owned());
        }
        let _router: Router<ServerState> = public_mount_routes(&[a, b], Some("tok".to_owned()));
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
            port,
            upstream_path: &upstream_path_for("/api/x", "/"),
            query: "",
            method: reqwest::Method::GET,
            src_headers: &src_headers,
            body: Vec::new(),
            hop_plugin_id: "com.test.root",
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
        let bare = reqwest::get(format!("http://127.0.0.1:{p1}/api/ext/com.ryu.teams"))
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
        let root = reqwest::get(format!("http://127.0.0.1:{p2}/api/ext/com.ryu.teams"))
            .await
            .unwrap();
        assert_eq!(root.status(), reqwest::StatusCode::OK);
        assert_eq!(root.text().await.unwrap(), "ROOT");
        let sub = reqwest::get(format!("http://127.0.0.1:{p2}/api/ext/com.ryu.teams/42"))
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
            .find(|m| m.id == "com.ryu.mail")
            .expect("com.ryu.mail is a registered built-in");
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
        // Health probes the bearer-gated status route (ryu-mail has no /health).
        assert_eq!(sc.health_path, "/api/mail/status");
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
        assert!(dst.get("connection").is_none(), "Connection must be stripped");
    }

    #[test]
    fn resolve_provider_route_501s_for_in_process_capability() {
        use crate::plugin_manifest::ProvidesEntry;
        let m = provider_manifest(9099, None);
        // A provides entry with no sidecar/route is in-process → broker declines.
        let in_proc = ProvidesEntry {
            capability: "rag".to_owned(),
            version: "1.0.0".to_owned(),
            sidecar: None,
            route: None,
            grant: None,
        };
        let resp = resolve_provider_route(&m, &in_proc, "com.ryu.rag").unwrap_err();
        assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
    }
}
