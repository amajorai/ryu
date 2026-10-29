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

#[tokio::test]
async fn embedding_rerank_and_auxiliary_debits_use_an_accepted_reason() {
    let control_plane = DebitFixture::start().await;
    let (state, _) = fixture(|config| control_plane.meter(config));
    for (request_id, operation) in [
        ("req-embed", EmbeddingOperation::Embed),
        ("req-rerank", EmbeddingOperation::Rerank),
    ] {
        run_embedding(
            state.clone(),
            managed_ctx(request_id),
            embedding_body(operation, "hello"),
            operation,
        )
        .await
        .unwrap();
    }
    GovernedInference::new(state.clone(), managed_ctx("req-route"), "smart-routing")
        .complete("test", prompt(), 100)
        .await
        .unwrap();

    let debits = control_plane.wait_for(3).await;
    assert_eq!(debits.len(), 3, "one debit per paid call: {debits:?}");
    let mut labels: Vec<&str> = debits
        .iter()
        .map(|debit| debit["taskLabel"].as_str().unwrap())
        .collect();
    labels.sort_unstable();
    assert_eq!(labels, ["embedding", "rerank", "smart-routing"]);
    for debit in &debits {
        assert_eq!(debit["reason"], "gateway_usage", "{debit}");
        // Provider-reported $0.001, no markup.
        assert_eq!(debit["amountMicroUsd"], 1000, "{debit}");
        assert_eq!(debit["estimated"], false, "{debit}");
    }
    assert!(!state.wallet.is_org_accounting_unavailable("org"));
}

