use super::*;

/// The spendable headroom `preflight_credit_gate` judges a request against, or
/// `None` when the org has no managed cap at all.
///
/// Factored out of the gate so the RESERVATION is taken against exactly the
/// number the gate approved. Deriving them separately is how a request gets
/// admitted against pooled grant money and then reserved against the
/// unrestricted balance — two different figures, and the mismatch would surface
/// as spurious 402s for tenants whose money is mostly in grants.
/// What [`enforce_budget`] hands back.
///
/// A struct rather than the old `(Option<BudgetDecision>, Option<PolicyAlert>)`
/// tuple because of the third member: `reservation` is an RAII permit whose
/// DROP releases the org's claimed headroom, so where it lives is load-bearing
/// rather than incidental. A tuple invites `let (budget, alert) = …?;`, which
/// silently drops a third element — releasing the claim the instant it was taken
/// and turning the whole mechanism into a no-op that still compiles and still
/// passes every test that does not run two requests at once. Naming the field
/// makes ignoring it something you have to write down.
#[derive(Default)]
pub(super) struct BudgetOutcome {
    pub(super) decision: Option<BudgetDecision>,
    pub(super) alert: Option<PolicyAlert>,
    /// HOLD THIS FOR AS LONG AS THE REQUEST RUNS. Dropping it early re-admits
    /// everything it was holding back.
    pub(super) reservation: Option<CreditReservation>,
    /// HOLD THIS until the request's spend is recorded against the local
    /// user/agent/session counters. It is this request's in-flight claim on
    /// those caps; dropping it early lets a parallel burst overshoot them.
    pub(super) budget_hold: Option<BudgetHold>,
}

/// Take a reservation for this request, or refuse it with the pre-flight 402.
///
/// `Ok(None)` is the ADMITTED-WITHOUT-A-CLAIM case and covers every request the
/// reservation layer has no business gating: reservations switched off, a
/// non-managed / BYOK tenant, and an org with no managed cap at all. Those are
/// exactly the callers for whom `credit_headroom_micro_usd` returns `None`, so
/// the absence of a cap stays a single concept rather than being re-derived
/// here with a slightly different meaning.
pub(super) fn maybe_reserve_credit(
    state: &AppState,
    ctx: &RequestContext,
    body: &Value,
    pool: Option<&str>,
) -> Result<Option<CreditReservation>, GatewayError> {
    if !state.config.credits.reserve_enabled {
        return Ok(None);
    }
    reserve_credit_estimate(
        state,
        ctx,
        pool,
        reservation_estimate_micro_usd(state, body),
    )
}

/// Claim `estimate` against this org's headroom, with the same no-claim cases
/// as [`maybe_reserve_credit`].
pub(super) fn reserve_credit_estimate(
    state: &AppState,
    ctx: &RequestContext,
    pool: Option<&str>,
    estimate: i64,
) -> Result<Option<CreditReservation>, GatewayError> {
    if !state.config.credits.reserve_enabled {
        return Ok(None);
    }
    let Some(org_id) = ctx.org_id.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let Some(headroom) = credit_headroom_micro_usd(state, ctx, pool) else {
        return Ok(None);
    };
    state
        .wallet
        .try_reserve(org_id, estimate, headroom)
        .map(Some)
        .ok_or(GatewayError::InsufficientCredits)
}

pub(crate) fn credit_headroom_micro_usd(
    state: &AppState,
    ctx: &RequestContext,
    pool: Option<&str>,
) -> Option<i64> {
    if !ctx.managed_inference {
        return None;
    }
    let total = ctx.remaining_budget_micro_usd?;
    let unrestricted = ctx.unrestricted_budget_micro_usd.unwrap_or(total);
    let resolved = match pool {
        None => unrestricted,
        Some(pool) => unrestricted.saturating_add(grant_money_reachable_from(ctx, pool)),
    };
    Some(resolved.saturating_sub(spent_since_resolve(state, ctx, total)))
}

/// The caller's grant money a request routed to `pool` may spend.
///
/// Ryu's own supply ([`crate::credit_pools::is_own_supply_pool`]) reaches the
/// caller's free credit of EVERY pool — that is the free-credit rule, mirrored by
/// `debitWallet` on the control plane, which draws grants of any pool for an
/// own-supply debit. Anything else (the retail OpenRouter pass-through) reaches
/// only grants of its own pool, exactly as before.
pub(super) fn grant_money_reachable_from(ctx: &RequestContext, pool: &str) -> i64 {
    if crate::credit_pools::is_own_supply_pool(pool) {
        return free_credit_micro_usd(ctx);
    }
    ctx.pool_budgets_micro_usd
        .get(pool)
        .copied()
        .unwrap_or_default()
}

