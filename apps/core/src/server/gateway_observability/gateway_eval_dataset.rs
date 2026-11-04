//! Gateway eval dataset runner proxy (M4 / #180).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Gateway eval dataset runner proxy (M4 / #180) ──────────────────────────
//
// `POST /api/gateway/evals/run` forwards the eval run request to the gateway's
// `POST /v1/evals/run` endpoint, carrying the bearer token server-side so the
// desktop never holds the master key. Returns the gateway's response verbatim;
// on gateway-unreachable, returns a structured 502 (fail-closed, AC hard-constraint #1).

#[utoipa::path(
    post,
    path = "/api/gateway/evals/run",
    tag = "Gateway",
    summary = "Run a gateway eval dataset (proxied)",
    description = "Forwards to the gateway's POST /v1/evals/run. An OPTIONAL run-level \
`evaluators: [\"id\", …]` array of registry evaluator ids is forwarded to the gateway, which \
scores each dataset case against those built-in/LLM-judge evaluators and returns per-evaluator \
scores + aggregates. A separate OPTIONAL `code_evaluators: [{ id, lang, source }]` field (lang = \
\"js\" | \"python\") is stripped before forwarding: Core runs those user functions locally (JS in \
the deny-all JS sandbox, Python in the configured sandbox backend). A Python case is REFUSED \
with `executed:false` when no command-capable sandbox is available, rather than falling back to \
the host — running untrusted code unsandboxed is opt-in only, via \
`RYU_EVAL_ALLOW_UNSANDBOXED_PYTHON`, and any such result is tagged on the wire. Core merges the real \
`executed:true` scores into each case's `evaluators` array, re-aggregating the affected ids. A \
request without either field behaves exactly as before. Inline Promptfoo `javascript` and `python` \
assertions use the same Core sandbox and replace their defensive `executed:false` assertion result \
in place. JavaScript assertions support Promptfoo's injected `output`, `input`, `expected`, `vars`, \
and `context` names and its boolean, numeric, or `{ score, pass, reason }` return forms.",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn gateway_run_evals(
    State(state): State<ServerState>,
    req_headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};

    // Code evaluators are a CORE capability: pull them out, run them here, and
    // NEVER forward them to the gateway (which would reject/ignore them). Also
    // snapshot the request dataset so each case's payload can be enriched with
    // `expected` + `vars` (the gateway's response case carries neither).
    let code_specs: Vec<ryu_eval_code::CodeEvaluatorSpec> = body
        .get("code_evaluators")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let mut code_specs = code_specs;
    code_specs.extend(inline_code_evaluator_specs(&body));
    let case_inputs: Vec<ryu_eval_code::CaseInput> = body
        .get("dataset")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(ryu_eval_code::CaseInput::from_case)
                .collect()
        })
        .unwrap_or_default();

    // Strip `code_evaluators` from the forwarded body (keep the shape unchanged).
    let mut fwd_body = body;
    if let Some(obj) = fwd_body.as_object_mut() {
        obj.remove("code_evaluators");
    }
    redact_inline_code_assertion_sources(&mut fwd_body);

    let base = gateway_url();
    let base = base.trim_end_matches('/');
    let token = gateway_admin_key();

    let mut req = state
        .client
        .post(format!("{base}/v1/evals/run"))
        .timeout(std::time::Duration::from_secs(120))
        .json(&fwd_body);

    // Prefer the gateway token if configured; otherwise forward the caller's
    // Authorization header so per-key budgets are tracked for the eval run.
    if let Some(t) = token.as_deref() {
        req = req.bearer_auth(t);
    } else if let Some(auth) = req_headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
    {
        req = req.header("authorization", auth);
    }

    match req.send().await {
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "reachable": false, "error": e.to_string() })),
        ),
        Ok(resp) => {
            let status =
                StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let mut response_body = resp
                .json::<serde_json::Value>()
                .await
                .unwrap_or_else(|_| json!({}));

            // Merge Code evaluator scores in on the success path only. On any
            // non-2xx (or an unparseable response missing `cases`) we pass the
            // gateway's body through untouched — never fabricate scores over an
            // error, and never 500 on a shape we don't recognise.
            if status.is_success() && !code_specs.is_empty() && response_body.get("cases").is_some()
            {
                if code_specs.iter().any(|spec| spec.assertion_index.is_some()) {
                    ryu_eval_code::merge_inline_code_assertions(
                        &mut response_body,
                        &case_inputs,
                        &code_specs,
                    )
                    .await;
                } else {
                    ryu_eval_code::merge_code_evaluators(
                        &mut response_body,
                        &case_inputs,
                        &code_specs,
                    )
                    .await;
                }
            }

            (status, Json(response_body))
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(in crate::server) struct GatewayBatchListQuery {
    pub(in crate::server) limit: Option<usize>,
    pub(in crate::server) after: Option<String>,
    #[serde(default)]
    pub(in crate::server) status: Vec<String>,
    pub(in crate::server) created_after: Option<String>,
    pub(in crate::server) created_before: Option<String>,
}

#[utoipa::path(
    post,
    path = "/api/gateway/batches",
    request_body = serde_json::Value,
    responses(
        (status = 202, description = "OpenRouter batch accepted", body = serde_json::Value),
        (status = 400, description = "Invalid batch request"),
        (status = 401, description = "Gateway admin key required")
    ),
    tag = "Gateway"
)]
pub(in crate::server) async fn gateway_batch_create(
    State(state): State<ServerState>,
    req_headers: axum::http::HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    proxy_gateway_batch(
        State(state),
        req_headers,
        reqwest::Method::POST,
        "/v1/batches".to_owned(),
        None,
        Some(body),
    )
    .await
}

