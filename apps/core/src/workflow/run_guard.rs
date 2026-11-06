//! Run-time half of the organization-bound reference rule.
//!
//! [`super::persist_workflow`] refuses to store a workflow that reaches agents,
//! nested workflows or tool dispatch on an organization-bound node, because a
//! run only checks `workflow.run` on the outer workflow and per-resource ACLs
//! (for example an admin's exact-agent `agent.run` deny) would be skipped. A
//! definition written before the node bound is never re-saved, so the same rule
//! is enforced again here, before any run, dry run, resume, fork or continue
//! starts executing it.

use super::{has_unscoped_managed_nodes, NodeKind, Workflow};

/// The refusal a run of such a workflow gets on an organization-bound node.
pub const UNSCOPED_RUN_REFUSAL: &str = "workflow agent, nested-workflow and tool references are disabled on organization-bound nodes until resource ACL propagation is available; this workflow was saved before the node joined the organization and cannot run here";

/// Refuse to run `workflow` on an organization-bound node when it reaches a
/// resource the save guard would have refused. Ad-hoc script workflows are
/// exempt only when they are exactly the definition [`super::script::script_workflow`]
/// builds: their agents go through the script bridge's own `agent.run` checks.
pub fn ensure_runnable_on_this_node(workflow: &Workflow) -> Result<(), String> {
    if crate::sidecar::control_plane::registered_org().is_none()
        || !has_unscoped_managed_nodes(workflow)
        || is_genuine_script_workflow(workflow)
    {
        return Ok(());
    }
    Err(UNSCOPED_RUN_REFUSAL.to_owned())
}

/// Whether `workflow` is byte-for-byte the content-addressed definition an
/// ad-hoc script run builds, so a stored workflow that merely borrows the
/// `script-` id prefix is not exempt.
fn is_genuine_script_workflow(workflow: &Workflow) -> bool {
    if !workflow
        .id
        .starts_with(super::store::SCRIPT_WORKFLOW_PREFIX)
    {
        return false;
    }
    // Script workflows saved before `allow_mutation` was recorded carry `None`,
    // which the script runner reads as "no mutation".
    let mut normalized = workflow.clone();
    let Some((code, agent_id, preset)) =
        normalized
            .nodes
            .iter_mut()
            .find_map(|node| match &mut node.kind {
                NodeKind::Script {
                    code,
                    agent_id,
                    preset,
                    allow_mutation,
                } => {
                    allow_mutation.get_or_insert(false);
                    Some((code.clone(), agent_id.clone(), *preset))
                }
                _ => None,
            })
    else {
        return false;
    };
    let allow_mutation = normalized.nodes.iter().any(|node| {
        matches!(
            node.kind,
            NodeKind::Script {
                allow_mutation: Some(true),
                ..
            }
        )
    });
    let expected =
        super::script::script_workflow(&code, agent_id.as_deref(), preset, allow_mutation);
    serde_json::to_value(&expected).ok() == serde_json::to_value(&normalized).ok()
}

#[cfg(test)]
#[path = "run_guard_tests.rs"]
mod tests;
