//! Admission and audit for `POST /v1/providers/call`.
//!
//! A managed provider call runs a Composio or Treg action on Ryu's own
//! provider credentials, so it gets the same gates a chat request does before
//! any upstream I/O, in this order:
//!
//! 1. [`screen`]: the resolved tenant scanner and the locked guardrails over
//!    every string the provider receives (the action slug, the method, the
//!    connected account, the billed org, the query and the body, object keys
//!    included). Detection-only: the body is never rewritten, so a Sanitize
//!    policy refuses a match instead of redacting it.
//! 2. [`validate_identifiers`]: the method is one of [`ALLOWED_METHODS`] and
//!    the action slug a plain path segment, so neither can carry text the
//!    screen did not read into the provider's URL or request line.
//! 3. [`rate_limit`]: the per-key request and burst limits, keyed like chat.
//! 4. [`credit_gate`]: the managed tenant pre-flight credit gate inference
//!    applies to the billed org, so a wallet at or below zero runs no action
//!    at all, priced or not.
//!
//! Every refusal and every executed call (success or failure) leaves one
//! `ExecCall` audit row naming the provider, the action slug and the billed
//! org ([`audit`]).
use std::time::Instant;

use serde_json::Value;
use tracing::warn;

use super::{inference_governance, outbound_text, RequestContext};
use crate::{connections::ConnectionCall, error::GatewayError, state::AppState};

/// The most a caller-supplied `fallbackCostMicroUsd` may charge one call
/// ($1). The fallback prices a call only where the Gateway quoted nothing, and
/// it comes from the caller, so a value above this is clamped (and audited)
/// rather than trusted.
pub(crate) const MAX_CALLER_FALLBACK_COST_MICRO_USD: u64 = 1_000_000;

/// The caller's fallback cost, clamped to
/// [`MAX_CALLER_FALLBACK_COST_MICRO_USD`]. The flag reports a clamp.
pub(crate) fn clamp_caller_fallback(supplied: Option<u64>) -> (Option<u64>, bool) {
    match supplied {
        Some(cost) if cost > MAX_CALLER_FALLBACK_COST_MICRO_USD => {
            (Some(MAX_CALLER_FALLBACK_COST_MICRO_USD), true)
        }
        other => (other, false),
    }
}

/// The HTTP methods a provider call may use.
pub(crate) const ALLOWED_METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE"];

/// The longest action slug a provider call may name.
const MAX_TOOL_ID_LEN: usize = 256;

/// Screen every provider-bound string of `call`. The slug, the method, the
/// connected account, the billed org, the query and the body are walked inside
/// one array as action arguments ([`outbound_text::action_residual_text`]):
/// no key reads with the chat root-key or media rules (a body `tools`, `user`
/// or `image` key is an action argument here), object keys are screened like
/// values, and every leaf is also screened percent- and base64-decoded. A
/// policy the control plane could not resolve fails closed.
pub(crate) fn screen(
    state: &AppState,
    ctx: &RequestContext,
    call: &ConnectionCall,
) -> Result<(), GatewayError> {
    let optional = |value: Option<&String>| value.cloned().map_or(Value::Null, Value::String);
    let wire = Value::Array(vec![
        Value::String(call.tool_id.clone()),
        Value::String(call.method.clone()),
        optional(call.account_id.as_ref()),
        optional(call.org_id.as_ref()),
        Value::Array(
            call.query
                .iter()
                .map(|(key, value)| {
                    Value::Array(vec![
                        Value::String(key.clone()),
                        Value::String(value.clone()),
                    ])
                })
                .collect(),
        ),
        call.body.clone().unwrap_or(Value::Null),
    ]);
    let residual = outbound_text::action_residual_text(&wire);
    inference_governance::enforce_locked_guardrails(state, ctx, &call.tool_id)?;
    inference_governance::enforce_locked_guardrails_on_residual(state, ctx, &residual)?;
    let scanner = state.resolved_scanner(ctx);
    // A WarnAndContinue match is forwarded; the endpoint has no alert header,
    // so the screen's own warning is the only record of it.
    outbound_text::screen_residual_inbound(state, ctx, scanner.as_ref(), &residual)?;
    Ok(())
}

/// The hazard screener over the same strings [`screen`] reads, after it
/// (`crate::screening`). A managed provider call runs on Ryu's provider
/// credentials, so on the fleet it is floor-bound like chat.
pub(crate) async fn screen_hazard(
    state: &AppState,
    ctx: &RequestContext,
    call: &ConnectionCall,
) -> Result<(), GatewayError> {
    let wire = serde_json::json!({
        "tool_id": call.tool_id,
        "method": call.method,
        "query": call.query,
        "body": call.body.clone().unwrap_or(Value::Null),
    });
    crate::screening::admit::screen_value(
        state,
        ctx,
        &wire,
        crate::screening::admit::Surface::ProviderCall,
    )
    .await
    .map(|_| ())
}

