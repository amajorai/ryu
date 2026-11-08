use super::*;

#[test]
fn budget_downgrade_reserves_against_the_final_provider_pool() {
    use crate::config::{BudgetAction, BudgetRule, ModelMapping};

    let mut config = GatewayConfig::default();
    config.routing.default_provider = ProviderId::from("cloudflare");
    config.routing.model_map.insert(
        "cheap-model".to_owned(),
        ModelMapping {
            provider: ProviderId::from("openrouter"),
            provider_model: None,
        },
    );
    config.budgets.users.insert(
        "u1".to_owned(),
        BudgetRule {
            limit: 1,
            window: Default::default(),
            action: BudgetAction::Downgrade,
            downgrade_to: Some("cheap-model".to_owned()),
            restrict_max_tokens: 256,
            alert: crate::config::AlertTier::Silent,
            include: crate::config::BudgetChargeInclusion::default(),
        },
    );
    config.credits.reserve_enabled = true;
    config.credits.min_reserve_micro_usd = 10_000;
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let state = AppState::new_for_test(config, audit, evals);
    state.with_budget(|budgets| budgets.record(Some("u1"), None, 1));

    let mut ctx = plain_ctx();
    ctx.org_id = Some("o1".to_owned());
    ctx.managed_inference = true;
    ctx.remaining_budget_micro_usd = Some(50_000);
    ctx.user_id = Some("u1".to_owned());
    ctx.unrestricted_budget_micro_usd = Some(0);
    ctx.pool_budgets_micro_usd =
        std::collections::HashMap::from([("openrouter".to_owned(), 50_000)]);
    let mut body = json!({ "model": "primary-model", "messages": [] });
    let mut decision = RouteDecision {
        provider: ProviderId::from("cloudflare"),
        model: "primary-model".to_owned(),
    };
    let admitted = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        BudgetChargeKind::Model,
        OutputCeiling::Clamp,
    )
    .expect("funded downgrade pool should admit the final route");
    assert_eq!(decision.provider.as_str(), "openrouter");
    assert_eq!(decision.model, "cheap-model");
    assert!(admitted.reservation.is_some());
    drop(admitted);

    ctx.pool_budgets_micro_usd =
        std::collections::HashMap::from([("cloudflare".to_owned(), 50_000)]);
    let mut body = json!({ "model": "primary-model", "messages": [] });
    let mut decision = RouteDecision {
        provider: ProviderId::from("cloudflare"),
        model: "primary-model".to_owned(),
    };
    assert!(matches!(
        enforce_budget(
            &state,
            &ctx,
            &mut body,
            &mut decision,
            BudgetChargeKind::Model,
            OutputCeiling::Clamp,
        ),
        Err(GatewayError::InsufficientCredits)
    ));
    assert_eq!(decision.provider.as_str(), "openrouter");
}

#[test]
fn concurrent_requests_count_each_others_budget_claims() {
    use crate::config::{BudgetAction, BudgetRule};

    let mut config = GatewayConfig::default();
    config.budgets.users.insert(
        "u1".to_owned(),
        BudgetRule {
            limit: 1_000_000,
            window: Default::default(),
            action: BudgetAction::Stop,
            downgrade_to: None,
            restrict_max_tokens: 256,
            alert: crate::config::AlertTier::Silent,
            include: crate::config::BudgetChargeInclusion::default(),
        },
    );
    config.credits.min_reserve_micro_usd = 10_000;
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(EvalsConfig::default());
    let state = AppState::new_for_test(config, audit, evals);
    // $0.995 of a $1 Stop cap is already recorded.
    state.with_budget(|budgets| budgets.record(Some("u1"), None, 995_000));

    let mut ctx = plain_ctx();
    ctx.user_id = Some("u1".to_owned());
    let admit = || {
        let mut body = json!({ "model": "primary-model", "messages": [] });
        let mut decision = RouteDecision {
            provider: ProviderId::from("openai"),
            model: "primary-model".to_owned(),
        };
        enforce_budget(
            &state,
            &ctx,
            &mut body,
            &mut decision,
            BudgetChargeKind::Model,
            OutputCeiling::Clamp,
        )
    };

    let first = admit().expect("a lone request below the cap is admitted");
    assert!(first.budget_hold.is_some());
    // While the first runs, its estimate fills the remaining headroom.
    assert!(matches!(admit(), Err(GatewayError::BudgetExceeded(_))));
    drop(first);
    assert!(admit().is_ok(), "a finished request frees its claim");
}

