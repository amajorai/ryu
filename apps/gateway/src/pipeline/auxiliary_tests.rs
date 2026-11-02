const MAX_PROVIDER_STREAM_BYTES: usize = 8 * 1024 * 1024;

use super::*;
use crate::{
    config::{
        FirewallConfig, FirewallPolicy, GatewayConfig, ProviderId, SmartRoutingConfig, SmartRule,
    },
    router::smart::SmartRouter,
};
use std::{
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
};

#[derive(Default)]
struct RecordingProvider {
    requests: Mutex<Vec<Value>>,
    response_text: Mutex<Option<String>>,
}
impl Provider for RecordingProvider {
    fn name(&self) -> &'static str {
        "openai"
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.requests.lock().unwrap().push(body.clone());
            let content = self
                .response_text
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| {
                    if body["max_tokens"] == 4 {
                        "ESCALATE".into()
                    } else {
                        "1".into()
                    }
                });
            Ok(
                json!({"choices":[{"message":{"content":content}}],"usage":{"prompt_tokens":20,"completion_tokens":1,"cost":0.001}}),
            )
        })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Body, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.requests.lock().unwrap().push(body.clone());
            let text = self
                .response_text
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| "hello".into());
            let delta = json!({"choices":[{"delta":{"content":text}}]});
            let usage = json!({"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":10,"cost":0.002}});
            Ok(Body::from(format!(
                "data: {delta}\n\ndata: {usage}\n\ndata: [DONE]\n\n"
            )))
        })
    }
    fn embed<'a>(
        &'a self,
        _model: &'a str,
        body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            self.requests.lock().unwrap().push(body.clone());
            Ok(json!({"data":[{"embedding":[1.0,0.0]}],"usage":{"prompt_tokens":20,"cost":0.001}}))
        })
    }
    fn rerank<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        self.embed(model, body)
    }
}
fn routing() -> SmartRoutingConfig {
    SmartRoutingConfig {
        enabled: true,
        classifier_model: "test".into(),
        cache_by_session: false,
        rules: vec![SmartRule {
            description: "coding".into(),
            model: "test".into(),
            weight: 1.0,
        }],
        ..Default::default()
    }
}
fn fixture(configure: impl FnOnce(&mut GatewayConfig)) -> (Arc<AppState>, Arc<RecordingProvider>) {
    let mut config = GatewayConfig::default();
    config.routing.default_provider = ProviderId::from("openai");
    config.routing.fallback_chain = vec![ProviderId::from("openai")];
    config.routing.smart_routing = routing();
    config.providers.openai = Some(
        serde_json::from_value(json!({"api_key":"test-key","base_url":"http://127.0.0.1:1/v1"}))
            .unwrap(),
    );
    config.firewall = FirewallConfig {
        enabled: false,
        ..Default::default()
    };
    configure(&mut config);
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let mut state = AppState::new_for_test(
        config,
        audit,
        crate::evals::EvalsRunner::new(Default::default()),
    );
    if state.config.semantic_cache.enabled {
        state.semantic_cache =
            crate::semantic_cache::SemanticCacheRegistry::from_cache(SemanticCache::new(
                state.config.semantic_cache.clone(),
                60,
                state.config.cache.max_entries,
            ));
    }
    let provider = Arc::new(RecordingProvider::default());
    state.provider_runtime.register_for_test(provider.clone());
    (Arc::new(state), provider)
}
fn ctx() -> RequestContext {
    super::super::test_support::plain_request_context()
}
fn prompt() -> Value {
    json!({"model":"test","messages":[{"role":"user","content":"coding"}]})
}

/// The control plane's debit reason enum (`debitReasonSchema` in the
/// control-plane credits router). It answers 400 to any other reason.
const CONTROL_PLANE_DEBIT_REASONS: [&str; 7] = [
    "gateway_usage",
    "openrouter",
    "composio",
    "treg",
    "subscription_offset",
    "adjustment",
    "sandbox",
];

