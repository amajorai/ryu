use std::collections::HashMap;

use super::tests::{context, spec, NOW};
use super::*;
use crate::budget::{BudgetWindow, MemorySpendStore};

#[test]
fn spend_is_counted_before_a_cap_exists_so_a_new_cap_sees_it() {
    let store = MemorySpendStore::default();
    let uncapped = context(OrgLimits::default(), &["t1", "t2"]);
    record(&store, &uncapped, Some("u1"), 70, NOW);
    for (scope, id) in [
        ("org", "org1"),
        ("member", "org1:u1"),
        ("team", "org1:t1"),
        ("team", "org1:t2"),
        ("key", "cred1"),
    ] {
        assert_eq!(
            store.spent(scope, id, BudgetWindow::Daily, NOW),
            70,
            "{scope}"
        );
        assert_eq!(
            store.spent(scope, id, BudgetWindow::Monthly, NOW),
            70,
            "{scope}"
        );
    }

    // An admin now adds a team cap mid-window: earlier spend counts.
    let mut teams = HashMap::new();
    teams.insert("t2".to_owned(), spec(50, LimitAction::Stop));
    let capped = context(
        OrgLimits {
            teams,
            ..OrgLimits::default()
        },
        &["t1", "t2"],
    );
    let decision = evaluate(&store, &capped, Some("u1"), NOW).decision.unwrap();
    assert_eq!(decision.scope, BudgetScope::Team);
    assert_eq!(decision.key, "t2");
    assert_eq!(decision.used, 70);

    // A stored subject (async settlement) charges the same counters.
    let subject = OrgLimitSubject::new(&capped, Some("u1"));
    record_subject(&store, &subject, 5, NOW);
    assert_eq!(store.spent("team", "org1:t2", BudgetWindow::Daily, NOW), 75);
    assert_eq!(store.spent("key", "cred1", BudgetWindow::Daily, NOW), 75);
}

fn remote(org_spent: u64, window_start: i64, as_of: i64) -> Arc<RemoteSpend> {
    Arc::new(RemoteSpend {
        as_of,
        org: Some(RemoteSpendEntry {
            spent_micro_usd: Some(org_spent),
            window_start,
            ..RemoteSpendEntry::default()
        }),
        ..RemoteSpend::default()
    })
}

fn org_capped(cap: u64, remote_spend: Option<Arc<RemoteSpend>>) -> OrgLimitContext {
    let mut ctx = context(
        OrgLimits {
            org: Some(spec(cap, LimitAction::Stop)),
            ..OrgLimits::default()
        },
        &[],
    );
    ctx.remote_spend = remote_spend;
    ctx
}

/// A simulated gateway: its own durable counter, the spend it has not yet
/// reported, and the snapshot from its latest resolve.
struct SimGateway {
    store: MemorySpendStore,
    unreported: u64,
    ctx: OrgLimitContext,
}

impl SimGateway {
    fn new(cap: u64) -> Self {
        Self {
            store: MemorySpendStore::new(),
            unreported: 0,
            ctx: org_capped(cap, None),
        }
    }

    /// Serve one request of `cost` if every cap admits it.
    fn serve(&mut self, cost: u64, now: i64) -> bool {
        if evaluate(&self.store, &self.ctx, None, now)
            .decision
            .is_some()
        {
            return false;
        }
        record(&self.store, &self.ctx, None, cost, now);
        self.unreported += cost;
        true
    }
}

#[test]
fn remote_spend_deserializes_and_null_or_missing_means_none() {
    let parsed: RemoteSpend = serde_json::from_value(serde_json::json!({
        "asOf": NOW,
        "org": { "spentMicroUsd": 900, "windowStart": 1_790_812_800 },
        "members": null,
        "teams": { "t1": { "spentMicroUsd": -4, "windowStart": 0 } },
    }))
    .unwrap();
    assert_eq!(parsed.org.unwrap().spent_micro_usd, Some(900));
    assert!(parsed.members.is_empty() && parsed.keys.is_empty());
    assert_eq!(parsed.teams["t1"].spent_micro_usd, None);
}

