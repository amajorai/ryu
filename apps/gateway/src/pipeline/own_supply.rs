//! Own-supply routing: serve a Ryu Router pick from Ryu's own donated supply
//! when the caller's free credit can pay for it.
//!
//! The user picks models from ONE provider, Ryu Router, by their real
//! (OpenRouter-catalog) ids. Their free credit — active grants of any pool —
//! pays only for work Ryu serves from its OWN supply (`credit_pools::
//! is_own_supply_pool`). So when a managed caller with free credit picks a model
//! Ryu can also serve itself (an enabled row of the own-supply table: the
//! control plane's published table on fleet gateways, the compiled seed
//! elsewhere — `crate::own_supply_table`), the request is served from that slot
//! instead of OpenRouter, and the response is rewritten back to the id the user
//! picked. In every other case the request goes to OpenRouter exactly as before.
//!
//! The routing rule, in full:
//!   1. the caller is managed, has free credit (> 0, and the pre-flight gate
//!      admits the own-supply pool), and did not pin a per-agent slot;
//!   2. the picked id routes to the Ryu Router (`openrouter`) slot today and has
//!      a row on an own-supply slot that is CONFIGURED here, permitted by the
//!      caller's policy (`allows_model(picked) && allows_provider(slot)`),
//!      routable here (its local canary passed on a fleet gateway, and it is not
//!      quarantined), and whose donated allowance still has room (when the
//!      control plane reports allowances; otherwise configured is enough);
//!   3. among several eligible slots: soonest allowance expiry, then most
//!      allowance left, then table order.
//!
//! `openrouter/auto` (the managed default) has no single equivalent; with free
//! credit it is served by the default model of the own-supply pool the caller
//! holds the most free credit from, shown under that model's Ryu Router id.
//!
//! PAID traffic (no free credit) is served from own supply only where an
//! operator turned a row's cut-over dial up (`paid_rollout_bps`, default 0):
//! the caller's org lands in a stable bucket per model
//! ([`ryu_gw_router::own_supply::rollout_bucket`]) and rows whose dial is above
//! that bucket are eligible under the same configured / permitted / routable
//! conditions. Only rows with a chargeable catalog price qualify (the control
//! plane publishes no dial on a row with an admin price override), and cache
//! reads and writes are priced at their own catalog rates, so a paid caller is
//! debited what the same pick costs on OpenRouter; what changes is that Ryu
//! pays its own supplier instead of buying OpenRouter credit. Paid traffic is
//! never served from a donated allowance: a row is cut over only when the
//! control plane REPORTED its pool with no ceiling and the pool has not lapsed
//! ([`PoolAllowance::admits_paid`]); a capped, lapsed or unreported pool keeps
//! paid traffic on the Ryu Router route (fail closed), while free credit is
//! gated exactly as before. A caller holding free credit is always planned on
//! free credit. `openrouter/auto` and tool-loop callers (`x-ryu-tools`), which
//! can never fall back, are not cut over, and neither is a paid prompt above
//! [`PAID_MAX_PROMPT_TOKENS`] (a supplier's long-context tier is dearer than the
//! row's flat price).
//!
//! If the own-supply attempt fails BEFORE any output ([`may_fall_back`]), the
//! same request is re-run on the normal Ryu Router route, so a slot outage never
//! strands a user. A grant reservation that does not fit the request's estimate
//! surfaces as `InsufficientCredits` there and falls back the same way.

use std::sync::Arc;

use ryu_gw_router::own_supply::{rollout_bucket, OwnSupplyRow, OwnSupplyTable};

use super::RequestContext;
use crate::credit_pools::PoolAllowance;
use crate::error::GatewayError;

/// The managed default model id, mirrored from `MANAGED_DEFAULT_MODEL` in
/// `apps/core/src/pi_config/mod.rs`.
pub(super) const MANAGED_DEFAULT_MODEL: &str = "openrouter/auto";

/// The Ryu Router slot every own-supply candidate must be displacing.
pub(super) const RYU_ROUTER_SLOT: &str = "openrouter";

/// The largest estimated prompt a PAID request may have and still be cut over.
///
/// The table carries one flat price per row (the catalog's base tier), but some
/// suppliers bill a dearer tier above a long-context threshold (Gemini 2.5 Pro
/// above 200k prompt tokens, for one), which OpenRouter passes through to the
/// user. Debiting such a call at the base rate would under-bill a paid caller
/// while Ryu pays the supplier's real tier, so a long paid prompt stays on the
/// Ryu Router route, which bills the real tier. The estimate is the rough
/// ~4 characters per token one, which under-counts code and JSON by up to a
/// third, hence the margin below the 200k tier boundary. Free credit is not
/// affected: it spends Ryu's own donated supply, not the user's wallet.
pub(super) const PAID_MAX_PROMPT_TOKENS: u64 = 128_000;

/// How to serve one request from own supply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct OwnSupplyPlan {
    /// The own-supply slot that will serve it.
    pub slot: String,
    /// The supplier's id the slot is sent (dispatched through
    /// `RequestContext::own_supply_route`, never shown).
    pub upstream: String,
    /// What the user sees: the id they picked, or for `openrouter/auto` the Ryu
    /// Router id of the model actually used.
    pub shown_model: String,
    /// Why this request qualified.
    pub basis: SupplyBasis,
}

