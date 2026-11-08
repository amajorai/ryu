use super::*;

#[test]
fn concurrent_managed_requests_cannot_all_spend_one_balance() {
    // THE REGRESSION GUARD. Post-paid metering means nothing debits until a
    // request finishes, so without the reservation every one of these sees
    // the same balance and every one is admitted.
    let state = reserve_state(10_000, 0);
    let ctx = managed_ctx(50_000); // $0.05 ⇒ five $0.01 reservations
    let body = json!({ "max_tokens": 1 });

    let held: Vec<_> = (0..5)
        .map(|_| {
            maybe_reserve_credit(&state, &ctx, &body, None)
                .expect("within balance")
                .expect("a managed tenant takes a real permit")
        })
        .collect();
    assert_eq!(held.len(), 5);

    assert!(
        matches!(
            maybe_reserve_credit(&state, &ctx, &body, None),
            Err(GatewayError::InsufficientCredits)
        ),
        "the sixth concurrent request must get the same 402 as an empty wallet"
    );

    // Finishing the in-flight work returns the headroom.
    drop(held);
    assert!(maybe_reserve_credit(&state, &ctx, &body, None).is_ok());
}

#[test]
fn a_dust_balance_no_longer_admits_an_expensive_request() {
    // The old gate asked `balance <= 0`, so one micro-USD bought a frontier
    // call. The gate is now the ESTIMATE against the balance.
    let state = reserve_state(10_000, 0);
    let ctx = managed_ctx(1);
    assert!(matches!(
        maybe_reserve_credit(&state, &ctx, &json!({}), None),
        Err(GatewayError::InsufficientCredits)
    ));
}

#[test]
fn an_unstated_ceiling_becomes_the_affordable_one() {
    // THE OVERDRAFT GUARD. Naming no ceiling used to reserve the $0.01 floor
    // and then generate without limit, so a dust balance could front an
    // arbitrarily expensive completion. It now gets the largest ceiling the
    // balance actually covers.
    let state = reserve_state(10_000, 1000); // 1000 micro-USD per 1k tokens
    let ctx = managed_ctx(50_000); // $0.05 ⇒ 50k tokens at that rate
    let body = clamped(&state, &ctx, json!({ "messages": [] }));
    assert_eq!(body["max_tokens"], json!(50_000));
}

#[test]
fn a_ceiling_the_balance_cannot_cover_is_lowered() {
    let state = reserve_state(10_000, 1000);
    let ctx = managed_ctx(50_000);
    let body = clamped(&state, &ctx, json!({ "max_tokens": 1_000_000 }));
    assert_eq!(body["max_tokens"], json!(50_000));
}

#[test]
fn a_ceiling_within_budget_is_left_exactly_alone() {
    // Asking for less than you can afford is a preference, not a budget —
    // the clamp only ever lowers.
    let state = reserve_state(10_000, 1000);
    let ctx = managed_ctx(50_000);
    let body = clamped(&state, &ctx, json!({ "max_tokens": 128 }));
    assert_eq!(body["max_tokens"], json!(128));
}

#[test]
fn an_expensive_model_gets_a_tighter_ceiling_than_the_flat_rate_would() {
    // THE RESIDUAL THE OVERDRAFT FIX LEFT. Priced at the flat 1000/1k this
    // balance buys 50k tokens; the model actually costs 10x that, so the
    // flat rate authorised 10x more generation than the org could pay for —
    // and it did so on precisely the frontier models where the overdraft is
    // worth having.
    let state = priced_state(10_000, 1000, "frontier-", 10_000);
    let ctx = managed_ctx(50_000);
    let body = clamped(
        &state,
        &ctx,
        json!({ "model": "frontier-xl-2026", "messages": [] }),
    );
    assert_eq!(body["max_tokens"], json!(5000));
}

#[test]
fn a_pool_alias_clamps_against_its_selected_upstream_model() {
    let state = priced_state(10_000, 1000, "frontier-", 10_000);
    let ctx = managed_ctx(50_000);
    let mut body = json!({ "model": "balanced-chat", "messages": [] });
    let mut decision = RouteDecision {
        provider: ProviderId::from("openai"),
        model: "frontier-xl-2026".to_owned(),
    };
    let outcome = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        BudgetChargeKind::Model,
        OutputCeiling::Clamp,
    )
    .expect("resolved member can be admitted");
    assert_eq!(body["max_tokens"], json!(5000));
    assert_eq!(body["model"], "balanced-chat");
    assert!(outcome.reservation.is_some());
}

