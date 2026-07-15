//! Topological executor for the petgraph DAG engine.
//!
//! Execution model:
//!   - Nodes run in dependency order (a node runs once all its *active* incoming
//!     edges have produced a value).
//!   - A node's input is the value carried on its first satisfied incoming edge
//!     (single-input model; fan-in concatenates incoming values with `\n`).
//!   - A `Condition` node evaluates its expression and activates only the
//!     matching `true`/`false` outgoing edges; the other branch is pruned, and
//!     any node left with no active incoming edge is `Skipped`.
//!   - After every node the run state is persisted so the run is resumable.
//!
//! This is **Core**: it decides what runs. The `Prompt` node hands its model
//! call to the OpenAI-compatible default route; it does not enforce policy.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use petgraph::graph::NodeIndex;
use petgraph::visit::EdgeRef;
use petgraph::Direction;

use super::store::{self, NodeRunState, NodeStatus, RunStatus, WorkflowRun};
use super::{delegation, NodeKind, Workflow, WorkflowGraph};

/// Sentinel error value returned by `execute_node` for an `Awakeable` gate (and a
/// `NotifyUser` node whose ack policy requires waiting). The outer loop treats
/// this as a suspend signal rather than a real error.
pub(crate) const SUSPEND_SENTINEL: &str = "__AWAKEABLE_SUSPEND__";

/// Maximum nested SubWorkflow depth, guards against accidental deep nesting.
const MAX_SUBWORKFLOW_DEPTH: usize = 8;

/// Defensive cap on how many times a single `While` gate may take its continue
/// (`true`) branch before it is forced to exit (`false`). Under today's
/// single-visit Kahn traversal a `While` is evaluated at most once per run, so
/// this cap is inert; it exists so that a future looping executor (which would
/// re-enter the gate) cannot run away. See the [`NodeKind::While`] doc.
pub const MAX_WHILE_ITERATIONS: u64 = 100;

/// Decide a `While` gate against an explicit iteration cap. Pure so it is unit
/// testable without an executor or gateway.
///
/// Given the current counter value, whether the resolved condition holds, and the
/// effective cap, returns `(take_true_branch, next_counter)`:
///   - condition holds AND `counter < cap` → continue (`true`), counter incremented.
///   - condition holds but the cap is reached → exit (`false`), counter unchanged
///     (the cap stops the loop).
///   - condition fails → exit (`false`), counter reset to 0 so a later re-entry
///     starts fresh.
///
/// The `cap` is the node's `max_iterations` clamped to [`MAX_WHILE_ITERATIONS`]
/// by [`effective_while_cap`] — a workflow can lower the bound but never raise it
/// past the hard safety maximum.
pub fn decide_while_capped(counter: u64, condition_holds: bool, cap: u64) -> (bool, u64) {
    if condition_holds {
        if counter < cap {
            (true, counter + 1)
        } else {
            (false, counter)
        }
    } else {
        (false, 0)
    }
}

/// Resolve a `While` node's effective iteration cap: its optional
/// `max_iterations` override clamped to the hard [`MAX_WHILE_ITERATIONS`]
/// ceiling, defaulting to the ceiling when unset. A `Some(0)` is treated as the
/// default rather than an instantly-exiting loop, since a zero cap is almost
/// certainly a misconfiguration.
pub fn effective_while_cap(max_iterations: Option<u64>) -> u64 {
    match max_iterations {
        Some(n) if n > 0 => n.min(MAX_WHILE_ITERATIONS),
        _ => MAX_WHILE_ITERATIONS,
    }
}

/// Back-compat wrapper for [`decide_while_capped`] using the engine default cap.
pub fn decide_while(counter: u64, condition_holds: bool) -> (bool, u64) {
    decide_while_capped(counter, condition_holds, MAX_WHILE_ITERATIONS)
}

/// Run a workflow to completion, persisting resumable state after each node.
///
/// If `resume_run` is provided, already-`Completed` nodes are skipped and their
/// recorded output is reused; otherwise a fresh run is created.
pub async fn run_workflow(
    workflow: &Workflow,
    input: HashMap<String, String>,
    run_id: String,
) -> Result<WorkflowRun, String> {
    run_workflow_inner(workflow, input, run_id, 0).await
}

/// Resume a workflow run suspended at its `Awakeable` gate: flip the gate node to
/// `Completed` carrying `payload`, persist, then re-invoke the executor (which
/// skips the now-completed gate and continues downstream). This is the reusable
/// core of the HTTP resume handler, also called by the approval engine when a
/// workflow-gate request is approved — so an approved resume is byte-identical to
/// a manual one.
pub async fn resume_run(run_id: &str, payload: String) -> Result<WorkflowRun, String> {
    use store::{NodeRunState, NodeStatus, RunStatus};

    let mut run = store::load_run(run_id).map_err(|_| "run not found".to_string())?;
    if run.status != RunStatus::AwaitingInput {
        return Err(format!(
            "run '{run_id}' is not awaiting input (status: {:?})",
            run.status
        ));
    }
    let gate_node_id = run
        .awaiting_node
        .clone()
        .ok_or_else(|| "run is awaiting_input but awaiting_node is unset".to_string())?;
    let workflow = store::load_workflow(&run.workflow_id)
        .map_err(|_| format!("workflow '{}' not found", run.workflow_id))?;

    // Preserve the gate's attempts/wake_at (a resume must not reset run-state the
    // retry/durable-timer machinery owns).
    let (gate_attempts, gate_wake_at) = run
        .nodes
        .get(&gate_node_id)
        .map(|s| (s.attempts, s.wake_at.clone()))
        .unwrap_or((0, None));
    run.nodes.insert(
        gate_node_id,
        NodeRunState {
            status: NodeStatus::Completed,
            output: Some(payload),
            error: None,
            attempts: gate_attempts,
            wake_at: gate_wake_at,
        },
    );
    run.status = RunStatus::Running;
    run.awaiting_node = None;
    run.updated_at = chrono::Utc::now().to_rfc3339();
    store::save_run(&run).map_err(|e| format!("failed to persist gate completion: {e}"))?;

    run_workflow(&workflow, run.input.clone(), run_id.to_string()).await
}

/// Fail a workflow run (e.g. its `Awakeable` approval gate was rejected/expired),
/// stamping `Failed` + `error` and clearing the awaiting gate so it never hangs
/// suspended. No-op-safe if the run is already terminal.
pub async fn fail_run(run_id: &str, error: &str) -> Result<(), String> {
    use store::RunStatus;

    let mut run = store::load_run(run_id).map_err(|_| "run not found".to_string())?;
    if matches!(run.status, RunStatus::Completed | RunStatus::Failed) {
        return Ok(());
    }
    run.status = RunStatus::Failed;
    run.error = Some(error.to_string());
    run.awaiting_node = None;
    run.updated_at = chrono::Utc::now().to_rfc3339();
    let saved = store::save_run(&run).map_err(|e| format!("failed to persist run failure: {e}"));

    // Feed the failure to the self-healing loop (diagnose → propose a diagnosed
    // retry to the inbox, or auto-retry). Best-effort + fire-and-forget so it never
    // blocks or fails the fail_run write. The `healrun_` guard in the heal engine
    // stops a heal-retry that itself fails from looping.
    if saved.is_ok() {
        let run_id = run_id.to_string();
        let error = error.to_string();
        tokio::spawn(async move {
            if let Some(engine) = crate::healing::global_engine() {
                engine
                    .report_failure(
                        &run_id,
                        crate::healing::HealSource::Workflow,
                        format!("Workflow run {run_id} failed."),
                        error,
                    )
                    .await;
            }
        });
    }
    saved
}

/// Re-run a failed workflow from scratch: load the failed run, load its workflow,
/// and start a FRESH run with the same inputs under a new `healrun_`-prefixed id
/// (the never-heal-a-heal marker, so a retry that itself fails won't be re-healed).
/// Used by the self-healing loop's approved workflow fix.
pub async fn rerun_run(run_id: &str) -> Result<WorkflowRun, String> {
    let run = store::load_run(run_id).map_err(|_| "run not found".to_string())?;
    let workflow = store::load_workflow(&run.workflow_id)
        .map_err(|_| format!("workflow '{}' not found", run.workflow_id))?;
    let new_id = format!("healrun_{}", uuid::Uuid::new_v4().simple());
    run_workflow(&workflow, run.input.clone(), new_id).await
}

fn run_workflow_inner(
    workflow: &Workflow,
    input: HashMap<String, String>,
    run_id: String,
    depth: usize,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<WorkflowRun, String>> + Send + '_>> {
    Box::pin(async move {
        if depth > MAX_SUBWORKFLOW_DEPTH {
            return Err(format!(
                "sub-workflow nesting exceeded max depth of {MAX_SUBWORKFLOW_DEPTH}"
            ));
        }

        let graph = WorkflowGraph::build(workflow).map_err(|e| e.to_string())?;

        // Resume from disk when a run with this id already exists, else fresh.
        let mut run = match store::load_run(&run_id) {
            Ok(existing) if existing.workflow_id == workflow.id => existing,
            _ => WorkflowRun::new(run_id.clone(), workflow.id.clone(), input.clone()),
        };
        // Resuming a suspended run: clear awaiting state and re-run from the
        // last checkpoint. Any Awakeable node already flipped to Completed (by
        // the resume endpoint) will be skipped like any other finished node.
        run.awaiting_node = None;
        run.status = RunStatus::Running;

        // Per-node produced value, seeded with any completed-node outputs from a
        // resumed run so downstream nodes can read upstream results.
        let mut values: HashMap<NodeIndex, String> = HashMap::new();
        for node in &workflow.nodes {
            if let Some(state) = run.nodes.get(&node.id) {
                if state.status == NodeStatus::Completed {
                    if let Some(out) = &state.output {
                        if let Some(&idx) = graph.index_by_id.get(&node.id) {
                            values.insert(idx, out.clone());
                        }
                    }
                }
            }
        }

        // Edges considered "active". A condition prunes the non-taken branch.
        let mut active_edges: HashSet<petgraph::graph::EdgeIndex> =
            graph.graph.edge_indices().collect();
        let mut pruned_nodes: HashSet<NodeIndex> = HashSet::new();

        // Kahn-style traversal honouring active edges only.
        let mut indegree: HashMap<NodeIndex, usize> = HashMap::new();
        for idx in graph.graph.node_indices() {
            let count = graph.graph.edges_directed(idx, Direction::Incoming).count();
            indegree.insert(idx, count);
        }

        let mut queue: VecDeque<NodeIndex> = graph.roots().into_iter().collect();

        while let Some(idx) = queue.pop_front() {
            if pruned_nodes.contains(&idx) {
                // A skipped node still resolves its outgoing edges so a
                // downstream join (branches that reconverge on one node) keeps
                // making progress instead of stalling forever. Its edges carry
                // no value and are deactivated inside `resolve_successors`.
                resolve_successors(
                    idx,
                    true,
                    &graph,
                    &mut active_edges,
                    &mut indegree,
                    &mut pruned_nodes,
                    &mut queue,
                    &mut run,
                )?;
                continue;
            }
            let node = &graph.graph[idx];

            // Gather input value from active incoming edges (fan-in joins).
            let incoming: Vec<String> = graph
                .graph
                .edges_directed(idx, Direction::Incoming)
                .filter(|e| active_edges.contains(&e.id()))
                .filter_map(|e| values.get(&e.source()).cloned())
                .collect();
            let node_input = if incoming.is_empty() {
                // Root node: read from run input by key/id.
                input_for_root(node, &run)
            } else {
                incoming.join("\n")
            };

            // Skip already-completed nodes on resume.
            let produced = if run.is_completed(&node.id) {
                run.nodes
                    .get(&node.id)
                    .and_then(|s| s.output.clone())
                    .unwrap_or_default()
            } else {
                mark(&mut run, &node.id, NodeStatus::Running, None, None);
                store::save_run(&run).map_err(|e| format!("failed to persist checkpoint: {e}"))?;

                // Temporal-style retry loop with an optional per-node wall-clock
                // timeout per attempt. A node with no `retry` policy runs once
                // (`max_attempts` defaults to 1); a timeout is surfaced as a
                // retryable error so it composes with the policy. An `Awakeable`
                // suspend is never retried.
                let policy = node.retry.clone().unwrap_or_default();
                let max_attempts = policy.max_attempts.max(1);

                let outcome = loop {
                    // Count this attempt before running it, so a crash mid-call
                    // still spends budget. `attempts` persists across restart.
                    let attempt = {
                        let st = run.nodes.entry(node.id.clone()).or_insert(NodeRunState {
                            status: NodeStatus::Running,
                            output: None,
                            error: None,
                            attempts: 0,
                            wake_at: None,
                        });
                        st.attempts += 1;
                        st.status = NodeStatus::Running;
                        st.attempts
                    };
                    store::save_run(&run)
                        .map_err(|e| format!("failed to persist checkpoint: {e}"))?;

                    let attempt_result = run_node_attempt(node, &node_input, &mut run, depth).await;

                    match attempt_result {
                        Ok(out) => {
                            mark(
                                &mut run,
                                &node.id,
                                NodeStatus::Completed,
                                Some(out.clone()),
                                None,
                            );
                            break Ok(out);
                        }
                        // Awakeable gate: suspend, never retry. The node stays
                        // `Running` so the resume endpoint can identify it and
                        // the executor re-enters it once it is flipped Completed.
                        Err(e) if e == SUSPEND_SENTINEL => {
                            run.status = RunStatus::AwaitingInput;
                            run.awaiting_node = Some(node.id.clone());
                            run.updated_at = chrono::Utc::now().to_rfc3339();
                            store::save_run(&run)
                                .map_err(|e| format!("failed to persist checkpoint: {e}"))?;
                            // Surface an `Awakeable` HITL gate in the approval
                            // inbox so the user can approve (resume) or reject
                            // (fail) it from one place. Best-effort + deduped on
                            // the run id. A `NotifyUser` gate is skipped here: it
                            // already delivered its own per-member inbox items
                            // (with an Ack action) inside the node arm, so a
                            // generic approval row would be a duplicate.
                            if let NodeKind::Awakeable { prompt } = &node.kind {
                                if let Some(engine) = crate::approvals::global_engine() {
                                    let req = crate::approvals::ApprovalRequest::for_workflow_gate(
                                        &run.run_id,
                                        &workflow.name,
                                        prompt.as_deref(),
                                    );
                                    let _ = engine.request_deduped(req).await;
                                }
                            }
                            return Ok(run);
                        }
                        Err(e) => match decide_retry(&policy, attempt, max_attempts, &e) {
                            RetryDecision::Fail => break Err(e),
                            RetryDecision::Retry(sleep_ms) => {
                                store::save_run(&run)
                                    .map_err(|e| format!("failed to persist checkpoint: {e}"))?;
                                tokio::time::sleep(std::time::Duration::from_millis(sleep_ms))
                                    .await;
                            }
                        },
                    }
                };

                match outcome {
                    Ok(out) => out,
                    Err(e) => {
                        mark(
                            &mut run,
                            &node.id,
                            NodeStatus::Failed,
                            None,
                            Some(e.clone()),
                        );
                        run.status = RunStatus::Failed;
                        run.error = Some(e.clone());
                        store::save_run(&run)
                            .map_err(|e| format!("failed to persist checkpoint: {e}"))?;
                        return Err(e);
                    }
                }
            };

            values.insert(idx, produced.clone());

            // Condition nodes (and a body-less one-shot While gate) produce
            // "true"/"false" and prune the non-taken branch. A *looped* While
            // (`body_workflow_id` set) produces the loop's carry value, not a
            // branch label, so it must NOT prune — it is a plain data node with a
            // single unlabelled forward edge.
            let is_brancher = matches!(node.kind, NodeKind::Condition { .. })
                || matches!(
                    node.kind,
                    NodeKind::While {
                        body_workflow_id: None,
                        ..
                    }
                );
            if is_brancher {
                let taken = produced == "true";
                let label = if taken { "true" } else { "false" };
                for edge in graph.graph.edges_directed(idx, Direction::Outgoing) {
                    let matches = edge
                        .weight()
                        .branch
                        .as_deref()
                        .map(|b| b == label)
                        .unwrap_or(true);
                    if !matches {
                        active_edges.remove(&edge.id());
                    }
                }
            }

            store::save_run(&run).map_err(|e| format!("failed to persist checkpoint: {e}"))?;

            // Resolve successors: decrement each successor's indegree and, once
            // it reaches zero, either enqueue it (a live incoming edge remains)
            // or skip it (every incoming path was pruned).
            resolve_successors(
                idx,
                false,
                &graph,
                &mut active_edges,
                &mut indegree,
                &mut pruned_nodes,
                &mut queue,
                &mut run,
            )?;
        }

        // Collect Output node values into the run output map.
        for node in &workflow.nodes {
            if let NodeKind::Output { key } = &node.kind {
                if let Some(&idx) = graph.index_by_id.get(&node.id) {
                    if let Some(v) = values.get(&idx) {
                        let out_key = key.clone().unwrap_or_else(|| node.id.clone());
                        run.output.insert(out_key, v.clone());
                    }
                }
            }
        }

        if run.status == RunStatus::Running {
            run.status = RunStatus::Completed;
        }
        run.updated_at = chrono::Utc::now().to_rfc3339();
        store::save_run(&run).map_err(|e| format!("failed to persist checkpoint: {e}"))?;
        Ok(run)
    })
}

