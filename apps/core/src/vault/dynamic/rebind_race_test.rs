//! The reaper compares a retry lease's bound version with the version read
//! under the same lock as the config it revokes through, so a role change
//! between the binding check and the target read cannot redirect the revoke.

use super::*;
use rusqlite::params;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

type Gate = (String, oneshot::Sender<()>, oneshot::Receiver<()>);

/// A pause armed for one role: the revoke path stops there before reading
/// the role, signals `entered`, and waits for `release`.
static PAUSE: Mutex<Option<Gate>> = Mutex::new(None);

/// Called by [`PluginSecretStore::revoke_target`] (tests only).
pub(super) async fn pause_before_role_read(role: &str) {
    let gate = {
        let mut armed = PAUSE.lock().unwrap();
        match armed.as_ref() {
            Some((name, _, _)) if name == role => armed.take(),
            _ => None,
        }
    };
    if let Some((_, entered, release)) = gate {
        let _ = entered.send(());
        let _ = release.await;
    }
}

/// Arm the pause for `role`; returns (entered, release).
fn arm(role: &str) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
    let (entered_tx, entered) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    *PAUSE.lock().unwrap() = Some((role.to_owned(), entered_tx, release_rx));
    (entered, release)
}

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

#[tokio::test]
async fn a_role_change_between_the_check_and_the_target_read_is_refused() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let role = "rb-race";
    let (url, seen) = target().await;
    let config: ProviderConfig = serde_json::from_value(json!({
        "kind": "webhook", "url": url, "signingSecret": "webhook-signing-secret-0001"
    }))
    .unwrap();
    store
        .dynamic_put_role(role, &config, Some(600), Some(600), &actor)
        .await
        .unwrap();
    let version = {
        let conn = store.conn.lock().await;
        role_version_locked(&conn, role).unwrap()
    };
    // Bound to the role as it is now, so the binding check alone passes.
    let id = store
        .lease_record_for_revoke(
            crate::vault::leases::NewLease {
                role,
                provider: "webhook",
                issued_to: None,
                ttl_secs: 0,
                max_ttl_secs: 0,
                renewable: false,
                revoke_data: &json!({ "user": "u" }),
            },
            version.as_deref(),
        )
        .await
        .unwrap();
    let (entered, release) = arm(role);
    let change = async {
        entered.await.unwrap();
        // The role changes while the revoke is between its binding check and
        // its target read. Its generation moves as a rewrite's would; the
        // writer stays a manager's, so the loopback target stays reachable
        // and a revoke sent there would be seen.
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_dynamic_roles SET generation = 'gen_rewritten' WHERE name = ?1",
            params![role],
        )
        .unwrap();
        drop(conn);
        release.send(()).unwrap();
    };
    let (revoked, ()) = tokio::join!(store.dynamic_revoke(&id, &actor), change);
    let error = revoked.unwrap_err();
    assert!(
        matches!(error.downcast_ref::<VaultError>(), Some(VaultError::Conflict(_))),
        "{error:#}"
    );
    assert!(seen.lock().unwrap().is_empty(), "the revoke reached the target");
    assert!(store.lease_get(&id).await.unwrap().revoked_at.is_none());
}
