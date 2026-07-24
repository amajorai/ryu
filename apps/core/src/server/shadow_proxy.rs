//! `/api/shadow/*` — a thin authenticated proxy onto the device-local Shadow
//! sidecar's HTTP surface.
//!
//! Shadow's API is bearer-gated and rejects every browser-context request
//! outright (any `Origin` header ⇒ 403 — the CSRF/DNS-rebind kill-switch in
//! `apps/shadow/src/server.rs`). The desktop webview's companion/review/search
//! surfaces used to `fetch` Shadow directly on `:3030`; that lane is now closed
//! by design, so they route through Core instead: this proxy rides the
//! PROTECTED router (node bearer via `require_auth`, loopback-dev `None` ⇒
//! allow — the same posture as every other `/api/*` route), strips the
//! browser-context headers, stamps Shadow's shared-secret bearer
//! ([`crate::sidecar::tools::shadow::api_token`]), and streams the response
//! back (the `/agent` SSE stream and `/frame` JPEG bytes both pass through).
//!
//! Only an explicit allowlist of Shadow's read/control endpoints is forwarded —
//! the ones the desktop actually uses. Mutation lanes that belong to other
//! clients (`/ingest`, `/stop`, `/clips/*`, `/meeting/*`) are NOT exposed here:
//! clips/meetings have their own sidecars and `/stop` stays Core-internal
//! (`ShadowManager::stop`).

use axum::body::Body;
use axum::extract::{Path, Request};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;

use crate::server::ServerState;

/// Max request body Core buffers + forwards (mirrors the ext-proxy default).
const MAX_PROXY_BYTES: usize = 10 * 1024 * 1024;

/// Connect-only timeout (mirrors `ext_proxy`): the `/agent` response is a
/// long-lived SSE stream that never completes, so a total-request timeout would
/// sever it mid-answer.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// The Shadow sub-paths this proxy forwards, per method. Everything else 404s —
/// undeclared paths are never forwarded (the ext-proxy's exact-route safety).
const GET_ALLOWLIST: &[&str] = &[
    "timeline",
    "journal",
    "journal/weekly",
    "frame",
    "search",
    "search/semantic",
    "context/current",
    "context/recent",
    "activity/recent",
    "proactive",
    "capture/control",
    "agent/tools",
];
const POST_ALLOWLIST: &[&str] = &["agent", "api/feedback", "capture/control"];

/// True when `sub_path` (no leading slash) is a forwardable Shadow endpoint for
/// `method`. Exact match only — no parametric or wildcard routes exist in the
/// allowlisted set, so string equality IS the gate.
fn is_allowed(method: &axum::http::Method, sub_path: &str) -> bool {
    if *method == axum::http::Method::GET {
        GET_ALLOWLIST.contains(&sub_path)
    } else if *method == axum::http::Method::POST {
        POST_ALLOWLIST.contains(&sub_path)
    } else {
        false
    }
}

/// The `/api/shadow/*` sub-router. Merged into the PROTECTED router so it
/// inherits `require_auth` (+ verified-caller attribution) like every other
/// first-party route.
pub fn routes() -> Router<ServerState> {
    Router::new().route("/api/shadow/*rest", any(shadow_proxy))
}

/// Hop-by-hop headers never forwarded in either direction (mirrors `ext_proxy`).
fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host" | "content-length" | "connection" | "transfer-encoding" | "keep-alive" | "upgrade"
    )
}

/// Browser-context headers describing the ORIGINAL caller (the desktop webview's
/// fetch to Core). Shadow 403s any Origin-bearing request, so forwarding them
/// would make Core's own authenticated hop indistinguishable from a drive-by
/// browser request (same rationale as `ext_proxy::is_browser_context`).
fn is_browser_context(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "origin" | "referer")
}

async fn shadow_proxy(Path(rest): Path<String>, req: Request) -> Response {
    // The wildcard tail arrives without a leading slash; normalize + gate.
    let sub_path = rest.trim_start_matches('/').to_owned();
    if !is_allowed(req.method(), &sub_path) {
        return StatusCode::NOT_FOUND.into_response();
    }

    let base = crate::sidecar::tools::shadow::base_url();
    let (parts, body) = req.into_parts();
    let body_bytes = match axum::body::to_bytes(body, MAX_PROXY_BYTES).await {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                "shadow proxy: request body too large",
            )
                .into_response()
        }
    };
    let query = parts
        .uri
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let target = format!("{}/{sub_path}{query}", base.trim_end_matches('/'));

    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in parts.headers.iter() {
        if is_hop_by_hop(name.as_str())
            || is_browser_context(name.as_str())
            || name.as_str().eq_ignore_ascii_case("authorization")
        {
            continue;
        }
        if let (Ok(n), Ok(v)) = (
            reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()),
            reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            headers.append(n, v);
        }
    }
    // Stamp Shadow's shared-secret bearer (replacing the caller's node bearer,
    // dropped above). A missing token falls through to Shadow's 401.
    if let Some(token) = crate::sidecar::tools::shadow::api_token() {
        if let Ok(val) = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}")) {
            headers.insert(reqwest::header::AUTHORIZATION, val);
        }
    }

    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes())
        .unwrap_or(reqwest::Method::GET);
    let upstream = client
        .request(method, &target)
        .headers(headers)
        .body(body_bytes.to_vec())
        .send()
        .await;

    let resp = match upstream {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!("shadow proxy: Shadow unreachable at {target}: {e}");
            return (StatusCode::BAD_GATEWAY, "shadow unreachable").into_response();
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
    // Stream the body through (SSE `/agent` never completes; `/frame` is bytes).
    (status, out, Body::from_stream(resp.bytes_stream())).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Method;

    #[test]
    fn allowlist_admits_only_declared_method_path_pairs() {
        assert!(is_allowed(&Method::GET, "timeline"));
        assert!(is_allowed(&Method::GET, "journal/weekly"));
        assert!(is_allowed(&Method::GET, "capture/control"));
        assert!(is_allowed(&Method::POST, "capture/control"));
        assert!(is_allowed(&Method::POST, "agent"));
        assert!(is_allowed(&Method::POST, "api/feedback"));
        // Wrong method.
        assert!(!is_allowed(&Method::POST, "timeline"));
        assert!(!is_allowed(&Method::GET, "api/feedback"));
        assert!(!is_allowed(&Method::DELETE, "timeline"));
        // Undeclared / other-client lanes stay closed.
        assert!(!is_allowed(&Method::POST, "ingest"));
        assert!(!is_allowed(&Method::GET, "stop"));
        assert!(!is_allowed(&Method::GET, "clips"));
        assert!(!is_allowed(&Method::POST, "meeting/start"));
        // No prefix/suffix sloppiness.
        assert!(!is_allowed(&Method::GET, "timeline/extra"));
        assert!(!is_allowed(&Method::GET, "journal/../ingest"));
    }
}