/// The caller's free credit: every pool's remaining grant money (negative
/// remainders are clamped, they are not debt against another pool).
pub(super) fn free_credit_micro_usd(ctx: &RequestContext) -> i64 {
    ctx.pool_budgets_micro_usd
        .values()
        .fold(0_i64, |sum, value| sum.saturating_add((*value).max(0)))
}

/// How much of the org's balance a debit newer than this request's resolve
/// reports as already spent, in micro-USD; `0` when no newer report exists.
///
/// The resolved budget is cached for up to a minute. After a large debit,
/// parallel requests gated on that figure alone would each spend the money
/// the debit already took. The debit response carries the balance after it,
/// so the drop from the resolved TOTAL to that report comes off the headroom.
///
/// Only a drop counts. A report above the resolved total (a top-up or grant
/// since the resolve) does not raise the headroom: the report is a blended
/// total, and new pool-restricted grant money must not admit a request it
/// cannot pay for. The next resolve, at most a minute away, picks it up.
/// For the same reason the whole drop is taken even when part of it was
/// drawn from another pool's grant: the bound errs toward refusing, never
/// toward overdraw. With no debit since the resolve this is `0`, and the gate
/// is unchanged.
pub(super) fn spent_since_resolve(
    state: &AppState,
    ctx: &RequestContext,
    resolved_total: i64,
) -> i64 {
    let (Some(org_id), Some(resolved_at)) = (
        ctx.org_id.as_deref().filter(|org| !org.is_empty()),
        ctx.budget_resolved_at,
    ) else {
        return 0;
    };
    state
        .wallet
        .balance_reported_after(org_id, resolved_at)
        .map_or(0, |reported| resolved_total.saturating_sub(reported).max(0))
}

/// What THIS request is expected to cost, in micro-USD, for reservation only.
///
/// Never bills anything — the authoritative charge is the post-call debit
/// against the real ledger. This exists solely to decide who may start.
///
/// The basis is `max_tokens` at the flat `control_plane.cost_per_1k_micro_usd`
/// rate, marked up the same way the debit will be, with `min_reserve_micro_usd`
/// as a floor. This output-only, flat-rate form is for the paths that reserve
/// their input separately ([`inference_governance::reserve_input_credit`]).
/// Text completions use [`chat_reservation_estimate_micro_usd`], which adds the
/// prompt and prices both at the routed model's rates. For OpenRouter the true
/// cost only arrives with the response. The floor is what bounds a burst — see
/// [`crate::config::CreditsConfig::min_reserve_micro_usd`].
///
/// A request that names no `max_tokens` gets the floor rather than zero. Zero
/// would mean an unbounded completion reserves nothing, which is precisely
/// backwards: not stating a ceiling makes a request MORE expensive to serve, not
/// less.
pub(super) fn reservation_estimate_micro_usd(state: &AppState, body: &Value) -> i64 {
    let credits = &state.config.credits;
    // Providers can prefer either spelling when both are supplied. Reserve
    // against the larger ceiling so neither interpretation can spend past the
    // amount claimed for this request.
    let max_tokens = ["max_tokens", "max_completion_tokens"]
        .into_iter()
        .filter_map(|key| body.get(key).and_then(Value::as_u64))
        .max()
        .unwrap_or(0);
    let estimate = credits.debit_amount(request_cost_micro_usd(state, 0, max_tokens));
    estimate
        .max(credits.min_reserve_micro_usd)
        .min(i64::MAX as u64) as i64
}

/// Charged estimate of a text completion's PROMPT at the routed model's input
/// rate (the flat rate when the model is unpriced).
///
/// Prompt tokens are billed as well as output. A clamp or reservation that
/// counted only the output ceiling let a large prompt overdraw the wallet by
/// the prompt's own price: a $1 balance could admit a full-balance output
/// ceiling plus any amount of input.
pub(super) fn prompt_reservation_micro_usd(state: &AppState, body: &Value, model: &str) -> u64 {
    let input_tokens = estimate_prompt_tokens(body);
    if input_tokens == 0 {
        return 0;
    }
    state
        .config
        .credits
        .debit_amount(state.config.control_plane.cost_for(model, input_tokens, 0))
}

