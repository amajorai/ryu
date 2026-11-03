//! Buffered (non-streaming) entry points, detaching metered calls from a
//! client hang-up, and the settlement of tool-loop rounds that did not answer.

use super::*;

/// Whether a client hang-up must leave this buffered call running.
///
/// True when this node debits the org's wallet for the call: accepted provider
/// work has to reach the settlement that audits, budgets and debits it, so a
/// client timeout cannot turn into unbilled provider spend.
///
/// An unmetered call (a Desktop's Core-managed local Gateway, a self-hosted
/// node) keeps cancel-on-drop. Its client gone, queued or in-flight work is
/// dropped, which frees the local engine's admission slot and queue place for
/// the next caller instead of serving a response nobody will read.
pub(super) fn settles_after_client_hang_up(state: &AppState, ctx: &RequestContext) -> bool {
    state.config.credits.is_active() && ctx.org_id.as_deref().is_some_and(|org| !org.is_empty())
}

/// Run a buffered pipeline, on its own task when `detach` is set.
///
/// A client that hangs up (or times out) makes hyper drop the handler future.
/// Awaited inline, that drop cancels the provider call mid-flight, after the
/// provider may have accepted the work but before the settlement that audits,
/// budgets and debits it. On its own task the pipeline outlives the handler:
/// dropping this future only detaches the `JoinHandle`, so dispatched work
/// finishes and is settled exactly like a delivered response. The task keeps
/// the caller's tracing span and route template (the traffic feed reads it).
/// See [`settles_after_client_hang_up`] for which calls detach.
pub(super) async fn run_buffered<T: Send + 'static>(
    detach: bool,
    work: impl std::future::Future<Output = Result<T, GatewayError>> + Send + 'static,
) -> Result<T, GatewayError> {
    use tracing::Instrument;
    if !detach {
        return work.await;
    }
    match tokio::spawn(crate::traffic::carry_route(work).in_current_span()).await {
        Ok(result) => result,
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(error) => Err(GatewayError::Internal(anyhow::anyhow!(
            "pipeline task was cancelled: {error}"
        ))),
    }
}

pub async fn run(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
) -> Result<PipelineOutput, GatewayError> {
    let managed = ctx.managed_inference;
    // Free credit first: a Ryu Router pick Ryu can serve from its own supply is
    // served there, shown under the id the user picked (see `own_supply`).
    if let Some(plan) = own_supply_plan(&state, &ctx, &body) {
        let (attempt_ctx, attempt_body) = own_supply_attempt(&ctx, &body, &plan);
        let attempt = run_unaliased(Arc::clone(&state), attempt_ctx, attempt_body).await;
        if let Err(error) = &attempt {
            note_own_supply_failure(&state, &plan, error);
        }
        match attempt {
            Ok(mut output) => {
                model_alias::apply_to_output(
                    &mut output.response,
                    &mut output.model_used,
                    &mut output.provider_used,
                    &plan.shown_model,
                );
                mask_degraded(&mut output.degraded, managed);
                return Ok(output);
            }
            Err(error) if own_supply::may_fall_back(&error, &ctx) => {
                warn!(
                    request_id = %ctx.request_id,
                    slot = %plan.slot,
                    error = %error,
                    "own supply failed before output; serving from the Ryu Router route"
                );
            }
            Err(error) => return Err(mask_own_supply_error(error, &plan, managed)),
        }
    }
    // A Ryu model alias (`ryu-code/max`) is resolved to the supplier's id for
    // dispatch; the client gets the alias back, never the supplier's id.
    let alias = model_alias::requested_alias(&body);
    let mut output = run_unaliased(state, ctx, body).await.map_err(|error| {
        model_alias::mask_pool_slots(model_alias::mask_error(error, alias), managed)
    })?;
    // A pre-alias raw id an own-supply slot served is shown under the id the
    // user knows, never the supplier's.
    let shown: Option<String> = alias
        .map(str::to_owned)
        .or_else(|| model_alias::served_display_id(output.provider_used, &output.model_used));
    if let Some(shown) = shown {
        model_alias::apply_to_output(
            &mut output.response,
            &mut output.model_used,
            &mut output.provider_used,
            &shown,
        );
    }
    mask_degraded(&mut output.degraded, managed);
    mask_provider_used(&mut output.provider_used, managed);
    Ok(output)
}