#[utoipa::path(
    get,
    path = "/api/gateway/batches",
    params(
        ("limit" = Option<usize>, Query, description = "Page size from 1 to 100"),
        ("after" = Option<String>, Query, description = "Opaque batch cursor"),
        ("status" = Vec<String>, Query, description = "Repeat for multiple statuses"),
        ("created_after" = Option<String>, Query),
        ("created_before" = Option<String>, Query)
    ),
    responses((status = 200, description = "Batch page", body = serde_json::Value)),
    tag = "Gateway"
)]
pub(in crate::server) async fn gateway_batches_list(
    State(state): State<ServerState>,
    req_headers: axum::http::HeaderMap,
    axum::extract::Query(query): axum::extract::Query<GatewayBatchListQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    proxy_gateway_batch(
        State(state),
        req_headers,
        reqwest::Method::GET,
        "/v1/batches".to_owned(),
        Some(query),
        None,
    )
    .await
}

#[utoipa::path(
    get,
    path = "/api/gateway/batches/{id}",
    params(("id" = String, Path, description = "OpenRouter batch id")),
    responses((status = 200, description = "Batch status and results", body = serde_json::Value)),
    tag = "Gateway"
)]
pub(in crate::server) async fn gateway_batch_get(
    State(state): State<ServerState>,
    req_headers: axum::http::HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    proxy_gateway_batch(
        State(state),
        req_headers,
        reqwest::Method::GET,
        format!("/v1/batches/{}", id),
        None,
        None,
    )
    .await
}

#[utoipa::path(
    delete,
    path = "/api/gateway/batches/{id}",
    params(("id" = String, Path, description = "Terminal OpenRouter batch id")),
    responses(
        (status = 200, description = "Batch and stored artifacts deleted", body = serde_json::Value),
        (status = 409, description = "Batch is not terminal")
    ),
    tag = "Gateway"
)]
pub(in crate::server) async fn gateway_batch_delete(
    State(state): State<ServerState>,
    req_headers: axum::http::HeaderMap,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    proxy_gateway_batch(
        State(state),
        req_headers,
        reqwest::Method::DELETE,
        format!("/v1/batches/{}", id),
        None,
        None,
    )
    .await
}

pub(in crate::server) async fn proxy_gateway_batch(
    State(state): State<ServerState>,
    req_headers: axum::http::HeaderMap,
    method: reqwest::Method,
    path: String,
    query: Option<GatewayBatchListQuery>,
    body: Option<serde_json::Value>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::sidecar::gateway::{gateway_admin_key, gateway_url};

    let valid_path = path == "/v1/batches"
        || path
            .strip_prefix("/v1/batches/")
            .and_then(|id| id.strip_prefix("batch_"))
            .is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            });
    if !valid_path {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                json!({ "error": { "code": "invalid_batch_path", "message": "Invalid batch path" } }),
            ),
        );
    }
    let base = gateway_url();
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let mut request = state
        .client
        .request(method, url)
        .timeout(std::time::Duration::from_secs(90));
    if let Some(query) = query {
        let mut params = Vec::new();
        if let Some(limit) = query.limit {
            params.push(("limit", limit.to_string()));
        }
        if let Some(after) = query.after {
            params.push(("after", after));
        }
        params.extend(query.status.into_iter().map(|status| ("status", status)));
        if let Some(created_after) = query.created_after {
            params.push(("created_after", created_after));
        }
        if let Some(created_before) = query.created_before {
            params.push(("created_before", created_before));
        }
        request = request.query(&params);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }

    if let Some(token) = gateway_admin_key() {
        request = request.bearer_auth(token);
    } else if let Some(authorization) = req_headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
    {
        request = request.header("authorization", authorization);
    }

    match request.send().await {
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "reachable": false, "error": error.to_string() })),
        ),
        Ok(response) => {
            let status =
                StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let value = response
                .json::<serde_json::Value>()
                .await
                .unwrap_or_else(|_| json!({}));
            (status, Json(value))
        }
    }
}

pub(in crate::server) fn inline_code_evaluator_specs(
    body: &serde_json::Value,
) -> Vec<ryu_eval_code::CodeEvaluatorSpec> {
    let Some(dataset) = body.get("dataset").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut specs = Vec::new();
    for (case_index, case) in dataset.iter().enumerate() {
        let Some(assertions) = case.get("assertions").and_then(serde_json::Value::as_array) else {
            continue;
        };
        for (assertion_index, assertion) in assertions.iter().enumerate() {
            let Some(kind) = assertion.get("kind").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let lang = match kind {
                "javascript" => "js",
                "python" => "python",
                _ => continue,
            };
            let Some(source) = assertion.get("value").and_then(serde_json::Value::as_str) else {
                continue;
            };
            if source.trim().is_empty() {
                continue;
            }
            specs.push(ryu_eval_code::CodeEvaluatorSpec {
                assertion_index: Some(assertion_index),
                case_index: Some(case_index),
                id: format!("__inline_code_{case_index}_{assertion_index}"),
                lang: lang.to_owned(),
                source: source.to_owned(),
            });
        }
    }
    specs
}
