//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use serde_json::json;

#[tokio::test]
async fn agent_account_policy_narrows_composio_scope_at_dispatch() {
    use crate::agents::{AgentIdentityMode, AgentStore, CreateAgent};
    use crate::sidecar::adapters::{AcpAgentRegistry, ComposioConnectionBinding};

    let store = AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
    let individual = store
        .create(CreateAgent {
            name: "Own identity".to_owned(),
            tools: vec!["*".to_owned()],
            identity_mode: AgentIdentityMode::Individual,
            ..Default::default()
        })
        .await
        .unwrap();
    let managed = store
        .create(CreateAgent {
            name: "Allowlisted".to_owned(),
            tools: vec!["*".to_owned()],
            account_access: Some(vec!["composio:ca_allowed".to_owned()]),
            ..Default::default()
        })
        .await
        .unwrap();
    let own_limited = store
        .create(CreateAgent {
            name: "Own identity, limited".to_owned(),
            tools: vec!["*".to_owned()],
            identity_mode: AgentIdentityMode::Individual,
            account_access: Some(vec!["composio:ca_user".to_owned()]),
            ..Default::default()
        })
        .await
        .unwrap();
    let registry = McpRegistry::empty().with_agent_store(store);
    // The user's account was validated into the scope, yet neither an
    // agent with its own identity nor one whose allowlist omits it may use
    // it: the scope is narrowed, never widened, before dispatch.
    let scope = [ComposioConnectionBinding {
        id: "ca_user".to_owned(),
        toolkit: "github".to_owned(),
    }];
    for agent_id in [&individual.id, &managed.id] {
        let error = registry
            .call_tool_with_identity_no_gate_scoped(
                Some(agent_id),
                "composio.GITHUB_SEARCH_ISSUES",
                json!({}),
                None,
                None,
                &[],
                None,
                None,
                Some(&scope),
                None,
                false,
            )
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("outside the selected source scope"),
            "{agent_id}: {error}"
        );
    }

    // With no scope, an agent with its own identity and an allowlist that
    // names none of its own accounts is refused before anything is listed
    // or dispatched; it never falls back to its entity's default account.
    let agent_id = &own_limited.id;
    let error = registry
        .call_tool_with_identity_no_gate_scoped(
            Some(agent_id),
            "composio.GITHUB_SEARCH_ISSUES",
            json!({}),
            None,
            None,
            &[],
            None,
            None,
            None,
            None,
            false,
        )
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("this agent is not allowed to use"),
        "{agent_id}: {error}"
    );
}

/// Composio grants are keyed by toolkit, so a real action id must resolve
/// to the granted toolkit slug rather than to the action name.
#[test]
fn composio_grant_slug_is_the_granted_toolkit() {
    let scope = crate::sidecar::control_plane::ResolvedScope {
        governance: None,
        grants_enforced: true,
        tools: vec![crate::sidecar::control_plane::ResolvedTool {
            id: "composio-github".to_owned(),
            kind: "composio".to_owned(),
            slug: "github".to_owned(),
            name: "GitHub".to_owned(),
            version: "1.0.0".to_owned(),
            config: serde_json::Value::Null,
            has_credential: true,
        }],
    };
    let granted = scope.allowed_slugs("composio");
    let github = composio_grant_slug("composio.GITHUB_CREATE_ISSUE")
        .expect("a Composio action has a grant slug");
    assert_eq!(github, "github");
    assert!(granted.contains(&github));
    let slack = composio_grant_slug("composio.SLACK_SEND_MESSAGE")
        .expect("a Composio action has a grant slug");
    assert!(!granted.contains(&slack));
    // No derivable toolkit fails closed: an empty slug matches no grant.
    assert_eq!(composio_grant_slug("composio.").as_deref(), Some(""));
    assert!(composio_grant_slug("github.create_issue").is_none());
}
