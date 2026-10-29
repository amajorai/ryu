//! Deterministic refresh dispatch tests. Credentials and outcomes are fixtures;
//! no provider network or normal account data is accessed.
use super::{accounts, refresh_subscription_account_with};
use accounts::{AccountVault, RefreshFailure};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

fn expired() -> Value {
    json!({"type":"oauth","access":"fixture-old","refresh":"fixture-refresh","expires":1})
}

fn rotated() -> Value {
    json!({"type":"oauth","access":"fixture-new","refresh":"fixture-rotated","expires":4102444800000u64})
}

fn seed(vault: &AccountVault, credential: Value) {
    vault
        .upsert(
            "provider:anthropic",
            "account",
            "Fixture",
            accounts::KIND_OAUTH,
            Some(credential),
        )
        .unwrap();
}

async fn blocked(vault: &AccountVault, calls: &AtomicUsize) {
    let error = refresh_subscription_account_with(vault, "anthropic", "account", |_| async {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(Some(rotated()))
    })
    .await
    .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<RefreshFailure>(),
        Some(RefreshFailure::Uncertain | RefreshFailure::Revoked)
    ));
}

#[tokio::test]
async fn uncertain_delivery_cannot_replay_after_retry_or_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("accounts.sqlite");
    let vault = AccountVault::open_test(path.clone()).unwrap();
    seed(&vault, expired());
    let calls = AtomicUsize::new(0);
    refresh_subscription_account_with(&vault, "anthropic", "account", |_| async {
        calls.fetch_add(1, Ordering::SeqCst);
        Err(anyhow::anyhow!("fixture timeout after dispatch"))
    })
    .await
    .unwrap_err();
    blocked(&vault, &calls).await;
    drop(vault);
    let reopened = AccountVault::open_test(path).unwrap();
    blocked(&reopened, &calls).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(reopened.list("provider:anthropic").unwrap()[0].needs_reauth);
    let view = serde_json::to_value(reopened.list("provider:anthropic").unwrap()).unwrap();
    assert_eq!(view[0]["needsReauth"], true);
    assert!(!view.to_string().contains("fixture-refresh"));
}

#[tokio::test]
async fn successful_rotation_with_failed_vault_write_cannot_replay_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("accounts.sqlite");
    let vault = AccountVault::open_test(path.clone()).unwrap();
    seed(&vault, expired());
    let calls = AtomicUsize::new(0);
    refresh_subscription_account_with(&vault, "anthropic", "account", |_| async {
        calls.fetch_add(1, Ordering::SeqCst);
        vault.reject_writes_for_test().unwrap();
        Ok(Some(rotated()))
    })
    .await
    .unwrap_err();
    blocked(&vault, &calls).await;
    drop(vault);
    blocked(&AccountVault::open_test(path).unwrap(), &calls).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn revoked_generation_requires_new_login() {
    let vault = AccountVault::in_memory().unwrap();
    seed(&vault, expired());
    let calls = AtomicUsize::new(0);
    refresh_subscription_account_with(&vault, "anthropic", "account", |_| async {
        calls.fetch_add(1, Ordering::SeqCst);
        Err(RefreshFailure::Revoked.into())
    })
    .await
    .unwrap_err();
    blocked(&vault, &calls).await;
    seed(&vault, rotated());
    assert!(!vault.needs_reauth("provider:anthropic", "account").unwrap());
    let credential = refresh_subscription_account_with(&vault, "anthropic", "account", |_| async {
        panic!("a fresh login does not refresh")
    })
    .await
    .unwrap();
    assert_eq!(credential, rotated());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn concurrent_new_login_is_neither_overwritten_nor_quarantined() {
    for revoked in [false, true] {
        let vault = AccountVault::in_memory().unwrap();
        let original = expired();
        seed(&vault, original.clone());
        refresh_subscription_account_with(&vault, "anthropic", "account", |_| async {
            // Even identical token values represent a newer credential revision.
            seed(&vault, original.clone());
            if revoked {
                Err(RefreshFailure::Revoked.into())
            } else {
                Ok(Some(rotated()))
            }
        })
        .await
        .unwrap_err();
        assert_eq!(
            vault.credential("provider:anthropic", "account").unwrap(),
            Some(original)
        );
        assert!(!vault.needs_reauth("provider:anthropic", "account").unwrap());
    }
}

#[tokio::test]
async fn explicit_transient_rejection_has_cooldown_then_allows_retry() {
    let vault = AccountVault::in_memory().unwrap();
    seed(&vault, expired());
    let calls = AtomicUsize::new(0);
    let error = refresh_subscription_account_with(&vault, "anthropic", "account", |_| async {
        calls.fetch_add(1, Ordering::SeqCst);
        Err(RefreshFailure::Transient.into())
    })
    .await
    .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<RefreshFailure>(),
        Some(RefreshFailure::Transient)
    ));
    assert!(!vault.needs_reauth("provider:anthropic", "account").unwrap());
    let error = refresh_subscription_account_with(&vault, "anthropic", "account", |_| async {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(Some(rotated()))
    })
    .await
    .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<RefreshFailure>(),
        Some(RefreshFailure::Transient)
    ));
    vault.expire_refresh_retry_for_test().unwrap();
    let credential = refresh_subscription_account_with(&vault, "anthropic", "account", |_| async {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(Some(rotated()))
    })
    .await
    .unwrap();
    assert_eq!(credential["access"], "fixture-new");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(!vault.needs_reauth("provider:anthropic", "account").unwrap());
}

