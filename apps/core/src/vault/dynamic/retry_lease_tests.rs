//! Retry leases: a credential whose lease was refused and whose immediate
//! revoke failed is kept for the reaper, and its role stays repairable.

use super::*;
use rusqlite::params;

/// `(revoke_attempts, next_revoke_at)` of a lease.
async fn backoff(store: &PluginSecretStore, id: &str) -> (i64, i64) {
    let conn = store.conn.lock().await;
    conn.query_row(
        "SELECT revoke_attempts, next_revoke_at FROM vault_leases WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

/// A webhook role named `flaky` pointing at `url`.
fn webhook(url: &str) -> ProviderConfig {
    serde_json::from_value(json!({
        "kind": "webhook", "url": url, "signingSecret": "webhook-signing-secret-0001"
    }))
    .unwrap()
}

/// A retry lease on `role`: the issue is refused fail-closed (no audit
/// device) and the provider refuses the immediate revoke.
async fn retry_lease(store: &PluginSecretStore, role: &str) -> String {
    crate::vault::audit_devices::set_fail_closed_for_test(Some(true));
    let issued = store
        .dynamic_issue(role, None, None, &AuditActor::system())
        .await;
    crate::vault::audit_devices::set_fail_closed_for_test(None);
    assert!(issued.is_err());
    let rows = store.lease_list(Some(role), false).await.unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    rows[0].id.clone()
}

/// The `details` of the newest audit row with `action`.
async fn last_audit(store: &PluginSecretStore, action: &str) -> Value {
    let conn = store.conn.lock().await;
    let details: String = conn
        .query_row(
            "SELECT details FROM vault_audit WHERE action = ?1 ORDER BY seq DESC LIMIT 1",
            params![action],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&details).unwrap()
}

/// A loopback webhook provider that issues on demand and refuses revokes
/// until `accept_revokes` is set. Returns its URL and the revokes it saw.
async fn flaky_webhook(
    accept_revokes: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> (String, std::sync::Arc<std::sync::Mutex<Vec<Value>>>) {
    use std::sync::atomic::Ordering;
    let revokes = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let seen = revokes.clone();
    let app = axum::Router::new().route(
        "/hook",
        axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let accept = accept_revokes.clone();
            let seen = seen.clone();
            async move {
                if body["action"] == "issue" {
                    return (
                        axum::http::StatusCode::OK,
                        axum::Json(json!({
                            "data": { "password": "issued-once" },
                            "revokeData": { "user": "flaky-user" }
                        })),
                    );
                }
                seen.lock().unwrap().push(body);
                if accept.load(Ordering::SeqCst) {
                    (axum::http::StatusCode::OK, axum::Json(json!({})))
                } else {
                    (axum::http::StatusCode::BAD_GATEWAY, axum::Json(json!({})))
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (url, revokes)
}

#[tokio::test]
async fn a_refused_credential_whose_revoke_fails_is_retried_by_the_reaper() {
    use crate::vault::machine::AuthMethod;
    use crate::vault::tokens::{with_request_context, RequestContext};
    use std::sync::atomic::{AtomicBool, Ordering};

    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let accept = std::sync::Arc::new(AtomicBool::new(false));
    let (url, revokes) = flaky_webhook(accept.clone()).await;
    let config: ProviderConfig = serde_json::from_value(json!({
        "kind": "webhook", "url": url, "signingSecret": "webhook-signing-secret-0001"
    }))
    .unwrap();
    store
        .dynamic_put_role("flaky", &config, Some(600), Some(600), &actor)
        .await
        .unwrap();

    // A request is admitted with ci's token, then the token is revoked
    // before the request records its lease, so the lease is refused.
    let identity = store
        .machine_create(
            "ci",
            AuthMethod::AppRole {
                role_id: String::new(),
            },
            vec![],
            Some(600),
            &actor,
        )
        .await
        .unwrap();
    let AuthMethod::AppRole { role_id } = identity.auth else {
        panic!("approle")
    };
    let (secret, _) = store
        .machine_issue_secret_id("ci", None, None, &actor)
        .await
        .unwrap();
    let token = store.approle_login(&role_id, &secret).await.unwrap();
    let context = RequestContext::new(None);
    with_request_context(context.clone(), async {
        store.token_lookup(&token.token).await.unwrap().unwrap();
    })
    .await;
    store
        .token_revoke_tree(&token.accessor, false, &actor)
        .await
        .unwrap();
    let refused = with_request_context(context, async {
        store
            .dynamic_issue("flaky", None, Some("machine:ci"), &actor)
            .await
    })
    .await;
    assert!(refused.is_err());

    // The immediate revoke failed, so an expired, token-less lease keeps the
    // credential on record for the reaper.
    assert_eq!(revokes.lock().unwrap().len(), 1);
    let pending = store.lease_list(Some("flaky"), false).await.unwrap();
    assert_eq!(pending.len(), 1, "{pending:?}");
    let pending = &pending[0];
    assert!(pending.revoked_at.is_none());
    assert_eq!(pending.issued_to.as_deref(), Some("machine:ci"));
    // The issue's audit row names the retry lease.
    assert_eq!(
        last_audit(&store, "dynamic.issue").await["retryLeaseId"],
        pending.id.as_str()
    );
    {
        let conn = store.conn.lock().await;
        let holder: Option<String> = conn
            .query_row(
                "SELECT token_accessor FROM vault_leases WHERE id = ?1",
                params![pending.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(holder, None);
    }

    // It cannot be renewed: it has already expired.
    let renewal = store.dynamic_renew(&pending.id, None, &actor).await;
    assert!(matches!(
        renewal.unwrap_err().downcast_ref::<VaultError>(),
        Some(VaultError::Conflict(_))
    ));
    // While the provider still refuses, the reaper fails, backs off and keeps it.
    let before = now_millis();
    assert_eq!(store.dynamic_reap().await.unwrap(), 0);
    assert!(store
        .lease_get(&pending.id)
        .await
        .unwrap()
        .revoked_at
        .is_none());
    // The backoff starts at 60 s and doubles per failure (capped at 1 h).
    let (attempts, next) = backoff(&store, &pending.id).await;
    assert_eq!(attempts, 1);
    assert!(
        (before + 60_000..=now_millis() + 60_000).contains(&next),
        "{next}"
    );
    {
        let conn = store.conn.lock().await;
        conn.execute("UPDATE vault_leases SET next_revoke_at = 0", [])
            .unwrap();
    }
    let before = now_millis();
    assert_eq!(store.dynamic_reap().await.unwrap(), 0);
    let (attempts, next) = backoff(&store, &pending.id).await;
    assert_eq!(attempts, 2);
    assert!(
        (before + 120_000..=now_millis() + 120_000).contains(&next),
        "{next}"
    );

    // Once the provider recovers (and the backoff has passed), the reaper
    // revokes it with the revoke data the provider issued.
    accept.store(true, Ordering::SeqCst);
    {
        let conn = store.conn.lock().await;
        conn.execute("UPDATE vault_leases SET next_revoke_at = 0", [])
            .unwrap();
    }
    assert_eq!(store.dynamic_reap().await.unwrap(), 1);
    assert!(store
        .lease_get(&pending.id)
        .await
        .unwrap()
        .revoked_at
        .is_some());
    let seen = revokes.lock().unwrap();
    assert_eq!(seen.len(), 4);
    assert!(seen
        .iter()
        .all(|body| body["revokeData"] == json!({ "user": "flaky-user" })));
}

#[tokio::test]
async fn a_fail_closed_refusal_whose_revoke_fails_leaves_one_retry_lease() {
    use std::sync::atomic::AtomicBool;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let (url, revokes) = flaky_webhook(std::sync::Arc::new(AtomicBool::new(false))).await;
    let config: ProviderConfig = serde_json::from_value(json!({
        "kind": "webhook", "url": url, "signingSecret": "webhook-signing-secret-0001"
    }))
    .unwrap();
    store
        .dynamic_put_role("flaky", &config, Some(600), Some(600), &actor)
        .await
        .unwrap();
    crate::vault::audit_devices::set_fail_closed_for_test(Some(true));
    let issued = store.dynamic_issue("flaky", None, None, &actor).await;
    crate::vault::audit_devices::set_fail_closed_for_test(None);
    assert!(matches!(
        issued.unwrap_err().downcast_ref::<VaultError>(),
        Some(VaultError::AuditUnavailable)
    ));
    assert_eq!(revokes.lock().unwrap().len(), 1);
    // Exactly one row, unrevoked: no second row claims the live credential
    // was revoked.
    let rows = store.lease_list(Some("flaky"), true).await.unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(rows[0].revoked_at.is_none());
}

#[tokio::test]
async fn a_role_with_only_retry_leases_can_be_repaired_and_the_reaper_then_revokes() {
    use std::sync::atomic::AtomicBool;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    // The configured target refuses every revoke (say, a wrong URL).
    let (broken, refused) = flaky_webhook(std::sync::Arc::new(AtomicBool::new(false))).await;
    store
        .dynamic_put_role("flaky", &webhook(&broken), Some(600), Some(600), &actor)
        .await
        .unwrap();
    let pending = retry_lease(&store, "flaky").await;
    assert_eq!(refused.lock().unwrap().len(), 1);

    // Deleting the role stays refused while the revoke is pending.
    let deleted = store.dynamic_delete_role("flaky", &actor).await;
    assert!(matches!(
        deleted.unwrap_err().downcast_ref::<VaultError>(),
        Some(VaultError::Conflict(_))
    ));

    // The operator repairs the config; the change is audited with the
    // number of pending revokes it now governs.
    let (fixed, accepted) = flaky_webhook(std::sync::Arc::new(AtomicBool::new(true))).await;
    store
        .dynamic_put_role("flaky", &webhook(&fixed), Some(600), Some(600), &actor)
        .await
        .unwrap();
    let put = last_audit(&store, "dynamic.role.put").await;
    assert_eq!(put["pendingRevokeLeases"], 1);
    // The old and new target are recorded with a repair over pending revokes.
    let origin = |url: &str| url.trim_end_matches("/hook").to_owned();
    assert_eq!(
        put["previousTarget"],
        json!({ "url": origin(&broken) }),
        "{put}"
    );
    assert_eq!(put["target"], json!({ "url": origin(&fixed) }), "{put}");

    // The next reaper pass revokes through the repaired config, recorded as a
    // cleanup, not an expiry.
    assert_eq!(store.dynamic_reap().await.unwrap(), 1);
    assert!(store
        .lease_get(&pending)
        .await
        .unwrap()
        .revoked_at
        .is_some());
    assert_eq!(accepted.lock().unwrap().len(), 1);
    let revoke = last_audit(&store, "lease.revoke").await;
    assert_eq!(revoke["leaseId"], pending.as_str());
    assert_eq!(revoke["reason"], "cleanup");
    store.dynamic_delete_role("flaky", &actor).await.unwrap();
}

#[tokio::test]
async fn a_role_with_a_handed_out_lease_still_refuses_a_config_change() {
    use std::sync::atomic::AtomicBool;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let (url, _) = flaky_webhook(std::sync::Arc::new(AtomicBool::new(false))).await;
    store
        .dynamic_put_role("flaky", &webhook(&url), Some(600), Some(600), &actor)
        .await
        .unwrap();
    retry_lease(&store, "flaky").await;
    // A credential that was handed out is live under the current config.
    store
        .dynamic_issue("flaky", None, None, &actor)
        .await
        .unwrap();
    let (other, _) = flaky_webhook(std::sync::Arc::new(AtomicBool::new(true))).await;
    let changed = store
        .dynamic_put_role("flaky", &webhook(&other), Some(600), Some(600), &actor)
        .await;
    assert!(matches!(
        changed.unwrap_err().downcast_ref::<VaultError>(),
        Some(VaultError::Conflict(_))
    ));
}

#[tokio::test]
async fn only_a_manager_may_repair_and_never_across_provider_kinds() {
    use super::target_guard::RoleWriter;
    use std::sync::atomic::AtomicBool;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let (url, _) = flaky_webhook(std::sync::Arc::new(AtomicBool::new(false))).await;
    store
        .dynamic_put_role("flaky", &webhook(&url), Some(600), Some(600), &actor)
        .await
        .unwrap();
    retry_lease(&store, "flaky").await;
    let conflict = |result: anyhow::Result<DynamicRoleInfo>, says: &str| {
        let error = result.unwrap_err();
        matches!(
            error.downcast_ref::<VaultError>(),
            Some(VaultError::Conflict(_))
        ) && error.to_string().contains(says)
    };

    // A delegate may not retarget it: the reaper would send the sealed
    // revoke data to a host the delegate chose and close the lease on a 2xx.
    let delegate = store
        .dynamic_put_role_as(
            "flaky",
            &webhook("https://exfil.example.com/hook"),
            (Some(600), Some(600)),
            RoleWriter::Delegate,
            &actor,
        )
        .await;
    assert!(conflict(delegate, "only a configuration manager"));

    // No one may switch the provider kind while revokes are pending.
    let random: ProviderConfig = serde_json::from_value(json!({
        "kind": "random", "length": 16, "charset": "hex"
    }))
    .unwrap();
    let kind = store
        .dynamic_put_role("flaky", &random, Some(600), Some(600), &actor)
        .await;
    assert!(conflict(kind, "provider kind cannot change"));

    // A manager may repair it with the same kind.
    let (fixed, _) = flaky_webhook(std::sync::Arc::new(AtomicBool::new(true))).await;
    store
        .dynamic_put_role("flaky", &webhook(&fixed), Some(600), Some(600), &actor)
        .await
        .unwrap();
}

#[tokio::test]
async fn a_database_from_before_pending_revoke_gains_the_column() {
    let store = PluginSecretStore::in_memory().unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute("ALTER TABLE vault_leases DROP COLUMN pending_revoke", [])
            .unwrap();
        crate::vault::leases::init_schema(&conn).unwrap();
        crate::vault::leases::init_schema(&conn).unwrap();
    }
    let id = store
        .lease_record_for_revoke(
            crate::vault::leases::NewLease {
                role: "any",
                provider: "random",
                issued_to: None,
                ttl_secs: 0,
                max_ttl_secs: 0,
                renewable: false,
                revoke_data: &Value::Null,
            },
            None,
        )
        .await
        .unwrap();
    assert!(store.lease_is_pending_revoke(&id).await.unwrap());
}

#[test]
fn a_webhook_summary_is_its_origin_only() {
    let config =
        webhook("https://user:hunter2@hooks.example.com:8443/hook/PATHTOKEN?token=QUERYTOKEN#frag");
    let summary = config.summary().to_string();
    assert_eq!(
        config.summary(),
        json!({ "url": "https://hooks.example.com:8443" })
    );
    for secret in ["hunter2", "PATHTOKEN", "QUERYTOKEN", "frag", "user"] {
        assert!(!summary.contains(secret), "{summary}");
    }
}