/// A `/api/credits/debit` stand-in that validates `reason` the way the
/// control plane does and records every body it accepts or rejects.
pub(super) struct DebitFixture {
    pub base_url: String,
    pub debits: Arc<Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<()>,
}
impl DebitFixture {
    pub async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let debits = Arc::new(Mutex::new(Vec::<Value>::new()));
        let recorded = Arc::clone(&debits);
        let server = tokio::spawn(async move {
            let route = axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let recorded = Arc::clone(&recorded);
                async move {
                    let accepted = body["reason"]
                        .as_str()
                        .is_some_and(|reason| CONTROL_PLANE_DEBIT_REASONS.contains(&reason));
                    recorded.lock().unwrap().push(body);
                    if accepted {
                        (
                            axum::http::StatusCode::OK,
                            r#"{"balanceMicroUsd":1000000,"applied":true,"duplicate":false,"wentNonPositive":false}"#,
                        )
                    } else {
                        (
                            axum::http::StatusCode::BAD_REQUEST,
                            r#"{"error":"bad reason"}"#,
                        )
                    }
                }
            });
            axum::serve(
                listener,
                axum::Router::new().route("/api/credits/debit", route),
            )
            .await
            .unwrap();
        });
        Self {
            base_url: format!("http://{address}"),
            debits,
            server,
        }
    }
    /// Turn on fail-closed managed metering against this fixture.
    pub fn meter(&self, config: &mut GatewayConfig) {
        config.credits.enabled = true;
        config.credits.base_url = self.base_url.clone();
        config.credits.internal_secret = Some("test-internal-secret".into());
        config.credits.fail_closed = true;
    }
    /// Wait (bounded) until `count` debits arrived, then give stragglers a
    /// moment so an unexpected extra debit is also observed.
    pub async fn wait_for(&self, count: usize) -> Vec<Value> {
        for _ in 0..200 {
            if self.debits.lock().unwrap().len() >= count {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        self.debits.lock().unwrap().clone()
    }
}
impl Drop for DebitFixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
fn managed_ctx(request_id: &str) -> RequestContext {
    let mut context = ctx();
    context.request_id = request_id.into();
    context.managed_inference = true;
    context.org_id = Some("org".into());
    context
}

/// An `openai` stand-in answering buffered tool-loop rounds from a script.
/// With `hold`, the round at that index waits for a release signal, so a
/// test can drop the caller while the provider works on it.
struct ScriptedRounds {
    script: Vec<Result<Value, String>>,
    calls: AtomicUsize,
    hold: Option<(
        usize,
        Arc<tokio::sync::Notify>,
        tokio::sync::watch::Receiver<bool>,
    )>,
}
impl Provider for ScriptedRounds {
    fn name(&self) -> &'static str {
        "openai"
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        let round = self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if let Some((_, started, release)) =
                self.hold.as_ref().filter(|(held, ..)| *held == round)
            {
                started.notify_one();
                let mut release = release.clone();
                while !*release.borrow() {
                    if release.changed().await.is_err() {
                        break;
                    }
                }
            }
            match self.script.get(round) {
                Some(Ok(answer)) => Ok(answer.clone()),
                Some(Err(message)) => {
                    Err(ryu_gw_providers::ProviderError::Provider(message.clone()))
                }
                None => Err(ryu_gw_providers::ProviderError::Provider(
                    "unscripted round".into(),
                )),
            }
        })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Body, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async {
            Err(ryu_gw_providers::ProviderError::Provider(
                "tool loops are buffered".into(),
            ))
        })
    }
}
fn tool_call_round(input: u64, output: u64, cost: f64) -> Result<Value, String> {
    tool_call_round_named("composio.GMAIL_SEND_EMAIL", input, output, cost)
}
fn tool_call_round_named(tool: &str, input: u64, output: u64, cost: f64) -> Result<Value, String> {
    Ok(json!({
        "choices": [{
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": tool, "arguments": "{}"}
                }]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": input, "completion_tokens": output, "cost": cost}
    }))
}
fn answer_round(input: u64, output: u64, cost: f64) -> Result<Value, String> {
    Ok(json!({
        "choices": [{
            "message": {"role": "assistant", "content": "done"},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": input, "completion_tokens": output, "cost": cost}
    }))
}
/// A metered node whose requests run the unified tool loop over `provider`.
fn tool_loop_fixture(control_plane: &DebitFixture, provider: Arc<ScriptedRounds>) -> Arc<AppState> {
    tool_loop_fixture_with(control_plane, provider, |_| {})
}
fn tool_loop_fixture_with(
    control_plane: &DebitFixture,
    provider: Arc<ScriptedRounds>,
    configure: impl FnOnce(&mut GatewayConfig),
) -> Arc<AppState> {
    let (mut state, _) = fixture(|config| {
        control_plane.meter(config);
        config.routing.smart_routing.enabled = false;
        configure(config);
    });
    let state_mut = Arc::get_mut(&mut state).unwrap();
    state_mut.provider_runtime.register_for_test(provider);
    // The scripted tool call is outside the request's allowlist, so the
    // loop answers it with a denial and never reaches this catalog.
    state_mut.tools = Some(crate::tools::ToolSearchClient::new(
        &crate::config::CoreProviderConfig {
            base_url: "http://127.0.0.1:1".into(),
            token: None,
        },
        state_mut.http.clone(),
    ));
    state
}
fn tool_ctx(request_id: &str) -> RequestContext {
    let mut context = managed_ctx(request_id);
    context.tools_header_present = true;
    context.tool_search_requested = true;
    context.remaining_budget_micro_usd = Some(1_000_000);
    context
}
/// A stand-in for Core's tool catalog that counts the tools it is asked
/// to run and answers each with an empty result.
async fn counting_tool_catalog() -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let tool_calls = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&tool_calls);
    let app = axum::Router::new().route(
        "/api/mcp/tools/call",
        axum::routing::post(move || {
            let counted = Arc::clone(&counted);
            async move {
                counted.fetch_add(1, Ordering::SeqCst);
                axum::Json(json!({ "content": [] }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (base_url, tool_calls, server)
}

#[path = "auxiliary_tests/cancellation_test.rs"]
mod cancellation;
#[path = "auxiliary_tests/embedding_inspector_test.rs"]
mod embedding_inspector;
#[path = "auxiliary_tests/local_engine_test.rs"]
mod local_engine;
fn embedding_body(operation: EmbeddingOperation, text: &str) -> Value {
    match operation {
        EmbeddingOperation::Embed => json!({"model":"test","input":[text]}),
        EmbeddingOperation::Rerank => {
            json!({"model":"test","query":text,"documents":[text,"public"]})
        }
    }
}

#[path = "auxiliary_tests/routing_test.rs"]
mod routing;
#[path = "auxiliary_tests/settlement_test.rs"]
mod settlement;
#[path = "auxiliary_tests/tool_loop_test.rs"]
mod tool_loop;
#[path = "auxiliary_tests/tool_loop_billing_test.rs"]
mod tool_loop_billing;
