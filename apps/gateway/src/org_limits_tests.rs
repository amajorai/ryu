use super::*;
use crate::budget::MemorySpendStore;

// 2026-10-08T15:30:00Z
const NOW: i64 = 1_791_473_400;

fn spec(budget: u64, action: LimitAction) -> LimitSpec {
    LimitSpec {
        budget_micro_usd: Some(budget),
        budget_window: BudgetWindow::Monthly,
        budget_action: action,
        downgrade_model: None,
        alert_thresholds_pct: vec![50, 80, 100],
        rpm: None,
        tpm: None,
    }
}

fn context(limits: OrgLimits, teams: &[&str]) -> OrgLimitContext {
    OrgLimitContext {
        org_id: "org1".to_owned(),
        limits: Arc::new(limits),
        credential_id: Some("cred1".to_owned()),
        service_account_id: None,
        bound_user_id: None,
        team_ids: teams.iter().map(|team| (*team).to_owned()).collect(),
        remote_spend: None,
        active_gateways: None,
        tags: Vec::new(),
    }
}

#[test]
fn deserializes_contract_shape_with_nulls_and_lenient_values() {
    let limits: OrgLimits = serde_json::from_value(serde_json::json!({
        "org": null,
        "memberDefault": {
            "budgetMicroUsd": 2_000_000.0,
            "budgetWindow": "fortnightly",
            "budgetAction": "explode",
            "downgradeModel": null,
            "alertThresholdsPct": [80, 50, 50, 250, -1],
            "rpm": 0,
            "tpm": null
        },
        "members": null,
        "teams": {},
        "keys": { "k": { "budgetMicroUsd": null } }
    }))
    .unwrap();
    let member = limits.member_default.as_ref().unwrap();
    assert_eq!(member.budget_micro_usd, Some(2_000_000));
    assert_eq!(member.budget_window, BudgetWindow::Monthly);
    assert_eq!(member.budget_action, LimitAction::Stop);
    assert_eq!(member.alert_thresholds_pct, vec![50, 80]);
    assert_eq!(member.rpm, None, "a 0 rate is ignored");
    assert!(limits.members.is_empty());
    assert_eq!(limits.keys["k"].budget_micro_usd, None);
    assert!(!limits.is_empty());
    assert!(OrgLimits::default().is_empty());
}

#[test]
fn zero_budget_is_a_hard_cap_not_unlimited() {
    let spec: LimitSpec =
        serde_json::from_value(serde_json::json!({ "budgetMicroUsd": 0 })).unwrap();
    assert_eq!(spec.budget_micro_usd, Some(0));
    let negative: LimitSpec =
        serde_json::from_value(serde_json::json!({ "budgetMicroUsd": -5 })).unwrap();
    assert_eq!(negative.budget_micro_usd, None);
}

#[test]
fn every_applicable_cap_is_checked_and_any_stop_blocks() {
    let store = MemorySpendStore::new();
    let mut limits = OrgLimits {
        org: Some(spec(1_000_000, LimitAction::Notify)),
        member_default: Some(spec(100, LimitAction::Notify)),
        ..OrgLimits::default()
    };
    limits
        .teams
        .insert("t1".to_owned(), spec(50, LimitAction::Stop));
    let ctx = context(limits, &["t1"]);
    record(&store, &ctx, Some("u1"), 60, NOW);
    let outcome = evaluate(&store, &ctx, Some("u1"), NOW);
    let decision = outcome.decision.expect("team cap exhausted");
    assert_eq!(decision.scope, BudgetScope::Team);
    assert_eq!(decision.action, BudgetAction::Stop);
    assert_eq!(decision.key, "t1");
    assert_eq!(decision.used, 60);
    // The org cap recorded the same spend under its own scope.
    assert_eq!(store.spent("org", "org1", BudgetWindow::Monthly, NOW), 60);
    assert_eq!(
        store.spent("member", "org1:u1", BudgetWindow::Monthly, NOW),
        60
    );
}

