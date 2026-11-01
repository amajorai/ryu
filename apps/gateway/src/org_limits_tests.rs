use super::*;
use crate::budget::{BudgetWindow, MemorySpendStore};

// 2026-10-08T15:30:00Z
pub(super) const NOW: i64 = 1_791_473_400;

pub(super) fn spec(budget: u64, action: LimitAction) -> LimitSpec {
    LimitSpec {
        budget_micro_usd: Some(budget),
        budget_window: BudgetWindow::Monthly,
        budget_action: action,
        downgrade_model: None,
        alert_thresholds_pct: vec![50, 80, 100],
        rpm: None,
        tpm: None,
        funding_budgets: FundingBudgets::default(),
    }
}

pub(super) fn alert_window(now: i64) -> i64 {
    BudgetWindow::Daily.start(now)
}

pub(super) fn context(limits: OrgLimits, teams: &[&str]) -> OrgLimitContext {
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
        project_id: None,
        bot_id: None,
        funding_draw_source: None,
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
            ..RemoteSpendEntry::default()
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
            ..RemoteSpendEntry::default()
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