/// A `Restrict` rule serves the turn but stamps the Restrict decision on the
/// output (the request path strips tools + caps max_tokens).
#[tokio::test]
async fn budget_restrict_serves_with_a_restrict_decision() {
    use crate::config::{BudgetAction, BudgetRule};
    let (state, _calls) = budget_state(BudgetRule {
        limit: 1_000_000,
        window: Default::default(),
        action: BudgetAction::Restrict,
        downgrade_to: None,
        restrict_max_tokens: 128,
        alert: crate::config::AlertTier::Silent,
        include: crate::config::BudgetChargeInclusion::default(),
    });
    let out = run(Arc::clone(&state), u1_ctx(), ping_body())
        .await
        .expect("restrict still serves a minimal answer");
    let budget = out.budget.expect("a budget decision is stamped");
    assert_eq!(budget.action, BudgetAction::Restrict);
}

#[tokio::test]
async fn budget_restrict_blocks_hints_search_and_unsolicited_dispatch_in_both_paths() {
    use crate::config::{BudgetAction, BudgetRule, CoreProviderConfig};
    let catalog_calls = Arc::new(AtomicUsize::new(0));
    let calls = Arc::clone(&catalog_calls);
    let app = axum::Router::new().fallback(move || {
        let calls = Arc::clone(&calls);
        async move {
            calls.fetch_add(1, Ordering::SeqCst);
            axum::Json(json!({}))
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for stream in [false, true] {
        let (mut state, _) = budget_state(BudgetRule {
            limit: 1_000_000,
            window: Default::default(),
            action: BudgetAction::Restrict,
            downgrade_to: None,
            restrict_max_tokens: 128,
            alert: crate::config::AlertTier::Silent,
            include: crate::config::BudgetChargeInclusion::default(),
        });
        let state_mut = Arc::get_mut(&mut state).unwrap();
        state_mut.tools = Some(crate::tools::ToolSearchClient::new(
            &CoreProviderConfig {
                base_url: base_url.clone(),
                token: None,
            },
            state_mut.http.clone(),
        ));
        let (provider, provider_calls) = StubProvider::new("primary", Mode::RestrictedToolCalls);
        state_mut
            .provider_runtime
            .register_for_test(provider as Arc<dyn Provider>);
        let mut ctx = u1_ctx();
        ctx.tools_header_present = true;
        ctx.tool_search_requested = true;
        ctx.capability_hints =
            Some(r#"{"tools":["composio.GMAIL_SEARCH_EMAILS"],"skills":["mail"]}"#.into());
        let mut body = ping_body();
        body["max_tokens"] = json!(4096);
        body["tools"] = json!([{"type":"function","function":{"name":"skills.load"}}]);
        body["tool_choice"] = json!("required");
        if stream {
            let out = super::super::run_stream(state, ctx, body).await.unwrap();
            let bytes = axum::body::to_bytes(out.body, usize::MAX).await.unwrap();
            assert!(String::from_utf8_lossy(&bytes).contains("pong"));
        } else {
            let out = run(state, ctx, body).await.unwrap();
            assert_eq!(out.budget.unwrap().action, BudgetAction::Restrict);
        }
        assert_eq!(
            provider_calls.load(Ordering::SeqCst),
            1,
            "restricted turns never enter a tool round"
        );
        assert_eq!(
            catalog_calls.load(Ordering::SeqCst),
            0,
            "no describe, search, skill load or execution reaches Core"
        );
    }
    server.abort();
}

/// A `Notify` rule is non-blocking: it serves the turn and stamps the Notify
/// decision without altering the model.
#[tokio::test]
async fn budget_notify_is_non_blocking() {
    use crate::config::{BudgetAction, BudgetRule};
    let (state, calls) = budget_state(BudgetRule {
        limit: 1_000_000,
        window: Default::default(),
        action: BudgetAction::Notify,
        downgrade_to: None,
        restrict_max_tokens: 256,
        alert: crate::config::AlertTier::Silent,
        include: crate::config::BudgetChargeInclusion::default(),
    });
    let out = run(Arc::clone(&state), u1_ctx(), ping_body())
        .await
        .expect("notify never blocks");
    assert_eq!(out.budget.expect("decision").action, BudgetAction::Notify);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

/// The pre-flight credit gate: a managed-inference tenant whose resolved wallet
/// balance is already zero is rejected with a hard `InsufficientCredits` (402)
/// before any provider is reached.
#[tokio::test]
async fn preflight_credit_gate_rejects_exhausted_managed_tenant() {
    let mut state = chain_state(5);
    let (primary, calls) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let mut ctx = plain_ctx();
    ctx.org_id = Some("org-managed".to_string());
    ctx.managed_inference = true;
    ctx.remaining_budget_micro_usd = Some(0);

    let err = match run(Arc::clone(&state), ctx, ping_body()).await {
        Err(e) => e,
        Ok(_) => panic!("an exhausted managed wallet must be rejected pre-flight"),
    };
    assert!(
        matches!(err, GatewayError::InsufficientCredits),
        "expected InsufficientCredits, got {err:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "the credit gate must short-circuit before dispatch"
    );
}

/// The streaming outbound firewall (Block policy) buffers the upstream SSE,
/// scans the assembled text, and emits a blocked frame instead of the leaked
/// secret — so a secret never streams to the client.
#[tokio::test]
async fn run_stream_outbound_firewall_block_redacts_leaked_secret() {
    use super::super::run_stream;
    use crate::config::FirewallPolicy;

    struct LeakyStream;
    impl Provider for LeakyStream {
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
            Box::pin(async move { Err(ryu_gw_providers::ProviderError::Provider("n/a".into())) })
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
            let sse = concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"key sk-abcdefghijklmnopqrstu\"}}]}\n\n",
                "data: [DONE]\n\n",
            );
            Box::pin(async move { Ok(axum::body::Body::from(sse)) })
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
        .register_for_test(Arc::new(LeakyStream) as Arc<dyn Provider>);
    let state = Arc::new(state);

    let out = run_stream(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("stream is served (as a blocked frame)");
    let bytes = axum::body::to_bytes(out.body, usize::MAX)
        .await
        .expect("drain sse body");
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        !text.contains("sk-abcdefghijklmnopqrstu"),
        "the outbound firewall must not let the secret stream through: {text}"
    );
}

/// A `Sanitize` inbound policy redacts the offending content in place and still
/// serves the turn (never blocks).
#[tokio::test]
async fn inbound_firewall_sanitize_serves_the_request() {
    use crate::config::{AlertTier, FirewallPolicy};
    let (state, calls) = firewall_state(FirewallPolicy::Sanitize, AlertTier::Silent);
    let out = run(Arc::clone(&state), plain_ctx(), secret_body())
        .await
        .expect("sanitize never blocks");
    assert_eq!(out.provider_used, "primary");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "the sanitized request still reaches the provider"
    );
}

/// Sanitize must not make the provider-bound prefix depend on whether the
/// newest turn tripped the firewall: tools and earlier turns egress in the
/// same form on a clean turn and on a flagged one, so the provider's prompt
/// cache keeps hitting.
#[tokio::test]
async fn inbound_sanitize_keeps_the_cached_prompt_prefix_stable() {
    use crate::config::{AlertTier, FirewallPolicy};
    let (state, _) = firewall_state(FirewallPolicy::Sanitize, AlertTier::Silent);
    let tools = json!([{ "type": "function", "function": {
        "name": "notify",
        "description": "Send mail, e.g. to jane@example.com",
        "parameters": { "type": "object" }
    } }]);
    let history = json!([
        { "role": "system", "content": "You are helpful." },
        { "role": "user", "content": "hello" },
        { "role": "assistant", "content": "hi there" }
    ]);
    let mut clean = json!({ "model": "anything", "messages": history, "tools": tools });
    clean["messages"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "role": "user", "content": "what's new?" }));
    let mut flagged = json!({ "model": "anything", "messages": history, "tools": tools });
    flagged["messages"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "role": "user", "content": "use key sk-abcdefghijklmnopqrstu" }));

    let ctx = plain_ctx();
    super::super::pre_process(&state, &ctx, &mut clean)
        .await
        .expect("clean turn");
    super::super::pre_process(&state, &ctx, &mut flagged)
        .await
        .expect("sanitized turn");

    assert_eq!(
        clean["tools"], flagged["tools"],
        "tools must egress identically"
    );
    assert!(
        !clean["tools"].to_string().contains("jane@example.com"),
        "{}",
        clean["tools"]
    );
    for turn in 0..3 {
        assert_eq!(clean["messages"][turn], flagged["messages"][turn]);
    }
    assert!(!flagged["messages"][3]["content"]
        .as_str()
        .unwrap()
        .contains("sk-abcdefghijklmnopqrstu"));
}