#[tokio::test]
async fn exhausted_wallet_stops_every_routing_strategy_before_dispatch() {
    for embedding in [false, true] {
        let (state, provider) = fixture(|_| {});
        let mut context = ctx();
        context.managed_inference = true;
        context.org_id = Some("org".into());
        context.remaining_budget_micro_usd = Some(0);
        let client = GovernedInference::new(state, context, "smart-routing");
        let result = if embedding {
            client.embed("test", "coding", 100).await.map(|_| ())
        } else {
            client.complete("test", prompt(), 100).await.map(|_| ())
        };
        assert!(matches!(result, Err(GatewayError::InsufficientCredits)));
        assert!(provider.requests.lock().unwrap().is_empty());
    }
}
#[tokio::test]
async fn rate_and_firewall_denials_precede_classifier_calls_on_both_pipelines() {
    for stream in [false, true] {
        for firewall in [false, true] {
            let (state, provider) = fixture(|config| {
                if firewall {
                    config.firewall.enabled = true;
                    config.firewall.policy = FirewallPolicy::Block;
                } else {
                    config.rate_limit.requests_per_minute = Some(0);
                }
            });
            let mut body = prompt();
            if firewall {
                body["messages"][0]["content"] =
                    json!("ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD");
            }
            let result = if stream {
                run_stream(state, ctx(), body).await.map(|_| ())
            } else {
                run(state, ctx(), body).await.map(|_| ())
            };
            assert!(result.is_err());
            assert!(provider.requests.lock().unwrap().is_empty());
        }
    }
}
#[tokio::test]
async fn classifier_escalation_and_embedding_remain_functional_and_metered() {
    for strategy in 0..3 {
        let (state, provider) = fixture(|_| {});
        let mut config = routing();
        if strategy == 1 {
            config.router_type = crate::config::ModelRouterType::Escalation;
            config.escalation_weak_model = "weak".into();
            config.escalation_strong_model = "strong".into();
            config.escalation_judge_model = "test".into();
            config.escalation_confirmations = 1;
        }
        if strategy == 2 {
            config.strategy = crate::config::RouteStrategy::Embedding;
            config.embedding_model = "test".into();
        }
        let router = SmartRouter::new(config);
        let client = GovernedInference::new(state.clone(), ctx(), "smart-routing");
        let result = router
            .resolve(&prompt()["messages"], None, &client)
            .await
            .unwrap();
        assert_eq!(
            result.as_deref(),
            Some(if strategy == 1 { "strong" } else { "test" })
        );
        assert!(!provider.requests.lock().unwrap().is_empty());
        assert!(
            state
                .metrics
                .total_input_tokens
                .load(std::sync::atomic::Ordering::Relaxed)
                > 0
        );
    }
}
#[tokio::test]
async fn auxiliary_dlp_inspects_rule_text_and_sanitizes_embedding_input() {
    let (state, provider) = fixture(|config| {
        config.firewall.enabled = true;
        config.firewall.policy = FirewallPolicy::Sanitize;
    });
    let client = GovernedInference::new(state, ctx(), "smart-routing");
    let secret = "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD";
    client.embed("test", secret, 100).await.unwrap();
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(!requests[0]["input"].as_str().unwrap().contains(secret));
}
#[test]
fn untrusted_overrides_never_enter_the_cache_and_trusted_cache_is_bounded() {
    let (state, _) = fixture(|_| {});
    let context = ctx();
    let mut body = json!({"ryu_smart_route":routing()});
    assert!(
        super::super::per_request_smart_router(&state, &context, &mut body)
            .unwrap()
            .is_none()
    );
    assert!(body.get("ryu_smart_route").is_none());
    assert_eq!(state.per_agent_routers.len(), 0);
    let mut trusted = context;
    trusted.is_master_key = true;
    for i in 0..100 {
        let mut config = routing();
        config.random_seed = Some(i);
        let mut body = json!({"ryu_smart_route":config});
        super::super::per_request_smart_router(&state, &trusted, &mut body).unwrap();
    }
    assert_eq!(state.per_agent_routers.len(), 64);
}
#[tokio::test]
async fn paid_auxiliary_calls_have_distinct_audit_and_budget_records() {
    let (state, provider) = fixture(|config| {
        config.budgets.users.insert(
            "user".into(),
            serde_json::from_value(json!({"limit":1500})).unwrap(),
        );
    });
    let mut context = ctx();
    context.user_id = Some("user".into());
    context.session_id = Some("session".into());
    let mut events = state.traffic.subscribe();
    let client = GovernedInference::new(state.clone(), context, "smart-routing");
    client.complete("test", prompt(), 100).await.unwrap();
    client.complete("test", prompt(), 100).await.unwrap();
    let first = events.try_recv().unwrap();
    let second = events.try_recv().unwrap();
    assert_ne!(first["request_id"], second["request_id"]);
    assert_ne!(first["request_id"], "test-req");
    assert_eq!(first["session_id"], "session");
    assert_eq!(first["provider_cost_micro_usd"], 1000);
    assert_eq!(state.audit.token_usage("sk-test"), 42);
    assert!(matches!(
        client.complete("test", prompt(), 100).await,
        Err(GatewayError::BudgetExceeded(_))
    ));
    assert_eq!(provider.requests.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn routing_propagates_denials_and_does_not_poison_cached_probes() {
    let (state, provider) = fixture(|_| {});
    let mut context = ctx();
    context.resolved_policy = Some(crate::policy::EffectivePolicy {
        approved_models: vec!["allowed".into()],
        ..Default::default()
    });
    let client = GovernedInference::new(state.clone(), context, "smart-routing");
    let router = SmartRouter::new(routing());
    assert!(matches!(
        router.resolve(&prompt()["messages"], None, &client).await,
        Err(GatewayError::PolicyViolation(_))
    ));
    assert!(provider.requests.lock().unwrap().is_empty());
    let permitted = GovernedInference::new(state, ctx(), "smart-routing");
    assert_eq!(
        router
            .resolve(&prompt()["messages"], None, &permitted)
            .await
            .unwrap()
            .as_deref(),
        Some("test")
    );
}
fn pooled_routing() -> SmartRoutingConfig {
    SmartRoutingConfig {
        enabled: true,
        strategy: crate::config::RouteStrategy::Keyword,
        cache_by_session: false,
        rules: vec![
            SmartRule {
                description: "coding".into(),
                model: "claude-sonnet-4-5".into(),
                weight: 1.0,
            },
            SmartRule {
                description: "coding".into(),
                model: "gpt-4o".into(),
                weight: 1.0,
            },
        ],
        ..Default::default()
    }
}
async fn routed_model(state: &Arc<AppState>, agent_id: Option<&str>) -> String {
    let mut context = ctx();
    context.agent_id = agent_id.map(str::to_owned);
    let mut body = prompt();
    super::super::apply_smart_routing(state, &context, &mut body)
        .await
        .unwrap();
    body["model"].as_str().unwrap().to_owned()
}
fn pool(models: &[&str], providers: &[&str]) -> crate::config::RoutePool {
    crate::config::RoutePool {
        allowed_models: models.iter().map(|m| (*m).to_owned()).collect(),
        allowed_providers: providers.iter().map(|p| (*p).to_owned()).collect(),
    }
}
#[tokio::test]
async fn agent_pools_narrow_the_global_router_per_agent() {
    let (state, _) = fixture(|config| {
        let mut routing = pooled_routing();
        routing
            .agent_pools
            .insert("gpt-bot".into(), pool(&["GPT-*"], &[]));
        routing
            .agent_pools
            .insert("openai-bot".into(), pool(&[], &["openai"]));
        config.routing.smart_routing = routing;
    });
    // No agent, or an agent without a pool: the first matching rule wins.
    assert_eq!(routed_model(&state, None).await, "claude-sonnet-4-5");
    assert_eq!(
        routed_model(&state, Some("other")).await,
        "claude-sonnet-4-5"
    );
    // A model pool hides the Claude rule from the router.
    assert_eq!(routed_model(&state, Some("gpt-bot")).await, "gpt-4o");
    // A provider pool does the same by resolved provider.
    assert_eq!(routed_model(&state, Some("openai-bot")).await, "gpt-4o");
}
#[tokio::test]
async fn global_pool_is_a_ceiling_an_agent_pool_cannot_widen() {
    let (state, _) = fixture(|config| {
        let mut routing = pooled_routing();
        routing.allowed_models = vec!["claude-*".into()];
        routing
            .agent_pools
            .insert("gpt-bot".into(), pool(&["gpt-*"], &[]));
        config.routing.smart_routing = routing;
    });
    assert_eq!(routed_model(&state, None).await, "claude-sonnet-4-5");
    // The intersection is empty, so routing keeps the requested model
    // instead of leaving the global pool.
    assert_eq!(routed_model(&state, Some("gpt-bot")).await, "test");
    // A per-agent override still sits under the global ceiling.
    let mut trusted = ctx();
    trusted.is_master_key = true;
    let mut override_config = pooled_routing();
    override_config.rules.reverse();
    let mut body = prompt();
    body["ryu_smart_route"] = json!(override_config);
    super::super::apply_smart_routing(&state, &trusted, &mut body)
        .await
        .unwrap();
    assert_eq!(body["model"], "claude-sonnet-4-5");
}
#[tokio::test]
async fn stored_agent_routes_override_the_global_router_per_agent() {
    let (state, _) = fixture(|config| {
        let mut routing = pooled_routing();
        let mut gpt_first = pooled_routing();
        gpt_first.rules.reverse();
        routing.agent_routes.insert("acp-bot".into(), gpt_first);
        config.routing.smart_routing = routing;
    });
    assert_eq!(routed_model(&state, None).await, "claude-sonnet-4-5");
    assert_eq!(
        routed_model(&state, Some("other")).await,
        "claude-sonnet-4-5"
    );
    // The stored override needs no Core request field, so it reaches ACP
    // agents that call the gateway directly.
    assert_eq!(routed_model(&state, Some("acp-bot")).await, "gpt-4o");

    // Core's request-scoped override still wins over the stored one.
    let mut trusted = ctx();
    trusted.is_master_key = true;
    trusted.agent_id = Some("acp-bot".into());
    let mut body = prompt();
    body["ryu_smart_route"] = json!(pooled_routing());
    super::super::apply_smart_routing(&state, &trusted, &mut body)
        .await
        .unwrap();
    assert_eq!(body["model"], "claude-sonnet-4-5");
}
#[tokio::test]
async fn stored_agent_routes_stay_inside_the_node_and_agent_pools() {
    let (state, _) = fixture(|config| {
        let mut routing = pooled_routing();
        routing.allowed_models = vec!["claude-*".into()];
        let mut gpt_first = pooled_routing();
        gpt_first.rules.reverse();
        routing
            .agent_routes
            .insert("acp-bot".into(), gpt_first.clone());
        routing.agent_routes.insert("pooled-bot".into(), gpt_first);
        routing
            .agent_pools
            .insert("pooled-bot".into(), pool(&[], &["anthropic"]));
        config.routing.smart_routing = routing;
    });
    // The node pool drops the GPT rule even though the override lists it first.
    assert_eq!(
        routed_model(&state, Some("acp-bot")).await,
        "claude-sonnet-4-5"
    );
    assert_eq!(
        routed_model(&state, Some("pooled-bot")).await,
        "claude-sonnet-4-5"
    );
}
#[test]
fn oversized_override_pools_are_rejected() {
    let (state, _) = fixture(|_| {});
    let mut trusted = ctx();
    trusted.is_master_key = true;
    let mut config = routing();
    config.allowed_models = (0..65).map(|i| format!("m{i}")).collect();
    let mut body = json!({"ryu_smart_route": config});
    assert!(matches!(
        super::super::per_request_smart_router(&state, &trusted, &mut body),
        Err(GatewayError::BadRequest(_))
    ));
}
#[tokio::test]
async fn denied_outer_requests_do_not_allocate_override_cache_entries() {
    let (state, provider) = fixture(|config| config.rate_limit.requests_per_minute = Some(0));
    let mut context = ctx();
    context.is_master_key = true;
    let mut body = prompt();
    body["ryu_smart_route"] = json!(routing());
    assert!(matches!(
        run(state.clone(), context, body).await,
        Err(GatewayError::RateLimited)
    ));
    assert_eq!(state.per_agent_routers.len(), 0);
    assert!(provider.requests.lock().unwrap().is_empty());
}
fn embedding_body(operation: EmbeddingOperation, text: &str) -> Value {
    match operation {
        EmbeddingOperation::Embed => json!({"model":"test","input":[text]}),
        EmbeddingOperation::Rerank => {
            json!({"model":"test","query":text,"documents":[text,"public"]})
        }
    }
}
#[tokio::test]
async fn embedding_endpoints_block_secrets_and_unapproved_models_before_dispatch() {
    for operation in [EmbeddingOperation::Embed, EmbeddingOperation::Rerank] {
        for locked in [false, true] {
            let (state, provider) = fixture(|config| {
                config.firewall.enabled = !locked;
                config.firewall.policy = FirewallPolicy::Block;
            });
            let mut context = ctx();
            if locked {
                context.resolved_policy = Some(crate::policy::EffectivePolicy {
                    locked_guardrails: vec!["secrets".into()],
                    ..Default::default()
                });
            }
            let result = run_embedding(
                state,
                context,
                embedding_body(operation, "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD"),
                operation,
            )
            .await;
            assert!(matches!(
                result,
                Err(GatewayError::FirewallBlocked(..) | GatewayError::PolicyViolation(_))
            ));
            assert!(provider.requests.lock().unwrap().is_empty());
        }
        let (state, provider) = fixture(|_| {});
        let mut context = ctx();
        context.resolved_policy = Some(crate::policy::EffectivePolicy {
            approved_models: vec!["allowed".into()],
            ..Default::default()
        });
        assert!(matches!(
            run_embedding(state, context, embedding_body(operation, "safe"), operation).await,
            Err(GatewayError::PolicyViolation(_))
        ));
        assert!(provider.requests.lock().unwrap().is_empty());
    }
}
#[tokio::test]
async fn embedding_cache_serves_repeat_inputs_without_a_provider_call() {
    let (state, provider) = fixture(|config| config.embedding_cache.enabled = true);
    let body = embedding_body(EmbeddingOperation::Embed, "hello world");
    let first = run_embedding(
        state.clone(),
        ctx(),
        body.clone(),
        EmbeddingOperation::Embed,
    )
    .await
    .unwrap();
    assert!(!first.cache_hit);
    // Normalization folds surrounding whitespace onto the same entry.
    let repeat = embedding_body(EmbeddingOperation::Embed, "  hello world\r\n");
    let second = run_embedding(state.clone(), ctx(), repeat, EmbeddingOperation::Embed)
        .await
        .unwrap();
    assert!(second.cache_hit);
    assert_eq!(second.provider_used, "cache");
    assert_eq!(second.response["data"][0]["embedding"], json!([1.0, 0.0]));
    assert_eq!(second.response["usage"]["total_tokens"], 0);
    assert_eq!(provider.requests.lock().unwrap().len(), 1);

    // Another credential, a new input, `user`, and rerank all bypass the entry.
    let mut other_caller = ctx();
    other_caller.owner_binding = "another-credential".into();
    let mut with_user = body.clone();
    with_user["user"] = json!("u-1");
    for (context, request, operation) in [
        (other_caller, body.clone(), EmbeddingOperation::Embed),
        (
            ctx(),
            embedding_body(EmbeddingOperation::Embed, "new"),
            EmbeddingOperation::Embed,
        ),
        (ctx(), with_user, EmbeddingOperation::Embed),
        (
            ctx(),
            embedding_body(EmbeddingOperation::Rerank, "hello world"),
            EmbeddingOperation::Rerank,
        ),
    ] {
        let output = run_embedding(state.clone(), context, request, operation)
            .await
            .unwrap();
        assert!(!output.cache_hit);
    }
    assert_eq!(provider.requests.lock().unwrap().len(), 5);
    let snapshot = state.metrics.snapshot();
    assert_eq!(snapshot["cache"]["embedding_hits"], 1);
    assert_eq!(snapshot["cache"]["embedding_misses"], 3);
}
#[tokio::test]
async fn embedding_cache_is_off_by_default() {
    let (state, provider) = fixture(|_| {});
    assert!(state.embedding_cache.is_none());
    let body = embedding_body(EmbeddingOperation::Embed, "hello");
    for _ in 0..2 {
        let output = run_embedding(
            state.clone(),
            ctx(),
            body.clone(),
            EmbeddingOperation::Embed,
        )
        .await
        .unwrap();
        assert!(!output.cache_hit);
    }
    assert_eq!(provider.requests.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn embedding_endpoints_sanitize_every_input_field_and_preserve_arrays() {
    for operation in [EmbeddingOperation::Embed, EmbeddingOperation::Rerank] {
        let (state, provider) = fixture(|config| {
            config.firewall.enabled = true;
            config.firewall.policy = FirewallPolicy::Sanitize;
        });
        let secret = "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD";
        run_embedding(state, ctx(), embedding_body(operation, secret), operation)
            .await
            .unwrap();
        let requests = provider.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(!requests[0].to_string().contains(secret));
        match operation {
            EmbeddingOperation::Embed => assert!(requests[0]["input"].is_array()),
            EmbeddingOperation::Rerank => {
                assert!(requests[0]["query"].is_string());
                assert_eq!(requests[0]["documents"].as_array().unwrap().len(), 2);
            }
        }
        assert!(requests[0].get("messages").is_none());
    }
}
#[tokio::test]
async fn embedding_overrun_is_charged_and_audited_before_429() {
    for operation in [EmbeddingOperation::Embed, EmbeddingOperation::Rerank] {
        let (state, provider) = fixture(|config| {
            config.rate_limit.tokens_per_minute = Some(10);
            config.budgets.users.insert(
                "user".into(),
                serde_json::from_value(json!({"limit":500})).unwrap(),
            );
        });
        let mut context = ctx();
        context.user_id = Some("user".into());
        let mut events = state.traffic.subscribe();
        assert!(matches!(
            run_embedding(
                state.clone(),
                context.clone(),
                embedding_body(operation, "x"),
                operation
            )
            .await,
            Err(GatewayError::RateLimited)
        ));
        assert_eq!(provider.requests.lock().unwrap().len(), 1);
        assert_eq!(state.audit.token_usage("sk-test"), 20);
        assert!(state
            .with_budget(|budget| budget.evaluate_charge(
                Some("user"),
                None,
                BudgetChargeKind::Model
            ))
            .is_some());
        let event = events.try_recv().unwrap();
        assert_eq!(event["input_tokens"], 20);
        assert_eq!(event["provider_cost_micro_usd"], 1000);
        assert!(event["error"].is_string());
        assert!(
            run_embedding(state, context, embedding_body(operation, "x"), operation)
                .await
                .is_err()
        );
        assert_eq!(provider.requests.lock().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn inspector_uses_sanitized_text_and_accounts_before_main_completion() {
    let (state, provider) = fixture(|config| {
        config.routing.smart_routing.enabled = false;
        config.firewall.enabled = true;
        config.firewall.policy = FirewallPolicy::Sanitize;
        config.firewall.inspector.enabled = true;
        config.firewall.inspector.min_chars = 0;
        config.firewall.inspector.model = "test".into();
    });
    let secret = "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD";
    let mut body = prompt();
    body["messages"][0]["content"] = json!(secret);
    let mut events = state.traffic.subscribe();
    run(state, ctx(), body).await.unwrap();
    let requests = provider.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(!requests[0].to_string().contains(secret));
    let first = events.try_recv().unwrap();
    assert_eq!(first["provider_cost_micro_usd"], 1000);
    assert_ne!(first["request_id"], "test-req");
}
#[tokio::test]
async fn optional_inspector_and_semantic_cache_obey_empty_wallet_before_dispatch() {
    for inspector in [false, true] {
        let (state, provider) = fixture(|config| {
            config.routing.smart_routing.enabled = false;
            config.semantic_cache.enabled = !inspector;
            config.semantic_cache.embedding_model = "test".into();
            config.firewall.inspector.enabled = inspector;
            config.firewall.inspector.min_chars = 0;
            config.firewall.inspector.model = "test".into();
        });
        let mut context = ctx();
        context.managed_inference = true;
        context.org_id = Some("org".into());
        context.remaining_budget_micro_usd = Some(0);
        assert!(matches!(
            run(state, context, prompt()).await,
            Err(GatewayError::InsufficientCredits)
        ));
        assert!(provider.requests.lock().unwrap().is_empty());
    }
}
#[tokio::test]
async fn semantic_cache_hit_still_accounts_its_embedding() {
    let (state, provider) = fixture(|config| {
        config.routing.smart_routing.enabled = false;
        config.semantic_cache.enabled = true;
        config.semantic_cache.embedding_model = "test".into();
        config.cache.enabled = false;
    });
    let mut events = state.traffic.subscribe();
    run(state.clone(), ctx(), prompt()).await.unwrap();
    let mut different = prompt();
    different["messages"][0]["content"] = json!("different wording");
    let result = run(state.clone(), ctx(), different).await.unwrap();
    assert!(result.cache_hit);
    assert_eq!(result.provider_used, "semantic-cache");
    assert_eq!(provider.requests.lock().unwrap().len(), 3);
    let mut paid = Vec::new();
    while let Ok(event) = events.try_recv() {
        if event["provider_cost_micro_usd"] == 1000 {
            paid.push(event);
        }
    }
    assert_eq!(paid.len(), 3);
    assert_eq!(state.audit.token_usage("sk-test"), 61);
}
#[tokio::test]
async fn completed_chat_is_charged_when_output_dlp_or_evaluator_blocks() {
    for evaluator in [false, true] {
        let (state, provider) = fixture(|config| {
            config.routing.smart_routing.enabled = false;
            config.firewall.enabled = !evaluator;
            config.firewall.policy = FirewallPolicy::Block;
            if evaluator {
                let mut ev = EvaluatorRegistry::new().get("pii_leakage").unwrap().clone();
                ev.target = EvaluatorTarget::Output;
                config.custom_evaluators.push(ev);
                config
                    .firewall
                    .evaluators
                    .push(crate::evaluators::EvaluatorBinding {
                        id: "pii_leakage".into(),
                        enabled: true,
                        inline_action: Some(FirewallPolicy::Block),
                        offline: None,
                        locked: false,
                    });
            }
        });
        *provider.response_text.lock().unwrap() = Some(if evaluator {
            "private email: alice@example.com".into()
        } else {
            "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD".into()
        });
        let mut events = state.traffic.subscribe();
        assert!(matches!(
            run(state.clone(), ctx(), prompt()).await,
            Err(GatewayError::FirewallBlocked(..))
        ));
        assert_eq!(state.audit.token_usage("sk-test"), 21);
        let mut paid = Vec::new();
        while let Ok(event) = events.try_recv() {
            if event["provider_cost_micro_usd"] == 1000 {
                paid.push(event);
            }
        }
        assert_eq!(paid.len(), 1);
        assert_eq!(paid[0]["input_tokens"], 20);
        assert!(paid[0]["error"].is_string());
        assert_eq!(provider.requests.lock().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn completed_chat_token_overrun_keeps_accounting() {
    let (state, provider) = fixture(|config| {
        config.routing.smart_routing.enabled = false;
        config.rate_limit.tokens_per_minute = Some(10);
    });
    let mut events = state.traffic.subscribe();
    assert!(matches!(
        run(state.clone(), ctx(), prompt()).await,
        Err(GatewayError::RateLimited)
    ));
    assert_eq!(state.audit.token_usage("sk-test"), 21);
    let event = events.try_recv().unwrap();
    assert_eq!(event["provider_cost_micro_usd"], 1000);
    assert_eq!(event["output_tokens"], 1);
    assert!(event["error"].is_string());
    assert_eq!(provider.requests.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn embedding_reserves_input_cost_before_dispatch() {
    let (state, provider) = fixture(|config| {
        config.credits.min_reserve_micro_usd = 1;
        config.control_plane.cost_per_1k_micro_usd = 1_000_000;
    });
    let mut context = ctx();
    context.managed_inference = true;
    context.org_id = Some("org".into());
    context.remaining_budget_micro_usd = Some(50_000);
    let body = embedding_body(EmbeddingOperation::Embed, &"a".repeat(1000));
    assert!(matches!(
        run_embedding(state, context, body, EmbeddingOperation::Embed).await,
        Err(GatewayError::InsufficientCredits)
    ));
    assert!(provider.requests.lock().unwrap().is_empty());
}
#[tokio::test]
async fn streaming_dlp_preserves_actual_usage_when_client_frames_are_replaced() {
    for policy in [FirewallPolicy::Block, FirewallPolicy::Sanitize] {
        let (state, provider) = fixture(|config| {
            config.routing.smart_routing.enabled = false;
            config.firewall.enabled = true;
            config.firewall.policy = policy.clone();
        });
        let secret = "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD";
        *provider.response_text.lock().unwrap() = Some(secret.into());
        let mut events = state.traffic.subscribe();
        let output = run_stream(state.clone(), ctx(), prompt()).await.unwrap();
        let bytes = axum::body::to_bytes(output.body, 1024 * 1024)
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains(secret));
        assert_eq!(state.audit.token_usage("sk-test"), 30);
        let mut published = Vec::new();
        while let Ok(event) = events.try_recv() {
            published.push(event);
        }
        // A block also publishes its guardrail verdict row; only the
        // usage row settles.
        let (verdicts, usage): (Vec<_>, Vec<_>) = published
            .into_iter()
            .partition(|event| event["kind"] == "verdict");
        assert_eq!(
            verdicts.len(),
            usize::from(policy == FirewallPolicy::Block),
            "{verdicts:?}"
        );
        for verdict in &verdicts {
            assert_eq!(verdict["verdict"]["action"], "block");
            assert_eq!(verdict["verdict"]["decided_by"], "node");
        }
        assert_eq!(
            usage.len(),
            1,
            "EOF plus Drop must not duplicate settlement"
        );
        let event = &usage[0];
        assert_eq!(event["input_tokens"], 20);
        assert_eq!(event["output_tokens"], 10);
        assert_eq!(event["provider_cost_micro_usd"], 2000);
    }
}
#[tokio::test]
async fn dropped_stream_settles_received_work_once_and_marks_estimates() {
    use futures_util::StreamExt;
    let (state, _) = fixture(|_| {});
    let mut events = state.traffic.subscribe();
    let chunk = format!(
        "data: {}\n\n",
        json!({"choices":[{"delta":{"content":"received output"}}]})
    );
    let chunks = futures_util::stream::once(async move {
        Ok::<_, std::io::Error>(axum::body::Bytes::from(chunk))
    })
    .chain(futures_util::stream::pending());
    let observed = attach_stream_observer(
        Body::from_stream(chunks),
        state.clone(),
        ctx(),
        "openai".into(),
        "test".into(),
        ryu_gw_providers::PromptCacheOutcome::Disabled,
        7,
        Instant::now(),
        None,
        None,
    );
    let mut stream = observed.into_data_stream();
    assert!(stream.next().await.unwrap().is_ok());
    drop(stream);
    let event = events.try_recv().unwrap();
    assert_eq!(event["input_tokens"], 7);
    assert!(event["output_tokens"].as_u64().unwrap() > 0);
    assert!(event["error"].as_str().unwrap().contains("estimated"));
    assert_eq!(
        state.audit.token_usage("sk-test"),
        event["input_tokens"].as_u64().unwrap() + event["output_tokens"].as_u64().unwrap()
    );
    assert!(events.try_recv().is_err());
}
fn user_budget(config: &mut GatewayConfig, limit: u64) {
    config.budgets.users.insert(
        "user".into(),
        serde_json::from_value(json!({ "limit": limit })).unwrap(),
    );
}
fn user_budget_exceeded(state: &AppState) -> bool {
    state
        .with_budget(|budget| budget.evaluate_charge(Some("user"), None, BudgetChargeKind::Model))
        .is_some()
}
#[tokio::test]
async fn client_hang_up_mid_stream_debits_the_received_work_once() {
    use futures_util::StreamExt;
    let control_plane = DebitFixture::start().await;
    let (state, _) = fixture(|config| {
        control_plane.meter(config);
        user_budget(config, 2_000);
    });
    let mut context = managed_ctx("req-hang-up");
    context.user_id = Some("user".into());
    let reservation = state.wallet.try_reserve("org", 5_000, 1_000_000);
    assert_eq!(state.wallet.in_flight_micro_usd("org"), 5_000);
    // 16 generated characters, then the upstream would keep going.
    let chunk = format!(
        "data: {}\n\n",
        json!({"choices":[{"delta":{"content":"0123456789abcdef"}}]})
    );
    let chunks = futures_util::stream::once(async move {
        Ok::<_, std::io::Error>(axum::body::Bytes::from(chunk))
    })
    .chain(futures_util::stream::pending());
    let observed = attach_stream_observer(
        Body::from_stream(chunks),
        state.clone(),
        context,
        "openai".into(),
        "test".into(),
        ryu_gw_providers::PromptCacheOutcome::Disabled,
        1_000,
        Instant::now(),
        None,
        reservation,
    );
    let mut stream = observed.into_data_stream();
    assert!(stream.next().await.unwrap().is_ok());
    assert!(!user_budget_exceeded(&state));
    // The client disconnects: hyper drops the body mid-stream.
    drop(stream);

    assert!(
        user_budget_exceeded(&state),
        "budget counters advance on hang-up"
    );
    let debits = control_plane.wait_for(1).await;
    assert_eq!(debits.len(), 1, "exactly one debit: {debits:?}");
    let debit = &debits[0];
    assert_eq!(debit["reason"], "gateway_usage");
    assert_eq!(debit["refId"], "req-hang-up");
    assert_eq!(debit["orgId"], "org");
    assert_eq!(debit["inputTokens"], 1_000);
    assert_eq!(debit["outputTokens"], 4);
    // (1_000 estimated prompt + 4 estimated output) tokens at the flat
    // 2_000 micro-USD per 1k fallback.
    assert_eq!(debit["amountMicroUsd"], 2_008);
    assert_eq!(debit["estimated"], true);
    assert_eq!(
        state.wallet.in_flight_micro_usd("org"),
        0,
        "the credit claim is released once the debit resolves"
    );
    assert!(!state.wallet.is_org_accounting_unavailable("org"));
}
#[tokio::test]
async fn completed_stream_debits_reported_cost_once_and_keeps_usage_on() {
    let control_plane = DebitFixture::start().await;
    let (state, provider) = fixture(|config| {
        control_plane.meter(config);
        config.routing.smart_routing.enabled = false;
        // Even with the eval default off, a metered stream asks for usage.
        config.evals.stream_usage = false;
    });
    let mut body = prompt();
    body["stream"] = json!(true);
    body["stream_options"] = json!({"include_usage": false});
    let output = run_stream(state.clone(), managed_ctx("req-complete"), body)
        .await
        .unwrap();
    axum::body::to_bytes(output.body, 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(
        provider.requests.lock().unwrap()[0]["stream_options"]["include_usage"],
        true,
        "a client opt-out must not switch off the billed usage frame"
    );
    let debits = control_plane.wait_for(1).await;
    assert_eq!(
        debits.len(),
        1,
        "EOF plus Drop must not debit twice: {debits:?}"
    );
    let debit = &debits[0];
    assert_eq!(debit["reason"], "gateway_usage");
    assert_eq!(debit["refId"], "req-complete");
    assert_eq!(debit["inputTokens"], 20);
    assert_eq!(debit["outputTokens"], 10);
    // The provider-reported $0.002, not a token estimate.
    assert_eq!(debit["amountMicroUsd"], 2_000);
    assert_eq!(debit["estimated"], false);
}
#[tokio::test]
async fn usage_less_stream_bills_estimated_output_instead_of_zero() {
    let control_plane = DebitFixture::start().await;
    let (state, _) = fixture(|config| control_plane.meter(config));
    let mut events = state.traffic.subscribe();
    // A provider that ignored include_usage: content, then [DONE].
    let sse = format!(
        "data: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"delta":{"content":"abcdefgh"}}]})
    );
    let observed = attach_stream_observer(
        Body::from(sse),
        state.clone(),
        managed_ctx("req-no-usage"),
        "openai".into(),
        "test".into(),
        ryu_gw_providers::PromptCacheOutcome::Disabled,
        10,
        Instant::now(),
        None,
        None,
    );
    axum::body::to_bytes(observed, 1024 * 1024).await.unwrap();
    let event = events.try_recv().unwrap();
    assert_eq!(event["input_tokens"], 10);
    assert_eq!(event["output_tokens"], 2);
    let debits = control_plane.wait_for(1).await;
    assert_eq!(debits.len(), 1, "{debits:?}");
    assert_eq!(debits[0]["outputTokens"], 2);
    // (10 + 2) tokens at the flat 2_000 micro-USD per 1k fallback.
    assert_eq!(debits[0]["amountMicroUsd"], 24);
    assert_eq!(debits[0]["estimated"], true);
}
/// An `openai` stand-in whose buffered completion waits for a release
/// signal, so a test can drop the caller while the provider is working.
struct GatedProvider {
    started: Arc<tokio::sync::Notify>,
    release: tokio::sync::watch::Receiver<bool>,
}
impl Provider for GatedProvider {
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
        self.started.notify_one();
        let mut release = self.release.clone();
        Box::pin(async move {
            while !*release.borrow() {
                if release.changed().await.is_err() {
                    break;
                }
            }
            Ok(json!({
                "choices": [{"message": {"content": "done"}}],
                "usage": {"prompt_tokens": 20, "completion_tokens": 5, "cost": 0.003}
            }))
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
        Box::pin(async { Ok(Body::empty()) })
    }
}
#[tokio::test]
async fn client_hang_up_during_a_buffered_call_still_settles_and_debits() {
    let control_plane = DebitFixture::start().await;
    let (mut state, _) = fixture(|config| {
        control_plane.meter(config);
        config.routing.smart_routing.enabled = false;
    });
    let started = Arc::new(tokio::sync::Notify::new());
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    Arc::get_mut(&mut state)
        .unwrap()
        .provider_runtime
        .register_for_test(Arc::new(GatedProvider {
            started: Arc::clone(&started),
            release: release_rx,
        }));
    let mut events = state.traffic.subscribe();

    let handler = tokio::spawn(super::super::run(
        state.clone(),
        managed_ctx("req-client-timeout"),
        prompt(),
    ));
    started.notified().await;
    // The client times out: hyper drops the handler future mid-call.
    handler.abort();
    assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
    release_tx.send(true).unwrap();

    let debits = control_plane.wait_for(1).await;
    assert_eq!(debits.len(), 1, "accepted work is billed: {debits:?}");
    assert_eq!(debits[0]["reason"], "gateway_usage");
    assert_eq!(debits[0]["refId"], "req-client-timeout");
    assert_eq!(debits[0]["inputTokens"], 20);
    assert_eq!(debits[0]["outputTokens"], 5);
    // The provider-reported $0.003.
    assert_eq!(debits[0]["amountMicroUsd"], 3_000);
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
        .await
        .expect("the abandoned call is audited")
        .unwrap();
    assert_eq!(event["request_id"], "req-client-timeout");
    assert_eq!(event["provider_cost_micro_usd"], 3_000);
}
#[tokio::test]
async fn unmetered_buffered_call_is_cancelled_with_its_client() {
    // A Desktop's local Gateway bills nothing, so a hang-up keeps
    // cancelling the call: work nobody will read must not hold a local
    // engine slot or queue place.
    let (mut state, _) = fixture(|config| config.routing.smart_routing.enabled = false);
    assert!(!state.config.credits.is_active());
    let started = Arc::new(tokio::sync::Notify::new());
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    Arc::get_mut(&mut state)
        .unwrap()
        .provider_runtime
        .register_for_test(Arc::new(GatedProvider {
            started: Arc::clone(&started),
            release: release_rx,
        }));
    let mut events = state.traffic.subscribe();

    let handler = tokio::spawn(super::super::run(state.clone(), ctx(), prompt()));
    started.notified().await;
    handler.abort();
    assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
    let _ = release_tx.send(true);

    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), events.recv())
            .await
            .is_err(),
        "the cancelled call never completed, so nothing settled"
    );
}
/// An `openai` stand-in whose stream opens only on a release signal, so a
/// test can drop the caller before the first byte.
struct GatedStreamProvider {
    started: Arc<tokio::sync::Notify>,
    release: tokio::sync::watch::Receiver<bool>,
    /// Refuse the stream once released, as after exhausted 5xx retries.
    refuse: bool,
}
impl Provider for GatedStreamProvider {
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
        Box::pin(async {
            Err(ryu_gw_providers::ProviderError::Provider(
                "stream only".into(),
            ))
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
        self.started.notify_one();
        let mut release = self.release.clone();
        let refuse = self.refuse;
        Box::pin(async move {
            while !*release.borrow() {
                if release.changed().await.is_err() {
                    break;
                }
            }
            if refuse {
                return Err(ryu_gw_providers::ProviderError::Provider(
                    "openai error 503 after 3 retries".into(),
                ));
            }
            let delta = json!({"choices":[{"delta":{"content":"late"}}]});
            Ok(Body::from(format!("data: {delta}\n\ndata: [DONE]\n\n")))
        })
    }
}
fn gated_stream(
    state: &mut Arc<AppState>,
    refuse: bool,
) -> (Arc<tokio::sync::Notify>, tokio::sync::watch::Sender<bool>) {
    let started = Arc::new(tokio::sync::Notify::new());
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    Arc::get_mut(state)
        .unwrap()
        .provider_runtime
        .register_for_test(Arc::new(GatedStreamProvider {
            started: Arc::clone(&started),
            release: release_rx,
            refuse,
        }));
    (started, release_tx)
}
#[tokio::test]
async fn client_hang_up_before_the_first_byte_bills_the_accepted_prompt() {
    let control_plane = DebitFixture::start().await;
    let (mut state, _) = fixture(|config| {
        control_plane.meter(config);
        config.routing.smart_routing.enabled = false;
    });
    let (started, release) = gated_stream(&mut state, false);
    let mut events = state.traffic.subscribe();
    let mut context = managed_ctx("req-before-first-byte");
    context.remaining_budget_micro_usd = Some(1_000_000);
    let body = json!({"model":"test","messages":[{"role":"user","content":"a".repeat(4_000)}]});
    assert_eq!(super::super::estimate_prompt_tokens(&body), 1_000);

    let handler = tokio::spawn(super::super::run_stream(state.clone(), context, body));
    started.notified().await;
    assert!(
        state.wallet.in_flight_micro_usd("org") > 0,
        "the stream holds a claim"
    );
    // The client hangs up while the provider is still opening the stream.
    handler.abort();
    assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
    // Nothing is decided until the provider answers.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(control_plane.debits.lock().unwrap().is_empty());
    assert!(state.wallet.in_flight_micro_usd("org") > 0, "still held");
    // The provider accepts the prompt.
    release.send(true).unwrap();

    let debits = control_plane.wait_for(1).await;
    assert_eq!(
        debits.len(),
        1,
        "the accepted prompt is billed once: {debits:?}"
    );
    let debit = &debits[0];
    assert_eq!(debit["reason"], "gateway_usage");
    assert_eq!(debit["refId"], "req-before-first-byte");
    assert_eq!(debit["inputTokens"], 1_000);
    assert_eq!(debit["outputTokens"], 0);
    // 1_000 estimated prompt tokens at the flat 2_000 micro-USD per 1k.
    assert_eq!(debit["amountMicroUsd"], 2_000);
    assert_eq!(debit["estimated"], true);
    assert_eq!(state.wallet.in_flight_micro_usd("org"), 0);
    let event = events.try_recv().expect("the hang-up is audited");
    assert_eq!(event["input_tokens"], 1_000);
    assert!(event["error"]
        .as_str()
        .unwrap()
        .contains("before the first byte"));
    assert!(events.try_recv().is_err());
}
#[tokio::test]
async fn a_stream_the_provider_refuses_after_a_hang_up_costs_nothing() {
    let control_plane = DebitFixture::start().await;
    let (mut state, _) = fixture(|config| {
        control_plane.meter(config);
        config.routing.smart_routing.enabled = false;
    });
    let (started, release) = gated_stream(&mut state, true);
    let mut events = state.traffic.subscribe();
    let mut context = managed_ctx("req-refused");
    context.remaining_budget_micro_usd = Some(1_000_000);
    let handler = tokio::spawn(super::super::run_stream(state.clone(), context, prompt()));
    started.notified().await;
    handler.abort();
    assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
    assert!(
        state.wallet.in_flight_micro_usd("org") > 0,
        "held until it resolves"
    );
    // The provider gives up: it never accepted the prompt.
    release.send(true).unwrap();

    for _ in 0..200 {
        if state.wallet.in_flight_micro_usd("org") == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(state.wallet.in_flight_micro_usd("org"), 0, "claim released");
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(
        control_plane.debits.lock().unwrap().is_empty(),
        "nothing charged"
    );
    assert!(events.try_recv().is_err(), "nothing was served or settled");
}
#[tokio::test]
async fn unmetered_stream_hang_up_before_the_first_byte_records_nothing() {
    let (mut state, _) = fixture(|config| config.routing.smart_routing.enabled = false);
    let (started, release) = gated_stream(&mut state, false);
    let mut events = state.traffic.subscribe();
    let handler = tokio::spawn(super::super::run_stream(state.clone(), ctx(), prompt()));
    started.notified().await;
    handler.abort();
    assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
    let _ = release.send(true);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), events.recv())
            .await
            .is_err(),
        "an unmetered stream keeps cancel-on-drop"
    );
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
#[tokio::test]
async fn client_hang_up_mid_tool_loop_bills_every_round_once() {
    let control_plane = DebitFixture::start().await;
    let started = Arc::new(tokio::sync::Notify::new());
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    let provider = Arc::new(ScriptedRounds {
        script: vec![
            tool_call_round(100, 10, 0.001),
            answer_round(200, 20, 0.002),
        ],
        calls: AtomicUsize::new(0),
        hold: Some((1, Arc::clone(&started), release_rx)),
    });
    let state = tool_loop_fixture(&control_plane, Arc::clone(&provider));
    let mut events = state.traffic.subscribe();

    let handler = tokio::spawn(super::super::run_stream(
        state.clone(),
        tool_ctx("req-tool-hang-up"),
        prompt(),
    ));
    // The first round is answered; the provider is working on the second.
    started.notified().await;
    handler.abort();
    assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
    assert!(
        state.wallet.in_flight_micro_usd("org") > 0,
        "held until settled"
    );
    release_tx.send(true).unwrap();

    let debits = control_plane.wait_for(1).await;
    assert_eq!(debits.len(), 1, "one debit for the whole loop: {debits:?}");
    let debit = &debits[0];
    assert_eq!(debit["reason"], "gateway_usage");
    assert_eq!(debit["refId"], "req-tool-hang-up");
    // Both rounds: the answered one and the one the hang-up interrupted.
    assert_eq!(debit["inputTokens"], 300);
    assert_eq!(debit["outputTokens"], 30);
    // The provider-reported $0.001 + $0.002.
    assert_eq!(debit["amountMicroUsd"], 3_000);
    assert_eq!(debit["estimated"], false);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2, "the loop stopped");
    assert_eq!(state.wallet.in_flight_micro_usd("org"), 0);
    let event = tokio::time::timeout(std::time::Duration::from_secs(2), events.recv())
        .await
        .expect("the abandoned loop is audited")
        .unwrap();
    assert_eq!(event["input_tokens"], 300);
    assert_eq!(event["provider_cost_micro_usd"], 3_000);
    assert!(event["error"].as_str().unwrap().contains("tool loop"));
}
#[tokio::test]
async fn a_tool_loop_is_billed_for_every_round_it_ran() {
    for stream in [true, false] {
        let control_plane = DebitFixture::start().await;
        let provider = Arc::new(ScriptedRounds {
            script: vec![
                tool_call_round(100, 10, 0.001),
                answer_round(200, 20, 0.002),
            ],
            calls: AtomicUsize::new(0),
            hold: None,
        });
        let state = tool_loop_fixture(&control_plane, Arc::clone(&provider));
        let request_id = if stream {
            "req-tool-stream"
        } else {
            "req-tool-buffered"
        };
        if stream {
            let output = super::super::run_stream(state.clone(), tool_ctx(request_id), prompt())
                .await
                .unwrap();
            let bytes = axum::body::to_bytes(output.body, 1024 * 1024)
                .await
                .unwrap();
            let text = String::from_utf8_lossy(&bytes);
            assert!(text.contains("done"), "{text}");
            // The client still sees the final round's own usage.
            assert!(text.contains(r#""prompt_tokens":200"#), "{text}");
        } else {
            let output = super::super::run(state.clone(), tool_ctx(request_id), prompt())
                .await
                .unwrap();
            assert_eq!(output.response["usage"]["prompt_tokens"], 200);
            assert_eq!(output.response["usage"]["completion_tokens"], 20);
        }
        let debits = control_plane.wait_for(1).await;
        assert_eq!(debits.len(), 1, "stream={stream}: {debits:?}");
        let debit = &debits[0];
        assert_eq!(debit["refId"], request_id);
        assert_eq!(debit["inputTokens"], 300, "stream={stream}");
        assert_eq!(debit["outputTokens"], 30, "stream={stream}");
        assert_eq!(debit["amountMicroUsd"], 3_000, "stream={stream}");
        assert_eq!(debit["estimated"], false, "stream={stream}");
        assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
        assert_eq!(state.wallet.in_flight_micro_usd("org"), 0);
    }
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
#[tokio::test]
async fn client_hang_up_mid_buffered_tool_loop_stops_the_tools_and_bills_the_rounds() {
    for hang_up in [true, false] {
        let control_plane = DebitFixture::start().await;
        let started = Arc::new(tokio::sync::Notify::new());
        let (release_tx, release_rx) = tokio::sync::watch::channel(false);
        let provider = Arc::new(ScriptedRounds {
            script: vec![
                tool_call_round_named("notes_append", 100, 10, 0.001),
                tool_call_round_named("notes_append", 200, 20, 0.002),
                answer_round(300, 30, 0.003),
            ],
            calls: AtomicUsize::new(0),
            hold: hang_up.then(|| (1, Arc::clone(&started), release_rx)),
        });
        let mut state = tool_loop_fixture(&control_plane, Arc::clone(&provider));
        let (catalog, tool_calls, server) = counting_tool_catalog().await;
        Arc::get_mut(&mut state).unwrap().tools = Some(crate::tools::ToolSearchClient::new(
            &crate::config::CoreProviderConfig {
                base_url: catalog,
                token: None,
            },
            state.http.clone(),
        ));
        let mut context = tool_ctx("req-buffered-loop");
        context.tool_actions = Some("notes_append".into());

        let handler = tokio::spawn(super::super::run(state.clone(), context, prompt()));
        if hang_up {
            // The first round ran its tool; the provider is working on the
            // second, which will ask for the tool again.
            started.notified().await;
            assert_eq!(tool_calls.load(Ordering::SeqCst), 1);
            handler.abort();
            assert!(matches!(handler.await, Err(error) if error.is_cancelled()));
            assert!(
                state.wallet.in_flight_micro_usd("org") > 0,
                "held until settled"
            );
            release_tx.send(true).unwrap();
        } else {
            let output = handler.await.unwrap().unwrap();
            assert_eq!(output.response["choices"][0]["message"]["content"], "done");
        }

        let debits = control_plane.wait_for(1).await;
        assert_eq!(debits.len(), 1, "hang_up={hang_up}: {debits:?}");
        let debit = &debits[0];
        assert_eq!(debit["reason"], "gateway_usage");
        assert_eq!(debit["refId"], "req-buffered-loop");
        assert_eq!(debit["estimated"], false);
        if hang_up {
            // The answered round and the in-flight one, from their real
            // usage; the loop stopped there.
            assert_eq!(debit["inputTokens"], 300);
            assert_eq!(debit["outputTokens"], 30);
            assert_eq!(debit["amountMicroUsd"], 3_000);
            assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
            assert_eq!(tool_calls.load(Ordering::SeqCst), 1, "no tool ran after it");
        } else {
            assert_eq!(debit["inputTokens"], 600);
            assert_eq!(debit["outputTokens"], 60);
            assert_eq!(debit["amountMicroUsd"], 6_000);
            assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
            assert_eq!(tool_calls.load(Ordering::SeqCst), 2);
        }
        assert_eq!(state.wallet.in_flight_micro_usd("org"), 0, "claim released");
        server.abort();
    }
}
#[tokio::test]
async fn a_round_still_running_at_the_pool_deadline_is_billed_once_it_answers() {
    use super::super::tool_rounds::{MeteredRounds, ToolRoundLedger};
    let control_plane = DebitFixture::start().await;
    let (state, _) = fixture(|config| control_plane.meter(config));
    let started = Arc::new(tokio::sync::Notify::new());
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    let provider = Arc::new(ScriptedRounds {
        script: vec![
            tool_call_round(100, 10, 0.001),
            tool_call_round(200, 20, 0.002),
        ],
        calls: AtomicUsize::new(0),
        hold: Some((1, Arc::clone(&started), release_rx)),
    });
    // The metered loop's provider, as `run_attached` builds it.
    let ledger = Arc::new(ToolRoundLedger::default());
    let rounds = MeteredRounds::new(provider.clone(), Arc::clone(&ledger), true);
    let body = prompt();
    rounds.complete("test", &body).await.unwrap();
    // The second round is in flight when the pool deadline drops the loop.
    let cut_off = tokio::time::timeout(
        std::time::Duration::from_millis(50),
        rounds.complete("test", &body),
    )
    .await;
    assert!(cut_off.is_err(), "the deadline cut the loop off");
    started.notified().await;
    let claim = state.wallet.try_reserve("org", 50_000, 1_000_000);

    super::super::settle_timed_out_tool_rounds(
        &state,
        &managed_ctx("req-pool-deadline"),
        0,
        &ledger,
        "openai",
        "test",
        None,
        Instant::now(),
        claim,
    );
    // Nothing is billed while the round runs; the claim stays held.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(control_plane.debits.lock().unwrap().is_empty());
    assert_eq!(state.wallet.in_flight_micro_usd("org"), 50_000);
    // The provider answers the late round.
    release_tx.send(true).unwrap();

    let debits = control_plane.wait_for(1).await;
    assert_eq!(debits.len(), 1, "every round, billed once: {debits:?}");
    let debit = &debits[0];
    assert_eq!(debit["refId"], "req-pool-deadline:attempt-0");
    // The answered round plus the late one, from its real usage.
    assert_eq!(debit["inputTokens"], 300);
    assert_eq!(debit["outputTokens"], 30);
    assert_eq!(debit["amountMicroUsd"], 3_000);
    assert_eq!(debit["estimated"], false);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    assert_eq!(state.wallet.in_flight_micro_usd("org"), 0, "claim released");
}
#[tokio::test]
async fn the_token_limit_judges_the_answering_round_not_the_whole_loop() {
    // 135 + 15 tokens over three rounds against a 100 tokens/minute limit:
    // the answering round (55) fits, as it did before rounds were billed.
    // Refusing the sum would 429 a request whose tools already ran and
    // were paid for, and the client's retry would pay for them again.
    let control_plane = DebitFixture::start().await;
    let provider = Arc::new(ScriptedRounds {
        script: vec![
            tool_call_round(40, 5, 0.001),
            tool_call_round(45, 5, 0.001),
            answer_round(50, 5, 0.001),
        ],
        calls: AtomicUsize::new(0),
        hold: None,
    });
    let state = tool_loop_fixture_with(&control_plane, Arc::clone(&provider), |config| {
        config.rate_limit.tokens_per_minute = Some(100);
    });
    let output = super::super::run(state.clone(), tool_ctx("req-tpm"), prompt())
        .await
        .expect("the answering round is within the limit");
    assert_eq!(output.response["usage"]["prompt_tokens"], 50);
    let debits = control_plane.wait_for(1).await;
    assert_eq!(debits.len(), 1, "{debits:?}");
    assert_eq!(debits[0]["refId"], "req-tpm");
    assert_eq!(debits[0]["inputTokens"], 135);
    assert_eq!(debits[0]["outputTokens"], 15);
    assert_eq!(debits[0]["amountMicroUsd"], 3_000);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 3);
    // The earlier rounds still count: the bucket is spent for now.
    assert!(!state.rate_limiter.check_tokens_for_key("sk-test", 1, None));
}
#[tokio::test]
async fn rounds_before_a_failed_tool_round_are_billed_under_their_attempt_ref() {
    for stream in [true, false] {
        let control_plane = DebitFixture::start().await;
        let provider = Arc::new(ScriptedRounds {
            script: vec![
                tool_call_round(100, 10, 0.001),
                Err("upstream failed".to_owned()),
            ],
            calls: AtomicUsize::new(0),
            hold: None,
        });
        let state = tool_loop_fixture(&control_plane, Arc::clone(&provider));
        let request_id = if stream {
            "req-loop-fails-stream"
        } else {
            "req-loop-fails"
        };
        let failed = if stream {
            super::super::run_stream(state.clone(), tool_ctx(request_id), prompt())
                .await
                .is_err()
        } else {
            super::super::run(state.clone(), tool_ctx(request_id), prompt())
                .await
                .is_err()
        };
        assert!(failed, "stream={stream}");
        let debits = control_plane.wait_for(1).await;
        assert_eq!(debits.len(), 1, "stream={stream}: {debits:?}");
        let debit = &debits[0];
        // Its own ref: a fallback attempt that succeeded would debit the
        // request id, and must not be deduplicated against this charge.
        assert_eq!(debit["refId"], format!("{request_id}:attempt-0"));
        assert_eq!(debit["inputTokens"], 100, "stream={stream}");
        assert_eq!(debit["outputTokens"], 10, "stream={stream}");
        assert_eq!(debit["amountMicroUsd"], 1_000, "stream={stream}");
        assert_eq!(debit["estimated"], false, "stream={stream}");
        assert_eq!(state.wallet.in_flight_micro_usd("org"), 0);
    }
}
#[tokio::test]
async fn never_polled_stream_still_records_dispatched_prompt_on_drop() {
    let (state, _) = fixture(|_| {});
    let mut events = state.traffic.subscribe();
    let body = attach_stream_observer(
        Body::empty(),
        state.clone(),
        ctx(),
        "openai".into(),
        "test".into(),
        ryu_gw_providers::PromptCacheOutcome::Disabled,
        9,
        Instant::now(),
        None,
        None,
    );
    drop(body);
    let event = events.try_recv().unwrap();
    assert_eq!(event["input_tokens"], 9);
    assert!(event["error"].is_string());
    assert!(events.try_recv().is_err());
}
#[tokio::test]
async fn oversized_stream_aborts_without_serving_unscanned_output() {
    let (state, provider) = fixture(|config| {
        config.routing.smart_routing.enabled = false;
        config.firewall.enabled = true;
        config.firewall.policy = FirewallPolicy::Block;
    });
    *provider.response_text.lock().unwrap() = Some("a".repeat(MAX_PROVIDER_STREAM_BYTES + 1));
    let mut events = state.traffic.subscribe();
    let output = run_stream(state.clone(), ctx(), prompt()).await.unwrap();
    let bytes = axum::body::to_bytes(output.body, 4096).await.unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("Unable to scan"));
    assert!(!text.contains(&"a".repeat(1000)));
    let event = events.try_recv().unwrap();
    assert!(event["error"].as_str().unwrap().contains("8 MiB"));
    assert!(state.audit.token_usage("sk-test") > 0);
}
struct LocalRecording(Arc<RecordingProvider>);
impl Provider for LocalRecording {
    fn name(&self) -> &'static str {
        "local"
    }
    fn complete<'a>(
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
        self.0.complete(model, body)
    }
    fn complete_stream<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Body, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        self.0.complete_stream(model, body)
    }
}
struct BlockingLocal {
    calls: Arc<AtomicUsize>,
    started: Arc<tokio::sync::Notify>,
    release: tokio::sync::watch::Receiver<bool>,
}

impl Provider for BlockingLocal {
    fn name(&self) -> &'static str {
        "local"
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
        Box::pin(async {
            Ok(json!({
                "choices": [{"message": {"content": "judge"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1}
            }))
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
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.started.notify_one();
        let mut release = self.release.clone();
        Box::pin(async move {
            let chunk = futures_util::stream::once(async move {
                while !*release.borrow() {
                    if release.changed().await.is_err() {
                        return Err(std::io::Error::other("release signal dropped"));
                    }
                }
                Ok::<_, std::io::Error>(axum::body::Bytes::from(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"alice@example.com\"}}]}\n\n",
                ))
            });
            Ok(Body::from_stream(chunk))
        })
    }
}

#[tokio::test]
async fn deterministic_output_guardrail_keeps_local_stream_admission_bounded() {
    let calls = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(tokio::sync::Notify::new());
    let (release_tx, release_rx) = tokio::sync::watch::channel(false);
    let mut config = GatewayConfig::default();
    config.routing.default_provider = ProviderId::from("local");
    config.routing.fallback_chain = vec![ProviderId::from("local")];
    config.routing.smart_routing.enabled = false;
    config.concurrency.enabled = true;
    config.concurrency.local_max_in_flight = 1;
    config.concurrency.local_max_queued = 0;
    config.firewall.enabled = false;
    config
        .firewall
        .evaluators
        .push(crate::evaluators::EvaluatorBinding {
            id: "pii_leakage".into(),
            enabled: true,
            inline_action: Some(FirewallPolicy::Sanitize),
            offline: None,
            locked: false,
        });
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
    state
        .provider_runtime
        .register_for_test(Arc::new(BlockingLocal {
            calls: Arc::clone(&calls),
            started: Arc::clone(&started),
            release: release_rx,
        }));
    let state = Arc::new(state);

    let first = tokio::spawn(run_stream(Arc::clone(&state), ctx(), prompt()));
    started.notified().await;
    assert_eq!(
        state
            .admission
            .snapshots()
            .into_iter()
            .find(|snapshot| snapshot.provider == "local")
            .map(|snapshot| snapshot.in_flight),
        Some(1)
    );

    let second = tokio::spawn(run_stream(Arc::clone(&state), ctx(), prompt()));
    let second_result = tokio::time::timeout(std::time::Duration::from_secs(1), second)
        .await
        .expect("the second request should be rejected by the zero-length queue")
        .expect("the second request task should finish");
    assert!(matches!(second_result, Err(GatewayError::Overloaded(_))));
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    release_tx.send(true).unwrap();
    let first_output = first
        .await
        .expect("the first request task should finish")
        .expect("the first request should complete after the upstream releases");
    axum::body::to_bytes(first_output.body, 1024 * 1024)
        .await
        .unwrap();
}

#[tokio::test]
async fn output_judge_reuses_single_local_engine_slot_after_generation_finishes() {
    for stream in [false, true] {
        let (mut state, provider) = fixture(|config| {
            config.routing.default_provider = ProviderId::from("local");
            config.routing.fallback_chain = vec![ProviderId::from("local")];
            config.routing.smart_routing.enabled = false;
            config.concurrency.enabled = true;
            config.concurrency.local_max_in_flight = 1;
            config.concurrency.local_max_queued = 0;
            config.firewall.inspector.model = "test".into();
            let mut ev = EvaluatorRegistry::new().get("toxicity").unwrap().clone();
            ev.target = EvaluatorTarget::Output;
            config.custom_evaluators.push(ev);
            config
                .firewall
                .evaluators
                .push(crate::evaluators::EvaluatorBinding {
                    id: "toxicity".into(),
                    enabled: true,
                    inline_action: Some(FirewallPolicy::Block),
                    offline: None,
                    locked: false,
                });
        });
        Arc::get_mut(&mut state)
            .unwrap()
            .provider_runtime
            .register_for_test(Arc::new(LocalRecording(provider.clone())));
        let run = async {
            if stream {
                let output = run_stream(state, ctx(), prompt()).await?;
                axum::body::to_bytes(output.body, 1024 * 1024)
                    .await
                    .unwrap();
                Ok(())
            } else {
                super::super::run(state, ctx(), prompt()).await.map(|_| ())
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(1), run)
            .await
            .expect("output judge must not deadlock")
            .expect("output judge must receive released slot");
        assert_eq!(provider.requests.lock().unwrap().len(), 2);
    }
}