/// Why a request is served from own supply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SupplyBasis {
    /// The caller's free credit (grants) pays for it.
    FreeCredit,
    /// A paid caller inside the row's cut-over dial.
    PaidRollout,
}

impl SupplyBasis {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::FreeCredit => "free_credit",
            Self::PaidRollout => "paid_rollout",
        }
    }
}

/// The cohort a paid request is bucketed by: the org, else the user, else the
/// request (no stable identity: an independent draw per request).
fn rollout_cohort(ctx: &RequestContext) -> &str {
    [ctx.org_id.as_deref(), ctx.user_id.as_deref()]
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty())
        .unwrap_or(ctx.request_id.as_str())
}

/// What this gateway can serve, answered by the caller of [`plan`].
pub(super) trait SupplyView {
    /// The own-supply table in force here.
    fn table(&self) -> Arc<OwnSupplyTable>;
    /// The slot is configured here and the caller's policy permits serving
    /// `shown_model` from it.
    fn serves(&self, slot: &str, shown_model: &str) -> bool;
    /// This gateway's canary passed for the row (fleet) and it is not
    /// quarantined.
    fn is_routable(&self, row: &OwnSupplyRow) -> bool;
    /// The latest reported allowance for `pool`, `None` when unknown.
    fn allowance(&self, pool: &str) -> Option<PoolAllowance>;
}

/// Decide whether `requested_model` is served from own supply.
///
/// `routes_to_ryu_router` is whether the router sends the id to the managed
/// OpenRouter slot today; anything else (BYOK prefixes, operator model maps,
/// explicit aliases) is never touched.
///
/// `estimated_prompt_tokens` is the request's rough prompt size (the estimate
/// admission uses); a paid request above [`PAID_MAX_PROMPT_TOKENS`] is not cut
/// over.
pub(super) fn plan(
    requested_model: &str,
    routes_to_ryu_router: bool,
    estimated_prompt_tokens: u64,
    ctx: &RequestContext,
    supply: &impl SupplyView,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<OwnSupplyPlan> {
    if !ctx.managed_inference || !routes_to_ryu_router {
        return None;
    }
    if ctx.slot_provider.is_some() || ctx.slot_model.is_some() {
        return None;
    }
    // `openrouter/auto` picks a pool by the caller's free credit; a paid caller
    // has none to pick by, so it stays on the Ryu Router route.
    let is_default = requested_model.eq_ignore_ascii_case(MANAGED_DEFAULT_MODEL);
    // A PAID request may be cut over only off the default model, outside a tool
    // loop (which can never fall back, see [`may_fall_back`], so an own-supply
    // outage must not fail it), and under the long-context bound (a long prompt
    // may be billed at a dearer supplier tier than the row's flat price, see
    // [`PAID_MAX_PROMPT_TOKENS`]).
    let paid_allowed = !is_default
        && !(ctx.tools_header_present || ctx.tool_actions.is_some())
        && estimated_prompt_tokens <= PAID_MAX_PROMPT_TOKENS;
    let paid_bucket = rollout_bucket(rollout_cohort(ctx), requested_model);

    let table = supply.table();
    // SEPARATE POOLS: a row is served on free credit only when the caller holds
    // grant money reachable from THAT row's pool; otherwise it can only be a
    // paid cut-over inside the row's dial.
    let eligible = |row: &OwnSupplyRow| -> Option<(SupplyBasis, Option<PoolAllowance>)> {
        let pool = crate::credit_pools::pool_for_gateway_provider(&row.slot)?;
        if !crate::credit_pools::is_own_supply_pool(pool)
            || super::preflight_credit_gate(ctx, Some(pool)).is_some()
        {
            return None;
        }
        let basis = if super::grant_money_reachable_from(ctx, pool) > 0 {
            SupplyBasis::FreeCredit
        } else if paid_allowed && row.admits_paid(paid_bucket) {
            SupplyBasis::PaidRollout
        } else {
            return None;
        };
        let allowance = supply.allowance(pool);
        let room = match basis {
            SupplyBasis::FreeCredit => allowance.as_ref().is_none_or(|a| a.has_room(now)),
            // Paid traffic is served only from a pool the control plane
            // reported as uncapped (an account Ryu pays for itself): a donated
            // allowance, or a pool it never reported, stays free credit only.
            SupplyBasis::PaidRollout => allowance.as_ref().is_some_and(|a| a.admits_paid(now)),
        };
        if !room {
            return None;
        }
        (supply.is_routable(row) && supply.serves(&row.slot, &row.id)).then_some((basis, allowance))
    };

    if is_default {
        return plan_default(ctx, &table, eligible);
    }

    // Free-credit rows first (the caller's grant pays), then by allowance.
    let mut best: Option<((bool, Rank), OwnSupplyPlan)> = None;
    for (index, row) in table.equivalents(requested_model).enumerate() {
        let Some((basis, allowance)) = eligible(row) else {
            continue;
        };
        let rank = (
            basis != SupplyBasis::FreeCredit,
            Rank::new(allowance.as_ref(), index),
        );
        if best.as_ref().is_none_or(|(top, _)| rank < *top) {
            best = Some((
                rank,
                OwnSupplyPlan {
                    slot: row.slot.clone(),
                    upstream: row.upstream.clone(),
                    shown_model: requested_model.to_owned(),
                    basis,
                },
            ));
        }
    }
    best.map(|(_, plan)| plan)
}

/// `openrouter/auto` with free credit: the default model (admin-set per pool)
/// of the own-supply pool the caller holds the MOST free credit from (ties:
/// catalog order), so a campaign's grant buys that campaign's kind of model.
fn plan_default(
    ctx: &RequestContext,
    table: &OwnSupplyTable,
    eligible: impl Fn(&OwnSupplyRow) -> Option<(SupplyBasis, Option<PoolAllowance>)>,
) -> Option<OwnSupplyPlan> {
    let mut best: Option<(i64, OwnSupplyPlan)> = None;
    for (_, pool) in crate::credit_pools::own_supply_slots() {
        // What the caller's grants can pay for on this pool (its own grants
        // plus any retired pool's), the only money `openrouter/auto` may spend.
        let held = super::grant_money_reachable_from(ctx, pool).max(0);
        if held <= 0 {
            continue;
        }
        if best.as_ref().is_some_and(|(top, _)| held <= *top) {
            continue;
        }
        let Some(row) = table.pool_default(pool, |slot| {
            crate::credit_pools::pool_for_gateway_provider(slot) == Some(pool)
        }) else {
            continue;
        };
        if !matches!(eligible(row), Some((SupplyBasis::FreeCredit, _))) {
            continue;
        }
        best = Some((
            held,
            OwnSupplyPlan {
                slot: row.slot.clone(),
                upstream: row.upstream.clone(),
                shown_model: row.id.clone(),
                basis: SupplyBasis::FreeCredit,
            },
        ));
    }
    best.map(|(_, plan)| plan)
}

/// Whether an own-supply failure means the row itself is unavailable here
/// rather than a passing outage: such a row is quarantined on this gateway for
/// an hour. Decided only from the upstream status the provider carried, never
/// from message text (which can echo the request): a 404 says the model was
/// retired or renamed, a 401 that the slot's credential is no longer accepted.
/// A 403 never quarantines, because an upstream refuses one request's content
/// with it, and a safety outcome is a decision about one request, so neither
/// may take the row away from every other caller.
pub(super) fn is_row_unavailable(error: &GatewayError) -> bool {
    !error.is_safety_outcome()
        && matches!(
            error,
            GatewayError::ProviderRejected {
                status: 401 | 404,
                ..
            }
        )
}

/// Ordering among several eligible slots for one model: soonest allowance
/// expiry first (spend what lapses first), then most allowance left, then
/// table order. Smaller is better.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Rank {
    /// Unix seconds of expiry; `i64::MAX` when none is known.
    expires_at: i64,
    /// Negated remaining allowance, so more allowance sorts first; `i64::MIN`
    /// (best) when the pool has no ceiling.
    neg_remaining: i64,
    index: usize,
}