/// Resolve a finalized node's outgoing edges during Kahn traversal.
///
/// Called once per node after it Completes (`was_skipped == false`) and once per
/// Skipped node (`was_skipped == true`). A skipped node produces no value, so its
/// outgoing edges are deactivated. For every successor whose indegree reaches
/// zero we decide run-vs-skip: a successor with at least one still-active
/// incoming edge runs (and reads only its active inputs); a successor whose
/// incoming edges were all pruned is itself skipped and enqueued so the skip
/// propagates through any further joins. This is what lets a `Condition` whose
/// branches reconverge on a single downstream node work — the pruned branch's
/// skip flows through to the join instead of stalling its indegree forever.
#[allow(clippy::too_many_arguments)]
fn resolve_successors(
    idx: NodeIndex,
    was_skipped: bool,
    graph: &WorkflowGraph,
    active_edges: &mut HashSet<petgraph::graph::EdgeIndex>,
    indegree: &mut HashMap<NodeIndex, usize>,
    pruned_nodes: &mut HashSet<NodeIndex>,
    queue: &mut VecDeque<NodeIndex>,
    run: &mut WorkflowRun,
) -> Result<(), String> {
    let out_edges: Vec<(petgraph::graph::EdgeIndex, NodeIndex)> = graph
        .graph
        .edges_directed(idx, Direction::Outgoing)
        .map(|e| (e.id(), e.target()))
        .collect();
    for (eid, target) in out_edges {
        if was_skipped {
            // A skipped source carries no value into the join.
            active_edges.remove(&eid);
        }
        let entry = indegree.entry(target).or_insert(0);
        if *entry > 0 {
            *entry -= 1;
        }
        if *entry != 0 || pruned_nodes.contains(&target) {
            continue;
        }
        let has_active_incoming = graph
            .graph
            .edges_directed(target, Direction::Incoming)
            .any(|e| active_edges.contains(&e.id()));
        // A still-pending node reachable by no active path is skipped (and the
        // skip propagates from its own edges). A completed node — a prior run's
        // checkpoint on resume — is never re-marked; it is enqueued so the
        // loop replays its stored output down the graph.
        if !has_active_incoming && !run.is_completed(&graph.graph[target].id) {
            pruned_nodes.insert(target);
            mark(run, &graph.graph[target].id, NodeStatus::Skipped, None, None);
            store::save_run(run).map_err(|e| format!("failed to persist checkpoint: {e}"))?;
        }
        queue.push_back(target);
    }
    Ok(())
}

fn input_for_root(node: &super::WorkflowNode, run: &WorkflowRun) -> String {
    match &node.kind {
        NodeKind::Input { key } => {
            let k = key.clone().unwrap_or_else(|| node.id.clone());
            run.input.get(&k).cloned().unwrap_or_default()
        }
        _ => run.input.get(&node.id).cloned().unwrap_or_default(),
    }
}

fn mark(
    run: &mut WorkflowRun,
    node_id: &str,
    status: NodeStatus,
    output: Option<String>,
    error: Option<String>,
) {
    // Preserve fields the retry/durable-timer machinery owns: `attempts` (the
    // Temporal-style retry budget, managed by the retry loop) and `wake_at` (the
    // durable-delay instant). Clobbering them here would silently reset a retry
    // budget or lose a persisted timer on a status transition.
    let (attempts, wake_at) = run
        .nodes
        .get(node_id)
        .map(|s| (s.attempts, s.wake_at.clone()))
        .unwrap_or((0, None));
    run.nodes.insert(
        node_id.to_string(),
        NodeRunState {
            status,
            output,
            error,
            attempts,
            wake_at,
        },
    );
    run.updated_at = chrono::Utc::now().to_rfc3339();
}

/// Build the template context from the current run + incoming value. Owns small
/// cloned maps so the caller can keep a mutable borrow of `run` (e.g. for
/// `SetState`) while resolving a node's fields. `{{nodes.<id>}}` reads from
/// `run.nodes` (keyed by node id, populated in topological order), so all
/// upstream outputs are already present.
fn build_template_ctx(input: &str, run: &WorkflowRun) -> super::template::TemplateCtx {
    let nodes = run
        .nodes
        .iter()
        .filter_map(|(id, s)| s.output.clone().map(|o| (id.clone(), o)))
        .collect();
    super::template::TemplateCtx {
        input: input.to_string(),
        nodes,
        state: run.state.clone(),
    }
}

// ── Retry / timeout (Temporal-style) ─────────────────────────────────────────

/// The retry loop's decision after an attempt fails: stop, or wait then re-run.
enum RetryDecision {
    /// Sleep this many milliseconds, then retry.
    Retry(u64),
    /// Stop retrying and fail the node (budget spent or non-retryable error).
    Fail,
}

/// Run one node attempt, applying the node's optional per-node wall-clock
/// timeout (the Temporal `StartToClose` analogue). On timeout the in-flight
/// future is cancelled and a *retryable* "timed out" error is returned, so a
/// timeout composes with the surrounding retry loop. With no timeout set the
/// node runs unbounded (historical behaviour).
async fn run_node_attempt(
    node: &super::WorkflowNode,
    input: &str,
    run: &mut WorkflowRun,
    depth: usize,
) -> Result<String, String> {
    match node.timeout_ms {
        Some(ms) if ms > 0 => {
            match tokio::time::timeout(
                std::time::Duration::from_millis(ms),
                execute_node(node, input, run, depth),
            )
            .await
            {
                Ok(r) => r,
                Err(_) => Err(format!("node '{}' timed out after {ms}ms", node.id)),
            }
        }
        _ => execute_node(node, input, run, depth).await,
    }
}

/// Decide whether to retry a failed attempt. `attempt` is the 1-indexed number
/// of the attempt that just failed; `max_attempts` is the clamped budget. Pure
/// so the policy is unit-testable without an executor or gateway.
fn decide_retry(
    policy: &super::RetryPolicy,
    attempt: u32,
    max_attempts: u32,
    error: &str,
) -> RetryDecision {
    // Fast fail on a known-unrecoverable error (case-insensitive substring).
    if !policy.non_retryable_errors.is_empty() {
        let lower = error.to_lowercase();
        if policy
            .non_retryable_errors
            .iter()
            .any(|p| !p.is_empty() && lower.contains(&p.to_lowercase()))
        {
            return RetryDecision::Fail;
        }
    }
    if attempt >= max_attempts {
        return RetryDecision::Fail;
    }
    RetryDecision::Retry(apply_jitter(next_backoff_ms(policy, attempt), policy))
}

/// Exponential backoff for the retry that follows the `attempt`-th failure:
/// `min(initial * coefficient^(attempt-1), max_interval)`. After attempt 1 the
/// exponent is 0, so the first retry waits exactly `initial_interval_ms`.
fn next_backoff_ms(policy: &super::RetryPolicy, attempt: u32) -> u64 {
    let exp = attempt.saturating_sub(1) as f64;
    let coeff = if policy.backoff_coefficient <= 0.0 {
        1.0
    } else {
        policy.backoff_coefficient
    };
    let backoff = policy.initial_interval_ms as f64 * coeff.powf(exp);
    let ceil = policy.max_interval_ms.max(1) as f64;
    backoff.min(ceil).max(0.0) as u64
}

/// Scatter a backoff interval by `±jitter_fraction` to avoid retry storms. The
/// randomness is drawn from the sub-second clock mixed with a process-global
/// counter — not cryptographic, but it de-correlates retries that fire within
/// the same nanosecond window (a plain clock read would hand them identical
/// jitter and re-create the storm). Returns the input unchanged when jitter is
/// off or out of range.
fn apply_jitter(backoff_ms: u64, policy: &super::RetryPolicy) -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let j = policy.jitter_fraction;
    if backoff_ms == 0 || j == 0.0 || !(0.0..=1.0).contains(&j) {
        return backoff_ms;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    // SplitMix64-style avalanche of (clock ⊕ monotonic counter) → a well-spread
    // 64-bit value, then folded to a fraction. The counter guarantees two calls
    // in the same nanosecond still diverge.
    let mut x = nanos
        ^ SEQ
            .fetch_add(1, Ordering::Relaxed)
            .wrapping_mul(0x9E37_79B9_7F4A_7C15);
    x ^= x >> 30;
    x = x.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^= x >> 31;
    // Map into [-1.0, 1.0).
    let r = (x as f64 / u64::MAX as f64) * 2.0 - 1.0;
    let delta = backoff_ms as f64 * j * r;
    ((backoff_ms as f64) + delta).max(1.0) as u64
}

// ── Idempotency (Restate-style) ──────────────────────────────────────────────

/// Deterministic idempotency key for a side-effecting node. Stable across a
/// resume — a re-run after a crash carries the SAME key — so a cooperating sink
/// can dedup the duplicate and the effect stays effectively-once. This tightens
/// at-least-once → effectively-once for sinks that honour it; it does not change
/// Ryu's own recovery model.
fn idempotency_key(run_id: &str, node_id: &str) -> String {
    format!("{run_id}:{node_id}")
}