/// Refuse a method outside [`ALLOWED_METHODS`] (in any case; the Treg
/// dispatch sends the uppercase token) or an action slug that is not
/// a plain path segment of `[A-Za-z0-9._:-]`. Providers format the slug into
/// the request path, so a `%` escape, a `?` query or a `/` would reach the
/// provider as text the screen never read in that form. The messages never
/// echo the value.
pub(crate) fn validate_identifiers(call: &ConnectionCall) -> Result<(), GatewayError> {
    let method = call.method.trim();
    if !ALLOWED_METHODS
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(method))
    {
        return Err(GatewayError::BadRequest(format!(
            "method must be one of {}",
            ALLOWED_METHODS.join(", ")
        )));
    }
    let tool_id = call.tool_id.trim();
    let plain_segment = !tool_id.is_empty()
        && tool_id.len() <= MAX_TOOL_ID_LEN
        && !tool_id.bytes().all(|byte| byte == b'.')
        && tool_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':'));
    if !plain_segment {
        return Err(GatewayError::BadRequest(
            "tool_id must be a plain identifier of letters, digits and . _ - :".to_owned(),
        ));
    }
    Ok(())
}

/// The per-key request and burst limits, checked as the chat `RateLimit`
/// stage checks them, so provider calls share the key's chat budget.
pub(crate) fn rate_limit(state: &AppState, ctx: &RequestContext) -> Result<(), GatewayError> {
    let admitted = if state
        .rate_limiter
        .check_request_for_key(&ctx.api_key, ctx.key_config.as_ref())
    {
        crate::org_limits::check_request(state, ctx)
    } else {
        Err(GatewayError::RateLimited)
    };
    if let Err(error) = admitted {
        warn!(key_id = %crate::audit::credential_log_id(&ctx.api_key), request_id = %ctx.request_id, "provider call: rate limit exceeded");
        state.metrics.inc_rate_limited();
        return Err(error);
    }
    if !state.rate_limiter.check_burst(&ctx.api_key) {
        warn!(key_id = %crate::audit::credential_log_id(&ctx.api_key), request_id = %ctx.request_id, "provider call: burst rate exceeded (bot detection)");
        state.metrics.inc_rate_limited();
        return Err(GatewayError::RateLimited);
    }
    Ok(())
}

/// The managed tenant pre-flight gate, with the guards `enforce_budget` puts
/// around it: the master key is exempt, an accounting outage is the retryable
/// 503, and a resolved balance at or below zero is a 402. The pool is `None`,
/// the unrestricted balance `admit` reserves against.
///
/// `billed_org` is the org the call is billed to. When a trusted forwarder
/// bills another org (with a Core proof for it), the forwarder's own resolved
/// balance says nothing about that wallet, so the gate reads what this node
/// last learned of the billed org instead: an accounting outage is the 503 and
/// a wallet the last debit reported empty is the 402.
pub(crate) fn credit_gate(
    state: &AppState,
    ctx: &RequestContext,
    billed_org: Option<&str>,
) -> Result<(), GatewayError> {
    if ctx.is_master_key {
        return Ok(());
    }
    if let Some(org) = billed_org.filter(|org| Some(*org) != ctx.org_id.as_deref()) {
        if !state.config.credits.is_active() {
            return Ok(());
        }
        if state.wallet.is_org_accounting_unavailable(org) {
            state.metrics.inc_errors();
            warn!(
                org_id = %org,
                "provider call: billed org accounting unavailable, rejecting managed call (503)"
            );
            return Err(GatewayError::AccountingUnavailable);
        }
        if state.wallet.is_org_empty(org) {
            state.metrics.inc_budget_exceeded();
            warn!(
                org_id = %org,
                "provider call: billed org wallet exhausted, rejecting pre-flight (402)"
            );
            return Err(GatewayError::InsufficientCredits);
        }
        return Ok(());
    }
    if let Some(error) = super::accounting_unavailable_gate(state, ctx) {
        state.metrics.inc_errors();
        warn!(
            org_id = ?ctx.org_id,
            "provider call: control-plane accounting unavailable, rejecting managed call (503)"
        );
        return Err(error);
    }
    if let Some(error) = super::preflight_credit_gate(ctx, None) {
        state.metrics.inc_budget_exceeded();
        warn!(
            org_id = ?ctx.org_id,
            remaining_budget_micro_usd = ?ctx.remaining_budget_micro_usd,
            unrestricted_budget_micro_usd = ?ctx.unrestricted_budget_micro_usd,
            "provider call: managed tenant wallet exhausted, rejecting pre-flight (402)"
        );
        return Err(error);
    }
    Ok(())
}

/// What one provider call audit row names.
pub(crate) struct ProviderCallAudit<'a> {
    pub provider: &'a str,
    pub tool_id: &'a str,
    /// The org the call is billed to, which a trusted forwarder may choose.
    pub org_id: Option<&'a str>,
    pub start: Instant,
}

