//! A retry lease whose role changed after it was issued stays refused until a
//! configuration manager rebinds it explicitly: a save that changes the
//! provider config, or one that acknowledges the current config. Each case
//! runs against a loopback target that must see no revoke while refused.

use super::target_guard::RoleWriter;
use super::*;
use rusqlite::params;
use std::sync::{Arc, Mutex};

/// A loopback webhook that accepts every call. Returns its URL and the
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

/// Role `rb` pointing at `url`, written by `writer`, with one retry lease
/// bound to `issued` (a version the role no longer has, or `None` for a lease
/// recorded before binding existed). Returns the lease id.
async fn stale_retry_lease(
    store: &PluginSecretStore,
    url: &str,
    writer: &str,
    issued: Option<&str>,
) -> String {
    store
        .dynamic_put_role("rb", &webhook(url), Some(600), Some(600), &AuditActor::system())
        .await
        .unwrap();
    let id = store
        .lease_record_for_revoke(
            crate::vault::leases::NewLease {
                role: "rb",
                provider: "webhook",
                issued_to: None,
                ttl_secs: 0,
                max_ttl_secs: 0,
                renewable: false,
                revoke_data: &json!({ "user": "u" }),
            },
            issued,
        )
        .await
        .unwrap();
    // Stand in for a delegated admin's rewrite to `url` after the issue (a
    // delegate cannot point a role at loopback, so the row is stamped here).
    let conn = store.conn.lock().await;
    conn.execute(
        "UPDATE vault_dynamic_roles SET writer = ?1 WHERE name = 'rb'",
        params![writer],
    )
    .unwrap();
    id
}

/// Run the reaper on every pending lease now.
async fn reap(store: &PluginSecretStore) -> usize {
    {
        let conn = store.conn.lock().await;
        conn.execute("UPDATE vault_leases SET next_revoke_at = 0", [])
            .unwrap();
    }
    store.dynamic_reap().await.unwrap()
}

async fn audits(store: &PluginSecretStore, action: &str) -> Vec<Value> {
    let conn = store.conn.lock().await;
    let mut stmt = conn
        .prepare("SELECT details FROM vault_audit WHERE action = ?1 ORDER BY seq")
        .unwrap();
    stmt.query_map(params![action], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|details| serde_json::from_str(&details.unwrap()).unwrap())
        .collect()
}

/// The refusal, as the reaper and a direct revoke see it.
async fn assert_refused(store: &PluginSecretStore, id: &str, seen: &Mutex<Vec<Value>>) {
    assert_eq!(reap(store).await, 0);
    let error = store
        .dynamic_revoke(id, &AuditActor::system())
        .await
        .unwrap_err();
    assert!(
        matches!(error.downcast_ref::<VaultError>(), Some(VaultError::Conflict(message))
            if message.contains("a configuration manager must rebind it")),
        "{error:#}"
    );
    assert!(seen.lock().unwrap().is_empty(), "the target saw a revoke");
    let lease = store.lease_get(id).await.unwrap();
    assert!(lease.revoked_at.is_none() && lease.pending_revoke);
    let blocked = audits(store, "lease.revoke").await;
    let last = blocked.last().unwrap();
    assert_eq!(last["reason"], "blocked");
    assert_eq!(last["code"], "retry_lease_role_changed");
    assert_eq!(last["retryLeaseId"], id);
}

#[tokio::test]
async fn a_refused_retry_lease_stays_visible() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (url, seen) = target().await;
    let id = stale_retry_lease(&store, &url, "delegate", Some("gen_old:manager")).await;
    assert_refused(&store, &id, &seen).await;
    // Expired, yet listed by default, flagged, and counted on its role.
    let listed = store.lease_list(Some("rb"), false).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert!(listed[0].pending_revoke);
    let (info, _) = store.dynamic_role("rb").await.unwrap();
    assert_eq!(info.pending_revoke_leases, 1);
}

#[tokio::test]
async fn a_managers_identical_save_does_not_rebind() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (url, seen) = target().await;
    let id = stale_retry_lease(&store, &url, "delegate", Some("gen_old:manager")).await;
    store
        .dynamic_put_role("rb", &webhook(&url), Some(600), Some(600), &AuditActor::system())
        .await
        .unwrap();
    assert_refused(&store, &id, &seen).await;
    assert!(audits(&store, "dynamic.role.rebind").await.is_empty());
}

#[tokio::test]
async fn a_delegates_acknowledgement_does_not_rebind() {
    let store = PluginSecretStore::in_memory().unwrap();
    // A public target, which a delegate may save (a delegate cannot save a
    // loopback one); nothing here connects to it.
    let url = "https://hooks.example.com/hook";
    let id = stale_retry_lease(&store, url, "delegate", Some("gen_old:manager")).await;
    let error = store
        .dynamic_put_role_with(
            "rb",
            &webhook(url),
            (Some(600), Some(600)),
            RoleWriter::Delegate,
            true,
            &AuditActor::system(),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error.downcast_ref::<VaultError>(), Some(VaultError::Denied(_))),
        "{error:#}"
    );
    assert!(audits(&store, "dynamic.role.rebind").await.is_empty());
    assert_eq!(
        store.lease_issued_role_version(&id).await.unwrap().as_deref(),
        Some("gen_old:manager")
    );
}

