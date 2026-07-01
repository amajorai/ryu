//! DAG workflow engine for Ryu Core.
//!
//! A workflow is a directed acyclic graph (DAG) of typed nodes. Nodes are
//! connected by edges that carry data and (optionally) a branch label so a
//! `Condition` node can fork execution down a `true`/`false` path.
//!
//! This module owns the *definition* and *graph* layer:
//!   - [`Workflow`] — the persisted definition (nodes + edges).
//!   - [`NodeKind`] — the core node types (Prompt, Condition, Transform, Tool,
//!     Input, Output, Webhook, Delay, SubWorkflow, AgentDelegate).
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

pub mod delegation;
pub mod durable;
pub mod executor;
pub mod store;
pub mod template;
pub mod triggers;

pub use executor::{fail_run, resume_run};

use std::collections::HashMap;

use petgraph::algo::is_cyclic_directed;
use petgraph::graph::{DiGraph, NodeIndex};
use serde::{Deserialize, Serialize};

/// The kind of a workflow node. Each variant carries the config it needs to run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NodeKind {
    /// Entry node: surfaces a named value from the run's initial input map.
    Input {
        /// Key to read from the run input. Defaults to the node id when absent.
        #[serde(default)]
        key: Option<String>,
    },
    /// Terminal node: records its incoming value into the run output map.
    Output {
        /// Key to write into the run output. Defaults to the node id when absent.
        #[serde(default)]
        key: Option<String>,
    },
    /// Calls an LLM with a prompt template, hands the model call to chat routing.
    Prompt {
        /// Prompt template. `{{input}}` is replaced with the incoming value.
        prompt: String,
        /// Optional agent id to route to (defaults to the built-in plain LLM).
        #[serde(default)]
        agent_id: Option<String>,
    },
    /// Branches on a boolean expression evaluated against the incoming value.
    Condition {
        /// A simple expression, e.g. `input == "yes"`, `input contains "ok"`,
        /// `input != ""`. See [`executor::eval_condition`].
        expr: String,
    },
    /// Pure data transform on the incoming value.
    Transform {
        /// Operation name: `uppercase`, `lowercase`, `trim`, `json_parse`,
        /// `template` (uses `template` field), or `identity`.
        op: String,
        /// Template body for the `template` op; `{{input}}` is substituted.
        #[serde(default)]
        template: Option<String>,
    },
    /// Invokes a Core tool/sidecar through the MCP registry.
    Tool {
        /// Fully-qualified tool id (`<server>__<tool>`, e.g. `spider__crawl`).
        /// A bare server name with no `__` is rejected at run time.
        name: String,
        /// Free-form JSON args passed to the tool.
        #[serde(default)]
        args: serde_json::Value,
    },
    /// Posts the incoming value to an external URL (fire-and-forward webhook).
    Webhook {
        url: String,
        #[serde(default = "default_webhook_method")]
        method: String,
    },
    /// Writes a value into the run's `state` map under `key`, then passes the
    /// incoming input through unchanged to outgoing edges. The `value` is a
    /// template resolved against the current context (so it can capture an
    /// upstream node's output, `{{input}}`, prior state, or a trigger field).
    /// Readable downstream as `{{state.<key>}}`.
    SetState { key: String, value: String },
    /// Pauses execution for a fixed number of milliseconds, as a **durable
    /// timer**. On first reaching the node the executor computes and persists a
    /// `wake_at` instant ([`store::NodeRunState::wake_at`]) and checkpoints
    /// before sleeping, so a Core crash mid-sleep resumes with only the
    /// *remaining* time instead of restarting the full delay (Restate/Temporal
    /// durable-timer parity — the timer is journaled, not an in-memory
    /// `setTimeout`).
    Delay { ms: u64 },
    /// Documentation-only annotation. Carries no behaviour: at run time it
    /// forwards its incoming value unchanged to outgoing edges and produces no
    /// run output. Useful for labelling regions of a canvas.
    Note { text: String },
    /// A guarded loop / branch gate. Evaluates `expr` (the same tiny grammar as
    /// [`NodeKind::Condition`], with `{{...}}` tokens resolved first).
    ///
    /// # Two forms
    ///
    /// **1. Real bounded loop (`body_workflow_id` set).** The node re-executes the
    /// named body workflow as long as `expr` holds, up to
    /// [`executor::MAX_WHILE_ITERATIONS`]. Iteration is implemented as recursion
    /// (each iteration runs as its own [`store::WorkflowRun`] via the same path as
    /// [`NodeKind::SubWorkflow`]), so the outer DAG never gains a cycle and DAG
    /// validation is untouched. The **carry** is the loop variable: it is seeded
    /// with the node's incoming value, the condition is evaluated against the carry
    /// (use the `input` keyword, e.g. `input < 10`), and each iteration's body
    /// output replaces the carry. On exit the node produces the final carry as a
    /// plain data value (a looped `While` is a data node, not a brancher — its
    /// single forward edge should be unlabelled). The iteration counter persists to
    /// the run `state` (keyed `state["__while_<id>"]`) and is checkpointed to disk
    /// after every iteration, so a loop survives a Core restart and resumes from
    /// the persisted iteration.
    ///
    /// **At-least-once, not exactly-once:** a side-effecting body node
    /// (Tool/Webhook/GhostAction/Prompt) interrupted mid-call re-runs on resume.
    /// An `Awakeable` gate inside a loop body is rejected in v1 (the node fails with
    /// a clear error); propagating a mid-loop suspend is future work.
    ///
    /// **2. One-shot branch gate (`body_workflow_id` absent — back-compat).** With
    /// no body the node behaves as a `Condition`-style gate: it evaluates `expr`
    /// once and activates only the matching `true`/`false` outgoing edges. The
    /// per-node counter + [`executor::MAX_WHILE_ITERATIONS`] cap still apply but,
    /// under the single-visit traversal, the gate is reached at most once.
    ///
    /// The on-canvas back-edge loop (author draws body→`While` directly on the
    /// graph) is deferred — v1 ships the explicit `body_workflow_id` form where the
    /// loop body is authored as a separate sub-workflow.
    While {
        expr: String,
        /// When set, the id of the workflow run repeatedly as the loop body. When
        /// absent the node is a one-shot branch gate (back-compat).
        #[serde(default)]
        body_workflow_id: Option<String>,
        /// Optional per-node ceiling on loop iterations. Absent = the engine
        /// default [`executor::MAX_WHILE_ITERATIONS`]. Always clamped to that
        /// hard maximum so a workflow can lower the bound but never raise it past
        /// the safety cap (a runaway-loop backstop). Ignored by the one-shot gate
        /// form (`body_workflow_id` absent), which is reached at most once anyway.
        #[serde(default)]
        max_iterations: Option<u64>,
    },
    /// Routes the incoming text through the Gateway firewall (the moat owns
    /// "what is allowed", per the Core-vs-Gateway rule) and fails the run when a
    /// requested guardrail trips. `checks` is the set of guardrails to enforce
    /// (e.g. `["pii", "jailbreak"]`); on PASS the incoming value is forwarded
    /// unchanged. Core enforces no policy locally — it asks the Gateway.
    Guardrails {
        /// Guardrail names to enforce: `pii`, `jailbreak`, `moderation`. Mapped
        /// to the Gateway firewall's scan categories server-side.
        #[serde(default)]
        checks: Vec<String>,
    },
    /// Runs another persisted workflow by id and forwards its output.
    SubWorkflow { workflow_id: String },
    /// Delegates work to one or more sub-agents that run with a clean context
    /// (no parent history), under a permission preset and depth/concurrency/
    /// token/wall-time caps. Same-depth delegates run concurrently. The node's
    /// output is the JSON array of per-delegate results.
    ///
    /// See [`delegation`] for the engine and presets.
    AgentDelegate {
        /// The sibling delegates to fan out. Each gets the node input appended
        /// to its `task` so the delegate sees upstream context as clean input.
        delegates: Vec<delegation::DelegateSpec>,
        /// Optional caps override (concurrency clamped to the hard max).
        #[serde(default)]
        caps: Option<delegation::DelegationCaps>,
    },
    /// A durable pause/human-in-the-loop gate — the **Temporal Signal /
    /// Restate Durable Promise** analogue (an external trigger resumes a
    /// suspended run). When the executor reaches this node it suspends the run
    /// (setting status to `AwaitingInput`) and persists to disk. The run resumes
    /// when an external actor calls the resume endpoint
    /// (`POST /workflows/runs/:run_id/resume`) with a payload; the payload
    /// becomes the node's output and execution continues downstream. A suspend
    /// is never treated as a retryable error, so a `retry` policy on this node
    /// does not re-fire the gate.
    ///
    /// # Core-vs-Gateway
    ///
    /// This node decides *what runs* (suspend vs continue) — it lives in Core.
    /// Whether the resumed action is *allowed* is a Gateway concern and is
    /// evaluated when the resumed step makes its model/tool call.
    ///
    /// # Restate mapping
    ///
    /// In a Restate-backed deployment this node maps to a Restate Awakeable: the
    /// executor registers an Awakeable ID, suspends until the ID is completed by
    /// the resume endpoint calling the Restate `awakeable/resolve` API. In the
    /// `FallbackEngine` (default, no Restate) the same semantics are achieved via
    /// the file-backed run store: the run is persisted with `status =
    /// awaiting_input` and resumed by re-invoking `run_workflow` after the gate's
    /// persisted state is flipped to `Completed`.
    Awakeable {
        /// Human-readable prompt sent back to the caller in the suspended run's
        /// state, so the UI can display what input is expected.
        #[serde(default)]
        prompt: Option<String>,
    },
    /// Replays a ghost **recipe** — a parameterized, recorded native-desktop
    /// automation (ghost-os parity: a frontier model records it once, the
    /// workflow runs it forever). The node feeds `params` to `ghost_run` through
    /// the live ghost engine; each value is a template (`{{input}}`,
    /// `{{nodes.<id>}}`, `{{state.<key>}}`, `{{trigger.*}}`) resolved before
    /// replay, so a recorded "send email" recipe can be driven by upstream data.
    /// Decides *what runs* (which recorded actions) → Core, alongside the engine.
    Recipe {
        /// The installed recipe's name (its `~/.ghost/recipes/<name>.json` stem).
        recipe: String,
        /// Parameter map for `{{param}}` substitution. String values are resolved
        /// as templates against the run context before replay.
        #[serde(default)]
        params: serde_json::Value,
    },
    /// Executes a **single** recorded native-desktop action through the ghost
    /// engine — the per-step node that lets a recorded automation appear in the
    /// canvas as a visible flow (one node per click/type/scroll) rather than one
    /// opaque [`NodeKind::Recipe`]. The executor maps `action` to the matching
    /// ghost MCP action tool (`ghost__ghost_click`, `ghost__ghost_type`, …) — the
    /// same primitives the recipe replay loop calls (`apps/ghost/src/tools/recipes.rs`
    /// `execute_step`), so a node behaves identically to that step inside a replay.
    /// String fields of `target`/`params` are templates (`{{input}}`,
    /// `{{nodes.<id>}}`, `{{state.<key>}}`, `{{trigger.*}}`) resolved before the call.
    /// Decides *what runs* (which recorded action) → Core, alongside the engine.
    GhostAction {
        /// The recorded action verb: `click`, `type`, `scroll`, `press`, `hotkey`,
        /// `focus`, `hover`, `long_press`, `drag`, `double_click`, `window`,
        /// `wait`/`delay`/`sleep`, `screenshot`.
        action: String,
        /// The recorded element locator (`{ query, role, identifier, app, dom_id,
        /// dom_class }`). Empty/absent for screen-relative or app-level actions.
        #[serde(default)]
        target: serde_json::Value,
        /// Action parameters (`{ text }` for type, `{ key }` for press,
        /// `{ direction, amount }` for scroll, `{ keys }` for hotkey, …).
        #[serde(default)]
        params: serde_json::Value,
    },
}

