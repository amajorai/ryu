use super::*;

pub(super) fn preflight_credit_gate(
    ctx: &RequestContext,
    pool: Option<&str>,
) -> Option<GatewayError> {
    if !ctx.managed_inference {
        return None;
    }
    // The balance is unknown (the control plane could not read it), not zero:
    // answer the retryable 503, never a wallet-empty 402.
    if ctx.credit_accounting_unavailable {
        return Some(GatewayError::AccountingUnavailable);
    }
    // `None` ⇒ no managed cap at all; nothing to gate on, pooled or not.
    let total = ctx.remaining_budget_micro_usd?;
    let unrestricted = ctx.unrestricted_budget_micro_usd.unwrap_or(total);
    let Some(pool) = pool else {
        return (unrestricted <= 0).then_some(GatewayError::InsufficientCredits);
    };
    (unrestricted.saturating_add(grant_money_reachable_from(ctx, pool)) <= 0)
        .then_some(GatewayError::InsufficientCredits)
}

/// Stop new managed provider spend after a debit could not be accounted for.
/// This is intentionally separate from `wallet_empty_decision`: an outage is
/// not evidence that the wallet is empty, and mapping it to the wallet-empty
/// budget action would strand a funded tenant until the process restarts.
/// Refuse a metered request (one with a local budget rule for its user or
/// agent, or control-plane org limits) while the durable spend counters are
/// unhealthy: `spend.db` sealed under another key is never reset, and counting
/// from zero would let a capped caller spend past the cap.
pub(crate) fn spend_store_gate(state: &AppState, ctx: &RequestContext) -> Option<GatewayError> {
    if ctx.is_master_key {
        return None;
    }
    let reason = state.spend_store.health().err()?;
    let metered = ctx.org_limits.is_some()
        || state.with_budget(|budget| {
            let config = budget.config();
            ctx.user_id
                .as_deref()
                .is_some_and(|id| config.users.contains_key(id))
                || ctx
                    .agent_id
                    .as_deref()
                    .is_some_and(|id| config.agents.contains_key(id))
        });
    metered.then_some(GatewayError::BudgetStoreUnavailable(reason))
}

pub(super) fn accounting_unavailable_gate(
    state: &AppState,
    ctx: &RequestContext,
) -> Option<GatewayError> {
    if !(ctx.managed_inference && state.config.credits.is_active()) {
        return None;
    }
    // The control plane could not read this tenant's entitlement or wallet
    // at resolve time. Not sticky: the next resolve (within the short cache
    // window such a resolve gets) clears it.
    if ctx.credit_accounting_unavailable {
        return Some(GatewayError::AccountingUnavailable);
    }
    let org_id = ctx.org_id.as_deref().filter(|value| !value.is_empty())?;
    state
        .wallet
        .is_org_accounting_unavailable(org_id)
        .then_some(GatewayError::AccountingUnavailable)
}

pub(super) fn wallet_empty_decision(
    state: &AppState,
    ctx: &RequestContext,
) -> Option<BudgetDecision> {
    let credits = &state.config.credits;
    if !credits.is_active() {
        return None;
    }
    let org_id = ctx.org_id.as_deref().filter(|s| !s.is_empty())?;
    if !state.wallet.is_org_empty(org_id) {
        return None;
    }

    // Map the configured wallet-empty action onto the budget action. A downgrade
    // with no target model degrades to a restrict (mirrors the spend-budget rule)
    // so the caller is never silently let through on an unhonourable downgrade.
    let action = match credits.wallet_empty_action {
        crate::config::WalletEmptyAction::Downgrade
            if credits.wallet_empty_downgrade_to.is_some() =>
        {
            BudgetAction::Downgrade
        }
        crate::config::WalletEmptyAction::Downgrade => BudgetAction::Restrict,
        crate::config::WalletEmptyAction::Stop => BudgetAction::Stop,
    };

    Some(BudgetDecision {
        scope: crate::budget::BudgetScope::User,
        key: format!("org:{org_id}"),
        action,
        used: 0,
        limit: 0,
        downgrade_to: credits.wallet_empty_downgrade_to.clone(),
        restrict_max_tokens: 256,
        // The wallet-empty rule's own alert tier (folded into the max in
        // `enforce_budget`). `limit == 0` keeps the wallet-empty invariant that
        // `PolicyAlert::from_budget_decision` routes to `wallet_empty`.
        alert: credits.wallet_empty_alert,
    })
}

/// Pick the more restrictive of two optional budget decisions. Severity order
/// (most restrictive first): `Stop` > `Restrict`/`Downgrade` > `Notify`. Ties
/// keep the first budget decision. Mirrors `budget::severity` (private there).
pub(super) fn most_severe(
    a: Option<BudgetDecision>,
    b: Option<BudgetDecision>,
) -> Option<BudgetDecision> {
    fn rank(action: BudgetAction) -> u8 {
        match action {
            BudgetAction::Notify => 0,
            BudgetAction::Restrict | BudgetAction::Downgrade => 1,
            BudgetAction::Stop => 2,
        }
    }
    match (a, b) {
        (Some(x), Some(y)) => {
            if rank(y.action) > rank(x.action) {
                Some(y)
            } else {
                Some(x)
            }
        }
        (Some(x), None) => Some(x),
        (None, other) => other,
    }
}

/// Flat estimated spend in micro-USD for reservation-only paths.
pub(super) fn request_cost_micro_usd(
    state: &AppState,
    input_tokens: u64,
    output_tokens: u64,
) -> u64 {
    let per_1k = state.config.control_plane.cost_per_1k_micro_usd;
    input_tokens
        .saturating_add(output_tokens)
        .saturating_mul(per_1k)
        / 1000
}

