use super::*;

/// A hosted organisation's managed inference on a billing gateway runs on
/// the fleet's keys and is billed to the organisation, so an agent's
/// provider list (which limits the user's own credentials) does not block
/// it. Every other combination stays limited.
#[test]
fn agent_provider_access_exempts_fleet_supply_for_managed_tenants() {
    let billing = billing_state();
    let not_billing = AppState::new_for_test_default();
    let fleet_tenant = {
        let mut ctx = fleet_tenant_ctx();
        ctx.agent_provider_access = provider_access(&[]);
        ctx
    };
    let check = |state: &AppState, ctx: &RequestContext, provider: &str| {
        crate::pipeline::inference_governance::authorize_agent_provider(
            state,
            ctx,
            &ProviderId::from(provider),
        )
    };
    for provider in ["openrouter", "openai", "anthropic", "genai"] {
        assert!(
            check(&billing, &fleet_tenant, provider).is_ok(),
            "{provider}"
        );
        // A gateway that does not bill may hold the operator's (the
        // user's) own keys: still limited.
        assert!(
            check(&not_billing, &fleet_tenant, provider).is_err(),
            "{provider}"
        );
    }
    // A static or scoped key on a billing gateway is not managed inference.
    let mut static_key = fleet_tenant.clone();
    static_key.managed_inference = false;
    assert!(check(&billing, &static_key, "openrouter").is_err());
    // Without a resolved organisation there is no tenant wallet.
    let mut no_org = fleet_tenant.clone();
    no_org.org_id = None;
    assert!(check(&billing, &no_org, "openai").is_err());
    // The master key never stands for a hosted tenant.
    let mut master = fleet_tenant.clone();
    master.is_master_key = true;
    assert!(check(&billing, &master, "openai").is_err());
    // No list stays unrestricted on every gateway.
    assert!(check(&not_billing, &fleet_tenant_ctx(), "openai").is_ok());
}

/// The exemption only lifts the agent's account check: the organisation's
/// own provider policy still binds the fleet-served turn.
#[test]
fn managed_tenant_policy_still_binds_an_exempt_agent() {
    let billing = billing_state();
    let mut ctx = fleet_tenant_ctx();
    ctx.agent_provider_access = provider_access(&[]);
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        approved_providers: vec!["anthropic".to_owned()],
        ..Default::default()
    });
    assert!(
        crate::pipeline::inference_governance::authorize_provider_region(
            &billing,
            &ctx,
            &ProviderId::from("anthropic")
        )
        .is_ok()
    );
    let Err(error) = crate::pipeline::inference_governance::authorize_provider_region(
        &billing,
        &ctx,
        &ProviderId::from("openrouter"),
    ) else {
        panic!("the organisation's policy must still refuse openrouter");
    };
    assert!(
        error.to_string().contains("control-plane provider"),
        "unexpected error: {error}"
    );
}

