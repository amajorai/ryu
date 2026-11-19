//! Admission, use limits, renewal, child and orphan token tests (`admit_create`).

use super::tests::{approle, ip, login};
use super::*;
use super::{config::*, context::*};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;
use crate::vault::now_millis;

#[tokio::test]
async fn use_limited_tokens_are_revoked_at_zero() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (_, role_id) = approle(&store, "limited", &["p"]).await;
    store
        .machine_set_token_config(
            "limited",
            TokenConfig {
                num_uses: Some(2),
                ..TokenConfig::default()
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let token = login(&store, "limited", &role_id).await;
    assert!(store.token_lookup(&token.token).await.unwrap().is_some());
    assert!(store.token_lookup(&token.token).await.unwrap().is_some());
    assert!(store.token_lookup(&token.token).await.unwrap().is_none());
    let info = store.token_info(&token.accessor).await.unwrap();
    assert_eq!(info.num_uses_remaining, Some(0));
    assert!(info.revoked_at.is_some());
}

#[tokio::test]
async fn cidr_bound_tokens_need_a_matching_client() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (_, role_id) = approle(&store, "bound", &[]).await;
    store
        .machine_set_token_config(
            "bound",
            TokenConfig {
                bound_cidrs: vec!["10.0.0.0/8".into()],
                ..TokenConfig::default()
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let (secret, _) = store
        .machine_issue_secret_id("bound", None, None, &AuditActor::system())
        .await
        .unwrap();
    // Login from outside the bound CIDRs is refused.
    let outside = RequestContext::new(Some(ip("192.0.2.1")));
    assert!(
        with_request_context(outside, store.approle_login(&role_id, &secret))
            .await
            .is_err()
    );
    let inside = RequestContext::new(Some(ip("10.2.3.4")));
    let token = with_request_context(inside.clone(), store.approle_login(&role_id, &secret))
        .await
        .unwrap();
    assert!(
        with_request_context(inside, store.token_lookup(&token.token))
            .await
            .unwrap()
            .is_some()
    );
    let elsewhere = RequestContext::new(Some(ip("192.0.2.1")));
    assert!(
        with_request_context(elsewhere, store.token_lookup(&token.token))
            .await
            .unwrap()
            .is_none()
    );
    // Outside any request the address is unknown: fail closed.
    assert!(store.token_lookup(&token.token).await.unwrap().is_none());
}

#[tokio::test]
async fn renew_extends_up_to_the_max_ttl() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (_, role_id) = approle(&store, "renew", &[]).await;
    store
        .machine_set_token_config(
            "renew",
            TokenConfig {
                max_ttl_secs: Some(900),
                ..TokenConfig::default()
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let token = login(&store, "renew", &role_id).await;
    let info = store.token_info(&token.accessor).await.unwrap();
    let max = info.max_expires_at.unwrap();
    assert!(max - info.created_at <= 900_000);
    let renewed = store
        .token_renew(&token.accessor, Some(10_000), &AuditActor::system())
        .await
        .unwrap();
    assert_eq!(renewed.expires_at, max);
    store
        .token_revoke(&token.accessor, &AuditActor::system())
        .await
        .unwrap();
    assert!(store
        .token_renew(&token.accessor, None, &AuditActor::system())
        .await
        .is_err());
}

#[tokio::test]
async fn periodic_tokens_renew_by_one_period_without_a_max() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (_, role_id) = approle(&store, "periodic", &[]).await;
    store
        .machine_set_token_config(
            "periodic",
            TokenConfig {
                period_secs: Some(120),
                renewable: Some(true),
                ..TokenConfig::default()
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let token = login(&store, "periodic", &role_id).await;
    let info = store.token_info(&token.accessor).await.unwrap();
    assert_eq!(info.period_secs, Some(120));
    assert_eq!(info.max_expires_at, None);
    assert!(info.expires_at - info.created_at <= 120_000);
    let renewed = store
        .token_renew(&token.accessor, Some(99_999), &AuditActor::system())
        .await
        .unwrap();
    assert!(renewed.expires_at - now_millis() <= 120_000);
}

#[tokio::test]
async fn non_renewable_tokens_refuse_renewal() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (_, role_id) = approle(&store, "fixed", &[]).await;
    store
        .machine_set_token_config(
            "fixed",
            TokenConfig {
                renewable: Some(false),
                ..TokenConfig::default()
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let token = login(&store, "fixed", &role_id).await;
    assert!(store
        .token_renew(&token.accessor, None, &AuditActor::system())
        .await
        .is_err());
}

#[tokio::test]
async fn child_tokens_narrow_policies_and_die_with_the_parent() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (identity_id, role_id) = approle(&store, "orch", &["read", "write"]).await;
    let parent = login(&store, "orch", &role_id).await;
    let actor = AuditActor::system();
    // Escalation beyond the parent's policies is refused.
    assert!(store
        .token_create_child(
            &parent.accessor,
            &parent.policies,
            &identity_id,
            TokenRequest {
                policies: Some(vec!["admin".into()]),
                ..TokenRequest::default()
            },
            &actor,
        )
        .await
        .is_err());
    let child = store
        .token_create_child(
            &parent.accessor,
            &parent.policies,
            &identity_id,
            TokenRequest {
                policies: Some(vec!["read".into()]),
                ttl_secs: Some(999_999),
                num_uses: Some(1),
                ..TokenRequest::default()
            },
            &actor,
        )
        .await
        .unwrap();
    assert!(child.expires_at <= parent.expires_at);
    let principal = store.token_lookup(&child.token).await.unwrap().unwrap();
    assert_eq!(principal.policies, vec!["read".to_owned()]);
    // A use-limited token cannot have children of its own.
    assert!(store
        .token_create_child(
            &child.accessor,
            &principal.policies,
            &identity_id,
            TokenRequest::default(),
            &actor,
        )
        .await
        .is_err());
    // The single use is spent.
    assert!(store.token_lookup(&child.token).await.unwrap().is_none());
    let second = store
        .token_create_child(
            &parent.accessor,
            &parent.policies,
            &identity_id,
            TokenRequest::default(),
            &actor,
        )
        .await
        .unwrap();
    let grandchild = store
        .token_create_child(
            &second.accessor,
            &second.policies,
            &identity_id,
            TokenRequest::default(),
            &actor,
        )
        .await
        .unwrap();
    let report = store
        .token_revoke_tree(&parent.accessor, false, &actor)
        .await
        .unwrap();
    assert_eq!(report.tokens, 4);
    assert!(store.token_lookup(&second.token).await.unwrap().is_none());
    assert!(store
        .token_lookup(&grandchild.token)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn orphans_need_a_role_and_survive_the_parent() {
    let store = PluginSecretStore::in_memory().unwrap();
    let (identity_id, role_id) = approle(&store, "orph", &["read"]).await;
    let parent = login(&store, "orph", &role_id).await;
    let actor = AuditActor::system();
    let request = |role: Option<&str>| TokenRequest {
        role: role.map(str::to_owned),
        orphan: Some(true),
        ..TokenRequest::default()
    };
    assert!(store
        .token_create_child(
            &parent.accessor,
            &parent.policies,
            &identity_id,
            request(None),
            &actor
        )
        .await
        .is_err());
    store
        .token_role_put(
            TokenRole {
                name: "detached".into(),
                orphan: true,
                allowed_policies: vec!["read".into()],
                ..TokenRole::default()
            },
            &actor,
        )
        .await
        .unwrap();
    // Without `use` on the role, a machine cannot mint from it.
    assert!(store
        .token_create_child(
            &parent.accessor,
            &parent.policies,
            &identity_id,
            request(Some("detached")),
            &actor,
        )
        .await
        .is_err());
    {
        let conn = store.conn.lock().await;
        crate::vault::policy::put_policy(
            &conn,
            &crate::vault::policy::Policy {
                name: "read".into(),
                description: String::new(),
                rules: vec![crate::vault::policy::PolicyRule {
                    path: "sys/token-roles/detached".into(),
                    capabilities: vec![crate::vault::policy::Capability::Use],
                    deny: false,
                    ..Default::default()
                }],
            },
        )
        .unwrap();
    }
    let orphan = store
        .token_create_child(
            &parent.accessor,
            &parent.policies,
            &identity_id,
            request(Some("detached")),
            &actor,
        )
        .await
        .unwrap();
    store.token_revoke(&parent.accessor, &actor).await.unwrap();
    let info = store.token_info(&orphan.accessor).await.unwrap();
    assert!(info.orphan && info.parent_accessor.is_none());
    assert!(store.token_lookup(&orphan.token).await.unwrap().is_some());
}