#[tokio::test]
async fn normal_rotation_persists_and_does_not_refresh_fresh_credentials() {
    let vault = AccountVault::in_memory().unwrap();
    seed(&vault, expired());
    let result = refresh_subscription_account_with(&vault, "anthropic", "account", |_| async {
        Ok(Some(rotated()))
    })
    .await
    .unwrap();
    assert_eq!(result["access"], "fixture-new");
    assert_eq!(
        vault.credential("provider:anthropic", "account").unwrap(),
        Some(result.clone())
    );
    assert!(!vault.list("provider:anthropic").unwrap()[0].needs_reauth);
    assert_eq!(
        refresh_subscription_account_with(&vault, "anthropic", "account", |_| async {
            panic!("fresh credential must not dispatch")
        })
        .await
        .unwrap(),
        result
    );
}

#[test]
fn separate_vault_connections_cannot_claim_the_same_generation() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("accounts.sqlite");
    let first = AccountVault::open_test(path.clone()).unwrap();
    let second = AccountVault::open_test(path).unwrap();
    seed(&first, expired());
    first
        .begin_refresh("provider:anthropic", "account", &expired())
        .unwrap();
    let error = second
        .begin_refresh("provider:anthropic", "account", &expired())
        .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<RefreshFailure>(),
        Some(RefreshFailure::Uncertain)
    ));
    seed(&second, rotated());
    assert!(!first.needs_reauth("provider:anthropic", "account").unwrap());
}

