//! Gateway live-traffic proxy (SSE).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Gateway live-traffic proxy (SSE) ────────────────────────────────────────
//
// The gateway exposes `GET /v1/traffic` as an admin-gated Server-Sent Events
// stream (master key or the loopback posture), feeding the desktop's live
// traffic dashboard. The desktop never holds the gateway master key, so Core
// proxies it with its own gateway token and streams the bytes through unchanged.
//
// The response is a LONG-LIVED SSE stream: on gateway down / error it returns a
// short, fail-soft JSON body (`{ "reachable": false, "error": … }`) so the
// client can distinguish "gateway down (Core up)" from "Core down", matching
// the audit proxy's contract; a healthy gateway streams `text/event-stream`
// indefinitely. Core's own response is not cached and carries no body
// transformation — it is a byte relay.

#[utoipa::path(
    get,
    path = "/api/gateway/traffic",
    tag = "Gateway",
    summary = "Stream live gateway traffic (proxied SSE)",
    responses((status = 200, description = "Server-Sent Events stream of redacted request events"))
)]
pub(in crate::server) async fn gateway_traffic(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};

    // Live traffic names every member's requests, models, and cost, like the
    // audit log. A caller who may route inference (`gateway:route`) must not
    // inherit a view of everyone else's traffic.
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AUDIT_VIEW,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: audit.view".to_owned(),
        );
    }

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_admin_key();
    let url = format!("{base}/v1/traffic");

    let mut req = state.client.get(&url);
    // No overall timeout: the SSE stream stays open indefinitely. reqwest's
    // connect timeout still applies (default ~10s), so a down gateway fails fast.
    if let Some(t) = token.as_deref() {
        req = req.bearer_auth(t);
    }

    match req.send().await {
        Err(e) => (
            StatusCode::OK,
            Json(json!({ "reachable": false, "error": e.to_string() })),
        )
            .into_response(),
        Ok(resp) => {
            if !resp.status().is_success() {
                let status_u16 = resp.status().as_u16();
                let body = resp
                    .json::<serde_json::Value>()
                    .await
                    .unwrap_or_else(|_| json!({}));
                return (
                    StatusCode::OK,
                    Json(json!({ "reachable": false, "status": status_u16, "error": body })),
                )
                    .into_response();
            }
            // Stream the gateway's SSE bytes through unchanged.
            let mut headers = axum::http::HeaderMap::new();
            headers.insert(
                axum::http::header::CONTENT_TYPE,
                axum::http::HeaderValue::from_static("text/event-stream"),
            );
            headers.insert(
                axum::http::header::CACHE_CONTROL,
                axum::http::HeaderValue::from_static("no-cache"),
            );
            (
                StatusCode::OK,
                headers,
                axum::body::Body::from_stream(resp.bytes_stream()),
            )
                .into_response()
        }
    }
}

// ── Gateway budget-spend proxy (M2 control-layer UX) ────────────────────────
//
// The gateway tracks live per-user / per-agent / per-session charged spend in
// memory but gates the read surface (`GET /v1/budget/spend`) behind
// `require_local_admin`, which the desktop cannot satisfy directly (it never
// holds the master key). Core proxies it with its own gateway token so the
// desktop budget panel can render live spend-vs-limit. Returns
// `{ "reachable": false }` (200) when the gateway is down, matching the audit
// proxy's fail-soft read-only contract. The gateway owns the counters; Core
// only relays.

#[derive(serde::Deserialize, Debug)]
pub(in crate::server) struct BudgetSpendQueryParams {
    pub(in crate::server) user_id: Option<String>,
    pub(in crate::server) agent_id: Option<String>,
    pub(in crate::server) session_id: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/gateway/budget/spend",
    tag = "Gateway",
    summary = "Query live gateway budget spend (proxied)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn gateway_budget_spend(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Query(params): axum::extract::Query<BudgetSpendQueryParams>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};

    // Budget counters are keyed by any user, agent, or session the caller names,
    // so reading them is Console data: the same gateway.configure that sets the
    // budgets. A member's own spend is served by `/api/usage/me`.
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::GATEWAY_CONFIGURE,
    )
    .await
    .is_err()
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "insufficient permissions: gateway.configure" })),
        );
    }

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_admin_key();

    let mut query_parts: Vec<String> = Vec::new();
    if let Some(uid) = &params.user_id {
        query_parts.push(format!("user_id={}", urlencoding_simple(uid)));
    }
    if let Some(aid) = &params.agent_id {
        query_parts.push(format!("agent_id={}", urlencoding_simple(aid)));
    }
    if let Some(sid) = &params.session_id {
        query_parts.push(format!("session_id={}", urlencoding_simple(sid)));
    }
    let qs = if query_parts.is_empty() {
        String::new()
    } else {
        format!("?{}", query_parts.join("&"))
    };

    let url = format!("{base}/v1/budget/spend{qs}");

    let mut req = state
        .client
        .get(&url)
        .timeout(std::time::Duration::from_millis(3000));
    if let Some(t) = token.as_deref() {
        req = req.bearer_auth(t);
    }

    match req.send().await {
        Err(e) => (
            StatusCode::OK,
            Json(json!({
                "reachable": false,
                "error": e.to_string(),
                "users": {},
                "agents": {},
                "sessions": {},
                "limits": {},
            })),
        ),
        Ok(resp) => {
            if !resp.status().is_success() {
                let status_u16 = resp.status().as_u16();
                let body = resp
                    .json::<serde_json::Value>()
                    .await
                    .unwrap_or_else(|_| json!({}));
                return (
                    StatusCode::OK,
                    Json(json!({
                        "reachable": false,
                        "status": status_u16,
                        "error": body,
                        "users": {},
                        "agents": {},
                        "sessions": {},
                        "limits": {},
                    })),
                );
            }
            let body = resp
                .json::<serde_json::Value>()
                .await
                .unwrap_or_else(|_| json!({}));
            (
                StatusCode::OK,
                Json(json!({
                    "reachable": true,
                    "users": body.get("users").cloned().unwrap_or(json!({})),
                    "agents": body.get("agents").cloned().unwrap_or(json!({})),
                    "sessions": body.get("sessions").cloned().unwrap_or(json!({})),
                    "limits": body.get("limits").cloned().unwrap_or(json!({})),
                })),
            )
        }
    }
}

/// Minimal percent-encoding for query string values (encodes non-alphanumeric
/// except `-`, `_`, `.`, `~`). Avoids a full URL-encoding library dependency.
pub(in crate::server) fn urlencoding_simple(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
            out.push(c);
        } else {
            for byte in c.to_string().as_bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}
