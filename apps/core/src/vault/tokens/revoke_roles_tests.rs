//! Secret id and identity token settings, orphan revocation and token role
//! tests (`revoke_roles`).

use super::tests::{approle, ip, login};
use super::*;
use super::{config::*, context::*};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;

#[tokio::test]
async fn secret_id_cidrs_gate_login_and_bind_the_token() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (_, role_id) = approle(&store, "sid", &[]).await;
    let (secret, _) = store
        .machine_issue_secret_id_with(
            "sid",
            SecretIdOptions {
                cidr_list: vec!["198.51.100.0/24".into()],
                token_bound_cidrs: vec!["198.51.100.7/32".into()],
                ..SecretIdOptions::default()
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let wrong = RequestContext::new(Some(ip("203.0.113.1")));
    assert!(
        with_request_context(wrong, store.approle_login(&role_id, &secret))
            .await
            .is_err()
    );
    let right = RequestContext::new(Some(ip("198.51.100.7")));
    let token = with_request_context(right, store.approle_login(&role_id, &secret))
        .await
        .unwrap();
    let info = store.token_info(&token.accessor).await.unwrap();
    assert_eq!(info.bound_cidrs, vec!["198.51.100.7/32".to_owned()]);
}

#[tokio::test]
async fn narrowing_identity_cidrs_overrides_older_secret_ids() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (_, role_id) = approle(&store, "narrowed", &[]).await;
    let (secret, _) = store
        .machine_issue_secret_id_with(
            "narrowed",
            SecretIdOptions {
                token_bound_cidrs: vec!["198.51.100.0/24".into()],
                ..SecretIdOptions::default()
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    store
        .machine_set_token_config(
            "narrowed",
            TokenConfig {
                bound_cidrs: vec!["203.0.113.0/24".into()],
                ..TokenConfig::default()
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    // Inside the old override but outside the identity's new range.
    let old_range = RequestContext::new(Some(ip("198.51.100.7")));
    assert!(
        with_request_context(old_range, store.approle_login(&role_id, &secret))
            .await
            .is_err()
    );
    // Inside the new range, but the stored override is no longer inside it.
    let new_range = RequestContext::new(Some(ip("203.0.113.9")));
    assert!(
        with_request_context(new_range, store.approle_login(&role_id, &secret))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn revoke_orphan_keeps_children_alive() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (identity_id, role_id) = approle(&store, "keep", &["read"]).await;
    let parent = login(&store, "keep", &role_id).await;
    let actor = AuditActor::system();
    let child = store
        .token_create_child(
            &parent.accessor,
            &parent.policies,
            &identity_id,
            TokenRequest::default(),
            &actor,
        )
        .await
        .unwrap();
    let report = store
        .token_revoke_tree(&parent.accessor, true, &actor)
        .await
        .unwrap();
    assert_eq!(report.tokens, 1);
    assert!(store.token_lookup(&child.token).await.unwrap().is_some());
    assert!(store.token_info(&child.accessor).await.unwrap().orphan);
}

#[tokio::test]
async fn role_policy_lists_constrain_admin_tokens() {
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    approle(&store, "svc", &["a", "b"]).await;
    store
        .token_role_put(
            TokenRole {
                name: "narrow".into(),
                disallowed_policies: vec!["b".into()],
                token: TokenConfig {
                    num_uses: Some(3),
                    ..TokenConfig::default()
                },
                ..TokenRole::default()
            },
            &actor,
        )
        .await
        .unwrap();
    assert!(store
        .token_create_for_identity(
            "svc",
            TokenRequest {
                role: Some("narrow".into()),
                policies: Some(vec!["b".into()]),
                ..TokenRequest::default()
            },
            &actor,
        )
        .await
        .is_err());
    let token = store
        .token_create_for_identity(
            "svc",
            TokenRequest {
                role: Some("narrow".into()),
                policies: Some(vec!["a".into()]),
                num_uses: Some(10),
                ..TokenRequest::default()
            },
            &actor,
        )
        .await
        .unwrap();
    let info = store.token_info(&token.accessor).await.unwrap();
    assert_eq!(info.num_uses_remaining, Some(3));
    assert!(info.orphan);
    assert_eq!(store.token_role_list().await.unwrap().len(), 1);
    assert!(store.token_role_delete("narrow", &actor).await.unwrap());
    assert!(store.token_role_get("narrow").await.is_err());
}