#[tokio::test]
async fn intent_persistence_failure_prevents_dispatch() {
    let vault = AccountVault::in_memory().unwrap();
    seed(&vault, expired());
    vault.reject_writes_for_test().unwrap();
    let calls = AtomicUsize::new(0);
    refresh_subscription_account_with(&vault, "anthropic", "account", |_| async {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(Some(rotated()))
    })
    .await
    .unwrap_err();
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

fn proactive_fixture(path: &std::path::Path, credential: Value) {
    super::write_secret_file(
        path,
        &json!({"openai": credential, "other": {"type":"api_key","key":"fixture-other"}})
            .to_string(),
    )
    .unwrap();
}

fn seed_proactive(vault: &AccountVault, credential: Value) {
    vault
        .upsert(
            "provider:openai",
            "account",
            "Fixture",
            accounts::KIND_OAUTH,
            Some(credential),
        )
        .unwrap();
}

#[tokio::test]
async fn proactive_entrypoint_lost_response_clears_shared_auth_and_never_replays_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("accounts.sqlite");
    let path = directory.path().join("auth.json");
    let vault = AccountVault::open_test(database.clone()).unwrap();
    seed_proactive(&vault, expired());
    proactive_fixture(&path, expired());
    let calls = AtomicUsize::new(0);
    super::refresh_oauth_with(Some(&vault), &path, "openai", |_| async {
        calls.fetch_add(1, Ordering::SeqCst);
        Err(anyhow::anyhow!("fixture lost response"))
    })
    .await
    .unwrap_err();
    assert!(!super::read_refresh_auth(&path)
        .unwrap()
        .contains_key("openai"));
    assert!(super::read_refresh_auth(&path)
        .unwrap()
        .contains_key("other"));
    assert!(super::materializable_account_credential(
        &vault,
        "provider:openai",
        "account",
        expired()
    )
    .unwrap()
    .is_none());
    drop(vault);
    let reopened = AccountVault::open_test(database).unwrap();
    super::refresh_oauth_with(Some(&reopened), &path, "openai", |_| async {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(Some(rotated()))
    })
    .await
    .unwrap_err();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    seed_proactive(&reopened, rotated());
    super::refresh_oauth_with(Some(&reopened), &path, "openai", |_| async {
        panic!("a newer fresh login must not dispatch")
    })
    .await
    .unwrap();
    assert_eq!(
        super::read_refresh_auth(&path).unwrap()["openai"],
        rotated()
    );
    assert!(super::materializable_account_credential(
        &reopened,
        "provider:openai",
        "account",
        rotated()
    )
    .unwrap()
    .is_some());
}

#[tokio::test]
async fn proactive_entrypoint_failed_rotation_persistence_quarantines_shared_auth_after_restart() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("accounts.sqlite");
    let path = directory.path().join("auth.json");
    let vault = AccountVault::open_test(database.clone()).unwrap();
    seed_proactive(&vault, expired());
    proactive_fixture(&path, expired());
    let calls = AtomicUsize::new(0);
    super::refresh_oauth_with(Some(&vault), &path, "openai", |_| async {
        calls.fetch_add(1, Ordering::SeqCst);
        vault.reject_writes_for_test().unwrap();
        Ok(Some(rotated()))
    })
    .await
    .unwrap_err();
    assert!(!super::read_refresh_auth(&path)
        .unwrap()
        .contains_key("openai"));
    drop(vault);
    let reopened = AccountVault::open_test(database).unwrap();
    super::refresh_oauth_with(Some(&reopened), &path, "openai", |_| async {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(Some(rotated()))
    })
    .await
    .unwrap_err();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(reopened.needs_reauth("provider:openai", "account").unwrap());
}

#[tokio::test]
async fn proactive_entrypoint_preserves_newer_login_and_active_selection() {
    for switch_account in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("auth.json");
        let vault = AccountVault::in_memory().unwrap();
        seed_proactive(&vault, expired());
        proactive_fixture(&path, expired());
        super::refresh_oauth_with(Some(&vault), &path, "openai", |_| async {
            if switch_account {
                vault
                    .upsert(
                        "provider:openai",
                        "second",
                        "Second",
                        accounts::KIND_OAUTH,
                        Some(rotated()),
                    )
                    .unwrap();
                vault.set_active("provider:openai", "second").unwrap();
                proactive_fixture(&path, rotated());
            } else {
                // Identical plaintext still has a distinct sealed generation.
                seed_proactive(&vault, expired());
                proactive_fixture(&path, expired());
            }
            Err(RefreshFailure::Revoked.into())
        })
        .await
        .unwrap_err();
        let expected = if switch_account { rotated() } else { expired() };
        assert_eq!(super::read_refresh_auth(&path).unwrap()["openai"], expected);
        assert_eq!(
            vault.needs_reauth("provider:openai", "account").unwrap(),
            switch_account,
            "revocation remains attached to the dispatched account generation; a newer login replaces that generation"
        );
        let selected_account = if switch_account { "second" } else { "account" };
        assert!(!vault
            .needs_reauth("provider:openai", selected_account)
            .unwrap());
        assert_eq!(
            vault
                .credential("provider:openai", selected_account)
                .unwrap()
                .unwrap(),
            expected,
            "the active login's sealed credential must survive the earlier account's revoked response"
        );
        assert_eq!(
            vault
                .active_info("provider:openai")
                .unwrap()
                .unwrap()
                .account_id,
            if switch_account { "second" } else { "account" }
        );
    }
}

