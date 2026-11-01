//! Project, bot and funding-source caps (scoped budgets, contract §1, §2, §6).

use super::tests::{context, spec, NOW};
use super::*;
use crate::budget::{BudgetWindow, MemorySpendStore};
use crate::error::GatewayError;

fn month() -> i64 {
    BudgetWindow::Monthly.start(NOW)
}

fn funding(subscription: Option<u64>, api: Option<u64>) -> FundingBudgets {
    FundingBudgets {
        subscription_micro_usd: subscription,
        api_micro_usd: api,
    }
}

/// An org cap with only funding budgets (no total budget).
fn funded_org(budgets: FundingBudgets, action: LimitAction) -> OrgLimits {
    let mut org = spec(0, action);
    org.budget_micro_usd = None;
    org.funding_budgets = budgets;
    OrgLimits {
        org: Some(org),
        ..OrgLimits::default()
    }
}

#[test]
fn project_cap_applies_to_the_request_project_and_counts_its_spend() {
    let store = MemorySpendStore::new();
    let mut limits = OrgLimits::default();
    limits
        .projects
        .insert("proj_1".to_owned(), spec(100, LimitAction::Stop));
    let mut ctx = context(limits, &[]);
    record(&store, &ctx, None, 150, NOW);
    assert!(
        evaluate(&store, &ctx, None, NOW).decision.is_none(),
        "a request outside the project is not capped by it"
    );
    ctx.project_id = Some("proj_1".to_owned());
    record(&store, &ctx, None, 150, NOW);
    assert_eq!(
        store.spent("project", "org1:proj_1", BudgetWindow::Monthly, NOW),
        150
    );
    let decision = evaluate(&store, &ctx, None, NOW).decision.unwrap();
    assert_eq!(decision.scope, BudgetScope::Project);
    assert_eq!(decision.key, "proj_1");
    assert_eq!(decision.action, BudgetAction::Stop);
    assert_eq!(decision.used, 150);
}

#[test]
fn bot_cap_applies_only_to_a_verified_bot() {
    let store = MemorySpendStore::new();
    let mut limits = OrgLimits::default();
    limits
        .bots
        .insert("bot_7".to_owned(), spec(100, LimitAction::Notify));
    let mut ctx = context(limits, &[]);
    ctx.bot_id = Some("bot_7".to_owned());
    record(&store, &ctx, None, 100, NOW);
    assert_eq!(
        store.spent("bot", "org1:bot_7", BudgetWindow::Monthly, NOW),
        100
    );
    let decision = evaluate(&store, &ctx, None, NOW).decision.unwrap();
    assert_eq!(decision.scope, BudgetScope::Bot);
    assert_eq!(decision.action, BudgetAction::Notify);

    // The same traffic without a verified bot id never reaches the cap.
    ctx.bot_id = None;
    assert!(evaluate(&store, &ctx, None, NOW).decision.is_none());
    let subject = OrgLimitSubject::new(&ctx, None);
    assert_eq!(subject.bot_id, None);
}

#[test]
fn project_and_bot_rates_are_enforced_per_subject() {
    let rate = crate::rate_limit::ScopedRateLimiter::default();
    let mut capped = spec(0, LimitAction::Stop);
    capped.budget_micro_usd = None;
    capped.rpm = Some(1);
    let mut limits = OrgLimits::default();
    limits.projects.insert("proj_1".to_owned(), capped.clone());
    limits.bots.insert("bot_7".to_owned(), capped);
    let mut project = context(limits.clone(), &[]);
    project.project_id = Some("proj_1".to_owned());
    let mut bot = context(limits, &[]);
    bot.bot_id = Some("bot_7".to_owned());
    assert!(admit_request(&rate, &project, None));
    assert!(!admit_request(&rate, &project, None));
    assert!(admit_request(&rate, &bot, None), "a separate bucket");
    assert!(!admit_request(&rate, &bot, None));
}

#[test]
fn funding_caps_attribute_local_spend_to_the_draw_source() {
    let cases = [
        (Some(FundingSource::Subscription), true, false),
        (Some(FundingSource::Api), false, true),
        // Unknown draw source: counted toward both (fail closed).
        (None, true, true),
    ];
    for (draw, subscription_blocked, api_blocked) in cases {
        for (source, blocked) in [
            (FundingSource::Subscription, subscription_blocked),
            (FundingSource::Api, api_blocked),
        ] {
            let budgets = match source {
                FundingSource::Subscription => funding(Some(100), None),
                FundingSource::Api => funding(None, Some(100)),
            };
            let store = MemorySpendStore::new();
            let mut ctx = context(funded_org(budgets, LimitAction::Stop), &[]);
            ctx.funding_draw_source = draw;
            record(&store, &ctx, None, 100, NOW);
            let decision = evaluate(&store, &ctx, None, NOW).decision;
            assert_eq!(decision.is_some(), blocked, "draw {draw:?}, {source:?} cap");
            if let Some(decision) = decision {
                assert_eq!(decision.scope, BudgetScope::Org);
                assert_eq!((decision.used, decision.limit), (100, 100));
            }
        }
    }
}

