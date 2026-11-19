//! Lease attribution: a lease records the token that requested it (`schema`).

use super::config::*;
use super::context::*;
use super::tests::{approle, login};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;

#[tokio::test]
async fn token_revocation_revokes_attached_leases() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let (_, role_id) = approle(&store, "leasy", &[]).await;
    let token = login(&store, "leasy", &role_id).await;
    store
        .dynamic_put_role(
            "rnd",
            &crate::vault::dynamic::ProviderConfig::Random {
                length: 16,
                charset: crate::plugin_secrets::kv::Charset::Hex,
                field: None,
            },
            Some(600),
            Some(600),
            &actor,
        )
        .await
        .unwrap();
    let context = RequestContext::new(None);
    let credential = with_request_context(context.clone(), async {
        store.token_lookup(&token.token).await.unwrap().unwrap();
        store
            .dynamic_issue("rnd", None, Some("machine:x"), &actor)
            .await
            .unwrap()
    })
    .await;
    assert_eq!(context.token_accessor(), Some(token.accessor.clone()));
    let report = store
        .token_revoke_tree(&token.accessor, false, &actor)
        .await
        .unwrap();
    assert_eq!(report.leases_revoked, 1);
    assert!(store
        .lease_get(&credential.lease.id)
        .await
        .unwrap()
        .revoked_at
        .is_some());
}

/// What happens between a request's `token_lookup` and the lease it records.
enum CutOff {
    Revoke,
    Disable,
    Delete,
}

/// A request is admitted with `ci`'s token, then (before it records its
/// lease) the token is revoked or the identity disabled or deleted. The
/// lease must be refused: the revoke tree already ran and would never see it.
async fn issue_after(cut_off: CutOff) -> (PluginSecretStore, anyhow::Result<String>) {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let (_, role_id) = approle(&store, "ci", &[]).await;
    let token = login(&store, "ci", &role_id).await;
    random_role(&store).await;
    let context = RequestContext::new(None);
    with_request_context(context.clone(), async {
        store.token_lookup(&token.token).await.unwrap().unwrap();
    })
    .await;
    match cut_off {
        CutOff::Revoke => {
            store
                .token_revoke_tree(&token.accessor, false, &actor)
                .await
                .unwrap();
        }
        CutOff::Disable => {
            store
                .machine_update("ci", None, None, Some(true), &actor)
                .await
                .unwrap();
        }
        CutOff::Delete => store.machine_delete("ci", &actor).await.unwrap(),
    }
    let issued = with_request_context(context, async {
        store
            .dynamic_issue("rnd", None, Some("machine:ci"), &actor)
            .await
    })
    .await;
    (store, issued.map(|credential| credential.lease.id))
}

async fn random_role(store: &PluginSecretStore) {
    store
        .dynamic_put_role(
            "rnd",
            &crate::vault::dynamic::ProviderConfig::Random {
                length: 16,
                charset: crate::plugin_secrets::kv::Charset::Hex,
                field: None,
            },
            Some(600),
            Some(600),
            &AuditActor::system(),
        )
        .await
        .unwrap();
}

async fn assert_no_lease(store: &PluginSecretStore, issued: anyhow::Result<String>) {
    let error = issued.expect_err("a cut-off token must get no lease");
    assert!(error.to_string().starts_with("vault_denied"), "{error}");
    assert!(store.lease_list(None, true).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_token_revoked_after_lookup_records_no_lease() {
    let (store, issued) = issue_after(CutOff::Revoke).await;
    assert_no_lease(&store, issued).await;
}

#[tokio::test]
async fn an_identity_disabled_after_lookup_records_no_lease() {
    let (store, issued) = issue_after(CutOff::Disable).await;
    assert_no_lease(&store, issued).await;
}

#[tokio::test]
async fn an_identity_deleted_after_lookup_records_no_lease() {
    let (store, issued) = issue_after(CutOff::Delete).await;
    assert_no_lease(&store, issued).await;
}

#[tokio::test]
async fn a_request_that_spent_the_last_use_still_records_its_lease() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let (_, role_id) = approle(&store, "once", &[]).await;
    store
        .machine_set_token_config(
            "once",
            TokenConfig {
                num_uses: Some(1),
                ..TokenConfig::default()
            },
            &actor,
        )
        .await
        .unwrap();
    let token = login(&store, "once", &role_id).await;
    random_role(&store).await;
    let credential = with_request_context(RequestContext::new(None), async {
        store.token_lookup(&token.token).await.unwrap().unwrap();
        store
            .dynamic_issue("rnd", None, Some("machine:once"), &actor)
            .await
            .unwrap()
    })
    .await;
    // The use spent the token, and the lease is still recorded on it.
    assert!(store.token_lookup(&token.token).await.unwrap().is_none());
    let report = store
        .token_revoke_tree(&token.accessor, false, &actor)
        .await
        .unwrap();
    assert_eq!(report.leases_revoked, 1);
    assert!(store
        .lease_get(&credential.lease.id)
        .await
        .unwrap()
        .revoked_at
        .is_some());
}

#[tokio::test]
async fn a_spent_token_revoked_explicitly_records_no_late_lease() {
    // Two requests are admitted on a two-use token; the second spends it.
    // An explicit revoke then runs the tree before the first records its
    // lease: that lease must be refused like any other after a revoke.
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let (_, role_id) = approle(&store, "twice", &[]).await;
    store
        .machine_set_token_config(
            "twice",
            TokenConfig {
                num_uses: Some(2),
                ..TokenConfig::default()
            },
            &actor,
        )
        .await
        .unwrap();
    let token = login(&store, "twice", &role_id).await;
    random_role(&store).await;
    let first = RequestContext::new(None);
    with_request_context(first.clone(), async {
        store.token_lookup(&token.token).await.unwrap().unwrap();
    })
    .await;
    with_request_context(RequestContext::new(None), async {
        store.token_lookup(&token.token).await.unwrap().unwrap();
    })
    .await;
    store
        .token_revoke_tree(&token.accessor, false, &actor)
        .await
        .unwrap();
    let issued = with_request_context(first, async {
        store
            .dynamic_issue("rnd", None, Some("machine:twice"), &actor)
            .await
    })
    .await;
    assert_no_lease(&store, issued.map(|credential| credential.lease.id)).await;
}

#[tokio::test]
async fn a_database_from_before_spent_at_gains_the_column_and_keeps_working() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let (_, role_id) = approle(&store, "old", &[]).await;
    let token = login(&store, "old", &role_id).await;
    random_role(&store).await;
    {
        // A database written before the column existed.
        let conn = store.conn.lock().await;
        conn.execute("ALTER TABLE vault_tokens DROP COLUMN spent_at", [])
            .unwrap();
        // Opening it adds the column, and opening it again is a no-op.
        super::init_schema(&conn).unwrap();
        super::init_schema(&conn).unwrap();
        let spent: Option<i64> = conn
            .query_row(
                "SELECT spent_at FROM vault_tokens WHERE accessor = ?1",
                rusqlite::params![token.accessor],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(spent, None);
    }
    let credential = with_request_context(RequestContext::new(None), async {
        store.token_lookup(&token.token).await.unwrap().unwrap();
        store
            .dynamic_issue("rnd", None, Some("machine:old"), &actor)
            .await
            .unwrap()
    })
    .await;
    let report = store
        .token_revoke_tree(&token.accessor, false, &actor)
        .await
        .unwrap();
    assert_eq!(report.leases_revoked, 1);
    assert!(store
        .lease_get(&credential.lease.id)
        .await
        .unwrap()
        .revoked_at
        .is_some());
}
