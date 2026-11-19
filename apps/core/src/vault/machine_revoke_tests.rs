//! Disabling or deleting a machine identity revokes everything its tokens
//! hold, through the same revoke tree as an explicit revoke, and fails
//! closed when a provider refuses a lease.

use super::*;
use crate::vault::dynamic::ProviderConfig;
use crate::vault::leases::NewLease;
use crate::vault::tokens::TokenRequest;

struct Fixture {
    store: PluginSecretStore,
    identity_id: String,
    role_id: String,
    parent: IssuedToken,
    child: IssuedToken,
    lease: String,
}

fn actor() -> AuditActor {
    AuditActor::system()
}

/// An AppRole identity with a login token, a child of that token, a
/// cubbyhole entry on the parent, and a dynamic lease held by the child.
async fn fixture() -> Fixture {
    let store = PluginSecretStore::in_memory().unwrap();
    let identity = store
        .machine_create(
            "ci",
            AuthMethod::AppRole {
                role_id: String::new(),
            },
            vec!["read".into()],
            Some(600),
            &actor(),
        )
        .await
        .unwrap();
    let AuthMethod::AppRole { role_id } = identity.auth.clone() else {
        panic!("approle")
    };
    let (secret, _) = store
        .machine_issue_secret_id("ci", None, None, &actor())
        .await
        .unwrap();
    let parent = store.approle_login(&role_id, &secret).await.unwrap();
    let child = store
        .token_create_child(
            &parent.accessor,
            &parent.policies,
            &identity.id,
            TokenRequest::default(),
            &actor(),
        )
        .await
        .unwrap();
    store
        .cubbyhole_put(&parent.accessor, "note", &json!("kept"), &actor())
        .await
        .unwrap();
    store
        .dynamic_put_role(
            "rnd",
            &ProviderConfig::Random {
                length: 16,
                charset: crate::plugin_secrets::kv::Charset::Hex,
                field: None,
            },
            Some(600),
            Some(600),
            &actor(),
        )
        .await
        .unwrap();
    let issued = store
        .dynamic_issue("rnd", None, Some("machine:ci"), &actor())
        .await
        .unwrap();
    attach(&store, &issued.lease.id, &child.accessor).await;
    Fixture {
        store,
        identity_id: identity.id,
        role_id,
        parent,
        child,
        lease: issued.lease.id,
    }
}

async fn attach(store: &PluginSecretStore, lease: &str, accessor: &str) {
    let conn = store.conn.lock().await;
    conn.execute(
        "UPDATE vault_leases SET token_accessor = ?1 WHERE id = ?2",
        params![accessor, lease],
    )
    .unwrap();
}

/// A lease whose role is gone: every revocation at the provider fails.
async fn failing_lease(store: &PluginSecretStore, accessor: &str) -> String {
    let lease = store
        .lease_create(
            NewLease {
                role: "gone",
                provider: "random",
                issued_to: None,
                ttl_secs: 600,
                max_ttl_secs: 600,
                renewable: false,
                revoke_data: &Value::Null,
            },
            &actor(),
        )
        .await
        .unwrap();
    attach(store, &lease.id, accessor).await;
    lease.id
}