fn default_webhook_method() -> String {
    "POST".to_string()
}

/// A Temporal-style retry policy for a single node. Optional and opt-in: a node
/// with no policy runs exactly once (the historical behaviour). When present, a
/// retryable error re-runs the node up to `max_attempts` times with exponential
/// backoff between attempts.
///
/// The attempt counter persists in [`store::NodeRunState::attempts`], so the
/// budget is *total* across a Core restart, not per-process. The budget is **per
/// unique node per run**: a `While` loop body is a separate sub-run each
/// iteration, so each iteration spends its own independent budget. An
/// `Awakeable` suspend is never a retryable error. Per the Core-vs-Gateway rule
/// this is **Core**: it decides *what runs* (whether to re-run a step), not policy.
///
/// Defaults (mirroring Temporal's `RetryPolicy`): `backoff_coefficient = 2.0`,
/// `initial_interval_ms = 100`, `max_interval_ms = 60_000`. `max_attempts`
/// defaults to 1 so a bare `"retry": {}` is inert until a caller raises it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RetryPolicy {
    /// Maximum total execution attempts (retries = `max_attempts - 1`). Clamped
    /// to at least 1 at run time. Default 1 (run once, no retries).
    pub max_attempts: u32,
    /// Backoff before the first retry, in milliseconds. Default 100.
    pub initial_interval_ms: u64,
    /// Multiplicative backoff growth per retry. Default 2.0 (exponential):
    /// `interval(n) = min(initial * coefficient^(n-1), max_interval)`.
    pub backoff_coefficient: f64,
    /// Ceiling on the computed backoff interval, in milliseconds. Default 60_000.
    pub max_interval_ms: u64,
    /// Optional bounded jitter as a fraction of the computed backoff, in
    /// `[0.0, 1.0]`. The actual sleep is scattered by `±(jitter_fraction * r)`
    /// to avoid retry storms. Default 0.0 (no jitter); out-of-range = ignored.
    #[serde(default)]
    pub jitter_fraction: f64,
    /// Error substrings (case-insensitive) that must NOT be retried — a fast
    /// fail for known-unrecoverable errors. Substring match, not regex. Default
    /// empty (every error is retryable until the budget is spent).
    #[serde(default)]
    pub non_retryable_errors: Vec<String>,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 1,
            initial_interval_ms: 100,
            backoff_coefficient: 2.0,
            max_interval_ms: 60_000,
            jitter_fraction: 0.0,
            non_retryable_errors: Vec::new(),
        }
    }
}

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
        }
    }
}

