//! A role rewritten while one of its credentials is being issued: the lease
//! is refused, and a retry lease stays bound to the role as issued.

use super::target_guard::RoleWriter;
use super::*;
use std::sync::{Arc, Mutex};

/// A webhook provider whose first issue call pauses until released (so the
/// test can rewrite the role mid-issue), and that refuses revokes while
/// `refuse` holds. Returns its URL, the pause handles and the revokes seen.
struct Issuer {
    url: String,
    entered: tokio::sync::oneshot::Receiver<()>,
    release: tokio::sync::oneshot::Sender<()>,
    revokes: Arc<Mutex<Vec<Value>>>,
    refuse: Arc<std::sync::atomic::AtomicBool>,
}

async fn issuer(refuse: bool) -> Issuer {
    use std::sync::atomic::{AtomicBool, Ordering};
    let (entered_tx, entered) = tokio::sync::oneshot::channel::<()>();
    let (release, release_rx) = tokio::sync::oneshot::channel::<()>();
    let gate = Arc::new(Mutex::new(Some((entered_tx, release_rx))));
    let revokes = Arc::new(Mutex::new(Vec::<Value>::new()));
    let refuse = Arc::new(AtomicBool::new(refuse));
    let (seen, refusing) = (revokes.clone(), refuse.clone());
    let app = axum::Router::new().route(
        "/hook",
        axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let (gate, seen, refusing) = (gate.clone(), seen.clone(), refusing.clone());
            async move {
                if body["action"] == "issue" {
                    let pair = gate.lock().unwrap().take();
                    if let Some((entered, release)) = pair {
                        let _ = entered.send(());
                        let _ = release.await;
                    }
                    return (
                        axum::http::StatusCode::OK,
                        axum::Json(json!({
                            "data": { "password": "p" },
                            "revokeData": { "user": "internal-db-user" }
                        })),
                    );
                }
                seen.lock().unwrap().push(body);
                if refusing.load(Ordering::SeqCst) {
                    (axum::http::StatusCode::BAD_GATEWAY, axum::Json(json!({})))
                } else {
                    (axum::http::StatusCode::OK, axum::Json(json!({})))
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    Issuer {
        url,
        entered,
        release,
        revokes,
        refuse,
    }
}

fn webhook(url: &str) -> ProviderConfig {
    serde_json::from_value(json!({
        "kind": "webhook", "url": url, "signingSecret": "webhook-signing-secret-0001"
    }))
    .unwrap()
}

#[tokio::test]
async fn a_retry_lease_is_never_revoked_through_a_delegates_rewrite() {
    use std::sync::atomic::Ordering;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    // The issuer refuses revokes at first, so the refused lease becomes a
    // retry lease.
    let issuer = issuer(true).await;
    store
        .dynamic_put_role("raced", &webhook(&issuer.url), Some(600), Some(600), &actor)
        .await
        .unwrap();
    let (entered, release) = (issuer.entered, issuer.release);
    let rewrite = async {
        entered.await.unwrap();
        store
            .dynamic_put_role_as(
                "raced",
                &webhook("https://attacker.example.com/hook"),
                (Some(600), Some(600)),
                RoleWriter::Delegate,
                &actor,
            )
            .await
            .unwrap();
        release.send(()).unwrap();
    };
    let (issued, ()) = tokio::join!(store.dynamic_issue("raced", None, None, &actor), rewrite);
    assert!(issued.is_err());
    let rows = store.lease_list(Some("raced"), false).await.unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    let retry = rows[0].id.clone();

    // The reaper must not send the revoke data to the delegate's target: it
    // refuses (audited) without calling it, and keeps the lease.
    {
        let conn = store.conn.lock().await;
        conn.execute("UPDATE vault_leases SET next_revoke_at = 0", [])
            .unwrap();
    }
    assert_eq!(store.dynamic_reap().await.unwrap(), 0);
    assert!(store.lease_get(&retry).await.unwrap().revoked_at.is_none());
    let error = {
        let conn = store.conn.lock().await;
        conn.query_row(
            "SELECT details FROM vault_audit WHERE action = 'lease.revoke' AND outcome = 'error'
             ORDER BY seq DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap()
    };
    // The binding's own refusal, not a failed call to the delegate's target.
    let error: Value = serde_json::from_str(&error).unwrap();
    assert_eq!(error["code"], "retry_lease_role_changed", "{error}");
    assert_eq!(error["retryLeaseId"], retry.as_str());

    // A configuration manager repairs it back to the issuer (a changed
    // config, so an explicit rebind), which now accepts; the reaper revokes
    // there.
    issuer.refuse.store(false, Ordering::SeqCst);
    store
        .dynamic_put_role("raced", &webhook(&issuer.url), Some(600), Some(600), &actor)
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute("UPDATE vault_leases SET next_revoke_at = 0", [])
            .unwrap();
    }
    assert_eq!(store.dynamic_reap().await.unwrap(), 1);
    let seen = issuer.revokes.lock().unwrap();
    assert!(seen
        .iter()
        .all(|body| body["revokeData"] == json!({ "user": "internal-db-user" })));
    assert!(!seen.is_empty());
}

#[tokio::test]
async fn a_role_deleted_and_recreated_during_issue_records_no_lease() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let issuer = issuer(false).await;
    store
        .dynamic_put_role("raced", &webhook(&issuer.url), Some(600), Some(600), &actor)
        .await
        .unwrap();
    let (entered, release) = (issuer.entered, issuer.release);
    let recreate = async {
        entered.await.unwrap();
        store.dynamic_delete_role("raced", &actor).await.unwrap();
        // Same name, same target: still a different role.
        store
            .dynamic_put_role("raced", &webhook(&issuer.url), Some(600), Some(600), &actor)
            .await
            .unwrap();
        release.send(()).unwrap();
    };
    let (issued, ()) = tokio::join!(store.dynamic_issue("raced", None, None, &actor), recreate);
    let error = issued.expect_err("the role changed during issue");
    assert!(
        matches!(error.downcast_ref::<VaultError>(), Some(VaultError::Conflict(message))
            if message.ends_with("changed while its credential was being issued")),
        "{error:#}"
    );
    assert!(store
        .lease_list(Some("raced"), true)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(issuer.revokes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_role_rewritten_during_issue_records_no_lease_and_revokes_at_the_issuer() {
    use super::target_guard::RoleWriter;
    // The issuing provider pauses inside its issue call until released, so
    // the test can rewrite the role while the issue is in flight.
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let gate = std::sync::Arc::new(std::sync::Mutex::new(Some((entered_tx, release_rx))));
    let revokes = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let seen = revokes.clone();
    let app = axum::Router::new().route(
        "/hook",
        axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
            let gate = gate.clone();
            let seen = seen.clone();
            async move {
                if body["action"] == "issue" {
                    let pair = gate.lock().unwrap().take();
                    if let Some((entered, release)) = pair {
                        let _ = entered.send(());
                        let _ = release.await;
                    }
                    return axum::Json(json!({
                        "data": { "password": "issued-once" },
                        "revokeData": { "user": "internal-db-user" }
                    }));
                }
                seen.lock().unwrap().push(body);
                axum::Json(json!({}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}/hook", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });

    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    store
        .dynamic_put_role("raced", &webhook(&issuer), Some(600), Some(600), &actor)
        .await
        .unwrap();
    let issue = store.dynamic_issue("raced", None, None, &actor);
    let rewrite = async {
        entered_rx.await.unwrap();
        // 0 live, 0 pending: a delegate's retarget is allowed right now.
        store
            .dynamic_put_role_as(
                "raced",
                &webhook("https://attacker.example.com/hook"),
                (Some(600), Some(600)),
                RoleWriter::Delegate,
                &actor,
            )
            .await
            .unwrap();
        release_tx.send(()).unwrap();
    };
    let (issued, ()) = tokio::join!(issue, rewrite);

    // No lease was recorded under the rewritten role, and the credential was
    // revoked at the provider that issued it.
    let error = issued.expect_err("a lease under a rewritten role must be refused");
    assert!(
        matches!(error.downcast_ref::<VaultError>(), Some(VaultError::Conflict(message))
            if message.ends_with("changed while its credential was being issued")),
        "{error:#}"
    );
    assert!(store
        .lease_list(Some("raced"), true)
        .await
        .unwrap()
        .is_empty());
    let seen = revokes.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0]["revokeData"], json!({ "user": "internal-db-user" }));
}

#[tokio::test]
async fn only_a_real_change_moves_a_roles_version() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let config = webhook("https://hooks.example.com/hook");
    store
        .dynamic_put_role_as("versioned", &config, (Some(600), Some(600)), RoleWriter::Delegate, &actor)
        .await
        .unwrap();
    let version = || async {
        let conn = store.conn.lock().await;
        roles::role_version_locked(&conn, "versioned").unwrap().unwrap()
    };
    let v0 = version().await;
    // A keyring rewrap reseals every role: not a change.
    store.rewrap_all(&actor).await.unwrap();
    assert_eq!(version().await, v0);
    // The same delegate saving the same config again: not a change either,
    // so it cannot be used to strand a pending revoke.
    store
        .dynamic_put_role_as("versioned", &config, (Some(900), Some(900)), RoleWriter::Delegate, &actor)
        .await
        .unwrap();
    assert_eq!(version().await, v0);
    // A new target is.
    store
        .dynamic_put_role_as(
            "versioned",
            &webhook("https://other.example.com/hook"),
            (Some(600), Some(600)),
            RoleWriter::Delegate,
            &actor,
        )
        .await
        .unwrap();
    assert_ne!(version().await, v0);
}
