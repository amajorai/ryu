//! The budgets one applicable cap is checked against: its total budget and
//! each funding budget (contract §2 and §6).
//!
//! A funding budget caps the part of the cap's spend paid from one credit
//! source. The gateway's spend counters cannot tell the sources apart, so the
//! paid split comes from the control plane's ledger (`limitsSpend` entries'
//! `fundingSpendMicroUsd`), and the spend this gateway served since that
//! snapshot is attributed to the source the org wallet draws from next
//! (resolve `fundingDrawSource`). When the draw source is unknown that spend
//! counts toward both sources, so an unknown source never opens spend.
//!
//! An exhausted funding budget gates only spend that can still reach it: when
//! the wallet draws from the other source, the request is paid from that one,
//! so the exhausted budget is left out (a known draw source of the other kind
//! is the only way out; an unknown one keeps it, fail closed).

use super::{Applicable, FundingSource, OrgLimitContext};
use crate::budget::SpendStore;

/// Every `(budget, used)` pair `cap` is checked against: the total budget
/// first when one is set, then each configured funding budget that can still
/// be charged (see [`gates`]). Non-exhausted funding budgets are always kept so
/// their early-warning thresholds still alert.
pub(super) fn budget_checks(
    store: &dyn SpendStore,
    limit_ctx: &OrgLimitContext,
    cap: &Applicable<'_>,
    now: i64,
) -> Vec<(u64, u64)> {
    let spec = cap.spec;
    let mut funding = spec.funding_budgets.caps().peekable();
    if spec.budget_micro_usd.is_none() && funding.peek().is_none() {
        return Vec::new();
    }
    let window = spec.budget_window;
    let local = store.spent(cap.scope.as_str(), &cap.store_id, window, now);
    let remote = limit_ctx.remote_spend.as_deref();
    let mut checks = Vec::with_capacity(3);
    if let Some(budget) = spec.budget_micro_usd {
        let used = remote.map_or(local, |remote| {
            remote.effective(cap.scope, cap.subject, &cap.store_id, window, local, now)
        });
        checks.push((budget, used));
    }
    for (source, budget) in funding {
        let used = funding_used(limit_ctx, cap, source, local, now);
        if used < budget || gates(limit_ctx.funding_draw_source, source) {
            checks.push((budget, used));
        }
    }
    checks
}

/// Whether an exhausted `source` budget blocks a request: only when the wallet
/// draws from `source` next, or the draw source is unknown (fail closed).
fn gates(draw: Option<FundingSource>, source: FundingSource) -> bool {
    draw.is_none_or(|drawn| drawn == source)
}

