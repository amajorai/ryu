//! Admin-gated OpenRouter asynchronous inference batches.

use std::collections::HashSet;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use ryu_gw_providers::{
    BatchCreateRequest, BatchListQuery, BatchProvider, BatchProviderError, BATCH_ENDPOINTS,
};
use serde_json::{json, Value};

use crate::{
    pipeline::{authenticate, AuthInputs},
    state::SharedState,
};

pub const MAX_BATCH_REQUESTS: usize = 10_000;
pub const MAX_BATCH_BODY_BYTES: usize = 8 * 1024 * 1024;

async fn require_admin(
    state: &SharedState,
    headers: &HeaderMap,
) -> Result<crate::pipeline::RequestContext, Response> {
    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let context = authenticate(state, AuthInputs::with_key(raw_key))
        .await
        .map_err(IntoResponse::into_response)?;
    if !context.is_master_key {
        return Err(crate::error::GatewayError::Unauthorized(
            "OpenRouter batch operations require the Gateway master key".to_owned(),
        )
        .into_response());
    }
    Ok(context)
}

/// The hosted fleet refuses batch submission: a batch sends up to
/// [`MAX_BATCH_REQUESTS`] bodies upstream with no per-item screening, org or
/// budget. Refused after authentication and before any provider lookup, with
/// one audit row.
fn refuse_batch_on_fleet(
    state: &SharedState,
    ctx: &crate::pipeline::RequestContext,
) -> Option<Response> {
    if state.custody.allows_batch_create() {
        return None;
    }
    let error = crate::error::GatewayError::PlatformRefused {
        code: "feature_not_permitted",
        message: "Batch submission is not available on the hosted Gateway.",
    };
    state.metrics.inc_errors();
    crate::pipeline::provider_call_guard::audit(
        state,
        ctx,
        &crate::pipeline::provider_call_guard::ProviderCallAudit {
            provider: "openrouter",
            tool_id: "batches.create",
            org_id: ctx.org_id.as_deref(),
            start: std::time::Instant::now(),
        },
        Some("feature_not_permitted"),
    );
    Some(error.into_response())
}

fn batch_provider(state: &SharedState) -> Result<std::sync::Arc<dyn BatchProvider>, Response> {
    batch_provider_from_registry(&state.provider_runtime.snapshot().providers)
}

fn batch_provider_from_registry(
    providers: &crate::providers::ProviderRegistry,
) -> Result<std::sync::Arc<dyn BatchProvider>, Response> {
    providers.batch_provider_owned("openrouter").ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "error": {
                    "code": "provider_unavailable",
                    "message": "OpenRouter is not configured in this Gateway"
                }
            })),
        )
            .into_response()
    })
}