#[tokio::test]
async fn proactive_entrypoint_migrates_only_private_scope_before_guarded_exchange() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("auth.json");
    let vault = AccountVault::in_memory().unwrap();
    proactive_fixture(&path, expired());
    let calls = AtomicUsize::new(0);
    assert!(
        super::refresh_oauth_with(Some(&vault), &path, "openai", |_| async {
            calls.fetch_add(1, Ordering::SeqCst);
            let account = vault.active_info("provider:openai").unwrap().unwrap();
            assert!(vault
                .needs_reauth("provider:openai", &account.account_id)
                .unwrap());
            Ok(Some(rotated()))
        })
        .await
        .unwrap()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(vault.count("provider:openai").unwrap(), 1);
    assert_eq!(vault.count("provider:other").unwrap(), 0);
    let shared = super::read_refresh_auth(&path).unwrap()["openai"].clone();
    assert_eq!(shared["access"], "fixture-new");
    assert_eq!(shared["refresh"], "fixture-rotated");
    assert_eq!(
        vault
            .active_credential("provider:openai")
            .unwrap()
            .unwrap()
            .1,
        shared
    );
}

#[tokio::test]
async fn proactive_entrypoint_unavailable_vault_never_exchanges_expired_plaintext() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("auth.json");
    proactive_fixture(&path, expired());
    super::refresh_oauth_with(None, &path, "openai", |_| async {
        panic!("plaintext refresh without durable custody must not dispatch")
    })
    .await
    .unwrap_err();
    assert!(!super::read_refresh_auth(&path)
        .unwrap()
        .contains_key("openai"));
    assert!(super::read_refresh_auth(&path)
        .unwrap()
        .contains_key("other"));
}

#[tokio::test]
async fn proactive_entrypoint_failed_legacy_import_never_dispatches_or_leaves_plaintext() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("auth.json");
    let vault = AccountVault::in_memory().unwrap();
    proactive_fixture(&path, expired());
    vault.reject_writes_for_test().unwrap();
    super::refresh_oauth_with(Some(&vault), &path, "openai", |_| async {
        panic!("failed sealed import must not dispatch")
    })
    .await
    .unwrap_err();
    assert!(!super::read_refresh_auth(&path)
        .unwrap()
        .contains_key("openai"));
    assert!(super::read_refresh_auth(&path)
        .unwrap()
        .contains_key("other"));
}

#[tokio::test]
async fn proactive_batch_continues_only_after_unsafe_shared_slot_is_removed() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("auth.json");
    let vault = AccountVault::in_memory().unwrap();
    seed_proactive(&vault, expired());
    proactive_fixture(&path, expired());
    let calls = AtomicUsize::new(0);
    super::refresh_pi_oauth_logins_with(&path, |auth_key| {
        super::refresh_oauth_with(Some(&vault), &path, auth_key, |_| async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(anyhow::anyhow!("fixture lost response"))
        })
    })
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!super::read_refresh_auth(&path)
        .unwrap()
        .contains_key("openai"));
}

#[tokio::test]
async fn proactive_batch_unreadable_auth_file_blocks_process_spawn() {
    let directory = tempfile::tempdir().unwrap();
    // A directory cannot be read as auth.json on any supported platform.
    super::refresh_pi_oauth_logins_with(directory.path(), |_| async {
        Err(anyhow::anyhow!("fixture auth removal failed"))
    })
    .await
    .unwrap_err();
}