/// Sanitise an idempotency key for use as an HTTP header value: keep only the
/// portable token charset `[A-Za-z0-9._:-]`, replacing anything else with `-`.
/// Stable for the same input, so the dedup guarantee survives sanitisation.
fn header_safe_key(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Build the MCP tool argument object: start from the node's `args` (object,
/// empty, or scalar-wrapped), inject the upstream `input` if absent, and stamp a
/// stable `__ryu_idempotency_key` (only if the author did not already supply
/// one). Split out so it is unit-testable without the MCP registry.
fn build_tool_args(args: &serde_json::Value, input: &str, idem_key: &str) -> serde_json::Value {
    let mut arguments = match args {
        serde_json::Value::Object(_) => args.clone(),
        serde_json::Value::Null => serde_json::json!({}),
        other => serde_json::json!({ "args": other }),
    };
    if let Some(obj) = arguments.as_object_mut() {
        obj.entry("input")
            .or_insert_with(|| serde_json::Value::String(input.to_string()));
        obj.entry("__ryu_idempotency_key")
            .or_insert_with(|| serde_json::Value::String(idem_key.to_string()));
    }
    arguments
}

/// Execute a single node and return its produced value.
async fn execute_node(
    node: &super::WorkflowNode,
    input: &str,
    run: &mut WorkflowRun,
    depth: usize,
) -> Result<String, String> {
    use super::template::resolve;

    let ctx = build_template_ctx(input, run);

    match &node.kind {
        NodeKind::Input { .. } => Ok(input.to_string()),
        NodeKind::Output { .. } => Ok(input.to_string()),
        NodeKind::Transform { op, template } => {
            // The `template` op resolves the full `{{...}}` grammar; other ops
            // stay pure string transforms over the incoming value.
            if op == "template" {
                let tmpl = template
                    .as_deref()
                    .ok_or("template op requires a `template` field")?;
                Ok(resolve(tmpl, &ctx))
            } else {
                apply_transform(op, template.as_deref(), input)
            }
        }
        NodeKind::Condition { expr } => {
            // Resolve tokens in the expression (e.g. an RHS `{{state.x}}`) before
            // evaluating. The literal `input` keyword is not a `{{...}}` token, so
            // the `input ==`/`!=`/`contains` prefixes still parse.
            let resolved = resolve(expr, &ctx);
            Ok(eval_condition(&resolved, input).to_string())
        }
        NodeKind::SetState { key, value } => {
            let resolved = resolve(value, &ctx);
            run.state.insert(key.clone(), resolved);
            // Pass the incoming value through unchanged to outgoing edges.
            Ok(input.to_string())
        }
        NodeKind::Delay { ms } => {
            // Durable timer: on first entry compute and persist a `wake_at`, then
            // checkpoint before sleeping. On resume the persisted instant is
            // reused so only the remaining time is slept (a crash mid-sleep does
            // not restart the full delay). Restate/Temporal durable-timer parity.
            let now = chrono::Utc::now();
            let wake_at = run
                .nodes
                .get(&node.id)
                .and_then(|s| s.wake_at.as_deref())
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&chrono::Utc))
                .unwrap_or_else(|| now + chrono::Duration::milliseconds(*ms as i64));
            // Stamp wake_at onto the node state and checkpoint before sleeping.
            // Scope the mutable `entry` borrow so it ends before save_run (which
            // needs to borrow the whole run) is called.
            let stamped = {
                let entry = run.nodes.entry(node.id.clone()).or_insert(NodeRunState {
                    status: NodeStatus::Running,
                    output: None,
                    error: None,
                    attempts: 0,
                    wake_at: None,
                });
                if entry.wake_at.is_none() {
                    entry.wake_at = Some(wake_at.to_rfc3339());
                    true
                } else {
                    false
                }
            };
            if stamped {
                store::save_run(run).map_err(|e| format!("failed to persist checkpoint: {e}"))?;
            }
            // Clamp to 0 so a backward clock jump (now > wake_at by skew) can
            // never produce a negative duration / cast surprise — a past wake_at
            // just means "fire now". Durability note: a failed checkpoint save
            // fails the run (same as every node checkpoint); a hard OS crash in
            // the sub-millisecond window before the sleep may re-sleep the full
            // delay. A clean restart always resumes with the remainder.
            let remaining = (wake_at - chrono::Utc::now()).num_milliseconds().max(0);
            if remaining > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(remaining as u64)).await;
            }
            Ok(input.to_string())
        }
        NodeKind::Note { .. } => {
            // Documentation only: forward the incoming value untouched. Note nodes
            // are excluded from the run output map (only `Output` nodes contribute
            // there), so a Note never affects the run result.
            Ok(input.to_string())
        }
        NodeKind::While {
            expr,
            body_workflow_id,
            max_iterations,
        } => {
            let cap = effective_while_cap(*max_iterations);
            match body_workflow_id {
                // Real bounded loop: re-run the body sub-workflow while the
                // condition holds. See [`run_while_loop`].
                Some(body_id) if !body_id.is_empty() => {
                    run_while_loop(expr, body_id, cap, &node.id, input, run, depth).await
                }
                // One-shot guarded gate (back-compat, NOT a loop): resolve tokens,
                // evaluate the condition, then consult the per-node iteration
                // counter. Produces "true"/"false" exactly like a Condition node, so
                // the outer pruning loop selects the matching outgoing branch.
                _ => {
                    let resolved = resolve(expr, &ctx);
                    let holds = eval_condition(&resolved, input);
                    let state_key = format!("__while_{}", node.id);
                    let counter = run
                        .state
                        .get(&state_key)
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(0);
                    let (take_true, next) = decide_while_capped(counter, holds, cap);
                    run.state.insert(state_key, next.to_string());
                    Ok(take_true.to_string())
                }
            }
        }
        NodeKind::Guardrails { checks } => run_guardrails(checks, input).await,
        NodeKind::Prompt { prompt, agent_id } => {
            let rendered = resolve(prompt, &ctx);
            run_prompt(&rendered, agent_id.as_deref(), &run.run_id, &node.id).await
        }
        NodeKind::Webhook { url, method } => {
            let resolved_url = resolve(url, &ctx);
            let idem_key = idempotency_key(&run.run_id, &node.id);
            run_webhook(&resolved_url, method, input, &idem_key).await
        }
        NodeKind::Tool { name, args } => {
            let resolved_args = resolve_json_strings(args, &ctx);
            let idem_key = idempotency_key(&run.run_id, &node.id);
            run_tool(name, &resolved_args, input, &idem_key).await
        }
        NodeKind::Mcp { server, tool, args } => {
            // The explicit two-field form of a Tool node: join `<server>__<tool>`
            // into the id the MCP registry expects, then reuse the Tool path so
            // idempotency-key + `input` folding behave identically.
            let resolved_args = resolve_json_strings(args, &ctx);
            let idem_key = idempotency_key(&run.run_id, &node.id);
            let tool_id = format!("{server}__{tool}");
            run_tool(&tool_id, &resolved_args, input, &idem_key).await
        }
        NodeKind::Recipe { recipe, params } => {
            let resolved_params = resolve_json_strings(params, &ctx);
            run_recipe(recipe, &resolved_params).await
        }
        NodeKind::GhostAction {
            action,
            target,
            params,
        } => {
            let resolved_target = resolve_json_strings(target, &ctx);
            let resolved_params = resolve_json_strings(params, &ctx);
            run_ghost_action(action, &resolved_target, &resolved_params).await
        }
        NodeKind::SubWorkflow { workflow_id } => {
            let sub = store::load_workflow(workflow_id)
                .map_err(|e| format!("sub-workflow '{workflow_id}' not found: {e}"))?;
            let mut sub_input = HashMap::new();
            sub_input.insert("input".to_string(), input.to_string());
            // Deterministic child run id (same scheme as the `While` loop body) so
            // a resumed parent re-enters the SAME inner run: it short-circuits on
            // the inner run's already-Completed nodes after a restart, and any
            // side-effecting inner node keeps a STABLE idempotency key across the
            // crash (a fresh UUID here would defeat both).
            let sub_run_id = format!("{}-sub-{}", run.run_id, node.id);
            let result = run_workflow_inner(&sub, sub_input, sub_run_id, depth + 1).await?;
            // Forward the first output value (or empty).
            Ok(result.output.values().next().cloned().unwrap_or_default())
        }
        NodeKind::AgentDelegate { delegates, caps } => {
            run_agent_delegate(delegates, caps.clone(), input, depth, &run.run_id, &node.id).await
        }
        NodeKind::Agent { agent_id, task } => {
            // A dedicated "run agent X on this task" step. `run_prompt` already
            // routes a set agent id through the agent runner (and falls back to
            // the gateway LLM in headless/test contexts), so reuse it: the task
            // template is the agent's instruction.
            let task_tmpl = task.as_deref().unwrap_or("{{input}}");
            let rendered = resolve(task_tmpl, &ctx);
            run_prompt(&rendered, Some(agent_id), &run.run_id, &node.id).await
        }
        NodeKind::Skill {
            skill,
            agent_id,
            task,
        } => {
            let task_tmpl = task.as_deref().unwrap_or("{{input}}");
            let rendered = resolve(task_tmpl, &ctx);
            run_skill(skill, agent_id.as_deref(), &rendered, &run.run_id, &node.id).await
        }
        NodeKind::Plugin {
            plugin_id,
            runnable_id,
            args,
        } => {
            let resolved_args = resolve_json_strings(args, &ctx);
            let idem_key = idempotency_key(&run.run_id, &node.id);
            run_plugin(
                plugin_id,
                runnable_id,
                &resolved_args,
                input,
                &idem_key,
                &run.run_id,
                &node.id,
                depth,
            )
            .await
        }
        NodeKind::NotifyUser {
            target,
            title,
            body,
            ack_mode,
            ack_timeout_ms: _,
        } => {
            // Resolve the title/body templates before delivery, then hand off to
            // the notify-user helper. When the ack policy requires waiting it
            // writes its gate bookkeeping into `run.state` and returns the suspend
            // sentinel, which the outer loop turns into `AwaitingInput` (identical
            // to an Awakeable gate); fire-and-forget returns a JSON receipt.
            let rendered_title = resolve(title, &ctx);
            let rendered_body = resolve(body, &ctx);
            super::notify_user::run(
                target,
                &rendered_title,
                &rendered_body,
                ack_mode,
                &node.id,
                run,
            )
            .await
        }
        NodeKind::ChannelSend {
            platform,
            recipient,
            text,
            bot_token,
            webhook_url,
        } => {
            // Resolve the recipient + message templates, then hand off to the
            // channel-send helper (which reuses the monitor notify primitives).
            let rendered_recipient = resolve(recipient, &ctx);
            let rendered_text = resolve(text, &ctx);
            super::channel_send::run(
                *platform,
                &rendered_recipient,
                &rendered_text,
                bot_token.as_deref(),
                webhook_url.as_deref(),
            )
            .await
        }
        // Signal the outer loop to suspend by returning the sentinel. The outer
        // loop recognises this exact value and transitions the run to
        // `AwaitingInput` without marking the node Failed.
        NodeKind::Awakeable { .. } => Err(SUSPEND_SENTINEL.to_string()),
    }
}

/// Run a real bounded `While` loop using iteration-as-recursion: each iteration
/// executes the named body workflow as its own [`WorkflowRun`] (the same path as
/// [`NodeKind::SubWorkflow`]), so the outer DAG never gains a cycle and DAG
/// validation is untouched.
///
/// The **carry** is the loop variable: seeded with the node's incoming `input`,
/// the condition is evaluated against the carry (the `input` keyword resolves to
/// it, e.g. `input < 10`), and each iteration's body output replaces the carry.
/// The loop returns the final carry as the node's produced value (a looped While
/// is a data node, not a brancher).
///
/// # Durability
///
/// The iteration counter and carry persist into the run `state` (keyed
/// `__while_<id>` / `__while_carry_<id>`) and are checkpointed to disk via
/// `store::save_run` after every iteration. On resume the While node is still
/// `Running` (the loop did not finish), so `execute_node` re-enters it, reads the
/// persisted counter/carry, and continues. Per-iteration sub-runs use a
/// deterministic run id (`<run>-<node>-iter-<n>`) so an early iteration that
/// already finished short-circuits on its own Completed nodes.
///
/// **At-least-once:** an iteration interrupted mid-flight re-runs on resume; a
/// side-effecting body node is not exactly-once.
///
/// # Guards
///
/// - A self-referential `body_workflow_id` (equal to the parent run's workflow
///   id) is rejected to avoid infinite recursion; [`MAX_SUBWORKFLOW_DEPTH`] also
///   bounds nesting.
/// - An `Awakeable` gate inside the body (the sub-run returns `AwaitingInput`)
///   fails the While node in v1 with a clear error.
async fn run_while_loop(
    expr: &str,
    body_id: &str,
    cap: u64,
    node_id: &str,
    input: &str,
    run: &mut WorkflowRun,
    depth: usize,
) -> Result<String, String> {
    use super::store::RunStatus;
    use super::template::{resolve, TemplateCtx};

    if body_id == run.workflow_id {
        return Err(format!(
            "while node '{node_id}': body_workflow_id '{body_id}' is the workflow itself (would recurse infinitely)"
        ));
    }

    let body_wf = store::load_workflow(body_id)
        .map_err(|e| format!("while node '{node_id}': body workflow '{body_id}' not found: {e}"))?;

    let counter_key = format!("__while_{node_id}");
    let carry_key = format!("__while_carry_{node_id}");

    // Resume support: pick up the persisted counter/carry, else seed from input.
    let mut counter = run
        .state
        .get(&counter_key)
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let mut carry = run
        .state
        .get(&carry_key)
        .cloned()
        .unwrap_or_else(|| input.to_string());

    loop {
        // Evaluate the condition against the current carry (the `input` keyword
        // resolves to the carry). Any `{{state.*}}`/`{{nodes.*}}` tokens in the
        // expr resolve against the parent run state.
        let ctx = TemplateCtx {
            input: carry.clone(),
            nodes: run
                .nodes
                .iter()
                .filter_map(|(id, s)| s.output.clone().map(|o| (id.clone(), o)))
                .collect(),
            state: run.state.clone(),
        };
        let resolved = resolve(expr, &ctx);
        let holds = eval_condition(&resolved, &carry);
        let (continue_loop, next_counter) = decide_while_capped(counter, holds, cap);
        if !continue_loop {
            break;
        }

        // Run one iteration as a sub-run with a deterministic id so a finished
        // early iteration short-circuits on its own Completed nodes after a restart.
        let mut sub_input = HashMap::new();
        sub_input.insert("input".to_string(), carry.clone());
        let sub_run_id = format!("{}-{}-iter-{}", run.run_id, node_id, counter);
        let result = run_workflow_inner(&body_wf, sub_input, sub_run_id, depth + 1).await?;

        // v1: an Awakeable gate inside the body is not supported — fail clearly.
        if result.status == RunStatus::AwaitingInput {
            return Err(format!(
                "while node '{node_id}': Awakeable gates are not supported inside a While body in v1"
            ));
        }

        // Fold the body's first output into the carry (loop variable advances).
        carry = result.output.values().next().cloned().unwrap_or_default();
        counter = next_counter;

        // Checkpoint the loop progress after every iteration (the genuinely-new
        // mid-loop durability — the executor otherwise only checkpoints between
        // nodes).
        run.state.insert(counter_key.clone(), counter.to_string());
        run.state.insert(carry_key.clone(), carry.clone());
        store::save_run(run).map_err(|e| format!("failed to persist checkpoint: {e}"))?;
    }

    // Loop finished: the node produces the final carry as a plain data value.
    Ok(carry)
}

/// Execute an `AgentDelegate` node: fan out to its sub-agents concurrently with
/// a clean context. The node input is appended to each delegate's task so the
/// delegate receives upstream data as clean input (never parent history).
///
/// Delegation depth maps to the node's nesting depth + 1: a top-level workflow
/// (depth 0) delegating launches delegates at depth 1, and the
/// [`delegation::MAX_DELEGATION_DEPTH`] cap rejects fan-outs nested too deep.
/// The node output is a JSON array of [`delegation::DelegateResult`].
///
/// When `run_id` and `node_id` are supplied, the fan-out runs with a durable
/// checkpoint key so completed delegates are not re-run on resume.
async fn run_agent_delegate(
    delegates: &[delegation::DelegateSpec],
    caps: Option<delegation::DelegationCaps>,
    input: &str,
    depth: usize,
    run_id: &str,
    node_id: &str,
) -> Result<String, String> {
    // Compose each delegate's clean-context task: the configured task plus the
    // node input as a labelled, history-free block.
    let prepared: Vec<delegation::DelegateSpec> = delegates
        .iter()
        .map(|d| {
            let task = if input.is_empty() {
                d.task.clone()
            } else {
                format!("{}\n\n--- input ---\n{}", d.task, input)
            };
            delegation::DelegateSpec {
                id: d.id.clone(),
                task,
                agent_id: d.agent_id.clone(),
                preset: d.preset,
                inline: d.inline.clone(),
            }
        })
        .collect();

    let caps = caps.unwrap_or_default();

    // Build a durable checkpoint key so each delegate result is persisted; on
    // resume completed delegates are skipped and their recorded results reused.
    let checkpoint_key = Arc::new(delegation::FanoutCheckpointKey {
        run_id: run_id.to_string(),
        node_id: node_id.to_string(),
    });

    // Progress events are dropped here (no streaming sink at the node boundary);
    // the chat/stream delegation entry point wires a real channel.
    let results = delegation::run_fanout_with_checkpoint(
        prepared,
        caps,
        depth + 1,
        None,
        Some(checkpoint_key),
    )
    .await
    .map_err(|e| e.to_string())?;

    serde_json::to_string(&results)
        .map_err(|e| format!("failed to serialise delegate results: {e}"))
}

