//! Request-path helpers: budget evaluation, spend recording and the RPM/TPM
//! admission of every applicable cap for a [`RequestContext`].

use super::{
    bucket_key, evaluate, rate_share, record, record_subject, LimitsOutcome, OrgLimitContext,
    OrgLimitSubject,
};
use crate::error::GatewayError;
use crate::pipeline::RequestContext;
use crate::state::AppState;

/// Budget evaluation for a request context (no limits ⇒ empty outcome).
pub fn evaluate_for(state: &AppState, ctx: &RequestContext) -> LimitsOutcome {
    match ctx.org_limits.as_deref() {
        Some(limit_ctx) if !ctx.is_master_key => evaluate(
            state.spend_store.as_ref(),
            limit_ctx,
            ctx.user_id.as_deref(),
            crate::budget::unix_now(),
        ),
        _ => LimitsOutcome::default(),
    }
}

/// The org-limit subject of a request, for settlement paths that outlive it.
pub fn subject_for(ctx: &RequestContext) -> Option<OrgLimitSubject> {
    ctx.org_limits
        .as_deref()
        .map(|limit_ctx| OrgLimitSubject::new(limit_ctx, ctx.user_id.as_deref()))
}

/// Record charged spend for a stored subject (async settlement paths).
pub fn record_subject_for(state: &AppState, subject: Option<&OrgLimitSubject>, amount: u64) {
    if let Some(subject) = subject {
        record_subject(
            state.spend_store.as_ref(),
            subject,
            amount,
            crate::budget::unix_now(),
        );
    }
}

/// Record charged spend for a request context.
pub fn record_for(state: &AppState, ctx: &RequestContext, amount: u64) {
    if let Some(limit_ctx) = ctx.org_limits.as_deref() {
        record(
            state.spend_store.as_ref(),
            limit_ctx,
            ctx.user_id.as_deref(),
            amount,
            crate::budget::unix_now(),
        );
    }
}

/// Admit one request against the abuse ladder's throttle and new-key rates
/// ([`crate::enforcement::admit_rate`], which answer with their own codes),
/// then against every applicable RPM ceiling (`RateLimited`).
pub fn check_request(state: &AppState, ctx: &RequestContext) -> Result<(), GatewayError> {
    crate::enforcement::admit_rate(state, ctx)?;
    let Some(limit_ctx) = ctx.org_limits.as_deref() else {
        return Ok(());
    };
    if admit_request(&state.org_rate, limit_ctx, ctx.user_id.as_deref()) {
        Ok(())
    } else {
        Err(GatewayError::RateLimited)
    }
}

/// All-or-nothing RPM admission: a request a member/team/key cap rejects must
/// not drain the org (or any other) bucket it was checked against first.
pub(super) fn admit_request(
    rate: &crate::rate_limit::ScopedRateLimiter,
    limit_ctx: &OrgLimitContext,
    user_id: Option<&str>,
) -> bool {
    let ceilings: Vec<(String, u64)> = limit_ctx
        .applicable(user_id)
        .iter()
        .filter_map(|cap| {
            cap.spec
                .rpm
                .map(|rpm| (bucket_key(cap), rate_share(rpm, limit_ctx.active_gateways)))
        })
        .collect();
    rate.check_requests_all(&ceilings)
}

/// Admit `tokens` against every applicable TPM ceiling. `true` = allowed.
pub fn check_tokens(state: &AppState, ctx: &RequestContext, tokens: u64) -> bool {
    let Some(limit_ctx) = ctx.org_limits.as_deref() else {
        return true;
    };
    if tokens == 0 {
        return true;
    }
    admit_tokens(&state.org_rate, limit_ctx, ctx.user_id.as_deref(), tokens)
}

/// All-or-nothing TPM admission (see [`admit_request`]).
pub(super) fn admit_tokens(
    rate: &crate::rate_limit::ScopedRateLimiter,
    limit_ctx: &OrgLimitContext,
    user_id: Option<&str>,
    tokens: u64,
) -> bool {
    let ceilings: Vec<(String, u64)> = limit_ctx
        .applicable(user_id)
        .iter()
        .filter_map(|cap| {
            cap.spec
                .tpm
                .map(|tpm| (bucket_key(cap), rate_share(tpm, limit_ctx.active_gateways)))
        })
        .collect();
    rate.check_tokens_all(&ceilings, tokens)
}

/// Charge already-served tokens to every applicable TPM bucket (may carry
/// debt). Returns `true` when any bucket was already over its ceiling, so the
/// non-streaming path can report the overrun like the per-key limiter does.
pub fn settle_tokens(state: &AppState, ctx: &RequestContext, tokens: u64) -> bool {
    let Some(limit_ctx) = ctx.org_limits.as_deref() else {
        return false;
    };
    if tokens == 0 {
        return false;
    }
    let mut over = false;
    for cap in limit_ctx.applicable(ctx.user_id.as_deref()) {
        if let Some(tpm) = cap.spec.tpm {
            let share = rate_share(tpm, limit_ctx.active_gateways);
            over |= state
                .org_rate
                .settle_tokens(&bucket_key(&cap), tokens, share);
        }
    }
    over
}

/// [`settle_tokens`] for tokens counted for accounting rather than admission
/// (a tool loop's earlier provider rounds). Each bucket is charged at most its
/// own one-minute share, so one request cannot put it more than a minute into
/// debt, and an overrun is never reported.
pub fn record_tokens_within_window(state: &AppState, ctx: &RequestContext, tokens: u64) {
    let Some(limit_ctx) = ctx.org_limits.as_deref() else {
        return;
    };
    if tokens == 0 {
        return;
    }
    for cap in limit_ctx.applicable(ctx.user_id.as_deref()) {
        if let Some(tpm) = cap.spec.tpm {
            let share = rate_share(tpm, limit_ctx.active_gateways);
            state
                .org_rate
                .settle_tokens(&bucket_key(&cap), tokens.min(share), share);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::super::tests::context;
    use super::super::OrgLimits;
    use super::*;

    #[test]
    fn a_subject_exists_only_under_org_limits_and_carries_project_and_bot() {
        let mut ctx = crate::pipeline::test_support::plain_request_context();
        assert!(subject_for(&ctx).is_none());
        let mut limit_ctx = context(OrgLimits::default(), &["t1"]);
        limit_ctx.project_id = Some("proj_1".to_owned());
        limit_ctx.bot_id = Some("agent_1".to_owned());
        ctx.org_limits = Some(Arc::new(limit_ctx));
        ctx.user_id = Some("u1".to_owned());
        let subject = subject_for(&ctx).expect("subject under org limits");
        assert_eq!(subject.user_id.as_deref(), Some("u1"));
        assert_eq!(subject.team_ids, ["t1"]);
        assert_eq!(subject.project_id.as_deref(), Some("proj_1"));
        assert_eq!(subject.bot_id.as_deref(), Some("agent_1"));
    }
}
