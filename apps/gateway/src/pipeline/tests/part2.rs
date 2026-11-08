use super::*;

#[tokio::test]
async fn named_chat_pool_dispatches_each_session_to_its_upstream_model() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };

    struct MockUpstream {
        calls: Mutex<Vec<(String, Value)>>,
        fail_openai: AtomicBool,
    }

    async fn upstream(
        axum::extract::State(state): axum::extract::State<Arc<MockUpstream>>,
        uri: axum::http::Uri,
        axum::Json(body): axum::Json<Value>,
    ) -> (axum::http::StatusCode, axum::Json<Value>) {
        let path = uri.path().to_owned();
        state.calls.lock().unwrap().push((path.clone(), body));
        if path.ends_with("/messages") {
            (
                axum::http::StatusCode::OK,
                axum::Json(json!({
                    "id":"msg_1",
                    "content":[{"type":"text","text":"from anthropic"}],
                    "stop_reason":"end_turn",
                    "usage":{"input_tokens":2,"output_tokens":2}
                })),
            )
        } else if state.fail_openai.load(Ordering::SeqCst) {
            (
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                axum::Json(json!({"error":{"message":"quota"}})),
            )
        } else {
            (
                axum::http::StatusCode::OK,
                axum::Json(json!({
                    "id":"chatcmpl_1",
                    "object":"chat.completion",
                    "choices":[{"index":0,"message":{"role":"assistant","content":"from openai"},"finish_reason":"stop"}],
                    "usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}
                })),
            )
        }
    }

    let upstream_state = Arc::new(MockUpstream {
        calls: Mutex::new(Vec::new()),
        fail_openai: AtomicBool::new(false),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .fallback(post(upstream))
        .with_state(Arc::clone(&upstream_state));
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let mut config = crate::config::GatewayConfig::default();
    config.providers.openai = Some(crate::config::OpenAiProviderConfig {
        api_key: "openai-test-key".to_owned(),
        api_keys: Vec::new(),
        base_url: format!("{base}/v1"),
    });
    config.providers.anthropic = Some(crate::config::AnthropicProviderConfig {
        api_key: "anthropic-test-key".to_owned(),
        api_keys: Vec::new(),
        base_url: base,
    });
    config.routing.model_map.insert(
        "balanced-chat".to_owned(),
        crate::config::ModelMapping {
            provider: ProviderId::from("pool:balanced"),
            provider_model: None,
        },
    );
    config.routing.provider_pools.insert(
        "balanced".to_owned(),
        crate::config::ProviderPoolConfig {
            strategy: crate::config::ProviderPoolStrategy::RoundRobin,
            sticky_limit: 1,
            wait_for_cooldown_ms: 0,
            members: vec![
                crate::config::ProviderPoolMemberConfig {
                    provider: ProviderId::from("openai"),
                    model: "gpt-4o-mini".to_owned(),
                    priority: 0,
                    weight: 1,
                    enabled: true,
                    last_resort: false,
                    context_tokens: None,
                },
                crate::config::ProviderPoolMemberConfig {
                    provider: ProviderId::from("anthropic"),
                    model: "claude-haiku-4-5".to_owned(),
                    priority: 0,
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
    config.firewall.enabled = false;
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    let state = Arc::new(AppState::new_for_test(config, audit, evals));
    let body = json!({"model":"balanced-chat","messages":[{"role":"user","content":"ping"}]});

    let mut first = signal_ctx(None, false, false);
    first.session_id = Some("first".to_owned());
    let one = run(Arc::clone(&state), first, body.clone()).await.unwrap();
    let mut second = signal_ctx(None, false, false);
    second.session_id = Some("second".to_owned());
    let two = run(Arc::clone(&state), second, body.clone()).await.unwrap();
    let mut repeated = signal_ctx(None, false, false);
    repeated.session_id = Some("first".to_owned());
    let again = run(Arc::clone(&state), repeated, body.clone())
        .await
        .unwrap();

    assert_eq!(one.provider_used, "openai");
    assert_eq!(one.model_used, "gpt-4o-mini");
    assert_eq!(two.provider_used, "anthropic");
    assert_eq!(two.model_used, "claude-haiku-4-5");
    assert_eq!(again.provider_used, "openai");
    {
        let recorded = upstream_state.calls.lock().unwrap();
        assert_eq!(
            recorded.len(),
            3,
            "pool routes bypass Gateway response caches"
        );
        assert_eq!(recorded[0].0, "/v1/chat/completions");
        assert_eq!(recorded[0].1["model"], "gpt-4o-mini");
        assert_eq!(recorded[1].0, "/v1/messages");
        assert_eq!(recorded[1].1["model"], "claude-haiku-4-5");
    }

    upstream_state.fail_openai.store(true, Ordering::SeqCst);
    let mut third = signal_ctx(None, false, false);
    third.session_id = Some("third".to_owned());
    let failed_over = run(Arc::clone(&state), third, body.clone())
        .await
        .expect("a second pool member serves the same turn");
    assert_eq!(failed_over.provider_used, "anthropic");
    assert_eq!(failed_over.model_used, "claude-haiku-4-5");
    assert_eq!(
        failed_over.degraded,
        Some(DegradedMode::Fallback("anthropic".to_owned()))
    );
    assert_eq!(
        upstream_state.calls.lock().unwrap().len(),
        5,
        "the 429 retries the next member with its own model in the same turn"
    );
    let mut retry = signal_ctx(None, false, false);
    retry.session_id = Some("third".to_owned());
    let recovered = run(state, retry, body).await.unwrap();
    assert_eq!(recovered.provider_used, "anthropic");
    assert_eq!(recovered.model_used, "claude-haiku-4-5");
    assert_eq!(upstream_state.calls.lock().unwrap().len(), 6);
    server.abort();
}

#[tokio::test]
async fn main_path_pool_failure_lowers_auto_reliability_for_new_sessions() {
    use std::sync::Mutex;

    // Reliability is the only weighted Auto factor, so the ranking reflects
    // exactly what the feedback ring holds for each member.
    async fn upstream(
        axum::extract::State(calls): axum::extract::State<Arc<Mutex<Vec<String>>>>,
        uri: axum::http::Uri,
    ) -> (axum::http::StatusCode, axum::Json<Value>) {
        let path = uri.path().to_owned();
        calls.lock().unwrap().push(path.clone());
        if path.ends_with("/messages") {
            (
                axum::http::StatusCode::OK,
                axum::Json(json!({
                    "id":"msg_1",
                    "content":[{"type":"text","text":"from anthropic"}],
                    "stop_reason":"end_turn",
                    "usage":{"input_tokens":2,"output_tokens":2}
                })),
            )
        } else {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(json!({"error":{"message":"upstream failed"}})),
            )
        }
    }

    let calls = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .fallback(post(upstream))
        .with_state(Arc::clone(&calls));
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    let mut config = crate::config::GatewayConfig::default();
    config.providers.openai = Some(crate::config::OpenAiProviderConfig {
        api_key: "openai-test-key".to_owned(),
        api_keys: Vec::new(),
        base_url: format!("{base}/v1"),
    });
    config.providers.anthropic = Some(crate::config::AnthropicProviderConfig {
        api_key: "anthropic-test-key".to_owned(),
        api_keys: Vec::new(),
        base_url: base,
    });
    config.routing.model_map.insert(
        "auto-chat".to_owned(),
        crate::config::ModelMapping {
            provider: ProviderId::from("pool:auto"),
            provider_model: None,
        },
    );
    let member = |provider: &str, model: &str| crate::config::ProviderPoolMemberConfig {
        provider: ProviderId::from(provider),
        model: model.to_owned(),
        priority: 0,
        weight: 1,
        enabled: true,
        last_resort: false,
        context_tokens: None,
    };
    config.routing.provider_pools.insert(
        "auto".to_owned(),
        crate::config::ProviderPoolConfig {
            strategy: crate::config::ProviderPoolStrategy::Auto,
            sticky_limit: 1,
            wait_for_cooldown_ms: 0,
            members: vec![
                member("openai", "gpt-4o-mini"),
                member("anthropic", "claude-haiku-4-5"),
            ],
            execution: Default::default(),
            judge: None,
            auto_weights: Some(serde_json::from_value(json!({"reliability":1.0})).unwrap()),
        },
    );
    config.firewall.enabled = false;
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    let state = Arc::new(AppState::new_for_test(config, audit, evals));
    let body = json!({"model":"auto-chat","messages":[{"role":"user","content":"ping"}]});

    // Cold members tie, so config order tries openai first; its 500 falls over.
    let mut first = signal_ctx(None, false, false);
    first.session_id = Some("first".to_owned());
    let one = run(Arc::clone(&state), first, body.clone()).await.unwrap();
    assert_eq!(one.provider_used, "anthropic");
    assert_eq!(
        one.degraded,
        Some(DegradedMode::Fallback("anthropic".to_owned()))
    );
    let openai_calls = |calls: &Mutex<Vec<String>>| {
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|path| path.ends_with("/chat/completions"))
            .count()
    };
    let after_first = openai_calls(&calls);
    assert!(after_first > 0);

    // A new session now ranks the failing member below the healthy one.
    let mut second = signal_ctx(None, false, false);
    second.session_id = Some("second".to_owned());
    let two = run(Arc::clone(&state), second, body).await.unwrap();
    assert_eq!(two.provider_used, "anthropic");
    assert_eq!(two.degraded, None, "the healthy member is chosen first");
    assert_eq!(openai_calls(&calls), after_first);
    server.abort();
}

#[test]
fn cache_tenant_separates_users_within_an_org() {
    let mut ctx = signal_ctx(None, false, false);
    ctx.org_id = Some("org".to_owned());
    ctx.user_id = None;
    assert_eq!(cache_tenant(&ctx).as_deref(), Some("org"));
    ctx.user_id = Some("alice".to_owned());
    let alice = cache_tenant(&ctx);
    ctx.user_id = Some("bob".to_owned());
    let bob = cache_tenant(&ctx);
    assert_ne!(alice, bob);
    assert_ne!(alice.as_deref(), Some("org"));
    ctx.org_id = None;
    assert_ne!(cache_tenant(&ctx), bob);
}

#[test]
fn semantic_cache_keeps_provider_model_and_tenant_separate() {
    let scope = |org: Option<&str>, provider: &str, model: &str| {
        crate::cache::CacheScope::new(
            crate::cache::CacheEpoch::new([0; 16], 1),
            org,
            provider,
            model,
        )
        .semantic_scope()
    };
    let cache = SemanticCache::new(
        crate::config::SemanticCacheConfig {
            enabled: true,
            ..Default::default()
        },
        60,
        1000,
    );
    let embedding = vec![1.0, 0.0];
    let original = scope(Some("org"), "openai", "gpt-4o");
    cache.insert(
        Some(original.clone()),
        embedding.clone(),
        serde_json::json!({"route":"openai"}),
    );
    assert_eq!(
        cache.lookup(Some(&original), &embedding),
        Some(serde_json::json!({"route":"openai"}))
    );
    for other in [
        scope(Some("org"), "anthropic", "gpt-4o"),
        scope(Some("org"), "openai", "gpt-4o-mini"),
        scope(None, "openai", "gpt-4o"),
    ] {
        assert_eq!(cache.lookup(Some(&other), &embedding), None);
    }
}

#[test]
fn a_locked_node_drops_the_request_headers_entirely() {
    let mut ctx = signal_ctx(None, false, false);
    ctx.prompt_cache_mode = Some(ryu_gw_providers::PromptCacheMode::Explicit);
    ctx.prompt_cache_ttl = Some("1h".into());

    let cfg = crate::config::PromptCacheConfig {
        allow_request_override: false,
        ..Default::default()
    };
    let (mode, ttl) = resolve_prompt_cache_override(&cfg, &ctx);
    assert_eq!(mode, None, "a locked node must ignore x-ryu-prompt-cache");
    assert_eq!(ttl, None);
}

#[test]
fn zdr_is_available_without_plan_entitlement_and_rejects_invalid_options() {
    let state = AppState::new_for_test_default();
    let mut ctx = managed_ctx(10_000);
    let body = json!({"provider":{"zdr":true}});
    assert!(zero_data_retention::enforce_requested_zdr(
        &state,
        &ctx,
        &json!({"provider":{"zdr":"true"}})
    )
    .is_err());
    assert!(zero_data_retention::enforce_requested_zdr(&state, &ctx, &body).is_ok());
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        zero_data_retention_enabled: true,
        ..Default::default()
    });
    assert!(zero_data_retention::enforce_requested_zdr(&state, &ctx, &body).is_ok());
    ctx.resolved_policy.as_mut().unwrap().available = false;
    assert!(zero_data_retention::enforce_requested_zdr(&state, &ctx, &body).is_ok());
    ctx.managed_inference = false;
    assert!(zero_data_retention::enforce_requested_zdr(&state, &ctx, &body).is_ok());
}

#[test]
fn reservation_estimate_floors_at_the_configured_minimum() {
    let state = reserve_state(10_000, 1);
    // A tiny completion still claims the floor, so a burst of cheap requests
    // is bounded by balance / floor rather than by nothing.
    let body = json!({ "max_tokens": 1 });
    assert_eq!(reservation_estimate_micro_usd(&state, &body), 10_000);
}

#[test]
fn reservation_estimate_scales_with_max_tokens_above_the_floor() {
    // 1_000_000 tokens at 1000 micro-USD/1k = 1_000_000 micro-USD, over the floor.
    let state = reserve_state(10_000, 1000);
    let body = json!({ "max_tokens": 1_000_000 });
    assert_eq!(reservation_estimate_micro_usd(&state, &body), 1_000_000);
}

#[test]
fn conflicting_token_limits_reserve_for_the_larger_ceiling() {
    let state = reserve_state(10_000, 1000);
    for body in [
        json!({ "max_tokens": 1, "max_completion_tokens": 32_000 }),
        json!({ "max_tokens": 32_000, "max_completion_tokens": 1 }),
    ] {
        assert_eq!(reservation_estimate_micro_usd(&state, &body), 32_000);
    }
}

#[test]
fn an_unbounded_completion_reserves_the_floor_not_zero() {
    // Naming no ceiling makes a request MORE expensive to serve, not free.
    let state = reserve_state(10_000, 1000);
    assert_eq!(reservation_estimate_micro_usd(&state, &json!({})), 10_000);
    // `max_completion_tokens` is the newer spelling and must read the same.
    let aliased = json!({ "max_completion_tokens": 1_000_000 });
    assert_eq!(reservation_estimate_micro_usd(&state, &aliased), 1_000_000);
}