/// Apply a pure transform op to the input string.
pub fn apply_transform(op: &str, template: Option<&str>, input: &str) -> Result<String, String> {
    match op {
        "uppercase" => Ok(input.to_uppercase()),
        "lowercase" => Ok(input.to_lowercase()),
        "trim" => Ok(input.trim().to_string()),
        "identity" => Ok(input.to_string()),
        "json_parse" => serde_json::from_str::<serde_json::Value>(input)
            .map(|v| v.to_string())
            .map_err(|e| format!("json_parse failed: {e}")),
        "template" => {
            let tmpl = template.ok_or("template op requires a `template` field")?;
            Ok(tmpl.replace("{{input}}", input))
        }
        other => Err(format!("unknown transform op: {other}")),
    }
}

/// Evaluate a tiny condition expression against the input.
///
/// Supported forms (left side is always the literal `input`):
///   `input == "x"`, `input != "x"`, `input contains "x"`,
///   `input starts_with "x"`, `input ends_with "x"`, `input empty`,
///   `input nonempty`, and the numeric comparisons `input < N`, `input > N`,
///   `input <= N`, `input >= N` (both operands parsed as f64; non-numeric → false).
/// Quotes around the right-hand value are optional. The numeric operators are
/// what give a bounded `While` loop a useful exit, e.g. `input < 10` where the
/// loop carry is a counter.
pub fn eval_condition(expr: &str, input: &str) -> bool {
    let expr = expr.trim();
    let strip = |s: &str| s.trim().trim_matches('"').trim_matches('\'').to_string();

    if expr == "input empty" {
        return input.is_empty();
    }
    if expr == "input nonempty" {
        return !input.is_empty();
    }
    if let Some(rhs) = expr.strip_prefix("input ==") {
        return input == strip(rhs);
    }
    if let Some(rhs) = expr.strip_prefix("input !=") {
        return input != strip(rhs);
    }
    if let Some(rhs) = expr.strip_prefix("input contains") {
        return input.contains(&strip(rhs));
    }
    if let Some(rhs) = expr.strip_prefix("input starts_with") {
        return input.starts_with(&strip(rhs));
    }
    if let Some(rhs) = expr.strip_prefix("input ends_with") {
        return input.ends_with(&strip(rhs));
    }
    // Numeric comparisons. Check the two-char operators (`<=`/`>=`) before the
    // single-char ones so `input <= N` is not mis-parsed as `input < =N`.
    let numeric_cmp = |rhs: &str, cmp: fn(f64, f64) -> bool| match (
        input.trim().parse::<f64>(),
        strip(rhs).parse::<f64>(),
    ) {
        (Ok(l), Ok(r)) => cmp(l, r),
        _ => false,
    };
    if let Some(rhs) = expr.strip_prefix("input <=") {
        return numeric_cmp(rhs, |l, r| l <= r);
    }
    if let Some(rhs) = expr.strip_prefix("input >=") {
        return numeric_cmp(rhs, |l, r| l >= r);
    }
    if let Some(rhs) = expr.strip_prefix("input <") {
        return numeric_cmp(rhs, |l, r| l < r);
    }
    if let Some(rhs) = expr.strip_prefix("input >") {
        return numeric_cmp(rhs, |l, r| l > r);
    }
    // Fallback: truthy if input equals the raw expression.
    input == expr
}

/// Run a Prompt (Agent) node.
///
/// When `agent_id` is set AND the process-global agent runner is available, the
/// turn routes through the *configured* agent (its engine binding, gateway
/// routing, tools, persona) via the real chat path — so a workflow `Agent` node
/// actually invokes the agent the user picked. The ephemeral conversation id is
/// derived from `run_id`/`node_id` so it is deterministic per node.
///
/// Otherwise (no agent picked, or no runner — e.g. headless/tests) the call
/// falls back to the default-LLM gateway path. Per the Core-vs-Gateway rule,
/// Core never POSTs directly to a provider URL; every model call goes through the
/// gateway so firewall / PII-DLP / budgets / audit all apply. Fail-closed: if the
/// gateway is unreachable and `RYU_ALLOW_GATEWAY_FALLBACK=1` is not set, the node
/// fails rather than silently bypassing the gateway.
async fn run_prompt(
    prompt: &str,
    agent_id: Option<&str>,
    run_id: &str,
    node_id: &str,
) -> Result<String, String> {
    use crate::sidecar::gateway::{gateway_token, gateway_url};

    // A configured agent + an available runner: invoke the real agent.
    if let Some(id) = agent_id.filter(|s| !s.is_empty()) {
        if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
            let conversation_id = format!("wfrun-{run_id}-{node_id}");
            return runner
                .run(Some(id.to_string()), conversation_id, prompt.to_string())
                .await
                .map_err(|e| format!("prompt node: agent '{id}' failed: {e}"));
        }
    }

    let gw_url = gateway_url();
    let gw_token = gateway_token();

    let model = std::env::var("RYU_DEFAULT_LLM_MODEL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "gpt-4o-mini".to_string());

    let payload = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [{ "role": "user", "content": prompt }],
    });

    let client = reqwest::Client::new();
    let endpoint = format!("{}/v1/chat/completions", gw_url.trim_end_matches('/'));
    let mut builder = client.post(&endpoint).json(&payload);
    if let Some(token) = gw_token {
        builder = builder.bearer_auth(token);
    }

    let resp = builder
        .send()
        .await
        .map_err(|e| format!("prompt node: gateway unreachable (fail-closed): {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "prompt node: gateway returned HTTP {}",
            resp.status()
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("prompt node: invalid gateway response: {e}"))?;
    let text = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    Ok(text)
}

/// Execute a `Skill` node: load the skill's instruction body from the registry
/// and run it (skill body + resolved task) through the chosen agent, or the
/// default gateway LLM when no agent is set. The composed text reuses the same
/// `## Skill: <name>` framing the chat injector uses ([`crate::skills`]), so a
/// skill behaves the same whether it is injected into a chat turn or driven as a
/// workflow step. Fails clearly when the skill is not installed.
async fn run_skill(
    skill_id: &str,
    agent_id: Option<&str>,
    task: &str,
    run_id: &str,
    node_id: &str,
) -> Result<String, String> {
    let record = crate::skills::SkillRegistry::load()
        .list_all()
        .into_iter()
        .find(|s| s.id == skill_id)
        .ok_or_else(|| format!("skill node: skill '{skill_id}' is not installed"))?;

    // Compose the skill body as the leading context, then the resolved task —
    // the same block shape the chat/ACP injectors build from a skill record.
    let composed = format!(
        "## Skill: {}\n{}\n\n{}",
        record.name, record.instructions, task
    );
    run_prompt(&composed, agent_id, run_id, node_id).await
}

/// Execute a `Plugin` node: resolve the installed plugin's manifest, find the
/// named bundled runnable, and dispatch it to that kind's execution path. This
/// is the object-model bridge — a workflow step that runs any Runnable an app
/// contributes (`AGENTS.md` Runnable union: Agent · Workflow · Tool · Skill).
///
/// Kind dispatch:
/// - `tool` → the MCP registry, using the entry's `ToolConfig.slug` as the tool
///   id (reusing [`run_tool`], so `input` + idempotency-key folding match a
///   `Tool` node).
/// - `agent` → the agent runner, running the agent registered under the
///   runnable id with `input` as the task (reusing [`run_prompt`]).
/// - `skill` → the skill path, using the entry's `SkillConfig.skill_id`.
/// - `workflow` → a sub-workflow run of the entry's `WorkflowConfig.entry`
///   (the same deterministic-child-id path as a `SubWorkflow` node).
///
/// Non-executable kinds (companion/channel/engine/policy) are rejected: they are
/// surfaces/bindings, not input→output runnables. Decides *what runs* → Core;
/// every model call the dispatched runnable makes stays gateway-governed.
#[allow(clippy::too_many_arguments)]
async fn run_plugin(
    plugin_id: &str,
    runnable_id: &str,
    args: &serde_json::Value,
    input: &str,
    idem_key: &str,
    run_id: &str,
    node_id: &str,
    depth: usize,
) -> Result<String, String> {
    use crate::plugin_manifest::PluginManifestLoader;
    use crate::runnable::RunnableKind;

    let manifest = PluginManifestLoader::load()
        .into_iter()
        .find(|m| m.id == plugin_id)
        .ok_or_else(|| format!("plugin node: plugin '{plugin_id}' is not installed"))?;

    let entry = manifest
        .runnables()
        .iter()
        .find(|r| r.id == runnable_id)
        .ok_or_else(|| {
            format!("plugin node: plugin '{plugin_id}' has no runnable '{runnable_id}'")
        })?;

    // Small helper to pull a required string field out of the entry's per-kind
    // config blob, with a clear error when the manifest is malformed.
    let config_str = |field: &str| -> Result<String, String> {
        entry
            .config
            .as_ref()
            .and_then(|c| c.get(field))
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .ok_or_else(|| {
                format!(
                    "plugin node: runnable '{runnable_id}' of plugin '{plugin_id}' is missing config field '{field}'"
                )
            })
    };

    match entry.kind {
        RunnableKind::Tool => {
            let slug = config_str("slug")?;
            run_tool(&slug, args, input, idem_key).await
        }
        RunnableKind::Agent => {
            // Run the agent registered under the runnable id; the pipeline value
            // is the task. Fails clearly if the plugin's agent is not (yet)
            // registered in the agent store.
            run_prompt(input, Some(&entry.id), run_id, node_id).await
        }
        RunnableKind::Skill => {
            let skill_id = config_str("skill_id")?;
            run_skill(&skill_id, None, input, run_id, node_id).await
        }
        RunnableKind::Workflow => {
            let wf_id = config_str("entry")?;
            let sub = store::load_workflow(&wf_id).map_err(|e| {
                format!("plugin node: workflow runnable '{wf_id}' not found: {e}")
            })?;
            let mut sub_input = HashMap::new();
            sub_input.insert("input".to_string(), input.to_string());
            // Deterministic child run id (same scheme as a SubWorkflow node) so a
            // resumed parent re-enters the SAME inner run after a restart.
            let sub_run_id = format!("{run_id}-plugin-{node_id}");
            let result = run_workflow_inner(&sub, sub_input, sub_run_id, depth + 1).await?;
            Ok(result.output.values().next().cloned().unwrap_or_default())
        }
        RunnableKind::Companion
        | RunnableKind::Channel
        | RunnableKind::Engine
        | RunnableKind::Policy => Err(format!(
            "plugin node: runnable '{runnable_id}' has kind '{}', which is a surface/binding, not a runnable workflow step",
            entry.kind.as_str()
        )),
    }
}

/// Run a `Guardrails` node by routing the incoming text through the Gateway
/// firewall and failing the run when a requested guardrail trips.
///
/// Per the Core-vs-Gateway rule, *what is allowed* is the Gateway's job: Core
/// never reimplements the firewall policy here. It POSTs the text plus the
/// requested check set to `POST /v1/firewall/check` (which runs the gateway's
/// existing `FirewallScanner`) and, on a block, fails the node (which fails the
/// run). On PASS the incoming value is forwarded unchanged so downstream nodes
/// see the original input.
///
/// Fail-closed: if the gateway is unreachable the node fails rather than letting
/// unchecked text through, unless `RYU_ALLOW_GATEWAY_FALLBACK=1` is set (matching
/// the `run_prompt` posture), in which case the input is forwarded.
async fn run_guardrails(checks: &[String], input: &str) -> Result<String, String> {
    use crate::sidecar::gateway::{gateway_token, gateway_url};

    // No checks requested → nothing to enforce; pass the value through.
    if checks.is_empty() {
        return Ok(input.to_string());
    }

    let gw_url = gateway_url();
    let gw_token = gateway_token();

    let payload = serde_json::json!({
        "text": input,
        "checks": checks,
    });

    let client = reqwest::Client::new();
    let endpoint = format!("{}/v1/firewall/check", gw_url.trim_end_matches('/'));
    let mut builder = client.post(&endpoint).json(&payload);
    if let Some(token) = gw_token {
        builder = builder.bearer_auth(token);
    }

    let allow_fallback = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK")
        .ok()
        .is_some_and(|v| v == "1");

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            if allow_fallback {
                return Ok(input.to_string());
            }
            return Err(format!(
                "guardrails node: gateway unreachable (fail-closed): {e}"
            ));
        }
    };
    if !resp.status().is_success() {
        if allow_fallback {
            return Ok(input.to_string());
        }
        return Err(format!(
            "guardrails node: gateway firewall returned HTTP {}",
            resp.status()
        ));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("guardrails node: invalid gateway response: {e}"))?;
    let allowed = body
        .get("allowed")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if allowed {
        Ok(input.to_string())
    } else {
        let reason = body
            .get("reason")
            .and_then(|r| r.as_str())
            .unwrap_or("guardrail check failed");
        Err(format!("guardrails node: blocked: {reason}"))
    }
}

/// Post the input value to an external URL.
/// Execute a `Tool` node by invoking the MCP registry. The node `name` is the
/// fully-qualified tool id (`<server>__<tool>`). The node's `args` are merged
/// with the upstream `input` (exposed under an `input` key when `args` is a JSON
/// object), so a tool can receive both its static config and the live pipeline
/// value. Returns the tool result serialized as JSON text.
/// Recursively resolve `{{...}}` tokens in every string leaf of a JSON value,
/// leaving structure, numbers, and booleans untouched. Used so a Tool node's
/// `args` can reference upstream node outputs, run state, the incoming input, or
/// trigger fields.
fn resolve_json_strings(
    value: &serde_json::Value,
    ctx: &super::template::TemplateCtx,
) -> serde_json::Value {
    use super::template::resolve;
    match value {
        serde_json::Value::String(s) => serde_json::Value::String(resolve(s, ctx)),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(|v| resolve_json_strings(v, ctx)).collect())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), resolve_json_strings(v, ctx)))
                .collect(),
        ),
        other => other.clone(),
    }
}