#[tokio::test]
async fn a_managers_changed_save_rebinds_and_is_audited() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (decoy, decoy_seen) = target().await;
    let (issuer, issuer_seen) = target().await;
    let id = stale_retry_lease(&store, &decoy, "delegate", Some("gen_old:manager")).await;
    store
        .dynamic_put_role("rb", &webhook(&issuer), Some(600), Some(600), &AuditActor::system())
        .await
        .unwrap();
    assert_eq!(reap(&store).await, 1);
    assert!(decoy_seen.lock().unwrap().is_empty());
    assert_eq!(issuer_seen.lock().unwrap().len(), 1);
    assert!(store.lease_get(&id).await.unwrap().revoked_at.is_some());
    let rebinds = audits(&store, "dynamic.role.rebind").await;
    assert_eq!(rebinds.len(), 1, "{rebinds:?}");
    assert_eq!(rebinds[0]["reboundRetryLeases"], 1);
    assert_eq!(rebinds[0]["acknowledged"], false);
    assert_eq!(rebinds[0]["configChanged"], true);
    assert_eq!(rebinds[0]["previousTarget"]["url"], webhook::url_origin(&decoy));
    assert_eq!(rebinds[0]["target"]["url"], webhook::url_origin(&issuer));
}

#[tokio::test]
async fn an_acknowledged_identical_save_rebinds_and_is_audited() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (url, seen) = target().await;
    let id = stale_retry_lease(&store, &url, "delegate", Some("gen_old:manager")).await;
    store
        .dynamic_put_role_with(
            "rb",
            &webhook(&url),
            (Some(600), Some(600)),
            RoleWriter::Manager,
            true,
            &AuditActor::system(),
        )
        .await
        .unwrap();
    assert_eq!(reap(&store).await, 1);
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert!(store.lease_get(&id).await.unwrap().revoked_at.is_some());
    let rebinds = audits(&store, "dynamic.role.rebind").await;
    assert_eq!(rebinds.len(), 1, "{rebinds:?}");
    assert_eq!(rebinds[0]["reboundRetryLeases"], 1);
    assert_eq!(rebinds[0]["acknowledged"], true);
    assert_eq!(rebinds[0]["configChanged"], false);
    // This save replaced no target, so none is claimed as the previous one.
    assert_eq!(rebinds[0]["previousTarget"], Value::Null);
    assert_eq!(rebinds[0]["target"]["url"], webhook::url_origin(&url));
}

#[tokio::test]
async fn an_unbound_retry_lease_is_refused_until_a_manager_confirms_its_role() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (url, seen) = target().await;
    let id = stale_retry_lease(&store, &url, "delegate", None).await;
    assert_refused(&store, &id, &seen).await;
    // A manager's identical save re-stamps the writer but is no rebind.
    store
        .dynamic_put_role("rb", &webhook(&url), Some(600), Some(600), &AuditActor::system())
        .await
        .unwrap();
    assert_refused(&store, &id, &seen).await;
    store
        .dynamic_put_role_with(
            "rb",
            &webhook(&url),
            (Some(600), Some(600)),
            RoleWriter::Manager,
            true,
            &AuditActor::system(),
        )
        .await
        .unwrap();
    assert_eq!(reap(&store).await, 1);
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(audits(&store, "dynamic.role.rebind").await.len(), 1);
}

#[tokio::test]
async fn the_writer_is_part_of_the_bound_version() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (url, seen) = target().await;
    store
        .dynamic_put_role("rb", &webhook(&url), Some(600), Some(600), &AuditActor::system())
        .await
        .unwrap();
    let version = {
        let conn = store.conn.lock().await;
        role_version_locked(&conn, "rb").unwrap().unwrap()
    };
    // Bound to the role's real version, then only the writer changes (the
    // generation stays): refused.
    let id = stale_retry_lease(&store, &url, "delegate", Some(&version)).await;
    assert_refused(&store, &id, &seen).await;
    // The same writer again matches, and the reaper revokes.
    {
        let conn = store.conn.lock().await;
        conn.execute("UPDATE vault_dynamic_roles SET writer = 'manager'", [])
            .unwrap();
    }
    assert_eq!(reap(&store).await, 1);
    assert_eq!(seen.lock().unwrap().len(), 1);
}

/// The role row, as `(provider, summary, writer, generation)`.
async fn role_row(store: &PluginSecretStore) -> (String, String, String, String) {
    let conn = store.conn.lock().await;
    conn.query_row(
        "SELECT provider, summary, writer, generation FROM vault_dynamic_roles WHERE name = 'rb'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .unwrap()
}

#[tokio::test]
async fn a_failed_rebind_rolls_back_the_role_write_and_its_audit_rows() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (decoy, _) = target().await;
    let (issuer, _) = target().await;
    let id = stale_retry_lease(&store, &decoy, "delegate", Some("gen_old:manager")).await;
    let before = role_row(&store).await;
    let puts_before = audits(&store, "dynamic.role.put").await.len();
    {
        let conn = store.conn.lock().await;
        conn.execute_batch(
            "CREATE TRIGGER fail_rebind BEFORE UPDATE OF issued_role_version ON vault_leases
             BEGIN SELECT RAISE(ABORT, 'injected rebind failure'); END;",
        )
        .unwrap();
    }
    // A manager's changed save, so it must rebind; the rebind fails.
    let error = store
        .dynamic_put_role("rb", &webhook(&issuer), Some(600), Some(600), &AuditActor::system())
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("injected rebind failure"), "{error:#}");
    assert_eq!(role_row(&store).await, before);
    assert_eq!(audits(&store, "dynamic.role.put").await.len(), puts_before);
    assert!(audits(&store, "dynamic.role.rebind").await.is_empty());
    assert_eq!(
        store.lease_issued_role_version(&id).await.unwrap().as_deref(),
        Some("gen_old:manager")
    );
}