#[test]
fn missing_or_unusable_remote_spend_leaves_local_enforcement_unchanged() {
    let month = BudgetWindow::Monthly.start(NOW);
    let cases = [
        ("no snapshot", None),
        ("other window", Some(remote(5_000, month - 86_400, NOW))),
        (
            "stale snapshot",
            Some(remote(5_000, month, NOW - 2 * 3_600)),
        ),
        ("other scope only", {
            let mut keys = HashMap::new();
            keys.insert(
                "someone-else".to_owned(),
                RemoteSpendEntry {
                    spent_micro_usd: Some(5_000),
                    window_start: month,
                    ..RemoteSpendEntry::default()
                },
            );
            Some(Arc::new(RemoteSpend {
                as_of: NOW,
                keys,
                ..RemoteSpend::default()
            }))
        }),
    ];
    for (label, remote_spend) in cases {
        let store = MemorySpendStore::new();
        let ctx = org_capped(1_000, remote_spend);
        record(&store, &ctx, None, 999, NOW);
        assert!(
            evaluate(&store, &ctx, None, NOW).decision.is_none(),
            "{label}: 999 of 1000 is admitted"
        );
        record(&store, &ctx, None, 1, NOW);
        let decision = evaluate(&store, &ctx, None, NOW).decision.unwrap();
        assert_eq!(decision.used, 1_000, "{label}: local counter only");
    }
}

#[test]
fn a_new_instance_starts_from_the_fleet_aggregate_not_zero() {
    let month = BudgetWindow::Monthly.start(NOW);
    let store = MemorySpendStore::new();
    let ctx = org_capped(1_000, Some(remote(900, month, NOW)));
    let first = evaluate(&store, &ctx, None, NOW);
    assert!(first.decision.is_none());
    assert_eq!(first.alert.unwrap().enforcement, "notify", "80% crossed");
    record(&store, &ctx, None, 100, NOW);
    let decision = evaluate(&store, &ctx, None, NOW).decision.unwrap();
    assert_eq!(decision.scope, BudgetScope::Org);
    assert_eq!(decision.used, 1_000, "aggregate 900 + local 100");

    // Member, team, and key aggregates apply to their own scopes too.
    let mut member = spec(500, LimitAction::Stop);
    member.alert_thresholds_pct.clear();
    let mut limits = OrgLimits {
        member_default: Some(member.clone()),
        ..OrgLimits::default()
    };
    limits.teams.insert("t1".to_owned(), member.clone());
    limits.keys.insert("cred1".to_owned(), member);
    let entry = RemoteSpendEntry {
        spent_micro_usd: Some(500),
        window_start: month,
        ..RemoteSpendEntry::default()
    };
    for scope in [BudgetScope::Member, BudgetScope::Team, BudgetScope::Key] {
        let mut snapshot = RemoteSpend {
            as_of: NOW,
            ..RemoteSpend::default()
        };
        match scope {
            BudgetScope::Member => snapshot.members.insert("u1".to_owned(), entry),
            BudgetScope::Team => snapshot.teams.insert("t1".to_owned(), entry),
            _ => snapshot.keys.insert("cred1".to_owned(), entry),
        };
        let mut ctx = context(limits.clone(), &["t1"]);
        ctx.remote_spend = Some(Arc::new(snapshot));
        let decision = evaluate(&MemorySpendStore::new(), &ctx, Some("u1"), NOW)
            .decision
            .unwrap();
        assert_eq!(decision.scope, scope);
        assert_eq!(decision.used, 500);
    }
}

