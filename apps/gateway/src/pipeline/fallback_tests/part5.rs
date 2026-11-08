use super::*;

#[tokio::test]
async fn run_stream_retries_a_pool_member_with_its_own_model() {
    use super::super::run_stream;
    use crate::config::{
        ModelMapping, ProviderPoolConfig, ProviderPoolMemberConfig, ProviderPoolStrategy,
    };

    let mut config = GatewayConfig::default();
    config.firewall.enabled = false;
    config.routing.model_map.insert(
        "balanced-chat".to_owned(),
        ModelMapping {
            provider: ProviderId::from("pool:balanced"),
            provider_model: None,
        },
    );
    config.routing.provider_pools.insert(
        "balanced".to_owned(),
        ProviderPoolConfig {
            strategy: ProviderPoolStrategy::Priority,
            sticky_limit: 1,
            wait_for_cooldown_ms: 0,
            members: vec![
                ProviderPoolMemberConfig {
                    provider: ProviderId::from("primary"),
                    model: "first-model".to_owned(),
                    priority: 0,
                    weight: 1,
                    enabled: true,
                    last_resort: false,
                    context_tokens: None,
                },
                ProviderPoolMemberConfig {
                    provider: ProviderId::from("secondary"),
                    model: "second-model".to_owned(),
                    priority: 1,
                    weight: 1,
                    enabled: true,
                    last_resort: false,
                    context_tokens: None,
                },
            ],
            execution: Default::default(),
            judge: None,
            auto_weights: None,
        },
    );
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::RateLimited);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let out = run_stream(
        Arc::clone(&state),
        plain_ctx(),
        json!({"model":"balanced-chat","messages":[{"role":"user","content":"ping"}]}),
    )
    .await
    .expect("secondary pool member streams in the same turn");
    assert_eq!(out.provider_used, "secondary");
    assert_eq!(out.model_used, "second-model");
    assert_eq!(
        out.degraded,
        Some(DegradedMode::Fallback("secondary".to_owned()))
    );
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
    let bytes = axum::body::to_bytes(out.body, usize::MAX).await.unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("[DONE]"));
}

#[tokio::test]
async fn pool_fallback_checks_the_next_members_credit_pool() {
    use crate::config::{
        ModelMapping, ProviderPoolConfig, ProviderPoolMemberConfig, ProviderPoolStrategy,
    };

    let make_state = || {
        let mut config = GatewayConfig::default();
        config.firewall.enabled = false;
        config.credits.reserve_enabled = true;
        config.credits.min_reserve_micro_usd = 10_000;
        config.routing.model_map.insert(
            "balanced-chat".to_owned(),
            ModelMapping {
                provider: ProviderId::from("pool:balanced"),
                provider_model: None,
            },
        );
        config.routing.provider_pools.insert(
            "balanced".to_owned(),
            ProviderPoolConfig {
                strategy: ProviderPoolStrategy::Priority,
                sticky_limit: 1,
                wait_for_cooldown_ms: 0,
                members: [
                    ("cloudflare", "first-model", 0),
                    ("openrouter", "second-model", 1),
                ]
                .into_iter()
                .map(|(provider, model, priority)| ProviderPoolMemberConfig {
                    provider: ProviderId::from(provider),
                    model: model.to_owned(),
                    priority,
                    weight: 1,
                    enabled: true,
                    last_resort: false,
                    context_tokens: None,
                })
                .collect(),
                execution: Default::default(),
                judge: None,
                auto_weights: None,
            },
        );
        let audit = AuditLogger::new(&AuditConfig {
            enabled: false,
            db_path: String::new(),
        })
        .unwrap();
        let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
        let mut state = AppState::new_for_test(config, audit, evals);
        let (primary, primary_calls) = StubProvider::new("cloudflare", Mode::RateLimited);
        let (secondary, secondary_calls) = StubProvider::new("openrouter", Mode::Ok);
        state
            .provider_runtime
            .register_for_test(primary as Arc<dyn Provider>);
        state
            .provider_runtime
            .register_for_test(secondary as Arc<dyn Provider>);
        (Arc::new(state), primary_calls, secondary_calls)
    };
    let make_ctx = |retail_credit| {
        let mut ctx = plain_ctx();
        ctx.org_id = Some("o1".to_owned());
        ctx.managed_inference = true;
        ctx.remaining_budget_micro_usd = Some(50_000);
        ctx.unrestricted_budget_micro_usd = Some(0);
        ctx.pool_budgets_micro_usd = std::collections::HashMap::from([
            ("cloudflare".to_owned(), 50_000),
            ("openrouter".to_owned(), retail_credit),
        ]);
        ctx
    };
    let body = json!({"model":"balanced-chat","messages":[{"role":"user","content":"ping"}]});

    let (state, primary_calls, secondary_calls) = make_state();
    let output = run(state, make_ctx(50_000), body.clone())
        .await
        .expect("funded fallback should complete");
    // The secondary (retail) member served it — see the call counts; a
    // managed caller reads it as Ryu Router.
    assert_eq!(output.provider_used, "ryu");
    assert_eq!(output.model_used, "second-model");
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);

    let (state, primary_calls, secondary_calls) = make_state();
    let error = match run(state, make_ctx(0), body).await {
        Err(error) => error,
        Ok(_) => panic!("unfunded fallback must not dispatch"),
    };
    assert!(matches!(error, GatewayError::InsufficientCredits));
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 0);
}