impl std::error::Error for GraphError {}

/// Validate, stamp, persist, and reconcile a workflow definition — the single
/// write path shared by the REST `create_workflow` handler and the chat-driven
/// [`crate::runnable::workflow_builder`] tools, so both behave identically
/// (including Composio trigger reconciliation; no chat-vs-canvas drift).
///
/// Steps: reject an invalid DAG, mint a `wf_…` id when empty, stamp
/// `created_at`/`updated_at`, write the file, then reconcile declared triggers
/// into external resources (scheduler jobs + Composio subscriptions). The
/// reconcile step is best-effort — it never fails the save, mirroring the prior
/// handler behaviour. Returns the persisted workflow (with its final id/stamps).
pub async fn persist_workflow(mut workflow: Workflow) -> Result<Workflow, String> {
    // Validate the DAG before persisting so callers never store a broken graph.
    WorkflowGraph::build(&workflow).map_err(|e| e.to_string())?;

    if workflow.id.is_empty() {
        workflow.id = format!("wf_{}", uuid::Uuid::new_v4().simple());
    }
    let now = chrono::Utc::now().to_rfc3339();
    if workflow.created_at.is_none() {
        workflow.created_at = Some(now.clone());
    }
    workflow.updated_at = Some(now);

    store::save_workflow(&workflow).map_err(|e| e.to_string())?;
    reconcile_triggers(&workflow).await;
    Ok(workflow)
}

