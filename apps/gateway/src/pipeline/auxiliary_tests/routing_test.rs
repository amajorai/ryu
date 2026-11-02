//! Debit reasons, routing denials and agent model pools on auxiliary work.

use super::*;

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
