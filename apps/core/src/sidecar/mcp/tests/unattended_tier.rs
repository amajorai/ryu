//! The plain `call_tool` entry (workflow tool nodes and other unattended
//! callers) keeps the approval policy's every-call tier: it refuses those tools
//! instead of running them through the no-gate core.

use super::*;
use crate::workflow::store::{self, NodeStatus, RunStatus};
use crate::workflow::test_support as ts;
use crate::workflow::NodeKind;
use serde_json::json;

/// What the loopback executor answers when it is handed a self-API call that
/// lacks its `id` path parameter. It refuses before any network I/O, so this
/// text proves the call was dispatched, and its absence that it was not.
const DISPATCHED: &str = "missing required path parameter";
/// Words only the refusal of `unattended_call_refusal` carries.
const REFUSED: &str = "cannot run from a workflow tool node";
const WRITE: &str = "ryu_api.put_api_models_id_launch_config";
const READ: &str = "ryu_api.get_api_models_id_launch_config";
const APP_WRITE: &str = "ryu_ext.ryu_crm.post_records";
const APP_READ: &str = "ryu_ext.ryu_crm.get_records";
/// A built-in that reads one file of the workflow store and answers in process.
const ORDINARY: &str = "workflow_builder.get_workflow";

#[test]
fn the_every_call_tier_is_refused_in_every_approval_mode() {
    for pref in [None, Some("off"), Some("smart"), Some("manual")] {
        for tool in [
            WRITE,
            "ryu_api.post_workflows",
            "ryu_api__delete_api_models_id",
            "research.run",
            crate::sidecar::mcp::challenges_tool::SUBMIT_TOOL_ID,
            "workspace.switch_interface",
        ] {
            let refusal = unattended_call_refusal(tool, tool, pref)
                .unwrap_or_else(|| panic!("{tool} must be refused with mode {pref:?}"));
            assert!(
                refusal.contains(REFUSED) && refusal.contains(tool),
                "{refusal}"
            );
        }
    }
}

#[test]
fn an_app_api_write_is_refused_unless_approvals_are_explicitly_off() {
    for pref in [None, Some(""), Some("smart"), Some("manual")] {
        assert!(
            unattended_call_refusal(APP_WRITE, APP_WRITE, pref).is_some(),
            "mode {pref:?}"
        );
    }
    for pref in [Some("off"), Some(" OFF ")] {
        assert!(
            unattended_call_refusal(APP_WRITE, APP_WRITE, pref).is_none(),
            "mode {pref:?}"
        );
    }
}

/// Reads, and tools the policy gates only by name or by the manual mode, keep
/// running for a workflow.
#[test]
fn reads_and_ordinary_tools_are_not_refused() {
    for pref in [None, Some("off"), Some("manual")] {
        for tool in [
            READ,
            APP_READ,
            ORDINARY,
            "spider.crawl",
            "gmail.send_email",
            "routines.create",
            "spaces.create_page",
        ] {
            assert!(
                unattended_call_refusal(tool, tool, pref).is_none(),
                "{tool} with mode {pref:?}"
            );
        }
    }
}

/// An app alias is judged by its target, and the refusal names the id the
/// author wrote.
#[test]
fn the_refusal_judges_the_target_and_names_the_requested_id() {
    let refusal = unattended_call_refusal("app.acme.tidy", WRITE, Some("off")).unwrap();
    assert!(refusal.contains("`app.acme.tidy`"), "{refusal}");
    assert!(unattended_call_refusal(WRITE, ORDINARY, Some("off")).is_none());
}

#[tokio::test]
async fn the_plain_entry_refuses_a_self_api_write_before_dispatch() {
    let registry = McpRegistry::empty();
    for tool in [WRITE, "ryu_api__put_api_models_id_launch_config"] {
        let error = registry
            .call_tool(tool, json!({}), None)
            .await
            .expect_err("a self-API write is never run for an unattended caller")
            .to_string();
        assert!(
            error.contains(REFUSED) && !error.contains(DISPATCHED),
            "{tool}: {error}"
        );
    }
}

