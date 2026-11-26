use super::*;
use crate::server::oauth_pool_policy::{AccountRule, Policy, Strategy};

#[test]
fn sdk_warmup_captures_each_account_revision_from_its_canonical_scope() {
    use crate::pi_config::accounts::{provider_scope, AccountVault, KIND_API_KEY, KIND_OAUTH};
    let vault = AccountVault::in_memory().unwrap();
    let scope = provider_scope(
        crate::pi_config::provider_meta("openai-codex")
            .unwrap()
            .auth_key,
    );
    for (id, kind) in [("b", KIND_OAUTH), ("a", KIND_OAUTH), ("key", KIND_API_KEY)] {
        vault
            .upsert(&scope, id, id, kind, Some(serde_json::json!({"access":id})))
            .unwrap();
    }
    let policy = Policy::default();
    let revisions = warm_account_revisions(&vault, "openai-codex", &policy).unwrap();
    assert_eq!(
        revisions
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b"]
    );
    assert_eq!(
        revisions[0].1,
        vault.credential_revision(&scope, "a").unwrap().unwrap()
    );
    assert!(warm_account_revisions(&vault, "github-copilot", &policy)
        .unwrap()
        .is_empty());
    assert!(warm_account_revisions(&vault, "kimi-coding", &policy)
        .unwrap()
        .is_empty());
    vault
        .upsert(
            &scope,
            "a",
            "a",
            KIND_OAUTH,
            Some(serde_json::json!({"access":"new"})),
        )
        .unwrap();
    let rotated = warm_account_revisions(&vault, "openai-codex", &policy).unwrap();
    assert_ne!(rotated[0].1, revisions[0].1);
    assert_eq!(rotated[1].1, revisions[1].1);
}

#[test]
fn warmup_excludes_disabled_quarantined_and_non_oauth_accounts() {
    use crate::pi_config::accounts::{provider_scope, AccountVault, KIND_OAUTH};
    let vault = AccountVault::in_memory().unwrap();
    let scope = provider_scope(
        crate::pi_config::provider_meta("github-copilot")
            .unwrap()
            .auth_key,
    );
    vault
        .upsert(
            &scope,
            "account",
            "account",
            KIND_OAUTH,
            Some(serde_json::json!({"access":"token"})),
        )
        .unwrap();
    let mut account = vault.list(&scope).unwrap().remove(0);
    let mut policy = Policy::default();
    assert!(warm_account_allowed(&account, &policy));
    account.needs_reauth = true;
    assert!(!warm_account_allowed(&account, &policy));
    account.needs_reauth = false;
    policy.accounts.insert(
        "account".to_owned(),
        AccountRule {
            enabled: false,
            priority: 0,
            drain_threshold_percent: None,
        },
    );
    assert!(!warm_account_allowed(&account, &policy));
    assert!(warm_account_revisions(&vault, "github-copilot", &policy)
        .unwrap()
        .is_empty());
    policy.accounts.clear();
    account.kind = crate::pi_config::accounts::KIND_OPAQUE.to_owned();
    assert!(!warm_account_allowed(&account, &policy));
}

fn snapshot(available: bool, windows: Vec<ryu_usage::UsageWindow>) -> ryu_usage::UsageSnapshot {
    ryu_usage::UsageSnapshot {
        agent_id: "claude".to_owned(),
        engine: "claude".to_owned(),
        available,
        plan: None,
        reason: None,
        windows,
        meters: Vec::new(),
        extra_usage_usd: None,
        retry_after_seconds: None,
        ..Default::default()
    }
}

fn window(used_percent: f64, model: Option<&str>) -> ryu_usage::UsageWindow {
    ryu_usage::UsageWindow {
        label: "Weekly".to_owned(),
        used_percent,
        resets_at: None,
        window_seconds: Some(604_800),
        model: model.map(str::to_owned),
    }
}

#[test]
fn observation_requires_fresh_matching_credential_and_account_wide_meter() {
    let mut cache = Cache::default();
    cache.record(
        "claude",
        "first",
        b"revision-a",
        &snapshot(true, vec![window(40.0, None), window(99.0, Some("opus"))]),
    );
    assert_eq!(
        cache
            .get("claude", "first", b"revision-a")
            .map(|observation| observation.highest_used_percent()),
        Some(40.0)
    );
    assert!(cache.get("claude", "first", b"revision-b").is_none());
    assert!(cache.get("claude", "first", b"revision-a").is_some());
    assert!(cache.get("chatgpt", "first", b"revision-a").is_none());
}

