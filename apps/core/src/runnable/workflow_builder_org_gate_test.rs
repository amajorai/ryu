//! Regression tests: every `workflow_builder.*` tool is refused on an
//! organization-bound node. The tools load and save workflows (and their
//! schedule triggers) with no per-workflow ACL and no saving principal, so the
//! org-binding refusal in [`super::dispatch`] is the only thing keeping a member
//! from rewriting another member's workflow through MCP.

use serde_json::json;

use super::dispatch;
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};

fn bound_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org-1".to_owned(),
            name: "Acme".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

#[tokio::test]
async fn every_workflow_builder_tool_is_refused_on_an_org_bound_node() {
    for (tool, args) in [
        ("get_workflow", json!({ "workflow_id": "wf-victim" })),
        ("create_workflow", json!({ "name": "attacker" })),
        (
            "configure_workflow",
            json!({ "workflow_id": "wf-victim", "nodes": [], "triggers": [] }),
        ),
    ] {
        let err = with_test_node_binding(true, Some(bound_node()), dispatch(tool, args))
            .await
            .expect_err("an org-bound node must refuse workflow_builder");
        assert!(
            err.to_string()
                .contains("disabled on organization-bound nodes"),
            "{tool}: {err}"
        );
    }
}

#[tokio::test]
async fn an_unbound_node_still_reaches_the_workflow_builder_handlers() {
    // The refusal is about the org binding, not the tool: an unbound node gets
    // past it to the handler, which reports its own argument error.
    let err = with_test_node_binding(false, None, dispatch("get_workflow", json!({})))
        .await
        .expect_err("missing workflow_id");
    assert!(
        !err.to_string()
            .contains("disabled on organization-bound nodes"),
        "{err}"
    );
}