/// This process has no approval engine, so the mode is unknown and an app API
/// write is held like the policy holds it for an unset mode.
#[tokio::test]
async fn the_plain_entry_refuses_an_app_api_write() {
    let error = McpRegistry::empty()
        .call_tool(APP_WRITE, json!({}), None)
        .await
        .expect_err("an app API write is not run for an unattended caller")
        .to_string();
    assert!(
        error.contains(REFUSED) && !error.contains("unknown derived tool"),
        "{error}"
    );
}

#[tokio::test]
async fn the_plain_entry_still_dispatches_reads_and_ordinary_tools() {
    let registry = McpRegistry::empty();
    let read = registry
        .call_tool(READ, json!({}), None)
        .await
        .expect_err("the executor refuses a call without its id")
        .to_string();
    assert!(
        read.contains(DISPATCHED) && !read.contains(REFUSED),
        "{read}"
    );
    let app_read = registry
        .call_tool(APP_READ, json!({}), None)
        .await
        .expect_err("no app registered this derived tool")
        .to_string();
    assert!(app_read.contains("unknown derived tool"), "{app_read}");
    let ordinary = registry
        .call_tool(ORDINARY, json!({ "workflow_id": absent_workflow() }), None)
        .await
        .expect("an ordinary tool runs");
    assert_eq!(ordinary["found"], json!(false), "{ordinary}");
}

fn absent_workflow() -> String {
    format!("wf_ce8_absent_{}", uuid::Uuid::new_v4().simple())
}

/// Run a one-step workflow (`in` -> `t`) the way a saved or scheduled workflow
/// runs, against the process-global registry, and return the stored run.
async fn run_node(kind: NodeKind) -> store::WorkflowRun {
    // Published once per process; a registry another test published first
    // serves just as well, because nothing here depends on its contents.
    crate::sidecar::mcp::set_global_registry(std::sync::Arc::new(McpRegistry::empty()));
    let workflow = ts::workflow(
        format!("ce8-{}", uuid::Uuid::new_v4().simple()),
        "ce8",
        vec![
            ts::node("in", NodeKind::Input { key: None }),
            ts::node("t", kind),
        ],
        vec![ts::edge("in", "t")],
    );
    let run_id = format!("ce8r-{}", uuid::Uuid::new_v4().simple());
    let _ = crate::workflow::executor::run_workflow(
        &workflow,
        std::collections::HashMap::new(),
        run_id.clone(),
    )
    .await;
    store::load_run(&run_id).expect("the run is persisted")
}

fn node_error(run: &store::WorkflowRun) -> String {
    run.nodes
        .get("t")
        .and_then(|state| state.error.clone())
        .unwrap_or_default()
}

/// CE-8: a `tool` node and its two-field `mcp` form both name a self-API write.
/// The run fails at that node and the call never reaches the executor.
#[tokio::test]
async fn a_workflow_tool_node_does_not_run_a_self_api_write() {
    let nodes = [
        NodeKind::Tool {
            name: WRITE.into(),
            args: json!({}),
        },
        NodeKind::Mcp {
            server: "ryu_api".into(),
            tool: "put_api_models_id_launch_config".into(),
            args: json!({}),
        },
    ];
    for kind in nodes {
        let run = run_node(kind.clone()).await;
        let error = node_error(&run);
        assert_eq!(run.status, RunStatus::Failed, "{kind:?}");
        assert!(
            error.contains(REFUSED) && !error.contains(DISPATCHED),
            "{kind:?}: {error}"
        );
    }
}

#[tokio::test]
async fn a_workflow_tool_node_still_runs_a_self_api_read_and_an_ordinary_tool() {
    let read = run_node(NodeKind::Tool {
        name: READ.into(),
        args: json!({}),
    })
    .await;
    let error = node_error(&read);
    assert!(
        error.contains(DISPATCHED) && !error.contains(REFUSED),
        "the read must reach the executor: {error}"
    );

    let ordinary = run_node(NodeKind::Tool {
        name: ORDINARY.into(),
        args: json!({ "workflow_id": absent_workflow() }),
    })
    .await;
    let state = ordinary.nodes.get("t").expect("the tool node ran");
    assert_eq!(state.status, NodeStatus::Completed, "{:?}", state.error);
    let output = state.output.as_deref().unwrap_or_default();
    assert!(output.contains("\"found\":false"), "{output}");
}
