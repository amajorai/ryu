//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;

/// A managed node with no grant resolution is deny-by-default, so every
/// entry that reaches the no-gate dispatch core (workflows, approval
/// replay, capability facades) must refuse an ungranted external MCP
/// server or Composio toolkit, not only the gated agent entry.
#[tokio::test]
async fn ungranted_sources_are_refused_on_every_dispatch_entry() {
    let registry = McpRegistry::empty();
    registry.servers.write().unwrap().insert(
        "ungranted".to_owned(),
        McpServerConfig {
            enabled: true,
            transport: Some("streamable-http".to_owned()),
            url: Some("http://127.0.0.1:9/mcp".to_owned()),
            ..Default::default()
        },
    );
    crate::sidecar::control_plane::with_test_node_binding(true, None, async {
        for tool in ["ungranted.probe", "composio.GITHUB_CREATE_ISSUE"] {
            let workflow = registry
                .call_tool_with_user(tool, serde_json::json!({}), None, None)
                .await
                .expect_err("an ungranted source must be refused for workflows");
            assert!(
                workflow
                    .to_string()
                    .contains("not granted by the control plane"),
                "{tool}: {workflow}"
            );
            let replay = registry
                .call_tool_with_identity_after_approval_scoped(
                    None,
                    tool,
                    serde_json::json!({}),
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
                .expect_err("an ungranted source must be refused on approval replay");
            assert!(
                replay
                    .to_string()
                    .contains("not granted by the control plane"),
                "{tool}: {replay}"
            );
            let facade = CAPABILITY_PROVIDER_DISPATCH
                .scope(
                    true,
                    registry.call_tool_with_identity_no_gate(
                        None,
                        tool,
                        serde_json::json!({}),
                        None,
                        None,
                        &[],
                        None,
                        None,
                    ),
                )
                .await
                .expect_err("a facade target must not bypass the grant check");
            assert!(
                facade
                    .to_string()
                    .contains("not granted by the control plane"),
                "{tool}: {facade}"
            );
        }
    })
    .await;
}