/// Reconcile a workflow's declared triggers into the external resources that
/// fire it. Idempotent and best-effort (logs and swallows errors):
///   - Schedule triggers → deterministic `wf-sched-<id>-*` scheduler jobs.
///   - Composio triggers → workflow-target Composio subscriptions.
/// Manual / Webhook declare no external resource here.
pub async fn reconcile_triggers(workflow: &Workflow) {
    // Schedules are local + fast, so reconcile inline.
    triggers::apply_schedule_reconcile(&workflow.id, &workflow.name, &workflow.triggers);

    // Composio reconcile makes a network call per subscription; keep it
    // best-effort and inline so a save reflects the declared set, but never let
    // it surface an error to the caller.
    let Some(store) = crate::composio_triggers::global() else {
        return;
    };
    // Replace the workflow's existing composio subs with the declared set
    // (simplest convergent strategy: drop all, re-create the current ones).
    if let Err(e) = store.delete_for_workflow(&workflow.id).await {
        tracing::warn!(workflow = %workflow.id, error = %e, "clearing prior composio workflow subs");
    }
    for trigger in &workflow.triggers {
        if let WorkflowTrigger::Composio {
            toolkit,
            trigger_slug,
            connected_account_id,
        } = trigger
        {
            let Some(account) = connected_account_id.as_deref() else {
                tracing::warn!(
                    workflow = %workflow.id,
                    slug = %trigger_slug,
                    "composio workflow trigger missing connected_account_id; skipping subscribe"
                );
                continue;
            };
            if let Err(e) = store
                .subscribe_workflow(
                    &workflow.id,
                    toolkit,
                    trigger_slug,
                    account,
                    serde_json::json!({}),
                )
                .await
            {
                tracing::warn!(workflow = %workflow.id, slug = %trigger_slug, error = %e, "composio workflow subscribe failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, kind: NodeKind) -> WorkflowNode {
        WorkflowNode {
            id: id.to_string(),
            retry: None,
            timeout_ms: None,
            kind,
        }
    }

    fn linear_workflow() -> Workflow {
        Workflow {
            id: "wf1".into(),
            name: "linear".into(),
            description: None,
            nodes: vec![
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
            edges: vec![
                WorkflowEdge {
                    from: "in".into(),
                    to: "up".into(),
                    branch: None,
                },
                WorkflowEdge {
                    from: "up".into(),
                    to: "out".into(),
                    branch: None,
                },
            ],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        }
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
        wf.edges.push(WorkflowEdge {
            from: "out".into(),
            to: "in".into(),
            branch: None,
        });
        let err = WorkflowGraph::build(&wf).expect_err("cycle must be rejected");
        assert!(matches!(err, GraphError::Cyclic));
    }

    #[test]
    fn rejects_unknown_edge() {
        let mut wf = linear_workflow();
        wf.edges.push(WorkflowEdge {
            from: "in".into(),
            to: "ghost".into(),
            branch: None,
        });
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
}
