use super::*;

#[test]
fn unroutable_or_disallowed_rows_give_no_plan() {
    let ctx = ctx(0, &[("openai-credits", 5_000)]);
    // No canary / quarantined here.
    assert_eq!(
        served(
            "openai/o3",
            &ctx,
            &Supply::all().blocking("openai-credits", "o3")
        ),
        None
    );
    // The caller's policy does not allow the picked id.
    assert_eq!(
        served("openai/o3", &ctx, &Supply::all().denying("openai/o3")),
        None
    );
    // Several slots: an unroutable one is skipped for the next (the caller holds
    // credit for both pools).
    let ctx = super::super::tests::ctx(0, &[("vertex", 5_000), ("cloudflare", 5_000)]);
    let supply = Supply::all()
        .with_table(published(
            &[
                ("x/model", "vertex", "x/model-v1", 0),
                ("x/model", "cloudflare", "@cf/x/model", 1),
            ],
            &[],
        ))
        .blocking("vertex", "x/model-v1");
    assert_eq!(served("x/model", &ctx, &supply).unwrap().slot, "cloudflare");
}

#[test]
fn the_default_model_comes_from_the_published_pool_defaults() {
    let ctx = ctx(0, &[("cloudflare", 9_000)]);
    let supply = Supply::all().with_table(published(
        &[
            (
                "meta-llama/llama-3.3-70b-instruct",
                "cloudflare",
                "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
                0,
            ),
            (
                "meta-llama/llama-3.1-8b-instruct",
                "cloudflare",
                "@cf/meta/llama-3.1-8b-instruct",
                0,
            ),
        ],
        &[("cloudflare", "meta-llama/llama-3.3-70b-instruct")],
    ));
    let plan = served("openrouter/auto", &ctx, &supply).unwrap();
    assert_eq!(plan.shown_model, "meta-llama/llama-3.3-70b-instruct");
    assert_eq!(plan.upstream, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    // No default for the pool: the normal route.
    let no_default = Supply::all().with_table(published(
        &[(
            "meta-llama/llama-3.1-8b-instruct",
            "cloudflare",
            "@cf/meta/llama-3.1-8b-instruct",
            0,
        )],
        &[],
    ));
    assert_eq!(served("openrouter/auto", &ctx, &no_default), None);
}

#[test]
fn only_a_structured_not_found_or_refused_credential_marks_the_row_unavailable() {
    assert!(is_row_unavailable(&rejected(
        404,
        "anthropic-credits returned 404: model not_found"
    )));
    assert!(is_row_unavailable(&rejected(401, "invalid x-api-key")));
    // A 403 is how an upstream refuses one request's content: it must not
    // take the row away from every other caller.
    assert!(!is_row_unavailable(&rejected(403, "HTTP 403 Forbidden")));
    assert!(!is_row_unavailable(&rejected(400, "model not found")));
    // Message text never decides: it can echo the request.
    for message in [
        "HTTP 403 Forbidden",
        "404 not found",
        "model does not exist",
        "no access",
        "not available",
    ] {
        assert!(
            !is_row_unavailable(&GatewayError::ProviderError(message.into())),
            "{message}"
        );
        assert!(
            !is_row_unavailable(&GatewayError::NoProvider(message.into())),
            "{message}"
        );
    }
    assert!(!is_row_unavailable(&GatewayError::ProviderRateLimited {
        provider: "bedrock".into(),
        retry_after: None,
        reset_at: None,
    }));
    for outcome in safety_outcomes() {
        assert!(!is_row_unavailable(&outcome), "{outcome:?}");
    }
}

#[test]
fn safety_outcomes_and_upstream_refusals_never_fall_back_to_the_ryu_router() {
    let plain = super::super::super::test_support::plain_request_context();
    for outcome in safety_outcomes() {
        assert!(!may_fall_back(&outcome, &plain), "{outcome:?}");
    }
    for status in [400, 401, 403, 404, 409, 413, 422, 451] {
        assert!(
            !may_fall_back(&rejected(status, "refused"), &plain),
            "{status}"
        );
    }
    // A 402 is an upstream 4xx: it is returned, not re-run.
    assert!(!may_fall_back(
        &GatewayError::ProviderPaymentRequired {
            provider: "anthropic-credits".into(),
            message: "credit balance too low".into(),
        },
        &plain
    ));
    // Benign controls: genuine health faults and capacity still move a
    // free-credit caller to the Ryu Router route.
    assert!(may_fall_back(
        &GatewayError::ProviderError("anthropic error 503".into()),
        &plain
    ));
    assert!(may_fall_back(
        &GatewayError::ProviderTransport("connection failed".into()),
        &plain
    ));
    assert!(may_fall_back(
        &GatewayError::ProviderRateLimited {
            provider: "anthropic-credits".into(),
            retry_after: Some(1),
            reset_at: None,
        },
        &plain
    ));
}

#[test]
fn only_pre_output_failures_without_a_tool_loop_fall_back() {
    let plain = super::super::super::test_support::plain_request_context();
    assert!(may_fall_back(
        &GatewayError::CircuitOpen("anthropic-credits".into()),
        &plain
    ));
    assert!(may_fall_back(&GatewayError::InsufficientCredits, &plain));
    assert!(!may_fall_back(
        &GatewayError::ProviderDeliveryUncertain("x".into()),
        &plain
    ));
    assert!(!may_fall_back(&GatewayError::BudgetExceeded(None), &plain));
    let mut tools = plain;
    tools.tools_header_present = true;
    assert!(!may_fall_back(
        &GatewayError::ProviderError("x".into()),
        &tools
    ));
}

#[test]
fn an_approved_alias_authorizes_its_own_upstream_route_only() {
    let state = crate::state::AppState::new_for_test_default();
    let mut ctx = super::super::super::test_support::plain_request_context();
    ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
        approved_models: vec!["ryu-code/max".to_owned()],
        ..crate::policy::EffectivePolicy::default()
    });
    let route = |provider: &str, model: &str| super::super::super::RouteDecision {
        provider: crate::config::ProviderId::from(provider),
        model: model.to_owned(),
    };
    assert!(super::super::super::authorize_routed_model(
        &state,
        &ctx,
        "ryu-code/max",
        &route("anthropic-credits", "claude-opus-4-5"),
    )
    .is_ok());
    // Anything else the route turns into is still checked.
    assert!(super::super::super::authorize_routed_model(
        &state,
        &ctx,
        "ryu-code/max",
        &route("anthropic", "claude-opus-4-5"),
    )
    .is_err());
    assert!(super::super::super::authorize_routed_model(
        &state,
        &ctx,
        "claude-opus-4-5",
        &route("anthropic-credits", "claude-opus-4-5"),
    )
    .is_err());
}