#[test]
fn explicit_member_entry_overrides_the_default() {
    let store = MemorySpendStore::new();
    let mut limits = OrgLimits {
        member_default: Some(spec(10, LimitAction::Stop)),
        ..OrgLimits::default()
    };
    limits
        .members
        .insert("vip".to_owned(), spec(1_000, LimitAction::Stop));
    let ctx = context(limits, &[]);
    record(&store, &ctx, Some("vip"), 20, NOW);
    record(&store, &ctx, Some("other"), 20, NOW);
    assert!(evaluate(&store, &ctx, Some("vip"), NOW).decision.is_none());
    assert!(evaluate(&store, &ctx, Some("other"), NOW)
        .decision
        .is_some());
    // An unattributed request has no member cap at all.
    assert!(evaluate(&store, &ctx, None, NOW).decision.is_none());
}

#[test]
fn downgrade_without_a_model_restricts_and_key_cap_applies() {
    let store = MemorySpendStore::new();
    let mut limits = OrgLimits::default();
    limits
        .keys
        .insert("cred1".to_owned(), spec(10, LimitAction::Downgrade));
    let ctx = context(limits, &[]);
    record(&store, &ctx, None, 10, NOW);
    let decision = evaluate(&store, &ctx, None, NOW).decision.unwrap();
    assert_eq!(decision.scope, BudgetScope::Key);
    assert_eq!(decision.action, BudgetAction::Restrict);
    assert_eq!(decision.alert, AlertTier::Warn);
}

#[test]
fn service_account_cap_is_shared_by_every_key_of_the_account() {
    let store = MemorySpendStore::new();
    let mut limits = OrgLimits::default();
    limits
        .service_accounts
        .insert("sa1".to_owned(), spec(100, LimitAction::Stop));
    let mut first = context(limits.clone(), &[]);
    first.service_account_id = Some("sa1".to_owned());
    let mut second = context(limits, &[]);
    second.credential_id = Some("cred2".to_owned());
    second.service_account_id = Some("sa1".to_owned());
    record(&store, &first, None, 60, NOW);
    assert!(evaluate(&store, &second, None, NOW).decision.is_none());
    // A second key of the same account spends from the same cap.
    record(&store, &second, None, 40, NOW);
    let decision = evaluate(&store, &first, None, NOW).decision.unwrap();
    assert_eq!(decision.scope, BudgetScope::ServiceAccount);
    assert_eq!(decision.action, BudgetAction::Stop);
    assert_eq!(decision.key, "sa1");
    assert_eq!(decision.used, 100);
    assert_eq!(
        store.spent("service_account", "org1:sa1", BudgetWindow::Monthly, NOW),
        100
    );
    // A node key in the same org has no account and is not capped by it.
    let node = context(first.limits.as_ref().clone(), &[]);
    assert!(evaluate(&store, &node, None, NOW).decision.is_none());
}

#[test]
fn service_account_admits_against_the_fleet_aggregate() {
    let month = BudgetWindow::Monthly.start(NOW);
    let store = MemorySpendStore::new();
    let mut limits = OrgLimits::default();
    let mut cap = spec(500, LimitAction::Stop);
    cap.alert_thresholds_pct.clear();
    limits.service_accounts.insert("sa1".to_owned(), cap);
    let mut snapshot = RemoteSpend {
        as_of: NOW,
        ..RemoteSpend::default()
    };
    snapshot.service_accounts.insert(
        "sa1".to_owned(),
        RemoteSpendEntry {
            spent_micro_usd: Some(500),
            window_start: month,
        },
    );
    let mut ctx = context(limits, &[]);
    ctx.service_account_id = Some("sa1".to_owned());
    ctx.remote_spend = Some(Arc::new(snapshot));
    let decision = evaluate(&store, &ctx, None, NOW).decision.unwrap();
    assert_eq!(decision.scope, BudgetScope::ServiceAccount);
    assert_eq!(decision.used, 500);
}