#[test]
fn funding_caps_read_the_ledger_split_plus_attributed_spend_since_the_snapshot() {
    let mut snapshot = RemoteSpend {
        as_of: NOW,
        ..RemoteSpend::default()
    };
    snapshot.org = Some(RemoteSpendEntry {
        spent_micro_usd: Some(900),
        window_start: month(),
        funding_spend_micro_usd: FundingSpend {
            subscription: 600,
            api: 300,
        },
    });
    let snapshot = Arc::new(snapshot);
    let budgets = funding(Some(700), Some(350));
    let run = |draw: Option<FundingSource>| {
        let store = MemorySpendStore::new();
        let mut ctx = context(funded_org(budgets, LimitAction::Stop), &[]);
        ctx.remote_spend = Some(Arc::clone(&snapshot));
        ctx.funding_draw_source = draw;
        // First evaluation pins the baseline; then this gateway serves 60.
        assert!(evaluate(&store, &ctx, None, NOW).decision.is_none());
        record(&store, &ctx, None, 60, NOW);
        evaluate(&store, &ctx, None, NOW).decision
    };
    // Subscription draw: 600 + 60 < 700, api stays at 300 < 350.
    assert!(run(Some(FundingSource::Subscription)).is_none());
    // API draw: 300 + 60 >= 350 exhausts the API budget.
    let decision = run(Some(FundingSource::Api)).unwrap();
    assert_eq!((decision.used, decision.limit), (360, 350));
    // Unknown draw: the API budget is exhausted as well.
    assert_eq!(run(None).unwrap().limit, 350);
}

#[test]
fn an_exhausted_funding_cap_takes_the_spec_action_and_the_most_severe_wins() {
    let store = MemorySpendStore::new();
    let mut downgrade = funded_org(funding(Some(10), None), LimitAction::Downgrade);
    if let Some(org) = downgrade.org.as_mut() {
        org.downgrade_model = Some("small".to_owned());
    }
    let mut member = spec(5, LimitAction::Notify);
    member.budget_micro_usd = Some(1_000);
    member.funding_budgets = funding(None, Some(10));
    downgrade.member_default = Some(member);
    let mut ctx = context(downgrade, &[]);
    ctx.funding_draw_source = None;
    record(&store, &ctx, Some("u1"), 20, NOW);
    let decision = evaluate(&store, &ctx, Some("u1"), NOW).decision.unwrap();
    assert_eq!(decision.action, BudgetAction::Downgrade);
    assert_eq!(decision.downgrade_to.as_deref(), Some("small"));

    // A stop funding cap outranks a downgrade total cap.
    let mut stop = funded_org(funding(None, Some(10)), LimitAction::Stop);
    stop.keys.insert("cred1".to_owned(), {
        let mut key = spec(10, LimitAction::Downgrade);
        key.downgrade_model = Some("small".to_owned());
        key
    });
    let ctx = context(stop, &[]);
    record(&store, &ctx, None, 20, NOW);
    let decision = evaluate(&store, &ctx, None, NOW).decision.unwrap();
    assert_eq!(decision.action, BudgetAction::Stop);
    assert_eq!(decision.scope, BudgetScope::Org);
}

#[test]
fn a_funding_cap_raises_its_own_threshold_alert() {
    let store = MemorySpendStore::new();
    let mut limits = funded_org(funding(Some(1_000), None), LimitAction::Stop);
    if let Some(org) = limits.org.as_mut() {
        org.alert_thresholds_pct = vec![50, 80];
    }
    let mut ctx = context(limits, &[]);
    ctx.funding_draw_source = Some(FundingSource::Subscription);
    record(&store, &ctx, None, 850, NOW);
    let outcome = evaluate(&store, &ctx, None, NOW);
    assert!(outcome.decision.is_none());
    let alert = outcome.alert.expect("80% crossed");
    assert_eq!((alert.used, alert.limit), (850, 1_000));

    // Spend drawn from the other source never alerts on this budget.
    ctx.funding_draw_source = Some(FundingSource::Api);
    assert!(evaluate(&store, &ctx, None, NOW).alert.is_none());
}

