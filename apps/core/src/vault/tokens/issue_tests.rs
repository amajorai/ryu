//! Policy narrowing for credentials that act for a token later (`issue`).

use super::config::*;
use super::tests::{approle, login};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;
use crate::vault::now_millis;
use rusqlite::params;

#[tokio::test]
async fn broker_resolution_keeps_a_scoped_tokens_narrowed_policies() {
    use crate::vault::machine::{principal_by_accessor_locked, principal_policies_locked};
    use crate::vault::policy::{bind, put_policy, Capability, Policy, PolicyRule};
    let store = PluginSecretStore::in_memory().unwrap();
    let (identity_id, role_id) = approle(&store, "broker", &["read", "write"]).await;
    {
        let conn = store.conn.lock().await;
        for name in ["read", "write", "bound"] {
            put_policy(
                &conn,
                &Policy {
                    name: name.into(),
                    description: String::new(),
                    rules: vec![PolicyRule {
                        path: format!("{name}/**"),
                        capabilities: vec![Capability::Use],
                        deny: false,
                        ..Default::default()
                    }],
                },
            )
            .unwrap();
        }
        bind(
            &conn,
            "bound",
            &format!("machine:{identity_id}"),
            None,
            None,
        )
        .unwrap();
    }
    let parent = login(&store, "broker", &role_id).await;
    let child = store
        .token_create_child(
            &parent.accessor,
            &parent.policies,
            &identity_id,
            TokenRequest {
                policies: Some(vec!["read".into()]),
                ..TokenRequest::default()
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let conn = store.conn.lock().await;
    let principal = principal_by_accessor_locked(&conn, &child.accessor)
        .unwrap()
        .unwrap();
    assert_eq!(principal.policies, vec!["read".to_owned()]);
    let documents: Vec<String> = principal_policies_locked(&conn, &principal)
        .unwrap()
        .into_iter()
        .map(|policy| policy.name)
        .collect();
    assert_eq!(documents, vec!["read".to_owned()], "no binding re-added");
    // The parent keeps everything, its binding included.
    let principal = principal_by_accessor_locked(&conn, &parent.accessor)
        .unwrap()
        .unwrap();
    let mut documents: Vec<String> = principal_policies_locked(&conn, &principal)
        .unwrap()
        .into_iter()
        .map(|policy| policy.name)
        .collect();
    documents.sort();
    assert_eq!(documents, ["bound", "read", "write"]);
    // Revoking the parent ends the child's broker authority too.
    conn.execute(
        "UPDATE vault_tokens SET revoked_at = ?1 WHERE accessor = ?2",
        params![now_millis(), parent.accessor],
    )
    .unwrap();
    assert!(principal_by_accessor_locked(&conn, &child.accessor)
        .unwrap()
        .is_none());
}
