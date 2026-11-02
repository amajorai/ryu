//! Embedding endpoints, the inspector and the semantic cache under governance.

use super::*;

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
    // The judge must answer with a verdict: under the inspector's default
    // Block action a non-JSON reply is no verdict and fails closed.
    *provider.response_text.lock().unwrap() =
        Some(r#"{"flagged": false, "categories": [], "reason": "clean"}"#.into());
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
/// GuardBreaker: a judge that answers in prose gives no verdict, so a Block
/// inspector refuses the turn instead of forwarding it to the model.
#[tokio::test]
async fn a_block_inspector_refuses_a_turn_its_judge_gave_no_verdict_for() {
    let (state, provider) = fixture(|config| {
        config.routing.smart_routing.enabled = false;
        config.firewall.inspector.enabled = true;
        config.firewall.inspector.min_chars = 0;
        config.firewall.inspector.model = "test".into();
    });
    *provider.response_text.lock().unwrap() = Some("Paris is the capital of France.".into());
    let result = run(state, ctx(), prompt()).await;
    assert!(
        matches!(&result, Err(GatewayError::FirewallBlocked(reason, _)) if reason.contains("inspector")),
        "a prose judge reply must fail closed under Block: {:?}",
        result.as_ref().err()
    );
    assert_eq!(
        provider.requests.lock().unwrap().len(),
        1,
        "only the judge call is dispatched; the turn never reaches the model"
    );
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