#[test]
fn a_cheap_model_is_not_truncated_by_a_blended_rate() {
    // The other half of the same bug: a blended rate charges a cheap model
    // as though it were expensive and cuts completions the org could always
    // afford.
    let state = priced_state(10_000, 1000, "cheap-", 100);
    let ctx = managed_ctx(50_000);
    let body = clamped(
        &state,
        &ctx,
        json!({ "model": "cheap-mini", "messages": [] }),
    );
    assert_eq!(body["max_tokens"], json!(500_000));
}

#[test]
fn the_prompt_is_netted_out_of_the_output_ceiling_and_the_claim() {
    // THE OVERDRAW THE OUTPUT-ONLY ESTIMATE LEFT. A $1 wallet asking for
    // 500k output tokens at the flat 2_000/1k was admitted for the whole
    // balance in output alone, and its prompt was billed on top.
    let state = reserve_state(10_000, 2_000);
    let ctx = managed_ctx(1_000_000);
    // 250k prompt tokens cost $0.50, leaving $0.50 = 250k output tokens.
    let mut body = prompt_body(250_000, Some(500_000));
    let outcome = admit_chat(&state, &ctx, &mut body).expect("the prompt fits the balance");
    assert_eq!(body["max_tokens"], json!(250_000));
    assert!(outcome.reservation.is_some());
    // The claim covers prompt plus output: the whole balance, not more.
    assert_eq!(state.wallet.in_flight_micro_usd("o1"), 1_000_000);
}

#[test]
fn a_prompt_the_balance_cannot_cover_is_refused_before_dispatch() {
    let state = reserve_state(10_000, 1_000);
    // 10k prompt tokens cost 10_000 micro-USD; the balance is 5_000.
    let ctx = managed_ctx(5_000);
    for max_tokens in [None, Some(100)] {
        let mut body = prompt_body(10_000, max_tokens);
        assert!(matches!(
            admit_chat(&state, &ctx, &mut body),
            Err(GatewayError::InsufficientCredits)
        ));
        assert_eq!(body.get("max_tokens").and_then(Value::as_u64), max_tokens);
    }
    assert_eq!(state.wallet.in_flight_micro_usd("o1"), 0);
}

#[test]
fn the_chat_claim_prices_output_at_the_routed_model_rate() {
    // 1_000 output tokens of a 10_000/1k model is 10_000 micro-USD, ten
    // times the flat-rate figure the claim used to take.
    let state = priced_state(1, 1_000, "frontier-", 10_000);
    let ctx = managed_ctx(1_000_000);
    let body = json!({ "messages": [], "max_tokens": 1_000 });
    assert_eq!(
        chat_reservation_estimate_micro_usd(&state, &body, "frontier-xl"),
        10_000
    );
    assert_eq!(reservation_estimate_micro_usd(&state, &body), 1_000);
    drop(ctx);
}

#[test]
fn a_debit_reported_after_the_resolve_lowers_the_headroom() {
    // The resolved balance is cached for up to a minute. A debit that
    // reports a lower balance since then is the fresher figure.
    let state = reserve_state(10_000, 1000);
    let mut ctx = managed_ctx(1_000_000);
    ctx.budget_resolved_at = Some(Instant::now());
    // Unchanged while no debit has reported a balance.
    assert_eq!(
        credit_headroom_micro_usd(&state, &ctx, None),
        Some(1_000_000)
    );
    let body = clamped(&state, &ctx, json!({ "messages": [] }));
    assert_eq!(body["max_tokens"], json!(1_000_000));

    tick();
    state.wallet.set_org_balance("o1", 250_000);
    assert_eq!(credit_headroom_micro_usd(&state, &ctx, None), Some(250_000));
    let body = clamped(&state, &ctx, json!({ "messages": [] }));
    assert_eq!(body["max_tokens"], json!(250_000));
    // Figures that did not come from a resolve are left alone.
    let mut unresolved = ctx.clone();
    unresolved.budget_resolved_at = None;
    assert_eq!(
        credit_headroom_micro_usd(&state, &unresolved, None),
        Some(1_000_000)
    );

    // The whole 750_000 drop comes off a pooled request's headroom too:
    // the report does not say which bucket paid.
    let mut pooled = ctx.clone();
    pooled.unrestricted_budget_micro_usd = Some(600_000);
    pooled.pool_budgets_micro_usd =
        std::collections::HashMap::from([("cloudflare".to_owned(), 400_000)]);
    assert_eq!(
        credit_headroom_micro_usd(&state, &pooled, Some("cloudflare")),
        Some(250_000)
    );
    assert_eq!(
        credit_headroom_micro_usd(&state, &pooled, None),
        Some(-150_000)
    );

    // A report above the resolved total (a top-up) never raises it...
    tick();
    state.wallet.set_org_balance("o1", 5_000_000);
    assert_eq!(
        credit_headroom_micro_usd(&state, &ctx, None),
        Some(1_000_000)
    );
    // ...and a request resolved after the report uses its own figure.
    tick();
    state.wallet.set_org_balance("o1", 250_000);
    tick();
    let mut fresh = ctx.clone();
    fresh.budget_resolved_at = Some(Instant::now());
    assert_eq!(
        credit_headroom_micro_usd(&state, &fresh, None),
        Some(1_000_000)
    );
}