/// Streaming exhaustion: every provider faults, so `run_stream` surfaces the
/// wrapped `AllProvidersUnavailable` error rather than an empty stream.
#[tokio::test]
async fn run_stream_exhausted_chain_errors() {
    use super::super::run_stream;
    let mut state = chain_state(5);
    let (primary, _) = StubProvider::new("primary", Mode::Fail);
    let (secondary, _) = StubProvider::new("secondary", Mode::Fail);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let err = match run_stream(Arc::clone(&state), plain_ctx(), ping_body()).await {
        Err(e) => e,
        Ok(_) => panic!("an exhausted stream chain must error"),
    };
    assert!(matches!(err, GatewayError::AllProvidersUnavailable(_)));
}

/// The per-key request rate limiter gates the pipeline: with a 1-request/min
/// budget the second identical (uncached) request is refused with `RateLimited`
/// before the provider is reached.
#[tokio::test]
async fn per_key_request_rate_limit_rejects_the_second_call() {
    use crate::config::RateLimitConfig;
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        rate_limit: RateLimitConfig {
            enabled: true,
            requests_per_minute: Some(1),
            tokens_per_minute: None,
            max_burst_per_second: 0,
        },
        // Disable the exact cache so the second call actually reaches the limiter
        // rather than being served from cache.
        cache: crate::config::CacheConfig {
            enabled: false,
            ..crate::config::CacheConfig::default()
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let (primary, _) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);

    // First request is within budget.
    run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("first request under the limit");
    // Second request exceeds 1/min ⇒ RateLimited.
    let err = match run(Arc::clone(&state), plain_ctx(), ping_body()).await {
        Err(e) => e,
        Ok(_) => panic!("second request must be rate limited"),
    };
    // The per-key refusal names the 1/min policy that refused it.
    assert!(matches!(
        err,
        GatewayError::RateLimitedBy(ref policy)
            if policy.policy == "requests" && policy.quota == 1 && policy.retry_after_secs == 60
    ));
}