pub(super) async fn run_unaliased(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
) -> Result<PipelineOutput, GatewayError> {
    // Dispatch one buffered attempt; metered calls run detached (see
    // `run_buffered`) so a client hang-up never skips settlement.
    let detach = settles_after_client_hang_up(&state, &ctx);
    // A detached call outlives its caller. Dropping this future (a client
    // hang-up) cancels `caller`, which stops a tool loop from running further
    // tools or rounds; see `run_attached`.
    let caller = tokio_util::sync::CancellationToken::new();
    let _cancel_on_hang_up = caller.clone().drop_guard();
    run_buffered(
        detach,
        run_attached(state, ctx, body, detach.then_some(caller)),
    )
    .await
}

/// Bill the provider rounds a buffered tool loop ran before it failed.
///
/// They are provider spend even though the request did not succeed on this
/// attempt. They settle under their own ref, `{request_id}:attempt-{n}`, so a
/// fallback attempt that succeeds afterwards is not deduplicated against them
/// by the idempotent debit. The credit claim follows this debit. `error`, when
/// known, is what the loop failed with; the traffic feed reports it.
#[allow(clippy::too_many_arguments)]
pub(super) fn settle_failed_tool_rounds(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    attempt_index: usize,
    rounds: tool_rounds::ToolRoundTotals,
    provider: &str,
    model: &str,
    budget: Option<BudgetDecision>,
    start: Instant,
    reservation: Option<CreditReservation>,
    error: Option<&GatewayError>,
) {
    settle_unanswered_tool_rounds(
        state,
        ctx,
        format!("{}:attempt-{attempt_index}", ctx.request_id),
        rounds,
        provider,
        model,
        budget,
        start,
        reservation,
        "tool loop failed after paid provider rounds",
        error,
    );
}

/// Bill a tool loop the pool's final-execution deadline cut off, as a failed
/// attempt (`{request_id}:attempt-{n}`).
///
/// The deadline drops the loop, but a metered round runs on its own task and
/// keeps going: the provider bills it, so Ryu must too. With no round in
/// flight, the answered rounds settle now. Otherwise one settlement waits,
/// bounded by [`ABANDONED_PROVIDER_WAIT`], for the round to finish, then bills
/// every round once, the late one from its real usage. A second debit for the
/// late round alone would need its own ref (the same ref is deduplicated), so
/// the rounds settle together, as on the hang-up paths. The credit claim is
/// held until that debit resolves.
#[allow(clippy::too_many_arguments)]
pub(super) fn settle_timed_out_tool_rounds(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    attempt_index: usize,
    ledger: &Arc<tool_rounds::ToolRoundLedger>,
    provider: &'static str,
    model: &str,
    budget: Option<BudgetDecision>,
    start: Instant,
    reservation: Option<CreditReservation>,
) {
    let settle = move |state: &Arc<AppState>,
                       ctx: &RequestContext,
                       model: &str,
                       rounds: tool_rounds::ToolRoundTotals| {
        if rounds.rounds > 0 {
            settle_failed_tool_rounds(
                state,
                ctx,
                attempt_index,
                rounds,
                provider,
                model,
                budget,
                start,
                reservation,
                None,
            );
        }
    };
    let handle = tokio::runtime::Handle::try_current();
    match handle {
        Ok(handle) if ledger.rounds_in_flight() > 0 => {
            let (state, ctx, ledger, model) = (
                Arc::clone(state),
                ctx.clone(),
                Arc::clone(ledger),
                model.to_owned(),
            );
            handle.spawn(async move {
                let rounds = ledger.settled(ABANDONED_PROVIDER_WAIT).await;
                settle(&state, &ctx, &model, rounds);
            });
        }
        _ => settle(state, ctx, model, ledger.totals()),
    }
}