#[test]
fn another_entry_resolving_later_does_not_hide_a_debit_from_this_one() {
    // t=0 the chat entry resolves at $1; t=5 a debit reports $0.10; t=20
    // the org's web-search entry (or another key) resolves. Resolutions
    // are cached per credential and operation, so chat requests still
    // carry the t=0 figure and must still see the t=5 report.
    let state = reserve_state(10_000, 1000);
    let mut chat = managed_ctx(1_000_000);
    chat.budget_resolved_at = Some(Instant::now());
    tick();
    state.wallet.set_org_balance("o1", 100_000);
    tick();
    let mut other_entry = managed_ctx(100_000);
    other_entry.budget_resolved_at = Some(Instant::now());

    assert_eq!(
        credit_headroom_micro_usd(&state, &chat, None),
        Some(100_000)
    );
    let body = clamped(&state, &chat, json!({ "messages": [] }));
    assert_eq!(body["max_tokens"], json!(100_000));
    // The later entry already holds the reported figure: no adjustment.
    assert_eq!(
        credit_headroom_micro_usd(&state, &other_entry, None),
        Some(100_000)
    );
}

#[test]
fn a_failed_attempts_claim_shrinks_to_what_its_rounds_cost() {
    // A failed tool-loop attempt holds its claim until its debit
    // resolves. Shrunk to the rounds' cost, the fallback attempt does not
    // have to fit alongside the failed attempt's whole estimate.
    let state = reserve_state(10_000, 1000);
    let ctx = managed_ctx(1_000_000);
    let claim = state.wallet.try_reserve("o1", 900_000, 1_000_000);
    let held = shrink_credit_claim(&state, &ctx, claim, 3_000);
    assert_eq!(state.wallet.in_flight_micro_usd("o1"), 3_000);
    // The fallback attempt fits next to it.
    assert!(state.wallet.try_reserve("o1", 990_000, 1_000_000).is_some());
    drop(held);
    // A claim is never grown, and no claim stays none.
    let claim = state.wallet.try_reserve("o1", 2_000, 1_000_000);
    let held = shrink_credit_claim(&state, &ctx, claim, 50_000);
    assert_eq!(
        held.as_ref().map(CreditReservation::amount_micro_usd),
        Some(2_000)
    );
    drop(held);
    assert!(shrink_credit_claim(&state, &ctx, None, 50_000).is_none());
    assert_eq!(state.wallet.in_flight_micro_usd("o1"), 0);
}

#[test]
fn parallel_requests_after_a_large_debit_cannot_claim_the_spent_balance() {
    // A $1 resolve is cached, then a debit reports $0.10 left. Gated on
    // the cached figure alone, the next request was admitted for a
    // 490_000-token ceiling and a $1 claim.
    let state = reserve_state(10_000, 2_000);
    let mut ctx = managed_ctx(1_000_000);
    ctx.budget_resolved_at = Some(Instant::now());
    tick();
    state.wallet.set_org_balance("o1", 100_000);

    // A 10k-token prompt costs 20_000; 80_000 buys 40_000 output tokens.
    let mut body = prompt_body(10_000, Some(500_000));
    let admitted = admit_chat(&state, &ctx, &mut body).expect("the fresh balance covers it");
    assert_eq!(body["max_tokens"], json!(40_000));
    assert_eq!(state.wallet.in_flight_micro_usd("o1"), 100_000);

    // A parallel request finds nothing left of the reported balance.
    let mut parallel = prompt_body(10_000, Some(500_000));
    assert!(matches!(
        admit_chat(&state, &ctx, &mut parallel),
        Err(GatewayError::InsufficientCredits)
    ));
    drop(admitted);
    assert_eq!(state.wallet.in_flight_micro_usd("o1"), 0);
}

