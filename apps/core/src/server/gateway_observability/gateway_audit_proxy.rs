//! Gateway audit proxy (M4 / #177).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Gateway audit proxy (M4 / #177) ────────────────────────────────────────
//
// `GET /api/gateway/audit` forwards supported query-string filters to the
// gateway's `GET /v1/audit` endpoint, carrying the bearer token server-side so
// the desktop never handles the master key. Returns `{ "reachable": false }`
// (200) when the gateway is unreachable, consistent with the status proxy
// contract (fail-soft for read-only observability, not fail-closed like the
// exec-budget gate). The gateway owns the audit data; Core only proxies.

#[derive(serde::Deserialize, Debug)]
pub(in crate::server) struct AuditQueryParams {
    pub(in crate::server) session_id: Option<String>,
    pub(in crate::server) agent_id: Option<String>,
    pub(in crate::server) event_type: Option<String>,
    #[serde(default)]
    pub(in crate::server) errors_only: bool,
    pub(in crate::server) limit: Option<u32>,
    pub(in crate::server) from: Option<String>,
    pub(in crate::server) until: Option<String>,
    pub(in crate::server) provider: Option<String>,
    pub(in crate::server) model: Option<String>,
    pub(in crate::server) widget_instance_id: Option<String>,
}

#[utoipa::path(
    get,
    path = "/api/gateway/audit",
    tag = "Gateway",
    summary = "Query the gateway audit log (proxied)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn gateway_audit(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<AuditQueryParams>,
) -> (StatusCode, Json<serde_json::Value>) {
    // Build the query string from supported filter params.
    let mut query_parts: Vec<String> = Vec::new();
    if let Some(sid) = &params.session_id {
        query_parts.push(format!("session_id={}", urlencoding_simple(sid)));
    }
    if let Some(agent_id) = &params.agent_id {
        query_parts.push(format!("agent_id={}", urlencoding_simple(agent_id)));
    }
    if params.errors_only {
        query_parts.push("errors_only=true".to_string());
    }
    if let Some(limit) = params.limit {
        query_parts.push(format!("limit={limit}"));
    }
    if let Some(from) = &params.from {
        query_parts.push(format!("from={}", urlencoding_simple(from)));
    }
    if let Some(until) = &params.until {
        query_parts.push(format!("until={}", urlencoding_simple(until)));
    }
    if let Some(provider) = &params.provider {
        query_parts.push(format!("provider={}", urlencoding_simple(provider)));
    }
    if let Some(model) = &params.model {
        query_parts.push(format!("model={}", urlencoding_simple(model)));
    }
    if let Some(event_type) = &params.event_type {
        query_parts.push(format!("event_type={}", urlencoding_simple(event_type)));
    }
    if let Some(widget_instance_id) = &params.widget_instance_id {
        query_parts.push(format!(
            "widget_instance_id={}",
            urlencoding_simple(widget_instance_id)
        ));
    }

    proxy_gateway_audit(&state, &query_parts).await
}

/// Forward an audit query to the gateway with the admin token, which stays
/// server-side. Gateway errors surface as `reachable: false` with no entries so
/// the desktop shows the "audit disabled" empty state rather than a raw error.
pub(in crate::server) async fn proxy_gateway_audit(
    state: &ServerState,
    query_parts: &[String],
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_admin_key();
    let qs = if query_parts.is_empty() {
        String::new()
    } else {
        format!("?{}", query_parts.join("&"))
    };

    let url = format!("{base}/v1/audit{qs}");

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
            Json(json!({ "reachable": false, "error": e.to_string(), "entries": [] })),
        ),
        Ok(resp) => {
            if !resp.status().is_success() {
                let status_u16 = resp.status().as_u16();
                let body = resp
                    .json::<serde_json::Value>()
                    .await
                    .unwrap_or_else(|_| json!({}));
                // Gateway audit disabled or returned an error — surface as
                // reachable:false with empty entries so the desktop shows the
                // "audit disabled" empty state rather than a raw error.
                return (
                    StatusCode::OK,
                    Json(
                        json!({ "reachable": false, "status": status_u16, "error": body, "entries": [] }),
                    ),
                );
            }
            let body = resp
                .json::<serde_json::Value>()
                .await
                .unwrap_or_else(|_| json!({}));
            (
                StatusCode::OK,
                Json(
                    json!({ "reachable": true, "entries": body.get("entries").cloned().unwrap_or(json!([])), "count": body.get("count").cloned().unwrap_or(json!(0)) }),
                ),
            )
        }
    }
}

#[derive(serde::Deserialize, Debug)]
pub(in crate::server) struct MyUsageQueryParams {
    pub(in crate::server) limit: Option<u32>,
    pub(in crate::server) from: Option<String>,
    pub(in crate::server) until: Option<String>,
}

/// A member's own gateway usage. The `user_id` filter is always the verified
/// caller's id and cannot be supplied by the client, so this is the one audit
/// read a non-owner member can reach: owners keep `/api/gateway/audit` for the
/// whole node.
#[utoipa::path(
    get,
    path = "/api/usage/me",
    tag = "Gateway",
    summary = "Query the signed-in member's own gateway usage",
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 401, description = "No verified user identity on the request")
    )
)]
pub(in crate::server) async fn my_gateway_usage(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Query(params): axum::extract::Query<MyUsageQueryParams>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(caller) = caller else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": "Sign in to see your own usage.",
                "code": "identity_required",
            })),
        );
    };
    proxy_gateway_audit(&state, &my_usage_query_parts(&caller.user_id, &params)).await
}

