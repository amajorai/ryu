//! Charging completed, overrun and streamed chats exactly once.

use super::*;

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
