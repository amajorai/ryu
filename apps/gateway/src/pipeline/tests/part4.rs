use super::*;

#[test]
fn reservations_are_skipped_where_they_have_no_business_gating() {
    let state = reserve_state(10_000, 0);
    let body = json!({ "max_tokens": 1 });

    // Unmanaged (BYOK / static key): never gated.
    let mut unmanaged = managed_ctx(0);
    unmanaged.managed_inference = false;
    assert!(maybe_reserve_credit(&state, &unmanaged, &body, None)
        .expect("admitted")
        .is_none());

    // Managed but uncapped (no control-plane budget at all).
    let mut uncapped = managed_ctx(0);
    uncapped.remaining_budget_micro_usd = None;
    assert!(maybe_reserve_credit(&state, &uncapped, &body, None)
        .expect("admitted")
        .is_none());

    // No org to key the claim on.
    let mut orgless = managed_ctx(0);
    orgless.org_id = None;
    assert!(maybe_reserve_credit(&state, &orgless, &body, None)
        .expect("admitted")
        .is_none());
}

#[test]
fn the_kill_switch_restores_the_unreserved_behaviour() {
    let mut state = reserve_state(10_000, 0);
    state.config.credits.reserve_enabled = false;
    let ctx = managed_ctx(1);
    // Same dust balance the reservation path refuses above.
    assert!(maybe_reserve_credit(&state, &ctx, &json!({}), None)
        .expect("admitted")
        .is_none());
}

#[test]
fn the_reservation_is_taken_against_the_same_pool_the_gate_approved() {
    // A tenant whose money is pool-restricted grant credit must be able to
    // spend it: gating on the unrestricted balance alone would 402 them.
    let state = reserve_state(10_000, 0);
    let mut ctx = managed_ctx(0);
    ctx.unrestricted_budget_micro_usd = Some(0);
    ctx.pool_budgets_micro_usd =
        std::collections::HashMap::from([("cloudflare".to_string(), 50_000)]);

    assert!(
        preflight_credit_gate(&ctx, Some("cloudflare")).is_none(),
        "precondition: the gate admits this request on pooled money"
    );
    assert!(
        maybe_reserve_credit(&state, &ctx, &json!({}), Some("cloudflare"))
            .expect("the reservation must see the same pooled headroom")
            .is_some()
    );
    // …and the pool it did NOT route to is still refused.
    assert!(matches!(
        maybe_reserve_credit(&state, &ctx, &json!({}), Some("openrouter")),
        Err(GatewayError::InsufficientCredits)
    ));
}

#[test]
fn preflight_credit_gate_managed_empty_rejects_others_allow() {
    let mut ctx = signal_ctx(None, false, false);
    ctx.org_id = Some("o1".to_string());

    // Non-managed traffic is never gated, even at a zero balance (BYOK /
    // static-key / master paths are exempt).
    ctx.managed_inference = false;
    ctx.remaining_budget_micro_usd = Some(0);
    assert!(preflight_credit_gate(&ctx, None).is_none());

    // Managed + positive balance ⇒ allowed.
    ctx.managed_inference = true;
    ctx.remaining_budget_micro_usd = Some(500);
    assert!(preflight_credit_gate(&ctx, None).is_none());

    // Managed + uncapped (None budget) ⇒ allowed.
    ctx.remaining_budget_micro_usd = None;
    assert!(preflight_credit_gate(&ctx, None).is_none());

    // Managed + exhausted (zero) ⇒ hard 402.
    ctx.remaining_budget_micro_usd = Some(0);
    assert!(matches!(
        preflight_credit_gate(&ctx, None),
        Some(GatewayError::InsufficientCredits)
    ));

    // Managed + overdrawn (negative) ⇒ hard 402.
    ctx.remaining_budget_micro_usd = Some(-5);
    assert!(matches!(
        preflight_credit_gate(&ctx, None),
        Some(GatewayError::InsufficientCredits)
    ));
}

