//! Vault route builders, shared JSON helpers, the model catalog and Composio integrations: `webhook_timestamp_fresh` through `buyer_bearer_from_headers`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Read a webhook timestamp header (Svix/Composio `webhook-timestamp`, or the
/// generic `x-timestamp`) and decide whether the delivery is fresh. Delegates the
/// staleness decision to [`crate::webhook_ingress::timestamp_fresh`] (absent /
/// unparseable ⇒ fresh, so this never breaks existing unsigned callers).
pub(in crate::server) fn webhook_timestamp_fresh(headers: &axum::http::HeaderMap) -> bool {
    let ts = ["webhook-timestamp", "x-timestamp", "x-request-timestamp"]
        .iter()
        .find_map(|h| headers.get(*h).and_then(|v| v.to_str().ok()));
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    crate::webhook_ingress::timestamp_fresh(ts, now)
}

pub(in crate::server) fn workflow_webhook_timestamp_fresh(headers: &axum::http::HeaderMap) -> bool {
    let raw = ["webhook-timestamp", "x-timestamp", "x-request-timestamp"]
        .iter()
        .find_map(|name| headers.get(*name).and_then(|value| value.to_str().ok()))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(raw) = raw else {
        return false;
    };
    let parseable = raw
        .split(',')
        .find_map(|token| token.trim().strip_prefix("t=").or(Some(token.trim())))
        .and_then(|value| value.parse::<i64>().ok())
        .is_some();
    parseable && webhook_timestamp_fresh(headers)
}

/// Read the delivery id from the common header spellings: Svix-style
/// `webhook-id` (Composio uses Svix), then `x-github-delivery`, then the
/// generic `x-delivery-id`. Absent ⇒ empty string. The Composio route only
/// reads it after signature verification, which requires `webhook-id`.
pub(in crate::server) fn webhook_delivery_id(headers: &axum::http::HeaderMap) -> String {
    ["webhook-id", "x-github-delivery", "x-delivery-id"]
        .iter()
        .find_map(|h| headers.get(*h).and_then(|v| v.to_str().ok()))
        .unwrap_or("")
        .to_owned()
}