/// What a TEXT completion is expected to cost, for reservation only: the
/// prompt estimate plus the output ceiling, both at the routed model's rates,
/// floored at `min_reserve_micro_usd`. Run after [`clamp_output_ceiling`], so
/// the ceiling priced here is the one the wallet can cover.
pub(super) fn chat_reservation_estimate_micro_usd(
    state: &AppState,
    body: &Value,
    model: &str,
) -> i64 {
    let credits = &state.config.credits;
    let max_tokens = ["max_tokens", "max_completion_tokens"]
        .into_iter()
        .filter_map(|key| body.get(key).and_then(Value::as_u64))
        .max()
        .unwrap_or(0);
    let output = credits.debit_amount(
        max_tokens.saturating_mul(
            state
                .config
                .control_plane
                .output_price_per_1k_micro_usd(model),
        ) / 1000,
    );
    output
        .saturating_add(prompt_reservation_micro_usd(state, body, model))
        .max(credits.min_reserve_micro_usd)
        .min(i64::MAX as u64) as i64
}

/// Whether this request body carries an output-token ceiling the credit clamp
/// may lower.
///
/// Only text completions do. `run_multimodal` and `submit_video_job` route
/// through the same [`enforce_budget`], and writing a `max_tokens` into an image
/// or video body would at best be ignored and at worst rejected by the provider
/// as an unknown field.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum OutputCeiling {
    /// A chat/text-completion body — clamp its token ceiling to what the wallet
    /// can actually pay for.
    Clamp,
    /// An image/video/other body — leave it alone.
    Untouched,
}

/// How many output tokens `available_micro_usd` buys at the flat rate.
///
/// The inverse of [`request_cost_micro_usd`] over the output term, un-doing the
/// billing markup first so the answer is in the same currency the caller's
/// budget is denominated in.
///
/// Saturates to `u64::MAX` when the node charges nothing per token (a rate of
/// zero divides into any balance infinitely), which the caller reads as "no
/// affordability limit" — correct, because a node that meters nothing cannot
/// overdraw anyone.
pub(super) fn affordable_output_tokens(
    state: &AppState,
    available_micro_usd: i64,
    model: &str,
) -> u64 {
    // PER-MODEL, not the flat blended rate. Output prices span roughly 500x
    // across the catalog, so a single rate made this ceiling far too generous on
    // exactly the frontier models where an overdraft is worth having, and
    // needlessly tight on cheap ones — truncating completions the org could
    // always afford. Falls back to the flat rate when the model is not in the
    // price table.
    let per_1k = state
        .config
        .control_plane
        .output_price_per_1k_micro_usd(model);
    if per_1k == 0 {
        return u64::MAX;
    }
    let available = available_micro_usd.max(0) as u64;
    // Undo the markup: `debit_amount` is what turns raw provider cost into the
    // figure charged, and the budget is measured in charged micro-USD. Dividing
    // before un-marking-up would hand out a ceiling the debit then exceeds.
    let raw = state.config.credits.undo_debit_amount(available);
    raw.saturating_mul(1000) / per_1k
}

