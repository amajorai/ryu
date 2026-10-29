//! Inbound screening inside the buffered tool loops.
//!
//! `pre_process` screens the request once, but a tool loop then sends new
//! content to the provider on every round: the model's own turn (its text and
//! the arguments of the calls it chose) and each tool result. This screen
//! reads only that newly appended content, once per item, so the cost stays
//! bounded by what the loop adds rather than the whole history.
//!
//! It is detection-only. Nothing is redacted or rewritten here, so the bytes
//! of the request prefix the provider caches stay as they were. A match the
//! request would refuse inbound ends the loop with the same 403
//! `policy_violation`:
//!
//! - the locked guardrails, under any policy;
//! - the inbound regex firewall, under `Block`. `Sanitize` and
//!   `WarnAndContinue` keep the loop's existing per-result handling.
//!
//! Tool definitions the loop injects itself (described by Core after a
//! `tool_search` call or from capability hints) are screened before they join
//! `tools`, with the rule `pre_process` applies to the caller's definitions:
//! secrets only. A match ends the loop with the same refusal, under any policy
//! but `WarnAndContinue`, since there is no field to redact and no per-result
//! fallback that could withhold a definition.
use std::sync::Arc;

use serde_json::Value;
use tracing::warn;

use super::{inference_governance, outbound_text, RequestContext};
use crate::{
    config::FirewallPolicy, error::GatewayError, state::AppState, tools::ToolLoopFirewall,
};

/// The tool-loop firewall for one request: its resolved scanner plus the
/// appended-content screen below.
pub(super) fn firewall(state: &Arc<AppState>, ctx: &RequestContext) -> ToolLoopFirewall {
    let screen_state = Arc::clone(state);
    let screen_ctx = ctx.clone();
    let definitions_state = Arc::clone(state);
    let definitions_ctx = ctx.clone();
    ToolLoopFirewall {
        scanner: state.resolved_scanner(ctx),
        screen: Some(Arc::new(move |appended: &Value| {
            screen_appended(&screen_state, &screen_ctx, appended)
        })),
        screen_definitions: Some(Arc::new(move |definitions: &[Value]| {
            screen_definitions(&definitions_state, &definitions_ctx, definitions)
        })),
        standing: standing_check(state, ctx),
        hazard: hazard_screen(state, ctx),
    }
}

/// The hazard screener over each appended item, as a tool round
/// (`crate::screening`). `None` when no screener binds this gateway.
///
/// The model's turn is screened as `tool_args`, a tool result as
/// `tool_result`, and round `n` is attempt `n + 1` (spec 00.5): a tool result
/// flagged for the code the prompt was is its own event, not a duplicate.
fn hazard_screen(
    state: &Arc<AppState>,
    ctx: &RequestContext,
) -> Option<crate::tools::HazardScreen> {
    state.screening.tier(state.custody)?;
    let state = Arc::clone(state);
    let ctx = ctx.clone();
    Some(Arc::new(
        move |appended: Value, part: crate::tools::ToolRoundPart, round: u8| {
            let state = Arc::clone(&state);
            let mut ctx = ctx.clone();
            ctx.violation_attempt = crate::violations::AttemptRef {
                index: round.saturating_add(1),
                ..ctx.violation_attempt.clone()
            };
            let surface = match part {
                crate::tools::ToolRoundPart::ModelTurn => {
                    crate::screening::admit::Surface::ToolArgs
                }
                crate::tools::ToolRoundPart::ToolResult => {
                    crate::screening::admit::Surface::ToolRound
                }
            };
            Box::pin(async move {
                crate::screening::admit::screen_value(&state, &ctx, &appended, surface)
                    .await
                    .map(|_| ())
            })
        },
    ))
}

/// The loop's platform-standing check: a cheap version compare each round,
/// and a re-resolve only when an enforcement push named this request.
fn standing_check(
    state: &Arc<AppState>,
    ctx: &RequestContext,
) -> Option<crate::tools::StandingCheck> {
    let guard = ctx.standing.clone()?;
    let state = Arc::clone(state);
    Some(Arc::new(move || {
        let guard = Arc::clone(&guard);
        let state = Arc::clone(&state);
        Box::pin(async move { guard.recheck(&state).await })
    }))
}

/// Screen one appended item. It is walked with no chat root-key rule, so none
/// softens a result key such as `tools`, and every string leaf (decoded when
/// it holds embedded JSON), every object key and every URL is read (see
/// `outbound_text::tool_loop_residual_text`).
fn screen_appended(
    state: &AppState,
    ctx: &RequestContext,
    appended: &Value,
) -> Result<(), GatewayError> {
    let residual = outbound_text::tool_loop_residual_text(appended);
    if let Err(error) =
        inference_governance::enforce_locked_guardrails_on_residual(state, ctx, &residual)
    {
        warn!(
            request_id = %ctx.request_id,
            "tool loop: appended content violates a locked guardrail; loop stopped"
        );
        state.metrics.inc_firewall_blocked();
        return Err(error);
    }
    let scanner = state.resolved_scanner(ctx);
    if matches!(scanner.policy(), FirewallPolicy::Block) {
        outbound_text::screen_residual_inbound(state, ctx, scanner.as_ref(), &residual)?;
    }
    Ok(())
}

/// Screen tool definitions the loop is about to add to `tools`, secrets only
/// (see the module docs).
fn screen_definitions(
    state: &AppState,
    ctx: &RequestContext,
    definitions: &[Value],
) -> Result<(), GatewayError> {
    if definitions.is_empty() {
        return Ok(());
    }
    let residual = outbound_text::tool_definitions_residual_text(definitions);
    if let Err(error) =
        inference_governance::enforce_locked_guardrails_on_residual(state, ctx, &residual)
    {
        warn!(
            request_id = %ctx.request_id,
            "tool loop: an injected tool definition violates a locked guardrail; loop stopped"
        );
        state.metrics.inc_firewall_blocked();
        return Err(error);
    }
    let scanner = state.resolved_scanner(ctx);
    outbound_text::screen_residual_inbound(state, ctx, scanner.as_ref(), &residual)?;
    Ok(())
}
