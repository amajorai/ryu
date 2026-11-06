//! What a workflow references: its chat entry point, the agents and nested
//! workflows it runs, and the revision a save was based on.

use super::*;

/// Whether a workflow can be driven from a chat composer — the "has a chat
/// input" signal the composer filters on and the `workflow_id` chat-turn gate
/// enforces.
///
/// Read off the graph rather than a schema flag: a workflow is chat-triggerable
/// iff at least one *root* node (no incoming edges) is an [`NodeKind::Input`]
/// node — i.e. the run consumes a value from its initial input map. A workflow
/// whose entry point never reads the run input would silently ignore everything
/// the user types, so offering only these keeps the chat surface honest. Derived
/// means an author who adds an `Input` node gets the chat target for free; an
/// un-runnable definition (invalid DAG) simply reports `false`.
pub fn accepts_chat_input(workflow: &Workflow) -> bool {
    let graph = match WorkflowGraph::build(workflow) {
        Ok(g) => g,
        Err(_) => return false,
    };
    graph
        .roots()
        .iter()
        .any(|&idx| matches!(&graph.graph[idx].kind, NodeKind::Input { .. }))
}

/// Return every explicitly configured agent referenced by a workflow node.
/// Plugin runnables remain governed at their own dispatch boundary because a
/// plugin manifest can resolve its agent at runtime rather than in the graph.
pub fn referenced_agent_ids(workflow: &Workflow) -> Vec<String> {
    let mut ids: Vec<String> = workflow
        .nodes
        .iter()
        .flat_map(node_agent_ids)
        .map(str::to_owned)
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// Every non-blank agent id a single node names explicitly.
fn node_agent_ids(node: &WorkflowNode) -> Vec<&str> {
    let ids: Vec<&str> = match &node.kind {
        NodeKind::Prompt { agent_id, .. }
        | NodeKind::Skill { agent_id, .. }
        | NodeKind::Script { agent_id, .. } => agent_id.as_deref().into_iter().collect(),
        NodeKind::Agent { agent_id, .. } => vec![agent_id.as_str()],
        NodeKind::AgentDelegate { delegates, .. } => delegates
            .iter()
            .filter_map(|delegate| delegate.agent_id.as_deref())
            .collect(),
        _ => Vec::new(),
    };
    ids.into_iter().filter(|id| !id.trim().is_empty()).collect()
}

/// Reject a workflow that would invoke a draft or trial agent. Workflows are
/// non-interactive execution, so even a manually-started workflow cannot be a
/// trial surface; trial evaluation belongs in the foreground chat composer.
pub async fn ensure_agents_active(workflow: &Workflow) -> Result<(), String> {
    let Some(store) = crate::agents::global() else {
        return Ok(());
    };
    let mut workflow_ids = HashSet::new();
    let mut agent_ids = Vec::new();
    collect_referenced_agents(workflow, &mut workflow_ids, &mut agent_ids)?;
    agent_ids.sort_unstable();
    agent_ids.dedup();
    for agent_id in agent_ids {
        let record = store
            .get(&agent_id)
            .await
            .map_err(|error| format!("could not inspect agent '{agent_id}': {error}"))?
            .ok_or_else(|| format!("workflow references unknown agent '{agent_id}'"))?;
        if record.lifecycle_status != crate::agents::AgentLifecycleStatus::Active {
            return Err(format!(
                "agent '{}' is {} and cannot run in a workflow; promote it to Active first",
                record.name,
                record.lifecycle_status.as_str()
            ));
        }
    }
    Ok(())
}

fn collect_referenced_agents(
    workflow: &Workflow,
    visited_workflows: &mut HashSet<String>,
    agent_ids: &mut Vec<String>,
) -> Result<(), String> {
    if !visited_workflows.insert(workflow.id.clone()) {
        return Ok(());
    }
    agent_ids.extend(referenced_agent_ids(workflow));

    for nested_id in workflow.nodes.iter().flat_map(nested_workflow_ids) {
        let nested = store::load_workflow(nested_id).map_err(|error| {
            format!(
                "workflow '{}' references nested workflow '{}': {error}",
                workflow.id, nested_id
            )
        })?;
        collect_referenced_agents(&nested, visited_workflows, agent_ids)?;
    }
    Ok(())
}

/// Every workflow id a node runs as a nested child workflow.
pub fn nested_workflow_ids(node: &WorkflowNode) -> Vec<&str> {
    match &node.kind {
        NodeKind::SubWorkflow { workflow_id } => vec![workflow_id.as_str()],
        NodeKind::While {
            body_workflow_id: Some(workflow_id),
            ..
        }
        | NodeKind::ForEach {
            body_workflow_id: workflow_id,
            ..
        } => vec![workflow_id.as_str()],
        NodeKind::Parallel { branches, .. } => branches
            .iter()
            .map(|branch| branch.workflow_id.as_str())
            .collect(),
        _ => Vec::new(),
    }
}

/// Whether a workflow reaches any resource that per-resource ACLs would have
/// to govern: another workflow, a configured agent, or a tool dispatch.
///
/// Organization-bound nodes refuse to store such workflows until resource ACL
/// propagation exists, because a run only checks `workflow.run` on the outer
/// workflow. Definitions stored before binding are refused again at run time
/// by [`super::ensure_runnable_on_this_node`]. The predicate is derived from [`nested_workflow_ids`] and the
/// explicit agent references so a node kind that gains a reference is covered
/// automatically; the remaining kinds dispatch tools, agents or runnables
/// chosen at run time (Script picks agent ids in its body, Plugin resolves a
/// runnable, Recipe and GhostAction call ghost tools without the approval gate).
pub fn has_unscoped_managed_nodes(workflow: &Workflow) -> bool {
    workflow.nodes.iter().any(|node| {
        !nested_workflow_ids(node).is_empty()
            || !node_agent_ids(node).is_empty()
            || matches!(
                &node.kind,
                NodeKind::SubWorkflow { .. }
                    | NodeKind::ForEach { .. }
                    | NodeKind::Parallel { .. }
                    | NodeKind::Tool { .. }
                    | NodeKind::Mcp { .. }
                    | NodeKind::Agent { .. }
                    | NodeKind::AgentDelegate { .. }
                    | NodeKind::Script { .. }
                    | NodeKind::Plugin { .. }
                    | NodeKind::Recipe { .. }
                    | NodeKind::GhostAction { .. }
            )
    })
}

/// Whether `incoming` was edited from the revision currently stored.
///
/// A client that re-saves a workflow it loaded sends back the `updated_at` it
/// loaded. When another member of a shared node has saved since, that value no
/// longer matches and the save must be refused rather than silently overwriting
/// their work. A save without `updated_at`, or of a workflow that does not exist
/// yet, is not guarded. Returns the stored revision on conflict.
pub fn stale_revision(stored: Option<&Workflow>, incoming: &Workflow) -> Option<Option<String>> {
    let expected = incoming.updated_at.as_deref()?;
    let stored = stored?;
    (stored.updated_at.as_deref() != Some(expected)).then(|| stored.updated_at.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::test_support::{node, workflow};

    fn revision(updated_at: Option<&str>) -> Workflow {
        serde_json::from_value(serde_json::json!({
            "id": "wf_shared",
            "name": "shared",
            "nodes": [],
            "updated_at": updated_at,
        }))
        .expect("minimal workflow deserializes")
    }

    #[test]
    fn stale_revision_refuses_saves_based_on_an_older_revision() {
        let stored = revision(Some("2026-09-29T10:00:01Z"));
        // Saved from the current revision: allowed.
        assert_eq!(
            stale_revision(Some(&stored), &revision(Some("2026-09-29T10:00:01Z"))),
            None
        );
        // Another member saved after this client loaded: conflict, and the caller
        // learns the revision it must reload.
        assert_eq!(
            stale_revision(Some(&stored), &revision(Some("2026-09-29T09:59:00Z"))),
            Some(Some("2026-09-29T10:00:01Z".to_owned()))
        );
        // Unguarded saves and first saves keep the historic behavior.
        assert_eq!(stale_revision(Some(&stored), &revision(None)), None);
        assert_eq!(
            stale_revision(None, &revision(Some("2026-09-29T09:59:00Z"))),
            None
        );
    }

    #[test]
    fn referenced_agent_ids_covers_explicit_agent_nodes() {
        let workflow = workflow(
            "wf_agents",
            "agents",
            vec![
                node(
                    "prompt",
                    NodeKind::Prompt {
                        prompt: "one".into(),
                        agent_id: Some("agent_prompt".into()),
                    },
                ),
                node(
                    "agent",
                    NodeKind::Agent {
                        agent_id: "agent_direct".into(),
                        task: None,
                    },
                ),
                node(
                    "skill",
                    NodeKind::Skill {
                        skill: "research".into(),
                        agent_id: Some("agent_skill".into()),
                        task: None,
                    },
                ),
                node(
                    "delegation",
                    NodeKind::AgentDelegate {
                        delegates: vec![delegation::DelegateSpec {
                            id: "delegate".into(),
                            task: "work".into(),
                            agent_id: Some("agent_delegate".into()),
                            preset: Default::default(),
                            inline: None,
                        }],
                        caps: None,
                    },
                ),
            ],
            Vec::new(),
        );

        assert_eq!(
            referenced_agent_ids(&workflow),
            vec![
                "agent_delegate",
                "agent_direct",
                "agent_prompt",
                "agent_skill",
            ]
        );
    }

    fn single(kind: NodeKind) -> Workflow {
        workflow("wf_a", "a", vec![node("n", kind)], Vec::new())
    }

    fn reaching_kinds() -> Vec<(&'static str, NodeKind)> {
        vec![
            (
                "while body",
                NodeKind::While {
                    expr: "input == go".into(),
                    body_workflow_id: Some("wf_b".into()),
                    max_iterations: Some(1),
                },
            ),
            (
                "skill with agent",
                NodeKind::Skill {
                    skill: "research".into(),
                    agent_id: Some("agent_x".into()),
                    task: None,
                },
            ),
            (
                "plugin",
                NodeKind::Plugin {
                    plugin_id: "com.example.app".into(),
                    runnable_id: "wf".into(),
                    args: serde_json::Value::Null,
                },
            ),
            (
                "script without agent",
                NodeKind::Script {
                    code: "return await agent({agent_id: 'agent_x'})".into(),
                    agent_id: None,
                    preset: None,
                    allow_mutation: None,
                },
            ),
            (
                "agent delegate",
                NodeKind::AgentDelegate {
                    delegates: vec![delegation::DelegateSpec {
                        id: "d".into(),
                        task: "work".into(),
                        agent_id: Some("agent_x".into()),
                        preset: Default::default(),
                        inline: None,
                    }],
                    caps: None,
                },
            ),
            (
                "recipe",
                NodeKind::Recipe {
                    recipe: "send-email".into(),
                    params: serde_json::Value::Null,
                },
            ),
            (
                "ghost action",
                NodeKind::GhostAction {
                    action: "click".into(),
                    target: serde_json::Value::Null,
                    params: serde_json::Value::Null,
                },
            ),
        ]
    }

    #[test]
    fn unscoped_guard_covers_every_reference_and_dispatching_kind() {
        for (label, kind) in reaching_kinds() {
            assert!(
                has_unscoped_managed_nodes(&single(kind)),
                "{label} must be refused on an org-bound node"
            );
        }
    }

    #[test]
    fn unscoped_guard_allows_self_contained_graphs() {
        let gate = single(NodeKind::While {
            expr: "input == go".into(),
            body_workflow_id: None,
            max_iterations: None,
        });
        assert!(!has_unscoped_managed_nodes(&gate));
        let skill = single(NodeKind::Skill {
            skill: "research".into(),
            agent_id: None,
            task: None,
        });
        assert!(!has_unscoped_managed_nodes(&skill));
        let plain = single(NodeKind::Prompt {
            prompt: "hi".into(),
            agent_id: None,
        });
        assert!(!has_unscoped_managed_nodes(&plain));
    }

    #[test]
    fn unscoped_guard_covers_every_nested_workflow_and_agent_reference() {
        for (_, kind) in reaching_kinds() {
            let candidate = single(kind);
            let references = candidate
                .nodes
                .iter()
                .any(|n| !nested_workflow_ids(n).is_empty())
                || !referenced_agent_ids(&candidate).is_empty();
            assert!(!references || has_unscoped_managed_nodes(&candidate));
        }
    }
}
