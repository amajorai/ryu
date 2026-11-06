//! A workflow stored before the node joined an organization must not run agent,
//! nested-workflow or tool-dispatching nodes once it is bound, whichever entry
//! point starts it (REST, chat, Connect and schedules all reach the executor).

use std::collections::HashMap;

use super::*;
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use crate::workflow::store::{self, RunStatus};
use crate::workflow::test_support::{edge, linear_workflow, node, workflow};
use crate::workflow::{executor, script};

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

fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

/// Input -> Prompt routed to `fin-bot` -> Output, as written before binding.
fn agent_workflow(id: &str) -> Workflow {
    workflow(
        id,
        "pre-binding",
        vec![
            node(
                "in",
                NodeKind::Input {
                    key: Some("text".into()),
                },
            ),
            node(
                "ask",
                NodeKind::Prompt {
                    prompt: "{{input}}".into(),
                    agent_id: Some("fin-bot".into()),
                },
            ),
            node(
                "out",
                NodeKind::Output {
                    key: Some("result".into()),
                },
            ),
        ],
        vec![edge("in", "ask"), edge("ask", "out")],
    )
}

#[tokio::test]
async fn unbound_nodes_may_run_agent_workflows() {
    let wf = agent_workflow(&unique("wf-unbound"));
    assert_eq!(
        with_test_node_binding(false, None, async { ensure_runnable_on_this_node(&wf) }).await,
        Ok(())
    );
}

#[tokio::test]
async fn bound_nodes_refuse_agent_workflows_but_run_self_contained_ones() {
    let wf = agent_workflow(&unique("wf-bound"));
    let plain = linear_workflow(unique("wf-plain"));
    with_test_node_binding(true, Some(org_node()), async {
        assert_eq!(
            ensure_runnable_on_this_node(&wf),
            Err(UNSCOPED_RUN_REFUSAL.to_owned())
        );
        assert_eq!(ensure_runnable_on_this_node(&plain), Ok(()));
    })
    .await;
}

#[tokio::test]
async fn only_genuine_ad_hoc_script_workflows_are_exempt() {
    let genuine = script::script_workflow("return 1;", Some("me"), None, true);
    let mut legacy = script::script_workflow("return 1;", Some("me"), None, false);
    for node in &mut legacy.nodes {
        if let NodeKind::Script { allow_mutation, .. } = &mut node.kind {
            *allow_mutation = None;
        }
    }
    // A stored definition borrowing the `script-` prefix to smuggle an agent node.
    let mut borrowed = script::script_workflow("return 1;", None, None, false);
    borrowed.nodes.push(node(
        "smuggled",
        NodeKind::Prompt {
            prompt: "x".into(),
            agent_id: Some("fin-bot".into()),
        },
    ));
    let mut renamed = agent_workflow("ignored");
    renamed.id = genuine.id.clone();
    with_test_node_binding(true, Some(org_node()), async {
        assert_eq!(ensure_runnable_on_this_node(&genuine), Ok(()));
        assert_eq!(ensure_runnable_on_this_node(&legacy), Ok(()));
        assert!(ensure_runnable_on_this_node(&borrowed).is_err());
        assert!(ensure_runnable_on_this_node(&renamed).is_err());
    })
    .await;
}

#[tokio::test]
async fn the_executor_refuses_a_pre_binding_agent_workflow_before_creating_a_run() {
    let wf = agent_workflow(&unique("wf-exec"));
    // Written straight to the store, as a definition saved before binding was.
    store::save_workflow(&wf).expect("workflow should persist");
    let run_id = unique("run-refused");
    let dry_id = unique("dry-refused");
    let (live, dry) = with_test_node_binding(true, Some(org_node()), async {
        let live = executor::run_workflow(&wf, HashMap::new(), run_id.clone()).await;
        let dry = executor::dry_run_workflow(&wf, HashMap::new(), dry_id).await;
        (live, dry)
    })
    .await;
    assert_eq!(live.unwrap_err(), UNSCOPED_RUN_REFUSAL);
    assert_eq!(dry.unwrap_err(), UNSCOPED_RUN_REFUSAL);
    assert!(
        store::load_run(&run_id).is_err(),
        "a refused run must not leave a run record"
    );
}

#[tokio::test]
async fn the_executor_still_runs_self_contained_workflows_on_bound_nodes() {
    let wf = linear_workflow(unique("wf-exec-plain"));
    let input = HashMap::from([("text".to_owned(), "hello".to_owned())]);
    let run = with_test_node_binding(true, Some(org_node()), async {
        executor::run_workflow(&wf, input, unique("run-plain")).await
    })
    .await
    .expect("a self-contained workflow runs");
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.output.get("result").map(String::as_str), Some("HELLO"));
}