/// Write one `ExecCall` row for a provider call. `error` is `None` only for a
/// call the provider served successfully. It carries a pattern name or a
/// status, never the payload, and is still redacted like `audit_failure`'s.
/// The row keeps `ctx.api_key` (the store redacts it to a prefix on query)
/// and `ctx.key_id()`, the credential id an `rgw_` org label cannot give.
/// The live traffic feed gets the row even when the audit store is off.
pub(crate) fn audit(
    state: &AppState,
    ctx: &RequestContext,
    target: &ProviderCallAudit<'_>,
    error: Option<&str>,
) {
    state.log_audit(exec_record(state, ctx, target, error));
}

/// [`audit`] for a call the Gateway refused with `error`, so the traffic
/// feed reports the status, code and verdict the caller received.
pub(crate) fn audit_refusal(
    state: &AppState,
    ctx: &RequestContext,
    target: &ProviderCallAudit<'_>,
    error: &GatewayError,
) {
    let record = exec_record(state, ctx, target, Some(&audit_error_text(error)));
    state.log_audit_with(record, crate::traffic::TrafficOutcome::failure(error));
}

fn exec_record(
    state: &AppState,
    ctx: &RequestContext,
    target: &ProviderCallAudit<'_>,
    error: Option<&str>,
) -> crate::audit::AuditRecord {
    let error = error.map(|text| {
        state.with_firewall(|firewall| {
            let sanitized = firewall.sanitize(text);
            firewall.redact_outbound(&sanitized).0
        })
    });
    let duration_ms = target.start.elapsed().as_millis() as u64;
    let mut record = crate::audit::AuditLogger::make_exec_record(
        ctx.request_id.clone(),
        ctx.api_key.clone(),
        target.provider.to_owned(),
        target.tool_id.trim().to_owned(),
        duration_ms,
        if error.is_some() { -1 } else { 0 },
        ctx.session_id.clone(),
        error,
    );
    record.provider = target.provider.to_owned();
    record.model = target.tool_id.trim().to_owned();
    record.user_name = ctx.user_name.clone();
    record.org_id = target.org_id.map(str::to_owned);
    record.team_id = ctx.team_id.clone();
    record.team_ids = ctx.audit_team_ids();
    record.key_id = ctx.key_id();
    record.project_id = ctx.project_id.clone();
    record.user_id = ctx.user_id.clone();
    record.agent_id = ctx.agent_id.clone();
    record.feature = ctx.feature.clone();
    record.managed_inference = ctx.managed_inference;
    record
}

/// The audit text for a refused or failed call: the error's own message,
/// except for provider errors, whose upstream text is not recorded.
pub(crate) fn audit_error_text(error: &GatewayError) -> String {
    match error {
        GatewayError::ProviderError(_)
        | GatewayError::ProviderRejected { .. }
        | GatewayError::ProviderTransport(_)
        | GatewayError::ProviderDeliveryUncertain(_) => {
            "upstream provider request failed".to_owned()
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call_with(tool_id: &str, method: &str) -> ConnectionCall {
        serde_json::from_value(serde_json::json!({
            "provider": "treg",
            "toolId": tool_id,
            "method": method,
            "requestId": "req-1",
        }))
        .unwrap()
    }

    #[test]
    fn only_plain_methods_and_slugs_pass_validation() {
        for (tool_id, method) in [
            ("x.post.create", "POST"),
            ("GMAIL_FETCH_EMAILS", "GET"),
            ("ca_1", "DELETE"),
            ("vendor:tool-v2", "PATCH"),
            ("gmail", "PUT"),
            ("x.post.create", "post"),
        ] {
            assert!(
                validate_identifiers(&call_with(tool_id, method)).is_ok(),
                "{tool_id} {method}"
            );
        }
        for (tool_id, method) in [
            ("x.post.create", "TRACE"),
            ("x.post.create", "PROPFIND"),
            ("x.post.%41BC", "POST"),
            ("x.post.create?note=1", "POST"),
            ("x.post.create#frag", "POST"),
            ("x/post", "POST"),
            ("x post", "POST"),
            ("..", "POST"),
            ("", "POST"),
        ] {
            assert!(
                matches!(
                    validate_identifiers(&call_with(tool_id, method)),
                    Err(GatewayError::BadRequest(_))
                ),
                "{tool_id} {method}"
            );
        }
    }

    #[test]
    fn a_caller_fallback_above_the_cap_is_clamped_and_flagged() {
        assert_eq!(clamp_caller_fallback(None), (None, false));
        assert_eq!(clamp_caller_fallback(Some(15_000)), (Some(15_000), false));
        assert_eq!(
            clamp_caller_fallback(Some(MAX_CALLER_FALLBACK_COST_MICRO_USD)),
            (Some(MAX_CALLER_FALLBACK_COST_MICRO_USD), false)
        );
        assert_eq!(
            clamp_caller_fallback(Some(u64::MAX)),
            (Some(MAX_CALLER_FALLBACK_COST_MICRO_USD), true)
        );
    }
}