async fn run_tool(
    name: &str,
    args: &serde_json::Value,
    input: &str,
    idem_key: &str,
) -> Result<String, String> {
    let registry = crate::sidecar::mcp::global_registry()
        .ok_or_else(|| "tool node: MCP registry not initialized".to_string())?;

    // Build the argument object: node args + the upstream `input` + a stable
    // idempotency key (a re-run after a crash carries the same key so a
    // cooperating tool can dedup the duplicate side effect).
    let arguments = build_tool_args(args, input, idem_key);

    let result = registry
        .call_tool(name, arguments, None)
        .await
        .map_err(|e| format!("tool node: '{name}' failed: {e}"))?;
    Ok(result.to_string())
}

async fn run_recipe(recipe: &str, params: &serde_json::Value) -> Result<String, String> {
    // Replay routes through the live ghost engine (input synthesis + AX). The
    // params object's string leaves were already template-resolved by the caller,
    // so `{{input}}`/`{{nodes.*}}` slots are filled before substitution.
    let result = crate::recipes::run(recipe, params.clone())
        .await
        .map_err(|e| format!("recipe node: '{recipe}' failed: {e}"))?;
    Ok(result.to_string())
}

/// Pure mapping from a recorded action verb + locator/params to the
/// fully-qualified ghost MCP tool id and its call arguments. Mirrors the recipe
/// replay step dispatch in `apps/ghost/src/tools/recipes.rs::execute_step` so a
/// `GhostAction` node produces the exact same tool call as the equivalent step
/// inside a full recipe replay. Returns `Ok(None)` for the pure-sleep actions
/// (`wait`/`delay`/`sleep`), which need no tool. Split out from
/// [`run_ghost_action`] so the mapping is unit-testable without the live engine.
fn ghost_action_call(
    action: &str,
    target: &serde_json::Value,
    params: &serde_json::Value,
) -> Result<Option<(String, serde_json::Value)>, String> {
    use serde_json::json;

    let tstr = |k: &str| {
        target
            .get(k)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
    };
    let pstr = |k: &str| params.get(k).and_then(|v| v.as_str());
    let pnum = |k: &str| {
        params.get(k).and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
        })
    };

    if matches!(action, "wait" | "delay" | "sleep") {
        return Ok(None);
    }

    let query = tstr("query").unwrap_or("");
    let app = tstr("app");

    let (tool, mut call): (&str, serde_json::Value) = match action {
        "click" => ("ghost__ghost_click", json!({ "query": query })),
        "double_click" => ("ghost__ghost_click", json!({ "query": query, "count": 2 })),
        "hover" => ("ghost__ghost_hover", json!({ "query": query })),
        "long_press" => ("ghost__ghost_long_press", json!({ "query": query })),
        "type" => (
            "ghost__ghost_type",
            json!({ "text": pstr("text").unwrap_or(""), "into": query }),
        ),
        "press" => (
            "ghost__ghost_press",
            json!({ "key": pstr("key").unwrap_or("return") }),
        ),
        "hotkey" | "keyboard_shortcut" => {
            let keys: Vec<String> = pstr("keys")
                .unwrap_or("")
                .split('+')
                .map(|s| s.trim().to_string())
                .collect();
            ("ghost__ghost_hotkey", json!({ "keys": keys }))
        }
        "scroll" => (
            "ghost__ghost_scroll",
            json!({
                "direction": pstr("direction").unwrap_or("down"),
                "amount": pnum("amount").map(|n| n as i64).unwrap_or(3),
            }),
        ),
        "focus" => (
            "ghost__ghost_focus",
            json!({ "app": app.or_else(|| pstr("app")).unwrap_or("") }),
        ),
        "drag" => ("ghost__ghost_drag", json!({})),
        "window" => (
            "ghost__ghost_window",
            json!({
                "action": pstr("action").unwrap_or("focus"),
                "app": app.or_else(|| pstr("app")).unwrap_or(""),
            }),
        ),
        "screenshot" => ("ghost__ghost_screenshot", json!({})),
        unknown => {
            return Err(format!(
                "unknown ghost action '{unknown}' — install the ghost sidecar (Windows-first) and record a supported step"
            ))
        }
    };

    // Inject the optional locator / coordinate fields exactly where the engine
    // does. `focus`/`window` already fold `app` into their base call above, and
    // `screenshot` takes none.
    if !matches!(action, "focus" | "window" | "screenshot") {
        if let Some(a) = app {
            call["app"] = json!(a);
        }
    }
    if matches!(
        action,
        "click" | "double_click" | "hover" | "long_press" | "type"
    ) {
        if let Some(id) = tstr("dom_id") {
            call["dom_id"] = json!(id);
        }
    }
    if matches!(action, "click" | "double_click" | "hover" | "long_press") {
        if let Some(c) = tstr("dom_class") {
            call["dom_class"] = json!(c);
        }
    }
    if action == "type" && params.get("clear").is_some() {
        call["clear"] = json!(true);
    }
    if matches!(action, "hover" | "long_press") {
        if let Some(x) = pnum("x") {
            call["x"] = json!(x);
        }
        if let Some(y) = pnum("y") {
            call["y"] = json!(y);
        }
    }
    if action == "long_press" {
        if let Some(d) = pnum("duration") {
            call["duration"] = json!(d);
        }
        if let Some(b) = pstr("button") {
            call["button"] = json!(b);
        }
    }
    if action == "drag" {
        for k in ["from_x", "from_y", "to_x", "to_y", "duration"] {
            if let Some(v) = pnum(k) {
                call[k] = json!(v);
            }
        }
    }

    Ok(Some((tool.to_string(), call)))
}

/// Execute a single recorded ghost action node through the live ghost engine.
/// `target`/`params` have already had their string leaves template-resolved by
/// the caller, so `{{input}}`/`{{nodes.*}}` slots are filled before dispatch.
async fn run_ghost_action(
    action: &str,
    target: &serde_json::Value,
    params: &serde_json::Value,
) -> Result<String, String> {
    let Some((tool, call)) = ghost_action_call(action, target, params)? else {
        // Pure-sleep action: no tool, just wait.
        let secs = params
            .get("seconds")
            .or_else(|| params.get("duration"))
            .and_then(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
            })
            .unwrap_or(1.0);
        tokio::time::sleep(tokio::time::Duration::from_secs_f64(secs)).await;
        return Ok(serde_json::json!({ "slept_secs": secs }).to_string());
    };

    let registry = crate::sidecar::mcp::global_registry()
        .ok_or_else(|| "ghost action node: MCP registry not initialized".to_string())?;
    let result = registry
        .call_tool(&tool, call, None)
        .await
        .map_err(|e| format!("ghost action node: '{action}' failed: {e}"))?;
    // Unwrap ghost's `{ content: [{ text }], isError? }` envelope; surface errors.
    crate::recipes::extract_mcp_json(&result)
        .map(|v| v.to_string())
        .map_err(|e| format!("ghost action node: '{action}' failed: {e}"))
}

async fn run_webhook(
    url: &str,
    method: &str,
    input: &str,
    idem_key: &str,
) -> Result<String, String> {
    // SSRF guard: only http/https, and the host must not resolve to an internal
    // address. Disable redirect following so a 30x cannot bounce us to one.
    validate_webhook_url(url).await?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("webhook node: client build failed: {e}"))?;
    let req = match method.to_uppercase().as_str() {
        "GET" => client.get(url),
        "PUT" => client.put(url),
        "DELETE" => client.delete(url),
        _ => client.post(url),
    };
    let resp = req
        .header("content-type", "application/json")
        // Stable across a resume so the receiver can dedup a retried delivery.
        // The key is sanitised to a safe token first: `node_id` is author-chosen
        // and could otherwise carry control characters that reqwest would reject
        // as an invalid header value (failing the whole request).
        .header("Idempotency-Key", header_safe_key(idem_key))
        .body(serde_json::json!({ "input": input }).to_string())
        .send()
        .await
        .map_err(|e| format!("webhook node: request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("webhook node: HTTP {status}: {text}"));
    }
    Ok(text)
}

/// Reject webhook URLs that could reach internal infrastructure (SSRF). Parses
/// the URL, requires an http/https scheme, resolves the host, and rejects the
/// request if *any* resolved address is loopback, link-local, private, CGNAT,
/// or unspecified.
async fn validate_webhook_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("webhook node: invalid url: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "webhook node: unsupported url scheme '{other}' (only http/https allowed)"
            ));
        }
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "webhook node: url has no host".to_string())?;
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("webhook node: cannot resolve host '{host}': {e}"))?;
    let mut resolved = false;
    for addr in addrs {
        resolved = true;
        if is_blocked_ip(&addr.ip()) {
            return Err(format!(
                "webhook node: host '{host}' resolves to a disallowed address ({})",
                addr.ip()
            ));
        }
    }
    if resolved {
        Ok(())
    } else {
        Err(format!("webhook node: host '{host}' did not resolve"))
    }
}

