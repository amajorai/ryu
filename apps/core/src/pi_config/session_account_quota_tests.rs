use super::*;
use crate::server::oauth_pool_usage;
use std::time::Instant;

const PROVIDER: &str = "openai-codex";

fn save(vault: &super::super::accounts::AccountVault, account: &str, generation: &str) {
    vault.upsert(
        &super::super::accounts::provider_scope(PROVIDER), account, account,
        super::super::accounts::KIND_OAUTH,
        Some(json!({"type":"oauth", "access":format!("fixture-{generation}"), "refresh":"fixture-refresh", "expires":4_000_000_000_000_u64})),
    ).unwrap();
}

fn observe(vault: &super::super::accounts::AccountVault, account: &str, used: f64) {
    let revision = vault
        .credential_revision(&super::super::accounts::provider_scope(PROVIDER), account)
        .unwrap()
        .unwrap();
    let snapshot = ryu_usage::UsageSnapshot {
        agent_id: "fixture-sdk".into(),
        engine: PROVIDER.into(),
        available: true,
        plan: None,
        reason: None,
        windows: vec![ryu_usage::UsageWindow {
            label: "Account window".into(),
            used_percent: used,
            resets_at: None,
            window_seconds: Some(3600),
            model: None,
        }],
        meters: vec![],
        extra_usage_usd: None,
        retry_after_seconds: None,
        ..Default::default()
    };
    oauth_pool_usage::record(PROVIDER, account, &revision, Instant::now(), &snapshot);
}

fn capture_test(
    vault: &super::super::accounts::AccountVault,
    conversation: &str,
    chooser: &mut AccountChooser,
) -> SessionAccount {
    capture_with_vault_and_policy(
        vault,
        PROVIDER,
        PROVIDER,
        Some(conversation),
        "fixture-agent",
        None,
        &Policy {
            strategy: Strategy::QuotaFirst,
            ..Policy::default()
        },
        chooser,
    )
    .unwrap()
    .unwrap()
}

#[test]
fn existing_conversation_retains_identity_after_quota_change_picker_switch_and_new_login() {
    let vault = super::super::accounts::AccountVault::in_memory().unwrap();
    let prefix = uuid::Uuid::new_v4();
    let first = format!("{prefix}-first");
    let second = format!("{prefix}-second");
    save(&vault, &first, "first-original");
    save(&vault, &second, "second-original");
    observe(&vault, &first, 10.0);
    observe(&vault, &second, 70.0);
    let mut chooser = AccountChooser::default();
    let bound = capture_test(&vault, "bound-chat", &mut chooser);
    assert_eq!(bound.account_id, first);
    let identity = bound.process_identity();
    let cache_key = bound.session_key.clone();
    observe(&vault, &first, 90.0);
    observe(&vault, &second, 5.0);
    vault
        .set_active(&super::super::accounts::provider_scope(PROVIDER), &second)
        .unwrap();
    let reranked = capture_test(&vault, "new-chat", &mut chooser);
    assert_eq!(reranked.account_id, second);
    assert_eq!(capture_test(&vault, "bound-chat", &mut chooser), bound);
    save(&vault, &first, "first-new-login");
    let resumed = capture_test(&vault, "bound-chat", &mut AccountChooser::default());
    assert_eq!(resumed, bound);
    assert_eq!(resumed.process_identity(), identity);
    assert_eq!(resumed.session_key, cache_key);
    assert_ne!(reranked.session_key, cache_key);
    assert!(vault
        .credential(&super::super::accounts::provider_scope(PROVIDER), &first)
        .unwrap()
        .unwrap()["access"]
        .as_str()
        .unwrap()
        .contains("first-new-login"));
}

#[test]
fn quota_binding_survives_vault_reopen_while_new_conversations_use_current_observations() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("accounts.db");
    let prefix = uuid::Uuid::new_v4();
    let first = format!("{prefix}-first");
    let second = format!("{prefix}-second");
    let bound = {
        let vault = super::super::accounts::AccountVault::open_test(path.clone()).unwrap();
        save(&vault, &first, "first");
        save(&vault, &second, "second");
        observe(&vault, &first, 5.0);
        observe(&vault, &second, 70.0);
        capture_test(&vault, "persisted-chat", &mut AccountChooser::default())
    };
    let reopened = super::super::accounts::AccountVault::open_test(path).unwrap();
    observe(&reopened, &first, 95.0);
    observe(&reopened, &second, 5.0);
    let mut chooser = AccountChooser::default();
    assert_eq!(
        capture_test(&reopened, "persisted-chat", &mut chooser),
        bound
    );
    assert_eq!(
        capture_test(&reopened, "fresh-chat", &mut chooser).account_id,
        second
    );
}

#[test]
fn newer_credential_cannot_inherit_old_quota_rank_but_can_receive_fresh_observation() {
    let vault = super::super::accounts::AccountVault::in_memory().unwrap();
    let prefix = uuid::Uuid::new_v4();
    let first = format!("{prefix}-first");
    let second = format!("{prefix}-second");
    save(&vault, &first, "old-login");
    save(&vault, &second, "second");
    observe(&vault, &first, 0.0);
    observe(&vault, &second, 60.0);
    let old_revision = vault
        .credential_revision(&super::super::accounts::provider_scope(PROVIDER), &first)
        .unwrap()
        .unwrap();
    save(&vault, &first, "new-login");
    let current_revision = vault
        .credential_revision(&super::super::accounts::provider_scope(PROVIDER), &first)
        .unwrap()
        .unwrap();
    assert_ne!(current_revision, old_revision);
    assert!(oauth_pool_usage::get(PROVIDER, &first, &current_revision).is_none());
    assert_eq!(
        capture_test(&vault, "after-login", &mut AccountChooser::default()).account_id,
        second
    );
    observe(&vault, &first, 1.0);
    assert_eq!(
        capture_test(&vault, "after-observation", &mut AccountChooser::default()).account_id,
        first
    );
}

#[test]
fn quarantined_low_usage_account_is_excluded_without_silently_rebinding_existing_chat() {
    let vault = super::super::accounts::AccountVault::in_memory().unwrap();
    let prefix = uuid::Uuid::new_v4();
    let first = format!("{prefix}-first");
    let second = format!("{prefix}-second");
    save(&vault, &first, "first");
    save(&vault, &second, "second");
    observe(&vault, &first, 0.0);
    observe(&vault, &second, 60.0);
    let mut chooser = AccountChooser::default();
    assert_eq!(
        capture_test(&vault, "bound-before-quarantine", &mut chooser).account_id,
        first
    );
    let scope = super::super::accounts::provider_scope(PROVIDER);
    let credential = vault.credential(&scope, &first).unwrap().unwrap();
    let revision = vault.begin_refresh(&scope, &first, &credential).unwrap();
    vault
        .record_refresh_failure(
            &scope,
            &first,
            &revision,
            super::super::accounts::RefreshFailure::Revoked,
        )
        .unwrap();
    assert!(vault.needs_reauth(&scope, &first).unwrap());
    assert_eq!(
        capture_test(&vault, "new-after-quarantine", &mut chooser).account_id,
        second
    );
    assert_eq!(
        capture_test(&vault, "bound-before-quarantine", &mut chooser).account_id,
        first
    );
    assert!(vault.begin_refresh(&scope, &first, &credential).is_err());
}
