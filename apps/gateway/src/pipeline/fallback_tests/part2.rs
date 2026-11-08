use super::*;

#[tokio::test]
async fn a_published_row_routes_only_after_its_canary_and_shows_the_picked_id() {
    // Fleet gateway, no canary yet: the Ryu Router route.
    let (state, router_calls, slot_calls) =
        own_supply_state_with(Mode::Ok, Some(fleet_runtime_with_opus_41()));
    run(
        Arc::clone(&state),
        support::free_credit_ctx(5_000_000),
        opus_41_body(),
    )
    .await
    .expect("router serves");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 0);
    assert_eq!(router_calls.load(Ordering::SeqCst), 1);
    // A seed id that is not in the published table never goes to a slot.
    run(
        Arc::clone(&state),
        free_credit_ctx(5_000_000),
        sonnet_body(),
    )
    .await
    .expect("router serves");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 0);

    // Canary passed: served from own supply under the picked id, priced at
    // the row's price rather than the flat rate.
    state.own_supply.record_canary(
        "anthropic-credits",
        "claude-opus-4-1",
        crate::own_supply_table::CanaryResult {
            ok: true,
            at: std::time::Instant::now(),
            key_fingerprint: "test".into(),
        },
    );
    let out = run(
        Arc::clone(&state),
        free_credit_ctx(5_000_000),
        opus_41_body(),
    )
    .await
    .expect("own supply serves");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(out.response["model"], "anthropic/claude-opus-4.1");
    assert_eq!(out.provider_used, "ryu");
    assert_eq!(
        super::super::response_cost_micro_usd(
            &state,
            Some("anthropic-credits"),
            None,
            1000,
            1000,
            "claude-opus-4-1",
            None
        ),
        90_000
    );
    // A cached prompt is billed like OpenRouter bills it: 900 of the 1,000
    // prompt tokens read from cache at $1.50/M, 100 fresh at $15/M.
    assert_eq!(
        super::super::response_cost_micro_usd(
            &state,
            Some("anthropic-credits"),
            None,
            1000,
            1000,
            "claude-opus-4-1",
            Some(super::super::provider_usage::ProviderCacheUsage {
                read_tokens: 900,
                write_tokens: 0,
                write_1h_tokens: 0,
            })
        ),
        1_500 + 1_350 + 75_000
    );
    // A one-hour cache write is billed at 2x the prompt price ($30/M for
    // Opus), not the catalog's five-minute write rate ($18.75/M).
    assert_eq!(
        super::super::response_cost_micro_usd(
            &state,
            Some("anthropic-credits"),
            None,
            1000,
            1000,
            "claude-opus-4-1",
            Some(super::super::provider_usage::ProviderCacheUsage {
                read_tokens: 0,
                write_tokens: 1000,
                write_1h_tokens: 1000,
            })
        ),
        30_000 + 75_000
    );

    // Quarantined (a runtime 404): back to the Ryu Router route.
    state
        .own_supply
        .quarantine("anthropic-credits", "claude-opus-4-1");
    let mut fresh = opus_41_body();
    fresh["messages"][0]["content"] = json!("ping again");
    run(Arc::clone(&state), free_credit_ctx(5_000_000), fresh)
        .await
        .expect("router serves");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(router_calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn free_credit_serves_an_equivalent_pick_from_own_supply_under_the_picked_id() {
    let (state, router_calls, slot_calls) = own_supply_state(Mode::Ok);
    let out = run(
        Arc::clone(&state),
        free_credit_ctx(5_000_000),
        sonnet_body(),
    )
    .await
    .expect("own supply serves");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(router_calls.load(Ordering::SeqCst), 0);
    assert_eq!(out.response["model"], "anthropic/claude-sonnet-4.5");
    assert_eq!(out.model_used, "anthropic/claude-sonnet-4.5");
    assert_eq!(out.provider_used, "ryu");

    let out = super::super::run_stream(state, free_credit_ctx(5_000_000), sonnet_body())
        .await
        .expect("own supply streams");
    assert_eq!(out.model_used, "anthropic/claude-sonnet-4.5");
    assert_eq!(out.provider_used, "ryu");
    let _ = axum::body::to_bytes(out.body, usize::MAX).await.unwrap();
    assert_eq!(slot_calls.load(Ordering::SeqCst), 2);
    assert_eq!(router_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn without_free_credit_the_pick_goes_to_the_ryu_router_route() {
    let (state, router_calls, slot_calls) = own_supply_state(Mode::Ok);
    let out = run(state, free_credit_ctx(0), sonnet_body())
        .await
        .expect("router serves");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 0);
    assert_eq!(router_calls.load(Ordering::SeqCst), 1);
    // A managed caller never sees the serving slot, OpenRouter included.
    assert_eq!(out.provider_used, "ryu");
}

#[tokio::test]
async fn a_fully_dialed_row_serves_paid_traffic_and_falls_back_on_failure() {
    let paid_runtime = || {
        let (table, _) = crate::own_supply_table::parse_table(&json!({
            "version": 5,
            "rows": [{
                "id": "anthropic/claude-sonnet-4.5",
                "slot": "anthropic-credits",
                "upstream": "claude-sonnet-4-5",
                "userPrice": {"inPer1kMicroUsd": 3000, "outPer1kMicroUsd": 15000},
                "paidRolloutBps": 10000
            }],
            "poolDefaults": {}
        }))
        .unwrap();
        let runtime = crate::own_supply_table::OwnSupplyRuntime::fleet_for_test(table, None);
        runtime.record_canary(
            "anthropic-credits",
            "claude-sonnet-4-5",
            crate::own_supply_table::CanaryResult {
                ok: true,
                at: std::time::Instant::now(),
                key_fingerprint: "test".into(),
            },
        );
        runtime
    };
    // Paid traffic needs the pool reported, with no donation ceiling.
    let report = |remaining_micro_usd: Option<i64>| {
        std::collections::HashMap::from([(
            "anthropic-credits".to_owned(),
            crate::credit_pools::PoolAllowance {
                remaining_micro_usd,
                expires_at: None,
            },
        )])
    };
    let (state, router_calls, slot_calls) = own_supply_state_with(Mode::Ok, Some(paid_runtime()));
    let out = run(Arc::clone(&state), free_credit_ctx(0), sonnet_body())
        .await
        .expect("router serves a paid caller while no allowance is known");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 0);
    assert_eq!(router_calls.load(Ordering::SeqCst), 1);
    assert_eq!(out.provider_used, "ryu");

    // A donated allowance (any ceiling) keeps paid traffic on the router.
    // (A new prompt, so the router's response cache cannot answer it.)
    state.pool_allowances.observe(&report(Some(1_000_000_000)));
    let mut capped_body = sonnet_body();
    capped_body["messages"][0]["content"] = json!("ping on a capped pool");
    run(Arc::clone(&state), free_credit_ctx(0), capped_body)
        .await
        .expect("router serves a paid caller on a capped pool");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 0);
    assert_eq!(router_calls.load(Ordering::SeqCst), 2);

    state.pool_allowances.observe(&report(None));
    let out = run(Arc::clone(&state), free_credit_ctx(0), sonnet_body())
        .await
        .expect("own supply serves a paid caller");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(router_calls.load(Ordering::SeqCst), 2);
    assert_eq!(out.response["model"], "anthropic/claude-sonnet-4.5");
    assert_eq!(out.provider_used, "ryu");

    let (state, router_calls, slot_calls) = own_supply_state_with(Mode::Fail, Some(paid_runtime()));
    state.pool_allowances.observe(&report(None));
    run(state, free_credit_ctx(0), sonnet_body())
        .await
        .expect("the router route rescues a paid request");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(router_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn an_own_supply_failure_before_output_falls_back_to_the_ryu_router() {
    let (state, router_calls, slot_calls) = own_supply_state(Mode::Fail);
    let out = run(
        Arc::clone(&state),
        free_credit_ctx(5_000_000),
        sonnet_body(),
    )
    .await
    .expect("the router route rescues the request");
    assert_eq!(slot_calls.load(Ordering::SeqCst), 1);
    assert_eq!(router_calls.load(Ordering::SeqCst), 1);
    assert_eq!(out.provider_used, "ryu");

    // An outage that never reached a provider (rate limit) falls back on
    // the streaming path too.
    let (state, router_calls, _) = own_supply_state(Mode::RateLimited);
    let out = super::super::run_stream(state, free_credit_ctx(5_000_000), sonnet_body())
        .await
        .expect("the router route rescues the stream");
    let _ = axum::body::to_bytes(out.body, usize::MAX).await.unwrap();
    assert_eq!(router_calls.load(Ordering::SeqCst), 1);
}

/// A node preference REORDERS the fleet's chain: with the primary demoting,
/// the node's preferred fallback serves before the fleet's default second.
#[tokio::test]
async fn a_node_preference_reorders_the_fleet_fallback_chain() {
    let mut state = three_chain_state();
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
        .expect("the preferred fallback must serve");

    assert_eq!(out.provider_used, "tertiary");
    assert_eq!(
        secondary_calls.load(Ordering::SeqCst),
        0,
        "the fleet's default second was reordered behind the node's preference"
    );
    assert_eq!(tertiary_calls.load(Ordering::SeqCst), 1);
}

/// THE acceptance criterion: a preference may narrow and reorder the org's
/// envelope, never widen it. A provider the fleet's own chain does not
/// contain is never dispatched to, even when it is registered and healthy —
/// because `preflight_credit_gate` only ever gated the PRIMARY's pool.
#[tokio::test]
async fn a_node_preference_can_never_add_a_provider_to_the_chain() {
    let mut state = chain_state(10);
    let (primary, _) = StubProvider::new("primary", Mode::RateLimited);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    // Registered and perfectly healthy, but NOT in the fleet's fallback chain.
    let (offchain, offchain_calls) = StubProvider::new("tertiary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(offchain as Arc<dyn Provider>);
    let state = Arc::new(state);

    let mut ctx = plain_ctx();
    ctx.node_routing = Some(prefs(&["tertiary"]));

    let out = run(Arc::clone(&state), ctx, ping_body())
        .await
        .expect("the fleet's own chain still serves the turn");

    assert_eq!(out.provider_used, "secondary");
    assert_eq!(
        offchain_calls.load(Ordering::SeqCst),
        0,
        "a preference must not route out of a credit pool nothing gated"
    );
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
}

/// An agent limited to one provider is served from it even when another is
/// the primary: the denied primary is skipped like any policy refusal.
#[tokio::test]
async fn agent_provider_access_skips_providers_the_agent_may_not_use() {
    let mut state = chain_state(10);
    let (primary, primary_calls) = StubProvider::new("primary", Mode::Ok);
    let (secondary, secondary_calls) = StubProvider::new("secondary", Mode::Ok);
    state
        .provider_runtime
        .register_for_test(primary as Arc<dyn Provider>);
    state
        .provider_runtime
        .register_for_test(secondary as Arc<dyn Provider>);
    let state = Arc::new(state);

    let mut ctx = plain_ctx();
    ctx.agent_provider_access = provider_access(&["secondary"]);
    let out = run(Arc::clone(&state), ctx, ping_body())
        .await
        .expect("the allowed provider serves the turn");
    assert_eq!(out.provider_used, "secondary");
    assert_eq!(primary_calls.load(Ordering::SeqCst), 0);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);

    // With no provider allowed, nothing is dispatched and the refusal says why.
    let mut ctx = plain_ctx();
    ctx.agent_provider_access = provider_access(&[]);
    ctx.is_master_key = true;
    let Err(error) = run(Arc::clone(&state), ctx, ping_body()).await else {
        panic!("no provider may serve this agent");
    };
    assert!(
        error.to_string().contains("account access"),
        "unexpected error: {error}"
    );
    assert_eq!(primary_calls.load(Ordering::SeqCst), 0);
    assert_eq!(secondary_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn agent_provider_access_allows_only_listed_and_credential_free_slots() {
    let state = AppState::new_for_test_default();
    let none = {
        let mut ctx = plain_ctx();
        ctx.agent_provider_access = provider_access(&[]);
        ctx
    };
    for denied in ["openai", "openrouter", "core", "anthropic", "genai"] {
        assert!(
            crate::pipeline::inference_governance::authorize_agent_provider(
                &state,
                &none,
                &ProviderId::from(denied)
            )
            .is_err(),
            "{denied}"
        );
    }
    for allowed in [
        "local",
        crate::config::CLASSIFY_PROVIDER_ID,
        crate::config::OPENAI_CREDITS_PROVIDER_ID,
        crate::config::BEDROCK_PROVIDER_ID,
        crate::config::CLOUDFLARE_PROVIDER_ID,
        "genai-ollama",
    ] {
        assert!(
            crate::pipeline::inference_governance::authorize_agent_provider(
                &state,
                &none,
                &ProviderId::from(allowed)
            )
            .is_ok(),
            "{allowed}"
        );
    }
    // Gemini's registry id is `genai`; the list carries registry ids.
    let mut gemini = plain_ctx();
    gemini.agent_provider_access = provider_access(&["genai"]);
    assert!(
        crate::pipeline::inference_governance::authorize_agent_provider(
            &state,
            &gemini,
            &ProviderId::from("genai")
        )
        .is_ok()
    );
    assert!(
        crate::pipeline::inference_governance::authorize_agent_provider(
            &state,
            &gemini,
            &ProviderId::from("genai-openai")
        )
        .is_err()
    );
    // No list: unrestricted, as before.
    assert!(
        crate::pipeline::inference_governance::authorize_agent_provider(
            &state,
            &plain_ctx(),
            &ProviderId::from("openai")
        )
        .is_ok()
    );
    // The master key does not bypass an agent's list.
    let mut master = plain_ctx();
    master.is_master_key = true;
    master.agent_provider_access = provider_access(&["anthropic"]);
    assert!(
        crate::pipeline::inference_governance::authorize_provider_region(
            &AppState::new_for_test_default(),
            &master,
            &ProviderId::from("openai")
        )
        .is_err()
    );
    assert!(
        crate::pipeline::inference_governance::authorize_provider_region(
            &AppState::new_for_test_default(),
            &master,
            &ProviderId::from("anthropic")
        )
        .is_ok()
    );
}