impl Rank {
    fn new(allowance: Option<&PoolAllowance>, index: usize) -> Self {
        let expires_at = allowance
            .and_then(|a| a.expires_at)
            .map_or(i64::MAX, |at| at.timestamp());
        let neg_remaining = allowance
            .and_then(|a| a.remaining_micro_usd)
            .map_or(i64::MIN, |left| left.saturating_neg());
        Self {
            expires_at,
            neg_remaining,
            index,
        }
    }
}

/// Whether a failed own-supply attempt may be re-run on the Ryu Router route.
///
/// Only failures that happened before anything reached the caller or an
/// external system: a provider health fault (5xx, 408, unreadable reply),
/// a transport, rate or circuit failure, a routing miss, or a reservation that
/// did not fit. Never a safety or policy outcome, and never an upstream 4xx
/// other than 408 and 429 (`ProviderRejected` or a 402
/// `ProviderPaymentRequired`): re-running a refused request on the Ryu Router
/// route would shop it to another vendor. NOT `ProviderDeliveryUncertain`
/// (the upstream may have acted), and never when the gateway's own tool loop
/// ran: its tool calls may already have had side effects that a re-run would
/// repeat.
pub(super) fn may_fall_back(error: &GatewayError, ctx: &RequestContext) -> bool {
    if ctx.tools_header_present || ctx.tool_actions.is_some() || error.is_safety_outcome() {
        return false;
    }
    matches!(
        error,
        GatewayError::ProviderError(_)
            | GatewayError::ProviderTransport(_)
            | GatewayError::ProviderRateLimited { .. }
            | GatewayError::CircuitOpen(_)
            | GatewayError::AllProvidersUnavailable(_)
            | GatewayError::NoProvider(_)
            | GatewayError::InsufficientCredits
            | GatewayError::Overloaded(_)
    )
}

#[cfg(test)]
mod tests;
