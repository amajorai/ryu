use super::*;
use crate::server::{oauth_pool_policy::AccountRule, oauth_pool_usage};
use std::time::Instant;

fn snapshot(used: f64, reset: Option<chrono::DateTime<chrono::Utc>>) -> ryu_usage::UsageSnapshot {
    ryu_usage::UsageSnapshot {
        agent_id: "fixture-sdk".into(),
        engine: "fixture-sdk".into(),
        available: true,
        plan: None,
        reason: None,
        windows: vec![ryu_usage::UsageWindow {
            label: "Account window".into(),
            used_percent: used,
            resets_at: reset.map(|value| value.to_rfc3339()),
            window_seconds: Some(3600),
            model: None,
        }],
        meters: vec![],
        extra_usage_usd: None,
        retry_after_seconds: None,
        ..Default::default()
    }
}

fn accounts() -> [String; 3] {
    let prefix = uuid::Uuid::new_v4();
    [
        format!("{prefix}-a"),
        format!("{prefix}-b"),
        format!("{prefix}-c"),
    ]
}

fn record(
    provider: &str,
    account: &str,
    revision: &[u8],
    used: f64,
    reset: Option<chrono::DateTime<chrono::Utc>>,
) {
    oauth_pool_usage::record(
        provider,
        account,
        revision,
        Instant::now(),
        &snapshot(used, reset),
    );
}

fn choose(
    chooser: &mut AccountChooser,
    provider: &str,
    accounts: &[String],
    revisions: &[&[u8]],
    policy: &Policy,
) -> Option<String> {
    let candidates: Vec<_> = accounts
        .iter()
        .zip(revisions)
        .map(|(id, revision)| Candidate {
            account_id: id,
            revision,
        })
        .collect();
    chooser
        .select_captured(provider, &candidates, None, policy)
        .unwrap()
}

#[test]
fn quota_first_uses_account_wide_headroom_and_does_not_invent_unknown_usage() {
    for provider in ["openai-codex", "github-copilot"] {
        let ids = accounts();
        record(provider, &ids[0], b"a", 65.0, None);
        record(provider, &ids[1], b"b", 15.0, None);
        let policy = Policy {
            strategy: Strategy::QuotaFirst,
            ..Policy::default()
        };
        let selected = choose(
            &mut AccountChooser::default(),
            provider,
            &ids,
            &[b"a", b"b", b"unknown"],
            &policy,
        );
        assert_eq!(selected.as_deref(), Some(ids[1].as_str()));
        assert!(oauth_pool_usage::get(provider, &ids[2], b"unknown").is_none());
    }
}

#[test]
fn reset_first_ignores_elapsed_and_missing_resets_and_selects_earliest_future_window() {
    let ids = accounts();
    let now = chrono::Utc::now();
    record(
        "openai-codex",
        &ids[0],
        b"a",
        5.0,
        Some(now - chrono::Duration::hours(1)),
    );
    record(
        "openai-codex",
        &ids[1],
        b"b",
        50.0,
        Some(now + chrono::Duration::hours(1)),
    );
    record("openai-codex", &ids[2], b"c", 10.0, None);
    let policy = Policy {
        strategy: Strategy::ResetFirst,
        ..Policy::default()
    };
    let mut chooser = AccountChooser::default();
    assert_eq!(
        choose(
            &mut chooser,
            "openai-codex",
            &ids,
            &[b"a", b"b", b"c"],
            &policy
        ),
        Some(ids[1].clone())
    );
    record(
        "openai-codex",
        &ids[2],
        b"c",
        10.0,
        Some(now + chrono::Duration::minutes(30)),
    );
    assert_eq!(
        choose(
            &mut chooser,
            "openai-codex",
            &ids,
            &[b"a", b"b", b"c"],
            &policy
        ),
        Some(ids[2].clone())
    );
}

#[test]
fn invalid_and_unavailable_readings_remove_rank_then_unknown_accounts_rotate() {
    let ids = accounts();
    record("github-copilot", &ids[0], b"a", 1.0, None);
    record("github-copilot", &ids[0], b"a", f64::NAN, None);
    record("github-copilot", &ids[1], b"b", 10.0, None);
    let mut unavailable = snapshot(10.0, None);
    unavailable.available = false;
    oauth_pool_usage::record(
        "github-copilot",
        &ids[1],
        b"b",
        Instant::now(),
        &unavailable,
    );
    assert!(oauth_pool_usage::get("github-copilot", &ids[0], b"a").is_none());
    assert!(oauth_pool_usage::get("github-copilot", &ids[1], b"b").is_none());
    let policy = Policy {
        strategy: Strategy::QuotaFirst,
        ..Policy::default()
    };
    let mut chooser = AccountChooser::default();
    let selected: Vec<_> = (0..3)
        .map(|_| {
            choose(
                &mut chooser,
                "github-copilot",
                &ids,
                &[b"a", b"b", b"c"],
                &policy,
            )
            .unwrap()
        })
        .collect();
    assert_eq!(selected, ids);
}

