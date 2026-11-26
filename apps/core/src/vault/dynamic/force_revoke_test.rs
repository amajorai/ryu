//! Force-revoke of a retry lease: one test per guard, the provider is never
//! called, the audit row is exact, and the role can be deleted afterwards.

use std::sync::{Arc, Mutex};

use rusqlite::params;
use serde_json::{json, Value};

use super::*;
use crate::vault::dynamic::{role_version_locked, ProviderConfig};
use crate::vault::leases::NewLease;

/// A loopback webhook that accepts every revoke. Returns its URL and the
/// revokes it saw.
async fn target() -> (String, Arc<Mutex<Vec<Value>>>) {
    let revokes = Arc::new(Mutex::new(Vec::<Value>::new()));
    let seen = revokes.clone();
    let app = axum::Router::new().route(
        "/hook",
        axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let seen = seen.clone();
            async move {
                seen.lock().unwrap().push(body);
                (axum::http::StatusCode::OK, axum::Json(json!({})))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (url, revokes)
}

fn webhook(url: &str) -> ProviderConfig {
    serde_json::from_value(json!({
        "kind": "webhook", "url": url, "signingSecret": "webhook-signing-secret-0001"
    }))
    .unwrap()
}

fn lease_input(role: &str) -> NewLease<'_> {
    static REVOKE_DATA: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    NewLease {
        role,
        provider: "webhook",
        issued_to: Some("user:u-issuer"),
        ttl_secs: 600,
        max_ttl_secs: 600,
        renewable: false,
        revoke_data: REVOKE_DATA.get_or_init(|| json!({ "user": "u" })),
    }
}

/// Role `fr` at `url`, with one retry lease bound to its current version (so
/// the reaper would revoke it through `url`). Returns the lease id.
async fn retry_lease(store: &PluginSecretStore, url: &str) -> String {
    let system = AuditActor::system();
    if store.dynamic_role("fr").await.is_err() {
        store
            .dynamic_put_role("fr", &webhook(url), Some(600), Some(600), &system)
            .await
            .unwrap();
    }
    let version = {
        let conn = store.conn.lock().await;
        role_version_locked(&conn, "fr").unwrap()
    };
    store
        .lease_record_for_revoke(lease_input("fr"), version.as_deref())
        .await
        .unwrap()
}

fn manager() -> AuditActor {
    AuditActor::new("user", Some("u-admin"))
}

fn request(actor: &AuditActor, manager: bool, acknowledged: bool) -> ForceRevoke<'_> {
    ForceRevoke {
        manager,
        acknowledged,
        actor,
    }
}

/// `(actor_kind, actor_id, outcome, details)` of every `lease.revoke` row.
async fn revoke_rows(store: &PluginSecretStore) -> Vec<(String, Option<String>, String, Value)> {
    let conn = store.conn.lock().await;
    let mut stmt = conn
        .prepare(
            "SELECT actor_kind, actor_id, outcome, details FROM vault_audit
             WHERE action = 'lease.revoke' ORDER BY seq",
        )
        .unwrap();
    stmt.query_map([], |row| {
        let details: String = row.get(3)?;
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            serde_json::from_str(&details).unwrap(),
        ))
    })
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}

fn vault_error(error: &anyhow::Error) -> &VaultError {
    error.downcast_ref::<VaultError>().expect("a VaultError")
}

/// The lease is still open and no `lease.revoke` row was written.
async fn assert_untouched(store: &PluginSecretStore, id: &str) {
    assert!(store.lease_get(id).await.unwrap().revoked_at.is_none());
    assert!(revoke_rows(store).await.is_empty());
}

#[tokio::test]
async fn a_handed_out_lease_is_refused() {
    let store = PluginSecretStore::in_memory().unwrap();
    let lease = store
        .lease_create(lease_input("fr"), &AuditActor::system())
        .await
        .unwrap();
    let actor = manager();
    let error = store
        .lease_force_revoke(&lease.id, request(&actor, true, true))
        .await
        .unwrap_err();
    assert!(
        matches!(vault_error(&error), VaultError::Conflict(message) if message.contains("is not a retry lease")),
        "{error:#}"
    );
    assert_untouched(&store, &lease.id).await;
}

#[tokio::test]
async fn a_caller_who_is_not_a_configuration_manager_is_refused() {
    let store = PluginSecretStore::in_memory().unwrap();
    let id = retry_lease(&store, "https://hooks.example.com/hook").await;
    let actor = AuditActor::new("user", Some("u-delegate"));
    let error = store
        .lease_force_revoke(&id, request(&actor, false, true))
        .await
        .unwrap_err();
    assert!(
        matches!(vault_error(&error), VaultError::Denied(message) if message == MANAGER_ONLY),
        "{error:#}"
    );
    assert_untouched(&store, &id).await;
}

#[tokio::test]
async fn a_request_without_the_acknowledgement_is_refused() {
    let store = PluginSecretStore::in_memory().unwrap();
    let id = retry_lease(&store, "https://hooks.example.com/hook").await;
    let actor = manager();
    let error = store
        .lease_force_revoke(&id, request(&actor, true, false))
        .await
        .unwrap_err();
    assert!(
        matches!(vault_error(&error), VaultError::Invalid(message)
            if message.contains("revokes nothing at the provider")
                && message.contains("acknowledgeCredentialMayBeLive")),
        "{error:#}"
    );
    assert_untouched(&store, &id).await;
}