fn upstream_error(error: BatchProviderError) -> Response {
    let status = StatusCode::from_u16(error.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut response = (
        status,
        Json(json!({
            "error": {
                "code": "openrouter_batch_error",
                "message": error.message
            }
        })),
    )
        .into_response();
    if let Some(retry_after) = error.retry_after {
        if let Ok(value) = retry_after.parse() {
            response.headers_mut().insert("retry-after", value);
        }
    }
    response
}

pub fn validate_create_request(request: &BatchCreateRequest) -> Result<(), String> {
    if !BATCH_ENDPOINTS.contains(&request.endpoint.as_str()) {
        return Err(format!(
            "endpoint must be one of: {}",
            BATCH_ENDPOINTS.join(", ")
        ));
    }
    if request.model.trim().is_empty() || request.model.chars().count() > 256 {
        return Err("model must be non-empty and at most 256 characters".to_owned());
    }
    if request
        .completion_window
        .as_deref()
        .is_some_and(|window| window != "24h")
    {
        return Err("completion_window must be 24h".to_owned());
    }
    if request.requests.is_empty() || request.requests.len() > MAX_BATCH_REQUESTS {
        return Err(format!(
            "requests must contain between 1 and {MAX_BATCH_REQUESTS} items"
        ));
    }
    if let Some(provider) = &request.provider {
        if provider.only.is_empty()
            || provider
                .only
                .iter()
                .any(|slug| slug.is_empty() || slug.len() > 128)
        {
            return Err("provider.only must contain provider slugs".to_owned());
        }
    }

    let mut custom_ids = HashSet::with_capacity(request.requests.len());
    for (index, item) in request.requests.iter().enumerate() {
        if item.custom_id.trim().is_empty() || item.custom_id.chars().count() > 256 {
            return Err(format!(
                "requests[{index}].custom_id must be non-empty and at most 256 characters"
            ));
        }
        if !custom_ids.insert(item.custom_id.as_str()) {
            return Err(format!(
                "custom_id {:?} appears more than once",
                item.custom_id
            ));
        }
        if !item.body.is_object() {
            return Err(format!("requests[{index}].body must be a JSON object"));
        }
        if item
            .body
            .get("model")
            .and_then(Value::as_str)
            .is_some_and(|model| model != request.model)
        {
            return Err(format!(
                "requests[{index}].body.model must match the batch model"
            ));
        }
        if item.body.get("stream") == Some(&Value::Bool(true)) {
            return Err(format!("requests[{index}] cannot use stream: true"));
        }
    }
    Ok(())
}

pub fn validate_list_query(query: &BatchListQuery) -> Result<(), String> {
    if query.limit.is_some_and(|limit| !(1..=100).contains(&limit)) {
        return Err("limit must be between 1 and 100".to_owned());
    }
    if query.status.iter().any(|status| {
        !matches!(
            status.as_str(),
            "validating" | "in_progress" | "completed" | "failed" | "expired" | "cancelled"
        )
    }) {
        return Err("status contains an unsupported batch status".to_owned());
    }
    if query.after.as_deref().is_some_and(|id| !valid_batch_id(id)) {
        return Err("after must be an OpenRouter batch id".to_owned());
    }
    for (name, value) in [
        ("created_after", query.created_after.as_deref()),
        ("created_before", query.created_before.as_deref()),
    ] {
        if value.is_some_and(|value| value.is_empty() || value.len() > 64) {
            return Err(format!("{name} must contain 1 to 64 characters"));
        }
    }
    Ok(())
}

fn valid_batch_id(id: &str) -> bool {
    id.strip_prefix("batch_").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    })
}

/// `POST /v1/batches` — submit an asynchronous OpenRouter inference batch.
pub async fn create_batch(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(request): Json<BatchCreateRequest>,
) -> Response {
    let ctx = match require_admin(&state, &headers).await {
        Ok(ctx) => ctx,
        Err(response) => return response,
    };
    if let Some(response) = refuse_batch_on_fleet(&state, &ctx) {
        return response;
    }
    if let Err(error) = validate_create_request(&request) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "code": "invalid_batch_request", "message": error } })),
        )
            .into_response();
    }
    let runtime = state.provider_runtime.snapshot();
    if runtime
        .config
        .openrouter
        .as_ref()
        .is_some_and(|config| config.data_collection == "deny" || config.zdr)
    {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": {
                    "code": "batch_privacy_policy_unsupported",
                    "message": "OpenRouter batches cannot enforce this Gateway's per-request data-collection or zero-data-retention policy"
                }
            })),
        )
            .into_response();
    }
    if runtime
        .config
        .openrouter
        .as_ref()
        .is_some_and(|config| config.response_healing || !config.sort.is_empty())
    {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": {
                    "code": "batch_provider_option_unsupported",
                    "message": "OpenRouter batch requests cannot honor the configured response-healing plugin or provider sort preference"
                }
            })),
        )
            .into_response();
    }
    let provider = match batch_provider_from_registry(&runtime.providers) {
        Ok(provider) => provider,
        Err(response) => return response,
    };
    match provider.create_batch(&request).await {
        Ok(batch) => {
            tracing::info!(
                model = %request.model,
                endpoint = %request.endpoint,
                request_count = request.requests.len(),
                batch_id = batch
                    .get("id")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown"),
                "OpenRouter batch submitted"
            );
            (StatusCode::ACCEPTED, Json(batch)).into_response()
        }
        Err(error) => upstream_error(error),
    }
}