pub(in crate::server) fn my_usage_query_parts(
    user_id: &str,
    params: &MyUsageQueryParams,
) -> Vec<String> {
    let mut query_parts = vec![
        format!("user_id={}", urlencoding_simple(user_id)),
        "event_type=model_call".to_owned(),
    ];
    if let Some(limit) = params.limit {
        query_parts.push(format!("limit={limit}"));
    }
    if let Some(from) = &params.from {
        query_parts.push(format!("from={}", urlencoding_simple(from)));
    }
    if let Some(until) = &params.until {
        query_parts.push(format!("until={}", urlencoding_simple(until)));
    }
    query_parts
}

#[derive(serde::Deserialize, Debug)]
pub(in crate::server) struct AuditUsageQueryParams {
    pub(in crate::server) from: String,
    pub(in crate::server) until: String,
    pub(in crate::server) provider: Option<String>,
    pub(in crate::server) model: Option<String>,
    pub(in crate::server) purpose: Option<String>,
}

/// Proxy the gateway's canonical 15-minute usage buckets. Core supplies the
/// gateway admin token server-side, so desktop clients never handle it.
#[utoipa::path(
    get,
    path = "/api/gateway/audit/usage",
    tag = "Gateway",
    summary = "Query aggregated gateway usage analytics (proxied)",
    responses((status = 200, description = "Canonical 15-minute usage rollup", body = serde_json::Value))
)]
pub(in crate::server) async fn gateway_audit_usage(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<AuditUsageQueryParams>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let mut query_parts = vec![
        format!("from={}", urlencoding_simple(&params.from)),
        format!("until={}", urlencoding_simple(&params.until)),
    ];
    if let Some(provider) = &params.provider {
        query_parts.push(format!("provider={}", urlencoding_simple(provider)));
    }
    if let Some(model) = &params.model {
        query_parts.push(format!("model={}", urlencoding_simple(model)));
    }
    if let Some(purpose) = &params.purpose {
        query_parts.push(format!("purpose={}", urlencoding_simple(purpose)));
    }
    let url = format!("{base}/v1/audit/usage?{}", query_parts.join("&"));
    let mut request = state
        .client
        .get(&url)
        .timeout(std::time::Duration::from_millis(3000));
    if let Some(token) = gateway_admin_key().as_deref() {
        request = request.bearer_auth(token);
    }

    match request.send().await {
        Err(error) => {
            tracing::warn!(%error, "gateway usage proxy request failed");
            (
                StatusCode::OK,
                Json(json!({
                    "reachable": false,
                    "error": "gateway usage unavailable",
                    "kind": "rollup",
                    "bucketSeconds": 900,
                    "events": [],
                })),
            )
        }
        Ok(response) => {
            if !response.status().is_success() {
                let status = response.status().as_u16();
                let error = response
                    .json::<serde_json::Value>()
                    .await
                    .unwrap_or_else(|_| json!({}));
                return (
                    StatusCode::OK,
                    Json(json!({
                        "reachable": false,
                        "status": status,
                        "error": error,
                        "kind": "rollup",
                        "bucketSeconds": 900,
                        "events": [],
                    })),
                );
            }
            let mut body = match response.json::<serde_json::Value>().await {
                Ok(body) => body,
                Err(error) => {
                    tracing::warn!(%error, "gateway usage proxy returned invalid JSON");
                    return (
                        StatusCode::OK,
                        Json(json!({
                            "reachable": false,
                            "status": 502,
                            "error": "gateway usage response invalid",
                            "kind": "rollup",
                            "bucketSeconds": 900,
                            "events": [],
                        })),
                    );
                }
            };
            if let serde_json::Value::Object(object) = &mut body {
                object.insert("reachable".to_owned(), json!(true));
            }
            (StatusCode::OK, Json(body))
        }
    }
}

/// Proxy the owner-only audit retention maintenance action. The Gateway remains
/// the storage owner and chooses the configured retention bounds.
#[utoipa::path(
    post,
    path = "/api/gateway/audit/prune",
    tag = "Gateway",
    summary = "Apply gateway audit retention (proxied)",
    responses((status = 200, description = "Retention summary", body = serde_json::Value))
)]
pub(in crate::server) async fn gateway_audit_prune(
    State(state): State<ServerState>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};

    let gateway = gateway_url();
    let base = gateway.trim_end_matches('/');
    let mut request = state
        .client
        .post(format!("{base}/v1/audit/prune"))
        .timeout(std::time::Duration::from_millis(3000));
    if let Some(token) = gateway_admin_key().as_deref() {
        request = request.bearer_auth(token);
    }
    match request.send().await {
        Err(error) => (
            StatusCode::OK,
            Json(json!({ "reachable": false, "error": error.to_string() })),
        ),
        Ok(response) => {
            let status =
                StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let body = response
                .json::<serde_json::Value>()
                .await
                .unwrap_or_else(|_| json!({}));
            (status, Json(body))
        }
    }
}