#[test]
fn unknown_and_invalid_usage_clear_prior_observation() {
    let mut cache = Cache::default();
    let good = snapshot(true, vec![window(30.0, None)]);
    cache.record("claude", "first", b"revision", &good);
    cache.record("claude", "first", b"revision", &snapshot(false, Vec::new()));
    assert!(cache.get("claude", "first", b"revision").is_none());

    cache.record("claude", "first", b"revision", &good);
    cache.record(
        "claude",
        "first",
        b"revision",
        &snapshot(true, vec![window(f64::NAN, None)]),
    );
    assert!(cache.get("claude", "first", b"revision").is_none());
}

#[test]
fn stale_usage_failure_cannot_clear_a_new_credential_observation() {
    let mut cache = Cache::default();
    let good = snapshot(true, vec![window(30.0, None)]);
    cache.record("claude", "first", b"new-revision", &good);
    cache.record(
        "claude",
        "first",
        b"old-revision",
        &snapshot(false, Vec::new()),
    );
    cache.remove_if_revision("claude", "first", b"old-revision", Instant::now());
    assert_eq!(
        cache
            .get("claude", "first", b"new-revision")
            .map(|observation| observation.highest_used_percent()),
        Some(30.0)
    );
}

#[test]
fn slower_valid_read_cannot_replace_a_newer_credential_observation() {
    let mut cache = Cache::default();
    let old_started_at = Instant::now();
    let good = snapshot(true, vec![window(30.0, None)]);
    cache.record("claude", "first", b"new-revision", &good);
    cache.record_started(
        "claude",
        "first",
        b"old-revision",
        old_started_at,
        &snapshot(true, vec![window(10.0, None)]),
    );
    assert_eq!(
        cache
            .get("claude", "first", b"new-revision")
            .map(|observation| observation.highest_used_percent()),
        Some(30.0)
    );
}

#[test]
fn newer_credential_read_wins_even_when_old_read_finishes_first() {
    let mut cache = Cache::default();
    let old_started_at = Instant::now() - Duration::from_secs(2);
    let new_started_at = Instant::now() - Duration::from_secs(1);
    cache.record_started(
        "claude",
        "first",
        b"old-revision",
        old_started_at,
        &snapshot(true, vec![window(10.0, None)]),
    );
    cache.record_started(
        "claude",
        "first",
        b"new-revision",
        new_started_at,
        &snapshot(true, vec![window(30.0, None)]),
    );
    assert_eq!(
        cache
            .get("claude", "first", b"new-revision")
            .map(|observation| observation.highest_used_percent()),
        Some(30.0)
    );
}

#[test]
fn slower_failed_read_cannot_clear_newer_observation_of_same_credential() {
    let mut cache = Cache::default();
    let old_started_at = Instant::now();
    cache.record(
        "claude",
        "first",
        b"revision",
        &snapshot(true, vec![window(30.0, None)]),
    );
    cache.remove_if_revision("claude", "first", b"revision", old_started_at);
    assert!(cache.get("claude", "first", b"revision").is_some());
}

#[test]
fn saturated_window_wins_over_less_used_window() {
    let normalized = normalize(&snapshot(
        true,
        vec![window(31.0, None), window(100.0, None)],
    ));
    assert_eq!(
        normalized.map(|item| item.highest_used_percent()),
        Some(100.0)
    );
}

fn candidate<'a>(id: &'a str) -> Candidate<'a> {
    Candidate {
        account_id: id,
        revision: b"same",
    }
}

fn observation(used_percent: f64) -> Observation {
    Observation {
        windows: vec![WindowObservation {
            used_percent,
            reset_at: None,
            window_seconds: Some(18_000),
        }],
    }
}

#[test]
fn manual_and_round_robin_respect_enabled_accounts_and_priority() {
    let candidates = [candidate("first"), candidate("second"), candidate("third")];
    let mut cursor = PoolCursor::default();
    let mut policy = Policy::default();
    assert_eq!(
        cursor.select_with(&candidates, "second", &policy, |_| None),
        Some(1)
    );
    policy.strategy = Strategy::RoundRobin;
    policy.accounts.insert(
        "first".to_owned(),
        AccountRule {
            drain_threshold_percent: None,
            enabled: false,
            priority: 0,
        },
    );
    policy.accounts.insert(
        "third".to_owned(),
        AccountRule {
            drain_threshold_percent: None,
            enabled: true,
            priority: 5,
        },
    );
    assert_eq!(
        cursor.select_with(&candidates, "first", &policy, |_| None),
        Some(1)
    );
    assert_eq!(
        cursor.select_with(&candidates, "first", &policy, |_| None),
        Some(1)
    );
    policy.accounts.get_mut("third").unwrap().priority = 0;
    assert_eq!(
        cursor.select_with(&candidates, "first", &policy, |_| None),
        Some(1)
    );
    assert_eq!(
        cursor.select_with(&candidates, "first", &policy, |_| None),
        Some(2)
    );
}