/// `GET /v1/batches` — list batches in the configured OpenRouter workspace.
pub async fn list_batches(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Query(query): Query<BatchListQuery>,
) -> Response {
    if let Err(response) = require_admin(&state, &headers).await {
        return response;
    }
    if let Err(error) = validate_list_query(&query) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "code": "invalid_batch_query", "message": error } })),
        )
            .into_response();
    }
    match batch_provider(&state) {
        Ok(provider) => provider
            .list_batches(&query)
            .await
            .map(|batches| Json(batches).into_response())
            .unwrap_or_else(upstream_error),
        Err(response) => response,
    }
}

/// `GET /v1/batches/:id` — poll a batch; completed results are inline.
pub async fn get_batch(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_admin(&state, &headers).await {
        return response;
    }
    if !valid_batch_id(&id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "code": "invalid_batch_id", "message": "id must be an OpenRouter batch id" } })),
        )
            .into_response();
    }
    match batch_provider(&state) {
        Ok(provider) => provider
            .get_batch(&id)
            .await
            .map(|batch| Json(batch).into_response())
            .unwrap_or_else(upstream_error),
        Err(response) => response,
    }
}

/// `DELETE /v1/batches/:id` — purge a terminal batch and its stored results.
pub async fn delete_batch(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_admin(&state, &headers).await {
        return response;
    }
    if !valid_batch_id(&id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "code": "invalid_batch_id", "message": "id must be an OpenRouter batch id" } })),
        )
            .into_response();
    }
    match batch_provider(&state) {
        Ok(provider) => provider
            .delete_batch(&id)
            .await
            .map(|batch| Json(batch).into_response())
            .unwrap_or_else(upstream_error),
        Err(response) => response,
    }
}

#[cfg(test)]
mod tests {
    use super::{create_batch, valid_batch_id, validate_create_request, validate_list_query};
    use axum::{
        body::{Body, Bytes},
        extract::State,
        http::{HeaderMap, HeaderValue, Request, StatusCode},
        routing::post,
        Json, Router,
    };
    use ryu_gw_providers::{BatchCreateRequest, BatchListQuery, BatchRequestItem};
    use serde_json::json;
    use std::sync::Arc;

    fn create_request() -> BatchCreateRequest {
        BatchCreateRequest {
            endpoint: "/v1/chat/completions".to_owned(),
            model: "openai/gpt-4o-mini".to_owned(),
            completion_window: Some("24h".to_owned()),
            provider: None,
            requests: vec![BatchRequestItem {
                custom_id: "eval-1".to_owned(),
                body: json!({ "messages": [{ "role": "user", "content": "Hi" }] }),
            }],
        }
    }