/// Smart routing (Keyword strategy, no network) rewrites the request's model
/// BEFORE provider routing: a rule whose description matches the prompt sends
/// the turn to the rule's target model, which then resolves to the default
/// provider as any hand-picked model would.
#[tokio::test]
async fn smart_routing_keyword_rewrites_the_model() {
    use crate::config::{RouteStrategy, SmartRoutingConfig, SmartRule};
    let mut routing = RoutingConfig {
        default_provider: ProviderId::from("primary"),
        fallback_chain: vec![ProviderId::from("primary")],
        ..RoutingConfig::default()
    };
    routing.smart_routing = SmartRoutingConfig {
        enabled: true,
        strategy: RouteStrategy::Keyword,
        rules: vec![SmartRule {
            description: "ping".to_string(),
            model: "rewritten-model".to_string(),
            weight: 1.0,
        }],
        ..Default::default()
    };
    let config = GatewayConfig {
        routing,
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let out = run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("smart-routed request serves");
    // The model was rewritten by the matching keyword rule.
    assert_eq!(out.model_used, "rewritten-model");
    // ...and still resolved to the default provider.
    assert_eq!(out.provider_used, "primary");
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
}

/// A request that captured the old provider generation may finish after a
/// one-account publication. Its cache write belongs only to the old epoch;
/// a new request must dispatch through the replacement instead of reading
/// that old result from the shared exact cache.
#[tokio::test]
async fn delayed_old_generation_completion_cannot_fill_replacement_cache() {
    let mut state = chain_state(5);
    let (old_provider, old_calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(old_provider as Arc<dyn Provider>);
    let old_snapshot = state.provider_runtime.snapshot();
    let (replacement, replacement_calls) = StubProvider::new("primary", Mode::Ok);
    let replacement_epoch = state
        .provider_runtime
        .publish_for_test(replacement as Arc<dyn Provider>);
    assert_ne!(old_snapshot.epoch, replacement_epoch);
    let state = Arc::new(state);

    let mut delayed_ctx = plain_ctx();
    delayed_ctx.provider_snapshot = Some(old_snapshot);
    let delayed = run(Arc::clone(&state), delayed_ctx, ping_body())
        .await
        .expect("captured old generation completes after publication");
    assert!(!delayed.cache_hit);
    assert_eq!(old_calls.load(Ordering::SeqCst), 1);

    let current = run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("replacement generation dispatches");
    assert!(
        !current.cache_hit,
        "old epoch entry cannot satisfy new work"
    );
    assert_eq!(replacement_calls.load(Ordering::SeqCst), 1);
}

/// Outbound firewall: a provider response carrying a secret is blocked on the
/// egress path when the policy is `Block`, so the leaked secret never reaches
/// the client (`FirewallBlocked`).
#[tokio::test]
async fn outbound_firewall_block_stops_a_leaked_secret_response() {
    use crate::config::FirewallPolicy;

    // A provider that leaks a secret in its completion content.
    struct LeakyProvider;
    impl Provider for LeakyProvider {
        fn name(&self) -> &'static str {
            "primary"
        }
        fn complete<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a serde_json::Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<serde_json::Value, ryu_gw_providers::ProviderError>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                Ok(json!({
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": "here is a key sk-abcdefghijklmnopqrstu"},
                        "finish_reason": "stop"
                    }],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 5, "total_tokens": 6}
                }))
            })
        }
        fn complete_stream<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a serde_json::Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                Err(ryu_gw_providers::ProviderError::Provider(
                    "no stream".into(),
                ))
            })
        }
    }

    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("primary"),
            fallback_chain: vec![ProviderId::from("primary")],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: true,
            scan_inbound: false,
            scan_outbound: true,
            policy: FirewallPolicy::Block,
            ..FirewallConfig::default()
        },
        cache: crate::config::CacheConfig {
            enabled: false,
            ..crate::config::CacheConfig::default()
        },
        ..GatewayConfig::default()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    state
        .provider_runtime
        .register_for_test(Arc::new(LeakyProvider) as Arc<dyn Provider>);
    let state = Arc::new(state);

    let err = match run(Arc::clone(&state), plain_ctx(), ping_body()).await {
        Err(e) => e,
        Ok(_) => panic!("a leaked-secret response must be blocked outbound"),
    };
    assert!(
        matches!(err, GatewayError::FirewallBlocked(..)),
        "expected outbound FirewallBlocked, got {err:?}"
    );
}
