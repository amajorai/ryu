//! Graph construction and chat-entry tests for the workflow definition layer.

use super::*;
use crate::workflow::test_support::{edge, node, workflow};

fn linear_workflow() -> Workflow {
    workflow(
        "wf1",
        "linear",
        vec![
            node("in", NodeKind::Input { key: None }),
            node(
                "up",
                NodeKind::Transform {
                    op: "uppercase".into(),
                    template: None,
                },
            ),
            node("out", NodeKind::Output { key: None }),
        ],
        vec![edge("in", "up"), edge("up", "out")],
    )
}

#[test]
fn builds_linear_dag() {
    let g = WorkflowGraph::build(&linear_workflow()).expect("should build");
    assert_eq!(g.graph.node_count(), 3);
    assert_eq!(g.graph.edge_count(), 2);
    let roots = g.roots();
    assert_eq!(roots.len(), 1);
}

#[test]
fn rejects_cycle() {
    let mut wf = linear_workflow();
    wf.edges.push(edge("out", "in"));
    let err = WorkflowGraph::build(&wf).expect_err("cycle must be rejected");
    assert!(matches!(err, GraphError::Cyclic));
}

#[test]
fn rejects_unknown_edge() {
    let mut wf = linear_workflow();
    wf.edges.push(edge("in", "ghost"));
    let err = WorkflowGraph::build(&wf).expect_err("unknown node must be rejected");
    assert!(matches!(err, GraphError::UnknownNode(_)));
}

#[test]
fn rejects_duplicate_node() {
    let mut wf = linear_workflow();
    wf.nodes.push(node("in", NodeKind::Output { key: None }));
    let err = WorkflowGraph::build(&wf).expect_err("dup must be rejected");
    assert!(matches!(err, GraphError::DuplicateNode(_)));
}

#[test]
fn accepts_chat_input_when_root_is_input_node() {
    assert!(
        accepts_chat_input(&linear_workflow()),
        "a workflow rooted on an Input node is chat-triggerable"
    );
}

#[test]
fn rejects_chat_input_without_a_root_input_node() {
    // The Input node is fed by a root Transform, so it is not an entry
    // point — a message sent here would never be read by the run.
    let wf = workflow(
        "wf2",
        "no-entry",
        vec![
            node(
                "src",
                NodeKind::Transform {
                    op: "identity".into(),
                    template: None,
                },
            ),
            node("in", NodeKind::Input { key: None }),
            node("out", NodeKind::Output { key: None }),
        ],
        vec![edge("src", "in"), edge("in", "out")],
    );
    assert!(
        !accepts_chat_input(&wf),
        "an Input node that is not a root does not make a workflow chat-triggerable"
    );
}

#[test]
fn rejects_chat_input_for_broken_graph() {
    let mut wf = linear_workflow();
    wf.edges.push(edge("out", "in"));
    assert!(
        !accepts_chat_input(&wf),
        "a cyclic workflow is not chat-triggerable"
    );
}