#[test]
fn agent_provider_access_header_parses_and_narrows() {
    assert!(super::super::parse_agent_provider_access("none").is_empty());
    assert!(super::super::parse_agent_provider_access(" NONE ").is_empty());
    assert_eq!(
        super::super::parse_agent_provider_access("openai, anthropic,,Bad Id,genai"),
        ["openai", "anthropic", "genai"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    );
    let narrowed = super::super::narrow_agent_provider_access(
        provider_access(&["openai", "anthropic"]),
        Some(vec!["anthropic".to_owned()]),
    )
    .unwrap();
    assert_eq!(narrowed.len(), 1);
    assert!(narrowed.contains("anthropic"));
    assert!(super::super::narrow_agent_provider_access(None, None).is_none());
    assert!(
        super::super::narrow_agent_provider_access(None, Some(Vec::new()))
            .unwrap()
            .is_empty()
    );
}

/// A locked node ignores the preference wholesale — the `[node_routing]`
/// lever, mirroring `[prompt_cache].allow_request_override`.
#[tokio::test]
async fn a_locked_node_ignores_the_preference_end_to_end() {
    let mut state = three_chain_state();
    state.config.node_routing.allow_request_override = false;
    let (primary, _) = StubProvider::new("primary", Mode::RateLimited);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    let (tertiary, tertiary_calls) = StubProvider::new("tertiary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(tertiary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let mut ctx = plain_ctx();
    ctx.node_routing = Some(prefs(&["tertiary"]));

    let out = run(Arc::clone(&state), ctx, ping_body())
        .await
        .expect("the fleet order stands");

    assert_eq!(out.provider_used, "secondary");
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(tertiary_calls.load(Ordering::SeqCst), 0);
}

/// The polarity of the credit gate `clamped_fallback_chain` hands the clamp
/// (`preflight_credit_gate(..).is_none()` — `Some(err)` means REJECTED) is
/// expressed in exactly ONE place in production. A unit test that writes its
/// own closure cannot pin it: inverting the adapter leaves such a test green
/// while every reorder starts promoting providers the org cannot pay for.
///
/// So this drives the real thing through `run()`. The setup is the segregated
/// credit-pool case, which is also the only shape where the bug is reachable:
/// the org has grant money in the PRIMARY's pool (so `enforce_budget` admits
/// the request — it gates the primary's pool only) and nothing unrestricted,
/// so the preferred fallback in a DIFFERENT pool is unfunded and must not be
/// promoted ahead of the fleet's own next choice.
#[tokio::test]
async fn credit_gate_polarity_is_wired_correctly_end_to_end() {
    // Real provider ids, because `pool_for_gateway_provider` is a fixed table:
    // `openrouter` → the retail pool (funded here by its own grant),
    // `cloudflare` → own supply, which a retail primary may never fail over
    // onto (`keep_own_supply_in_its_lane`), and the made-up `secondary` is
    // untagged, so it needs unrestricted credit.
    let config = GatewayConfig {
        routing: RoutingConfig {
            default_provider: ProviderId::from("openrouter"),
            fallback_chain: vec![
                ProviderId::from("openrouter"),
                ProviderId::from("secondary"),
                ProviderId::from("cloudflare"),
            ],
            ..RoutingConfig::default()
        },
        firewall: FirewallConfig {
            enabled: false,
            ..FirewallConfig::default()
        },
        circuit_breaker: CircuitBreakerConfig {
            enabled: true,
            failure_threshold: 10,
            reset_timeout_secs: 30,
        },
        credits: crate::config::CreditsConfig {
            reserve_enabled: true,
            min_reserve_micro_usd: 10_000,
            ..Default::default()
        },
        rate_limit: crate::config::RateLimitConfig {
            max_burst_per_second: 0,
            ..Default::default()
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

    let (primary, _) = StubProvider::new("openrouter", Mode::RateLimited);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    let (own_supply, bedrock_calls) = StubProvider::new("cloudflare", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(own_supply as Arc<dyn Provider>);
    let state = Arc::new(state);

    let mut ctx = plain_ctx();
    ctx.managed_inference = true;
    ctx.org_id = Some("fallback-pool-test".into());
    // Total is positive (so the wallet is not simply empty), but ALL of it is
    // the PRIMARY's own pool grant: the untagged fallback is unfunded, and
    // the own-supply one is out of lane however the node prefers it.
    ctx.remaining_budget_micro_usd = Some(50_000);
    ctx.unrestricted_budget_micro_usd = Some(0);
    ctx.pool_budgets_micro_usd =
        std::collections::HashMap::from([("openrouter".to_string(), 50_000_i64)]);
    ctx.node_routing = Some(prefs(&["cloudflare"]));

    for preference in [
        Some(prefs(&["cloudflare"])),
        Some(prefs(&["secondary"])),
        None,
    ] {
        ctx.node_routing = preference;
        assert!(matches!(
            run(Arc::clone(&state), ctx.clone(), ping_body()).await,
            Err(GatewayError::InsufficientCredits)
        ));
        assert!(matches!(
            super::super::run_stream(Arc::clone(&state), ctx.clone(), ping_body()).await,
            Err(GatewayError::InsufficientCredits)
        ));
        assert!(matches!(
            super::super::run_speech(
                Arc::clone(&state),
                ctx.clone(),
                json!({"model":"stub-1","input":"ping"})
            )
            .await,
            Err(GatewayError::InsufficientCredits)
        ));
        for operation in [
            super::super::EmbeddingOperation::Embed,
            super::super::EmbeddingOperation::Rerank,
        ] {
            assert!(matches!(
                super::super::run_embedding(
                    Arc::clone(&state),
                    ctx.clone(),
                    json!({"model":"stub-1","input":"ping","query":"ping","documents":["pong"]}),
                    operation
                )
                .await,
                Err(GatewayError::InsufficientCredits)
            ));
        }
        assert_eq!(
            bedrock_calls.load(Ordering::SeqCst),
            0,
            "a retail primary never fails over onto own supply"
        );
        assert_eq!(
            secondary_calls.load(Ordering::SeqCst),
            0,
            "untagged fallback requires unrestricted credit"
        );
    }
    ctx.unrestricted_budget_micro_usd = Some(50_000);
    ctx.remaining_budget_micro_usd = Some(100_000);
    let out = run(Arc::clone(&state), ctx.clone(), ping_body())
        .await
        .unwrap();
    assert_eq!(
        out.provider_used, "secondary",
        "funded fallback still serves"
    );
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(bedrock_calls.load(Ordering::SeqCst), 0);
    let out = super::super::run_stream(Arc::clone(&state), ctx, ping_body())
        .await
        .unwrap();
    assert!(
        state.wallet.in_flight_micro_usd("fallback-pool-test") >= 10_000,
        "the funded fallback holds its own reservation throughout streaming"
    );
    let _ = axum::body::to_bytes(out.body, usize::MAX).await.unwrap();
    assert_eq!(state.wallet.in_flight_micro_usd("fallback-pool-test"), 0);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 2);
    assert_eq!(bedrock_calls.load(Ordering::SeqCst), 0);
}

/// The other half: an ALLOWED slot model still wins, so the clamp did not
/// break per-agent slot pinning. And with no allowlist at all (every
/// non-allowlisted deployment) nothing changes.
#[tokio::test]
async fn an_allowed_slot_model_and_an_empty_allowlist_both_still_pin() {
    let mut state = chain_state(10);
    let (primary, _) = StubProvider::new("primary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let mut ctx = plain_ctx();
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        approved_models: vec!["approved-model".into(), "slot-model".into()],
        ..Default::default()
    });
    ctx.slot_provider = Some(ProviderId::from("primary"));
    ctx.slot_model = Some("slot-model".into());
    let out = run(
        Arc::clone(&state),
        ctx,
        json!({"model": "approved-model", "messages": [{"role": "user", "content": "ping"}]}),
    )
    .await
    .expect("an approved slot model dispatches");
    assert_eq!(out.model_used, "slot-model");

    let mut ctx = plain_ctx();
    ctx.slot_provider = Some(ProviderId::from("primary"));
    ctx.slot_model = Some("anything-at-all".into());
    let out = run(Arc::clone(&state), ctx, ping_body())
        .await
        .expect("no allowlist ⇒ unchanged behaviour");
    assert_eq!(out.model_used, "anything-at-all");
}

/// A rate-limited primary demotes to the next provider in the chain: the
/// secondary serves the turn, the response is flagged as a degraded fallback,
/// and — crucially — the primary's circuit is NOT tripped (a 429 is a capacity
/// signal, not a fault).
#[tokio::test]
async fn rate_limited_primary_demotes_to_secondary_without_tripping_circuit() {
    let mut state = chain_state(1);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::RateLimited);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let out = run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("secondary must serve after primary rate-limits");

    assert_eq!(out.provider_used, "secondary");
    assert_eq!(
        out.degraded,
        Some(DegradedMode::Fallback("secondary".into()))
    );
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1, "primary was tried");
    assert_eq!(
        secondary_calls.load(Ordering::SeqCst),
        1,
        "secondary served"
    );
    // The 429 must NOT open the primary's circuit even with threshold=1.
    assert!(
        !state
            .circuit_breaker
            .is_open(&current_circuit_key(&state, "primary")),
        "a rate-limit is a capacity signal and must not trip the circuit"
    );
}

#[tokio::test]
async fn payment_required_primary_demotes_without_tripping_circuit() {
    let mut state = chain_state(1);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::PaymentRequired);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let out = run(Arc::clone(&state), plain_ctx(), ping_body())
        .await
        .expect("secondary must serve after the selected account returns 402");

    assert_eq!(out.provider_used, "secondary");
    assert_eq!(primary_calls.load(Ordering::SeqCst), 1);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
    assert!(
        !state
            .circuit_breaker
            .is_open(&current_circuit_key(&state, "primary")),
        "a payment condition belongs to the account, not provider health"
    );
}

#[tokio::test]
async fn exhausted_chain_preserves_the_payment_required_reason() {
    let mut state = chain_state(1);
    let (primary, _) = StubProvider::new("primary", Mode::PaymentRequired);
    let (secondary, _) = StubProvider::new("secondary", Mode::Fail);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let err = match run(Arc::clone(&state), plain_ctx(), ping_body()).await {
        Err(error) => error,
        Ok(_) => panic!("an exhausted fallback chain must fail"),
    };
    assert!(
        matches!(err, GatewayError::ProviderPaymentRequired { .. }),
        "the actionable 402 must survive a later generic fallback error: {err:?}"
    );
}