/// Bill tool-loop rounds that did not answer the request: rounds before a
/// failed round, or the rounds of a loop its caller abandoned. `debit_ref` is
/// the ref they settle under. The credit claim, shrunk to what the rounds
/// cost, follows this debit. The row reads the request's own traffic note, so
/// it carries the request's route, stages and verdict, and reports `error`
/// when the loop failed with one.
#[allow(clippy::too_many_arguments)]
pub(super) fn settle_unanswered_tool_rounds(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    debit_ref: String,
    rounds: tool_rounds::ToolRoundTotals,
    provider: &str,
    model: &str,
    budget: Option<BudgetDecision>,
    start: Instant,
    reservation: Option<CreditReservation>,
    reason: &str,
    error: Option<&GatewayError>,
) {
    let mut attempt_ctx = ctx.clone();
    attempt_ctx.request_id = debit_ref;
    // No round answered the request, so none is judged against the token
    // limits: all of them are recorded below like earlier rounds.
    let tokens = rounds.input_tokens.saturating_add(rounds.output_tokens);
    let reservation = shrink_credit_claim(
        state,
        ctx,
        reservation,
        tool_rounds_charge_micro_usd(state, &rounds, provider, model),
    );
    let mut settlement = inference_governance::settle_completion(
        state,
        &attempt_ctx,
        &rounds.billing_view(&Value::Null),
        inference_governance::CompletionReceipt {
            provider: provider.to_owned(),
            model: model.to_owned(),
            purpose: None,
            audit_provider: provider.to_owned(),
            backend: None,
            start,
            admitted_tokens: tokens,
            estimated_input: 0,
            budget,
            reservations: reservation.into_iter().collect(),
            zero_cost: false,
        },
    );
    settlement.record_mut().error = Some(reason.to_owned());
    settlement.join_note_of(&ctx.request_id);
    if let Some(error) = error {
        settlement.report(error);
    }
    record_earlier_round_tokens(state, ctx, tokens);
}

/// How a buffered tool loop ended when its caller can hang up.
pub(super) enum LoopOutcome<T> {
    Finished(T),
    /// The caller hung up first. The loop was dropped: no further tool runs
    /// and no new round starts.
    CallerGone,
}

/// Run `work`, a buffered tool loop, until it finishes or `caller` (present
/// on a metered, detached call) is cancelled by a client hang-up. Cancellation
/// wins a tie, and a caller already gone never starts the loop.
pub(super) async fn unless_caller_gone<T>(
    work: impl std::future::Future<Output = T>,
    caller: Option<&tokio_util::sync::CancellationToken>,
) -> LoopOutcome<T> {
    let Some(caller) = caller else {
        return LoopOutcome::Finished(work.await);
    };
    tokio::select! {
        biased;
        () = caller.cancelled() => LoopOutcome::CallerGone,
        output = work => LoopOutcome::Finished(output),
    }
}

/// What a tool loop's rounds are charged, in micro-USD: the same figure the
/// budgets and the debit use.
pub(super) fn tool_rounds_charge_micro_usd(
    state: &AppState,
    rounds: &tool_rounds::ToolRoundTotals,
    provider: &str,
    model: &str,
) -> u64 {
    charged_budget_cost_micro_usd(
        state,
        Some(provider),
        rounds.reported_cost_usd(),
        rounds.input_tokens,
        rounds.output_tokens,
        model,
        rounds.cache_usage(),
    )
}

/// Shrink a credit claim to `spent_micro_usd`, what the work actually cost.
///
/// A failed attempt's claim is held until its debit resolves. At full size,
/// the fallback attempt that follows would have to fit alongside the failed
/// attempt's whole estimate, and an org near its balance would be refused
/// although it can pay for both. The smaller claim is taken before the
/// original is released, so the amount held never dips below the spend. A
/// claim is never grown.
pub(super) fn shrink_credit_claim(
    state: &AppState,
    ctx: &RequestContext,
    claim: Option<CreditReservation>,
    spent_micro_usd: u64,
) -> Option<CreditReservation> {
    let claim = claim?;
    let Some(org_id) = ctx.org_id.as_deref().filter(|org| !org.is_empty()) else {
        return Some(claim);
    };
    let held = i64::try_from(spent_micro_usd)
        .unwrap_or(i64::MAX)
        .min(claim.amount_micro_usd());
    let shrunk = state.wallet.try_reserve(org_id, held, i64::MAX);
    drop(claim);
    shrunk
}

/// Count a tool loop's earlier provider rounds against the per-minute token
/// limits without refusing the request for them.
///
/// Every round is billed, but the token limits judge only the round that
/// answers, as they did before rounds were metered. Judging the sum would turn
/// a loop that already ran its tools and was debited into a 429, and the
/// client's retry would run the tools and pay again. Each bucket is charged at
/// most one window of these tokens, so one request cannot put it more than a
/// minute into debt.
pub(super) fn record_earlier_round_tokens(state: &AppState, ctx: &RequestContext, tokens: u64) {
    if tokens == 0 {
        return;
    }
    state.rate_limiter.record_tokens_within_window_for_key(
        &ctx.api_key,
        tokens,
        ctx.key_config.as_ref(),
    );
    crate::org_limits::record_tokens_within_window(state, ctx, tokens);
}