#[tokio::test]
async fn it_marks_the_retry_lease_revoked_without_calling_the_provider() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (url, seen) = target().await;
    let forced = retry_lease(&store, &url).await;
    let actor = manager();
    let lease = store
        .lease_force_revoke(&forced, request(&actor, true, true))
        .await
        .unwrap();
    assert!(lease.revoked_at.is_some() && lease.pending_revoke);
    assert!(seen.lock().unwrap().is_empty(), "the provider saw a revoke");
    // The reaper has nothing left to do for it, and the role counts no retry
    // lease. A second retry lease shows the reaper would have called `url`.
    let reaped = retry_lease(&store, &url).await;
    {
        let conn = store.conn.lock().await;
        conn.execute("UPDATE vault_leases SET next_revoke_at = 0", [])
            .unwrap();
    }
    assert_eq!(store.dynamic_reap().await.unwrap(), 1);
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert!(store.lease_get(&reaped).await.unwrap().revoked_at.is_some());
    let (info, _) = store.dynamic_role("fr").await.unwrap();
    assert_eq!(info.pending_revoke_leases, 0);
    // A second force-revoke of the same lease is refused, not audited again.
    let error = store
        .lease_force_revoke(&forced, request(&actor, true, true))
        .await
        .unwrap_err();
    assert!(
        matches!(vault_error(&error), VaultError::Conflict(message) if message.contains("already revoked")),
        "{error:#}"
    );
    let forced_rows = revoke_rows(&store)
        .await
        .into_iter()
        .filter(|row| row.3["reason"] == "forced")
        .count();
    assert_eq!(forced_rows, 1);
}

#[tokio::test]
async fn the_audit_row_names_the_caller_the_role_and_the_target() {
    let store = PluginSecretStore::in_memory().unwrap();
    let url = "https://hooks.example.com/hook/secret-path?token=t";
    let id = retry_lease(&store, url).await;
    let created_at = store.lease_get(&id).await.unwrap().created_at;
    let actor = manager();
    store
        .lease_force_revoke(&id, request(&actor, true, true))
        .await
        .unwrap();
    let rows = revoke_rows(&store).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    let (kind, actor_id, outcome, details) = &rows[0];
    assert_eq!(
        (kind.as_str(), actor_id.as_deref(), outcome.as_str()),
        ("user", Some("u-admin"), "ok")
    );
    assert_eq!(
        details,
        &json!({
            "leaseId": id,
            "retryLeaseId": id,
            "role": "fr",
            "provider": "webhook",
            "leaseCreatedAt": created_at,
            "reason": "forced",
            "credentialRevoked": false,
            "acknowledged": true,
            "caller": "user:u-admin",
            "callerAuthority": "configuration-manager",
            "target": { "url": "https://hooks.example.com" },
        })
    );
}

#[tokio::test]
async fn the_mark_never_commits_without_its_audit_row() {
    let store = PluginSecretStore::in_memory().unwrap();
    let id = retry_lease(&store, "https://hooks.example.com/hook").await;
    {
        let conn = store.conn.lock().await;
        conn.execute_batch(
            "CREATE TRIGGER audit_down BEFORE INSERT ON vault_audit
             BEGIN SELECT RAISE(ABORT, 'audit down'); END;",
        )
        .unwrap();
    }
    let actor = manager();
    // Refused whether or not fail-closed auditing is on.
    for fail_closed in [false, true] {
        crate::vault::audit_devices::set_fail_closed_for_test(Some(fail_closed));
        let forced = store
            .lease_force_revoke(&id, request(&actor, true, true))
            .await;
        crate::vault::audit_devices::set_fail_closed_for_test(None);
        let error = forced.unwrap_err();
        assert!(
            matches!(vault_error(&error), VaultError::AuditUnavailable),
            "fail closed {fail_closed}: {error:#}"
        );
        assert_untouched(&store, &id).await;
    }
    {
        let conn = store.conn.lock().await;
        conn.execute_batch("DROP TRIGGER audit_down").unwrap();
    }
    let lease = store
        .lease_force_revoke(&id, request(&actor, true, true))
        .await
        .unwrap();
    assert!(lease.revoked_at.is_some());
    assert_eq!(revoke_rows(&store).await.len(), 1);
}

#[tokio::test]
async fn the_role_can_be_deleted_after_its_retry_leases_are_force_revoked() {
    let store = PluginSecretStore::in_memory().unwrap();
    let id = retry_lease(&store, "https://hooks.example.com/hook").await;
    let system = AuditActor::system();
    let error = store.dynamic_delete_role("fr", &system).await.unwrap_err();
    assert!(
        matches!(vault_error(&error), VaultError::Conflict(_)),
        "{error:#}"
    );
    let actor = manager();
    store
        .lease_force_revoke(&id, request(&actor, true, true))
        .await
        .unwrap();
    store.dynamic_delete_role("fr", &system).await.unwrap();
    assert!(store.dynamic_list_roles().await.unwrap().is_empty());
    // The closed row stays as the record of what was forced.
    let conn = store.conn.lock().await;
    let kept: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM vault_leases WHERE id = ?1 AND revoked_at IS NOT NULL",
            params![id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(kept, 1);
}
