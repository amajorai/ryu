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

mod part2;

#[test]
fn a_grant_serves_only_picks_from_its_own_pool() {
    // SEPARATE POOLS: Anthropic-campaign credit pays for a Claude pick served
    // by Ryu's own Anthropic slot...
    let ctx = ctx(0, &[("anthropic-credits", 5_000_000)]);
    let plan = served("anthropic/claude-sonnet-4.5", &ctx, &Supply::all()).unwrap();
    assert_eq!(plan.slot, "anthropic-credits");
    assert_eq!(plan.upstream, "claude-sonnet-4-5");
    assert_eq!(plan.shown_model, "anthropic/claude-sonnet-4.5");
    assert_eq!(plan.basis, SupplyBasis::FreeCredit);
    // ...but never for an OpenAI pick, which another pool's supply serves.
    assert_eq!(served("openai/o3", &ctx, &Supply::all()), None);
    // OpenAI-campaign credit cannot pay for Claude either.
    let openai = super::tests::ctx(0, &[("openai-credits", 5_000_000)]);
    assert_eq!(
        served("anthropic/claude-sonnet-4.5", &openai, &Supply::all()),
        None
    );
    // A retired pool's grant (Bedrock) still pays for any own supply, whatever
    // the paid balance: free credit is spent first.
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