#[test]
fn tag_budgets_apply_only_to_requests_carrying_the_tag() {
    // Treg parity C6: `limits.tags` is keyed by budget id; the snapshot's
    // `tags` by the same id; the counter is the org's tag.
    let day = BudgetWindow::Daily.start(NOW);
    let limits: OrgLimits = serde_json::from_value(serde_json::json!({
        "tags": {
            "tbg_eudaily1": {
                "tag": "eu",
                "budgetMicroUsd": 1000,
                "budgetWindow": "daily",
                "budgetAction": "stop"
            },
            "tbg_quiet001": {
                "tag": "quiet",
                "budgetMicroUsd": 10,
                "budgetWindow": "monthly",
                "budgetAction": "notify"
            }
        }
    }))
    .unwrap();
    assert!(!limits.is_empty());
    let store = MemorySpendStore::new();
    let mut snapshot = RemoteSpend {
        as_of: NOW,
        ..RemoteSpend::default()
    };
    snapshot.tags.insert(
        "tbg_eudaily1".to_owned(),
        RemoteSpendEntry {
            spent_micro_usd: Some(900),
            window_start: day,
        },
    );
    let snapshot = Arc::new(snapshot);
    // Untagged: no tag cap applies.
    let mut ctx = context(limits.clone(), &[]);
    ctx.remote_spend = Some(Arc::clone(&snapshot));
    assert!(evaluate(&store, &ctx, None, NOW).decision.is_none());
    // Tagged `eu`: admitted under the cap, refused once local spend
    // since the snapshot carries it to the limit.
    ctx.tags = vec!["eu".to_owned()];
    assert!(evaluate(&store, &ctx, None, NOW).decision.is_none());
    record(&store, &ctx, None, 100, NOW);
    assert_eq!(store.spent("tag", "org1:eu", BudgetWindow::Daily, NOW), 100);
    let decision = evaluate(&store, &ctx, None, NOW).decision.unwrap();
    assert_eq!(decision.scope, BudgetScope::Tag);
    assert_eq!(decision.key, "tbg_eudaily1");
    assert_eq!(decision.action, BudgetAction::Stop);
    assert_eq!(decision.used, 1000);
    // A notify tag budget never blocks.
    let mut quiet = context(limits, &[]);
    quiet.tags = vec!["quiet".to_owned()];
    record(&store, &quiet, None, 50, NOW);
    let decision = evaluate(&store, &quiet, None, NOW).decision.unwrap();
    assert_eq!(decision.action, BudgetAction::Notify);
}

#[test]
fn an_unbudgeted_tag_records_no_counter_but_stays_on_the_subject() {
    let limits: OrgLimits = serde_json::from_value(serde_json::json!({
        "tags": {
            "tbg_eudaily1": {
                "tag": "eu",
                "budgetMicroUsd": 1000,
                "budgetWindow": "daily",
                "budgetAction": "stop"
            }
        }
    }))
    .unwrap();
    let store = MemorySpendStore::new();
    let mut ctx = context(limits, &[]);
    ctx.tags = vec!["eu".to_owned(), "made-up-1".to_owned()];
    let subject = OrgLimitSubject::new(&ctx, None);
    // The debit still carries every tag for the control plane's rollup.
    assert_eq!(subject.tags, ["eu", "made-up-1"]);
    assert_eq!(subject.budgeted_tags, ["eu"]);
    record(&store, &ctx, None, 70, NOW);
    assert_eq!(store.spent("tag", "org1:eu", BudgetWindow::Daily, NOW), 70);
    for window in [
        BudgetWindow::Daily,
        BudgetWindow::Monthly,
        BudgetWindow::Lifetime,
    ] {
        assert_eq!(store.spent("tag", "org1:made-up-1", window, NOW), 0);
    }
    // An org with no tag budgets counts no tag at all.
    let mut plain = context(OrgLimits::default(), &[]);
    plain.tags = vec!["anything".to_owned()];
    record(&store, &plain, None, 5, NOW);
    assert_eq!(
        store.spent("tag", "org1:anything", BudgetWindow::Lifetime, NOW),
        0
    );
    assert_eq!(store.spent("org", "org1", BudgetWindow::Daily, NOW), 75);
}