/// `POST /api/workflows/:id/webhook`
///
/// Public inbound trigger for a workflow that declares a `WorkflowTrigger::Webhook`.
/// The external caller (an integration, app, or any service that can POST) cannot
/// send the node bearer, so the route is unauthenticated at the router level and
/// instead authenticates the raw body with an HMAC-SHA256 over the trigger's own
/// `secret`. Fail-closed: a workflow with no webhook trigger, or a webhook trigger
/// with no configured secret, never fires. On success the raw JSON body is seeded
/// as the run's `trigger` state (readable in node templates as `{{trigger.<field>}}`).
#[utoipa::path(
    post,
    path = "/api/workflows/{id}/webhook",
    tag = "Workflows",
    summary = "Fire a workflow from an inbound webhook (HMAC-authenticated)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Run started", body = serde_json::Value),
        (status = 400, description = "Body is not valid JSON"),
        (status = 401, description = "Missing/invalid signature or no secret configured"),
        (status = 404, description = "No webhook trigger on this workflow")
    )
)]
pub(in crate::server) async fn workflow_webhook(
    axum::extract::Path(id): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> (StatusCode, Json<serde_json::Value>) {
    // Replay window (webhook-unify #5): reject a stale, timestamp-signed delivery
    // up front (back-compat: absent/unparseable timestamp ⇒ accepted).
    if !workflow_webhook_timestamp_fresh(&headers) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "stale webhook timestamp (replay window exceeded)" })),
        );
    }
    // Authenticate the raw bytes BEFORE parsing — verify exactly what was received,
    // never a re-serialized value. Accept the common signature-header spellings.
    let signature = ["webhook-signature", "x-signature", "x-hub-signature-256"]
        .iter()
        .find_map(|h| headers.get(*h).and_then(|v| v.to_str().ok()));

    // Delegate to the shared delivery path so the HTTP route and the relay
    // dispatcher use byte-identical auth + run semantics (webhook-unify): the
    // per-workflow HMAC secret lives only in Core, so this is the single verifier.
    // The v3 signature binds this workflow id, the delivery id and timestamp to
    // these raw bytes; the shared dispatcher durably deduplicates that signed id.
    use crate::webhook_ingress::WorkflowWebhookOutcome;
    let webhook_id = headers
        .get("webhook-id")
        .and_then(|value| value.to_str().ok());
    let webhook_timestamp = headers
        .get("webhook-timestamp")
        .and_then(|value| value.to_str().ok());
    match crate::webhook_ingress::deliver_workflow_webhook(
        &id,
        &body,
        crate::webhook_ingress::InboundWebhookHeaders {
            signature,
            webhook_id,
            webhook_timestamp,
        },
    )
    .await
    {
        WorkflowWebhookOutcome::Ran(run_id) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "run_id": run_id })),
        ),
        // Duplicate ⇒ 200 OK so the provider stops retrying (the work already
        // happened on the first delivery of this id).
        WorkflowWebhookOutcome::Duplicate => (
            StatusCode::OK,
            Json(json!({ "ok": true, "duplicate": true })),
        ),
        WorkflowWebhookOutcome::NotFound => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("workflow '{id}' not found") })),
        ),
        WorkflowWebhookOutcome::NoWebhookTrigger => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "workflow has no webhook trigger" })),
        ),
        WorkflowWebhookOutcome::NoSecret => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "webhook trigger has no secret configured" })),
        ),
        WorkflowWebhookOutcome::BadSignature => (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid or missing webhook signature" })),
        ),
        WorkflowWebhookOutcome::BadBody(msg) => {
            (StatusCode::BAD_REQUEST, Json(json!({ "error": msg })))
        }
        WorkflowWebhookOutcome::RunError(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        ),
    }
}

/// `GET /api/models/catalog?query=&sort=&limit=&installed_only=`
#[utoipa::path(
    get,
    path = "/api/models/catalog",
    tag = "Models",
    summary = "Browse the model catalog (HF GGUF)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn models_catalog_list(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let query = params.get("query").map(String::as_str).unwrap_or("");
    let sort = crate::model_catalog::CatalogSort::parse(
        params.get("sort").map(String::as_str).unwrap_or("trending"),
    );
    // Weight-format facet (one clean cursor per format; the desktop fans out).
    // Defaults to GGUF for back-compat with older clients that omit it.
    let format = crate::model_format::ModelFormat::from_wire(
        params.get("format").map(String::as_str).unwrap_or("gguf"),
    );
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(40);
    let installed_only = params
        .get("installed_only")
        .map(|s| s == "true" || s == "1")
        .unwrap_or(false);
    // Optional Hugging Face pipeline tag (e.g. `sentence-similarity` for
    // embeddings). The friendly category → tag mapping lives in the client.
    let task = params.get("task").map(String::as_str).unwrap_or("");
    // Optional org/user "browse this org" filter (a Hub namespace).
    let author = params.get("author").map(String::as_str).unwrap_or("");
    // Opaque pagination cursor for infinite scroll (from a prior page's
    // `next_cursor`). Forwarded verbatim to the Hub.
    let cursor = params
        .get("cursor")
        .map(String::as_str)
        .filter(|s| !s.is_empty());

    // A model-index active source has no HF query surface — route the search
    // through the active CatalogSource so its flat JSON index is listed. The
    // installed-only view is local + source-agnostic, so it always uses the HF
    // helper (which reads the on-disk models dir).
    if !installed_only {
        // Bind the active source ONCE and match on the binding (selection could
        // otherwise change between two awaits, panicking the `.expect`).
        let active = state
            .catalog_sources
            .get_active(
                crate::catalog_source::CatalogKind::Model,
                &state.preferences,
            )
            .await;
        if let Some(source) = active.as_ref().filter(|s| is_seam_model_source(s)) {
            let mut q = crate::catalog_source::CatalogQuery {
                query: query.to_string(),
                limit,
                cursor: cursor.map(str::to_string),
                ..Default::default()
            };
            q.extra.insert(
                "sort".to_string(),
                serde_json::Value::String(params.get("sort").cloned().unwrap_or_default()),
            );
            q.extra.insert(
                "format".to_string(),
                serde_json::Value::String(format.as_str().to_string()),
            );
            return match source.search(&state.client, &q).await {
                Ok(value) => (StatusCode::OK, Json(value)),
                Err(e) => (
                    catalog_search_error_status(&e),
                    Json(json!({ "error": e.to_string(), "models": [] })),
                ),
            };
        }
    }

    let endpoint = active_model_endpoint(&state).await;
    match crate::model_catalog::search_models_json(
        &state.client,
        &endpoint,
        query,
        sort,
        format,
        limit,
        installed_only,
        task,
        author,
        cursor,
    )
    .await
    {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string(), "models": [] })),
        ),
    }
}

