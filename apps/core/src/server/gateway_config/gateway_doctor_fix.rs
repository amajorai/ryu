//! Gateway config write, status and control-plane proxies: `gateway_doctor_fix` through `gateway_get_evaluators`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/gateway/doctor/fix` — proxy the Gateway's explicit safe-fix
/// operation. Core requires the same gateway.configure permission as other
/// writes, keeps the admin key server-side, and refreshes the returned report
/// with Core-owned findings before it reaches the client.
#[utoipa::path(
    post,
    path = "/api/gateway/doctor/fix",
    tag = "Gateway",
    summary = "Preview or apply safe Gateway Doctor fixes",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn gateway_doctor_fix(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
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

    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_admin_key();
    let mut req = state
        .client
        .post(format!("{base}/v1/doctor/fix"))
        .timeout(std::time::Duration::from_millis(3000))
        .json(&body);
    req = with_forwarded_gateway_actor(req, &caller);
    if let Some(token) = token.as_deref() {
        req = req.bearer_auth(token);
    }

    let response = match req.send().await {
        Ok(response) => response,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "reachable": false,
                    "error": error.to_string(),
                })),
            );
        }
    };
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut result = match response.json::<serde_json::Value>().await {
        Ok(result) => result,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({
                    "reachable": false,
                    "error": format!("Gateway Doctor fix returned invalid JSON: {error}"),
                })),
            );
        }
    };
    if !status.is_success() {
        return (status, Json(result));
    }

    // Reuse the existing combined report builder so the fix response includes
    // Core approval and agent-routing findings just like a fresh audit. If a
    // transient read fails after a successful fix, retain the Gateway-owned
    // report rather than turning a completed mutation into a proxy error.
    let (doctor_status, Json(report)) = gateway_doctor_report(State(state.clone())).await;
    if doctor_status.is_success() {
        result["report"] = report;
    }

    if result
        .get("appliedFixes")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|fixes| !fixes.is_empty())
    {
        record_gateway_control(
            &state,
            "gateway.doctor.fix",
            "gateway_doctor",
            Some("protective fixes applied"),
            &caller,
        )
        .await;
    }

    (status, Json(result))
}

#[utoipa::path(
    put,
    path = "/api/gateway/config",
    tag = "Gateway",
    summary = "Update the gateway config (proxied)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn gateway_put_config(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(patch): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
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

    // Reuse the single config-push transport; the proxy relays the gateway's exact
    // status code, so a caller sees the same result whether it PUT here or the
    // policy path pushed the patch.
    match crate::sidecar::gateway::push_config_with_actor(
        &state.client,
        &patch,
        caller.as_ref().map(|value| value.user_id.as_str()),
        caller.as_ref().and_then(|value| value.email.as_deref()),
    )
    .await
    {
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "reachable": false, "error": e.to_string() })),
        ),
        Ok((status, body)) => {
            if status.is_success() {
                crate::acp_runtime::observe_gateway_patch(&patch);
            }
            let status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (status, Json(body))
        }
    }
}

// ── Gateway evaluator catalog proxy (unified-evaluator system) ──────────────
//
// `GET /api/gateway/evaluators` forwards to the gateway's `GET /v1/evaluators`,
// carrying the bearer token server-side so the desktop never handles the master
// key. Returns the gateway's response (the full evaluator catalog: built-ins
// merged with `config.custom_evaluators`) verbatim. Fail-closed like
// `gateway_get_config`: a structured 502 when the gateway is unreachable, so the
// desktop catalog UI never renders a partial/stale set as if it were live.

#[utoipa::path(
    get,
    path = "/api/gateway/evaluators",
    tag = "Gateway",
    summary = "Get the gateway evaluator catalog (proxied)",
    description = "Forwards to the gateway's GET /v1/evaluators. Returns the full shared \
evaluator catalog (8 categories) with `capabilities` + `enforced` flags: the built-in seed \
table merged with any user-authored `custom_evaluators` (custom entries override a built-in by \
`id` and report `builtin: false`). Fail-closed: a 502 is returned when the gateway is \
unreachable.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn gateway_get_evaluators(
    State(state): State<ServerState>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_admin_key();

    let mut req = state
        .client
        .get(format!("{base}/v1/evaluators"))
        .timeout(std::time::Duration::from_millis(3000));
    if let Some(t) = token.as_deref() {
        req = req.bearer_auth(t);
    }

    match req.send().await {
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "reachable": false, "error": e.to_string() })),
        ),
        Ok(resp) => {
            let status =
                StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let body = resp
                .json::<serde_json::Value>()
                .await
                .unwrap_or_else(|_| json!({}));
            (status, Json(body))
        }
    }
}