async fn assert_cut_off(fixture: &Fixture) {
    let store = &fixture.store;
    assert!(store
        .token_lookup(&fixture.parent.token)
        .await
        .unwrap()
        .is_none());
    assert!(store
        .token_lookup(&fixture.child.token)
        .await
        .unwrap()
        .is_none());
    let lease = store.lease_get(&fixture.lease).await.unwrap();
    assert!(lease.revoked_at.is_some(), "the child's lease is revoked");
    assert!(store
        .cubbyhole_list(&fixture.parent.accessor)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn disabling_revokes_tokens_children_leases_and_cubbyholes() {
    let fixture = fixture().await;
    let disabled = fixture
        .store
        .machine_update("ci", None, None, Some(true), &actor())
        .await
        .unwrap();
    assert!(disabled.disabled);
    assert_cut_off(&fixture).await;
}

#[tokio::test]
async fn deleting_revokes_leases_and_cubbyholes_before_removing_the_identity() {
    let fixture = fixture().await;
    fixture.store.machine_delete("ci", &actor()).await.unwrap();
    assert!(fixture.store.machine_get("ci").await.is_err());
    assert_cut_off(&fixture).await;
}

#[tokio::test]
async fn disabling_again_revokes_leases_an_earlier_cut_off_left_live() {
    let fixture = fixture().await;
    // What the old disable did: mark tokens revoked and nothing else.
    {
        let conn = fixture.store.conn.lock().await;
        conn.execute(
            "UPDATE vault_machine_identities SET disabled = 1 WHERE id = ?1",
            params![fixture.identity_id],
        )
        .unwrap();
        conn.execute(
            "UPDATE vault_tokens SET revoked_at = 1 WHERE identity_id = ?1",
            params![fixture.identity_id],
        )
        .unwrap();
    }
    assert!(fixture
        .store
        .lease_get(&fixture.lease)
        .await
        .unwrap()
        .revoked_at
        .is_none());
    let revocation = fixture
        .store
        .machine_revoke_tokens(&fixture.identity_id, &actor())
        .await
        .unwrap();
    assert_eq!(revocation.leases_revoked, 1);
    assert_eq!(revocation.tokens, 2);
    assert!(revocation.leases_left.is_empty());
    assert_cut_off(&fixture).await;
}

#[tokio::test]
async fn a_lease_the_provider_refuses_fails_closed_and_is_named() {
    let fixture = fixture().await;
    let stuck = failing_lease(&fixture.store, &fixture.child.accessor).await;
    let error = fixture
        .store
        .machine_update("ci", None, None, Some(true), &actor())
        .await
        .unwrap_err();
    let message = error.to_string();
    assert!(message.starts_with("vault_conflict"), "{message}");
    assert!(message.contains(&stuck), "{message}");
    assert!(!message.contains(&fixture.lease), "{message}");
    // Disabled either way, and every other credential is gone.
    assert!(fixture.store.machine_get("ci").await.unwrap().disabled);
    assert_cut_off(&fixture).await;

    // Delete refuses too, and keeps the identity so it can be retried.
    let error = fixture
        .store
        .machine_delete("ci", &actor())
        .await
        .unwrap_err();
    assert!(error.to_string().contains(&stuck));
    let kept = fixture.store.machine_get("ci").await.unwrap();
    assert!(kept.disabled);
}

#[tokio::test]
async fn a_disabled_identity_gets_no_secret_id_and_cannot_log_in_with_an_old_one() {
    let fixture = fixture().await;
    let store = &fixture.store;
    let (old_secret, _) = store
        .machine_issue_secret_id("ci", None, None, &actor())
        .await
        .unwrap();
    store
        .machine_update("ci", None, None, Some(true), &actor())
        .await
        .unwrap();
    let refused = store
        .machine_issue_secret_id("ci", None, None, &actor())
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("identity is disabled"));
    assert!(store
        .approle_login(&fixture.role_id, &old_secret)
        .await
        .is_err());
    // Enabling again lets the kept secret id log in; tokens stay dead.
    store
        .machine_update("ci", None, None, Some(false), &actor())
        .await
        .unwrap();
    assert!(store
        .approle_login(&fixture.role_id, &old_secret)
        .await
        .is_ok());
    assert!(store
        .token_lookup(&fixture.parent.token)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn the_prune_keeps_a_revoked_token_that_still_holds_a_live_lease() {
    let fixture = fixture().await;
    let stuck = failing_lease(&fixture.store, &fixture.child.accessor).await;
    assert!(fixture
        .store
        .machine_update("ci", None, None, Some(true), &actor())
        .await
        .is_err());
    // Two days later the prune runs.
    {
        let conn = fixture.store.conn.lock().await;
        conn.execute(
            "UPDATE vault_tokens SET revoked_at = 1, expires_at = 1 WHERE identity_id = ?1",
            params![fixture.identity_id],
        )
        .unwrap();
    }
    fixture.store.machine_prune().await.unwrap();
    // The retry still finds the stuck lease and fails closed.
    let error = fixture
        .store
        .machine_delete("ci", &actor())
        .await
        .unwrap_err();
    assert!(error.to_string().contains(&stuck), "{error}");
    assert!(fixture.store.machine_get("ci").await.is_ok());
}

#[tokio::test]
async fn a_login_that_read_the_identity_before_a_disable_gets_no_token() {
    let fixture = fixture().await;
    let store = &fixture.store;
    // What a JWT, cert, AWS or Kubernetes login holds while its credential
    // is checked over the network: the identity as read before the disable.
    let before = store.machine_get("ci").await.unwrap();
    store
        .machine_update("ci", None, None, Some(true), &actor())
        .await
        .unwrap();
    let conn = store.conn.lock().await;
    let refused = store.issue_token_locked(&conn, &before, None).unwrap_err();
    assert!(refused.to_string().contains("identity is disabled"));
}

#[tokio::test]
async fn a_lease_recorded_after_the_revoke_tree_stops_the_delete() {
    // `machine_delete` disables (running the revoke tree), releases the
    // lock, then deletes. A lease recorded on one of its tokens in that gap
    // would lose its token rows and never be revoked, so the delete step
    // looks again and fails closed with its id.
    let fixture = fixture().await;
    let identity = fixture
        .store
        .machine_update("ci", None, None, Some(true), &actor())
        .await
        .unwrap();
    let late = fixture
        .store
        .dynamic_issue("rnd", None, Some("machine:ci"), &actor())
        .await
        .unwrap();
    attach(&fixture.store, &late.lease.id, &fixture.parent.accessor).await;
    let error = {
        let conn = fixture.store.conn.lock().await;
        fixture
            .store
            .machine_delete_rows_locked(&conn, &identity, &actor())
            .unwrap_err()
    };
    let message = error.to_string();
    assert!(message.starts_with("vault_conflict"), "{message}");
    assert!(message.contains(&late.lease.id), "{message}");
    // The refusal is audited, outside the rolled-back delete transaction.
    let refusals: i64 = {
        let conn = fixture.store.conn.lock().await;
        conn.query_row(
            "SELECT COUNT(*) FROM vault_audit
             WHERE action = 'machine.delete' AND outcome = 'error' AND details LIKE ?1",
            params![format!("%{}%", late.lease.id)],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(refusals, 1);
    // Nothing was deleted, so a retried delete can still revoke the lease.
    assert!(fixture.store.machine_get("ci").await.unwrap().disabled);
    fixture
        .store
        .machine_delete("ci", &actor())
        .await
        .unwrap();
    assert!(fixture
        .store
        .lease_get(&late.lease.id)
        .await
        .unwrap()
        .revoked_at
        .is_some());
}
