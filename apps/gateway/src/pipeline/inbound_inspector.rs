//! Step 3a: the LLM traffic inspector over the inbound turn.

use super::*;
use crate::firewall::inspector::{InspectorVerdict, UNAVAILABLE_CATEGORY};

/// Judge the inbound turn with the LLM inspector and apply its action. A
/// no-op when the resolved firewall does not enable it.
///
/// A judge that gives no usable verdict follows `inspector.fail_mode`
/// (see [`InspectorClient::inspect`]): closed, the turn comes back flagged
/// [`UNAVAILABLE_CATEGORY`]. Redaction cannot stand in for a verdict that
/// never came, so under Sanitize that flag refuses the turn exactly as Block
/// does; only a flag naming what the judge found reaches the redactor.
pub(super) async fn inspector_stage(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    body: &mut Value,
    scanner: &Arc<FirewallScanner>,
) -> Result<(), GatewayError> {
    let inspector_cfg = scanner.config().inspector.clone();
    if !inspector_cfg.enabled {
        return Ok(());
    }
    let inference = auxiliary::GovernedInference::new(Arc::clone(state), ctx.clone(), "inspector");
    let current_text = extract_text_for_scanning(body);
    let verdict = InspectorClient::inspect(&current_text, &inspector_cfg, &inference).await?;
    if !verdict.flagged {
        return Ok(());
    }
    match inspector_cfg.action {
        FirewallPolicy::Block => Err(refuse(state, ctx, body, scanner, &verdict)),
        FirewallPolicy::Sanitize if is_unjudged(&verdict) => {
            warn!(
                request_id = %ctx.request_id,
                reason = %verdict.reason,
                "inspector: no verdict under Sanitize; nothing to redact, blocked"
            );
            Err(refuse(state, ctx, body, scanner, &verdict))
        }
        FirewallPolicy::Sanitize => {
            warn!(
                request_id = %ctx.request_id,
                categories = ?verdict.categories,
                "inspector: flagged inbound content under Sanitize policy"
            );
            sanitize_inbound_or_block(state, ctx, body, scanner.as_ref(), "inspector")?;
            Ok(())
        }
        FirewallPolicy::WarnAndContinue => {
            warn!(
                request_id = %ctx.request_id,
                categories = ?verdict.categories,
                reason = %verdict.reason,
                "inspector: inbound flagged (warn-and-continue)"
            );
            Ok(())
        }
    }
}

/// Whether the flag is the fail-closed stand-in for a missing verdict.
pub(super) fn is_unjudged(verdict: &InspectorVerdict) -> bool {
    verdict
        .categories
        .iter()
        .any(|category| category == UNAVAILABLE_CATEGORY)
}

/// Audit and build the refusal for a turn the inspector blocks.
fn refuse(
    state: &AppState,
    ctx: &RequestContext,
    body: &Value,
    scanner: &FirewallScanner,
    verdict: &InspectorVerdict,
) -> GatewayError {
    warn!(
        request_id = %ctx.request_id,
        categories = ?verdict.categories,
        reason = %verdict.reason,
        "inspector: blocked inbound content"
    );
    state.metrics.inc_firewall_blocked();
    audit_inspector_block(state, ctx, body, verdict);
    GatewayError::FirewallBlocked(
        format!(
            "Inbound content blocked by inspector: {} [{}]",
            verdict.reason,
            verdict.categories.join(",")
        ),
        firewall_policy_alert(scanner.config(), ctx, "block"),
    )
}