/// Spend paid from `source` for `cap`. Without a snapshot the whole local
/// counter is unreported spend, attributed by the draw source.
fn funding_used(
    limit_ctx: &OrgLimitContext,
    cap: &Applicable<'_>,
    source: FundingSource,
    local: u64,
    now: i64,
) -> u64 {
    let draw = limit_ctx.funding_draw_source;
    match limit_ctx.remote_spend.as_deref() {
        Some(remote) => remote.funding_used(
            source,
            draw,
            (cap.scope, cap.subject, &cap.store_id),
            cap.spec.budget_window,
            local,
            now,
        ),
        None if draw.is_none_or(|drawn| drawn == source) => local,
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{context, spec, NOW};
    use super::super::{record, LimitAction, OrgLimits};
    use super::*;
    use crate::budget::{BudgetScope, MemorySpendStore};

    #[test]
    fn checks_the_total_then_each_funding_budget_against_attributed_spend() {
        let mut org = spec(100, LimitAction::Stop);
        org.funding_budgets.subscription_micro_usd = Some(50);
        org.funding_budgets.api_micro_usd = Some(40);
        let limits = OrgLimits {
            org: Some(org.clone()),
            ..OrgLimits::default()
        };
        let store = MemorySpendStore::new();
        let mut ctx = context(limits, &[]);
        record(&store, &ctx, None, 30, NOW);
        let cap = Applicable {
            scope: BudgetScope::Org,
            store_id: "org1".to_owned(),
            subject: "org1",
            spec: &org,
        };
        ctx.funding_draw_source = Some(FundingSource::Subscription);
        assert_eq!(
            budget_checks(&store, &ctx, &cap, NOW),
            [(100, 30), (50, 30), (40, 0)]
        );
        ctx.funding_draw_source = Some(FundingSource::Api);
        assert_eq!(
            budget_checks(&store, &ctx, &cap, NOW),
            [(100, 30), (50, 0), (40, 30)]
        );
        // Unknown draw source: the spend counts toward both (fail closed).
        ctx.funding_draw_source = None;
        assert_eq!(
            budget_checks(&store, &ctx, &cap, NOW),
            [(100, 30), (50, 30), (40, 30)]
        );
    }

    fn org_cap(spec: &super::super::LimitSpec) -> Applicable<'_> {
        Applicable {
            scope: BudgetScope::Org,
            store_id: "org1".to_owned(),
            subject: "org1",
            spec,
        }
    }

    fn decision_with(
        org: super::super::LimitSpec,
        draw: Option<FundingSource>,
        spent: u64,
    ) -> Option<crate::budget::BudgetDecision> {
        let limits = OrgLimits {
            org: Some(org),
            ..OrgLimits::default()
        };
        let store = MemorySpendStore::new();
        let mut ctx = context(limits, &[]);
        ctx.funding_draw_source = draw;
        if spent > 0 {
            record(&store, &ctx, None, spent, NOW);
        }
        super::super::evaluate(&store, &ctx, None, NOW).decision
    }

    #[test]
    fn a_zero_subscription_budget_does_not_block_api_drawn_spend() {
        let mut org = spec(1_000_000, LimitAction::Stop);
        org.funding_budgets.subscription_micro_usd = Some(0);
        assert!(decision_with(org.clone(), Some(FundingSource::Api), 0).is_none());
        assert!(decision_with(org.clone(), Some(FundingSource::Api), 500).is_none());
        // Drawing from the exhausted source, or an unknown one, still stops.
        let stop = decision_with(org.clone(), Some(FundingSource::Subscription), 0)
            .expect("subscription draw stops");
        assert_eq!(stop.action, crate::budget::BudgetAction::Stop);
        assert!(decision_with(org, None, 0).is_some());
    }

    #[test]
    fn an_exhausted_subscription_budget_leaves_the_api_allowance_usable() {
        use super::super::{FundingSpend, RemoteSpend, RemoteSpendEntry};
        // The ledger says the $10k subscription budget is spent; API is unused.
        let mut snapshot = RemoteSpend {
            as_of: NOW,
            ..RemoteSpend::default()
        };
        snapshot.org = Some(RemoteSpendEntry {
            spent_micro_usd: Some(10_000),
            window_start: crate::budget::BudgetWindow::Monthly.start(NOW),
            funding_spend_micro_usd: FundingSpend {
                subscription: 10_000,
                api: 0,
            },
        });
        let snapshot = std::sync::Arc::new(snapshot);
        let mut org = spec(0, LimitAction::Stop);
        org.budget_micro_usd = None;
        org.funding_budgets.subscription_micro_usd = Some(10_000);
        org.funding_budgets.api_micro_usd = Some(1_000);
        let run = |draw: Option<FundingSource>| {
            let limits = OrgLimits {
                org: Some(org.clone()),
                ..OrgLimits::default()
            };
            let mut ctx = context(limits, &[]);
            ctx.remote_spend = Some(std::sync::Arc::clone(&snapshot));
            ctx.funding_draw_source = draw;
            let store = MemorySpendStore::new();
            let checks = budget_checks(&store, &ctx, &org_cap(&org), NOW);
            let decision = super::super::evaluate(&store, &ctx, None, NOW).decision;
            (checks, decision)
        };
        // Drawing from API: only the (unused) API allowance is checked.
        let (checks, decision) = run(Some(FundingSource::Api));
        assert_eq!(checks, [(1_000, 0)]);
        assert!(decision.is_none());
        // Drawing from the exhausted subscription, or unknown: stop.
        for draw in [Some(FundingSource::Subscription), None] {
            let decision = run(draw).1.expect("exhausted subscription gates");
            assert_eq!(decision.action, crate::budget::BudgetAction::Stop);
            assert_eq!((decision.used, decision.limit), (10_000, 10_000));
        }
    }

    #[test]
    fn an_exhausted_api_budget_still_stops_api_drawn_spend() {
        let mut org = spec(1_000_000, LimitAction::Stop);
        org.funding_budgets.api_micro_usd = Some(100);
        org.funding_budgets.subscription_micro_usd = Some(1_000_000);
        let stop =
            decision_with(org.clone(), Some(FundingSource::Api), 100).expect("api draw stops");
        assert_eq!(stop.action, crate::budget::BudgetAction::Stop);
        // Drawing from the subscription the exhausted API budget is skipped.
        assert!(decision_with(org, Some(FundingSource::Subscription), 100).is_none());
    }

    #[test]
    fn a_cap_without_any_budget_has_nothing_to_check() {
        let mut rate_only = spec(0, LimitAction::Stop);
        rate_only.budget_micro_usd = None;
        let ctx = context(OrgLimits::default(), &[]);
        let cap = Applicable {
            scope: BudgetScope::Org,
            store_id: "org1".to_owned(),
            subject: "org1",
            spec: &rate_only,
        };
        assert!(budget_checks(&MemorySpendStore::new(), &ctx, &cap, NOW).is_empty());
    }
}