/// True if `ip` is in a range we must never let a webhook reach.
fn is_blocked_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                // CGNAT shared address space 100.64.0.0/10
                || (o[0] == 100 && (o[1] & 0xc0) == 64)
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // link-local fe80::/10
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                // unique-local fc00::/7
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                // IPv4-mapped/compatible: re-check the embedded v4 address
                || v6
                    .to_ipv4()
                    .is_some_and(|m| is_blocked_ip(&std::net::IpAddr::V4(m)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transforms_apply() {
        assert_eq!(apply_transform("uppercase", None, "hi").unwrap(), "HI");
        assert_eq!(apply_transform("lowercase", None, "HI").unwrap(), "hi");
        assert_eq!(apply_transform("trim", None, "  x ").unwrap(), "x");
        assert_eq!(
            apply_transform("template", Some("<{{input}}>"), "y").unwrap(),
            "<y>"
        );
        assert!(apply_transform("nope", None, "x").is_err());
    }

    // ── Retry / timeout / idempotency / durable timers ───────────────────────
    // (best-of Temporal RetryPolicy + StartToClose timeout, Restate idempotency
    // keys + durable timers)

    use crate::workflow::RetryPolicy;

    /// Fast retry policy for tests: tiny intervals so the loop spends its budget
    /// in milliseconds.
    fn fast_policy(max_attempts: u32) -> RetryPolicy {
        RetryPolicy {
            max_attempts,
            initial_interval_ms: 1,
            backoff_coefficient: 2.0,
            max_interval_ms: 10,
            jitter_fraction: 0.0,
            non_retryable_errors: Vec::new(),
        }
    }

    fn empty_input() -> HashMap<String, String> {
        HashMap::new()
    }

    #[test]
    fn decide_retry_budget_and_non_retryable() {
        // Budget spent (attempt == max) → Fail; budget left → Retry.
        assert!(matches!(
            decide_retry(&fast_policy(3), 3, 3, "boom"),
            RetryDecision::Fail
        ));
        assert!(matches!(
            decide_retry(&fast_policy(3), 1, 3, "boom"),
            RetryDecision::Retry(_)
        ));
        // Non-retryable substring (case-insensitive) fails fast regardless of budget.
        let mut p = fast_policy(5);
        p.non_retryable_errors = vec!["FORBIDDEN".into()];
        assert!(matches!(
            decide_retry(&p, 1, 5, "HTTP 403 Forbidden"),
            RetryDecision::Fail
        ));
        assert!(matches!(
            decide_retry(&p, 1, 5, "connection reset"),
            RetryDecision::Retry(_)
        ));
    }

    #[test]
    fn backoff_is_exponential_and_capped() {
        let p = RetryPolicy {
            max_attempts: 10,
            initial_interval_ms: 100,
            backoff_coefficient: 2.0,
            max_interval_ms: 500,
            jitter_fraction: 0.0,
            non_retryable_errors: Vec::new(),
        };
        assert_eq!(next_backoff_ms(&p, 1), 100); // 100 * 2^0
        assert_eq!(next_backoff_ms(&p, 2), 200); // 100 * 2^1
        assert_eq!(next_backoff_ms(&p, 3), 400); // 100 * 2^2
        assert_eq!(next_backoff_ms(&p, 4), 500); // 800 capped to 500
    }

    #[test]
    fn jitter_noop_when_off_or_out_of_range_else_in_band() {
        let mut p = fast_policy(3);
        p.jitter_fraction = 0.0;
        assert_eq!(apply_jitter(100, &p), 100);
        p.jitter_fraction = 1.5; // out of [0,1]
        assert_eq!(apply_jitter(100, &p), 100);
        p.jitter_fraction = 0.5; // ±50% band
        let j = apply_jitter(100, &p);
        assert!((50..=150).contains(&j), "jitter {j} out of ±50% band");
    }

    #[test]
    fn idempotency_key_is_stable_and_unique() {
        assert_eq!(idempotency_key("r1", "n1"), "r1:n1");
        assert_ne!(idempotency_key("r1", "n1"), idempotency_key("r2", "n1"));
        assert_ne!(idempotency_key("r1", "n1"), idempotency_key("r1", "n2"));
    }

    #[test]
    fn tool_args_inject_key_and_input_without_clobber() {
        use serde_json::json;
        let a = build_tool_args(&json!({"x": 1}), "hi", "r:n");
        assert_eq!(a["x"], json!(1));
        assert_eq!(a["input"], json!("hi"));
        assert_eq!(a["__ryu_idempotency_key"], json!("r:n"));
        // A pre-existing key is preserved (cooperating author may set one).
        let b = build_tool_args(&json!({"__ryu_idempotency_key": "keep"}), "hi", "r:n");
        assert_eq!(b["__ryu_idempotency_key"], json!("keep"));
        // Null and scalar args are wrapped into an object.
        let c = build_tool_args(&json!(null), "x", "k");
        assert_eq!(c["input"], json!("x"));
        let d = build_tool_args(&json!("scalar"), "x", "k");
        assert_eq!(d["args"], json!("scalar"));
        assert_eq!(d["__ryu_idempotency_key"], json!("k"));
    }

    #[test]
    fn retry_policy_serde_defaults_and_partial() {
        // Bare `{}` → defaults (max_attempts 1 = run once, coefficient 2.0).
        let p: RetryPolicy = serde_json::from_str("{}").unwrap();
        assert_eq!(p.max_attempts, 1);
        assert_eq!(p.backoff_coefficient, 2.0);
        // Partial JSON → unspecified fields fall back to defaults.
        let p2: RetryPolicy = serde_json::from_str(r#"{"max_attempts":5}"#).unwrap();
        assert_eq!(p2.max_attempts, 5);
        assert_eq!(p2.initial_interval_ms, 100);
    }

    #[test]
    fn node_and_run_state_back_compat_serde() {
        use crate::workflow::WorkflowNode;
        // Old node JSON (no retry/timeout) still deserializes.
        let n: WorkflowNode = serde_json::from_str(r#"{"id":"a","type":"input"}"#).unwrap();
        assert!(n.retry.is_none());
        assert!(n.timeout_ms.is_none());
        // Old run-state JSON (no attempts/wake_at) → safe defaults.
        let s: store::NodeRunState = serde_json::from_str(r#"{"status":"completed"}"#).unwrap();
        assert_eq!(s.attempts, 0);
        assert!(s.wake_at.is_none());
    }

    /// A perpetually-failing node with a 3-attempt policy spends its whole
    /// budget, records `attempts == 3`, then fails the run.
    #[tokio::test]
    async fn retry_exhausts_budget_then_fails() {
        use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};
        let wf = Workflow {
            id: format!("retry-{}", uuid::Uuid::new_v4().simple()),
            name: "r".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input { key: None },
                },
                WorkflowNode {
                    id: "t".into(),
                    retry: Some(fast_policy(3)),
                    timeout_ms: None,
                    // Always errors (no/empty MCP registry, or unknown tool).
                    kind: NodeKind::Tool {
                        name: "nope__nope".into(),
                        args: serde_json::json!({}),
                    },
                },
                WorkflowNode {
                    id: "out".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output { key: None },
                },
            ],
            edges: vec![
                WorkflowEdge {
                    from: "in".into(),
                    to: "t".into(),
                    branch: None,
                },
                WorkflowEdge {
                    from: "t".into(),
                    to: "out".into(),
                    branch: None,
                },
            ],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };
        let run_id = format!("rr-{}", uuid::Uuid::new_v4().simple());
        let res = run_workflow(&wf, empty_input(), run_id.clone()).await;
        assert!(res.is_err(), "perpetually-failing node must fail the run");
        let run = store::load_run(&run_id).expect("run persisted");
        assert_eq!(run.status, RunStatus::Failed);
        assert_eq!(
            run.nodes.get("t").map(|s| s.attempts),
            Some(3),
            "should spend the full 3-attempt budget"
        );
    }

    /// With no policy a failing node runs exactly once (back-compat behaviour).
    #[tokio::test]
    async fn no_policy_runs_once() {
        use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};
        let wf = Workflow {
            id: format!("once-{}", uuid::Uuid::new_v4().simple()),
            name: "o".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input { key: None },
                },
                WorkflowNode {
                    id: "t".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Tool {
                        name: "nope__nope".into(),
                        args: serde_json::json!({}),
                    },
                },
            ],
            edges: vec![WorkflowEdge {
                from: "in".into(),
                to: "t".into(),
                branch: None,
            }],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };
        let run_id = format!("or-{}", uuid::Uuid::new_v4().simple());
        let _ = run_workflow(&wf, empty_input(), run_id.clone()).await;
        let run = store::load_run(&run_id).expect("run persisted");
        assert_eq!(run.nodes.get("t").map(|s| s.attempts), Some(1));
    }

    /// A run whose checkpoint cannot be persisted must fail rather than
    /// continue: on a later crash/resume it would reload stale state and re-run
    /// already-completed side-effecting nodes. Fault injection: a run id
    /// containing `.` is outside `store`'s id charset, so every `save_run`
    /// returns `Err` — the very first checkpoint (marking the first node
    /// Running) must abort the run.
    #[tokio::test]
    async fn checkpoint_save_failure_fails_the_run() {
        use crate::workflow::{NodeKind, Workflow, WorkflowNode};
        let wf = Workflow {
            id: format!("ckpt-{}", uuid::Uuid::new_v4().simple()),
            name: "c".into(),
            description: None,
            nodes: vec![WorkflowNode {
                id: "in".into(),
                retry: None,
                timeout_ms: None,
                kind: NodeKind::Input { key: None },
            }],
            edges: Vec::new(),
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };
        let res = run_workflow(&wf, empty_input(), "bad.run.id".into()).await;
        let err = res.expect_err("run must fail when its checkpoint cannot be saved");
        assert!(
            err.contains("failed to persist checkpoint"),
            "unexpected error: {err}"
        );
    }

    /// A per-node timeout cancels a slow attempt and fails fast (Temporal
    /// StartToClose): a 20ms timeout on a 2s delay must not wait the full delay.
    #[tokio::test]
    async fn per_node_timeout_fails_fast() {
        use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};
        let wf = Workflow {
            id: format!("to-{}", uuid::Uuid::new_v4().simple()),
            name: "t".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input { key: None },
                },
                WorkflowNode {
                    id: "d".into(),
                    retry: None,
                    timeout_ms: Some(20),
                    kind: NodeKind::Delay { ms: 2000 },
                },
            ],
            edges: vec![WorkflowEdge {
                from: "in".into(),
                to: "d".into(),
                branch: None,
            }],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };
        let run_id = format!("tor-{}", uuid::Uuid::new_v4().simple());
        let start = tokio::time::Instant::now();
        let res = run_workflow(&wf, empty_input(), run_id.clone()).await;
        let err = res.expect_err("must fail on timeout");
        assert!(
            err.contains("timed out"),
            "expected a timeout error, got: {err}"
        );
        assert!(
            start.elapsed() < std::time::Duration::from_millis(1500),
            "must fail fast, not wait the full 2s delay"
        );
        let run = store::load_run(&run_id).expect("run persisted");
        assert_eq!(run.status, RunStatus::Failed);
    }

    /// Durable timer: a run pre-seeded with a `Delay` whose `wake_at` is already
    /// in the past resumes and completes immediately — it does NOT re-sleep the
    /// full (here 60s) duration. This is the crash-recovery guarantee.
    #[tokio::test]
    async fn durable_delay_resumes_with_remaining_time() {
        use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};
        let wf_id = format!("dd-{}", uuid::Uuid::new_v4().simple());
        let wf = Workflow {
            id: wf_id.clone(),
            name: "d".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input { key: None },
                },
                WorkflowNode {
                    id: "d".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Delay { ms: 60_000 },
                },
                WorkflowNode {
                    id: "out".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output { key: None },
                },
            ],
            edges: vec![
                WorkflowEdge {
                    from: "in".into(),
                    to: "d".into(),
                    branch: None,
                },
                WorkflowEdge {
                    from: "d".into(),
                    to: "out".into(),
                    branch: None,
                },
            ],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };
        // Pre-seed: the Delay node is Running with a wake_at 5s in the PAST.
        let run_id = format!("ddr-{}", uuid::Uuid::new_v4().simple());
        let mut pre = store::WorkflowRun::new(run_id.clone(), wf_id.clone(), empty_input());
        pre.nodes.insert(
            "d".into(),
            store::NodeRunState {
                status: NodeStatus::Running,
                output: None,
                error: None,
                attempts: 1,
                wake_at: Some((chrono::Utc::now() - chrono::Duration::seconds(5)).to_rfc3339()),
            },
        );
        store::save_run(&pre).expect("pre-seed save ok");

        let start = tokio::time::Instant::now();
        let run = run_workflow(&wf, empty_input(), run_id)
            .await
            .expect("resume ok");
        assert_eq!(run.status, RunStatus::Completed);
        assert!(
            start.elapsed() < std::time::Duration::from_secs(2),
            "wake_at was in the past → must not re-sleep the full delay"
        );
    }

    /// An `Awakeable` gate carrying a retry policy must still suspend (not be
    /// retried as a failure). The gate runs once and the run awaits input.
    #[tokio::test]
    async fn awakeable_with_retry_policy_suspends_not_retries() {
        use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};
        let wf = Workflow {
            id: format!("aw-{}", uuid::Uuid::new_v4().simple()),
            name: "a".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input { key: None },
                },
                WorkflowNode {
                    id: "gate".into(),
                    retry: Some(fast_policy(5)),
                    timeout_ms: None,
                    kind: NodeKind::Awakeable { prompt: None },
                },
                WorkflowNode {
                    id: "out".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output { key: None },
                },
            ],
            edges: vec![
                WorkflowEdge {
                    from: "in".into(),
                    to: "gate".into(),
                    branch: None,
                },
                WorkflowEdge {
                    from: "gate".into(),
                    to: "out".into(),
                    branch: None,
                },
            ],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };
        let run_id = format!("awr-{}", uuid::Uuid::new_v4().simple());
        let run = run_workflow(&wf, empty_input(), run_id)
            .await
            .expect("suspends ok");
        assert_eq!(run.status, RunStatus::AwaitingInput);
        assert_eq!(run.awaiting_node.as_deref(), Some("gate"));
        assert_eq!(
            run.nodes.get("gate").map(|s| s.attempts),
            Some(1),
            "the gate must run once and suspend, never retry"
        );
    }

    /// A `Delay` stamps and persists its `wake_at` on the FIRST run (not only on
    /// resume), and the instant survives into the Completed node state.
    #[tokio::test]
    async fn durable_delay_stamps_wake_at_on_first_run() {
        use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};
        let before = chrono::Utc::now();
        let wf = Workflow {
            id: format!("ws-{}", uuid::Uuid::new_v4().simple()),
            name: "s".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input { key: None },
                },
                WorkflowNode {
                    id: "d".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Delay { ms: 50 },
                },
            ],
            edges: vec![WorkflowEdge {
                from: "in".into(),
                to: "d".into(),
                branch: None,
            }],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };
        let run_id = format!("wsr-{}", uuid::Uuid::new_v4().simple());
        run_workflow(&wf, empty_input(), run_id.clone())
            .await
            .expect("ok");
        let run = store::load_run(&run_id).expect("run persisted");
        let wake_at = run
            .nodes
            .get("d")
            .and_then(|s| s.wake_at.clone())
            .expect("wake_at must be stamped on first run");
        let parsed = chrono::DateTime::parse_from_rfc3339(&wake_at)
            .expect("wake_at must be RFC3339")
            .with_timezone(&chrono::Utc);
        // ~50ms in the future of `before`, with generous slack for CI.
        assert!(
            parsed >= before && parsed <= before + chrono::Duration::seconds(2),
            "wake_at {parsed} should be ~now+50ms (ms, not seconds)"
        );
    }

    /// Timeout composes with retry: a per-node timeout produces a *retryable*
    /// error, so the retry loop re-runs the node and spends its whole budget. A
    /// `Delay{ms:10_000}` with a 30ms timeout can NEVER finish inside an attempt
    /// (no delay-vs-timeout race: the timeout always wins), so it deterministically
    /// times out every attempt and exhausts a 3-attempt budget.
    #[tokio::test]
    async fn timeout_is_retryable_and_exhausts_budget() {
        use crate::workflow::{NodeKind, RetryPolicy, Workflow, WorkflowEdge, WorkflowNode};
        let wf = Workflow {
            id: format!("trx-{}", uuid::Uuid::new_v4().simple()),
            name: "trx".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input { key: None },
                },
                WorkflowNode {
                    id: "d".into(),
                    retry: Some(RetryPolicy {
                        max_attempts: 3,
                        initial_interval_ms: 1,
                        backoff_coefficient: 1.0,
                        max_interval_ms: 5,
                        jitter_fraction: 0.0,
                        non_retryable_errors: Vec::new(),
                    }),
                    timeout_ms: Some(30),
                    kind: NodeKind::Delay { ms: 10_000 },
                },
            ],
            edges: vec![WorkflowEdge {
                from: "in".into(),
                to: "d".into(),
                branch: None,
            }],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };
        let run_id = format!("trxr-{}", uuid::Uuid::new_v4().simple());
        let res = run_workflow(&wf, empty_input(), run_id.clone()).await;
        let err = res.expect_err("every attempt times out → run fails");
        assert!(
            err.contains("timed out"),
            "expected a timeout error, got: {err}"
        );
        let run = store::load_run(&run_id).expect("run persisted");
        assert_eq!(run.status, RunStatus::Failed);
        assert_eq!(
            run.nodes.get("d").map(|s| s.attempts),
            Some(3),
            "a timeout must be retried until the budget is spent"
        );
    }

    /// The success-after-failure arm: a node that already has a prior failed
    /// attempt recorded (as after a crash+restart) completes on its next attempt,
    /// and the attempt counter accumulates across the resume rather than resetting.
    /// Deterministic — a `Transform` always succeeds, so there is no timing race.
    #[tokio::test]
    async fn node_succeeds_on_retry_accumulating_attempts() {
        use crate::workflow::{NodeKind, RetryPolicy, Workflow, WorkflowEdge, WorkflowNode};
        let wf_id = format!("sr-{}", uuid::Uuid::new_v4().simple());
        let wf = Workflow {
            id: wf_id.clone(),
            name: "sr".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input {
                        key: Some("text".into()),
                    },
                },
                WorkflowNode {
                    id: "up".into(),
                    retry: Some(RetryPolicy {
                        max_attempts: 5,
                        ..Default::default()
                    }),
                    timeout_ms: None,
                    kind: NodeKind::Transform {
                        op: "uppercase".into(),
                        template: None,
                    },
                },
                WorkflowNode {
                    id: "out".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output {
                        key: Some("result".into()),
                    },
                },
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
        };
        // Pre-seed: the Transform node has 2 prior (failed) attempts and is not
        // yet Completed — as if two attempts failed before a restart.
        let run_id = format!("srr-{}", uuid::Uuid::new_v4().simple());
        let mut input = HashMap::new();
        input.insert("text".to_string(), "hello".to_string());
        let mut pre = store::WorkflowRun::new(run_id.clone(), wf_id.clone(), input.clone());
        pre.nodes.insert(
            "up".into(),
            store::NodeRunState {
                status: NodeStatus::Running,
                output: None,
                error: Some("prior failure".into()),
                attempts: 2,
                wake_at: None,
            },
        );
        store::save_run(&pre).expect("pre-seed save ok");

        let run = run_workflow(&wf, input, run_id).await.expect("succeeds");
        assert_eq!(run.status, RunStatus::Completed);
        assert_eq!(run.output.get("result").map(String::as_str), Some("HELLO"));
        // Prior 2 attempts + this successful 3rd = 3 total (budget accumulates).
        assert_eq!(run.nodes.get("up").map(|s| s.attempts), Some(3));
    }

    /// A non-retryable error matched at run level fails immediately (attempts==1)
    /// even with a generous budget — the error string flows to `decide_retry`.
    #[tokio::test]
    async fn non_retryable_short_circuits_at_run_level() {
        use crate::workflow::{NodeKind, RetryPolicy, Workflow, WorkflowEdge, WorkflowNode};
        let wf = Workflow {
            id: format!("nr-{}", uuid::Uuid::new_v4().simple()),
            name: "nr".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input { key: None },
                },
                WorkflowNode {
                    id: "t".into(),
                    retry: Some(RetryPolicy {
                        max_attempts: 5,
                        initial_interval_ms: 1,
                        backoff_coefficient: 2.0,
                        max_interval_ms: 10,
                        jitter_fraction: 0.0,
                        // The Tool node's error always begins with "tool node:".
                        non_retryable_errors: vec!["tool node:".into()],
                    }),
                    timeout_ms: None,
                    kind: NodeKind::Tool {
                        name: "nope__nope".into(),
                        args: serde_json::json!({}),
                    },
                },
            ],
            edges: vec![WorkflowEdge {
                from: "in".into(),
                to: "t".into(),
                branch: None,
            }],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };
        let run_id = format!("nrr-{}", uuid::Uuid::new_v4().simple());
        let res = run_workflow(&wf, empty_input(), run_id.clone()).await;
        assert!(res.is_err());
        let run = store::load_run(&run_id).expect("run persisted");
        assert_eq!(run.status, RunStatus::Failed);
        assert_eq!(
            run.nodes.get("t").map(|s| s.attempts),
            Some(1),
            "non-retryable error must fail on the first attempt"
        );
    }

    #[test]
    fn header_safe_key_keeps_token_chars_and_replaces_others() {
        assert_eq!(header_safe_key("run-1:node_2"), "run-1:node_2");
        assert_eq!(header_safe_key("a b\nc"), "a-b-c");
        assert_eq!(header_safe_key("ok.id-9"), "ok.id-9");
    }

    #[test]
    fn ghost_action_maps_common_steps() {
        use serde_json::json;

        // click → ghost_click with query + app + dom locators.
        let (tool, call) = ghost_action_call(
            "click",
            &json!({ "query": "Compose", "app": "Gmail", "dom_id": "c1" }),
            &json!({}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(tool, "ghost__ghost_click");
        assert_eq!(call["query"], json!("Compose"));
        assert_eq!(call["app"], json!("Gmail"));
        assert_eq!(call["dom_id"], json!("c1"));

        // type → ghost_type with `into` (not `query`) and `text`.
        let (tool, call) = ghost_action_call(
            "type",
            &json!({ "query": "Recipient" }),
            &json!({ "text": "a@b.com" }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(tool, "ghost__ghost_type");
        assert_eq!(call["into"], json!("Recipient"));
        assert_eq!(call["text"], json!("a@b.com"));

        // hotkey → split keys on '+'.
        let (tool, call) = ghost_action_call("hotkey", &json!({}), &json!({ "keys": "ctrl + c" }))
            .unwrap()
            .unwrap();
        assert_eq!(tool, "ghost__ghost_hotkey");
        assert_eq!(call["keys"], json!(["ctrl", "c"]));

        // scroll → direction + numeric amount default.
        let (tool, call) = ghost_action_call("scroll", &json!({}), &json!({ "direction": "up" }))
            .unwrap()
            .unwrap();
        assert_eq!(tool, "ghost__ghost_scroll");
        assert_eq!(call["direction"], json!("up"));
        assert_eq!(call["amount"], json!(3));

        // focus → app from target, no duplicate app injection.
        let (tool, call) = ghost_action_call("focus", &json!({ "app": "Calculator" }), &json!({}))
            .unwrap()
            .unwrap();
        assert_eq!(tool, "ghost__ghost_focus");
        assert_eq!(call["app"], json!("Calculator"));

        // wait → no tool (pure sleep).
        assert!(
            ghost_action_call("wait", &json!({}), &json!({ "seconds": 2 }))
                .unwrap()
                .is_none()
        );

        // unknown → error.
        assert!(ghost_action_call("teleport", &json!({}), &json!({})).is_err());
    }

    #[test]
    fn conditions_evaluate() {
        assert!(eval_condition("input == \"yes\"", "yes"));
        assert!(!eval_condition("input == \"yes\"", "no"));
        assert!(eval_condition("input != \"yes\"", "no"));
        assert!(eval_condition("input contains \"ell\"", "hello"));
        assert!(eval_condition("input starts_with \"he\"", "hello"));
        assert!(!eval_condition("input starts_with \"lo\"", "hello"));
        assert!(eval_condition("input ends_with \"lo\"", "hello"));
        assert!(!eval_condition("input ends_with \"he\"", "hello"));
        assert!(eval_condition("input nonempty", "x"));
        assert!(eval_condition("input empty", ""));
    }

    #[test]
    fn while_cap_clamps_to_hard_max() {
        // An explicit override below the ceiling is honoured.
        assert_eq!(effective_while_cap(Some(5)), 5);
        // Above the ceiling is clamped down (never raised past the safety cap).
        assert_eq!(
            effective_while_cap(Some(MAX_WHILE_ITERATIONS + 50)),
            MAX_WHILE_ITERATIONS
        );
        // Unset / zero fall back to the engine default.
        assert_eq!(effective_while_cap(None), MAX_WHILE_ITERATIONS);
        assert_eq!(effective_while_cap(Some(0)), MAX_WHILE_ITERATIONS);
        // The capped decision stops at the lowered bound.
        assert_eq!(decide_while_capped(4, true, 5), (true, 5));
        assert_eq!(decide_while_capped(5, true, 5), (false, 5));
    }

    #[test]
    fn conditions_evaluate_numeric() {
        // Strict less-than / greater-than.
        assert!(eval_condition("input < 10", "3"));
        assert!(!eval_condition("input < 10", "10"));
        assert!(eval_condition("input > 5", "6"));
        assert!(!eval_condition("input > 5", "5"));
        // Inclusive variants — must not be mis-parsed as `< =` / `> =`.
        assert!(eval_condition("input <= 10", "10"));
        assert!(!eval_condition("input <= 10", "11"));
        assert!(eval_condition("input >= 5", "5"));
        assert!(!eval_condition("input >= 5", "4"));
        // Floats and whitespace are tolerated.
        assert!(eval_condition("input < 2.5", "2.49"));
        assert!(eval_condition("input <= 3 ", " 3 "));
        // Non-numeric operands are false (never panic / never truthy).
        assert!(!eval_condition("input < 10", "abc"));
        assert!(!eval_condition("input > x", "5"));
    }

    #[tokio::test]
    async fn runs_linear_transform_workflow() {
        use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};

        let wf = Workflow {
            id: format!("test-lin-{}", uuid::Uuid::new_v4().simple()),
            name: "lin".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input {
                        key: Some("text".into()),
                    },
                },
                WorkflowNode {
                    id: "up".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Transform {
                        op: "uppercase".into(),
                        template: None,
                    },
                },
                WorkflowNode {
                    id: "out".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output {
                        key: Some("result".into()),
                    },
                },
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
        };

        let mut input = HashMap::new();
        input.insert("text".to_string(), "hello".to_string());
        let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
        let run = run_workflow(&wf, input, run_id).await.expect("run ok");
        assert_eq!(run.status, RunStatus::Completed);
        assert_eq!(run.output.get("result").map(String::as_str), Some("HELLO"));
    }

    /// AC1 + AC3 + AC4: Awakeable suspend → disk-persist → resume → completion.
    ///
    /// This test covers the full HITL loop without Restate:
    ///
    /// 1. Run a workflow with an `Awakeable` gate mid-DAG.
    /// 2. The run suspends at the gate: status = `AwaitingInput`, `awaiting_node`
    ///    is set, and the state is persisted to disk.
    /// 3. Simulate a Core restart by **only** using `run_id` (no in-memory state
    ///    carryover). Load the run from disk, flip the gate to Completed with a
    ///    payload, persist, and call `run_workflow` again.
    /// 4. The executor skips the now-Completed gate and upstream nodes; it
    ///    executes only the downstream Output node, producing the payload.
    #[tokio::test]
    async fn awakeable_suspend_restart_resume_completes() {
        use crate::workflow::store::{NodeRunState, NodeStatus, RunStatus};
        use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};

        // Workflow: Input → Awakeable gate → Output
        let wf_id = format!("awk-wf-{}", uuid::Uuid::new_v4().simple());
        let wf = Workflow {
            id: wf_id.clone(),
            name: "awk-test".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input {
                        key: Some("initial".into()),
                    },
                },
                WorkflowNode {
                    id: "gate".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Awakeable {
                        prompt: Some("Approve?".into()),
                    },
                },
                WorkflowNode {
                    id: "out".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output {
                        key: Some("result".into()),
                    },
                },
            ],
            edges: vec![
                WorkflowEdge {
                    from: "in".into(),
                    to: "gate".into(),
                    branch: None,
                },
                WorkflowEdge {
                    from: "gate".into(),
                    to: "out".into(),
                    branch: None,
                },
            ],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };

        // Step 1: Initial run — hits the Awakeable gate and suspends.
        let run_id = format!("run-awk-{}", uuid::Uuid::new_v4().simple());
        let mut input = HashMap::new();
        input.insert("initial".to_string(), "hello".to_string());

        let suspended = run_workflow(&wf, input.clone(), run_id.clone())
            .await
            .expect("suspend should return Ok (not Err)");

        // AC1: status must reflect paused/awaiting-input.
        assert_eq!(
            suspended.status,
            RunStatus::AwaitingInput,
            "run must be AwaitingInput after hitting Awakeable gate"
        );
        assert_eq!(
            suspended.awaiting_node.as_deref(),
            Some("gate"),
            "awaiting_node must identify the gate"
        );

        // AC3: verify the run survives a "restart" by reading purely from disk.
        let from_disk = store::load_run(&run_id).expect("run must be persisted to disk");
        assert_eq!(
            from_disk.status,
            RunStatus::AwaitingInput,
            "disk state must be AwaitingInput"
        );
        assert_eq!(from_disk.awaiting_node.as_deref(), Some("gate"));

        // Step 2: Simulate resume (what the resume endpoint does).
        // Flip the gate to Completed with a payload, persist.
        let mut resuming = from_disk.clone();
        resuming.nodes.insert(
            "gate".to_string(),
            NodeRunState {
                status: NodeStatus::Completed,
                output: Some("approved".to_string()),
                error: None,
                attempts: 0,
                wake_at: None,
            },
        );
        resuming.status = RunStatus::Running;
        resuming.awaiting_node = None;
        store::save_run(&resuming).expect("save resumed run ok");

        // AC4: re-invoke with same run_id; executor loads from disk and continues.
        let completed = run_workflow(&wf, input, run_id.clone())
            .await
            .expect("resume run ok");

        assert_eq!(
            completed.status,
            RunStatus::Completed,
            "run must complete after resume"
        );
        // The Output node receives the gate's payload ("approved").
        assert_eq!(
            completed.output.get("result").map(String::as_str),
            Some("approved"),
            "output must be the resume payload"
        );
        // The gate node must still be Completed (not re-executed).
        assert_eq!(
            completed.nodes.get("gate").map(|s| s.status),
            Some(NodeStatus::Completed),
            "gate node must be Completed after resume"
        );
    }

    #[test]
    fn while_decides_continue_until_cap() {
        // A holding condition continues and increments the counter...
        assert_eq!(decide_while(0, true), (true, 1));
        assert_eq!(decide_while(5, true), (true, 6));
        // ...right up to the iteration just below the cap.
        assert_eq!(
            decide_while(MAX_WHILE_ITERATIONS - 1, true),
            (true, MAX_WHILE_ITERATIONS)
        );
        // At the cap the gate is forced to exit even though the condition holds.
        assert_eq!(
            decide_while(MAX_WHILE_ITERATIONS, true),
            (false, MAX_WHILE_ITERATIONS)
        );
    }

    #[test]
    fn while_exits_and_resets_when_condition_fails() {
        // A failing condition exits and resets the counter so a later re-entry
        // starts fresh.
        assert_eq!(decide_while(0, false), (false, 0));
        assert_eq!(decide_while(42, false), (false, 0));
    }

    /// A `While` gate whose condition is already false takes the exit (`false`)
    /// branch immediately, so only the exit subgraph runs to Output.
    #[tokio::test]
    async fn while_exits_immediately_when_condition_false() {
        use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};

        let wf = Workflow {
            id: format!("test-while-{}", uuid::Uuid::new_v4().simple()),
            name: "while".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input {
                        key: Some("v".into()),
                    },
                },
                WorkflowNode {
                    id: "loop".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::While {
                        // Input is "done", so `nonempty`... use an exact-match so the
                        // gate is false: continue only while input == "go".
                        expr: "input == \"go\"".into(),
                        body_workflow_id: None,
                        max_iterations: None,
                    },
                },
                WorkflowNode {
                    id: "body".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Transform {
                        op: "template".into(),
                        template: Some("BODY".into()),
                    },
                },
                WorkflowNode {
                    id: "after".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Transform {
                        op: "template".into(),
                        template: Some("AFTER".into()),
                    },
                },
                WorkflowNode {
                    id: "outBody".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output {
                        key: Some("b".into()),
                    },
                },
                WorkflowNode {
                    id: "outAfter".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output {
                        key: Some("a".into()),
                    },
                },
            ],
            edges: vec![
                WorkflowEdge {
                    from: "in".into(),
                    to: "loop".into(),
                    branch: None,
                },
                WorkflowEdge {
                    from: "loop".into(),
                    to: "body".into(),
                    branch: Some("true".into()),
                },
                WorkflowEdge {
                    from: "loop".into(),
                    to: "after".into(),
                    branch: Some("false".into()),
                },
                WorkflowEdge {
                    from: "body".into(),
                    to: "outBody".into(),
                    branch: None,
                },
                WorkflowEdge {
                    from: "after".into(),
                    to: "outAfter".into(),
                    branch: None,
                },
            ],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };

        let mut input = HashMap::new();
        input.insert("v".to_string(), "done".to_string());
        let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
        let run = run_workflow(&wf, input, run_id).await.expect("run ok");
        assert_eq!(run.status, RunStatus::Completed);
        // Exit branch ran...
        assert_eq!(run.output.get("a").map(String::as_str), Some("AFTER"));
        // ...and the continue branch was pruned (skipped, no output).
        assert_eq!(run.output.get("b"), None);
        assert_eq!(
            run.nodes.get("body").map(|s| s.status),
            Some(NodeStatus::Skipped)
        );
    }

    /// A real bounded `While` loop (`body_workflow_id` set) re-runs its body
    /// sub-workflow N>1 times and terminates when the condition flips.
    ///
    /// Body workflow: `input → Transform(template "{{input}}x") → output` — it
    /// appends one `x` to the carry per iteration. Parent: `input → While(loop) →
    /// output`, continuing while `input != "xxx"`. Seeded with "" the carry grows
    /// "" → "x" → "xx" → "xxx" over three iterations, then exits.
    #[tokio::test]
    async fn while_loop_increments_state_until_exit() {
        use crate::workflow::store;
        use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};

        // Persist the loop body workflow so `run_while_loop` can load it.
        let body_id = format!("whilebody{}", uuid::Uuid::new_v4().simple());
        let body = Workflow {
            id: body_id.clone(),
            name: "body".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "bin".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input {
                        key: Some("input".into()),
                    },
                },
                WorkflowNode {
                    id: "append".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Transform {
                        op: "template".into(),
                        template: Some("{{input}}x".into()),
                    },
                },
                WorkflowNode {
                    id: "bout".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output {
                        key: Some("r".into()),
                    },
                },
            ],
            edges: vec![
                WorkflowEdge {
                    from: "bin".into(),
                    to: "append".into(),
                    branch: None,
                },
                WorkflowEdge {
                    from: "append".into(),
                    to: "bout".into(),
                    branch: None,
                },
            ],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };
        store::save_workflow(&body).expect("save body workflow");

        // Parent: Input → While(loop) → Output.
        let wf = Workflow {
            id: format!("whileparent{}", uuid::Uuid::new_v4().simple()),
            name: "while-loop".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input {
                        key: Some("seed".into()),
                    },
                },
                WorkflowNode {
                    id: "loop".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::While {
                        expr: "input != \"xxx\"".into(),
                        body_workflow_id: Some(body_id.clone()),
                        max_iterations: None,
                    },
                },
                WorkflowNode {
                    id: "out".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output {
                        key: Some("result".into()),
                    },
                },
            ],
            edges: vec![
                WorkflowEdge {
                    from: "in".into(),
                    to: "loop".into(),
                    branch: None,
                },
                // Unlabelled forward edge: a looped While is a data node, not a
                // brancher, so its output flows straight through.
                WorkflowEdge {
                    from: "loop".into(),
                    to: "out".into(),
                    branch: None,
                },
            ],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };

        let mut input = HashMap::new();
        input.insert("seed".to_string(), String::new());
        let run_id = format!("run{}", uuid::Uuid::new_v4().simple());
        let run = run_workflow(&wf, input, run_id).await.expect("run ok");

        assert_eq!(run.status, RunStatus::Completed);
        // The loop ran three times (carry "" → "x" → "xx" → "xxx").
        assert_eq!(
            run.state.get("__while_loop").map(String::as_str),
            Some("3"),
            "loop must have iterated three times"
        );
        // The carry / node output is the terminal value.
        assert_eq!(
            run.state.get("__while_carry_loop").map(String::as_str),
            Some("xxx")
        );
        assert_eq!(run.output.get("result").map(String::as_str), Some("xxx"));
    }

    /// A looped `While` whose `body_workflow_id` is the parent workflow itself is
    /// rejected (would recurse infinitely).
    #[tokio::test]
    async fn while_loop_rejects_self_reference() {
        use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};

        let wf_id = format!("whileself{}", uuid::Uuid::new_v4().simple());
        let wf = Workflow {
            id: wf_id.clone(),
            name: "self".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input {
                        key: Some("seed".into()),
                    },
                },
                WorkflowNode {
                    id: "loop".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::While {
                        expr: "input nonempty".into(),
                        body_workflow_id: Some(wf_id.clone()),
                        max_iterations: None,
                    },
                },
                WorkflowNode {
                    id: "out".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output {
                        key: Some("result".into()),
                    },
                },
            ],
            edges: vec![
                WorkflowEdge {
                    from: "in".into(),
                    to: "loop".into(),
                    branch: None,
                },
                WorkflowEdge {
                    from: "loop".into(),
                    to: "out".into(),
                    branch: None,
                },
            ],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };

        let mut input = HashMap::new();
        input.insert("seed".to_string(), "go".to_string());
        let run_id = format!("run{}", uuid::Uuid::new_v4().simple());
        // A node error propagates as `Err` from `run_workflow` (only the Awakeable
        // suspend sentinel yields `Ok`), so the self-reference guard surfaces here.
        let err = run_workflow(&wf, input, run_id)
            .await
            .expect_err("self-reference must fail the run");
        assert!(
            err.contains("recurse"),
            "expected self-reference error, got: {err}"
        );
    }

    /// A `Note` node forwards its input untouched and contributes no run output.
    #[tokio::test]
    async fn note_passes_through_without_output() {
        use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};

        let wf = Workflow {
            id: format!("test-note-{}", uuid::Uuid::new_v4().simple()),
            name: "note".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input {
                        key: Some("v".into()),
                    },
                },
                WorkflowNode {
                    id: "doc".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Note {
                        text: "explains the next step".into(),
                    },
                },
                WorkflowNode {
                    id: "out".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output {
                        key: Some("r".into()),
                    },
                },
            ],
            edges: vec![
                WorkflowEdge {
                    from: "in".into(),
                    to: "doc".into(),
                    branch: None,
                },
                WorkflowEdge {
                    from: "doc".into(),
                    to: "out".into(),
                    branch: None,
                },
            ],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };

        let mut input = HashMap::new();
        input.insert("v".to_string(), "hello".to_string());
        let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
        let run = run_workflow(&wf, input, run_id).await.expect("run ok");
        assert_eq!(run.status, RunStatus::Completed);
        // The Note forwarded the input unchanged to Output.
        assert_eq!(run.output.get("r").map(String::as_str), Some("hello"));
    }

    #[tokio::test]
    async fn condition_prunes_branch() {
        use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};

        let wf = Workflow {
            id: format!("test-cond-{}", uuid::Uuid::new_v4().simple()),
            name: "cond".into(),
            description: None,
            nodes: vec![
                WorkflowNode {
                    id: "in".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Input {
                        key: Some("v".into()),
                    },
                },
                WorkflowNode {
                    id: "c".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Condition {
                        expr: "input == \"yes\"".into(),
                    },
                },
                WorkflowNode {
                    id: "yes".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Transform {
                        op: "template".into(),
                        template: Some("YESPATH".into()),
                    },
                },
                WorkflowNode {
                    id: "no".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Transform {
                        op: "template".into(),
                        template: Some("NOPATH".into()),
                    },
                },
                WorkflowNode {
                    id: "outYes".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output {
                        key: Some("y".into()),
                    },
                },
                WorkflowNode {
                    id: "outNo".into(),
                    retry: None,
                    timeout_ms: None,
                    kind: NodeKind::Output {
                        key: Some("n".into()),
                    },
                },
            ],
            edges: vec![
                WorkflowEdge {
                    from: "in".into(),
                    to: "c".into(),
                    branch: None,
                },
                WorkflowEdge {
                    from: "c".into(),
                    to: "yes".into(),
                    branch: Some("true".into()),
                },
                WorkflowEdge {
                    from: "c".into(),
                    to: "no".into(),
                    branch: Some("false".into()),
                },
                WorkflowEdge {
                    from: "yes".into(),
                    to: "outYes".into(),
                    branch: None,
                },
                WorkflowEdge {
                    from: "no".into(),
                    to: "outNo".into(),
                    branch: None,
                },
            ],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };

        let mut input = HashMap::new();
        input.insert("v".to_string(), "yes".to_string());
        let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
        let run = run_workflow(&wf, input, run_id).await.expect("run ok");
        assert_eq!(run.status, RunStatus::Completed);
        assert_eq!(run.output.get("y").map(String::as_str), Some("YESPATH"));
        // The false branch must have been pruned (skipped), not produce output.
        assert_eq!(run.output.get("n"), None);
        assert_eq!(
            run.nodes.get("no").map(|s| s.status),
            Some(NodeStatus::Skipped)
        );
    }

    #[tokio::test]
    async fn condition_branches_reconverge_on_one_output() {
        // A diamond: both Condition branches feed the SAME Output node. The
        // pruned branch must propagate its skip through the join so the Output
        // still fires with the taken branch's value (regression for the join
        // dead-end that stalled routing / classify-and-act / adversarial
        // templates).
        use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};

        let node = |id: &str, kind: NodeKind| WorkflowNode {
            id: id.into(),
            retry: None,
            timeout_ms: None,
            kind,
        };
        let edge = |from: &str, to: &str, branch: Option<&str>| WorkflowEdge {
            from: from.into(),
            to: to.into(),
            branch: branch.map(str::to_string),
        };

        let build = || Workflow {
            id: format!("test-diamond-{}", uuid::Uuid::new_v4().simple()),
            name: "diamond".into(),
            description: None,
            nodes: vec![
                node(
                    "in",
                    NodeKind::Input {
                        key: Some("v".into()),
                    },
                ),
                node(
                    "c",
                    NodeKind::Condition {
                        expr: "input == \"yes\"".into(),
                    },
                ),
                node(
                    "yes",
                    NodeKind::Transform {
                        op: "template".into(),
                        template: Some("YESPATH".into()),
                    },
                ),
                node(
                    "no",
                    NodeKind::Transform {
                        op: "template".into(),
                        template: Some("NOPATH".into()),
                    },
                ),
                node(
                    "out",
                    NodeKind::Output {
                        key: Some("r".into()),
                    },
                ),
            ],
            edges: vec![
                edge("in", "c", None),
                edge("c", "yes", Some("true")),
                edge("c", "no", Some("false")),
                edge("yes", "out", None),
                edge("no", "out", None),
            ],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        };

        // Taken branch = true.
        let mut input = HashMap::new();
        input.insert("v".to_string(), "yes".to_string());
        let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
        let run = run_workflow(&build(), input, run_id).await.expect("run ok");
        assert_eq!(run.status, RunStatus::Completed);
        assert_eq!(run.output.get("r").map(String::as_str), Some("YESPATH"));
        assert_eq!(
            run.nodes.get("no").map(|s| s.status),
            Some(NodeStatus::Skipped)
        );

        // Taken branch = false: the join must still fire with the other value.
        let mut input = HashMap::new();
        input.insert("v".to_string(), "no".to_string());
        let run_id = format!("run-{}", uuid::Uuid::new_v4().simple());
        let run = run_workflow(&build(), input, run_id).await.expect("run ok");
        assert_eq!(run.status, RunStatus::Completed);
        assert_eq!(run.output.get("r").map(String::as_str), Some("NOPATH"));
        assert_eq!(
            run.nodes.get("yes").map(|s| s.status),
            Some(NodeStatus::Skipped)
        );
    }

    // ── Agent / Skill / Mcp / Plugin node kinds (Runnable node support) ────────

    #[test]
    fn new_node_kinds_round_trip_wire_format() {
        use serde_json::json;

        // The desktop canvas flattens `NodeKind` onto `WorkflowNode` via
        // `#[serde(flatten)]` with a snake_case `type` tag — lock that shape so a
        // saved workflow keeps loading and the palette/config stay in sync.
        for (value, expected_type) in [
            (
                json!({ "type": "agent", "agent_id": "researcher", "task": "Summarise {{input}}" }),
                "agent",
            ),
            (
                json!({ "type": "skill", "skill": "pdf", "agent_id": null, "task": "{{input}}" }),
                "skill",
            ),
            (
                json!({ "type": "mcp", "server": "spider", "tool": "crawl", "args": { "url": "x" } }),
                "mcp",
            ),
            (
                json!({ "type": "plugin", "plugin_id": "com.example.app", "runnable_id": "r1", "args": {} }),
                "plugin",
            ),
        ] {
            let kind: NodeKind =
                serde_json::from_value(value.clone()).expect("deserialize new node kind");
            let back = serde_json::to_value(&kind).expect("serialize new node kind");
            assert_eq!(
                back.get("type").and_then(|v| v.as_str()),
                Some(expected_type),
                "type tag must round-trip for {expected_type}"
            );
        }
    }

    #[test]
    fn agent_and_skill_default_task_to_input() {
        use serde_json::json;

        // `task` is optional; when absent the executor falls back to `{{input}}`.
        let agent: NodeKind =
            serde_json::from_value(json!({ "type": "agent", "agent_id": "a" })).unwrap();
        match agent {
            NodeKind::Agent { agent_id, task } => {
                assert_eq!(agent_id, "a");
                assert_eq!(task, None);
            }
            other => panic!("expected Agent, got {other:?}"),
        }

        let skill: NodeKind =
            serde_json::from_value(json!({ "type": "skill", "skill": "s" })).unwrap();
        match skill {
            NodeKind::Skill {
                skill,
                agent_id,
                task,
            } => {
                assert_eq!(skill, "s");
                assert_eq!(agent_id, None);
                assert_eq!(task, None);
            }
            other => panic!("expected Skill, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn run_plugin_reports_missing_plugin() {
        // An id that is neither a built-in fixture nor an installed manifest must
        // fail with a clear "not installed" error rather than panicking.
        let err = run_plugin(
            "com.ryu.definitely-not-installed",
            "r1",
            &serde_json::json!({}),
            "input",
            "idem",
            "run",
            "node",
            0,
        )
        .await
        .expect_err("unknown plugin must error");
        assert!(
            err.contains("not installed"),
            "error should name the missing plugin: {err}"
        );
    }

    #[tokio::test]
    async fn run_skill_reports_missing_skill() {
        // A bogus skill id is never installed regardless of the skills dir, so the
        // node must fail clearly instead of silently producing empty output.
        let err = run_skill(
            "ryu:definitely-not-a-real-skill/v0",
            None,
            "input",
            "run",
            "node",
        )
        .await
        .expect_err("unknown skill must error");
        assert!(
            err.contains("not installed"),
            "error should name the missing skill: {err}"
        );
    }
}
