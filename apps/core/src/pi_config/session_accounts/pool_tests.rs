//! An agent's custom account pool on the SDK capture path.
use std::collections::BTreeSet;
use std::sync::Arc;

use super::capture_tests::{save, vault};
use super::*;

const PROVIDER: &str = "github-copilot";

fn pooled(strategy: Strategy, members: &[&str]) -> Policy {
    Policy {
        strategy,
        pool: Some(Arc::new(
            members
                .iter()
                .map(|id| (*id).to_owned())
                .collect::<BTreeSet<_>>(),
        )),
        ..Policy::default()
    }
}

fn capture_as(
    vault: &super::super::accounts::AccountVault,
    chat: &str,
    policy: &Policy,
    chooser: &mut AccountChooser,
) -> Result<Option<SessionAccount>> {
    capture_with_vault_and_policy(
        vault,
        PROVIDER,
        PROVIDER,
        Some(chat),
        "security",
        None,
        policy,
        chooser,
    )
}

#[test]
fn rotation_only_ever_picks_accounts_of_the_pool() {
    let vault = vault();
    for account in ["a", "b", "c", "d"] {
        save(&vault, account);
    }
    let mut chooser = AccountChooser::default();
    let policy = pooled(Strategy::RoundRobin, &["b", "d"]);
    let picked: Vec<String> = (0..6)
        .map(|turn| {
            capture_as(&vault, &format!("chat-{turn}"), &policy, &mut chooser)
                .unwrap()
                .unwrap()
                .account_id
        })
        .collect();
    assert_eq!(picked, ["b", "d", "b", "d", "b", "d"]);
}

#[test]
fn the_provider_policy_still_applies_inside_the_pool() {
    let vault = vault();
    for account in ["a", "b", "c"] {
        save(&vault, account);
    }
    let mut policy = pooled(Strategy::RoundRobin, &["a", "b"]);
    policy.accounts.insert(
        "a".into(),
        crate::server::oauth_pool_policy::AccountRule {
            drain_threshold_percent: None,
            enabled: false,
            priority: 0,
        },
    );
    let mut chooser = AccountChooser::default();
    for chat in ["one", "two", "three"] {
        let selected = capture_as(&vault, chat, &policy, &mut chooser)
            .unwrap()
            .unwrap();
        assert_eq!(selected.account_id, "b");
    }
}

#[test]
fn manual_uses_the_active_account_only_when_the_pool_holds_it() {
    let vault = vault();
    for account in ["a", "b", "c"] {
        save(&vault, account);
    }
    let scope = super::super::accounts::provider_scope(PROVIDER);
    let mut chooser = AccountChooser::default();
    // "c" is active (saved last) and outside the pool: the first pool account.
    let outside = pooled(Strategy::Manual, &["a", "b"]);
    assert_eq!(
        capture_as(&vault, "outside", &outside, &mut chooser)
            .unwrap()
            .unwrap()
            .account_id,
        "a"
    );
    vault.set_active(&scope, "b").unwrap();
    assert_eq!(
        capture_as(&vault, "inside", &outside, &mut chooser)
            .unwrap()
            .unwrap()
            .account_id,
        "b"
    );
    // The picker's active account is never changed by a pooled choice.
    assert_eq!(vault.active_info(&scope).unwrap().unwrap().account_id, "b");
}

#[test]
fn no_usable_pool_account_fails_instead_of_leaving_the_pool() {
    let vault = vault();
    save(&vault, "healthy-outside");
    let scope = super::super::accounts::provider_scope(PROVIDER);
    // The pool's only account has no usable credential.
    vault
        .upsert(
            &scope,
            "spent",
            "spent",
            super::super::accounts::KIND_OAUTH,
            Some(json!({"type":"oauth", "access":"", "refresh":"", "expires":1})),
        )
        .unwrap();
    vault.set_active(&scope, "healthy-outside").unwrap();
    let mut chooser = AccountChooser::default();
    for strategy in [Strategy::Manual, Strategy::RoundRobin, Strategy::FillFirst] {
        let error =
            capture_as(&vault, "chat", &pooled(strategy, &["spent"]), &mut chooser).unwrap_err();
        assert!(
            error.to_string().contains("account pool"),
            "{strategy:?}: {error}"
        );
    }
    // Nothing was bound, so nothing can leak into a later turn.
    assert_eq!(
        peek_with_vault(&vault, PROVIDER, Some("chat"), "security").unwrap(),
        None
    );
}

