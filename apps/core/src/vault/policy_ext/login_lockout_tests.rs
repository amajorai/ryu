//! Login lockout tests.

use super::*;
use crate::vault::machine::AuthMethod;

async fn identity(store: &PluginSecretStore, name: &str) -> String {
    let identity = store
        .machine_create(
            name,
            AuthMethod::AppRole {
                role_id: String::new(),
            },
            vec!["default".into()],
            Some(600),
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let AuthMethod::AppRole { role_id } = identity.auth else {
        panic!("approle")
    };
    role_id
}

fn named(name: &str) -> LoginPrincipal {
    LoginPrincipal::Identity(name.to_owned())
}

#[tokio::test]
async fn failures_inside_the_window_lock_until_unlocked() {
    let store = PluginSecretStore::in_memory().unwrap();
    let role_id = identity(&store, "ci").await;
    store
        .lockout_set_config(
            &LockoutConfig {
                threshold: 3,
                ..LockoutConfig::default()
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    // AppRole failures (by role id) and named failures count together.
    let by_role = LoginPrincipal::RoleId(role_id);
    assert_eq!(store.lockout_record(&by_role, false).await.unwrap(), None);
    assert_eq!(
        store.lockout_record(&named("ci"), false).await.unwrap(),
        None
    );
    assert_eq!(store.lockout_check(&by_role).await.unwrap(), None);
    let locked = store
        .lockout_record(&by_role, false)
        .await
        .unwrap()
        .unwrap();
    assert!(locked.locked_until > now_millis());
    assert_eq!(
        store.lockout_check(&named("ci")).await.unwrap(),
        Some(locked)
    );
    let listed = store.lockout_list().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].identity, "ci");
    assert_eq!(listed[0].failures, 3);

    assert!(store
        .lockout_unlock("ci", &AuditActor::system())
        .await
        .unwrap());
    assert_eq!(store.lockout_check(&by_role).await.unwrap(), None);
    assert!(store.lockout_list().await.unwrap().is_empty());
    assert!(!store
        .lockout_unlock("ci", &AuditActor::system())
        .await
        .unwrap());
}

#[tokio::test]
async fn a_success_resets_and_expired_windows_and_locks_clear() {
    let store = PluginSecretStore::in_memory().unwrap();
    identity(&store, "web").await;
    store
        .lockout_set_config(
            &LockoutConfig {
                threshold: 2,
                ..LockoutConfig::default()
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    store.lockout_record(&named("web"), false).await.unwrap();
    store.lockout_record(&named("web"), true).await.unwrap();
    assert_eq!(
        store.lockout_record(&named("web"), false).await.unwrap(),
        None
    );

    // A failure outside the window starts a new count.
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_login_lockouts SET window_start = window_start - ?1",
            params![DEFAULT_WINDOW_SECS * 1000 + 1],
        )
        .unwrap();
    }
    assert_eq!(
        store.lockout_record(&named("web"), false).await.unwrap(),
        None
    );
    assert!(store
        .lockout_record(&named("web"), false)
        .await
        .unwrap()
        .is_some());
    // An expired lock no longer refuses.
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_login_lockouts SET locked_until = ?1",
            params![now_millis() - 1],
        )
        .unwrap();
    }
    assert_eq!(store.lockout_check(&named("web")).await.unwrap(), None);
}

#[tokio::test]
async fn unknown_identities_are_not_tracked_and_disabled_lockout_refuses_nothing() {
    let store = PluginSecretStore::in_memory().unwrap();
    for _ in 0..10 {
        assert_eq!(
            store.lockout_record(&named("ghost"), false).await.unwrap(),
            None
        );
    }
    assert!(store.lockout_list().await.unwrap().is_empty());

    identity(&store, "ops").await;
    store
        .lockout_set_config(
            &LockoutConfig {
                enabled: false,
                threshold: 1,
                ..LockoutConfig::default()
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    assert_eq!(
        store.lockout_record(&named("ops"), false).await.unwrap(),
        None
    );
    assert_eq!(store.lockout_check(&named("ops")).await.unwrap(), None);
}

#[tokio::test]
async fn config_is_validated_and_defaults_match_openbao() {
    let store = PluginSecretStore::in_memory().unwrap();
    assert_eq!(
        store.lockout_config().await.unwrap(),
        LockoutConfig::default()
    );
    assert_eq!(LockoutConfig::default().threshold, 5);
    for bad in [
        LockoutConfig {
            threshold: 0,
            ..LockoutConfig::default()
        },
        LockoutConfig {
            window_secs: 0,
            ..LockoutConfig::default()
        },
        LockoutConfig {
            duration_secs: MAX_SECS + 1,
            ..LockoutConfig::default()
        },
    ] {
        assert!(store
            .lockout_set_config(&bad, &AuditActor::system())
            .await
            .is_err());
    }
    let parsed: LockoutConfig = serde_json::from_value(json!({ "threshold": 7 })).unwrap();
    assert_eq!(parsed.threshold, 7);
    assert!(parsed.enabled);
}