#[test]
fn an_unreadable_managed_tier_answers_503_never_a_wallet_empty_402() {
    // The control plane could not read the tenant's entitlement or wallet
    // (`TenantCredit::accounting_unavailable`): the balance is unknown.
    let mut ctx = managed_ctx(0);
    ctx.remaining_budget_micro_usd = None;
    ctx.unrestricted_budget_micro_usd = None;
    ctx.credit_accounting_unavailable = true;
    for pool in [None, Some("cloudflare")] {
        assert!(matches!(
            preflight_credit_gate(&ctx, pool),
            Some(GatewayError::AccountingUnavailable)
        ));
    }

    let mut config = crate::GatewayConfig::default();
    config.credits.enabled = true;
    config.credits.internal_secret = Some("debit-secret".to_owned());
    config.credits.base_url = "http://control-plane.invalid".to_owned();
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    let state = AppState::new_for_test(config, audit, evals);
    assert!(matches!(
        accounting_unavailable_gate(&state, &ctx),
        Some(GatewayError::AccountingUnavailable)
    ));
    // Not sticky: the next resolve's context carries no flag.
    ctx.credit_accounting_unavailable = false;
    ctx.remaining_budget_micro_usd = Some(500);
    assert!(accounting_unavailable_gate(&state, &ctx).is_none());
    assert!(preflight_credit_gate(&ctx, None).is_none());
}

#[tokio::test]
async fn malformed_successful_debit_marks_managed_accounting_unavailable() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind debit fixture");
    let address = listener.local_addr().expect("debit fixture address");
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/api/credits/debit", post(|| async { "this is not JSON" })),
        )
        .await
        .expect("serve debit fixture");
    });

    let mut state = reserve_state(10_000, 0);
    state.config.credits.enabled = true;
    state.config.credits.base_url = format!("http://{address}");
    state.config.credits.internal_secret = Some("test-internal-secret".to_string());
    state.config.credits.fail_closed = true;
    let state = Arc::new(state);

    debit_wallet_for_request(
        Arc::clone(&state),
        "o1".to_string(),
        "req-malformed-debit".to_string(),
        CreditDebitReason::GatewayUsage,
        1,
        true,
        None,
        None,
        DebitAttribution::default(),
    )
    .await;

    assert!(state.wallet.is_org_accounting_unavailable("o1"));
    server.abort();
}

#[tokio::test]
async fn transient_debit_failure_is_retried_before_the_charge_is_lost() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind debit fixture");
    let address = listener.local_addr().expect("debit fixture address");
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let handler_calls = Arc::clone(&calls);
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/api/credits/debit",
                post(move || {
                    let calls = Arc::clone(&handler_calls);
                    async move {
                        if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                            (
                                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                                "control plane restarting".to_string(),
                            )
                        } else {
                            (
                                axum::http::StatusCode::OK,
                                r#"{"balanceMicroUsd":9000,"applied":true,"duplicate":false,"wentNonPositive":false}"#
                                    .to_string(),
                            )
                        }
                    }
                }),
            ),
        )
        .await
        .expect("serve debit fixture");
    });

    let mut state = reserve_state(10_000, 0);
    state.config.credits.enabled = true;
    state.config.credits.base_url = format!("http://{address}");
    state.config.credits.internal_secret = Some("test-internal-secret".to_string());
    state.config.credits.fail_closed = true;
    let state = Arc::new(state);

    debit_wallet_for_request(
        Arc::clone(&state),
        "o1".to_string(),
        "req-retried-debit".to_string(),
        CreditDebitReason::GatewayUsage,
        1,
        true,
        None,
        None,
        DebitAttribution::default(),
    )
    .await;

    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert!(!state.wallet.is_org_accounting_unavailable("o1"));
    server.abort();
}

