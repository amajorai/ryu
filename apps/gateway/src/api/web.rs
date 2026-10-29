//! Authenticated Ryu web-service extensions; these are not OpenAI web standards.

use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use ryu_gw_credentials::web::{WebContentFormat, WebOperation, WebProviderKind, WEB_PROVIDERS};
use ryu_gw_providers::web::{ValidatedPublicWebUrl, WebFetchRequest, WebSearchRequest};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    config::ApiKeyOperation,
    error::GatewayError,
    pipeline::{authenticate_for_operation, AuthInputs},
    state::SharedState,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchBody {
    query: String,
    #[serde(default = "default_limit")]
    limit: u16,
    provider: Option<WebProviderKind>,
}
fn default_limit() -> u16 {
    10
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FetchBody {
    url: String,
    #[serde(default = "default_format")]
    format: WebContentFormat,
    provider: Option<WebProviderKind>,
}
fn default_format() -> WebContentFormat {
    WebContentFormat::Markdown
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 256 && !value.chars().any(char::is_control))
        .map(str::to_owned)
}
pub(super) fn inputs(headers: &HeaderMap) -> AuthInputs<'_> {
    AuthInputs {
        raw_api_key: headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
        user_id: header(headers, "x-ryu-user-id"),
        user_jwt: header(headers, "x-ryu-user-jwt"),
        agent_id: header(headers, "x-ryu-agent-id"),
        agent_provider_access: header(headers, "x-ryu-agent-provider-access"),
        agent_proof: header(headers, "x-ryu-agent-proof"),
        session_id: header(headers, "x-ryu-session-id"),
        feature: Some("web".into()),
        ..Default::default()
    }
}