#[test]
fn legacy_documents_without_scoped_fields_parse_unchanged() {
    let limits: OrgLimits = serde_json::from_value(serde_json::json!({
        "org": { "budgetMicroUsd": 10 },
        "members": {}, "teams": {}, "keys": {}
    }))
    .unwrap();
    assert!(limits.projects.is_empty() && limits.bots.is_empty());
    assert_eq!(
        limits.org.unwrap().funding_budgets,
        FundingBudgets::default()
    );

    let scoped: OrgLimits = serde_json::from_value(serde_json::json!({
        "projects": { "proj_1": { "fundingBudgets": null } },
        "bots": null,
        "keys": { "k": { "fundingBudgets": {
            "subscriptionMicroUsd": 1_000_000.0, "apiMicroUsd": -5
        } } }
    }))
    .unwrap();
    assert_eq!(
        scoped.projects["proj_1"].funding_budgets,
        FundingBudgets::default()
    );
    assert!(scoped.bots.is_empty());
    assert_eq!(
        scoped.keys["k"].funding_budgets,
        funding(Some(1_000_000), None)
    );
    assert!(!scoped.is_empty());

    let spend: RemoteSpend = serde_json::from_value(serde_json::json!({
        "asOf": NOW,
        "org": { "spentMicroUsd": 5, "windowStart": 0 },
        "members": { "u": { "spentMicroUsd": 5, "windowStart": 0,
            "fundingSpendMicroUsd": null } },
        "projects": { "p": { "spentMicroUsd": 9, "windowStart": 0,
            "fundingSpendMicroUsd": { "subscription": 4, "api": "x" } } },
        "bots": null,
        "omitted": { "projects": 7, "bots": null }
    }))
    .unwrap();
    assert_eq!(
        spend.org.unwrap().funding_spend_micro_usd,
        FundingSpend::default()
    );
    assert_eq!(
        spend.members["u"].funding_spend_micro_usd,
        FundingSpend::default()
    );
    assert_eq!(
        spend.projects["p"].funding_spend_micro_usd,
        FundingSpend {
            subscription: 4,
            api: 0
        }
    );
    assert!(spend.bots.is_empty());
    assert_eq!(spend.omitted.projects, Some(7));
    assert_eq!(spend.omitted.bots, None);
}

#[test]
fn a_truncated_snapshot_bounds_an_omitted_project_and_its_funding_spend() {
    let mut snapshot = RemoteSpend {
        as_of: NOW,
        truncated: true,
        ..RemoteSpend::default()
    };
    snapshot.omitted = OmittedSpend {
        projects: Some(500),
        ..OmittedSpend::default()
    };
    let mut capped = spec(400, LimitAction::Stop);
    capped.funding_budgets = funding(Some(450), None);
    let mut limits = OrgLimits::default();
    limits.projects.insert("proj_9".to_owned(), capped);
    let mut ctx = context(limits, &[]);
    ctx.project_id = Some("proj_9".to_owned());
    ctx.remote_spend = Some(Arc::new(snapshot));
    ctx.funding_draw_source = Some(FundingSource::Api);
    let decision = evaluate(&MemorySpendStore::new(), &ctx, None, NOW)
        .decision
        .unwrap();
    assert_eq!(decision.scope, BudgetScope::Project);
    assert_eq!(decision.used, 500);
}

#[tokio::test]
async fn rgw_auth_attributes_the_resolved_project_and_never_an_unproven_agent() {
    use axum::{response::IntoResponse, routing::get, Router};

    let app = Router::new().route(
        "/api/control-plane/gateway/resolve",
        get(|| async {
            axum::Json(serde_json::json!({
                "organization": { "id": "org_scoped" },
                "standing": { "state": "active", "refuses": "none" },
                "credential": {
                    "id": "cred_s",
                    "projectId": "proj_1",
                    "purpose": "gateway_relay",
                    "allowedOperations": ["gateway.inference"]
                },
                "fundingDrawSource": "subscription",
                "limits": {
                    "projects": { "proj_1": { "budgetMicroUsd": 100 } },
                    "bots": { "bot_x": { "budgetMicroUsd": 0 } }
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

    let request = crate::pipeline::authenticate(
        &state,
        crate::pipeline::AuthInputs {
            raw_api_key: Some("Bearer rgw_scoped"),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(request.project_id.as_deref(), Some("proj_1"));
    let limit_ctx = request.org_limits.as_deref().unwrap();
    assert_eq!(limit_ctx.project_id.as_deref(), Some("proj_1"));
    assert_eq!(limit_ctx.bot_id, None);
    assert_eq!(
        limit_ctx.funding_draw_source,
        Some(FundingSource::Subscription)
    );
    record_for(&state, &request, 100);
    let decision = evaluate_for(&state, &request).decision.unwrap();
    assert_eq!(decision.scope, BudgetScope::Project);
    let subject = subject_for(&request).unwrap();
    assert_eq!(subject.project_id.as_deref(), Some("proj_1"));
    assert_eq!(subject.bot_id, None);

    // A forwarded agent id without Core's proof is refused outright, so it
    // can never select (or escape) a bot cap.
    let spoofed = crate::pipeline::authenticate(
        &state,
        crate::pipeline::AuthInputs {
            raw_api_key: Some("Bearer rgw_scoped"),
            agent_id: Some("bot_x".to_owned()),
            ..Default::default()
        },
    )
    .await;
    assert!(matches!(spoofed, Err(GatewayError::Unauthorized(_))));
    server.abort();
}