/// Raw provider cost in micro-USD, preferring the provider's *reported actual*
/// spend over the configured per-model price table. OpenRouter returns
/// `usage.cost` (in USD) when usage accounting is enabled; every other provider
/// is priced from `control_plane.model_pricing`, and an unpriced model from the
/// flat `cost_per_1k_micro_usd` estimate. There is no catalog lookup here:
/// callers mark any charge without a reported cost as `estimated`.
pub(super) fn response_cost_micro_usd(
    state: &AppState,
    provider: Option<&str>,
    reported_cost_usd: Option<f64>,
    input_tokens: u64,
    output_tokens: u64,
    model: &str,
    cache: Option<provider_usage::ProviderCacheUsage>,
) -> u64 {
    reported_cost_usd
        .and_then(cost_usd_to_micro)
        .unwrap_or_else(|| {
            // A published own-supply row is billed at its own price (what the
            // pick costs on OpenRouter, or the admin override) — never the flat
            // rate, whether or not the control-plane price table knows the id.
            // Prompt-cache reads and writes (inside `input_tokens`) are priced
            // at the row's cache rates, as OpenRouter's reported cost does.
            // One-hour cache writes are billed above the catalog's (five-minute)
            // write rate, as Anthropic and OpenRouter bill them.
            let cache = cache
                .map(provider_usage::ProviderCacheUsage::pricing)
                .unwrap_or_default();
            provider
                .and_then(|slot| state.own_supply.price_for(slot, model))
                .map(|price| price.cost_with_cache(input_tokens, output_tokens, cache))
                .unwrap_or_else(|| {
                    state
                        .config
                        .control_plane
                        .cost_for(model, input_tokens, output_tokens)
                })
        })
}

pub(super) fn budget_session_key(
    owner_binding: &str,
    org_id: Option<&str>,
    user_id: Option<&str>,
    session_id: Option<&str>,
) -> Option<String> {
    let session_id = session_id.filter(|value| !value.is_empty())?;
    Some(ryu_gw_credentials::fingerprint(&format!(
        "ryu-session-budget-v1\0{owner_binding}\0{}\0{}\0{session_id}",
        org_id.unwrap_or(""),
        user_id.unwrap_or("")
    )))
}

/// Charged budget amount in micro-USD. Budget counters use the same amount the
/// wallet would debit, including the configured platform markup, while remaining
/// useful on self-hosted nodes where the markup is zero and no wallet is active.
pub(super) fn charged_budget_cost_micro_usd(
    state: &AppState,
    provider: Option<&str>,
    reported_cost_usd: Option<f64>,
    input_tokens: u64,
    output_tokens: u64,
    model: &str,
    cache: Option<provider_usage::ProviderCacheUsage>,
) -> u64 {
    state.config.credits.debit_amount_for_provider(
        provider,
        response_cost_micro_usd(
            state,
            provider,
            reported_cost_usd,
            input_tokens,
            output_tokens,
            model,
            cache,
        ),
    )
}

/// Add one successful charged model call to the local user/agent/session
/// counters. The budget engine owns the identity filtering and zero-cost no-op;
/// keeping this seam here makes every completion family use the same units.
pub(super) fn record_charged_budget(state: &AppState, ctx: &RequestContext, cost_micro_usd: u64) {
    record_charged_budget_kind(state, ctx, BudgetChargeKind::Model, cost_micro_usd);
}

/// Add one successful charged amount to the local user/agent/session counters,
/// honoring each matching rule's category inclusion settings.
pub(super) fn record_charged_budget_kind(
    state: &AppState,
    ctx: &RequestContext,
    kind: BudgetChargeKind,
    cost_micro_usd: u64,
) {
    let session_key = budget_session_key(
        &ctx.owner_binding,
        ctx.org_id.as_deref(),
        ctx.user_id.as_deref(),
        ctx.session_id.as_deref(),
    );
    state.with_budget(|budgets| {
        budgets.record_charge(
            ctx.user_id.as_deref(),
            ctx.agent_id.as_deref(),
            kind,
            cost_micro_usd,
        );
        budgets.record_session_charge(session_key.as_deref(), kind, cost_micro_usd);
    });
    crate::org_limits::record_for(state, ctx, cost_micro_usd);
}

/// Record charged spend when the completion is represented by stored identity
/// fields, as with an asynchronous video job that settles during polling.
pub(super) fn record_charged_budget_for_ids(
    state: &AppState,
    owner_binding: &str,
    org_id: Option<&str>,
    user_id: Option<&str>,
    agent_id: Option<&str>,
    session_id: Option<&str>,
    kind: BudgetChargeKind,
    cost_micro_usd: u64,
    org_limit_subject: Option<&crate::org_limits::OrgLimitSubject>,
) {
    let session_key = budget_session_key(owner_binding, org_id, user_id, session_id);
    state.with_budget(|budgets| {
        budgets.record_charge(user_id, agent_id, kind, cost_micro_usd);
        budgets.record_session_charge(session_key.as_deref(), kind, cost_micro_usd);
    });
    // Org/member/team/key caps advance on every settlement path, including
    // the ones that run after the request context is gone.
    crate::org_limits::record_subject_for(state, org_limit_subject, cost_micro_usd);
}

/// Read the configured/provider-reported raw media price. Callers pass the raw
/// amount to the wallet helper and apply `debit_amount` once for budget counters.
pub(super) fn media_cost_from_response(
    state: &AppState,
    modality: &Modality,
    response: &Value,
) -> (u64, bool) {
    state
        .config
        .credits
        .media_cost_from_response(modality, response)
}