#[tokio::test]
async fn proactive_entrypoint_keeps_api_key_slots_without_oauth_expiry() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("auth.json");
    let vault = AccountVault::in_memory().unwrap();
    let key = json!({"type":"api_key","key":"fixture-key"});
    proactive_fixture(&path, key.clone());
    for candidate in [None, Some(&vault)] {
        assert!(
            !super::refresh_oauth_with(candidate, &path, "openai", |_| async {
                panic!("API keys do not refresh")
            })
            .await
            .unwrap()
        );
        assert_eq!(super::read_refresh_auth(&path).unwrap()["openai"], key);
    }
}

#[tokio::test]
async fn proactive_entrypoint_no_vault_uses_sdk_refresh_window() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("auth.json");
    let credential = json!({"type":"oauth","access":"fixture-access","refresh":"fixture-refresh","expires_at":super::now_unix() + 120});
    super::write_secret_file(&path, &json!({"openai-codex":credential}).to_string()).unwrap();
    super::refresh_oauth_with(None, &path, "openai-codex", |_| async {
        panic!("SDK-skew credential requires durable custody")
    })
    .await
    .unwrap_err();
    assert!(!super::read_refresh_auth(&path)
        .unwrap()
        .contains_key("openai-codex"));
}

#[tokio::test]
async fn proactive_batch_legacy_anthropic_without_vault_cannot_bypass_guard() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("auth.json");
    super::write_secret_file(&path, &json!({"anthropic":expired()}).to_string()).unwrap();
    super::refresh_pi_oauth_logins_with(&path, |auth_key| {
        super::refresh_oauth_with(None, &path, auth_key, |_| async {
            panic!("legacy Claude plaintext must never exchange without custody")
        })
    })
    .await
    .unwrap();
    assert!(!super::read_refresh_auth(&path)
        .unwrap()
        .contains_key("anthropic"));
}

#[tokio::test]
async fn proactive_batch_preserves_local_claude_proxy_without_refreshing_it() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("auth.json");
    let proxy = super::claude_proxy_credential();
    super::write_secret_file(&path, &json!({"anthropic":proxy}).to_string()).unwrap();
    super::refresh_pi_oauth_logins_with(&path, |auth_key| async move {
        assert_ne!(auth_key, "anthropic");
        Ok(false)
    })
    .await
    .unwrap();
    assert_eq!(super::read_refresh_auth(&path).unwrap()["anthropic"], proxy);
}

#[tokio::test]
async fn proactive_batch_legacy_anthropic_migrates_and_removes_renewable_shared_slot() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("auth.json");
    let vault = AccountVault::in_memory().unwrap();
    super::write_secret_file(&path, &json!({"anthropic":expired()}).to_string()).unwrap();
    let calls = AtomicUsize::new(0);
    super::refresh_pi_oauth_logins_with(&path, |auth_key| {
        super::refresh_oauth_with(Some(&vault), &path, auth_key, |_| async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(Some(rotated()))
        })
    })
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!super::read_refresh_auth(&path)
        .unwrap()
        .contains_key("anthropic"));
    assert_eq!(
        vault
            .active_credential("provider:anthropic")
            .unwrap()
            .unwrap()
            .1["access"],
        "fixture-new"
    );
}

#[cfg(windows)]
#[tokio::test]
async fn proactive_batch_readonly_slot_removal_failure_blocks_process_spawn() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("auth.json");
    let vault = AccountVault::in_memory().unwrap();
    seed_proactive(&vault, expired());
    proactive_fixture(&path, expired());
    let mut permissions = std::fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&path, permissions).unwrap();
    let calls = AtomicUsize::new(0);
    let result = super::refresh_pi_oauth_logins_with(&path, |auth_key| {
        super::refresh_oauth_with(Some(&vault), &path, auth_key, |_| async {
            calls.fetch_add(1, Ordering::SeqCst);
            Err(anyhow::anyhow!("fixture lost response"))
        })
    })
    .await;
    let mut permissions = std::fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(false);
    std::fs::set_permissions(&path, permissions).unwrap();
    assert!(result.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        super::read_refresh_auth(&path).unwrap()["openai"],
        expired()
    );
    assert!(vault.needs_reauth("provider:openai", "account").unwrap());
}
