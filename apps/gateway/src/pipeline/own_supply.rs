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
    let basis = if super::free_credit_micro_usd(ctx) > 0 {
        SupplyBasis::FreeCredit
    } else {
        SupplyBasis::PaidRollout
    };
    // `openrouter/auto` picks a pool by the caller's free credit; a paid caller
    // has none to pick by, so it stays on the Ryu Router route.
    let is_default = requested_model.eq_ignore_ascii_case(MANAGED_DEFAULT_MODEL);
    if basis == SupplyBasis::PaidRollout && is_default {
        return None;
    }
    // A tool-loop caller can never fall back ([`may_fall_back`]), so a paid
    // request it sends stays on the Ryu Router route: before the dial it was
    // always served there, and an own-supply outage must not fail it.
    if basis == SupplyBasis::PaidRollout && (ctx.tools_header_present || ctx.tool_actions.is_some())
    {
        return None;
    }
    // A long-context prompt may be billed at a dearer supplier tier than the
    // row's flat price (see [`PAID_MAX_PROMPT_TOKENS`]).
    if basis == SupplyBasis::PaidRollout && estimated_prompt_tokens > PAID_MAX_PROMPT_TOKENS {
        return None;
    }
    let paid_bucket = rollout_bucket(rollout_cohort(ctx), requested_model);

    let table = supply.table();
    let eligible = |row: &OwnSupplyRow| -> Option<Option<PoolAllowance>> {
        if basis == SupplyBasis::PaidRollout && !row.admits_paid(paid_bucket) {
            return None;
        }
        let pool = crate::credit_pools::pool_for_gateway_provider(&row.slot)?;
        if !crate::credit_pools::is_own_supply_pool(pool)
            || super::preflight_credit_gate(ctx, Some(pool)).is_some()
        {
            return None;
        }
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
        (supply.is_routable(row) && supply.serves(&row.slot, &row.id)).then_some(allowance)
    };

    if is_default {
        return plan_default(ctx, &table, eligible);
    }

    let mut best: Option<(Rank, OwnSupplyPlan)> = None;
    for (index, row) in table.equivalents(requested_model).enumerate() {
        let Some(allowance) = eligible(row) else {
            continue;
        };
        let rank = Rank::new(allowance.as_ref(), index);
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
    eligible: impl Fn(&OwnSupplyRow) -> Option<Option<PoolAllowance>>,
) -> Option<OwnSupplyPlan> {
    let mut best: Option<(i64, OwnSupplyPlan)> = None;
    for (_, pool) in crate::credit_pools::own_supply_slots() {
        let held = ctx
            .pool_budgets_micro_usd
            .get(pool)
            .copied()
            .unwrap_or_default()
            .max(0);
        if best.as_ref().is_some_and(|(top, _)| held <= *top) {
            continue;
        }
        let Some(row) = table.pool_default(pool, |slot| {
            crate::credit_pools::pool_for_gateway_provider(slot) == Some(pool)
        }) else {
            continue;
        };
        if eligible(row).is_none() {
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
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    struct Supply {
        table: Arc<OwnSupplyTable>,
        configured: HashSet<&'static str>,
        allowances: HashMap<&'static str, PoolAllowance>,
        /// `(slot, upstream)` this gateway cannot route (no canary / quarantined).
        blocked: HashSet<(String, String)>,
        denied_models: HashSet<&'static str>,
    }

    impl Supply {
        fn all() -> Self {
            Self {
                table: Arc::new(OwnSupplyTable::seed()),
                configured: crate::credit_pools::own_supply_slots()
                    .map(|(slot, _)| slot)
                    .collect(),
                allowances: HashMap::new(),
                blocked: HashSet::new(),
                denied_models: HashSet::new(),
            }
        }
        fn with_table(mut self, table: OwnSupplyTable) -> Self {
            self.table = Arc::new(table);
            self
        }
        fn blocking(mut self, slot: &str, upstream: &str) -> Self {
            self.blocked.insert((slot.to_owned(), upstream.to_owned()));
            self
        }
        fn denying(mut self, model: &'static str) -> Self {
            self.denied_models.insert(model);
            self
        }
        fn without(mut self, slot: &'static str) -> Self {
            self.configured.remove(slot);
            self
        }
        fn allowance(mut self, pool: &'static str, allowance: PoolAllowance) -> Self {
            self.allowances.insert(pool, allowance);
            self
        }
    }

    impl SupplyView for Supply {
        fn table(&self) -> Arc<OwnSupplyTable> {
            Arc::clone(&self.table)
        }
        fn serves(&self, slot: &str, shown: &str) -> bool {
            self.configured.contains(slot) && !self.denied_models.contains(shown)
        }
        fn is_routable(&self, row: &OwnSupplyRow) -> bool {
            !self
                .blocked
                .contains(&(row.slot.clone(), row.upstream.clone()))
        }
        fn allowance(&self, pool: &str) -> Option<PoolAllowance> {
            self.allowances.get(pool).cloned()
        }
    }

    fn ctx(unrestricted: i64, pools: &[(&str, i64)]) -> RequestContext {
        let mut ctx = super::super::test_support::plain_request_context();
        ctx.org_id = Some("o1".to_owned());
        ctx.managed_inference = true;
        let pooled: i64 = pools.iter().map(|(_, b)| *b).sum();
        ctx.remaining_budget_micro_usd = Some(unrestricted + pooled);
        ctx.unrestricted_budget_micro_usd = Some(unrestricted);
        ctx.pool_budgets_micro_usd = pools
            .iter()
            .map(|(pool, balance)| ((*pool).to_owned(), *balance))
            .collect();
        ctx
    }

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc::now()
    }

    fn served(model: &str, ctx: &RequestContext, supply: &Supply) -> Option<OwnSupplyPlan> {
        plan(model, true, 0, ctx, supply, now())
    }

    #[test]
    fn a_grant_from_any_pool_serves_an_equivalent_pick_from_own_supply() {
        // OpenAI-campaign credit pays for a Claude pick served by Ryu's own slot.
        let ctx = ctx(0, &[("openai-credits", 5_000_000)]);
        let plan = served("anthropic/claude-sonnet-4.5", &ctx, &Supply::all()).unwrap();
        assert_eq!(plan.slot, "anthropic-credits");
        assert_eq!(plan.upstream, "claude-sonnet-4-5");
        assert_eq!(plan.shown_model, "anthropic/claude-sonnet-4.5");
        // Applies whatever the paid balance: free credit is spent first.
        let rich = super::tests::ctx(9_000_000, &[("bedrock", 1)]);
        assert!(served("openai/o3", &rich, &Supply::all()).is_some());
    }

    #[test]
    fn no_free_credit_always_means_the_ryu_router_route() {
        let paid_only = ctx(9_000_000, &[]);
        assert_eq!(
            served("anthropic/claude-sonnet-4.5", &paid_only, &Supply::all()),
            None
        );
        let spent = ctx(9_000_000, &[("anthropic-credits", 0), ("bedrock", -3)]);
        assert_eq!(served("openai/o3", &spent, &Supply::all()), None);
        assert_eq!(served("openrouter/auto", &paid_only, &Supply::all()), None);
    }

    #[test]
    fn explicit_non_equivalent_picks_and_non_router_routes_are_untouched() {
        let ctx = ctx(0, &[("anthropic-credits", 5_000)]);
        for model in [
            "anthropic/claude-sonnet-4",
            "openai/gpt-4o",
            "ryu-code/max",
            "claude-sonnet-4-5",
        ] {
            assert_eq!(served(model, &ctx, &Supply::all()), None, "{model}");
        }
        // Not routed to the Ryu Router slot (operator map, BYOK prefix): never.
        assert_eq!(
            plan(
                "anthropic/claude-sonnet-4.5",
                false,
                0,
                &ctx,
                &Supply::all(),
                now()
            ),
            None
        );
        let mut slotted = ctx.clone();
        slotted.slot_model = Some("x".to_owned());
        assert_eq!(
            served("anthropic/claude-sonnet-4.5", &slotted, &Supply::all()),
            None
        );
        let mut byok = ctx;
        byok.managed_inference = false;
        assert_eq!(
            served("anthropic/claude-sonnet-4.5", &byok, &Supply::all()),
            None
        );
    }

    #[test]
    fn unconfigured_or_exhausted_supply_is_skipped() {
        let ctx = ctx(0, &[("anthropic-credits", 5_000)]);
        assert_eq!(
            served(
                "anthropic/claude-sonnet-4.5",
                &ctx,
                &Supply::all().without("anthropic-credits")
            ),
            None
        );
        let exhausted = Supply::all().allowance(
            "anthropic-credits",
            PoolAllowance {
                remaining_micro_usd: Some(0),
                expires_at: None,
            },
        );
        assert_eq!(
            served("anthropic/claude-sonnet-4.5", &ctx, &exhausted),
            None
        );
        let lapsed = Supply::all().allowance(
            "anthropic-credits",
            PoolAllowance {
                remaining_micro_usd: Some(10),
                expires_at: Some(now() - chrono::Duration::hours(1)),
            },
        );
        assert_eq!(served("anthropic/claude-sonnet-4.5", &ctx, &lapsed), None);
    }

    #[test]
    fn several_eligible_slots_rank_by_expiry_then_allowance_then_order() {
        let a = PoolAllowance {
            remaining_micro_usd: Some(100),
            expires_at: Some(now() + chrono::Duration::days(30)),
        };
        let b = PoolAllowance {
            remaining_micro_usd: Some(5),
            expires_at: Some(now() + chrono::Duration::days(2)),
        };
        // Soonest expiry wins even with less allowance.
        assert!(Rank::new(Some(&b), 1) < Rank::new(Some(&a), 0));
        // Same expiry: more allowance wins.
        let c = PoolAllowance {
            remaining_micro_usd: Some(50),
            expires_at: b.expires_at,
        };
        assert!(Rank::new(Some(&c), 1) < Rank::new(Some(&b), 0));
        // Unknown expiry sorts after any known one; then table order.
        assert!(Rank::new(Some(&a), 5) < Rank::new(None, 0));
        assert!(Rank::new(None, 0) < Rank::new(None, 1));
    }

    #[test]
    fn the_default_model_uses_the_pool_the_caller_holds_most_free_credit_from() {
        let ctx = ctx(
            7_000_000,
            &[("openai-credits", 9_000), ("anthropic-credits", 1_000)],
        );
        let plan = served("openrouter/auto", &ctx, &Supply::all()).unwrap();
        assert_eq!(plan.slot, "openai-credits");
        assert_eq!(plan.upstream, "o3");
        assert_eq!(plan.shown_model, "openai/o3");
        // That pool's slot missing here: the next-largest that is.
        let plan = served(
            "OpenRouter/Auto",
            &ctx,
            &Supply::all().without("openai-credits"),
        )
        .unwrap();
        assert_eq!(plan.shown_model, "anthropic/claude-sonnet-4.5");
        // Nothing configured: the normal route.
        let mut none = Supply::all();
        none.configured.clear();
        assert_eq!(served("openrouter/auto", &ctx, &none), None);
    }

    fn published(rows: &[(&str, &str, &str, i64)], defaults: &[(&str, &str)]) -> OwnSupplyTable {
        OwnSupplyTable::from_rows(
            3,
            rows.iter()
                .map(|(id, slot, upstream, priority)| OwnSupplyRow {
                    id: (*id).to_owned(),
                    slot: (*slot).to_owned(),
                    upstream: (*upstream).to_owned(),
                    priority: *priority,
                    canary_required: false,
                    user_price: Some(ryu_gw_router::own_supply::OwnSupplyPrice::flat(1, 1)),
                    supplier_cost: None,
                    paid_rollout_bps: 0,
                })
                .collect(),
            defaults
                .iter()
                .map(|(pool, id)| ((*pool).to_owned(), (*id).to_owned()))
                .collect(),
        )
    }

    /// One priced Claude row on the Anthropic slot with the given paid dial,
    /// its pool reported with no donation ceiling (an account Ryu pays for).
    fn dialed(paid_rollout_bps: u16, priced: bool) -> Supply {
        let row = OwnSupplyRow {
            id: "anthropic/claude-sonnet-4.5".to_owned(),
            slot: "anthropic-credits".to_owned(),
            upstream: "claude-sonnet-4-5".to_owned(),
            priority: 0,
            canary_required: false,
            user_price: priced.then_some(ryu_gw_router::own_supply::OwnSupplyPrice::flat(
                3_000, 15_000,
            )),
            supplier_cost: None,
            paid_rollout_bps,
        };
        Supply::all()
            .with_table(OwnSupplyTable::from_rows(4, vec![row], HashMap::new()))
            .allowance("anthropic-credits", PoolAllowance::default())
    }

    #[test]
    fn a_paid_caller_is_served_from_own_supply_only_inside_the_dial() {
        let paid = ctx(9_000_000, &[]);
        let model = "anthropic/claude-sonnet-4.5";
        assert_eq!(served(model, &paid, &dialed(0, true)), None, "dial off");
        let plan = served(model, &paid, &dialed(10_000, true)).unwrap();
        assert_eq!(plan.slot, "anthropic-credits");
        assert_eq!(plan.upstream, "claude-sonnet-4-5");
        assert_eq!(plan.shown_model, model);
        assert_eq!(plan.basis, SupplyBasis::PaidRollout);
        // The org's bucket is the boundary: a dial at it excludes the org, one
        // above admits it.
        let bucket = rollout_bucket("o1", model);
        assert_eq!(served(model, &paid, &dialed(bucket, true)), None);
        assert!(served(model, &paid, &dialed(bucket + 1, true)).is_some());
    }

    #[test]
    fn paid_rollout_never_serves_an_unpriced_unconfigured_or_refused_row() {
        let paid = ctx(9_000_000, &[]);
        let model = "anthropic/claude-sonnet-4.5";
        assert_eq!(served(model, &paid, &dialed(10_000, false)), None);
        assert_eq!(
            served(
                model,
                &paid,
                &dialed(10_000, true).without("anthropic-credits")
            ),
            None
        );
        assert_eq!(
            served(model, &paid, &dialed(10_000, true).denying(model)),
            None
        );
        assert_eq!(
            served(
                model,
                &paid,
                &dialed(10_000, true).blocking("anthropic-credits", "claude-sonnet-4-5")
            ),
            None
        );
        let lapsed = dialed(10_000, true).allowance(
            "anthropic-credits",
            PoolAllowance {
                remaining_micro_usd: None,
                expires_at: Some(now() - chrono::Duration::hours(1)),
            },
        );
        assert_eq!(served(model, &paid, &lapsed), None);
        // An empty wallet is refused by the pre-flight gate, as on OpenRouter.
        assert_eq!(served(model, &ctx(0, &[]), &dialed(10_000, true)), None);
        // `openrouter/auto` has no paid equivalent.
        assert_eq!(
            served("openrouter/auto", &paid, &dialed(10_000, true)),
            None
        );
    }

    #[test]
    fn paid_rollout_never_touches_a_donated_allowance() {
        let paid = ctx(9_000_000, &[]);
        let free = ctx(0, &[("anthropic-credits", 5_000)]);
        let model = "anthropic/claude-sonnet-4.5";
        // A pool with a donation ceiling serves free credit only, however much
        // of the allowance is left.
        let capped = dialed(10_000, true).allowance(
            "anthropic-credits",
            PoolAllowance {
                remaining_micro_usd: Some(1_000_000_000),
                expires_at: None,
            },
        );
        assert_eq!(served(model, &paid, &capped), None);
        assert_eq!(
            served(model, &free, &capped).map(|p| p.basis),
            Some(SupplyBasis::FreeCredit)
        );
        // The same pool reported uncapped: paid traffic is cut over.
        assert_eq!(
            served(model, &paid, &dialed(10_000, true)).map(|p| p.basis),
            Some(SupplyBasis::PaidRollout)
        );
    }

    #[test]
    fn paid_rollout_fails_closed_on_an_unreported_pool() {
        let paid = ctx(9_000_000, &[]);
        let free = ctx(0, &[("anthropic-credits", 5_000)]);
        let model = "anthropic/claude-sonnet-4.5";
        // No allowance observed for the pool (an older control plane, or none
        // seen yet): paid stays on the Ryu Router route, free credit does not.
        let mut unknown = dialed(10_000, true);
        unknown.allowances.clear();
        assert_eq!(served(model, &paid, &unknown), None);
        assert!(served(model, &free, &unknown).is_some());
        // Another pool's report says nothing about this one.
        let other = unknown.allowance("bedrock", PoolAllowance::default());
        assert_eq!(served(model, &paid, &other), None);
    }

    #[test]
    fn a_tool_loop_caller_is_never_cut_over() {
        let model = "anthropic/claude-sonnet-4.5";
        let mut paid = ctx(9_000_000, &[]);
        paid.tools_header_present = true;
        assert_eq!(served(model, &paid, &dialed(10_000, true)), None);
        // Free credit is unchanged: the tool loop was already served there.
        let mut free = ctx(0, &[("anthropic-credits", 5_000)]);
        free.tools_header_present = true;
        assert!(served(model, &free, &dialed(0, true)).is_some());
    }

    #[test]
    fn a_long_context_paid_prompt_stays_on_the_ryu_router_route() {
        let model = "anthropic/claude-sonnet-4.5";
        let paid = ctx(9_000_000, &[]);
        let supply = dialed(10_000, true);
        let at = |tokens: u64, ctx: &RequestContext| plan(model, true, tokens, ctx, &supply, now());
        assert!(at(PAID_MAX_PROMPT_TOKENS, &paid).is_some(), "at the limit");
        assert_eq!(at(PAID_MAX_PROMPT_TOKENS + 1, &paid), None, "over it");
        assert_eq!(at(300_000, &paid), None, "a 300k prompt is never cut over");
        // Free credit spends Ryu's own supply, so a long prompt is unchanged.
        let free = ctx(0, &[("anthropic-credits", 5_000)]);
        assert_eq!(
            at(300_000, &free).map(|plan| plan.basis),
            Some(SupplyBasis::FreeCredit)
        );
    }

    #[test]
    fn free_credit_keeps_priority_over_the_paid_dial() {
        let free = ctx(9_000_000, &[("bedrock", 5_000)]);
        let plan = served("anthropic/claude-sonnet-4.5", &free, &dialed(0, true)).unwrap();
        assert_eq!(plan.basis, SupplyBasis::FreeCredit);
    }

    #[test]
    fn the_paid_cohort_is_the_org_then_the_user_then_the_request() {
        let mut ctx = ctx(1, &[]);
        assert_eq!(rollout_cohort(&ctx), "o1");
        ctx.org_id = Some(String::new());
        ctx.user_id = Some("u1".to_owned());
        assert_eq!(rollout_cohort(&ctx), "u1");
        ctx.user_id = None;
        ctx.request_id = "r1".to_owned();
        assert_eq!(rollout_cohort(&ctx), "r1");
    }

    #[test]
    fn a_dynamic_row_with_no_alias_plans_to_its_slot_under_the_picked_id() {
        let ctx = ctx(0, &[("anthropic-credits", 5_000)]);
        let supply = Supply::all().with_table(published(
            &[(
                "anthropic/claude-opus-4.1",
                "anthropic-credits",
                "claude-opus-4-1",
                0,
            )],
            &[],
        ));
        let plan = served("Anthropic/Claude-Opus-4.1", &ctx, &supply).unwrap();
        assert_eq!(plan.slot, "anthropic-credits");
        assert_eq!(plan.upstream, "claude-opus-4-1");
        assert_eq!(plan.shown_model, "Anthropic/Claude-Opus-4.1");
        // Not in the published table (disabled / absent): the normal route.
        assert_eq!(served("anthropic/claude-sonnet-4.5", &ctx, &supply), None);
    }

    #[test]
    fn unroutable_or_disallowed_rows_give_no_plan() {
        let ctx = ctx(0, &[("openai-credits", 5_000)]);
        // No canary / quarantined here.
        assert_eq!(
            served(
                "openai/o3",
                &ctx,
                &Supply::all().blocking("openai-credits", "o3")
            ),
            None
        );
        // The caller's policy does not allow the picked id.
        assert_eq!(
            served("openai/o3", &ctx, &Supply::all().denying("openai/o3")),
            None
        );
        // Several slots: an unroutable one is skipped for the next.
        let supply = Supply::all()
            .with_table(published(
                &[
                    ("x/model", "bedrock", "x.model-v1:0", 0),
                    ("x/model", "cloudflare", "@cf/x/model", 1),
                ],
                &[],
            ))
            .blocking("bedrock", "x.model-v1:0");
        assert_eq!(served("x/model", &ctx, &supply).unwrap().slot, "cloudflare");
    }

    #[test]
    fn the_default_model_comes_from_the_published_pool_defaults() {
        let ctx = ctx(0, &[("cloudflare", 9_000)]);
        let supply = Supply::all().with_table(published(
            &[
                (
                    "meta-llama/llama-3.3-70b-instruct",
                    "cloudflare",
                    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
                    0,
                ),
                (
                    "meta-llama/llama-3.1-8b-instruct",
                    "cloudflare",
                    "@cf/meta/llama-3.1-8b-instruct",
                    0,
                ),
            ],
            &[("cloudflare", "meta-llama/llama-3.3-70b-instruct")],
        ));
        let plan = served("openrouter/auto", &ctx, &supply).unwrap();
        assert_eq!(plan.shown_model, "meta-llama/llama-3.3-70b-instruct");
        assert_eq!(plan.upstream, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
        // No default for the pool: the normal route.
        let no_default = Supply::all().with_table(published(
            &[(
                "meta-llama/llama-3.1-8b-instruct",
                "cloudflare",
                "@cf/meta/llama-3.1-8b-instruct",
                0,
            )],
            &[],
        ));
        assert_eq!(served("openrouter/auto", &ctx, &no_default), None);
    }

    fn rejected(status: u16, message: &str) -> GatewayError {
        GatewayError::ProviderRejected {
            status,
            message: message.to_owned(),
            signal: None,
        }
    }

    /// Every safety and policy outcome the Gateway produces about one request.
    fn safety_outcomes() -> Vec<GatewayError> {
        vec![
            GatewayError::FirewallBlocked("Inbound content blocked".into(), None),
            GatewayError::PolicyViolation("model not allowed".into()),
            GatewayError::PlatformRefused {
                code: "feature_not_permitted",
                message: "This feature is not permitted on the hosted Gateway.",
            },
            GatewayError::RateLimited,
        ]
    }

    #[test]
    fn only_a_structured_not_found_or_refused_credential_marks_the_row_unavailable() {
        assert!(is_row_unavailable(&rejected(
            404,
            "anthropic-credits returned 404: model not_found"
        )));
        assert!(is_row_unavailable(&rejected(401, "invalid x-api-key")));
        // A 403 is how an upstream refuses one request's content: it must not
        // take the row away from every other caller.
        assert!(!is_row_unavailable(&rejected(403, "HTTP 403 Forbidden")));
        assert!(!is_row_unavailable(&rejected(400, "model not found")));
        // Message text never decides: it can echo the request.
        for message in [
            "HTTP 403 Forbidden",
            "404 not found",
            "model does not exist",
            "no access",
            "not available",
        ] {
            assert!(
                !is_row_unavailable(&GatewayError::ProviderError(message.into())),
                "{message}"
            );
            assert!(
                !is_row_unavailable(&GatewayError::NoProvider(message.into())),
                "{message}"
            );
        }
        assert!(!is_row_unavailable(&GatewayError::ProviderRateLimited {
            provider: "bedrock".into(),
            retry_after: None,
            reset_at: None,
        }));
        for outcome in safety_outcomes() {
            assert!(!is_row_unavailable(&outcome), "{outcome:?}");
        }
    }

    #[test]
    fn safety_outcomes_and_upstream_refusals_never_fall_back_to_the_ryu_router() {
        let plain = super::super::test_support::plain_request_context();
        for outcome in safety_outcomes() {
            assert!(!may_fall_back(&outcome, &plain), "{outcome:?}");
        }
        for status in [400, 401, 403, 404, 409, 413, 422, 451] {
            assert!(
                !may_fall_back(&rejected(status, "refused"), &plain),
                "{status}"
            );
        }
        // A 402 is an upstream 4xx: it is returned, not re-run.
        assert!(!may_fall_back(
            &GatewayError::ProviderPaymentRequired {
                provider: "anthropic-credits".into(),
                message: "credit balance too low".into(),
            },
            &plain
        ));
        // Benign controls: genuine health faults and capacity still move a
        // free-credit caller to the Ryu Router route.
        assert!(may_fall_back(
            &GatewayError::ProviderError("anthropic error 503".into()),
            &plain
        ));
        assert!(may_fall_back(
            &GatewayError::ProviderTransport("connection failed".into()),
            &plain
        ));
        assert!(may_fall_back(
            &GatewayError::ProviderRateLimited {
                provider: "anthropic-credits".into(),
                retry_after: Some(1),
                reset_at: None,
            },
            &plain
        ));
    }

    #[test]
    fn only_pre_output_failures_without_a_tool_loop_fall_back() {
        let plain = super::super::test_support::plain_request_context();
        assert!(may_fall_back(
            &GatewayError::CircuitOpen("anthropic-credits".into()),
            &plain
        ));
        assert!(may_fall_back(&GatewayError::InsufficientCredits, &plain));
        assert!(!may_fall_back(
            &GatewayError::ProviderDeliveryUncertain("x".into()),
            &plain
        ));
        assert!(!may_fall_back(&GatewayError::BudgetExceeded(None), &plain));
        let mut tools = plain;
        tools.tools_header_present = true;
        assert!(!may_fall_back(
            &GatewayError::ProviderError("x".into()),
            &tools
        ));
    }

    #[test]
    fn an_approved_alias_authorizes_its_own_upstream_route_only() {
        let state = crate::state::AppState::new_for_test_default();
        let mut ctx = super::super::test_support::plain_request_context();
        ctx.resolved_policy = Some(crate::policy::EffectivePolicy {
            approved_models: vec!["ryu-code/max".to_owned()],
            ..crate::policy::EffectivePolicy::default()
        });
        let route = |provider: &str, model: &str| super::super::RouteDecision {
            provider: crate::config::ProviderId::from(provider),
            model: model.to_owned(),
        };
        assert!(super::super::authorize_routed_model(
            &state,
            &ctx,
            "ryu-code/max",
            &route("anthropic-credits", "claude-opus-4-5"),
        )
        .is_ok());
        // Anything else the route turns into is still checked.
        assert!(super::super::authorize_routed_model(
            &state,
            &ctx,
            "ryu-code/max",
            &route("anthropic", "claude-opus-4-5"),
        )
        .is_err());
        assert!(super::super::authorize_routed_model(
            &state,
            &ctx,
            "claude-opus-4-5",
            &route("anthropic-credits", "claude-opus-4-5"),
        )
        .is_err());
    }

    #[test]
    fn own_supply_never_shares_a_fallback_chain() {
        use crate::config::ProviderId;
        let chain = || {
            [
                "anthropic-credits",
                "anthropic",
                "bedrock",
                "openrouter",
                "local",
            ]
            .map(ProviderId::from)
            .to_vec()
        };
        let lane = |primary: &str| {
            super::super::keep_own_supply_in_its_lane(&ProviderId::from(primary), chain())
                .iter()
                .map(|p| p.as_str().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(lane("anthropic-credits"), ["anthropic-credits"]);
        assert_eq!(lane("anthropic"), ["anthropic", "openrouter", "local"]);
        assert_eq!(lane("openrouter"), ["anthropic", "openrouter", "local"]);
    }
}
