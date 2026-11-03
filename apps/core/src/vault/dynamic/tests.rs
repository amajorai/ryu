//! Dynamic-role store tests (issue, renew, revoke, reaping, validation).

use super::*;
use rusqlite::params;

fn random_role() -> ProviderConfig {
    serde_json::from_value(json!({
        "kind": "random", "length": 24, "charset": "hex", "field": "token"
    }))
    .unwrap()
}

#[test]
fn provider_configs_round_trip_with_a_kind_tag() {
    let config = random_role();
    assert_eq!(
        config,
        ProviderConfig::Random {
            length: 24,
            charset: Charset::Hex,
            field: Some("token".into()),
        }
    );
    let value = serde_json::to_value(&config).unwrap();
    assert_eq!(value["kind"], "random");
}

#[tokio::test]
async fn random_roles_issue_renew_and_revoke() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let role = store
        .dynamic_put_role("ci-token", &random_role(), Some(60), Some(600), &actor)
        .await
        .unwrap();
    assert_eq!(role.provider, "random");
    let issued = store
        .dynamic_issue("ci-token", Some(10_000), Some("user:u1"), &actor)
        .await
        .unwrap();
    assert_eq!(issued.data["token"].len(), 24);
    // The requested TTL is clamped to the role's max.
    assert!(issued.lease.expires_at - issued.lease.created_at <= 600_000);
    store
        .dynamic_renew(&issued.lease.id, Some(30), &actor)
        .await
        .unwrap();
    assert!(store.dynamic_delete_role("ci-token", &actor).await.is_err());
    // TTL edits are allowed under live leases; a provider change is not.
    store
        .dynamic_put_role("ci-token", &random_role(), Some(30), Some(600), &actor)
        .await
        .unwrap();
    let changed = ProviderConfig::Random {
        length: 32,
        charset: Charset::Hex,
        field: Some("token".into()),
    };
    assert!(store
        .dynamic_put_role("ci-token", &changed, Some(60), Some(600), &actor)
        .await
        .is_err());
    let revoked = store
        .dynamic_revoke(&issued.lease.id, &actor)
        .await
        .unwrap();
    assert!(revoked.revoked_at.is_some());
    store.dynamic_delete_role("ci-token", &actor).await.unwrap();
}

#[tokio::test]
async fn fail_closed_withholds_and_revokes_dynamic_credentials() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    store
        .dynamic_put_role("ci-token", &random_role(), Some(60), Some(600), &actor)
        .await
        .unwrap();
    crate::vault::audit_devices::set_fail_closed_for_test(Some(true));
    let issued = store
        .dynamic_issue("ci-token", None, Some("user:u1"), &actor)
        .await;
    crate::vault::audit_devices::set_fail_closed_for_test(None);
    assert!(matches!(
        issued.unwrap_err().downcast_ref::<VaultError>(),
        Some(VaultError::AuditUnavailable)
    ));
    // The withheld lease is not left live.
    assert!(store
        .lease_list(Some("ci-token"), false)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn the_reaper_records_expiry_as_lease_expire() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    store
        .dynamic_put_role("short", &random_role(), Some(60), Some(600), &actor)
        .await
        .unwrap();
    let issued = store
        .dynamic_issue("short", None, None, &actor)
        .await
        .unwrap();
    let mut rx = crate::vault::events::subscribe();
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_leases SET expires_at = 0 WHERE id = ?1",
            params![issued.lease.id],
        )
        .unwrap();
    }
    assert_eq!(store.dynamic_reap().await.unwrap(), 1);
    loop {
        let event = rx.recv().await.unwrap();
        if event.lease_id.as_deref() == Some(issued.lease.id.as_str()) {
            assert_eq!(event.kind, "lease-expire");
            assert_eq!(event.policy_key(), "sys/dynamic/short");
            break;
        }
    }
}

#[tokio::test]
async fn failing_revocations_do_not_starve_healthy_expired_leases() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    // More failing leases than one reaper page: their role is gone, so
    // every revocation attempt fails.
    for _ in 0..201 {
        store
            .lease_create(
                NewLease {
                    role: "gone",
                    provider: "random",
                    issued_to: None,
                    ttl_secs: 0,
                    max_ttl_secs: 0,
                    renewable: false,
                    revoke_data: &Value::Null,
                },
                &actor,
            )
            .await
            .unwrap();
    }
    store
        .dynamic_put_role("short", &random_role(), Some(60), Some(600), &actor)
        .await
        .unwrap();
    let healthy = store
        .dynamic_issue("short", None, None, &actor)
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_leases SET expires_at = CASE WHEN id = ?1 THEN 1 ELSE 0 END",
            params![healthy.lease.id],
        )
        .unwrap();
    }
    // The first pass fills its page with failing leases and backs them off.
    assert_eq!(store.dynamic_reap().await.unwrap(), 0);
    // The next pass reaches the healthy lease behind them.
    assert_eq!(store.dynamic_reap().await.unwrap(), 1);
    assert!(store
        .lease_get(&healthy.lease.id)
        .await
        .unwrap()
        .revoked_at
        .is_some());
    let conn = store.conn.lock().await;
    let deferred: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vault_leases
             WHERE role = 'gone' AND revoke_attempts = 1 AND next_revoke_at > ?1",
            params![now_millis()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(deferred, 201);
}

#[tokio::test]
async fn fresh_expirations_are_reaped_before_due_retries() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    // A full page of failing leases whose backoff has lapsed: they expired
    // earlier than the healthy lease, so they would sort first by expiry.
    for _ in 0..200 {
        store
            .lease_create(
                NewLease {
                    role: "gone",
                    provider: "random",
                    issued_to: None,
                    ttl_secs: 0,
                    max_ttl_secs: 0,
                    renewable: false,
                    revoke_data: &Value::Null,
                },
                &actor,
            )
            .await
            .unwrap();
    }
    store
        .dynamic_put_role("short", &random_role(), Some(60), Some(600), &actor)
        .await
        .unwrap();
    let healthy = store
        .dynamic_issue("short", None, None, &actor)
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_leases SET expires_at = 0, revoke_attempts = 5, next_revoke_at = 0
             WHERE role = 'gone'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE vault_leases SET expires_at = 1 WHERE id = ?1",
            params![healthy.lease.id],
        )
        .unwrap();
    }
    let due = store.lease_expired(now_millis()).await.unwrap();
    assert_eq!(due.len(), 200);
    assert_eq!(due[0].id, healthy.lease.id);
    // A single pass reaches the never-attempted lease ahead of the retries.
    assert_eq!(store.dynamic_reap().await.unwrap(), 1);
    assert!(store
        .lease_get(&healthy.lease.id)
        .await
        .unwrap()
        .revoked_at
        .is_some());
}

#[tokio::test]
async fn invalid_roles_are_rejected() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    assert!(store
        .dynamic_put_role("Bad Name", &random_role(), None, None, &actor)
        .await
        .is_err());
    let short: ProviderConfig =
        serde_json::from_value(json!({ "kind": "random", "length": 2, "charset": "hex" })).unwrap();
    assert!(store
        .dynamic_put_role("x", &short, None, None, &actor)
        .await
        .is_err());
}