#[test]
fn quota_evidence_isolated_by_provider_account_and_sealed_generation() {
    let ids = accounts();
    record("openai-codex", &ids[0], b"old-generation", 1.0, None);
    record("openai-codex", &ids[1], b"b", 60.0, None);
    assert!(oauth_pool_usage::get("github-copilot", &ids[0], b"old-generation").is_none());
    assert!(oauth_pool_usage::get("openai-codex", &ids[2], b"old-generation").is_none());
    assert!(oauth_pool_usage::get("openai-codex", &ids[0], b"new-generation").is_none());
    let policy = Policy {
        strategy: Strategy::QuotaFirst,
        ..Policy::default()
    };
    assert_eq!(
        choose(
            &mut AccountChooser::default(),
            "openai-codex",
            &ids,
            &[b"new-generation", b"b", b"c"],
            &policy
        ),
        Some(ids[1].clone())
    );
    record("openai-codex", &ids[0], b"new-generation", 5.0, None);
    assert_eq!(
        choose(
            &mut AccountChooser::default(),
            "openai-codex",
            &ids,
            &[b"new-generation", b"b", b"c"],
            &policy
        ),
        Some(ids[0].clone())
    );
}

#[test]
fn drained_priority_tier_falls_back_but_disabled_account_never_receives_work() {
    let ids = accounts();
    record("github-copilot", &ids[0], b"a", 75.0, None);
    record("github-copilot", &ids[1], b"b", 40.0, None);
    record("github-copilot", &ids[2], b"c", 0.0, None);
    let mut policy = Policy {
        strategy: Strategy::QuotaFirst,
        ..Policy::default()
    };
    policy.accounts.insert(
        ids[0].clone(),
        AccountRule {
            enabled: true,
            priority: 0,
            drain_threshold_percent: Some(70),
        },
    );
    policy.accounts.insert(
        ids[1].clone(),
        AccountRule {
            enabled: true,
            priority: 1,
            drain_threshold_percent: None,
        },
    );
    policy.accounts.insert(
        ids[2].clone(),
        AccountRule {
            enabled: false,
            priority: 0,
            drain_threshold_percent: None,
        },
    );
    let mut chooser = AccountChooser::default();
    assert_eq!(
        choose(
            &mut chooser,
            "github-copilot",
            &ids,
            &[b"a", b"b", b"c"],
            &policy
        ),
        Some(ids[1].clone())
    );
    record("github-copilot", &ids[0], b"a", 69.0, None);
    assert_eq!(
        choose(
            &mut chooser,
            "github-copilot",
            &ids,
            &[b"a", b"b", b"c"],
            &policy
        ),
        Some(ids[0].clone())
    );
}

#[test]
fn fill_first_sticks_until_observed_threshold_and_retains_fallback_affinity() {
    let ids = accounts();
    record("openai-codex", &ids[0], b"a", 65.0, None);
    record("openai-codex", &ids[1], b"b", 10.0, None);
    let policy = Policy {
        strategy: Strategy::FillFirst,
        drain_threshold_percent: 80,
        ..Policy::default()
    };
    let mut chooser = AccountChooser::default();
    let revisions: &[&[u8]] = &[b"a", b"b", b"c"];
    assert_eq!(
        choose(&mut chooser, "openai-codex", &ids, revisions, &policy),
        Some(ids[0].clone())
    );
    record("openai-codex", &ids[1], b"b", 70.0, None);
    assert_eq!(
        choose(&mut chooser, "openai-codex", &ids, revisions, &policy),
        Some(ids[0].clone())
    );
    record("openai-codex", &ids[0], b"a", 80.0, None);
    assert_eq!(
        choose(&mut chooser, "openai-codex", &ids, revisions, &policy),
        Some(ids[1].clone())
    );
    record("openai-codex", &ids[0], b"a", 5.0, None);
    assert_eq!(
        choose(&mut chooser, "openai-codex", &ids, revisions, &policy),
        Some(ids[1].clone())
    );
}

#[test]
fn providers_without_account_quota_cannot_enable_quota_or_reset_routing() {
    let ids = accounts();
    let candidates = [Candidate {
        account_id: &ids[0],
        revision: b"a",
    }];
    for strategy in [Strategy::QuotaFirst, Strategy::ResetFirst] {
        assert_eq!(
            AccountChooser::default().select_captured(
                "xai",
                &candidates,
                None,
                &Policy {
                    strategy,
                    ..Policy::default()
                }
            ),
            Err(UnsupportedStrategy)
        );
    }
}