#[test]
fn a_conversation_bound_outside_the_pool_is_released_and_chosen_again() {
    let vault = vault();
    for account in ["a", "b"] {
        save(&vault, account);
    }
    let mut chooser = AccountChooser::default();
    let before = capture_as(
        &vault,
        "chat",
        &pooled(Strategy::RoundRobin, &["a"]),
        &mut chooser,
    )
    .unwrap()
    .unwrap();
    assert_eq!(before.account_id, "a");
    // The pool changes: it now holds only "b".
    let policy = pooled(Strategy::RoundRobin, &["b"]);
    let after = capture_as(&vault, "chat", &policy, &mut chooser)
        .unwrap()
        .unwrap();
    assert_eq!(after.account_id, "b");
    assert_eq!(after.session_key, before.session_key);
    assert_eq!(
        peek_with_vault(&vault, PROVIDER, Some("chat"), "security").unwrap(),
        Some("b".to_owned())
    );
    // The new binding is kept on the next turn.
    assert_eq!(
        capture_as(&vault, "chat", &policy, &mut chooser).unwrap(),
        Some(after)
    );
}

#[test]
fn a_disabled_bound_account_inside_the_pool_still_fails_as_before() {
    let vault = vault();
    for account in ["a", "b"] {
        save(&vault, account);
    }
    let mut chooser = AccountChooser::default();
    let mut policy = pooled(Strategy::RoundRobin, &["a", "b"]);
    let bound = capture_as(&vault, "chat", &policy, &mut chooser)
        .unwrap()
        .unwrap();
    policy.accounts.insert(
        bound.account_id.clone(),
        crate::server::oauth_pool_policy::AccountRule {
            drain_threshold_percent: None,
            enabled: false,
            priority: 0,
        },
    );
    let error = capture_as(&vault, "chat", &policy, &mut chooser).unwrap_err();
    assert!(error.to_string().contains("disabled"));
}

#[test]
fn an_agent_without_a_pool_keeps_manual_on_the_active_account() {
    let vault = vault();
    for account in ["a", "b"] {
        save(&vault, account);
    }
    let mut chooser = AccountChooser::default();
    let selected = capture_as(&vault, "chat", &Policy::default(), &mut chooser)
        .unwrap()
        .unwrap();
    assert_eq!(selected.account_id, "b");
}

#[test]
fn of_ten_accounts_with_five_in_the_pool_a_spent_one_gives_way_to_one_of_the_other_four() {
    let vault = vault();
    let prefix = uuid::Uuid::new_v4().simple().to_string();
    let ids: Vec<String> = (1..=10).map(|n| format!("{prefix}-{n:02}")).collect();
    for id in &ids {
        save(&vault, id);
    }
    let scope = super::super::accounts::provider_scope(PROVIDER);
    let outside: Vec<&str> = ids.iter().step_by(2).map(String::as_str).collect();
    let pool: Vec<&str> = ids.iter().skip(1).step_by(2).map(String::as_str).collect();
    let record = |id: &str, used_percent: f64| {
        let revision = vault.credential_revision(&scope, id).unwrap().unwrap();
        let snapshot = ryu_usage::UsageSnapshot {
            available: true,
            windows: vec![ryu_usage::UsageWindow {
                label: "Account window".into(),
                used_percent,
                resets_at: None,
                window_seconds: Some(3600),
                model: None,
            }],
            ..Default::default()
        };
        crate::server::oauth_pool_usage::record(
            PROVIDER,
            id,
            &revision,
            std::time::Instant::now(),
            &snapshot,
        );
    };
    // Every account outside the pool has all of its usage left.
    for id in &outside {
        record(id, 0.0);
    }
    for (id, used) in pool.iter().zip([100.0, 20.0, 30.0, 40.0, 50.0]) {
        record(id, used);
    }
    let mut chooser = AccountChooser::default();
    let policy = pooled(Strategy::QuotaFirst, &pool);
    for chat in ["one", "two", "three"] {
        let chosen = capture_as(&vault, chat, &policy, &mut chooser)
            .unwrap()
            .unwrap()
            .account_id;
        assert_ne!(chosen, pool[0], "the spent account");
        assert!(
            pool[1..].contains(&chosen.as_str()),
            "{chosen} is not one of the other four pool accounts"
        );
    }
    // Without a pool the same strategy takes an account outside it.
    let open = Policy {
        strategy: Strategy::QuotaFirst,
        ..Policy::default()
    };
    let chosen = capture_as(&vault, "open", &open, &mut chooser)
        .unwrap()
        .unwrap()
        .account_id;
    assert!(outside.contains(&chosen.as_str()), "{chosen}");
}
