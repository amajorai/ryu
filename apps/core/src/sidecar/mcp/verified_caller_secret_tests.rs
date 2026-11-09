//! Regression: on an org-bound node, a conversationless MCP or app-tool
//! dispatch from a verified member resolves secrets as that member, so the
//! member's `user:`/`role:`/`team:` vault denies cannot be skipped by calling
//! over network `/mcp` or the REST tool path instead of a chat conversation.

use super::{authenticated_scope, resolve_mcp_secret_map, McpRegistry, ToolPrincipal};
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::plugin_secrets::{PluginSecretStore, SecretResolutionContext, SecretScope};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use std::collections::BTreeMap;

fn org_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org-1".into(),
            name: "Org".into(),
            slug: None,
        },
        node_id: "node-1".into(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

fn bob() -> VerifiedCaller {
    VerifiedCaller {
        user_id: "bob".to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    }
}

async fn context_on_org_node(
    dispatch: impl std::future::Future<Output = SecretResolutionContext>,
) -> SecretResolutionContext {
    with_test_node_binding(true, Some(org_node()), dispatch).await
}

async fn prod_token(context: &SecretResolutionContext) -> Option<String> {
    let store = PluginSecretStore::in_memory().unwrap();
    store
        .set_vault_secret(SecretScope::Node, "node-1", None, "PROD_TOKEN", "prod")
        .await
        .unwrap();
    let headers = BTreeMap::from([(
        "Authorization".to_owned(),
        "Bearer secret:PROD_TOKEN".to_owned(),
    )]);
    resolve_mcp_secret_map(&store, &headers, context)
        .await
        .unwrap()
        .remove("Authorization")
}

#[tokio::test]
async fn a_verified_member_without_a_conversation_is_the_secret_principal() {
    let registry = McpRegistry::empty();
    let context = context_on_org_node(authenticated_scope::with_verified_tool_caller(
        &bob(),
        registry.secret_resolution_context(None, vec!["srv".into()]),
    ))
    .await;
    assert_eq!(context.user_id.as_deref(), Some("bob"));
    assert_eq!(context.org_id.as_deref(), Some("org-1"));
    // The member's current role and teams come from the control plane. A test
    // node has no control-plane credential, so the lookup fails and the
    // member's denies cannot be evaluated: resolution must fail closed rather
    // than fall back to the subject-less node baseline.
    assert!(context.principal_unverified);
    assert_eq!(prod_token(&context).await, None);
}

#[tokio::test]
async fn an_unattributed_verified_scope_fails_closed() {
    let registry = McpRegistry::empty();
    let context = context_on_org_node(authenticated_scope::with_principal_for_tests(
        ToolPrincipal::Unresolved,
        registry.secret_resolution_context(None, vec!["srv".into()]),
    ))
    .await;
    assert_eq!(context.user_id, None);
    assert!(context.principal_unverified);
    assert_eq!(prod_token(&context).await, None);
}

#[tokio::test]
async fn an_owner_token_call_keeps_the_node_scope() {
    let registry = McpRegistry::empty();
    let context =
        context_on_org_node(registry.secret_resolution_context(None, vec!["srv".into()])).await;
    assert_eq!(context.user_id, None);
    assert!(!context.principal_unverified);
    assert_eq!(prod_token(&context).await.as_deref(), Some("Bearer prod"));
}