#[test]
fn a_truncated_snapshot_admits_omitted_subjects_against_the_largest_omitted_spend() {
    let month = BudgetWindow::Monthly.start(NOW);
    let parsed: RemoteSpend = serde_json::from_value(serde_json::json!({
        "asOf": NOW,
        "org": null,
        "members": { "listed": { "spentMicroUsd": 900, "windowStart": month } },
        "teams": {}, "keys": {},
        "truncated": true,
        "omitted": { "members": 400, "teams": null, "keys": null }
    }))
    .unwrap();
    let snapshot = Arc::new(parsed);
    let mut member = spec(450, LimitAction::Stop);
    member.alert_thresholds_pct.clear();
    let limits = OrgLimits {
        member_default: Some(member.clone()),
        ..OrgLimits::default()
    };
    let mut ctx = context(limits, &[]);
    ctx.remote_spend = Some(Arc::clone(&snapshot));
    let store = MemorySpendStore::new();

    // A member the snapshot left out may have spent up to 400: 400 + 60
    // served here exceeds the 450 cap although the local counter is 60.
    assert!(evaluate(&store, &ctx, Some("unlisted"), NOW)
        .decision
        .is_none());
    record(&store, &ctx, Some("unlisted"), 60, NOW);
    let decision = evaluate(&store, &ctx, Some("unlisted"), NOW)
        .decision
        .expect("omitted member is not admitted on its local count alone");
    assert_eq!(decision.used, 460);
    // A listed member uses its own figure.
    assert_eq!(
        evaluate(&store, &ctx, Some("listed"), NOW)
            .decision
            .unwrap()
            .used,
        900
    );
    // No ceiling for a scope (teams here) keeps local enforcement.
    let mut teams = HashMap::new();
    teams.insert("t1".to_owned(), member);
    let mut team_ctx = context(
        OrgLimits {
            teams,
            ..OrgLimits::default()
        },
        &["t1"],
    );
    team_ctx.remote_spend = Some(Arc::clone(&snapshot));
    let team_store = MemorySpendStore::new();
    record(&team_store, &team_ctx, None, 60, NOW);
    assert!(evaluate(&team_store, &team_ctx, None, NOW)
        .decision
        .is_none());

    // An untruncated snapshot means an unlisted member spent nothing.
    let complete: RemoteSpend = serde_json::from_value(serde_json::json!({
        "asOf": NOW,
        "omitted": { "members": 400 }
    }))
    .unwrap();
    ctx.remote_spend = Some(Arc::new(complete));
    let fresh = MemorySpendStore::new();
    record(&fresh, &ctx, Some("unlisted"), 60, NOW);
    assert!(evaluate(&fresh, &ctx, Some("unlisted"), NOW)
        .decision
        .is_none());

    // A snapshot from before this window says nothing about it.
    let previous: RemoteSpend = serde_json::from_value(serde_json::json!({
        "asOf": month - 10,
        "truncated": true,
        "omitted": { "members": 400 }
    }))
    .unwrap();
    ctx.remote_spend = Some(Arc::new(previous));
    assert!(evaluate(&fresh, &ctx, Some("unlisted"), month + 100)
        .decision
        .is_none());
}

#[test]
fn two_gateways_sharing_the_aggregate_overshoot_by_at_most_one_report_interval() {
    const CAP: u64 = 10_000;
    const COST: u64 = 100;
    // Each gateway serves this many requests per report interval.
    const PER_INTERVAL: usize = 3;
    let month = BudgetWindow::Monthly.start(NOW);

    // Today's behavior for contrast: without an aggregate every gateway
    // spends the whole cap.
    let mut isolated = [SimGateway::new(CAP), SimGateway::new(CAP)];
    for _ in 0..1_000 {
        for gateway in &mut isolated {
            gateway.serve(COST, NOW);
        }
    }
    let isolated_total: u64 = isolated.iter().map(|g| g.unreported).sum();
    assert_eq!(isolated_total, 2 * CAP);

    let mut fleet = [SimGateway::new(CAP), SimGateway::new(CAP)];
    let mut cloud = 0_u64;
    for _ in 0..1_000 {
        for _ in 0..PER_INTERVAL {
            for gateway in &mut fleet {
                gateway.serve(COST, NOW);
            }
        }
        // Report interval: every gateway reports, then re-resolves.
        for gateway in &mut fleet {
            cloud += std::mem::take(&mut gateway.unreported);
        }
        for gateway in &mut fleet {
            gateway.ctx.remote_spend = Some(remote(cloud, month, NOW));
        }
    }
    let bound = fleet.len() as u64 * PER_INTERVAL as u64 * COST;
    assert!(cloud >= CAP, "the fleet may use the whole cap ({cloud})");
    assert!(
        cloud <= CAP + bound,
        "fleet spent {cloud}, over cap {CAP} + one interval of fleet traffic {bound}"
    );
    // Once the aggregate is known, nobody admits more.
    for gateway in &mut fleet {
        assert!(!gateway.serve(COST, NOW));
    }
}