fn response(output: crate::pipeline::web::WebPipelineOutput) -> Response {
    let mut response = Json(output.response).into_response();
    response
        .headers_mut()
        .insert("x-provider", HeaderValue::from_static(output.provider));
    if let Ok(value) = HeaderValue::from_str(&output.context.request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    if let Some(degraded) = output.degraded {
        if let Ok(value) = HeaderValue::from_str(&degraded.header_value()) {
            response.headers_mut().insert("x-degraded", value);
        }
    }
    if let Some(budget) = output.budget {
        response.headers_mut().insert(
            "x-budget-scope",
            HeaderValue::from_static(budget.scope.as_str()),
        );
        response
            .headers_mut()
            .insert("x-budget-action", HeaderValue::from_static("notify"));
    }
    if let Some(alert) = output.policy_alert {
        response.extensions_mut().insert(alert);
    }
    response
}

pub async fn search(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<SearchBody>,
) -> Result<Response, GatewayError> {
    let ctx =
        authenticate_for_operation(&state, inputs(&headers), ApiKeyOperation::WebSearch).await?;
    let request = WebSearchRequest::new(body.query, body.limit)
        .map_err(|_| GatewayError::BadRequest("Invalid bounded web search request".into()))?;
    crate::pipeline::web::run(
        state,
        ctx,
        crate::pipeline::web::WebRequest::Search(request),
        body.provider,
    )
    .await
    .map(response)
}

pub async fn fetch(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<FetchBody>,
) -> Result<Response, GatewayError> {
    let ctx =
        authenticate_for_operation(&state, inputs(&headers), ApiKeyOperation::WebFetch).await?;
    let url = ValidatedPublicWebUrl::parse(&body.url)
        .map_err(|_| GatewayError::BadRequest("Web fetch requires a public HTTP(S) URL".into()))?;
    let request = WebFetchRequest::new(url, body.format);
    crate::pipeline::web::run(
        state,
        ctx,
        crate::pipeline::web::WebRequest::Fetch(request),
        body.provider,
    )
    .await
    .map(response)
}

pub async fn capabilities(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Json<Value>, GatewayError> {
    let search =
        authenticate_for_operation(&state, inputs(&headers), ApiKeyOperation::WebSearch).await;
    let fetch =
        authenticate_for_operation(&state, inputs(&headers), ApiKeyOperation::WebFetch).await;
    let contexts = match (search, fetch) {
        (Ok(search), Ok(fetch)) => {
            if search.org_id != fetch.org_id || search.owner_binding != fetch.owner_binding {
                return Err(GatewayError::Unauthorized(
                    "Web credential resolution changed".into(),
                ));
            }
            vec![(WebOperation::Search, search), (WebOperation::Fetch, fetch)]
        }
        (Ok(ctx), Err(_)) => vec![(WebOperation::Search, ctx)],
        (Err(_), Ok(ctx)) => vec![(WebOperation::Fetch, ctx)],
        (Err(error), Err(_)) => return Err(error),
    };
    let clock = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    Ok(Json(capabilities_view(&state, &contexts, clock)))
}

fn capabilities_view(
    state: &SharedState,
    contexts: &[(WebOperation, crate::pipeline::RequestContext)],
    clock: u64,
) -> Value {
    let providers:Vec<_>=WEB_PROVIDERS.iter().filter_map(|descriptor| {
        let mut operations=Vec::new();let mut ready=false;let mut configured=false;let mut anonymous=false;let mut diagnostic=None;
        for (operation,ctx) in contexts {
            if !descriptor.operations.contains(operation){continue;}
            let policy=ctx.resolved_policy.clone().unwrap_or_else(||state.policy_snapshot());
            if !ctx.is_master_key && !policy.allows_provider(descriptor.provider_id){continue;}
            let snapshot=ctx.provider_snapshot.clone().unwrap_or_else(||state.provider_runtime.snapshot());
            let connection=snapshot.config.web.get(&descriptor.kind);
            let bound=snapshot.bind_web(descriptor.kind,*operation,None,clock).ok();
            if !ctx.is_master_key && !policy.allows_region(bound.as_ref().and_then(|route|route.region.as_deref())){continue;}
            operations.push(*operation);configured|=connection.is_some();anonymous|=connection.is_some_and(|connection|connection.is_anonymous());
            ready|=bound.is_some_and(|route|crate::pipeline::web::managed_ready(state,ctx,&route));
            if connection.is_none(){diagnostic=Some("not_configured");}
            else if descriptor.kind==WebProviderKind::GooglePse && clock>=ryu_gw_credentials::web::GOOGLE_PSE_SUNSET_UNIX_SECONDS {diagnostic=Some("google_pse_discontinued");}
            else if connection.is_some_and(|connection|connection.accounts().iter().any(|row|matches!(row.eligibility_diagnostic(clock),Some(ryu_gw_credentials::web::WebEligibilityDiagnostic::ExistingCustomerRequired)))) {diagnostic=Some("existing_customer_required");}
            else {diagnostic=Some("service_unavailable");}
        }
        if operations.is_empty(){return None;}
        let formats=if operations.contains(&WebOperation::Fetch){descriptor.formats}else{&[]};
        Some(json!({"id":descriptor.provider_id,"operations":operations,"formats":formats,"configured":configured,"ready":ready,"diagnostic":if ready{None}else{diagnostic},"auth_mode":if configured{Some(if anonymous{"anonymous"}else{"accounts"})}else{None},"context_fields":match descriptor.context {ryu_gw_credentials::web::WebContextKind::GooglePse=>vec!["engine_id","existing_customer_acknowledged"],ryu_gw_credentials::web::WebContextKind::SearchApi=>vec!["engine"],_=>vec![]},"sunset":(descriptor.kind==WebProviderKind::GooglePse).then_some("2027-01-01")}))
    }).collect();
    json!({"providers":providers})
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_gw_providers::web::{WebSearchOutput, WebSearchResult, WebServiceUsage};
    use ryu_gw_providers::{Provider, ProviderError};
    use std::pin::Pin;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tower::ServiceExt;

    struct Fixture {
        kind: WebProviderKind,
        calls: Arc<AtomicUsize>,
        uncertain: bool,
    }
    impl Provider for Fixture {
        fn name(&self) -> &'static str {
            self.kind.descriptor().provider_id
        }
        fn web_descriptor(
            &self,
        ) -> Option<&'static ryu_gw_credentials::web::WebProviderDescriptor> {
            Some(self.kind.descriptor())
        }
        fn complete<'a>(
            &'a self,
            _: &'a str,
            _: &'a Value,
        ) -> Pin<Box<dyn std::future::Future<Output = Result<Value, ProviderError>> + Send + 'a>>
        {
            Box::pin(async { Err(ProviderError::Provider("not chat".into())) })
        }
        fn complete_stream<'a>(
            &'a self,
            _: &'a str,
            _: &'a Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<Output = Result<axum::body::Body, ProviderError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async { Err(ProviderError::Provider("not chat".into())) })
        }
        fn web_search_for_session<'a>(
            &'a self,
            request: &'a WebSearchRequest,
            _: Option<&'a str>,
        ) -> Pin<
            Box<
                dyn std::future::Future<Output = Result<WebSearchOutput, ProviderError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                if self.uncertain {
                    return Err(ProviderError::DeliveryUncertain(
                        "accepted response unavailable".into(),
                    ));
                }
                Ok(WebSearchOutput {
                    results: vec![WebSearchResult {
                        title: Some("Result".into()),
                        url: "https://example.com/article".into(),
                        snippet: request.query().to_owned(),
                        score: None,
                    }],
                    usage: WebServiceUsage {
                        requests: 1,
                        ..Default::default()
                    },
                })
            })
        }
    }

    fn state() -> (SharedState, Arc<AtomicUsize>) {
        let mut config = crate::config::GatewayConfig::default();
        config.auth=serde_json::from_value(json!({"require_auth":false,"api_keys":[{"key":"web-client-test","name":"web-client","allowed_operations":["web_search","web_fetch"]},{"key":"inference-client-test","name":"inference-client"}]})).unwrap();
        config.providers.web=serde_json::from_value(json!({"tavily":{"mode":"accounts","accounts":[{"api_key":"hidden-vendor-material"}]},"brave":{"mode":"accounts","accounts":[{"api_key":"hidden-brave-material"}]},"jina-reader":{"mode":"anonymous"}})).unwrap();
        config.routing.web.search = Some(crate::web_config::WebBinding::Provider {
            provider: WebProviderKind::Tavily,
        });
        let mut state = crate::state::AppState::new_for_test(
            config,
            crate::audit::AuditLogger::new(&crate::config::AuditConfig {
                enabled: false,
                db_path: String::new(),
            })
            .unwrap(),
            crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
        );
        let calls = Arc::new(AtomicUsize::new(0));
        state.provider_runtime.register_for_test(Arc::new(Fixture {
            kind: WebProviderKind::Tavily,
            calls: Arc::clone(&calls),
            uncertain: false,
        }));
        (Arc::new(state), calls)
    }

    fn app(state: SharedState) -> axum::Router {
        axum::Router::new()
            .route("/v1/web/search", axum::routing::post(search))
            .route("/v1/web/fetch", axum::routing::post(fetch))
            .route("/v1/web/capabilities", axum::routing::get(capabilities))
            .with_state(state)
    }
    async fn request(
        app: axum::Router,
        path: &str,
        key: Option<&str>,
        body: Value,
    ) -> axum::response::Response {
        let mut builder = axum::http::Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json");
        if let Some(key) = key {
            builder = builder.header("authorization", format!("Bearer {key}"));
        }
        app.oneshot(
            builder
                .body(axum::body::Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn actual_routes_require_explicit_grants_even_when_inference_is_anonymous() {
        let (state, calls) = state();
        let app = app(state);
        for key in [
            None,
            Some("inference-client-test"),
            Some("arbitrary-bearer"),
        ] {
            let response =
                request(app.clone(), "/v1/web/search", key, json!({"query":"hello"})).await;
            assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let response = request(
            app.clone(),
            "/v1/web/search",
            Some("web-client-test"),
            json!({"query":"hello"}),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(response.headers()["x-provider"], "tavily");
        assert!(response.headers().contains_key("x-request-id"));
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["object"], "web.search");
        assert_eq!(body["usage"]["requests"], 1);
        assert!(body["usage"]["cost_micro_usd"].is_null());
        assert!(!String::from_utf8_lossy(&bytes).contains("hidden-vendor-material"));
        assert_eq!(
            request(
                app,
                "/v1/web/search",
                Some("web-client-test"),
                json!({"query":"hello"})
            )
            .await
            .status(),
            axum::http::StatusCode::OK
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2); // no service response cache
    }

    #[tokio::test]
    async fn strict_request_and_ssrf_boundaries_reject_before_provider_io() {
        let (state, calls) = state();
        let app = app(state);
        for body in [
            json!({"query":"hello","api_key":"caller-injection"}),
            json!({"query":"hello","limit":11}),
            json!({"query":"hello","provider":"jina"}),
            json!({"query":""}),
        ] {
            assert!(
                request(app.clone(), "/v1/web/search", Some("web-client-test"), body)
                    .await
                    .status()
                    .is_client_error()
            );
        }
        for url in [
            "http://127.0.0.1/",
            "http://[::ffff:127.0.0.1]/",
            "http://user:secret@example.com/",
            "file:///tmp/private",
            "https://example.com:8443/private",
        ] {
            assert!(request(
                app.clone(),
                "/v1/web/fetch",
                Some("web-client-test"),
                json!({"url":url})
            )
            .await
            .status()
            .is_client_error());
        }
        assert!(request(
            app,
            "/v1/web/fetch",
            Some("web-client-test"),
            json!({"url":"https://example.com/","format":"html"})
        )
        .await
        .status()
        .is_client_error());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn capability_projection_keeps_operation_policy_and_managed_admission_separate() {
        let (state, _) = state();
        let snapshot = state.provider_runtime.snapshot();
        let mut search = crate::pipeline::test_support::plain_request_context();
        search.authorized_operation = ApiKeyOperation::WebSearch;
        search.provider_snapshot = Some(snapshot.clone());
        search.resolved_policy = Some(crate::policy::EffectivePolicy {
            approved_providers: vec!["tavily".into()],
            ..Default::default()
        });
        let mut fetch = search.clone();
        fetch.authorized_operation = ApiKeyOperation::WebFetch;
        fetch.resolved_policy = Some(crate::policy::EffectivePolicy {
            approved_providers: vec!["jina-reader".into()],
            ..Default::default()
        });
        let value = capabilities_view(
            &state,
            &[
                (WebOperation::Search, search.clone()),
                (WebOperation::Fetch, fetch),
            ],
            0,
        );
        let providers = value["providers"].as_array().unwrap();
        let tavily = providers.iter().find(|row| row["id"] == "tavily").unwrap();
        assert_eq!(tavily["operations"], json!(["search"]));
        assert!(providers
            .iter()
            .any(|row| row["id"] == "jina-reader" && row["operations"] == json!(["fetch"])));
        assert!(!value.to_string().contains("hidden-vendor-material"));
        search.managed_inference = true;
        search.org_id = Some("org".into());
        search.remaining_budget_micro_usd = Some(100);
        search.unrestricted_budget_micro_usd = Some(100);
        let value = capabilities_view(&state, &[(WebOperation::Search, search)], 0);
        assert_eq!(value["providers"][0]["ready"], false);
    }
}