#[test]
fn debit_body_carries_the_pool_only_when_the_provider_is_tagged() {
    // Untagged provider ⇒ the pre-pool body, byte-identical. `pool` must be
    // ABSENT, not `null`: the control plane distinguishes the two.
    let legacy = debit_request_body(
        "o1",
        1_234,
        CreditDebitReason::GatewayUsage,
        "req_1",
        None,
        None,
        &DebitAttribution::default(),
    );
    assert_eq!(legacy["orgId"], "o1");
    assert_eq!(legacy["amountMicroUsd"], 1_234);
    assert_eq!(legacy["reason"], "gateway_usage");
    assert_eq!(legacy["refId"], "req_1");
    assert!(legacy.get("pool").is_none());
    assert!(legacy.get("alertTier").is_none());

    // Tagged provider ⇒ the pool id travels verbatim under `pool`. This key
    // and this value are what let the ledger reach pool-restricted grants;
    // renaming either is a control-plane contract change.
    let pooled = debit_request_body(
        "o1",
        1_234,
        CreditDebitReason::GatewayUsage,
        "req_1",
        Some(AlertTier::Warn),
        crate::credit_pools::pool_for_gateway_provider("vertex"),
        &DebitAttribution::default(),
    );
    assert_eq!(pooled["pool"], "vertex");
    // Retired Bedrock is untagged: its debit carries no pool and draws no grant.
    let retired = debit_request_body(
        "o1",
        1_234,
        CreditDebitReason::GatewayUsage,
        "req_1",
        None,
        crate::credit_pools::pool_for_gateway_provider("bedrock"),
        &DebitAttribution::default(),
    );
    assert!(retired.get("pool").is_none());
    assert_eq!(pooled["alertTier"], "warn");
}

/// Attribution is ADDITIVE and every absent field is OMITTED.
///
/// The contract that matters is the same one `pool` and `alertTier` already
/// hold: a control plane that does not know these keys must see a
/// byte-identical legacy body. Sending `null` instead of omitting would
/// satisfy a naive "is it there" check while writing an explicit null into
/// a column whose whole meaning is "not reported".
#[test]
fn debit_body_omits_attribution_it_was_not_given() {
    let bare = debit_request_body(
        "o1",
        10,
        CreditDebitReason::GatewayUsage,
        "req_1",
        None,
        None,
        &DebitAttribution::default(),
    );
    for key in [
        "provider",
        "upstreamProvider",
        "model",
        "userId",
        "taskLabel",
        "inputTokens",
        "outputTokens",
        "durationMs",
        "estimated",
        "keyId",
        "teamIds",
        "projectId",
        "botId",
    ] {
        assert!(bare.get(key).is_none(), "{key} must be absent, not null");
    }

    let full = debit_request_body(
        "o1",
        10,
        CreditDebitReason::GatewayUsage,
        "req_1",
        None,
        None,
        &DebitAttribution {
            provider: Some("openrouter".to_string()),
            upstream_provider: Some("Google Vertex".to_string()),
            model: Some("google/gemini-2.5-flash".to_string()),
            input_tokens: Some(4_210),
            output_tokens: Some(380),
            duration_ms: Some(2_140),
            user_id: Some("u_1".to_string()),
            task_label: Some("3 tool calls".to_string()),
            estimated: None,
            tags: vec!["checkout".to_string(), "eu".to_string()],
            scope: Default::default(),
        },
    );
    assert_eq!(full["provider"], "openrouter");
    assert_eq!(full["upstreamProvider"], "Google Vertex");
    assert_eq!(full["model"], "google/gemini-2.5-flash");
    assert_eq!(full["inputTokens"], 4_210);
    assert_eq!(full["outputTokens"], 380);
    assert_eq!(full["durationMs"], 2_140);
    assert_eq!(full["userId"], "u_1");
    assert_eq!(full["taskLabel"], "3 tool calls");
    // Builder tags ride on the debit; an untagged debit omits the key.
    assert_eq!(full["tags"], serde_json::json!(["checkout", "eu"]));
    let untagged = debit_request_body(
        "org",
        1,
        CreditDebitReason::GatewayUsage,
        "req_2",
        None,
        None,
        &DebitAttribution::default(),
    );
    assert!(untagged.get("tags").is_none());
}

