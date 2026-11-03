//! DAG workflow engine for Ryu Core.
//!
//! A workflow is a directed acyclic graph (DAG) of typed nodes. Nodes are
//! connected by edges that carry data and (optionally) a branch label so a
//! `Condition` node can fork execution down a `true`/`false` path.
//!
//! This module owns the *definition* and *graph* layer:
//!   - [`Workflow`] — the persisted definition (nodes + edges).
//!   - [`NodeKind`] — the typed node kinds. Data/logic (Input, Output, Prompt,
//!     Condition, Transform, SetState, Delay, Note, While, Guardrails, Webhook),
//!     orchestration (SubWorkflow, ForEach, Parallel, AgentDelegate, Awakeable),
//!     desktop automation
//!     (Recipe, GhostAction), the **Runnable** nodes that run any executable
//!     Ryu object as a step: Agent, Skill, Mcp, and Plugin, and Code, which
//!     runs or checks a Lean, Bend, or BAML program.
//!   - [`RetryPolicy`] / [`RepeatPolicy`] — per-node policies that re-run one
//!     step on failure, or loop it on its own output.
//!   - [`WorkflowGraph`] — a validated petgraph DAG built from a [`Workflow`].
//!
//! Per the Core-vs-Gateway rule this is **Core**: it decides *what runs*
//! (which node, in what order). It never enforces policy; a `Prompt` node hands
//! its model call to the normal chat routing path.
//!
//! Durable execution lives on this engine directly (Restate was dropped): the
//! in-process topological executor checkpoints file-backed, resumable run state
//! after every node and every `While` loop iteration, so a run survives a Core
//! restart and resumes from the last completed node. See [`durable`] for the
//! engine seam and [`executor`] for the loop/HITL semantics.

pub mod auto_resume;
pub mod channel_send;
#[cfg(test)]
mod concurrency_tests;
pub mod delegation;
pub mod durable;
pub mod executor;
pub mod history;
pub mod limits;
pub mod notify_user;
pub mod script;
pub mod secrets;
pub mod store;
pub mod template;
pub mod templates;
#[cfg(test)]
pub(crate) mod test_support;
pub mod triggers;

pub use executor::{dry_run_workflow, fail_run, fork_run, rerun_run, resume_run};

use std::collections::{HashMap, HashSet};

use petgraph::algo::is_cyclic_directed;
use petgraph::graph::{DiGraph, NodeIndex};
use serde::{Deserialize, Serialize};

// Split by responsibility; every item keeps its `workflow::` path through the
// re-exports below.
mod guardrails;
mod node_kind;
mod persist;
mod policies;
mod references;

pub use self::{guardrails::*, node_kind::*, persist::*, policies::*, references::*};

/// A single node in a workflow definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowNode {
    pub id: String,
    #[serde(flatten)]
    pub kind: NodeKind,
    /// Optional Temporal-style retry policy. Absent = run once (back-compat).
    /// Orthogonal to `kind`: any node type may carry one, though it is most
    /// useful on side-effecting nodes (Tool/Webhook/Prompt/GhostAction).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryPolicy>,
    /// Optional per-node wall-clock execution timeout, in milliseconds (the
    /// Temporal `StartToClose` analogue). When set, a single attempt that
    /// exceeds it is cancelled and surfaced as a *retryable* "timed out" error,
    /// so it composes with `retry`. Absent = unbounded (back-compat).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// Optional loop policy that re-runs this one step on its own output. Absent
    /// = run once (back-compat). See [`RepeatPolicy`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<RepeatPolicy>,
}

/// A directed edge between two nodes, optionally gated on a branch label.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowEdge {
    pub from: String,
    pub to: String,
    /// Branch label. For a `Condition` source, `"true"`/`"false"` selects the
    /// edge to follow. `None` is an unconditional edge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// How a workflow is fired. A workflow may declare any number of triggers; the