#[test]
fn own_supply_never_shares_a_fallback_chain() {
    use crate::config::ProviderId;
    let chain = || {
        [
            "anthropic-credits",
            "anthropic",
            "bedrock",
            "openrouter",
            "local",
        ]
        .map(ProviderId::from)
        .to_vec()
    };
    let lane = |primary: &str| {
        super::super::super::keep_own_supply_in_its_lane(&ProviderId::from(primary), chain())
            .iter()
            .map(|p| p.as_str().to_owned())
            .collect::<Vec<_>>()
    };
    assert_eq!(lane("anthropic-credits"), ["anthropic-credits"]);
    assert_eq!(lane("anthropic"), ["anthropic", "openrouter", "local"]);
    assert_eq!(lane("openrouter"), ["anthropic", "openrouter", "local"]);
}

#[test]
fn grant_money_reaches_only_its_own_pool_plus_retired_pools() {
    let ctx = ctx(
        0,
        &[
            ("azure-credits", 700),
            ("vertex", 50),
            ("bedrock", 20),
            ("openrouter", 9),
        ],
    );
    let reachable = |pool: &str| super::super::super::grant_money_reachable_from(&ctx, pool);
    // Own supply: its own pool's grants plus the retired Bedrock grant.
    assert_eq!(reachable("azure-credits"), 720);
    assert_eq!(reachable("vertex"), 70);
    assert_eq!(reachable("cloudflare"), 20);
    // Retail reaches only its own pool's grants; BYOK-style unknown pools none.
    assert_eq!(reachable("openrouter"), 9);
    assert_eq!(reachable("not-a-pool"), 0);
}
