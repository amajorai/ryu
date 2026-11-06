//! `POST /workflows/:id/run` on an organization-bound node refuses a workflow
//! stored before binding that reaches an agent, so a member an admin denied
//! `agent.run` on that agent cannot run it through the workflow.

use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::server::*;
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use crate::workflow::test_support::{edge, linear_workflow, node, workflow};
use crate::workflow::NodeKind;

fn org_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org1".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

fn bob() -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: "bob".to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org1".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    })
}

fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

async fn run_as_bob(state: &ServerState, id: &str) -> (StatusCode, serde_json::Value) {
    let (status, Json(body)) = with_test_node_binding(
        true,
        Some(org_node()),
        run_workflow(
            State(state.clone()),
            axum::Extension(bob()),
            axum::extract::Path(id.to_owned()),
            None,
        ),
    )
    .await;
    (status, body)
}

#[tokio::test]
async fn a_pre_binding_agent_workflow_is_refused_and_a_self_contained_one_runs() {
    crate::crypto_host::install();
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());

    let agent_id = unique("wf-agent");
    let agent_wf = workflow(
        agent_id.clone(),
        "pre-binding",
        vec![
            node("in", NodeKind::Input { key: None }),
            node(
                "ask",
                NodeKind::Prompt {
                    prompt: "{{input}}".into(),
                    agent_id: Some("fin-bot".into()),
                },
            ),
            node("out", NodeKind::Output { key: None }),
        ],
        vec![edge("in", "ask"), edge("ask", "out")],
    );
    // Stored directly, skipping the save guard, as it was before binding.
    crate::workflow::store::save_workflow(&agent_wf).unwrap();
    let (status, body) = run_as_bob(&state, &agent_id).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"], crate::workflow::UNSCOPED_RUN_REFUSAL);
    assert!(crate::workflow::store::list_runs()
        .iter()
        .all(|run| run.workflow_id != agent_id));

    let plain_id = unique("wf-plain");
    crate::workflow::store::save_workflow(&linear_workflow(plain_id.clone())).unwrap();
    let (status, body) = run_as_bob(&state, &plain_id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["run"]["status"], "completed");
}