/// `create_workflow` handler reconciles them into external resources (scheduler
/// jobs, Composio subscriptions) idempotently on every save.
///
/// Per the Core-vs-Gateway rule this is **Core**: it decides *when* a workflow
/// runs. The trigger declaration carries no policy.
///
/// # Why there is no MCP / skill / plugin / app / integration *trigger* arm
///
/// Steps can already *invoke* all of those ([`NodeKind::Mcp`]/[`NodeKind::Tool`],
/// [`NodeKind::Skill`], [`NodeKind::Plugin`], [`NodeKind::Agent`]). A *trigger*,
/// though, needs a source that can **deliver an event to Core**, and only event
/// sources qualify:
/// - **Composio** delivers via a subscription webhook (`composio_triggers`).
/// - A generic **[`WorkflowTrigger::Webhook`]** covers *any* other integration,
///   app, or service that can POST — the universal "beyond Composio" path
///   (`POST /api/workflows/:id/webhook`, HMAC-authenticated per-trigger secret).
///
/// The remaining candidates have no event source to hang a trigger on: skills are
/// instruction text (they emit nothing), there is no plugin runtime yet
/// (design-only, `AGENTS.md` §4), and the MCP servers in the registry are
/// request/response with no push. Adding trigger arms for those would be dead UI
/// wired to nothing. When one genuinely needs to poll, that is already expressible
/// as `Schedule` + a `Tool`/`Mcp` step + a `Condition` (poll-and-diff) — no new
/// trigger kind required. Revisit only when a real push source appears (e.g. MCP
/// resource-subscriptions, or a plugin runtime that emits events).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkflowTrigger {
    /// Run only on explicit user action (the canvas "Run now" button or the
    /// `POST /workflows/:id/run` endpoint). No external resource is created.
    Manual,
    /// Run on a schedule. Exactly one of `cron`/`every` should be set; `cron`
    /// wins when both are present. Reconciled into a `ScheduledJob` whose target
    /// is `JobTarget::Workflow`.
    Schedule {
        #[serde(default)]
        cron: Option<String>,
        #[serde(default)]
        every: Option<String>,
        /// When true, each scheduled firing waits for a human-in-the-loop
        /// approval (an inbox request, see [`crate::approvals`]) before the
        /// workflow runs. Off by default (autonomous).
        #[serde(default)]
        require_approval: bool,
    },
    /// Run when an HTTP POST hits the workflow's public ingress URL. The URL is a
    /// status surface exposed via the existing webhook-ingress seam; `secret`
    /// (when set) is the HMAC signing secret the caller must use.
    Webhook {
        #[serde(default)]
        secret: Option<String>,
    },
    /// Run when a Composio event fires. Reconciled into a Composio trigger
    /// subscription (`composio_triggers`) whose `target_kind` is `workflow`.
    Composio {
        toolkit: String,
        trigger_slug: String,
        #[serde(default)]
        connected_account_id: Option<String>,
    },
    /// Run when an **app event** fires — an event some installed app declared in
    /// its manifest `contributes.hook_events` and raised through the `events.emit`
    /// kernel capability (`@example/meetings#meeting.ended`).
    ///
    /// This is what makes workflows a first-class *consumer* of the hook system,
    /// alongside plugin hooks: "when a meeting ends, summarize it and file the
    /// notes" stops being bespoke wiring between two apps and becomes a workflow
    /// the user assembles. The event payload arrives as the run's input, so a
    /// workflow reads `meeting.transcript` the same way a manual run reads its
    /// form.
    ///
    /// Like [`WorkflowTrigger::Webhook`] and unlike [`WorkflowTrigger::Schedule`] /
    /// [`WorkflowTrigger::Composio`], this creates **no external resource** and so
    /// needs no reconciliation: the emit path scans saved workflows for a matching
    /// trigger, exactly as the webhook ingress does. That also means a workflow may
    /// subscribe to an event whose provider is not installed yet — it simply never
    /// fires until it is, which is the behaviour you want when a user builds the
    /// automation before installing the app.
    Event {
        /// The fully-qualified event id to subscribe to.
        event: String,
    },
}