    fn master_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_static("Bearer master-secret"),
        );
        headers
    }

    fn batch_test_state(
        base_url: &str,
        data_collection: &str,
        zdr: bool,
        sort: &str,
        response_healing: bool,
    ) -> Arc<crate::state::AppState> {
        let mut config = crate::config::GatewayConfig::default();
        config.auth.master_key = Some("master-secret".to_owned());
        config.providers.openrouter = Some(crate::config::OpenRouterProviderConfig {
            api_key: "sk-or-mock".to_owned(),
            api_keys: Vec::new(),
            base_url: base_url.to_owned(),
            site_url: "https://ryu.example".to_owned(),
            site_name: "Ryu".to_owned(),
            data_collection: data_collection.to_owned(),
            zdr,
            sort: sort.to_owned(),
            response_healing,
            usage_accounting: true,
            org_api_keys: Default::default(),
        });
        let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .expect("disabled audit logger");
        let evals = crate::evals::EvalsRunner::new(config.evals.clone());
        Arc::new(crate::state::AppState::new_for_test(config, audit, evals))
    }

    #[test]
    fn validates_supported_batch_requests_and_unique_ids() {
        let request = create_request();
        assert!(validate_create_request(&request).is_ok());
        let mut duplicate = request;
        duplicate.requests.push(duplicate.requests[0].clone());
        assert!(validate_create_request(&duplicate)
            .unwrap_err()
            .contains("appears more than once"));
    }

    #[test]
    fn rejects_unsupported_shapes_streaming_and_model_mismatch() {
        let mut request = create_request();
        request.endpoint = "/v1/audio/speech".to_owned();
        assert!(validate_create_request(&request)
            .unwrap_err()
            .contains("endpoint"));

        let mut request = create_request();
        request.requests[0].body["stream"] = json!(true);
        assert!(validate_create_request(&request)
            .unwrap_err()
            .contains("stream"));

        let mut request = create_request();
        request.requests[0].body["model"] = json!("different/model");
        assert!(validate_create_request(&request)
            .unwrap_err()
            .contains("must match"));
    }

    #[test]
    fn batch_ids_and_list_filters_are_bounded() {
        assert!(valid_batch_id("batch_123abc"));
        assert!(!valid_batch_id("batch_../secret"));
        assert!(!valid_batch_id("other_123"));
        assert!(validate_list_query(&BatchListQuery {
            limit: Some(101),
            ..Default::default()
        })
        .is_err());
        assert!(validate_list_query(&BatchListQuery {
            status: vec!["finalizing".to_owned()],
            ..Default::default()
        })
        .is_err());
    }

    #[tokio::test]
    async fn batch_creation_requires_the_gateway_master_key() {
        let state = Arc::new(crate::state::AppState::new_for_test_default());
        let response = create_batch(State(state), HeaderMap::new(), Json(create_request())).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn batch_creation_rejects_gateway_options_the_batch_api_cannot_honor() {
        for (data_collection, zdr, sort, response_healing) in [
            ("deny", false, "", false),
            ("", true, "", false),
            ("", false, "price", false),
            ("", false, "", true),
        ] {
            let state = batch_test_state(
                "http://127.0.0.1:1/api/v1",
                data_collection,
                zdr,
                sort,
                response_healing,
            );
            let response =
                create_batch(State(state), master_headers(), Json(create_request())).await;
            assert_eq!(response.status(), StatusCode::CONFLICT);
        }
    }

    #[tokio::test]
    async fn gateway_batch_route_submits_once_to_the_configured_openrouter_account() {
        use std::sync::Mutex;
        use tower::ServiceExt;

        #[derive(Clone)]
        struct Capture(Arc<Mutex<Vec<u8>>>);

        async fn accept_batch(
            State(capture): State<Capture>,
            body: Bytes,
        ) -> (StatusCode, Json<serde_json::Value>) {
            *capture.0.lock().expect("capture lock") = body.to_vec();
            (
                StatusCode::ACCEPTED,
                Json(json!({ "id": "batch_local_1", "status": "validating" })),
            )
        }

        let captured = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock OpenRouter listener");
        let base = format!("http://{}", listener.local_addr().expect("mock address"));
        let mock_router = Router::new()
            .route("/api/v1/batches", post(accept_batch))
            .with_state(Capture(Arc::clone(&captured)));
        let server = tokio::spawn(async move {
            axum::serve(listener, mock_router)
                .await
                .expect("mock OpenRouter server");
        });

        let state = batch_test_state(&format!("{base}/api/v1"), "", false, "", false);
        let request = Request::builder()
            .method("POST")
            .uri("/v1/batches")
            .header("authorization", "Bearer master-secret")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&create_request()).expect("encode request"),
            ))
            .expect("build gateway request");

        let response = crate::api::router(state)
            .oneshot(request)
            .await
            .expect("gateway response");
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read gateway response");
        let body: serde_json::Value = serde_json::from_slice(&bytes).expect("batch JSON");
        assert_eq!(body["id"], "batch_local_1");

        let captured = captured.lock().expect("capture lock");
        let raw = std::str::from_utf8(&captured).expect("UTF-8 batch request");
        let requests_key = raw.find("\"requests\"").expect("requests field");
        assert!(raw.find("\"endpoint\"").expect("endpoint field") < requests_key);
        assert!(raw.find("\"model\"").expect("model field") < requests_key);
        assert!(raw[requests_key..].contains("\"custom_id\""));
        server.abort();
    }

    #[tokio::test]
    async fn batch_account_policy_publication_keeps_old_generation_alive_and_never_falls_back() {
        use std::collections::HashMap;
        use std::sync::Mutex;

        let captured = Arc::new(Mutex::new(Vec::<String>::new()));
        let upstream_capture = Arc::clone(&captured);
        let upstream = Router::new().route(
            "/api/v1/batches",
            post(move |headers: HeaderMap| {
                let captured = Arc::clone(&upstream_capture);
                async move {
                    captured.lock().expect("capture lock").push(
                        headers["authorization"]
                            .to_str()
                            .expect("account bearer")
                            .to_owned(),
                    );
                    (
                        StatusCode::ACCEPTED,
                        Json(json!({"id":"batch_generation_1","status":"validating"})),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock OpenRouter listener");
        let base = format!(
            "http://{}/api/v1",
            listener.local_addr().expect("mock address")
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, upstream).await.expect("mock server");
        });
        let state = batch_test_state(&base, "", false, "", false);
        let snapshot = state.provider_runtime.snapshot();
        let mut config = snapshot.config.clone();
        config
            .openrouter
            .as_mut()
            .expect("OpenRouter config")
            .api_keys = vec!["sk-or-secondary".to_owned()];
        let candidate = state
            .provider_runtime
            .build_candidate(
                config,
                snapshot.routing.clone(),
                state.config.egress.clone(),
                Default::default(),
                None,
            )
            .expect("second account generation");
        state
            .provider_runtime
            .publish(candidate)
            .expect("publish second account");
        drop(snapshot);
        // This is the same owned capability used by API handlers across await.
        let retained = super::batch_provider(&state).expect("retained batch capability");
        let snapshot = state.provider_runtime.snapshot();
        let before_epoch = snapshot.epoch.clone();
        let updates = HashMap::from([(
            "openrouter".to_owned(),
            HashMap::from([(
                ryu_gw_credentials::provider_account_id("openrouter", "sk-or-mock"),
                ryu_gw_providers::ProviderAccountPolicy {
                    name: "Disabled primary batch account".to_owned(),
                    enabled: false,
                    ..Default::default()
                },
            )]),
        )]);
        let candidate = state
            .provider_runtime
            .candidate_with_policies(&updates)
            .expect("disable primary account candidate");
        state
            .provider_runtime
            .publish(candidate)
            .expect("publish account policy");
        drop(snapshot);
        assert_ne!(state.provider_runtime.snapshot().epoch, before_epoch);
        let response = create_batch(
            State(Arc::clone(&state)),
            master_headers(),
            Json(create_request()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            captured.lock().expect("capture lock").is_empty(),
            "disabled batch owner must never submit using a secondary account"
        );
        let result = retained
            .create_batch(&create_request())
            .await
            .expect("in-flight old generation remains usable");
        assert_eq!(result["id"], "batch_generation_1");
        assert_eq!(
            *captured.lock().expect("capture lock"),
            vec!["Bearer sk-or-mock"]
        );
        server.abort();
    }

    #[tokio::test]
    async fn batch_lookup_observes_provider_removal_in_published_generation() {
        let state = batch_test_state("http://127.0.0.1:1/api/v1", "", false, "", false);
        let snapshot = state.provider_runtime.snapshot();
        let mut config = snapshot.config.clone();
        config.openrouter = None;
        let candidate = state
            .provider_runtime
            .build_candidate(
                config,
                snapshot.routing.clone(),
                state.config.egress.clone(),
                Default::default(),
                None,
            )
            .expect("provider removal candidate");
        state
            .provider_runtime
            .publish(candidate)
            .expect("publish removal");
        assert!(super::batch_provider(&state).is_err());
        // Master authentication still passes, but a stale startup provider must
        // not be used after removal from the executable runtime generation.
        let response = create_batch(State(state), master_headers(), Json(create_request())).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("error body");
        let body: serde_json::Value = serde_json::from_slice(&body).expect("error JSON");
        assert_eq!(body["error"]["code"], "provider_unavailable");
    }

    #[test]
    fn unchanged_provider_publication_preserves_batch_capability_identity() {
        let state = batch_test_state("http://127.0.0.1:1/api/v1", "", false, "", false);
        let snapshot = state.provider_runtime.snapshot();
        let original = snapshot
            .providers
            .batch_provider_owned("openrouter")
            .expect("batch capability");
        let candidate = state
            .provider_runtime
            .build_candidate(
                snapshot.config.clone(),
                snapshot.routing.clone(),
                state.config.egress.clone(),
                Default::default(),
                None,
            )
            .expect("unchanged provider candidate");
        state
            .provider_runtime
            .publish(candidate)
            .expect("publish unchanged generation");
        let current = super::batch_provider(&state).expect("current capability");
        assert!(Arc::ptr_eq(&original, &current), "unchanged provider must retain its batch account health and capability with the chat provider");
    }

    #[tokio::test]
    async fn batch_create_uses_privacy_and_option_policy_from_published_generation() {
        for (data_collection, zdr, sort, healing) in [
            ("deny", false, "", false),
            ("", true, "", false),
            ("", false, "price", false),
            ("", false, "", true),
        ] {
            let state = batch_test_state("http://127.0.0.1:1/api/v1", "", false, "", false);
            let snapshot = state.provider_runtime.snapshot();
            let mut config = snapshot.config.clone();
            let openrouter = config.openrouter.as_mut().expect("OpenRouter config");
            openrouter.data_collection = data_collection.to_owned();
            openrouter.zdr = zdr;
            openrouter.sort = sort.to_owned();
            openrouter.response_healing = healing;
            let candidate = state
                .provider_runtime
                .build_candidate(
                    config,
                    snapshot.routing.clone(),
                    state.config.egress.clone(),
                    Default::default(),
                    None,
                )
                .expect("live batch policy candidate");
            state
                .provider_runtime
                .publish(candidate)
                .expect("publish batch policy");
            let response =
                create_batch(State(state), master_headers(), Json(create_request())).await;
            assert_eq!(
                response.status(),
                StatusCode::CONFLICT,
                "live policy must reject before any upstream submission"
            );
        }
    }

    #[tokio::test]
    async fn batch_live_policy_clear_allows_submission_despite_restrictive_startup_config() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let upstream_entered = Arc::clone(&entered);
        let upstream_release = Arc::clone(&release);
        let upstream = Router::new().route(
            "/api/v1/batches",
            post(move || {
                let entered = Arc::clone(&upstream_entered);
                let release = Arc::clone(&upstream_release);
                async move {
                    entered.notify_one();
                    release.notified().await;
                    (
                        StatusCode::ACCEPTED,
                        Json(json!({"id":"batch_in_flight_1","status":"validating"})),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("mock listener");
        let base = format!(
            "http://{}/api/v1",
            listener.local_addr().expect("mock address")
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, upstream).await.expect("mock server");
        });
        let state = batch_test_state(&base, "deny", true, "price", true);
        let snapshot = state.provider_runtime.snapshot();
        let mut config = snapshot.config.clone();
        let openrouter = config.openrouter.as_mut().expect("OpenRouter config");
        openrouter.data_collection.clear();
        openrouter.zdr = false;
        openrouter.sort.clear();
        openrouter.response_healing = false;
        let candidate = state
            .provider_runtime
            .build_candidate(
                config,
                snapshot.routing.clone(),
                state.config.egress.clone(),
                Default::default(),
                None,
            )
            .expect("clear live options");
        state
            .provider_runtime
            .publish(candidate)
            .expect("publish cleared policy");
        let caller_state = Arc::clone(&state);
        let caller = tokio::spawn(async move {
            create_batch(
                State(caller_state),
                master_headers(),
                Json(create_request()),
            )
            .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
            .await
            .expect("cleared live policy must reach upstream despite restrictive startup config");
        // Publish a new privacy restriction while the old generation awaits its
        // response. The accepted operation keeps its captured generation; a
        // later caller must read and enforce the new policy.
        let snapshot = state.provider_runtime.snapshot();
        let mut config = snapshot.config.clone();
        config.openrouter.as_mut().expect("OpenRouter config").zdr = true;
        let candidate = state
            .provider_runtime
            .build_candidate(
                config,
                snapshot.routing.clone(),
                state.config.egress.clone(),
                Default::default(),
                None,
            )
            .expect("re-enable live privacy restriction");
        state
            .provider_runtime
            .publish(candidate)
            .expect("publish new restriction");
        let later = create_batch(State(state), master_headers(), Json(create_request())).await;
        assert_eq!(later.status(), StatusCode::CONFLICT);
        release.notify_one();
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), caller)
            .await
            .expect("in-flight caller completes")
            .expect("caller task");
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("accepted body");
        let body: serde_json::Value = serde_json::from_slice(&body).expect("accepted JSON");
        assert_eq!(body["id"], "batch_in_flight_1");
        server.abort();
    }
}