#[test]
fn accepted_media_calls_have_distinct_debits_and_stable_retry_references() {
    let first = media_debit_reference(&Modality::Image);
    let second = media_debit_reference(&Modality::Image);
    assert_ne!(first, second);
    assert!(first.ends_with(":image"));
    let body = debit_request_body(
        "org",
        250_000,
        CreditDebitReason::GatewayUsage,
        &first,
        None,
        None,
        &DebitAttribution::default(),
    );
    let retry = debit_request_body(
        "org",
        250_000,
        CreditDebitReason::GatewayUsage,
        &first,
        None,
        None,
        &DebitAttribution::default(),
    );
    assert_eq!(body["refId"], retry["refId"]);
    let another = debit_request_body(
        "org",
        250_000,
        CreditDebitReason::GatewayUsage,
        &second,
        None,
        None,
        &DebitAttribution::default(),
    );
    assert_ne!(body["refId"], another["refId"]);
}

/// A blank string is not a value. An empty-string model on a ledger row
/// renders as a present-but-nameless model, which reads as a bug to whoever
/// is looking at their invoice — strictly worse than an honest blank.
#[test]
fn debit_body_treats_a_blank_attribution_string_as_absent() {
    let blank = debit_request_body(
        "o1",
        10,
        CreditDebitReason::GatewayUsage,
        "req_1",
        None,
        None,
        &DebitAttribution {
            provider: Some("   ".to_string()),
            model: Some(String::new()),
            ..Default::default()
        },
    );
    assert!(blank.get("provider").is_none());
    assert!(blank.get("model").is_none());
}

/// The ledger names own-supply work by the Ryu Router id the user knows
/// (else the Ryu alias), never the supplier's model id; the same id on a
/// BYOK slot keeps its real name.
#[test]
fn debit_body_records_the_user_facing_id_for_an_own_supply_model() {
    let attribution = |provider: &str, model: &str| DebitAttribution {
        provider: Some(provider.to_string()),
        model: Some(model.to_string()),
        ..Default::default()
    };
    let body = |a: &DebitAttribution| {
        debit_request_body(
            "o1",
            10,
            CreditDebitReason::GatewayUsage,
            "req_1",
            None,
            Some("openai-credits"),
            a,
        )
    };
    let managed = body(&attribution("openai-credits", "o3"));
    assert_eq!(managed["model"], "openai/o3");
    let code = body(&attribution("anthropic-credits", "claude-haiku-4-5"));
    assert_eq!(code["model"], "anthropic/claude-haiku-4.5");
    // No Ryu Router equivalent: still the alias, never the supplier id.
    let fast = body(&attribution("cloudflare", "@cf/qwen/qwen1.5-14b-chat-awq"));
    assert_eq!(fast["model"], "ryu-fast/max");
    let byok = body(&attribution("anthropic", "claude-haiku-4-5"));
    assert_eq!(byok["model"], "claude-haiku-4-5");
}

#[test]
fn media_fallback_is_marked_in_the_existing_ledger_task_label() {
    let estimated = debit_request_body(
        "o1",
        1_950,
        CreditDebitReason::GatewayUsage,
        "req_1:image",
        None,
        None,
        &DebitAttribution {
            provider: Some("replicate".to_string()),
            model: Some("image-model".to_string()),
            task_label: Some(media_task_label(&Modality::Image, true)),
            estimated: Some(true),
            ..Default::default()
        },
    );
    assert_eq!(estimated["taskLabel"], "image (estimated cost)");
    assert_eq!(estimated["estimated"], true);

    let measured = debit_request_body(
        "o1",
        2_925,
        CreditDebitReason::GatewayUsage,
        "req_2:image",
        None,
        None,
        &DebitAttribution {
            task_label: Some(media_task_label(&Modality::Image, false)),
            duration_ms: Some(3_000),
            estimated: Some(false),
            ..Default::default()
        },
    );
    assert_eq!(measured["taskLabel"], "image");
    assert_eq!(measured["durationMs"], 3_000);
    assert_eq!(measured["estimated"], false);
}