#[test]
fn quota_first_uses_only_known_headroom_and_falls_back_to_rotation() {
    let candidates = [
        candidate("first"),
        candidate("second"),
        candidate("unknown"),
    ];
    let mut cursor = PoolCursor::default();
    let policy = Policy {
        strategy: Strategy::QuotaFirst,
        ..Policy::default()
    };
    assert_eq!(
        cursor.select_with(&candidates, "first", &policy, |candidate| {
            match candidate.account_id {
                "first" => Some(observation(80.0)),
                "second" => Some(observation(30.0)),
                _ => None,
            }
        }),
        Some(1)
    );
    assert_eq!(
        cursor.select_with(&candidates, "first", &policy, |_| None),
        Some(0)
    );
}

#[test]
fn quota_first_rotates_equal_readings_without_selecting_unknown_accounts() {
    let candidates = [
        candidate("first"),
        candidate("second"),
        candidate("unknown"),
    ];
    let mut cursor = PoolCursor::default();
    let policy = Policy {
        strategy: Strategy::QuotaFirst,
        ..Policy::default()
    };
    let mut select = || {
        cursor.select_with(&candidates, "first", &policy, |candidate| {
            (candidate.account_id != "unknown").then(|| observation(25.0))
        })
    };
    assert_eq!([select(), select(), select()], [Some(0), Some(1), Some(0)]);
}

#[test]
fn fill_first_holds_account_until_fresh_usage_reaches_threshold() {
    let candidates = [candidate("first"), candidate("second")];
    let mut cursor = PoolCursor::default();
    let policy = Policy {
        strategy: Strategy::FillFirst,
        ..Policy::default()
    };
    assert_eq!(
        cursor.select_with(&candidates, "first", &policy, |_| None),
        Some(0)
    );
    assert_eq!(
        cursor.select_with(&candidates, "first", &policy, |_| None),
        Some(0)
    );
    assert_eq!(
        cursor.select_with(&candidates, "first", &policy, |candidate| {
            Some(observation(if candidate.account_id == "first" {
                85.0
            } else {
                20.0
            }))
        }),
        Some(1)
    );
}

#[test]
fn reset_first_uses_future_reset_and_ignores_unknown() {
    let candidates = [candidate("first"), candidate("second")];
    let now = chrono::Utc::now();
    let mut cursor = PoolCursor::default();
    let policy = Policy {
        strategy: Strategy::ResetFirst,
        ..Policy::default()
    };
    assert_eq!(
        cursor.select_with(&candidates, "first", &policy, |candidate| {
            let mut usage = observation(40.0);
            usage.windows[0].reset_at = Some(
                now + chrono::Duration::minutes(if candidate.account_id == "first" {
                    60
                } else {
                    30
                }),
            );
            Some(usage)
        }),
        Some(1)
    );
}

#[test]
fn reset_first_rotates_accounts_with_the_same_reset_deadline() {
    let candidates = [candidate("first"), candidate("second")];
    let reset_at = chrono::Utc::now() + chrono::Duration::minutes(30);
    let mut cursor = PoolCursor::default();
    let policy = Policy {
        strategy: Strategy::ResetFirst,
        ..Policy::default()
    };
    let mut select = || {
        cursor.select_with(&candidates, "first", &policy, |_| {
            let mut usage = observation(40.0);
            usage.windows[0].reset_at = Some(reset_at);
            Some(usage)
        })
    };
    assert_eq!([select(), select(), select()], [Some(0), Some(1), Some(0)]);
}

#[test]
fn stale_observation_is_discarded() {
    let mut cache = Cache::default();
    cache.record(
        "claude",
        "first",
        b"revision",
        &snapshot(true, vec![window(10.0, None)]),
    );
    cache
        .entries
        .get_mut(&("claude".to_owned(), "first".to_owned()))
        .unwrap()
        .observed_at = Instant::now() - OBSERVATION_TTL;
    assert!(cache.get("claude", "first", b"revision").is_none());
}