/// A persisted workflow definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub nodes: Vec<WorkflowNode>,
    #[serde(default)]
    pub edges: Vec<WorkflowEdge>,
    /// How this workflow is fired. Empty/absent means manual-only (back-compat).
    #[serde(default)]
    pub triggers: Vec<WorkflowTrigger>,
    /// How many independent nodes of one run may execute at the same time.
    /// Absent = [`executor::DEFAULT_NODE_CONCURRENCY`]; clamped to
    /// `1..=`[`executor::MAX_NODE_CONCURRENCY`]. `1` restores strictly
    /// one-node-at-a-time execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrency: Option<u32>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Errors raised while building or validating a [`WorkflowGraph`].
#[derive(Debug)]
pub enum GraphError {
    /// An edge endpoint named a node id that does not exist.
    UnknownNode(String),
    /// The graph is not acyclic.
    Cyclic,
    /// Two nodes share the same id.
    DuplicateNode(String),
    /// A node carries a `repeat` policy its kind cannot honour.
    InvalidRepeat(String, &'static str),
    /// A node's configuration is invalid (e.g. an empty fan-out).
    InvalidNode(String, String),
}

/// A validated DAG built from a [`Workflow`]. Wraps a petgraph [`DiGraph`] and
/// keeps the id↔index mapping needed by the executor.
#[derive(Debug)]
pub struct WorkflowGraph {
    pub graph: DiGraph<WorkflowNode, EdgeData>,
    pub index_by_id: HashMap<String, NodeIndex>,
}

/// Payload carried on a graph edge.
#[derive(Debug, Clone)]
pub struct EdgeData {
    pub branch: Option<String>,
}

impl WorkflowGraph {
    /// Build and validate a DAG from a workflow definition.
    ///
    /// Validates that every edge endpoint exists, node ids are unique, and the
    /// resulting graph is acyclic.
    pub fn build(workflow: &Workflow) -> Result<Self, GraphError> {
        let mut graph: DiGraph<WorkflowNode, EdgeData> = DiGraph::new();
        let mut index_by_id: HashMap<String, NodeIndex> = HashMap::new();

        for node in &workflow.nodes {
            if index_by_id.contains_key(&node.id) {
                return Err(GraphError::DuplicateNode(node.id.clone()));
            }
            validate_repeat(node)?;
            validate_fanout(node, &workflow.id)?;
            validate_guardrail_checks(node)?;
            let idx = graph.add_node(node.clone());
            index_by_id.insert(node.id.clone(), idx);
        }

        for edge in &workflow.edges {
            let from = *index_by_id
                .get(&edge.from)
                .ok_or_else(|| GraphError::UnknownNode(edge.from.clone()))?;
            let to = *index_by_id
                .get(&edge.to)
                .ok_or_else(|| GraphError::UnknownNode(edge.to.clone()))?;
            graph.add_edge(
                from,
                to,
                EdgeData {
                    branch: edge.branch.clone(),
                },
            );
        }

        if is_cyclic_directed(&graph) {
            return Err(GraphError::Cyclic);
        }

        Ok(Self { graph, index_by_id })
    }

    /// Node indices with no incoming edges (entry points of the DAG).
    pub fn roots(&self) -> Vec<NodeIndex> {
        self.graph
            .node_indices()
            .filter(|&n| {
                self.graph
                    .neighbors_directed(n, petgraph::Direction::Incoming)
                    .next()
                    .is_none()
            })
            .collect()
    }
}

impl std::fmt::Display for GraphError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownNode(id) => write!(f, "edge references unknown node id: {id}"),
            Self::Cyclic => write!(f, "workflow contains a cycle; a DAG must be acyclic"),
            Self::DuplicateNode(id) => write!(f, "duplicate node id: {id}"),
            Self::InvalidRepeat(id, reason) => {
                write!(f, "node '{id}' cannot repeat: {reason}")
            }
            Self::InvalidNode(id, reason) => write!(f, "node '{id}' is invalid: {reason}"),
        }
    }
}

impl std::error::Error for GraphError {}

#[cfg(test)]
mod tests;