#[tokio::test]
async fn the_tags_header_is_parsed_once_and_a_malformed_one_is_refused() {
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;
    let app = axum::Router::new()
        .route(
            "/",
            axum::routing::get(|| async { current_spend_tags().join("|") }),
        )
        .layer(axum::middleware::from_fn(scope_spend_tags));
    let call = |header: Option<&str>| {
        let app = app.clone();
        let mut request = Request::builder().uri("/");
        if let Some(value) = header {
            request = request.header("x-ryu-tags", value);
        }
        async move {
            app.oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap()
        }
    };
    let body = |response: axum::response::Response| async move {
        String::from_utf8(
            axum::body::to_bytes(response.into_body(), 1 << 16)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap()
    };
    let tagged = call(Some(" EU,checkout ")).await;
    assert_eq!(tagged.status(), 200);
    assert_eq!(body(tagged).await, "checkout|eu");
    let untagged = call(None).await;
    assert_eq!(body(untagged).await, "");
    let refused = call(Some("eu,,us")).await;
    assert_eq!(refused.status(), 400);
    assert!(body(refused).await.contains("empty_tag"));
    // Outside a request there are no tags.
    assert!(current_spend_tags().is_empty());
}

#[test]
fn thresholds_alert_before_the_cap_and_daily_windows_roll_over() {
    let store = MemorySpendStore::new();
    let mut member = spec(100, LimitAction::Stop);
    member.budget_window = BudgetWindow::Daily;
    let ctx = context(
        OrgLimits {
            member_default: Some(member),
            ..OrgLimits::default()
        },
        &[],
    );
    record(&store, &ctx, Some("u1"), 85, NOW);
    let outcome = evaluate(&store, &ctx, Some("u1"), NOW);
    assert!(outcome.decision.is_none());
    let alert = outcome.alert.expect("80% threshold crossed");
    assert_eq!(alert.enforcement, "notify");
    assert_eq!(alert.scope, "member");
    assert_eq!(alert.subject_key, "u1");
    // A second threshold has a different dedupe key than the first.
    let half = PolicyAlert::limit_threshold(
        "member",
        "u1",
        AlertTier::Warn,
        85,
        100,
        50,
        alert_window(NOW),
        "org1",
    );
    assert_ne!(alert.dedupe_key, half.dedupe_key);
    // Tomorrow the daily counter is empty again.
    let tomorrow = NOW + 86_400;
    let next = evaluate(&store, &ctx, Some("u1"), tomorrow);
    assert!(next.decision.is_none() && next.alert.is_none());
}

#[test]
fn denied_member_retries_do_not_drain_the_org_rate_buckets() {
    let rate = crate::rate_limit::ScopedRateLimiter::default();
    let mut org = spec(1_000_000, LimitAction::Stop);
    org.rpm = Some(5);
    org.tpm = Some(1_000);
    let mut member = spec(1_000_000, LimitAction::Stop);
    member.rpm = Some(1);
    member.tpm = Some(100);
    let ctx = context(
        OrgLimits {
            org: Some(org),
            member_default: Some(member),
            ..OrgLimits::default()
        },
        &[],
    );

    assert!(admit_request(&rate, &ctx, Some("u1")));
    for _ in 0..20 {
        assert!(
            !admit_request(&rate, &ctx, Some("u1")),
            "member at its rpm cap"
        );
    }
    // The org bucket paid only for the one admitted request: 4 left.
    for other in ["u2", "u3", "u4", "u5"] {
        assert!(admit_request(&rate, &ctx, Some(other)), "{other} admitted");
    }
    assert!(!admit_request(&rate, &ctx, Some("u6")), "org rpm exhausted");

    assert!(admit_tokens(&rate, &ctx, Some("u1"), 100));
    for _ in 0..20 {
        assert!(!admit_tokens(&rate, &ctx, Some("u1"), 100));
    }
    // 900 org tokens remain despite 2_000 rejected tokens of retries.
    assert!(admit_tokens(&rate, &ctx, None, 900));
    assert!(!admit_tokens(&rate, &ctx, None, 50));
}

#[test]
fn an_oversized_prompt_is_admitted_once_then_throttled_by_its_debt() {
    // The plan's default ceiling (60k tpm) split across two gateways is a
    // 30k share; a 100k-token prompt estimate must still get through once.
    let rate = crate::rate_limit::ScopedRateLimiter::default();
    let mut org = spec(1_000_000, LimitAction::Stop);
    org.tpm = Some(60_000);
    let mut ctx = context(
        OrgLimits {
            org: Some(org),
            ..OrgLimits::default()
        },
        &[],
    );
    ctx.active_gateways = Some(2);
    assert!(admit_tokens(&rate, &ctx, None, 100_000), "admitted once");
    assert!(
        !admit_tokens(&rate, &ctx, None, 1_000),
        "the excess is debt that throttles what follows"
    );
}

#[test]
fn a_plan_rate_ceiling_narrows_the_org_cap_and_never_raises_it() {
    let ceiling = RateCeiling {
        rpm: Some(30),
        tpm: Some(60_000),
    };
    // No org-wide cap: one carrying only the ceiling, with no budget.
    let narrowed = OrgLimits::default().with_rate_ceiling(ceiling);
    let org = narrowed.org.as_ref().expect("org cap");
    assert_eq!((org.rpm, org.tpm), (Some(30), Some(60_000)));
    assert_eq!(org.budget_micro_usd, None);

    // An authored cap keeps its budget; the smaller rate wins each way.
    let mut authored = spec(5_000, LimitAction::Stop);
    authored.rpm = Some(500);
    authored.tpm = Some(10_000);
    let limits = OrgLimits {
        org: Some(authored),
        ..OrgLimits::default()
    };
    let narrowed = limits.with_rate_ceiling(ceiling);
    let org = narrowed.org.as_ref().expect("org cap");
    assert_eq!((org.rpm, org.tpm), (Some(30), Some(10_000)));
    assert_eq!(org.budget_micro_usd, Some(5_000));
    assert_eq!(limits.org.as_ref().and_then(|org| org.rpm), Some(500));

    // An empty ceiling changes nothing.
    assert!(OrgLimits::default()
        .with_rate_ceiling(RateCeiling::default())
        .is_empty());
}

#[test]
fn rate_share_divides_by_active_gateways_with_a_floor_of_one() {
    assert_eq!(rate_share(60, None), 60, "older plane: full ceiling");
    assert_eq!(rate_share(60, Some(0)), 60);
    assert_eq!(rate_share(60, Some(1)), 60);
    assert_eq!(rate_share(60, Some(3)), 20);
    assert_eq!(rate_share(61, Some(4)), 15, "floored");
    assert_eq!(rate_share(2, Some(5)), 1, "never below one");
}

#[test]
fn a_fleet_of_rate_limited_gateways_admits_at_most_the_configured_limit() {
    const GATEWAYS: u64 = 3;
    let mut org = spec(1_000_000, LimitAction::Stop);
    org.rpm = Some(60);
    org.tpm = Some(9_000);
    let mut member = spec(1_000_000, LimitAction::Stop);
    member.rpm = Some(10);
    let limits = OrgLimits {
        org: Some(org),
        member_default: Some(member),
        ..OrgLimits::default()
    };
    // Each gateway has its own in-process buckets.
    let fleet: Vec<_> = (0..GATEWAYS)
        .map(|_| crate::rate_limit::ScopedRateLimiter::default())
        .collect();
    let mut ctx = context(limits.clone(), &[]);
    ctx.active_gateways = Some(GATEWAYS);

    let mut org_admitted = 0;
    for (index, rate) in fleet.iter().enumerate() {
        for request in 0..100 {
            let user = format!("u{index}-{request}");
            if admit_request(rate, &ctx, Some(&user)) {
                org_admitted += 1;
            }
        }
    }
    assert_eq!(org_admitted, 60, "60 rpm across the fleet, not per gateway");

    // A member spread over every gateway: 10 rpm shares to 3 per gateway.
    let fresh: Vec<_> = (0..GATEWAYS)
        .map(|_| crate::rate_limit::ScopedRateLimiter::default())
        .collect();
    let mut member_admitted = 0;
    for rate in &fresh {
        for _ in 0..100 {
            if admit_request(rate, &ctx, Some("same-member")) {
                member_admitted += 1;
            }
        }
    }
    assert_eq!(member_admitted, 9, "at most the member's 10 rpm fleet-wide");

    let mut tokens_admitted = 0;
    for rate in &fleet {
        while admit_tokens(rate, &ctx, None, 1_000) {
            tokens_admitted += 1_000;
        }
    }
    assert_eq!(tokens_admitted, 9_000, "9_000 tpm across the fleet");

    // Without a count (older control plane) each gateway keeps the full
    // ceiling, as before.
    let legacy = context(limits, &[]);
    let rate = crate::rate_limit::ScopedRateLimiter::default();
    let admitted = (0..100)
        .filter(|request| admit_request(&rate, &legacy, Some(&format!("v{request}"))))
        .count();
    assert_eq!(admitted, 60);
}

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

fn alert_window(now: i64) -> i64 {
    BudgetWindow::Daily.start(now)
}

#[tokio::test]
async fn rgw_auth_attributes_only_a_verified_jwt_and_enforces_member_caps() {
    use axum::{response::IntoResponse, routing::get, Router};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use ed25519_dalek::{Signer, SigningKey};

    const ISSUER: &str = "https://auth.example";
    let app = Router::new().route(
        "/api/control-plane/gateway/resolve",
        get(|headers: axum::http::HeaderMap| async move {
            // Every resolve names the gateway process, so the plane can
            // count the gateways serving the org.
            if headers
                .get(crate::policy::GATEWAY_INSTANCE_HEADER)
                .and_then(|value| value.to_str().ok())
                != Some(crate::policy::gateway_instance_id())
            {
                return axum::http::StatusCode::BAD_REQUEST.into_response();
            }
            axum::Json(serde_json::json!({
                "organization": { "id": "org_test" },
                "standing": { "state": "active", "refuses": "none" },
                "activeGateways": 1,
                "credential": {
                    "id": "cred_9",
                    "purpose": "gateway_relay",
                    "allowedOperations": ["gateway.inference"]
                },
                "policyVersion": "pv1",
                "limits": {
                    "org": null,
                    "memberDefault": {
                        "budgetMicroUsd": 100, "budgetWindow": "daily",
                        "budgetAction": "stop", "downgradeModel": null,
                        "alertThresholdsPct": [], "rpm": 1, "tpm": null
                    },
                    "members": {}, "teams": {}, "keys": {}
                },
                "limitsSpend": {
                    "asOf": chrono::Utc::now().timestamp(),
                    "org": null,
                    "members": {
                        "user-7": {
                            "spentMicroUsd": 60,
                            "windowStart": BudgetWindow::Daily
                                .start(chrono::Utc::now().timestamp())
                        }
                    },
                    "teams": {}, "keys": {}
                }
            }))
            .into_response()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let config = crate::config::GatewayConfig {
        auth: crate::config::AuthConfig {
            require_auth: true,
            master_key: None,
            api_keys: vec![],
        },
        ..Default::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    let mut state = crate::state::AppState::new_for_test(config, audit, evals);
    state.resolve_cache = Some(crate::policy::ResolveCache::for_test(
        format!("http://{address}"),
        reqwest::Client::new(),
    ));
    let verifier = crate::policy::UserJwtVerifier::for_test(ISSUER);
    let signing = SigningKey::from_bytes(&[4; 32]);
    verifier.install_key("kid1", signing.verifying_key()).await;
    state.user_jwt = Some(verifier);

    let encode = |value: serde_json::Value| URL_SAFE_NO_PAD.encode(value.to_string());
    let input = format!(
        "{}.{}",
        encode(serde_json::json!({ "alg": "EdDSA", "kid": "kid1" })),
        encode(serde_json::json!({
            "id": "user-7", "iss": ISSUER, "aud": ISSUER,
            "exp": chrono::Utc::now().timestamp() + 600,
            "orgs": [{ "id": "org_test", "role": "member" }],
            "teams": [{ "id": "team-a", "org": "org_test", "role": "member" }]
        }))
    );
    let jwt = format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(signing.sign(input.as_bytes()).to_bytes())
    );

    // Without a JWT the spoofable x-ryu-user-id is ignored.
    let anonymous = crate::pipeline::authenticate(
        &state,
        crate::pipeline::AuthInputs {
            raw_api_key: Some("Bearer rgw_token"),
            user_id: Some("spoofed".to_owned()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(anonymous.user_id, None);
    assert_eq!(anonymous.key_id().as_deref(), Some("cred_9"));

    let verified = crate::pipeline::authenticate(
        &state,
        crate::pipeline::AuthInputs {
            raw_api_key: Some("Bearer rgw_token"),
            user_id: Some("spoofed".to_owned()),
            user_jwt: Some(jwt),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(verified.user_id.as_deref(), Some("user-7"));
    assert_eq!(verified.team_id.as_deref(), Some("team-a"));
    // Both requests carry the cached resolution's fetch time, which dates
    // their budget figures for the credit gate.
    assert!(anonymous.budget_resolved_at.is_some());
    assert_eq!(verified.budget_resolved_at, anonymous.budget_resolved_at);
    let limit_ctx = verified.org_limits.as_deref().unwrap();
    assert_eq!(limit_ctx.team_ids, vec!["team-a".to_owned()]);
    assert_eq!(limit_ctx.active_gateways, Some(1));

    // memberDefault applies to the verified member: rpm 1, then a cap.
    assert!(check_request(&state, &verified).is_ok());
    assert!(
        matches!(
            check_request(&state, &verified),
            Err(GatewayError::RateLimited)
        ),
        "second request in the minute"
    );
    assert!(
        check_request(&state, &anonymous).is_ok(),
        "unattributed traffic has no member bucket"
    );
    assert!(evaluate_for(&state, &verified).decision.is_none());
    record_for(&state, &verified, 150);
    let decision = evaluate_for(&state, &verified).decision.unwrap();
    assert_eq!(decision.scope, BudgetScope::Member);
    assert_eq!(decision.action, BudgetAction::Stop);
    assert_eq!(decision.key, "user-7");
    // The fleet aggregate from the same resolve counts too: 60 reported
    // elsewhere plus 150 served here since the snapshot arrived.
    assert_eq!(decision.used, 210);
    server.abort();
}

#[tokio::test]
async fn rgw_auth_binds_team_and_personal_credentials_without_a_jwt() {
    use axum::{response::IntoResponse, routing::get, Router};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use ed25519_dalek::{Signer, SigningKey};

    const ISSUER: &str = "https://auth.example";
    let app = Router::new().route(
        "/api/control-plane/gateway/resolve",
        get(|headers: axum::http::HeaderMap| async move {
            let binding = match headers
                .get("x-gateway-key")
                .and_then(|value| value.to_str().ok())
            {
                Some("rgw_team") => serde_json::json!({ "teamId": "team-a" }),
                Some("rgw_personal") => serde_json::json!({
                    "ownerUserId": "owner-1",
                    "ownerTeamIds": ["team-o"]
                }),
                _ => return axum::http::StatusCode::UNAUTHORIZED.into_response(),
            };
            let mut credential = serde_json::json!({
                "id": "cred_bound",
                "purpose": "gateway_relay",
                "allowedOperations": ["gateway.inference"]
            });
            for (key, value) in binding.as_object().unwrap() {
                credential[key] = value.clone();
            }
            axum::Json(serde_json::json!({
                "organization": { "id": "org_test" },
                "credential": credential,
                "standing": { "state": "active", "refuses": "none" },
                "limits": {
                    "org": null,
                    "memberDefault": null,
                    "members": { "owner-1": { "rpm": 1 } },
                    "teams": { "team-a": { "rpm": 1 }, "team-o": { "rpm": 5 } },
                    "keys": {}
                }
            }))
            .into_response()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let config = crate::config::GatewayConfig {
        auth: crate::config::AuthConfig {
            require_auth: true,
            master_key: None,
            api_keys: vec![],
        },
        ..Default::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    let mut state = crate::state::AppState::new_for_test(config, audit, evals);
    state.resolve_cache = Some(crate::policy::ResolveCache::for_test(
        format!("http://{address}"),
        reqwest::Client::new(),
    ));
    let verifier = crate::policy::UserJwtVerifier::for_test(ISSUER);
    let signing = SigningKey::from_bytes(&[5; 32]);
    verifier.install_key("kid1", signing.verifying_key()).await;
    state.user_jwt = Some(verifier);

    // A verified org admin who is on neither bound team nor the owner.
    let encode = |value: serde_json::Value| URL_SAFE_NO_PAD.encode(value.to_string());
    let input = format!(
        "{}.{}",
        encode(serde_json::json!({ "alg": "EdDSA", "kid": "kid1" })),
        encode(serde_json::json!({
            "id": "user-7", "iss": ISSUER, "aud": ISSUER,
            "exp": chrono::Utc::now().timestamp() + 600,
            "orgs": [{ "id": "org_test", "role": "admin" }],
            "teams": [{ "id": "team-b", "org": "org_test", "role": "member" }]
        }))
    );
    let other_jwt = format!(
        "{input}.{}",
        URL_SAFE_NO_PAD.encode(signing.sign(input.as_bytes()).to_bytes())
    );
    let auth = |key: &'static str, jwt: Option<String>| {
        crate::pipeline::authenticate(
            &state,
            crate::pipeline::AuthInputs {
                raw_api_key: Some(key),
                user_jwt: jwt,
                ..Default::default()
            },
        )
    };

    // Team node, no JWT: attributed to the team, whose cap applies.
    let team = auth("Bearer rgw_team", None).await.unwrap();
    assert_eq!(team.user_id, None);
    assert_eq!(team.team_id.as_deref(), Some("team-a"));
    assert_eq!(
        team.org_limits.as_deref().unwrap().team_ids,
        vec!["team-a".to_owned()]
    );
    assert!(check_request(&state, &team).is_ok());
    assert!(
        check_request(&state, &team).is_err(),
        "team rpm applies without a JWT"
    );
    // A verified admin outside the team keeps their identity and teams,
    // and the team's cap still counts the request.
    let admin = auth("Bearer rgw_team", Some(other_jwt.clone()))
        .await
        .unwrap();
    assert_eq!(admin.user_id.as_deref(), Some("user-7"));
    assert_eq!(admin.team_id.as_deref(), Some("team-a"));
    assert_eq!(
        admin.org_limits.as_deref().unwrap().team_ids,
        vec!["team-a".to_owned(), "team-b".to_owned()]
    );
    assert!(check_request(&state, &admin).is_err());

    // Personal node, no JWT: the owner's member cap and teams apply, but
    // the node token alone carries no user identity.
    let personal = auth("Bearer rgw_personal", None).await.unwrap();
    assert_eq!(personal.user_id, None);
    assert_eq!(personal.team_id.as_deref(), Some("team-o"));
    let personal_limits = personal.org_limits.as_deref().unwrap();
    assert_eq!(personal_limits.bound_user_id.as_deref(), Some("owner-1"));
    assert_eq!(personal_limits.team_ids, vec!["team-o".to_owned()]);
    assert_eq!(
        subject_for(&personal).unwrap().user_id.as_deref(),
        Some("owner-1"),
        "spend counts against the owner's member bucket"
    );
    assert!(check_request(&state, &personal).is_ok());
    assert!(
        check_request(&state, &personal).is_err(),
        "owner member rpm applies without a JWT"
    );
    // Another account's JWT is ignored, never a 401, never its identity
    // or teams, and the owner's cap still applies.
    let switched = auth("Bearer rgw_personal", Some(other_jwt)).await.unwrap();
    assert_eq!(switched.user_id, None);
    assert_eq!(
        switched.org_limits.as_deref().unwrap().team_ids,
        vec!["team-o".to_owned()]
    );
    assert!(check_request(&state, &switched).is_err());
    server.abort();
}