#[test]
fn observed_drained_priority_tier_yields_to_known_backup_and_retains_unknown_tiers() {
    let candidates = [candidate("first"), candidate("backup")];
    for strategy in [
        Strategy::FillFirst,
        Strategy::QuotaFirst,
        Strategy::ResetFirst,
    ] {
        let mut cursor = PoolCursor::default();
        let mut policy = Policy {
            strategy,
            ..Policy::default()
        };
        policy.accounts.insert(
            "backup".into(),
            AccountRule {
                enabled: true,
                priority: 1,
                drain_threshold_percent: None,
            },
        );
        assert_eq!(
            cursor.select_with(&candidates, "first", &policy, |candidate| {
                let mut usage = observation(if candidate.account_id == "first" {
                    100.0
                } else {
                    10.0
                });
                usage.windows[0].reset_at = Some(chrono::Utc::now() + chrono::Duration::hours(1));
                Some(usage)
            }),
            Some(1),
            "{strategy:?}"
        );
        assert_eq!(
            cursor.select_with(&candidates, "first", &policy, |candidate| {
                (candidate.account_id == "backup").then(|| observation(10.0))
            }),
            Some(0),
            "{strategy:?}"
        );
        policy.accounts.get_mut("backup").unwrap().enabled = false;
        assert_eq!(
            cursor.select_with(&candidates, "first", &policy, |_| Some(observation(100.0))),
            Some(0)
        );
    }
}

#[test]
fn account_zero_override_retains_fill_until_exhaustion_and_removal_restores_drain() {
    let candidates = [candidate("first"), candidate("backup")];
    let mut cursor = PoolCursor::default();
    let mut policy = Policy {
        strategy: Strategy::FillFirst,
        ..Policy::default()
    };
    policy.accounts.insert(
        "first".into(),
        AccountRule {
            enabled: true,
            priority: 0,
            drain_threshold_percent: Some(0),
        },
    );
    policy.accounts.insert(
        "backup".into(),
        AccountRule {
            enabled: true,
            priority: 1,
            drain_threshold_percent: None,
        },
    );
    let select = |cursor: &mut PoolCursor, policy: &Policy, used| {
        cursor.select_with(&candidates, "first", policy, |candidate| {
            Some(observation(if candidate.account_id == "first" {
                used
            } else {
                10.0
            }))
        })
    };
    assert_eq!(select(&mut cursor, &policy, 85.0), Some(0));
    assert_eq!(select(&mut cursor, &policy, 100.0), Some(1));
    policy
        .accounts
        .get_mut("first")
        .unwrap()
        .drain_threshold_percent = None;
    assert_eq!(select(&mut cursor, &policy, 85.0), Some(1));
}

#[test]
fn explicit_override_controls_tier_headroom_and_preserves_within_tier_reset_ranking() {
    let candidates = [candidate("first"), candidate("backup")];
    let mut cursor = PoolCursor::default();
    let mut policy = Policy {
        strategy: Strategy::ResetFirst,
        ..Policy::default()
    };
    policy.accounts.insert(
        "first".into(),
        AccountRule {
            enabled: true,
            priority: 0,
            drain_threshold_percent: Some(60),
        },
    );
    policy.accounts.insert(
        "backup".into(),
        AccountRule {
            enabled: true,
            priority: 1,
            drain_threshold_percent: None,
        },
    );
    let mut select = |policy: &Policy| {
        cursor.select_with(&candidates, "first", policy, |candidate| {
            let mut usage = observation(if candidate.account_id == "first" {
                65.0
            } else {
                10.0
            });
            usage.windows[0].reset_at = Some(
                chrono::Utc::now()
                    + chrono::Duration::seconds(if candidate.account_id == "first" {
                        60
                    } else {
                        3600
                    }),
            );
            Some(usage)
        })
    };
    assert_eq!(select(&policy), Some(1));
    policy
        .accounts
        .get_mut("first")
        .unwrap()
        .drain_threshold_percent = Some(0);
    assert_eq!(select(&policy), Some(0));
    policy
        .accounts
        .get_mut("first")
        .unwrap()
        .drain_threshold_percent = Some(60);
    policy.accounts.get_mut("backup").unwrap().priority = 0;
    assert_eq!(select(&policy), Some(0));
}