/// CLAMP THIS REQUEST'S OUTPUT CEILING TO WHAT THE WALLET CAN PAY FOR.
///
/// The hole this closes: metering is post-paid, and a request that names no
/// `max_tokens` reserved only `min_reserve_micro_usd` — a flat $0.01 that bounds
/// CONCURRENCY, not cost. So an org holding one cent could front a single
/// arbitrarily expensive completion, and the overdraft was limited only by how
/// much the model felt like generating. Prepaid credit is supposed to be a hard
/// cap; work is supposed to stop at zero.
///
/// The fix is to make the ceiling real rather than to refuse the request. A
/// request stating no ceiling is given the largest one its balance covers; a
/// request stating one keeps it, unless it is larger than the balance covers, in
/// which case it is lowered. The request then physically cannot cost more than
/// the org can pay, so the reservation that follows is an honest claim rather
/// than a floor standing in for one.
///
/// INJECTION, NOT REJECTION — deliberately, and a departure from the original
/// spec in `docs/pricing-remaining-work.md`, which called for a MANDATORY
/// `max_output_tokens`. Refusing every request that omits one would 402 every
/// existing managed client the moment this shipped, to fix a problem the client
/// did not cause. The cost of injecting instead is that a caller can now be
/// truncated at a ceiling it never set (`finish_reason: "length"`); that is the
/// honest consequence of running out of money mid-completion, and it is strictly
/// better than the alternative of serving the completion and eating the bill.
///
/// NET OF IN-FLIGHT CLAIMS. The headroom is the org's whole remaining balance,
/// and `try_reserve` is what subtracts the requests already running. Clamping
/// against the gross figure would let three concurrent unbounded requests each
/// size themselves at the full balance — the first would claim all of it and its
/// siblings would 402, which is not a bound, it is a race. Subtracting
/// `in_flight_micro_usd` first means concurrent requests each get a smaller
/// honest ceiling instead. A claim landing between this read and `try_reserve`
/// only makes the ceiling generous, and `try_reserve` still refuses
/// authoritatively — so the residual race degrades to today's behaviour rather
/// than past it.
///
/// NET OF THE PROMPT TOO. Prompt tokens are billed before any output is, so
/// the request's own prompt estimate (at the model's input rate) comes off the
/// balance first. A balance that cannot cover the prompt refuses the request.
///
/// THE RESIDUAL OVERDRAFT. Prices come from `control_plane.model_pricing`,
/// falling back to the flat `cost_per_1k_micro_usd` for unpriced models, the
/// prompt is a ~4 chars/token estimate, OpenRouter bills its own reported cost,
/// and the balance is the control plane's resolved figure (cached up to its
/// resolve TTL), lowered by any newer debit report (see
/// [`spent_since_resolve`]). So this bounds the overdraft to the error of
/// those estimates; it does not eliminate it.
///
/// Returns the ceiling written, for logging. `Ok(None)` when nothing was
/// changed. `Err(InsufficientCredits)` when the balance, net of in-flight
/// claims and of this request's own prompt, buys no output at all: the
/// request is refused rather than sent with a zero (or no) ceiling.
pub(super) fn clamp_output_ceiling(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    model: &str,
    pool: Option<&str>,
    ceiling: OutputCeiling,
) -> Result<Option<u64>, GatewayError> {
    if ceiling != OutputCeiling::Clamp || !state.config.credits.reserve_enabled {
        return Ok(None);
    }
    let Some(org_id) = ctx.org_id.as_deref().filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    // `None` ⇒ the org has no managed cap at all (BYOK, unmanaged, master key).
    // Nothing to clamp against, and imposing a ceiling on a tenant who is not
    // spending our money would be a pure regression.
    let Some(headroom) = credit_headroom_micro_usd(state, ctx, pool) else {
        return Ok(None);
    };
    // Net of in-flight claims AND of this request's own prompt, which is billed
    // before a single output token is.
    let prompt_cost = prompt_reservation_micro_usd(state, body, model).min(i64::MAX as u64) as i64;
    let available = headroom
        .saturating_sub(state.wallet.in_flight_micro_usd(org_id))
        .saturating_sub(prompt_cost);
    // Price the resolved upstream model. A pool's public model alias can have
    // a different price (or no price row), while this is the model dispatched.
    let affordable = affordable_output_tokens(state, available, model);
    if affordable == u64::MAX {
        return Ok(None);
    }
    if affordable == 0 {
        // Nothing left for output. Never write a zero ceiling (providers read
        // it as an error or as "no limit"), and never send the request
        // unbounded either: refuse it with the same pre-flight 402 as an empty
        // wallet.
        return Err(GatewayError::InsufficientCredits);
    }

    // Write back to the key the CLIENT used. Adding `max_tokens` to a body that
    // said `max_completion_tokens` would leave both present, which some
    // providers reject outright.
    let key = if body.get("max_completion_tokens").is_some() {
        "max_completion_tokens"
    } else {
        "max_tokens"
    };
    let requested = body.get(key).and_then(Value::as_u64).unwrap_or(0);
    // `0`/absent means "no ceiling stated", which is the unbounded case — give it
    // the affordable one. Otherwise only ever lower, never raise: a client asking
    // for less than it can afford is stating a preference, not a budget.
    let effective = if requested == 0 {
        affordable
    } else {
        requested.min(affordable)
    };
    if effective == requested {
        return Ok(None);
    }
    if let Some(map) = body.as_object_mut() {
        map.insert(key.to_string(), Value::from(effective));
    }
    Ok(Some(effective))
}
