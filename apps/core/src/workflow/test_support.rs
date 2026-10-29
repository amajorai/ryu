//! Builders for workflow definitions in tests: every optional field left unset.

use super::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};

/// A node with no retry, timeout or repeat policy.
pub(crate) fn node(id: impl Into<String>, kind: NodeKind) -> WorkflowNode {
    WorkflowNode {
        id: id.into(),
        kind,
        retry: None,
        timeout_ms: None,
        repeat: None,
    }
}

/// An unconditional edge.
pub(crate) fn edge(from: impl Into<String>, to: impl Into<String>) -> WorkflowEdge {
    WorkflowEdge {
        from: from.into(),
        to: to.into(),
        branch: None,
    }
}

/// A workflow with no description, triggers, concurrency cap or timestamps.
pub(crate) fn workflow(
    id: impl Into<String>,
    name: impl Into<String>,
    nodes: Vec<WorkflowNode>,
    edges: Vec<WorkflowEdge>,
) -> Workflow {
    Workflow {
        id: id.into(),
        name: name.into(),
        description: None,
        nodes,
        edges,
        triggers: Vec::new(),
        max_concurrency: None,
        created_at: None,
        updated_at: None,
    }
}

/// `in` (input `text`) -> `up` (uppercase) -> `out` (output `result`).
pub(crate) fn linear_workflow(id: impl Into<String>) -> Workflow {
    workflow(
        id,
        "lin",
        vec![
            node(
                "in",
                NodeKind::Input {
                    key: Some("text".into()),
                },
            ),
            node(
                "up",
                NodeKind::Transform {
                    op: "uppercase".into(),
                    template: None,
                },
            ),
            node(
                "out",
                NodeKind::Output {
                    key: Some("result".into()),
                },
            ),
        ],
        vec![edge("in", "up"), edge("up", "out")],
    )
}