/// `GET /api/models/catalog/detail?id=author%2Fname`
#[utoipa::path(
    get,
    path = "/api/models/catalog/detail",
    tag = "Models",
    summary = "Model detail: README + per-quant files",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn models_catalog_detail(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(id) = params.get("id").filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing required `id` query parameter" })),
        );
    };
    // A model-index active source resolves detail from its flat JSON index, not
    // the HF info/tree/README round-trips. Bind the active source ONCE and match
    // on the binding (avoids a panic if selection changes between two awaits).
    let active = state
        .catalog_sources
        .get_active(
            crate::catalog_source::CatalogKind::Model,
            &state.preferences,
        )
        .await;
    if let Some(source) = active.as_ref().filter(|s| is_seam_model_source(s)) {
        return match source.detail(&state.client, id).await {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": e.to_string() })),
            ),
        };
    }

    let format = crate::model_format::ModelFormat::from_wire(
        params.get("format").map(String::as_str).unwrap_or("gguf"),
    );
    let endpoint = active_model_endpoint(&state).await;
    match crate::model_catalog::model_detail_json(&state.client, &endpoint, id, format).await {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct ModelInstallBody {
    pub(in crate::server) id: String,
    /// GGUF filename to install. Required for single-file (GGUF) installs;
    /// ignored for a snapshot install (the whole repo is fetched).
    #[serde(default)]
    pub(in crate::server) file: String,
    /// Weight format. Defaults to GGUF for back-compat with older clients.
    /// Drives the single-file-vs-snapshot dispatch on the direct HF path.
    #[serde(default)]
    pub(in crate::server) format: Option<String>,
    #[serde(rename = "dryRun", default)]
    pub(in crate::server) dry_run: bool,
}

/// Header carrying the buyer's CONTROL-PLANE session bearer for a Marketplace
/// install (#491). Distinct from `Authorization` on purpose: `Authorization`
/// holds the Core **node** token (a machine secret the control plane does not
/// recognize as a user), so the desktop sends its signed-in Better-Auth session
/// token here instead, and Core forwards it to the install handoff for optional
/// account-aware commerce. Absent ⇒ anonymous install.
pub(in crate::server) const BUYER_TOKEN_HEADER: &str = "x-ryu-buyer-token";

/// Extract the caller's marketplace buyer bearer to forward to the install
/// handoff. Prefers the dedicated [`BUYER_TOKEN_HEADER`] (the user's
/// control-plane session token); when absent, falls back to the
/// `Authorization: Bearer …` value so a direct/headless caller hitting Core with
/// a real user token still works. Returns the trimmed token, or `None` for an
/// anonymous install.
pub(in crate::server) fn buyer_bearer_from_headers(
    headers: &axum::http::HeaderMap,
) -> Option<String> {
    let from_dedicated = headers
        .get(BUYER_TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    if from_dedicated.is_some() {
        return from_dedicated;
    }
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}