#[test]
fn a_model_absent_from_the_table_falls_back_to_the_flat_rate() {
    let state = priced_state(10_000, 1000, "frontier-", 10_000);
    let ctx = managed_ctx(50_000);
    let body = clamped(
        &state,
        &ctx,
        json!({ "model": "something-unpriced", "messages": [] }),
    );
    assert_eq!(body["max_tokens"], json!(50_000));
}

#[test]
fn the_clamp_writes_back_the_spelling_the_client_used() {
    // Adding `max_tokens` next to a `max_completion_tokens` the client sent
    // leaves both present, which some providers reject outright.
    let state = reserve_state(10_000, 1000);
    let ctx = managed_ctx(50_000);
    let body = clamped(&state, &ctx, json!({ "max_completion_tokens": 1_000_000 }));
    assert_eq!(body["max_completion_tokens"], json!(50_000));
    assert!(
        body.get("max_tokens").is_none(),
        "must not add the other spelling alongside it"
    );
}

#[test]
fn the_clamp_is_net_of_this_orgs_in_flight_claims() {
    // Clamping against the GROSS balance would let concurrent unbounded
    // requests each size themselves at the whole wallet — the first would
    // claim all of it and its siblings would 402. That is a race, not a
    // bound. Each concurrent request must get a smaller honest ceiling.
    let state = reserve_state(10_000, 1000);
    let ctx = managed_ctx(50_000);
    let held = maybe_reserve_credit(&state, &ctx, &json!({ "max_tokens": 30_000 }), None)
        .expect("within balance")
        .expect("a managed tenant takes a real permit");
    // $0.05 balance less the $0.03 already claimed leaves 20k tokens' worth.
    let body = clamped(&state, &ctx, json!({ "messages": [] }));
    assert_eq!(body["max_tokens"], json!(20_000));
    drop(held);
}

#[test]
fn the_clamp_leaves_non_text_bodies_untouched() {
    // `run_multimodal` and `submit_video_job` share `enforce_budget`, and a
    // token ceiling is meaningless — at best ignored, at worst rejected as an
    // unknown field.
    let state = reserve_state(10_000, 1000);
    let ctx = managed_ctx(50_000);
    let mut body = json!({ "prompt": "a cat" });
    clamp_output_ceiling(&state, &ctx, &mut body, "", None, OutputCeiling::Untouched)
        .expect("non-text bodies are never refused here");
    assert_eq!(body, json!({ "prompt": "a cat" }));
}

#[test]
fn the_clamp_spares_tenants_who_are_not_spending_our_money() {
    // BYOK/unmanaged traffic has no managed cap to clamp against, and
    // imposing a ceiling on it would be a pure regression.
    let state = reserve_state(10_000, 1000);
    let mut unmanaged = managed_ctx(50_000);
    unmanaged.managed_inference = false;
    let body = clamped(&state, &unmanaged, json!({ "messages": [] }));
    assert!(body.get("max_tokens").is_none());

    // Managed but uncapped: no control-plane budget at all.
    let mut uncapped = managed_ctx(50_000);
    uncapped.remaining_budget_micro_usd = None;
    let body = clamped(&state, &uncapped, json!({ "messages": [] }));
    assert!(body.get("max_tokens").is_none());
}

#[test]
fn a_node_that_meters_nothing_imposes_no_ceiling() {
    // A zero per-token rate cannot overdraw anyone, so there is nothing to
    // bound — and dividing by it must not be mistaken for "afford nothing".
    let state = reserve_state(10_000, 0);
    let ctx = managed_ctx(50_000);
    let body = clamped(&state, &ctx, json!({ "messages": [] }));
    assert!(body.get("max_tokens").is_none());
}

#[test]
fn the_ceiling_accounts_for_the_billing_markup() {
    // The budget is denominated in CHARGED micro-USD but a token count costs
    // RAW provider micro-USD. Sizing the ceiling without undoing the markup
    // hands out one the debit then exceeds — the very overdraft this closes.
    let mut state = reserve_state(10_000, 1000);
    state.config.credits.markup_bps = 10_000; // +100%: charged = 2x raw
    let ctx = managed_ctx(50_000);
    let body = clamped(&state, &ctx, json!({ "messages": [] }));
    // $0.05 of BUDGET buys $0.025 of raw provider spend = 25k tokens.
    assert_eq!(body["max_tokens"], json!(25_000));
}
