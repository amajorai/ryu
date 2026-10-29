//! Topological executor for the petgraph DAG engine.
//!
//! Execution model:
//!   - Nodes run in dependency order (a node runs once all its incoming edges
//!     have resolved). Independent ready nodes run **concurrently**, up to the
//!     workflow's `max_concurrency` (default [`DEFAULT_NODE_CONCURRENCY`]). Each
//!     in-flight node executes against a private copy of the run and every
//!     checkpoint it writes merges only its own changes into the canonical run
//!     (see [`BranchScope`]), so per-node checkpoints stay deterministic. The
//!     graph bookkeeping (joins, pruning, ready queue) stays serial in the
//!     coordinator. When a node fails, suspends, or parks, no new node starts;
//!     the nodes already in flight finish and are checkpointed before the run
//!     settles.
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
use std::sync::{Arc, Mutex, OnceLock, Weak};

use futures_util::stream::FuturesUnordered;
use futures_util::StreamExt;
use petgraph::graph::NodeIndex;
use petgraph::visit::EdgeRef;
use petgraph::Direction;

use super::history::CheckpointEvent;
use super::store::{self, NodeRunState, NodeStatus, RunStatus, WorkflowRun};
use super::{delegation, NodeKind, RepeatCollect, RepeatPolicy, Workflow, WorkflowGraph};

/// Sentinel error value returned by `execute_node` for an `Awakeable` gate (and a
/// `NotifyUser` node whose ack policy requires waiting). The outer loop treats
/// this as a suspend signal rather than a real error.
pub(crate) const SUSPEND_SENTINEL: &str = "__AWAKEABLE_SUSPEND__";

// Reserved durable links keep a child gate attached to its enclosing node without
// changing the public run schema. SetState cannot overwrite this namespace.
pub(crate) const PARENT_RUN_KEY: &str = "__workflow_parent_run";
const AWAITING_CHILD_KEY: &str = "__workflow_awaiting_child";

/// Serialize execution and gate decisions per persisted run. Parent execution
/// takes child locks in nesting order; resume releases the child before waking
/// ancestors, so an approval arriving during the suspend checkpoint cannot race
/// the parent's write or deadlock with it.
fn execution_lock(run_id: &str) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let key = format!("{}/{}", crate::paths::ryu_dir().display(), run_id);
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "workflow execution lock poisoned".to_string())?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

/// Whether some task in this process is executing `run_id` right now (holds its
/// execution lock). Lets auto-resume tell an interrupted `Running` checkpoint
/// from one a live request is still driving.
pub(crate) fn is_run_executing(run_id: &str) -> bool {
    execution_lock(run_id).is_ok_and(|lock| lock.try_lock().is_err())
}

/// Advance every enclosing run after a child decision. Links and loop carries
/// live on disk, so this also works when the approval occurs after a restart.
async fn continue_parent_runs(mut child: WorkflowRun) -> Result<WorkflowRun, String> {
    let mut seen = HashSet::new();
    while let Some(parent_id) = child.state.get(PARENT_RUN_KEY).cloned() {
        if !seen.insert(parent_id.clone()) || seen.len() > MAX_SUBWORKFLOW_DEPTH {
            return Err("invalid workflow parent chain".to_string());
        }
        // An approval can land while the parent is still executing (a fan-out
        // item gated early while its siblings run), before the parent's settle
        // checkpoint has written the link to this child. Wait for that checkpoint,
        // so the link is read once it is on disk and the parent is woken instead
        // of left suspended on a child that is already decided. The lock is not
        // held past the read: `run_workflow` below takes it again.
        let parent = {
            let lock = execution_lock(&parent_id)?;
            let _settled = lock.lock().await;
            store::load_run(&parent_id)
                .map_err(|e| format!("failed to load enclosing run '{parent_id}': {e}"))?
        };
        if parent.state.get(AWAITING_CHILD_KEY) != Some(&child.run_id) {
            break;
        }
        if matches!(parent.status, RunStatus::Completed | RunStatus::Failed) {
            // Recovery may observe a terminal intermediate parent whose own
            // ancestor has not yet consumed that checkpoint.
            child = parent;
            continue;
        }
        if child.status == RunStatus::Failed {
            // A rejected child must fail its enclosing runs even when their
            // definitions/agents are no longer executable. Do not run lifecycle
            // preflight, retries, or downstream effects to propagate a denial.
            let lock = execution_lock(&parent_id)?;
            let guard = lock.lock_owned().await;
            let mut parent = store::load_run(&parent_id)
                .map_err(|e| format!("failed to load enclosing run: {e}"))?;
            if parent.state.get(AWAITING_CHILD_KEY) != Some(&child.run_id) {
                break;
            }
            if !matches!(parent.status, RunStatus::Completed | RunStatus::Failed) {
                let error = format!(
                    "child workflow failed: {}",
                    child.error.as_deref().unwrap_or("unknown error")
                );
                if let Some(node_id) = parent.awaiting_node.clone() {
                    mark(
                        &mut parent,
                        &node_id,
                        NodeStatus::Failed,
                        None,
                        Some(error.clone()),
                    );
                }
                parent.status = RunStatus::Failed;
                parent.error = Some(error.clone());
                parent.awaiting_node = None;
                parent.updated_at = chrono::Utc::now().to_rfc3339();
                checkpoint_run(&parent, ExecutionMode::Live)?;
                crate::plugin_host::fire_workflow_run_event(
                    crate::plugin_host::ON_WORKFLOW_RUN_FAILED,
                    serde_json::json!({ "run_id": parent.run_id, "workflow_id": parent.workflow_id, "status": "failed", "error": error }),
                );
            }
            drop(guard);
            child = parent;
            continue;
        }
        let workflow = store::load_workflow(&parent.workflow_id)
            .map_err(|e| format!("failed to load enclosing workflow: {e}"))?;
        let parent_id = parent.run_id.clone();
        child = match run_workflow(&workflow, parent.input, parent.run_id).await {
            Ok(result) => result,
            Err(error) => {
                let failed = store::load_run(&parent_id).map_err(|_| error.clone())?;
                if failed.status != RunStatus::Failed {
                    return Err(error);
                }
                failed
            }
        };
    }
    Ok(child)
}

fn persisted_nesting_depth(run: &WorkflowRun) -> Result<usize, String> {
    let mut parent_id = run.state.get(PARENT_RUN_KEY).cloned();
    let mut seen = HashSet::from([run.run_id.clone()]);
    while let Some(id) = parent_id {
        if !seen.insert(id.clone()) || seen.len() > MAX_SUBWORKFLOW_DEPTH + 1 {
            return Err("invalid workflow parent chain".to_string());
        }
        let parent =
            store::load_run(&id).map_err(|e| format!("failed to load parent checkpoint: {e}"))?;
        parent_id = parent.state.get(PARENT_RUN_KEY).cloned();
    }
    Ok(seen.len() - 1)
}

/// Maximum nested SubWorkflow depth, guards against accidental deep nesting.
const MAX_SUBWORKFLOW_DEPTH: usize = 8;
const MAX_WEBHOOK_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// Hard ceiling on body iterations for a bounded `While` loop. The optional
/// node-specific cap can lower this bound but cannot raise it. Body-less While
/// nodes remain one-shot branch gates; body workflows execute as child runs so
/// the enclosing DAG remains acyclic. See the [`NodeKind::While`] doc.
pub const MAX_WHILE_ITERATIONS: u64 = 100;

/// Hard ceiling on iterations for a step's [`RepeatPolicy`]. Shares the `While`
/// backstop: a policy can lower the bound but never raise it.
pub const MAX_REPEAT_ITERATIONS: u64 = MAX_WHILE_ITERATIONS;

/// Hard ceiling on a [`RepeatPolicy`]'s `interval_ms` (1 hour). The pause holds
/// the run task open, so longer waits belong in a schedule trigger instead.
pub const MAX_REPEAT_INTERVAL_MS: u64 = 60 * 60 * 1000;

/// Reserved run-state namespace for repeat progress (`__repeat_count_<id>`,
/// `__repeat_carry_<id>`, ...). SetState cannot write it.
const REPEAT_STATE_PREFIX: &str = "__repeat_";

/// Reserved run-state namespace backing the `{{loop.*}}` template tokens of the
/// step currently repeating (see [`super::template`]).
pub(crate) const LOOP_STATE_PREFIX: &str = "__loop_";

fn repeat_state_key(field: &str, node_id: &str) -> String {
    format!("{REPEAT_STATE_PREFIX}{field}_{node_id}")
}

/// Decide whether a repeating step runs again after finishing iteration number
/// `completed` (1-based). Pure so the exit rules are unit-testable. Checked in
/// order: the iteration cap, `until` holding, `while` failing, and an unchanged
/// output when `stop_when_unchanged` is set.
pub fn decide_repeat(
    policy: &RepeatPolicy,
    completed: u64,
    until_holds: bool,
    while_holds: bool,
    unchanged: bool,
) -> bool {
    completed < policy.effective_max_iterations()
        && !until_holds
        && while_holds
        && !(policy.stop_when_unchanged && unchanged)
}

/// The id a node's side effects are keyed by: its own id, or `<id>__repeat<k>`
/// for the k-th repeat iteration (k >= 1). Idempotency keys, agent
/// conversations, delegation checkpoints, and child runs derive from this, so
/// each iteration is a distinct effect while a resumed iteration reuses its key.
fn iteration_scoped_id(run: &WorkflowRun, node_id: &str) -> String {
    match run
        .state
        .get(&repeat_state_key("count", node_id))
        .and_then(|v| v.parse::<u64>().ok())
    {
        Some(k) if k > 0 => format!("{node_id}__repeat{k}"),
        _ => node_id.to_owned(),
    }
}

/// Durable progress of one repeating step. Loaded from run state when the node
/// (re-)enters, so a resumed run continues from the last finished iteration.
struct RepeatProgress<'a> {
    policy: &'a RepeatPolicy,
    node_id: &'a str,
    original: String,
    completed: u64,
    carry: String,
    last: Option<String>,
    outputs: Vec<String>,
}

impl<'a> RepeatProgress<'a> {
    fn load(policy: &'a RepeatPolicy, node_id: &'a str, original: &str, run: &WorkflowRun) -> Self {
        let get = |field: &str| run.state.get(&repeat_state_key(field, node_id)).cloned();
        Self {
            policy,
            node_id,
            original: original.to_owned(),
            completed: get("count").and_then(|v| v.parse().ok()).unwrap_or(0),
            carry: get("carry").unwrap_or_else(|| original.to_owned()),
            last: get("last"),
            outputs: get("outputs")
                .and_then(|v| serde_json::from_str(&v).ok())
                .unwrap_or_default(),
        }
    }

    /// Publish the `{{loop.*}}` tokens for the iteration about to run.
    fn expose(&self, run: &mut WorkflowRun) {
        let vars = [
            ("iteration", (self.completed + 1).to_string()),
            ("previous", self.last.clone().unwrap_or_default()),
            ("original", self.original.clone()),
        ];
        for (name, value) in vars {
            run.state
                .insert(format!("{LOOP_STATE_PREFIX}{name}"), value);
        }
    }

    /// Fold one finished iteration in and decide whether another runs. When it
    /// does, the progress is written to run state for the caller to checkpoint.
    fn advance(&mut self, output: String, run: &mut WorkflowRun) -> bool {
        use super::template::resolve;

        let unchanged = self.last.as_deref() == Some(output.as_str());
        self.completed += 1;
        let ctx = build_template_ctx(&output, run);
        let holds = |expr: &str| eval_condition(&resolve(expr, &ctx), &output);
        let until_holds = self.policy.until_expr().is_some_and(holds);
        let while_holds = self.policy.while_condition().is_none_or(holds);
        let again = decide_repeat(
            self.policy,
            self.completed,
            until_holds,
            while_holds,
            unchanged,
        );

        if self.policy.collect == RepeatCollect::All {
            self.outputs.push(output.clone());
        }
        self.carry = if self.policy.feed_output {
            output.clone()
        } else {
            self.original.clone()
        };
        self.last = Some(output);
        if again {
            self.persist(run);
        }
        again
    }

    fn persist(&self, run: &mut WorkflowRun) {
        let mut put = |field: &str, value: String| {
            run.state
                .insert(repeat_state_key(field, self.node_id), value);
        };
        put("count", self.completed.to_string());
        put("carry", self.carry.clone());
        put("last", self.last.clone().unwrap_or_default());
        if self.policy.collect == RepeatCollect::All {
            put(
                "outputs",
                serde_json::to_string(&self.outputs).unwrap_or_default(),
            );
        }
        // The next iteration gets a fresh retry budget and its own durable timer.
        if let Some(state) = run.nodes.get_mut(self.node_id) {
            state.attempts = 0;
            state.wake_at = None;
        }
    }

    /// Stamp the durable instant the next iteration may start, so a restart
    /// during the pause resumes with only the remaining wait. The caller
    /// checkpoints it with the finished iteration.
    fn schedule_next(&self, run: &mut WorkflowRun) {
        let interval_ms = self.policy.interval_ms.min(MAX_REPEAT_INTERVAL_MS);
        if interval_ms == 0 {
            return;
        }
        let wake_at = chrono::Utc::now() + chrono::Duration::milliseconds(interval_ms as i64);
        run.state.insert(
            repeat_state_key("wake_at", self.node_id),
            wake_at.to_rfc3339(),
        );
    }

    /// Wait out any pending pause before the next iteration. Only the time left
    /// until the persisted `wake_at` is slept (never more than the capped
    /// interval, so a forward-dated stamp cannot park the run), and the stamp is
    /// cleared so the iteration's own checkpoint records that the pause ended.
    async fn wait_for_interval(&self, run: &mut WorkflowRun) {
        let Some(stamp) = run.state.remove(&repeat_state_key("wake_at", self.node_id)) else {
            return;
        };
        let Ok(wake_at) = chrono::DateTime::parse_from_rfc3339(&stamp) else {
            return;
        };
        let remaining = (wake_at.with_timezone(&chrono::Utc) - chrono::Utc::now())
            .num_milliseconds()
            .max(0) as u64;
        let remaining = remaining.min(self.policy.interval_ms.min(MAX_REPEAT_INTERVAL_MS));
        if remaining > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(remaining)).await;
        }
    }

    /// End the loop: drop the transient progress (the iteration count stays as
    /// a record of how many times the step ran) and produce the step's value.
    fn finish(self, run: &mut WorkflowRun) -> String {
        run.state.insert(
            repeat_state_key("count", self.node_id),
            self.completed.to_string(),
        );
        for field in ["carry", "last", "outputs", "wake_at"] {
            run.state.remove(&repeat_state_key(field, self.node_id));
        }
        run.state
            .retain(|key, _| !key.starts_with(LOOP_STATE_PREFIX));
        match self.policy.collect {
            RepeatCollect::Last => self.last.unwrap_or_default(),
            RepeatCollect::All => serde_json::to_string(&self.outputs).unwrap_or_default(),
        }
    }
}

/// Whether a workflow execution may create durable state or invoke effectful
/// nodes. Dry runs are deliberately a separate execution mode so a caller
/// cannot accidentally turn a read-only preview into a normal durable run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExecutionMode {
    Live,
    DryRun,
}

impl ExecutionMode {
    const fn is_dry_run(self) -> bool {
        matches!(self, Self::DryRun)
    }
}

/// Save a checkpoint only for a live execution. Keeping this guard at the
/// executor boundary makes every existing checkpoint call dry-run safe,
/// including nested workflows, loop iterations, retries, and durable timers.
///
/// Inside a dispatched branch (see [`BranchScope`]) a checkpoint of the branch's
/// own run merges the branch's changes into the canonical run and saves that, so
/// concurrently executing nodes never overwrite each other's progress.
fn checkpoint_run(run: &WorkflowRun, mode: ExecutionMode) -> Result<(), String> {
    if mode.is_dry_run() {
        return Ok(());
    }
    let scope = BRANCH_SCOPE
        .try_with(|scope| (scope.run_id == run.run_id).then(|| Arc::clone(scope)))
        .ok()
        .flatten();
    match scope {
        Some(scope) => scope.checkpoint(run),
        None => store::save_run(run).map_err(|e| format!("failed to persist checkpoint: {e}")),
    }
}

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
/// Run-lifecycle hooks fire from HERE and not from the status assignments inside
/// [`run_workflow_inner`], which is deliberate. That function is re-entered on every
/// resume and recurses for sub-workflows, so firing at its `RunStatus` writes would
/// emit `workflow_run_started` again for each resume and once per nested
/// sub-workflow — a consumer counting runs would over-count and a consumer
/// summarizing them would summarize fragments. This wrapper is the one boundary that
/// corresponds to what a user calls "a run".
/// Conversation id prefix of a workflow agent node's chat: `wfrun-<run>-<node>`.
const WORKFLOW_CONVERSATION_PREFIX: &str = "wfrun-";

pub async fn run_workflow(
    workflow: &Workflow,
    input: HashMap<String, String>,
    run_id: String,
) -> Result<WorkflowRun, String> {
    // A live run (manual, scheduled, triggered, resumed) is the user using Ryu,
    // so it marks today active for the profile streak. In-memory only.
    crate::profile_activity::note_activity();
    run_workflow_with_mode(workflow, input, run_id, ExecutionMode::Live).await
}

/// Evaluate a workflow without creating run history or invoking effectful
/// nodes. Pure nodes and MCP tools classified as read-only are evaluated in
/// memory; writes, prompts, notifications, webhooks, desktop actions, and
/// other effectful nodes are marked `Skipped` with a reason.
///
/// The returned [`WorkflowRun`] is a transient projection. Its `run_id` is
/// useful for correlating the response, but it must not be passed to resume or
/// expected to be readable from [`store::load_run`].
pub async fn dry_run_workflow(
    workflow: &Workflow,
    input: HashMap<String, String>,
    run_id: String,
) -> Result<WorkflowRun, String> {
    run_workflow_with_mode(workflow, input, run_id, ExecutionMode::DryRun).await
}

async fn run_workflow_with_mode(
    workflow: &Workflow,
    input: HashMap<String, String>,
    run_id: String,
    mode: ExecutionMode,
) -> Result<WorkflowRun, String> {
    crate::workflow::ensure_agents_active(workflow).await?;
    if !mode.is_dry_run() {
        crate::plugin_host::fire_workflow_run_event(
            crate::plugin_host::ON_WORKFLOW_RUN_STARTED,
            serde_json::json!({
                "run_id": run_id,
                "workflow_id": workflow.id,
                "workflow_name": workflow.name,
            }),
        );
    }

    let outcome = run_workflow_inner(workflow, input, run_id.clone(), 0, mode).await;

    if mode.is_dry_run() {
        return outcome;
    }

    // Each agent node ran in its own `wfrun-<run>-<node>` chat. Those pooled agent
    // processes would otherwise idle out one by one; nothing reuses them once the
    // run has stopped (a resumed run skips its completed nodes).
    crate::sidecar::adapters::acp::close_conversation_instances_with_prefix(&format!(
        "{WORKFLOW_CONVERSATION_PREFIX}{run_id}-"
    ));

    match &outcome {
        // A run that suspended at an approval gate has NOT finished — it is waiting
        // on a human and will come back through `resume_run`. Emitting `finished`
        // here would tell a consumer the work is done while it is still pending.
        Ok(run)
            if matches!(
                run.status,
                store::RunStatus::AwaitingInput | store::RunStatus::Waiting
            ) => {}
        Ok(run) => crate::plugin_host::fire_workflow_run_event(
            if run.status == store::RunStatus::Failed {
                crate::plugin_host::ON_WORKFLOW_RUN_FAILED
            } else {
                crate::plugin_host::ON_WORKFLOW_RUN_FINISHED
            },
            serde_json::json!({
                "run_id": run.run_id,
                "workflow_id": run.workflow_id,
                "workflow_name": workflow.name,
                "status": format!("{:?}", run.status).to_lowercase(),
                "error": run.error,
                "output": run.output,
            }),
        ),
        // An `Err` here is the executor refusing to run at all (a malformed graph,
        // nesting depth exceeded) — no run reached a terminal state, but from the
        // caller's point of view the run failed, so a consumer watching for failures
        // must still see it.
        Err(e) => crate::plugin_host::fire_workflow_run_event(
            crate::plugin_host::ON_WORKFLOW_RUN_FAILED,
            serde_json::json!({
                "run_id": run_id,
                "workflow_id": workflow.id,
                "workflow_name": workflow.name,
                "status": "failed",
                "error": e,
            }),
        ),
    }

    outcome
}

/// Resume a workflow run suspended at its `Awakeable` gate: flip the gate node to
/// `Completed` carrying `payload`, persist, then re-invoke the executor (which
/// skips the now-completed gate and continues downstream). This is the reusable
/// core of the HTTP resume handler, also called by the approval engine when a
/// workflow-gate request is approved — so an approved resume is byte-identical to
/// a manual one.
pub async fn resume_run(run_id: &str, payload: String) -> Result<WorkflowRun, String> {
    resume_run_inner(run_id, payload, false).await
}

/// Resume a `NotifyUser` gate after the notification endpoint has recorded an
/// authorized member acknowledgement. This is intentionally separate from the
/// public resume endpoint: a caller must not bypass a multi-person approval by
/// posting directly to `/workflows/runs/:run_id/resume`.
pub(crate) async fn resume_run_after_notify_ack(
    run_id: &str,
    payload: String,
) -> Result<WorkflowRun, String> {
    resume_run_inner(run_id, payload, true).await
}

async fn locked_gate_target(
    run_id: &str,
) -> Result<(WorkflowRun, tokio::sync::OwnedMutexGuard<()>), String> {
    let mut target_id = run_id.to_string();
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(target_id.clone()) || seen.len() > MAX_SUBWORKFLOW_DEPTH + 1 {
            return Err("invalid workflow child chain".to_string());
        }
        let lock = execution_lock(&target_id)?;
        let guard = lock.lock_owned().await;
        let current = store::load_run(&target_id).map_err(|_| "run not found".to_string())?;
        if current.status == RunStatus::AwaitingInput {
            if let Some(child_id) = current.state.get(AWAITING_CHILD_KEY) {
                let child =
                    store::load_run(child_id).map_err(|e| format!("child run not found: {e}"))?;
                if child.state.get(PARENT_RUN_KEY) != Some(&current.run_id) {
                    return Err("invalid workflow child link".to_string());
                }
                target_id = child_id.clone();
                drop(guard);
                continue;
            }
        }
        return Ok((current, guard));
    }
}

async fn resume_run_inner(
    run_id: &str,
    payload: String,
    allow_notify_ack: bool,
) -> Result<WorkflowRun, String> {
    use store::{NodeRunState, NodeStatus, RunStatus};

    let (mut run, gate_guard) = locked_gate_target(run_id).await?;
    let target_id = run.run_id.clone();
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

    let definition_is_notify_gate = workflow
        .nodes
        .iter()
        .any(|node| node.id == gate_node_id && matches!(&node.kind, NodeKind::NotifyUser { .. }));
    let persisted_is_notify_gate = super::notify_user::has_ack_state(&run, &gate_node_id);
    if !allow_notify_ack && (definition_is_notify_gate || persisted_is_notify_gate) {
        return Err(
            "run is awaiting member acknowledgements; acknowledge a notification instead"
                .to_string(),
        );
    }

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

    drop(gate_guard);
    match run_workflow(&workflow, run.input.clone(), target_id.clone()).await {
        Ok(child) => {
            continue_parent_runs(child).await?;
            // The resume endpoint addresses one run; ancestor propagation must
            // not change the identity of the resource returned to its caller.
            store::load_run(run_id).map_err(|e| format!("failed to load resumed run: {e}"))
        }
        Err(error) => {
            let child = store::load_run(&target_id).map_err(|_| error.clone())?;
            if child.status == RunStatus::Failed {
                continue_parent_runs(child).await?;
            }
            Err(error)
        }
    }
}

/// Fail a workflow run (e.g. its `Awakeable` approval gate was rejected/expired),
/// stamping `Failed` + `error` and clearing the awaiting gate so it never hangs
/// suspended. No-op-safe if the run is already terminal.
pub async fn fail_run(run_id: &str, error: &str) -> Result<(), String> {
    use store::RunStatus;

    let (mut run, gate_guard) = locked_gate_target(run_id).await?;
    let failed_id = run.run_id.clone();
    if run.status == RunStatus::Completed {
        return Ok(());
    }
    if run.status == RunStatus::Failed {
        drop(gate_guard);
        continue_parent_runs(run).await?;
        return Ok(());
    }
    run.status = RunStatus::Failed;
    run.error = Some(error.to_string());
    run.awaiting_node = None;
    run.updated_at = chrono::Utc::now().to_rfc3339();
    let saved = store::save_run(&run).map_err(|e| format!("failed to persist run failure: {e}"));

    // A run failed HERE (a rejected/expired approval gate) never returns through
    // `run_workflow`, so its failure hook has to fire from this path too. The
    // early-return above keeps it from double-firing on an already-terminal run.
    if saved.is_ok() {
        crate::plugin_host::fire_workflow_run_event(
            crate::plugin_host::ON_WORKFLOW_RUN_FAILED,
            serde_json::json!({
                "run_id": failed_id,
                "workflow_id": run.workflow_id,
                "status": "failed",
                "error": error,
            }),
        );
    }

    // Raise `core#run.failed` (a subscriber such as Self-Healing may propose a
    // diagnosed retry). Synchronous queueing only, so it never blocks or fails the
    // fail_run write. A subscriber's own never-heal-a-heal guard (`healrun_` ids)
    // stops a retry that itself fails from looping.
    if saved.is_ok() {
        crate::run_failures::report_workflow_failure(&failed_id, error);
    }
    drop(gate_guard);
    saved?;
    continue_parent_runs(run).await?;
    Ok(())
}

/// Re-run a failed workflow from scratch: load the failed run, load its workflow,
/// and start a FRESH run with the same inputs under a new
/// [`ryu_healing_contracts::HEAL_PREFIX`]-prefixed id (the never-heal-a-heal marker,
/// so a retry that itself fails won't be re-healed — the healing sidecar reads the
/// prefix back off the next failure, which is why it is a shared constant).
/// Used by the self-healing loop's approved workflow fix.
pub async fn rerun_run(run_id: &str) -> Result<WorkflowRun, String> {
    let run = store::load_run(run_id).map_err(|_| "run not found".to_string())?;
    let workflow = store::load_workflow(&run.workflow_id)
        .map_err(|_| format!("workflow '{}' not found", run.workflow_id))?;
    let new_id = format!(
        "{}{}",
        ryu_healing_contracts::HEAL_PREFIX,
        uuid::Uuid::new_v4().simple()
    );
    run_workflow(&workflow, run.input.clone(), new_id).await
}

/// Run-state namespaces the engine owns. They never carry a fork's links or
/// in-flight loop progress over from the parent, and a fork's `state_patch`
/// cannot write them.
const ENGINE_STATE_PREFIXES: [&str; 6] = [
    "__workflow_",
    REPEAT_STATE_PREFIX,
    LOOP_STATE_PREFIX,
    FANOUT_STATE_PREFIX,
    "__while_",
    super::notify_user::ACK_STATE_PREFIX,
];

/// Time travel: fork `run_id` from one of its history checkpoints (see
/// [`super::history`]) into a **new** run that resumes from that point, with an
/// optional patch applied to the checkpoint's state map.
///
/// The fork copies the checkpoint's *completed* nodes and their outputs, so
/// they are replayed rather than re-executed: their side effects are never
/// repeated. Every node that had not completed at the checkpoint runs again in
/// the fork as a **new** effect: the fork has its own run id, so its
/// idempotency keys (`<run_id>:<node_id>`, see [`idempotency_key`]), agent
/// conversations, and nested child run ids are all distinct from the parent's.
/// That is the same effectively-once contract a resumed run has, applied to a
/// deliberately new execution. The parent run is never modified.
///
/// The new run records its lineage in [`WorkflowRun::forked_from`] and its
/// history starts with a `forked` checkpoint. Nested child runs (driven by
/// their parent) cannot be forked directly; fork the top-level run instead.
pub async fn fork_run(
    run_id: &str,
    checkpoint_id: &str,
    state_patch: HashMap<String, String>,
) -> Result<WorkflowRun, String> {
    let parent = store::load_run(run_id).map_err(|_| "run not found".to_string())?;
    if parent.dry_run {
        return Err("dry runs have no history to fork".to_string());
    }
    if parent.state.contains_key(PARENT_RUN_KEY) {
        return Err(
            "run is a nested child run; fork the top-level run that owns it instead".to_string(),
        );
    }
    let checkpoint = super::history::find(run_id, checkpoint_id)
        .map_err(|e| format!("failed to read run history: {e}"))?
        .ok_or_else(|| format!("checkpoint '{checkpoint_id}' not found"))?;
    // Ad-hoc script runs are owned by the caller scope that started them (see
    // `super::script`); this generic surface cannot verify that scope, so it
    // must not re-execute their code under a new run.
    if parent
        .workflow_id
        .starts_with(store::SCRIPT_WORKFLOW_PREFIX)
    {
        return Err("script runs cannot be forked".to_string());
    }
    let workflow = store::load_workflow(&parent.workflow_id)
        .map_err(|_| format!("workflow '{}' not found", parent.workflow_id))?;
    let fork_id = format!("fork_{}", uuid::Uuid::new_v4().simple());
    let forked = build_fork(&parent, &checkpoint, &workflow, state_patch, fork_id)?;
    store::save_run(&forked).map_err(|e| format!("failed to persist fork: {e}"))?;
    super::history::record(&forked, CheckpointEvent::Forked, None, 0);
    run_workflow(&workflow, forked.input.clone(), forked.run_id.clone()).await
}

/// Build the seed checkpoint of a fork. Pure apart from the clock so the
/// carry-over rules are unit-testable.
fn build_fork(
    parent: &WorkflowRun,
    checkpoint: &super::history::RunCheckpoint,
    workflow: &Workflow,
    state_patch: HashMap<String, String>,
    fork_id: String,
) -> Result<WorkflowRun, String> {
    for key in state_patch.keys() {
        if key.trim().is_empty() {
            return Err("state_patch keys must not be empty".to_string());
        }
        if let Some(prefix) = ENGINE_STATE_PREFIXES
            .iter()
            .find(|prefix| key.starts_with(*prefix))
        {
            return Err(format!(
                "state_patch cannot write engine state keys beginning with '{prefix}'"
            ));
        }
    }
    let mut run = WorkflowRun::new(fork_id, parent.workflow_id.clone(), parent.input.clone());
    run.caller_scope = parent.caller_scope.clone();
    run.forked_from = Some(store::RunLineage {
        run_id: parent.run_id.clone(),
        checkpoint_id: checkpoint.checkpoint_id.clone(),
    });
    // Only completed nodes carry over; everything else (failed, skipped,
    // in-flight, or suspended at a gate) is recomputed by the fork.
    run.nodes = checkpoint
        .nodes
        .iter()
        .filter(|(_, state)| state.status == NodeStatus::Completed)
        .map(|(id, state)| (id.clone(), state.clone()))
        .collect();
    run.state = checkpoint.state.clone();
    // Parent/child links and in-flight fan-out/loop-token state belong to the
    // parent's executions; a fork starts its own.
    run.state.retain(|key, _| {
        !key.starts_with("__workflow_")
            && !key.starts_with(LOOP_STATE_PREFIX)
            && !key.starts_with(FANOUT_STATE_PREFIX)
    });
    // Loop progress of a node that will run again starts over.
    for node in &workflow.nodes {
        if run.is_completed(&node.id) {
            continue;
        }
        for field in ["count", "carry", "last", "outputs", "wake_at"] {
            run.state.remove(&repeat_state_key(field, &node.id));
        }
        run.state.remove(&format!("__while_{}", node.id));
        run.state.remove(&format!("__while_carry_{}", node.id));
        // A NotifyUser gate that runs again delivers fresh notifications; the
        // parent's ack bookkeeping (its members' acks and inbox rows) must not
        // satisfy or route the fork's gate.
        run.state
            .remove(&super::notify_user::ack_state_key(&node.id));
    }
    run.state.extend(state_patch);
    Ok(run)
}

fn run_workflow_inner(
    workflow: &Workflow,
    input: HashMap<String, String>,
    run_id: String,
    depth: usize,
    mode: ExecutionMode,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<WorkflowRun, String>> + Send + '_>> {
    Box::pin(async move {
        let lock = execution_lock(&run_id)?;
        let _guard = lock.lock_owned().await;
        if depth > MAX_SUBWORKFLOW_DEPTH {
            return Err(format!(
                "sub-workflow nesting exceeded max depth of {MAX_SUBWORKFLOW_DEPTH}"
            ));
        }

        // Nested SubWorkflow/While bodies do not pass through the public
        // `run_workflow` wrapper, so repeat the Core lifecycle preflight at this
        // execution boundary. This also catches agents added to a persisted
        // child workflow after the parent was saved.
        crate::workflow::ensure_agents_active(workflow).await?;

        let graph = WorkflowGraph::build(workflow).map_err(|e| e.to_string())?;

        // Resume from disk when a run with this id already exists, else fresh.
        let mut run = if mode.is_dry_run() {
            // A dry run is always a fresh in-memory projection. It must not
            // accidentally resume a durable run when a caller reuses an id.
            WorkflowRun::new(run_id.clone(), workflow.id.clone(), input.clone())
        } else {
            match store::load_run(&run_id) {
                Ok(existing) if existing.workflow_id == workflow.id => existing,
                _ => WorkflowRun::new(run_id.clone(), workflow.id.clone(), input.clone()),
            }
        };
        run.dry_run = mode.is_dry_run();
        let depth = if mode.is_dry_run() {
            depth
        } else {
            depth.max(persisted_nesting_depth(&run)?)
        };
        // Resuming a suspended run: clear awaiting state and re-run from the
        // last checkpoint. Any Awakeable node already flipped to Completed (by
        // the resume endpoint) will be skipped like any other finished node.
        run.awaiting_node = None;
        run.status = RunStatus::Running;
        // Woken from a limit wait (or resumed early by hand): the wait is over.
        run.resume_at = None;
        run.wait_reason = None;
        if !mode.is_dry_run() && super::history::is_empty(&run.run_id) {
            super::history::record(&run, CheckpointEvent::RunStarted, None, 0);
        }

        let mut traversal = Traversal::new(&graph, workflow, &run);
        let limit = effective_node_concurrency(workflow.max_concurrency);
        let shared = Arc::new(Mutex::new(run));
        let mut in_flight: FuturesUnordered<BranchFuture<'_>> = FuturesUnordered::new();
        let mut halt = Halt::default();

        loop {
            // Dispatch every ready node, up to the concurrency limit. Nodes that
            // need no execution (pruned, already completed on resume, skipped by
            // a dry run) settle inline and may make more nodes ready.
            while halt.is_clear() && in_flight.len() < limit {
                let Some(idx) = traversal.queue.pop_front() else {
                    break;
                };
                if traversal.pruned.contains(&idx) {
                    // A skipped node still resolves its outgoing edges so a
                    // downstream join (branches that reconverge on one node)
                    // keeps making progress instead of stalling forever.
                    let mut run = lock_run(&shared)?;
                    traversal.resolve_successors(idx, true, &mut run, mode)?;
                    continue;
                }
                let node = &graph.graph[idx];
                let (node_input, replayed) = {
                    let run = lock_run(&shared)?;
                    let replayed = run.is_completed(&node.id).then(|| {
                        run.nodes
                            .get(&node.id)
                            .and_then(|s| s.output.clone())
                            .unwrap_or_default()
                    });
                    (traversal.input_for(idx, &run), replayed)
                };
                // Skip already-completed nodes on resume: replay their output.
                if let Some(produced) = replayed {
                    let mut run = lock_run(&shared)?;
                    traversal.complete(idx, produced, &mut run, mode)?;
                    continue;
                }
                // Dry runs execute only pure nodes and tools that Core can
                // classify as read-only. Effectful nodes are recorded as
                // skipped and their outgoing paths are treated like a normal
                // skipped branch, so no external call can happen accidentally.
                if mode.is_dry_run() {
                    if let Some(reason) = dry_run_skip_reason(node).await {
                        let mut run = lock_run(&shared)?;
                        mark(&mut run, &node.id, NodeStatus::Skipped, None, Some(reason));
                        checkpoint_run(&run, mode)?;
                        traversal.resolve_successors(idx, true, &mut run, mode)?;
                        continue;
                    }
                }
                let base = lock_run(&shared)?.clone();
                in_flight.push(drive_branch(
                    node,
                    idx,
                    node_input,
                    base,
                    Arc::clone(&shared),
                    depth,
                    mode,
                ));
            }

            let Some(done) = in_flight.next().await else {
                break;
            };
            let BranchDone {
                idx,
                scope,
                local,
                outcome,
            } = done;
            let node = &graph.graph[idx];
            let mut run = lock_run(&shared)?;
            scope.merge_into(&mut run, &local)?;
            match outcome {
                Err(fatal) => {
                    halt.fatal.get_or_insert(fatal);
                }
                Ok(NodeOutcome::Produced(produced)) => {
                    traversal.complete(idx, produced, &mut run, mode)?;
                    super::history::record(
                        &run,
                        CheckpointEvent::NodeCompleted,
                        Some(&node.id),
                        node_iteration(&run, node),
                    );
                }
                Ok(NodeOutcome::Failed(error)) => {
                    checkpoint_run(&run, mode)?;
                    super::history::record(
                        &run,
                        CheckpointEvent::NodeFailed,
                        Some(&node.id),
                        node_iteration(&run, node),
                    );
                    halt.failed.get_or_insert(error);
                }
                Ok(NodeOutcome::Parked(error)) => {
                    halt.parked.get_or_insert((node.id.clone(), error));
                }
                // Only one gate is routed per suspension: the first. A second
                // suspended branch re-enters (and re-suspends at) its own gate
                // on the next resume, since its node is still unfinished.
                Ok(NodeOutcome::Suspended) => {
                    if halt.suspended.is_none() {
                        halt.suspended = Some((
                            node.id.clone(),
                            local.state.get(AWAITING_CHILD_KEY).cloned(),
                        ));
                    }
                }
            }
        }

        let mut run = lock_run(&shared)?.clone();
        drop(shared);

        // Settle a halted run once every in-flight branch has finished, so no
        // branch's completed work is lost: a hard checkpoint error first, then a
        // failed node, then a provider limit, then a human gate.
        if let Some(fatal) = halt.fatal {
            return Err(fatal);
        }
        if let Some(error) = halt.failed {
            run.status = RunStatus::Failed;
            run.error = Some(error.clone());
            run.updated_at = chrono::Utc::now().to_rfc3339();
            checkpoint_run(&run, mode)?;
            super::history::record(&run, CheckpointEvent::RunFailed, None, 0);
            return Err(error);
        }
        if let Some((node_id, error)) = halt.parked {
            // A rate, usage, or session limit is not this node failing: park
            // the run until the limit resets. A nested run parks too and its
            // parent turns that into a limit error of its own, so the whole
            // chain parks; only the top-level run schedules the wake-up, and
            // resuming it re-enters each child under its run id.
            park_on_limit(&mut run, &node_id, &error);
            checkpoint_run(&run, mode)?;
            super::history::record(&run, CheckpointEvent::NodeParked, Some(&node_id), 0);
            if depth == 0 {
                super::auto_resume::schedule_wake(&run);
            }
            return Ok(run);
        }
        if let Some((node_id, child)) = halt.suspended {
            // Route the resume to the suspended gate's child run (if the gate is
            // nested). Re-assert the link here: a sibling branch that finished
            // after the gate suspended may have merged its own link removal.
            match child {
                Some(child) => {
                    run.state.insert(AWAITING_CHILD_KEY.to_string(), child);
                }
                None => {
                    run.state.remove(AWAITING_CHILD_KEY);
                }
            }
            // The gate node stays `Running` so the resume endpoint can identify
            // it and the executor re-enters it once it is flipped Completed.
            run.status = RunStatus::AwaitingInput;
            run.awaiting_node = Some(node_id.clone());
            run.updated_at = chrono::Utc::now().to_rfc3339();
            checkpoint_run(&run, mode)?;
            super::history::record(&run, CheckpointEvent::NodeSuspended, Some(&node_id), 0);
            // Surface an `Awakeable` HITL gate in the approval inbox so the user
            // can approve (resume) or reject (fail) it from one place.
            // Best-effort + deduped on the run id. A `NotifyUser` gate is
            // skipped here: it already delivered its own per-member inbox items
            // (with an Ack action) inside the node arm, so a generic approval
            // row would be a duplicate.
            let gate = graph
                .index_by_id
                .get(&node_id)
                .map(|&idx| &graph.graph[idx].kind);
            if let Some(NodeKind::Awakeable { prompt }) = gate {
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

        // Collect Output node values into the run output map.
        for node in &workflow.nodes {
            if let NodeKind::Output { key } = &node.kind {
                if let Some(&idx) = graph.index_by_id.get(&node.id) {
                    if let Some(v) = traversal.values.get(&idx) {
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
        checkpoint_run(&run, mode)?;
        super::history::record(&run, CheckpointEvent::RunCompleted, None, 0);
        Ok(run)
    })
}

/// Why the coordinator stopped dispatching new nodes. Every reason is recorded
/// as it happens, but the run is only settled once in-flight branches finish.
#[derive(Default)]
struct Halt {
    /// A checkpoint could not be written: the run cannot continue safely.
    fatal: Option<String>,
    /// The first node failure.
    failed: Option<String>,
    /// The first node parked on a provider limit, with its limit error.
    parked: Option<(String, String)>,
    /// The first node suspended at a gate, with its child-run link (if any).
    suspended: Option<(String, Option<String>)>,
}

impl Halt {
    fn is_clear(&self) -> bool {
        self.fatal.is_none()
            && self.failed.is_none()
            && self.parked.is_none()
            && self.suspended.is_none()
    }
}

/// How one dispatched node finished.
enum NodeOutcome {
    /// The node produced a value (already marked `Completed` in its branch).
    Produced(String),
    /// The node failed (already marked `Failed` in its branch).
    Failed(String),
    /// The node suspended the run at a human gate (it stays `Running`).
    Suspended,
    /// The node hit a provider limit; the run parks with this error.
    Parked(String),
}

/// A finished branch: the node, its private run copy, and the outcome.
struct BranchDone {
    idx: NodeIndex,
    scope: Arc<BranchScope>,
    local: WorkflowRun,
    /// `Err` is a fatal checkpoint failure, not a node error.
    outcome: Result<NodeOutcome, String>,
}

type BranchFuture<'a> =
    std::pin::Pin<Box<dyn std::future::Future<Output = BranchDone> + Send + 'a>>;

/// The run copy one in-flight node executes against, plus the canonical run it
/// is merged back into. Nodes take `&mut WorkflowRun`, so concurrent branches
/// each get a private copy taken when they are dispatched; every checkpoint the
/// branch writes merges only *its own changes* (relative to `base`) into the
/// shared canonical run before that run is saved. Two branches can therefore
/// checkpoint in any interleaving without one overwriting the other's progress.
struct BranchScope {
    run_id: String,
    /// The branch copy as of its last merge (initially the dispatch snapshot).
    /// Each merge applies only what changed since then, so a key the branch
    /// wrote in one checkpoint and removed before the next is removed from the
    /// canonical run too.
    base: Mutex<WorkflowRun>,
    shared: Arc<Mutex<WorkflowRun>>,
}

tokio::task_local! {
    /// The branch whose checkpoints are being routed through a merge. Set while
    /// one dispatched node runs; nested child runs have different run ids and
    /// therefore save directly (or through their own scope).
    static BRANCH_SCOPE: Arc<BranchScope>;
}

impl BranchScope {
    /// Fold the branch's changes since its last merge into the canonical run.
    /// Idempotent: merging the same branch copy twice is a no-op.
    fn merge_into(&self, shared: &mut WorkflowRun, local: &WorkflowRun) -> Result<(), String> {
        let mut base = self
            .base
            .lock()
            .map_err(|_| "workflow branch state lock poisoned".to_string())?;
        merge_run_delta(shared, &base, local);
        base.clone_from(local);
        Ok(())
    }

    /// Merge `local` into the canonical run and save it, under the canonical
    /// run's lock so saves from concurrent branches are totally ordered.
    fn checkpoint(&self, local: &WorkflowRun) -> Result<(), String> {
        let mut shared = lock_run(&self.shared)?;
        self.merge_into(&mut shared, local)?;
        store::save_run(&shared).map_err(|e| format!("failed to persist checkpoint: {e}"))
    }
}

/// Apply the node/state/output changes `local` made since `base` onto `shared`.
fn merge_run_delta(shared: &mut WorkflowRun, base: &WorkflowRun, local: &WorkflowRun) {
    for (id, state) in &local.nodes {
        if base.nodes.get(id) != Some(state) {
            shared.nodes.insert(id.clone(), state.clone());
        }
    }
    merge_string_map(&mut shared.state, &base.state, &local.state);
    merge_string_map(&mut shared.output, &base.output, &local.output);
    shared.updated_at = chrono::Utc::now().to_rfc3339();
}

fn merge_string_map(
    shared: &mut HashMap<String, String>,
    base: &HashMap<String, String>,
    local: &HashMap<String, String>,
) {
    for (key, value) in local {
        if base.get(key) != Some(value) {
            shared.insert(key.clone(), value.clone());
        }
    }
    for key in base.keys() {
        if !local.contains_key(key) {
            shared.remove(key);
        }
    }
}

fn lock_run(shared: &Mutex<WorkflowRun>) -> Result<std::sync::MutexGuard<'_, WorkflowRun>, String> {
    shared
        .lock()
        .map_err(|_| "workflow run state lock poisoned".to_string())
}

/// Default number of independent nodes of one run that execute at once.
pub const DEFAULT_NODE_CONCURRENCY: u32 = 4;
/// Hard ceiling on a workflow's `max_concurrency`.
pub const MAX_NODE_CONCURRENCY: u32 = 16;

/// Resolve a workflow's node concurrency: its setting clamped to
/// `1..=MAX_NODE_CONCURRENCY`, defaulting to [`DEFAULT_NODE_CONCURRENCY`].
pub fn effective_node_concurrency(max_concurrency: Option<u32>) -> usize {
    max_concurrency
        .unwrap_or(DEFAULT_NODE_CONCURRENCY)
        .clamp(1, MAX_NODE_CONCURRENCY) as usize
}

/// How many times `node` has run in this run, for history records: its
/// `repeat` iteration count, its `while` loop count, or 1.
fn node_iteration(run: &WorkflowRun, node: &super::WorkflowNode) -> u64 {
    let parsed = |key: String| run.state.get(&key).and_then(|v| v.parse::<u64>().ok());
    parsed(repeat_state_key("count", &node.id))
        .or_else(|| match &node.kind {
            NodeKind::While { .. } => parsed(format!("__while_{}", node.id)),
            _ => None,
        })
        .filter(|count| *count > 0)
        .unwrap_or(1)
}

/// Run one node on its private run copy, routing its checkpoints through the
/// branch merge so concurrent branches never clobber each other.
fn drive_branch<'a>(
    node: &'a super::WorkflowNode,
    idx: NodeIndex,
    input: String,
    base: WorkflowRun,
    shared: Arc<Mutex<WorkflowRun>>,
    depth: usize,
    mode: ExecutionMode,
) -> BranchFuture<'a> {
    Box::pin(async move {
        let scope = Arc::new(BranchScope {
            run_id: base.run_id.clone(),
            base: Mutex::new(base.clone()),
            shared,
        });
        let mut local = base;
        let outcome = BRANCH_SCOPE
            .scope(
                Arc::clone(&scope),
                drive_node(node, &input, &mut local, depth, mode),
            )
            .await;
        BranchDone {
            idx,
            scope,
            local,
            outcome,
        }
    })
}

/// Execute one node to a settled outcome: the Temporal-style retry loop with an
/// optional per-attempt timeout, wrapped by an optional `repeat` loop. Mutates
/// only node-scoped state on `run` (its own node entry and state keys); the
/// coordinator owns run-level status transitions.
async fn drive_node(
    node: &super::WorkflowNode,
    node_input: &str,
    run: &mut WorkflowRun,
    depth: usize,
    mode: ExecutionMode,
) -> Result<NodeOutcome, String> {
    mark(run, &node.id, NodeStatus::Running, None, None);
    checkpoint_run(run, mode)?;

    // A node with no `retry` policy runs once (`max_attempts` defaults to 1); a
    // timeout is surfaced as a retryable error so it composes with the policy.
    // An `Awakeable` suspend is never retried.
    let policy = node.retry.clone().unwrap_or_default();
    let max_attempts = policy.max_attempts.max(1);
    // A `repeat` policy wraps the retry loop: each iteration is one full
    // (retried) execution of the node on the carried value.
    let mut repeat = node
        .repeat
        .as_ref()
        .map(|p| RepeatProgress::load(p, &node.id, node_input, run));

    let outcome = loop {
        let iteration_input = match &repeat {
            Some(progress) => {
                progress.wait_for_interval(run).await;
                progress.expose(run);
                progress.carry.clone()
            }
            None => node_input.to_string(),
        };
        let attempt_outcome = loop {
            // Count this attempt before running it, so a crash mid-call still
            // spends budget. `attempts` persists across restart.
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
            checkpoint_run(run, mode)?;

            match run_node_attempt(node, &iteration_input, run, depth, mode).await {
                Ok(out) => break Ok(out),
                // Awakeable gate: suspend, never retry.
                Err(e) if e == SUSPEND_SENTINEL => return Ok(NodeOutcome::Suspended),
                // A rate, usage, or session limit is not this node failing.
                Err(e)
                    if !mode.is_dry_run()
                        && run.limit_waits < super::auto_resume::MAX_LIMIT_WAITS
                        && super::limits::is_limit_error(&e) =>
                {
                    return Ok(NodeOutcome::Parked(e));
                }
                Err(e) => match decide_retry(&policy, attempt, max_attempts, &e) {
                    RetryDecision::Fail => break Err(e),
                    RetryDecision::Retry(sleep_ms) => {
                        checkpoint_run(run, mode)?;
                        tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
                    }
                },
            }
        };
        let out = match attempt_outcome {
            Ok(out) => out,
            Err(e) => break Err(e),
        };
        let Some(progress) = repeat.as_mut() else {
            break Ok(out);
        };
        if !progress.advance(out, run) {
            break Ok(repeat.take().map(|p| p.finish(run)).unwrap_or_default());
        }
        // Stamp the pause before the next pass as a durable timer, then
        // checkpoint the finished iteration with it so a restart resumes the
        // loop at the next pass after the remaining wait.
        if !mode.is_dry_run() {
            progress.schedule_next(run);
        }
        checkpoint_run(run, mode)?;
    };

    match outcome {
        Ok(out) => {
            mark(
                run,
                &node.id,
                NodeStatus::Completed,
                Some(out.clone()),
                None,
            );
            Ok(NodeOutcome::Produced(out))
        }
        Err(e) => {
            mark(run, &node.id, NodeStatus::Failed, None, Some(e.clone()));
            Ok(NodeOutcome::Failed(e))
        }
    }
}

/// Kahn-style traversal state honouring active edges only. Owned by the
/// coordinator; nodes run concurrently but the graph bookkeeping is serial.
struct Traversal<'g> {
    graph: &'g WorkflowGraph,
    /// Per-node produced value, seeded with any completed-node outputs from a
    /// resumed run so downstream nodes can read upstream results.
    values: HashMap<NodeIndex, String>,
    /// Edges considered "active". A condition prunes the non-taken branch.
    active_edges: HashSet<petgraph::graph::EdgeIndex>,
    pruned: HashSet<NodeIndex>,
    indegree: HashMap<NodeIndex, usize>,
    /// Ready nodes, in deterministic dispatch order.
    queue: VecDeque<NodeIndex>,
}

impl<'g> Traversal<'g> {
    fn new(graph: &'g WorkflowGraph, workflow: &Workflow, run: &WorkflowRun) -> Self {
        let mut values = HashMap::new();
        for node in &workflow.nodes {
            if let Some(state) = run.nodes.get(&node.id) {
                if state.status == NodeStatus::Completed {
                    if let (Some(out), Some(&idx)) =
                        (&state.output, graph.index_by_id.get(&node.id))
                    {
                        values.insert(idx, out.clone());
                    }
                }
            }
        }
        let indegree = graph
            .graph
            .node_indices()
            .map(|idx| {
                (
                    idx,
                    graph.graph.edges_directed(idx, Direction::Incoming).count(),
                )
            })
            .collect();
        Self {
            graph,
            values,
            active_edges: graph.graph.edge_indices().collect(),
            pruned: HashSet::new(),
            indegree,
            queue: graph.roots().into_iter().collect(),
        }
    }

    /// A node's input: its active incoming values joined with `\n` (fan-in), or
    /// the run input for a root node.
    fn input_for(&self, idx: NodeIndex, run: &WorkflowRun) -> String {
        let incoming: Vec<&str> = self
            .graph
            .graph
            .edges_directed(idx, Direction::Incoming)
            .filter(|e| self.active_edges.contains(&e.id()))
            .filter_map(|e| self.values.get(&e.source()).map(String::as_str))
            .collect();
        if incoming.is_empty() {
            input_for_root(&self.graph.graph[idx], run)
        } else {
            incoming.join("\n")
        }
    }

    /// Record a node's value, prune the branch a brancher did not take,
    /// checkpoint, and make its successors ready.
    fn complete(
        &mut self,
        idx: NodeIndex,
        produced: String,
        run: &mut WorkflowRun,
        mode: ExecutionMode,
    ) -> Result<(), String> {
        let node = &self.graph.graph[idx];
        // Condition nodes (and a body-less one-shot While gate) produce
        // "true"/"false" and prune the non-taken branch. A *looped* While
        // (`body_workflow_id` set) produces the loop's carry value, not a branch
        // label, so it must NOT prune — it is a plain data node with a single
        // unlabelled forward edge.
        let is_brancher = matches!(node.kind, NodeKind::Condition { .. })
            || matches!(
                node.kind,
                NodeKind::While {
                    body_workflow_id: None,
                    ..
                }
            );
        if is_brancher {
            let label = if produced == "true" { "true" } else { "false" };
            for edge in self.graph.graph.edges_directed(idx, Direction::Outgoing) {
                let matches = edge.weight().branch.as_deref().is_none_or(|b| b == label);
                if !matches {
                    self.active_edges.remove(&edge.id());
                }
            }
        }
        self.values.insert(idx, produced);
        checkpoint_run(run, mode)?;
        self.resolve_successors(idx, false, run, mode)
    }

    /// Resolve a finalized node's outgoing edges.
    ///
    /// Called once per node after it Completes (`was_skipped == false`) and
    /// once per Skipped node (`was_skipped == true`). A skipped node produces no
    /// value, so its outgoing edges are deactivated. A successor becomes ready
    /// only once **every** incoming edge has resolved (joins wait for all their
    /// inputs, whichever order concurrent branches finish in). A ready successor
    /// with at least one still-active incoming edge runs (and reads only its
    /// active inputs); one whose incoming edges were all pruned is itself
    /// skipped and enqueued so the skip propagates through any further joins.
    /// This is what lets a `Condition` whose branches reconverge on a single
    /// downstream node work.
    fn resolve_successors(
        &mut self,
        idx: NodeIndex,
        was_skipped: bool,
        run: &mut WorkflowRun,
        mode: ExecutionMode,
    ) -> Result<(), String> {
        let out_edges: Vec<(petgraph::graph::EdgeIndex, NodeIndex)> = self
            .graph
            .graph
            .edges_directed(idx, Direction::Outgoing)
            .map(|e| (e.id(), e.target()))
            .collect();
        for (eid, target) in out_edges {
            if was_skipped {
                // A skipped source carries no value into the join.
                self.active_edges.remove(&eid);
            }
            let entry = self.indegree.entry(target).or_insert(0);
            if *entry > 0 {
                *entry -= 1;
            }
            if *entry != 0 || self.pruned.contains(&target) {
                continue;
            }
            let has_active_incoming = self
                .graph
                .graph
                .edges_directed(target, Direction::Incoming)
                .any(|e| self.active_edges.contains(&e.id()));
            // A still-pending node reachable by no active path is skipped (and
            // the skip propagates from its own edges). A completed node — a
            // prior run's checkpoint on resume — is never re-marked; it is
            // enqueued so the loop replays its stored output down the graph.
            let target_id = &self.graph.graph[target].id;
            if !has_active_incoming && !run.is_completed(target_id) {
                self.pruned.insert(target);
                mark(run, target_id, NodeStatus::Skipped, None, None);
                checkpoint_run(run, mode)?;
            }
            self.queue.push_back(target);
        }
        Ok(())
    }
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

/// Return a skip reason for a node that is not safe to execute during a dry
/// run. `None` means the node is pure, transient-only, nested execution, or a
/// registered MCP tool that Core can classify as read-only.
async fn dry_run_skip_reason(node: &super::WorkflowNode) -> Option<String> {
    match &node.kind {
        NodeKind::Input { .. }
        | NodeKind::Output { .. }
        | NodeKind::Transform { .. }
        | NodeKind::Condition { .. }
        | NodeKind::SetState { .. }
        | NodeKind::Delay { .. }
        | NodeKind::Note { .. }
        | NodeKind::While { .. }
        | NodeKind::SubWorkflow { .. }
        | NodeKind::ForEach { .. }
        | NodeKind::Parallel { .. } => None,
        NodeKind::Tool { name, .. } => dry_run_tool_skip_reason(name).await,
        NodeKind::Mcp { server, tool, .. } => {
            dry_run_tool_skip_reason(&format!("{server}.{tool}")).await
        }
        NodeKind::Prompt { .. } => {
            Some("dry run skipped: prompt nodes call a model and are not read-only".to_string())
        }
        NodeKind::Agent { .. } => {
            Some("dry run skipped: agent nodes may invoke tools or mutate state".to_string())
        }
        NodeKind::Skill { .. } => {
            Some("dry run skipped: skill nodes call an agent and are not read-only".to_string())
        }
        NodeKind::AgentDelegate { .. } => Some(
            "dry run skipped: agent delegation may invoke models or tools and is not read-only"
                .to_string(),
        ),
        NodeKind::Script { .. } => {
            Some("dry run skipped: script nodes run agents and are not read-only".to_string())
        }
        NodeKind::Plugin { .. } => Some(
            "dry run skipped: plugin runnables do not expose a read-only execution contract"
                .to_string(),
        ),
        NodeKind::Guardrails { .. } => Some(
            "dry run skipped: guardrails use an external Gateway check and are not read-only"
                .to_string(),
        ),
        NodeKind::Webhook { .. } => {
            Some("dry run skipped: webhook delivery would write to an external service".to_string())
        }
        NodeKind::Recipe { .. } => Some(
            "dry run skipped: recipe replay can change the desktop or external applications"
                .to_string(),
        ),
        NodeKind::GhostAction { .. } => Some(
            "dry run skipped: ghost actions can change the desktop or external applications"
                .to_string(),
        ),
        NodeKind::NotifyUser { .. } => Some(
            "dry run skipped: notifications would deliver messages to organization members"
                .to_string(),
        ),
        NodeKind::ChannelSend { .. } => {
            Some("dry run skipped: channel sends would deliver a message externally".to_string())
        }
        NodeKind::Code { .. } => Some(
            "dry run skipped: code steps execute a program or call a model and are not read-only"
                .to_string(),
        ),
        NodeKind::Awakeable { .. } => Some(
            "dry run skipped: human-in-the-loop gates cannot be resumed from a transient run"
                .to_string(),
        ),
    }
}

/// Classify an MCP tool before a dry run dispatches it. Missing registry
/// metadata is fail-closed: a dry run never guesses that an unavailable or
/// unknown tool is safe to invoke.
async fn dry_run_tool_skip_reason(name: &str) -> Option<String> {
    let Some(registry) = crate::sidecar::mcp::global_registry() else {
        return Some(format!(
            "dry run skipped: cannot verify that tool '{name}' is read-only because the MCP registry is unavailable"
        ));
    };

    let (annotations, http_method) = registry.tool_effect_metadata(name).await;
    let effect = crate::agent_execution::classify_tool_with_metadata(
        name,
        annotations.as_ref(),
        http_method.as_deref(),
    );
    if effect.is_read_only() {
        None
    } else {
        Some(format!(
            "dry run skipped: tool '{name}' is not read-only (effect: {})",
            effect.label()
        ))
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

/// Allocate dispatch work in a separate constructor frame before polling it.
/// Factories keep large future temporaries off each nested executor's stack.
fn boxed_node_work<'a, F, Fut, T>(
    make: F,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T> + Send + 'a,
{
    Box::pin(make())
}

/// Allocate the node dispatcher before entering its polling frame.
fn boxed_node_execution<'a>(
    node: &'a super::WorkflowNode,
    input: &'a str,
    run: &'a mut WorkflowRun,
    depth: usize,
    mode: ExecutionMode,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>> {
    // Construct the large dispatch future in a separate frame that returns
    // before polling it. Heap ownership alone inside the async attempt would
    // still reserve a large temporary on every nested attempt's polling stack.
    Box::pin(execute_node(node, input, run, depth, mode))
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
    mode: ExecutionMode,
) -> Result<String, String> {
    let execution = boxed_node_execution(node, input, run, depth, mode);
    match node.timeout_ms {
        Some(ms) if ms > 0 => {
            match tokio::time::timeout(std::time::Duration::from_millis(ms), execution).await {
                Ok(r) => r,
                Err(_) => Err(format!("node '{}' timed out after {ms}ms", node.id)),
            }
        }
        _ => execution.await,
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
    mode: ExecutionMode,
) -> Result<String, String> {
    use super::template::resolve;

    let ctx = build_template_ctx(input, run);
    // Effects key on this so every `repeat` iteration is distinct (see
    // [`iteration_scoped_id`]); it is the plain node id otherwise.
    let exec_id = iteration_scoped_id(run, &node.id);

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
            for reserved in [
                "__workflow_",
                REPEAT_STATE_PREFIX,
                LOOP_STATE_PREFIX,
                FANOUT_STATE_PREFIX,
            ] {
                if key.starts_with(reserved) {
                    return Err(format!(
                        "state keys beginning with '{reserved}' are reserved"
                    ));
                }
            }
            let resolved = resolve(value, &ctx);
            run.state.insert(key.clone(), resolved);
            // Pass the incoming value through unchanged to outgoing edges.
            Ok(input.to_string())
        }
        NodeKind::Delay { .. } if mode.is_dry_run() => {
            // A dry run reports the path without waiting or stamping a durable
            // timer. Both are execution effects, not read-only evaluation.
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
                checkpoint_run(run, mode)?;
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
                    boxed_node_work(|| {
                        run_while_loop(expr, body_id, cap, &node.id, input, run, depth, mode)
                    })
                    .await
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
        NodeKind::Guardrails { checks } => boxed_node_work(|| run_guardrails(checks, input)).await,
        NodeKind::Prompt { prompt, agent_id } => {
            let rendered = resolve(prompt, &ctx);
            boxed_node_work(|| run_prompt(&rendered, agent_id.as_deref(), &run.run_id, &exec_id))
                .await
        }
        NodeKind::Webhook { url, method } => {
            let resolved_url = resolve(url, &ctx);
            let idem_key = idempotency_key(&run.run_id, &exec_id);
            boxed_node_work(|| run_webhook(&resolved_url, method, input, &idem_key)).await
        }
        NodeKind::Tool { name, args } => {
            let resolved_args = resolve_json_strings(args, &ctx);
            let idem_key = idempotency_key(&run.run_id, &exec_id);
            boxed_node_work(|| run_tool(name, &resolved_args, input, &idem_key)).await
        }
        NodeKind::Mcp { server, tool, args } => {
            // The explicit two-field form of a Tool node: join `<server>.<tool>`
            // into the id the MCP registry expects, then reuse the Tool path so
            // idempotency-key + `input` folding behave identically.
            let resolved_args = resolve_json_strings(args, &ctx);
            let idem_key = idempotency_key(&run.run_id, &exec_id);
            let tool_id = format!("{server}.{tool}");
            boxed_node_work(|| run_tool(&tool_id, &resolved_args, input, &idem_key)).await
        }
        NodeKind::Recipe { recipe, params } => {
            let resolved_params = resolve_json_strings(params, &ctx);
            boxed_node_work(|| run_recipe(recipe, &resolved_params)).await
        }
        NodeKind::GhostAction {
            action,
            target,
            params,
        } => {
            let resolved_target = resolve_json_strings(target, &ctx);
            let resolved_params = resolve_json_strings(params, &ctx);
            boxed_node_work(|| run_ghost_action(action, &resolved_target, &resolved_params)).await
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
            let sub_run_id = format!("{}-sub-{}", run.run_id, exec_id);
            let result = boxed_node_work(|| {
                run_child_workflow(&sub, sub_input, sub_run_id, &node.id, run, depth, mode)
            })
            .await?;
            // Forward the first output value (or empty).
            Ok(result.output.values().next().cloned().unwrap_or_default())
        }
        NodeKind::ForEach {
            body_workflow_id,
            items,
            max_concurrency,
        } => {
            boxed_node_work(|| {
                run_for_each(
                    body_workflow_id,
                    items.as_deref(),
                    *max_concurrency,
                    &node.id,
                    &exec_id,
                    input,
                    run,
                    depth,
                    mode,
                )
            })
            .await
        }
        NodeKind::Parallel {
            branches,
            max_concurrency,
        } => {
            boxed_node_work(|| {
                run_parallel(
                    branches,
                    *max_concurrency,
                    &node.id,
                    &exec_id,
                    input,
                    run,
                    depth,
                    mode,
                )
            })
            .await
        }
        NodeKind::Script {
            code,
            agent_id,
            preset,
            allow_mutation,
        } => {
            // Authored workflows predate the field and may write; an ad-hoc
            // script workflow saved without it is held to read-only presets.
            // An ad-hoc script with no locked agent never writes either, or its
            // `agent()` calls could pick any registered agent's tool loop.
            let ad_hoc = run
                .workflow_id
                .starts_with(super::store::SCRIPT_WORKFLOW_PREFIX);
            let locked_agent = agent_id.clone().filter(|id| !id.trim().is_empty());
            let script_ctx = super::script::ScriptContext {
                run_id: run.run_id.clone(),
                node_id: node.id.clone(),
                depth,
                allow_mutation: allow_mutation.unwrap_or(!ad_hoc)
                    && !(ad_hoc && locked_agent.is_none()),
                agent_id: locked_agent,
                default_preset: preset.unwrap_or(delegation::PermissionPreset::Research),
            };
            boxed_node_work(|| super::script::run_script(code, input, script_ctx)).await
        }
        NodeKind::AgentDelegate { delegates, caps } => {
            let resolved: Vec<delegation::DelegateSpec> = delegates
                .iter()
                .map(|delegate| {
                    let mut resolved = delegate.clone();
                    resolved.task = resolve(&delegate.task, &ctx);
                    resolved
                })
                .collect();
            boxed_node_work(|| {
                run_agent_delegate(&resolved, caps.clone(), input, depth, &run.run_id, &exec_id)
            })
            .await
        }
        NodeKind::Agent { agent_id, task } => {
            // A dedicated "run agent X on this task" step. `run_prompt` already
            // routes a set agent id through the agent runner (and falls back to
            // the gateway LLM in headless/test contexts), so reuse it: the task
            // template is the agent's instruction.
            let task_tmpl = task.as_deref().unwrap_or("{{input}}");
            let rendered = resolve(task_tmpl, &ctx);
            boxed_node_work(|| run_prompt(&rendered, Some(agent_id), &run.run_id, &exec_id)).await
        }
        NodeKind::Skill {
            skill,
            agent_id,
            task,
        } => {
            let task_tmpl = task.as_deref().unwrap_or("{{input}}");
            let rendered = resolve(task_tmpl, &ctx);
            boxed_node_work(|| {
                run_skill(skill, agent_id.as_deref(), &rendered, &run.run_id, &exec_id)
            })
            .await
        }
        NodeKind::Plugin {
            plugin_id,
            runnable_id,
            args,
        } => {
            let resolved_args = resolve_json_strings(args, &ctx);
            let idem_key = idempotency_key(&run.run_id, &exec_id);
            boxed_node_work(|| {
                run_plugin(
                    plugin_id,
                    runnable_id,
                    &resolved_args,
                    input,
                    &idem_key,
                    run,
                    &node.id,
                    &exec_id,
                    depth,
                    mode,
                )
            })
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
            boxed_node_work(|| {
                super::notify_user::run(
                    target,
                    &rendered_title,
                    &rendered_body,
                    ack_mode,
                    &node.id,
                    run,
                )
            })
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
            boxed_node_work(|| {
                super::channel_send::run(
                    *platform,
                    &rendered_recipient,
                    &rendered_text,
                    bot_token.as_deref(),
                    webhook_url.as_deref(),
                )
            })
            .await
        }
        NodeKind::Code {
            language,
            mode,
            source,
            input: input_template,
            function,
            args,
            model,
        } => {
            // The source stays literal; only the data handed to the program is
            // template-resolved, so a step input can never rewrite the program.
            let program_input = input_template
                .as_deref()
                .map_or_else(|| input.to_string(), |template| resolve(template, &ctx));
            let resolved_args = resolve_json_strings(args, &ctx);
            let timeout = node.timeout_ms.map_or(
                ryu_code_runner::DEFAULT_TIMEOUT,
                std::time::Duration::from_millis,
            );
            boxed_node_work(|| {
                run_code_step(
                    *language,
                    *mode,
                    source,
                    &program_input,
                    function.as_deref(),
                    &resolved_args,
                    model.as_deref(),
                    timeout,
                )
            })
            .await
        }
        // Signal the outer loop to suspend by returning the sentinel. The outer
        // loop recognises this exact value and transitions the run to
        // `AwaitingInput` without marking the node Failed.
        NodeKind::Awakeable { .. } => Err(SUSPEND_SENTINEL.to_string()),
    }
}

/// Execute or reuse a deterministic child checkpoint. Parent/child links are
/// written before the child can create an approval. Awaiting children suspend
/// their enclosing node; failed children fail it; only completed output advances
/// the parent's loop carry or SubWorkflow result.
#[allow(clippy::too_many_arguments)]
async fn run_child_workflow(
    workflow: &Workflow,
    input: HashMap<String, String>,
    child_id: String,
    node_id: &str,
    parent: &mut WorkflowRun,
    depth: usize,
    mode: ExecutionMode,
) -> Result<WorkflowRun, String> {
    if depth >= MAX_SUBWORKFLOW_DEPTH {
        return Err(format!(
            "sub-workflow nesting exceeded max depth of {MAX_SUBWORKFLOW_DEPTH}"
        ));
    }
    let child_lock = execution_lock(&child_id)?;
    let child_guard = child_lock.lock_owned().await;
    let parent_awaits_child = parent.state.get(AWAITING_CHILD_KEY) == Some(&child_id);
    let child = prepare_child(
        workflow,
        &input,
        &child_id,
        &parent.run_id,
        parent_awaits_child,
        mode,
    )
    .await?;
    parent
        .state
        .insert(AWAITING_CHILD_KEY.to_string(), child_id.clone());
    checkpoint_run(parent, mode)?;
    drop(child_guard);
    let result = drive_child(workflow, input, child, depth, mode).await?;
    match result.status {
        RunStatus::AwaitingInput => {
            parent.awaiting_node = Some(node_id.to_string());
            Err(SUSPEND_SENTINEL.to_string())
        }
        RunStatus::Completed => {
            parent.state.remove(AWAITING_CHILD_KEY);
            Ok(result)
        }
        RunStatus::Failed => Err(format!(
            "child workflow failed: {}",
            result.error.as_deref().unwrap_or("unknown error")
        )),
        RunStatus::Waiting => Err(child_limit_error(&result)),
        RunStatus::Running => Err("child workflow did not reach a stable checkpoint".to_string()),
    }
}

/// Load (or create) a deterministic child checkpoint, verify it belongs to this
/// parent, stamp the parent link, and write it. The caller holds the child's
/// execution lock. `parent_awaits_child` is true when the parent's durable link
/// already names this child: a missing checkpoint is then an integrity failure,
/// never a reason to start the child over.
async fn prepare_child(
    workflow: &Workflow,
    input: &HashMap<String, String>,
    child_id: &str,
    parent_run_id: &str,
    parent_awaits_child: bool,
    mode: ExecutionMode,
) -> Result<WorkflowRun, String> {
    let existing = if mode.is_dry_run() {
        None
    } else {
        match store::load_run(child_id) {
            Ok(run) => Some(run),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if parent_awaits_child {
                    return Err(
                        "pending child checkpoint is missing; refusing to recreate execution"
                            .to_string(),
                    );
                }
                None
            }
            Err(error) => return Err(format!("failed to load child checkpoint: {error}")),
        }
    };
    if let Some(child) = &existing {
        if child.workflow_id != workflow.id
            || child.state.get(PARENT_RUN_KEY).map(String::as_str) != Some(parent_run_id)
        {
            // Older deterministic child checkpoints predate links. Permit their
            // adoption, but never attach a run already owned by another parent.
            if child.workflow_id != workflow.id || child.state.contains_key(PARENT_RUN_KEY) {
                return Err("child run belongs to a different workflow or parent".to_string());
            }
        }
    }
    if existing
        .as_ref()
        .is_none_or(|child| child.status == RunStatus::Running)
    {
        // Refusing a new child must not leave a fictional Running checkpoint.
        crate::workflow::ensure_agents_active(workflow).await?;
        WorkflowGraph::build(workflow).map_err(|e| e.to_string())?;
    }
    let mut child = existing.unwrap_or_else(|| {
        WorkflowRun::new(child_id.to_owned(), workflow.id.clone(), input.clone())
    });
    child
        .state
        .insert(PARENT_RUN_KEY.to_string(), parent_run_id.to_owned());
    // Write the child first: a parent link must never point to an execution
    // checkpoint that has not yet existed. A crash before the parent's write
    // safely adopts this deterministic child when the parent re-enters.
    checkpoint_run(&child, mode)?;
    Ok(child)
}

/// Run (or re-enter) a prepared child to a stable checkpoint. A terminal or
/// gate-suspended child is returned as-is.
async fn drive_child(
    workflow: &Workflow,
    input: HashMap<String, String>,
    child: WorkflowRun,
    depth: usize,
    mode: ExecutionMode,
) -> Result<WorkflowRun, String> {
    match child.status {
        RunStatus::AwaitingInput if child.state.contains_key(AWAITING_CHILD_KEY) => {
            // An intermediate parent may still be waiting after a crash between
            // the leaf completion checkpoint and ancestor advancement. Re-enter
            // composition nodes, whose actual gate children remain untouched.
            run_workflow_inner(workflow, input, child.run_id, depth + 1, mode).await
        }
        RunStatus::AwaitingInput | RunStatus::Completed | RunStatus::Failed => Ok(child),
        // A child parked on a limit is woken with its parent.
        RunStatus::Running | RunStatus::Waiting => {
            run_workflow_inner(workflow, input, child.run_id, depth + 1, mode).await
        }
    }
}

/// Default number of `ForEach` items / `Parallel` branches that run at once.
pub const DEFAULT_FANOUT_CONCURRENCY: u32 = 4;
/// Hard ceiling on a fan-out node's `max_concurrency`.
pub const MAX_FANOUT_CONCURRENCY: u32 = 16;
/// Hard ceiling on `ForEach` items (and `Parallel` branches) per node.
pub const MAX_FANOUT_ITEMS: usize = 1_000;

/// Reserved run-state namespace for fan-out progress (`__fanout_<id>` holds the
/// finished item results). SetState cannot write it.
pub(crate) const FANOUT_STATE_PREFIX: &str = "__fanout_";

/// One child run of a `ForEach` / `Parallel` node.
struct FanoutJob<'w> {
    /// Result key: the item index or the branch id.
    key: String,
    workflow: &'w Workflow,
    input: HashMap<String, String>,
    child_id: String,
}

/// How a fan-out node assembles its children's results.
#[derive(Clone, Copy)]
enum FanoutShape {
    /// A JSON array in job order (`ForEach`).
    Array,
    /// A JSON object keyed by job key (`Parallel`).
    Object,
}

/// The value a child run hands its fan-out parent: its single output, or the
/// lexicographically first output key's value when it has several.
fn child_primary_output(child: &WorkflowRun) -> String {
    let mut keys: Vec<&String> = child.output.keys().collect();
    keys.sort();
    keys.first()
        .and_then(|key| child.output.get(*key))
        .cloned()
        .unwrap_or_default()
}

/// Embed a child result in the fan-out output: JSON objects and arrays stay
/// structured, anything else is a string.
fn fanout_value(output: &str) -> serde_json::Value {
    match serde_json::from_str::<serde_json::Value>(output) {
        Ok(value @ (serde_json::Value::Object(_) | serde_json::Value::Array(_))) => value,
        _ => serde_json::Value::String(output.to_owned()),
    }
}

/// Clamp a fan-out node's concurrency setting.
pub fn effective_fanout_concurrency(max_concurrency: Option<u32>) -> usize {
    max_concurrency
        .unwrap_or(DEFAULT_FANOUT_CONCURRENCY)
        .clamp(1, MAX_FANOUT_CONCURRENCY) as usize
}

/// Run a set of child workflows with bounded concurrency and join their
/// results in job order.
///
/// Durability: each finished child's output is folded into
/// `state["__fanout_<exec id>"]` and checkpointed immediately, so a resumed
/// node skips finished children and re-enters the rest under their
/// deterministic child run ids (which themselves resume from their own
/// checkpoints). When a child suspends at a gate, fails, or parks on a limit, no
/// further child starts; the children in flight settle (and are checkpointed)
/// first. A suspension links the parent to the suspended child so approval
/// resumes it and then this node; a failure fails the node; a limit parks it.
#[allow(clippy::too_many_arguments)]
async fn run_fanout(
    node_id: &str,
    exec_id: &str,
    jobs: Vec<FanoutJob<'_>>,
    limit: usize,
    shape: FanoutShape,
    run: &mut WorkflowRun,
    depth: usize,
    mode: ExecutionMode,
) -> Result<String, String> {
    if depth >= MAX_SUBWORKFLOW_DEPTH {
        return Err(format!(
            "sub-workflow nesting exceeded max depth of {MAX_SUBWORKFLOW_DEPTH}"
        ));
    }
    let progress_key = format!("{FANOUT_STATE_PREFIX}{exec_id}");
    let mut finished: HashMap<String, String> = run
        .state
        .get(&progress_key)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    let order: Vec<String> = jobs.iter().map(|job| job.key.clone()).collect();
    let mut pending: VecDeque<FanoutJob<'_>> = jobs
        .into_iter()
        .filter(|job| !finished.contains_key(&job.key))
        .collect();
    let parent_run_id = run.run_id.clone();
    let awaited_child = run.state.get(AWAITING_CHILD_KEY).cloned();

    type ChildFuture<'f> = std::pin::Pin<
        Box<
            dyn std::future::Future<Output = (String, String, Result<WorkflowRun, String>)>
                + Send
                + 'f,
        >,
    >;
    let mut in_flight: FuturesUnordered<ChildFuture<'_>> = FuturesUnordered::new();
    let mut suspended: Option<String> = None;
    let mut failure: Option<String> = None;
    let mut limited: Option<String> = None;

    loop {
        while suspended.is_none()
            && failure.is_none()
            && limited.is_none()
            && in_flight.len() < limit.max(1)
        {
            let Some(job) = pending.pop_front() else {
                break;
            };
            let parent_awaits_child = awaited_child.as_deref() == Some(job.child_id.as_str());
            let parent_run_id = parent_run_id.clone();
            in_flight.push(Box::pin(async move {
                let FanoutJob {
                    key,
                    workflow,
                    input,
                    child_id,
                } = job;
                let result = async {
                    let child_lock = execution_lock(&child_id)?;
                    let child_guard = child_lock.lock_owned().await;
                    let child = prepare_child(
                        workflow,
                        &input,
                        &child_id,
                        &parent_run_id,
                        parent_awaits_child,
                        mode,
                    )
                    .await?;
                    drop(child_guard);
                    drive_child(workflow, input, child, depth, mode).await
                }
                .await;
                (key, child_id, result)
            }));
        }
        let Some((key, child_id, result)) = in_flight.next().await else {
            break;
        };
        match result {
            Ok(child) => match child.status {
                RunStatus::Completed => {
                    finished.insert(key, child_primary_output(&child));
                    run.state.insert(
                        progress_key.clone(),
                        serde_json::to_string(&finished).map_err(|e| e.to_string())?,
                    );
                    if run.state.get(AWAITING_CHILD_KEY) == Some(&child_id) {
                        run.state.remove(AWAITING_CHILD_KEY);
                    }
                    checkpoint_run(run, mode)?;
                }
                RunStatus::AwaitingInput => {
                    suspended.get_or_insert(child_id);
                }
                RunStatus::Failed => {
                    failure.get_or_insert(format!(
                        "child workflow failed: {}",
                        child.error.as_deref().unwrap_or("unknown error")
                    ));
                }
                RunStatus::Waiting => {
                    limited.get_or_insert(child_limit_error(&child));
                }
                RunStatus::Running => {
                    failure.get_or_insert(
                        "child workflow did not reach a stable checkpoint".to_string(),
                    );
                }
            },
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
    }

    if let Some(error) = failure {
        return Err(error);
    }
    if let Some(error) = limited {
        return Err(error);
    }
    if let Some(child_id) = suspended {
        run.state.insert(AWAITING_CHILD_KEY.to_string(), child_id);
        run.awaiting_node = Some(node_id.to_string());
        checkpoint_run(run, mode)?;
        return Err(SUSPEND_SENTINEL.to_string());
    }

    let output = match shape {
        FanoutShape::Array => serde_json::Value::Array(
            order
                .iter()
                .map(|key| fanout_value(finished.get(key).map_or("", String::as_str)))
                .collect(),
        ),
        FanoutShape::Object => serde_json::Value::Object(
            order
                .iter()
                .map(|key| {
                    (
                        key.clone(),
                        fanout_value(finished.get(key).map_or("", String::as_str)),
                    )
                })
                .collect(),
        ),
    };
    // The node is about to complete with the joined value; its progress is no
    // longer needed for resume.
    run.state.remove(&progress_key);
    serde_json::to_string(&output).map_err(|e| format!("failed to serialise fan-out results: {e}"))
}

/// Execute a `ForEach` node: resolve its items, then map the body workflow
/// over them through [`run_fanout`].
#[allow(clippy::too_many_arguments)]
async fn run_for_each(
    body_workflow_id: &str,
    items_template: Option<&str>,
    max_concurrency: Option<u32>,
    node_id: &str,
    exec_id: &str,
    input: &str,
    run: &mut WorkflowRun,
    depth: usize,
    mode: ExecutionMode,
) -> Result<String, String> {
    if body_workflow_id == run.workflow_id {
        return Err(format!(
            "for_each node '{node_id}': body_workflow_id '{body_workflow_id}' is the workflow itself (would recurse infinitely)"
        ));
    }
    let body = store::load_workflow(body_workflow_id).map_err(|e| {
        format!("for_each node '{node_id}': body workflow '{body_workflow_id}' not found: {e}")
    })?;
    let raw_items = match items_template {
        Some(template) => super::template::resolve(template, &build_template_ctx(input, run)),
        None => input.to_string(),
    };
    let items = match serde_json::from_str::<serde_json::Value>(raw_items.trim()) {
        Ok(serde_json::Value::Array(items)) => items,
        _ => {
            return Err(format!(
                "for_each node '{node_id}': items must be a JSON array"
            ))
        }
    };
    if items.len() > MAX_FANOUT_ITEMS {
        return Err(format!(
            "for_each node '{node_id}': {} items exceed the {MAX_FANOUT_ITEMS} item limit",
            items.len()
        ));
    }
    let jobs = items
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let item_text = match item {
                serde_json::Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            FanoutJob {
                key: index.to_string(),
                workflow: &body,
                input: HashMap::from([
                    ("input".to_string(), item_text),
                    ("index".to_string(), index.to_string()),
                ]),
                child_id: format!("{}-{exec_id}-item-{index}", run.run_id),
            }
        })
        .collect();
    run_fanout(
        node_id,
        exec_id,
        jobs,
        effective_fanout_concurrency(max_concurrency),
        FanoutShape::Array,
        run,
        depth,
        mode,
    )
    .await
}

/// Execute a `Parallel` node: run each branch's workflow through
/// [`run_fanout`] and join the results by branch id.
#[allow(clippy::too_many_arguments)]
async fn run_parallel(
    branches: &[super::ParallelBranch],
    max_concurrency: Option<u32>,
    node_id: &str,
    exec_id: &str,
    input: &str,
    run: &mut WorkflowRun,
    depth: usize,
    mode: ExecutionMode,
) -> Result<String, String> {
    let ctx = build_template_ctx(input, run);
    let mut workflows = Vec::with_capacity(branches.len());
    for branch in branches {
        if branch.workflow_id == run.workflow_id {
            return Err(format!(
                "parallel node '{node_id}': branch '{}' runs the workflow itself (would recurse infinitely)",
                branch.id
            ));
        }
        let workflow = store::load_workflow(&branch.workflow_id).map_err(|e| {
            format!(
                "parallel node '{node_id}': branch '{}' workflow '{}' not found: {e}",
                branch.id, branch.workflow_id
            )
        })?;
        workflows.push(workflow);
    }
    let jobs = branches
        .iter()
        .zip(&workflows)
        .map(|(branch, workflow)| {
            let branch_input = branch
                .input
                .as_deref()
                .map_or_else(|| input.to_string(), |t| super::template::resolve(t, &ctx));
            FanoutJob {
                key: branch.id.clone(),
                workflow,
                input: HashMap::from([("input".to_string(), branch_input)]),
                child_id: format!("{}-{exec_id}-par-{}", run.run_id, branch.id),
            }
        })
        .collect();
    run_fanout(
        node_id,
        exec_id,
        jobs,
        effective_fanout_concurrency(max_concurrency),
        FanoutShape::Object,
        run,
        depth,
        mode,
    )
    .await
}

/// The error a parent node reports for a child run parked on a provider limit.
/// It carries the child's own limit text so [`super::limits`] parks the parent
/// with the same reset time.
fn child_limit_error(child: &WorkflowRun) -> String {
    format!(
        "child workflow is waiting on a provider limit: {}",
        child.wait_reason.as_deref().unwrap_or("rate limit")
    )
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
/// - A suspended child propagates its gate to the parent without advancing the
///   counter/carry; approval resumes the same deterministic iteration run.
async fn run_while_loop(
    expr: &str,
    body_id: &str,
    cap: u64,
    node_id: &str,
    input: &str,
    run: &mut WorkflowRun,
    depth: usize,
    mode: ExecutionMode,
) -> Result<String, String> {
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
        // Preserve the carry before starting a child, including iteration zero.
        // A pending approval must never fold an empty partial output into it.
        run.state.insert(counter_key.clone(), counter.to_string());
        run.state.insert(carry_key.clone(), carry.clone());
        let result = match run_child_workflow(
            &body_wf,
            sub_input,
            sub_run_id.clone(),
            node_id,
            run,
            depth,
            mode,
        )
        .await
        {
            Ok(result) => result,
            Err(error) => {
                // An iteration whose child ran and failed ends the loop with
                // nothing left to resume, so drop the counter/carry. A
                // suspension keeps them so approval resumes the same iteration,
                // and an integrity refusal (lost or damaged child checkpoint)
                // keeps them as evidence of the iteration that was pending.
                if error != SUSPEND_SENTINEL
                    && store::load_run(&sub_run_id)
                        .is_ok_and(|child| child.status == RunStatus::Failed)
                {
                    run.state.remove(&counter_key);
                    run.state.remove(&carry_key);
                }
                return Err(error);
            }
        };

        // Fold the body's first output into the carry (loop variable advances).
        carry = result.output.values().next().cloned().unwrap_or_default();
        counter = next_counter;

        // Checkpoint the loop progress after every iteration (the genuinely-new
        // mid-loop durability — the executor otherwise only checkpoints between
        // nodes).
        run.state.insert(counter_key.clone(), counter.to_string());
        run.state.insert(carry_key.clone(), carry.clone());
        checkpoint_run(run, mode)?;
    }

    // Loop finished: the node produces the final carry as a plain data value.
    Ok(carry)
}

/// Park `run` on a provider limit reported by `node_id`. The attempt the limit
/// interrupted is refunded: waiting out a limit must not spend the node's
/// retry budget, or a long rate-limited stretch would fail a healthy node.
fn park_on_limit(run: &mut WorkflowRun, node_id: &str, error: &str) {
    let now = chrono::Utc::now();
    let hit = super::limits::classify(error, now).unwrap_or(super::limits::LimitHit {
        resume_at: now + super::limits::DEFAULT_WAIT,
        reported: false,
    });
    if let Some(state) = run.nodes.get_mut(node_id) {
        state.attempts = state.attempts.saturating_sub(1);
        state.status = NodeStatus::Running;
        state.error = Some(error.to_owned());
    }
    run.status = RunStatus::Waiting;
    run.resume_at = Some(hit.resume_at.to_rfc3339());
    run.wait_reason = Some(error.to_owned());
    run.limit_waits = run.limit_waits.saturating_add(1);
    run.updated_at = now.to_rfc3339();
    tracing::info!(
        run_id = %run.run_id,
        node_id,
        resume_at = %hit.resume_at,
        reported = hit.reported,
        "workflow run parked on a provider limit"
    );
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

    // One delegate failing does not fail the node, but one stopped by a rate,
    // usage, or session limit does: the node error lets the run park until the
    // limit resets, and the resumed fan-out reruns only the delegates that did
    // not finish (successes are checkpointed above).
    if let Some(limited) = results
        .iter()
        .filter_map(|result| result.error.as_deref())
        .find(|error| super::limits::is_limit_error(error))
    {
        return Err(format!("delegate hit a provider limit: {limited}"));
    }

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
            let conversation_id = format!("{WORKFLOW_CONVERSATION_PREFIX}{run_id}-{node_id}");
            return runner
                .run(Some(id.to_string()), conversation_id, prompt.to_string())
                .await
                .map_err(|e| format!("prompt node: agent '{id}' failed: {e}"));
        }
    }

    let gw_url = gateway_url();
    let gw_token = gateway_token();

    let model = default_llm_model();

    let payload = serde_json::json!({
        "model": model,
        "stream": false,
        "messages": [{ "role": "user", "content": prompt }],
    });

    let client = crate::sidecar::gateway::gateway_http_client();
    let endpoint = format!("{}/v1/chat/completions", gw_url.trim_end_matches('/'));
    let mut builder = crate::sidecar::gateway::with_side_call_headers(
        client.post(&endpoint).json(&payload),
        &crate::sidecar::gateway::SidePurpose::WorkflowPrompt,
    );
    if let Some(token) = gw_token {
        builder = builder.bearer_auth(token);
    }

    let resp = builder
        .send()
        .await
        .map_err(|e| format!("prompt node: gateway unreachable (fail-closed): {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let retry_after = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = resp.text().await.unwrap_or_default();
        return Err(super::limits::gateway_error_message(
            "prompt node",
            status,
            retry_after.as_deref(),
            &body,
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("prompt node: invalid gateway response: {e}"))?;
    crate::sidecar::gateway::log_side_usage(
        &crate::sidecar::gateway::SidePurpose::WorkflowPrompt,
        &model,
        &body,
    );
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

/// The model a workflow step requests when it does not name one.
fn default_llm_model() -> String {
    std::env::var("RYU_DEFAULT_LLM_MODEL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "gpt-4o-mini".to_string())
}

/// The gateway route a BAML code step's `Ryu` client uses, so its model calls
/// stay governed like every other workflow model call.
fn code_step_llm_route(model: Option<&str>) -> ryu_code_runner::LlmRoute {
    use crate::sidecar::gateway::{gateway_token, gateway_url};

    ryu_code_runner::LlmRoute {
        base_url: format!("{}/v1", gateway_url().trim_end_matches('/')),
        api_key: gateway_token(),
        model: model
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map_or_else(default_llm_model, str::to_string),
    }
}

/// Execute a `Code` node through [`ryu_code_runner`]: Lean and Bend run in a
/// command-capable sandbox (or the host only when allowed), BAML runs as a
/// scrubbed, gateway-only `baml-cli` server.
#[allow(clippy::too_many_arguments)]
async fn run_code_step(
    language: ryu_code_runner::CodeLanguage,
    mode: ryu_code_runner::CodeMode,
    source: &str,
    input: &str,
    function: Option<&str>,
    args: &serde_json::Value,
    model: Option<&str>,
    timeout: std::time::Duration,
) -> Result<String, String> {
    let llm = (language == ryu_code_runner::CodeLanguage::Baml
        && mode == ryu_code_runner::CodeMode::Run)
        .then(|| code_step_llm_route(model));
    let request = ryu_code_runner::CodeRequest {
        language,
        mode,
        source,
        input,
        function,
        args,
        timeout,
        llm: llm.as_ref(),
    };
    let output = ryu_code_runner::run_code(&request)
        .await
        .map_err(|e| format!("code node ({}): {e}", language.as_str()))?;
    tracing::debug!(
        language = language.as_str(),
        mode = mode.as_str(),
        runner = %output.runner,
        "workflow code step finished"
    );
    Ok(output.value)
}

/// Execute a `Skill` node: load the skill's instruction body from the registry
/// and run it (skill body + resolved task) through the chosen agent, or the
/// default gateway LLM when no agent is set. The composed text reuses the same
/// `## Skill: <name>` framing the chat injector uses ([`crate::skills`]), so a
/// skill behaves the same whether it is injected into a chat turn or driven as a
/// workflow step. Fails clearly when the skill is not installed.
///
/// Everything decidable without a network call lives in [`compose_skill_prompt`];
/// this function is the registry read plus the model call, so the two failure arms
/// are unit-testable without a gateway or a `~/.claude/skills` directory.
async fn run_skill(
    skill_id: &str,
    agent_id: Option<&str>,
    task: &str,
    run_id: &str,
    node_id: &str,
) -> Result<String, String> {
    let record = ryu_skills::SkillRegistry::load()
        .list_all()
        .into_iter()
        .find(|s| s.id == skill_id);
    let composed = compose_skill_prompt(skill_id, record, task)?;
    run_prompt(&composed, agent_id, run_id, node_id).await
}

/// Resolve a looked-up skill record into the prompt a `Skill` node runs, or the
/// node failure explaining why there is nothing to run.
///
/// The composed text reuses the same `## Skill: <name>` framing the chat/ACP
/// injectors build from a record, so a skill behaves the same whether it is injected
/// into a turn or driven as a workflow step.
///
/// ## Why there are *two* failure arms
///
/// A [`ryu_skills::SkillRecord`] can be present and still have nothing to run:
/// `register_app_skill` stores `instructions: String::new()` for a plugin that
/// contributes a `RunnableKind::Skill` (its `SkillConfig` is `skill_id`-only — the
/// real body only exists once the skill is materialised on disk), and a
/// front-matter-only `SKILL.md` parses to an empty body too (the only parse error is
/// a missing `name`). Without the [`ryu_skills::SkillRecord::is_loadable`] check,
/// such a record composed to `"## Skill: <name>\n\n\n<task>"` — a heading with
/// nothing under it — and the node reported **success**. That is the
/// healthy-status-for-a-thing-that-is-not-there shape the predicate exists to stop,
/// and a workflow is the worst place for it: the run continues and downstream nodes
/// consume output produced without the instructions the author picked the node for.
///
/// The five model-facing surfaces (`skills.search`, `skills.load`, the merged tool
/// catalog, and the two injected blocks) apply the same predicate as a *filter*.
/// This one is not a discovery surface — a human wrote the id into the node, nothing
/// offered it — so it diagnoses instead of hiding. And `is_loadable` is checked after
/// the lookup rather than folded into it, so the two states stay distinguishable:
/// "you named a skill this node does not have" and "the skill is registered here but
/// its body was never installed" need different fixes, and collapsing them into the
/// not-installed message would send an operator hunting for a skill that is in fact
/// sitting right there in their library.
///
/// The caller reads `list_all()`, not `enabled_for` — deliberate and unchanged: a
/// workflow node names one specific skill, so global enablement and the per-agent
/// allowlist (both of which scope what a *model* may discover) do not gate it.
fn compose_skill_prompt(
    skill_id: &str,
    record: Option<ryu_skills::SkillRecord>,
    task: &str,
) -> Result<String, String> {
    let record =
        record.ok_or_else(|| format!("skill node: skill '{skill_id}' is not installed"))?;
    if !record.is_loadable() {
        return Err(format!(
            "skill node: skill '{skill_id}' is registered on this node but has no \
             instructions installed, so there is nothing to run. If a plugin \
             contributes it, the body arrives when the skill is materialised on disk."
        ));
    }
    Ok(format!(
        "## Skill: {}\n{}\n\n{}",
        record.name, record.instructions, task
    ))
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
    run: &mut WorkflowRun,
    node_id: &str,
    exec_id: &str,
    depth: usize,
    mode: ExecutionMode,
) -> Result<String, String> {
    use crate::plugin_manifest::PluginManifestLoader;
    use crate::runnable::RunnableKind;

    let run_id = run.run_id.clone();
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
            boxed_node_work(|| run_tool(&slug, args, input, idem_key)).await
        }
        RunnableKind::Agent => {
            // Run the agent registered under the runnable id; the pipeline value
            // is the task. Fails clearly if the plugin's agent is not (yet)
            // registered in the agent store.
            boxed_node_work(|| run_prompt(input, Some(&entry.id), &run_id, exec_id)).await
        }
        RunnableKind::Skill => {
            let skill_id = config_str("skill_id")?;
            boxed_node_work(|| run_skill(&skill_id, None, input, &run_id, exec_id)).await
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
            let sub_run_id = format!("{run_id}-plugin-{exec_id}");
            let result = boxed_node_work(|| run_child_workflow(&sub, sub_input, sub_run_id, node_id, run, depth, mode)).await?;
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

    let client = crate::sidecar::gateway::gateway_http_client();
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
/// fully-qualified tool id (`<server>.<tool>`). The node's `args` are merged
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
    //
    // Structural twin of `run_ghost_action` below: `ghost.ghost_run` is a Core
    // BUILT-IN MCP tool, so the node drives the shared registry directly rather
    // than linking the out-of-process `@ryu/recipes` app. The app's own
    // `/api/recipes/:name/run` still reaches this same engine through the generic
    // `ghost.replay` kernel capability — two lanes, one registry.
    //
    // Two deliberate consequences of owning replay here: the app's
    // `replay.ended`/`replay.failed` events do not fire on this lane (they never
    // did — the emitter no-ops without a per-plugin `RYU_EXT_TOKEN`, which Core
    // does not have), and the transport-error message no longer carries the app
    // wrapper's doubled `recipe replay failed:` prefix.
    let registry = crate::sidecar::mcp::global_registry()
        .ok_or_else(|| "recipe node: MCP registry not initialized".to_string())?;
    let envelope = registry
        .call_tool(
            crate::sidecar::mcp::GHOST_RUN_TOOL,
            serde_json::json!({ "recipe": recipe, "params": params }),
            None,
        )
        .await
        .map_err(|e| format!("recipe node: '{recipe}' failed: {e}"))?;
    crate::sidecar::mcp::client::extract_mcp_json(&envelope)
        .map(|v| v.to_string())
        .map_err(|e| format!("recipe node: '{recipe}' failed: {e}"))
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
        "click" => ("ghost.ghost_click", json!({ "query": query })),
        "double_click" => ("ghost.ghost_click", json!({ "query": query, "count": 2 })),
        "hover" => ("ghost.ghost_hover", json!({ "query": query })),
        "long_press" => ("ghost.ghost_long_press", json!({ "query": query })),
        "type" => (
            "ghost.ghost_type",
            json!({ "text": pstr("text").unwrap_or(""), "into": query }),
        ),
        "press" => (
            "ghost.ghost_press",
            json!({ "key": pstr("key").unwrap_or("return") }),
        ),
        "hotkey" | "keyboard_shortcut" => {
            let keys: Vec<String> = pstr("keys")
                .unwrap_or("")
                .split('+')
                .map(|s| s.trim().to_string())
                .collect();
            ("ghost.ghost_hotkey", json!({ "keys": keys }))
        }
        "scroll" => (
            "ghost.ghost_scroll",
            json!({
                "direction": pstr("direction").unwrap_or("down"),
                "amount": pnum("amount").map(|n| n as i64).unwrap_or(3),
            }),
        ),
        "focus" => (
            "ghost.ghost_focus",
            json!({ "app": app.or_else(|| pstr("app")).unwrap_or("") }),
        ),
        "drag" => ("ghost.ghost_drag", json!({})),
        "window" => (
            "ghost.ghost_window",
            json!({
                "action": pstr("action").unwrap_or("focus"),
                "app": app.or_else(|| pstr("app")).unwrap_or(""),
            }),
        ),
        "screenshot" => ("ghost.ghost_screenshot", json!({})),
        unknown => {
            return Err(format!(
                "unknown ghost action '{unknown}' — install the ghost sidecar and record a supported step"
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
    crate::sidecar::mcp::client::extract_mcp_json(&result)
        .map(|v| v.to_string())
        .map_err(|e| format!("ghost action node: '{action}' failed: {e}"))
}

async fn run_webhook(
    url: &str,
    method: &str,
    input: &str,
    idem_key: &str,
) -> Result<String, String> {
    let outbound = format!(
        "{} {}\n{}",
        method,
        url,
        serde_json::json!({ "input": input })
    );
    crate::sidecar::gateway::govern_egress(&outbound)
        .await
        .map_err(|error| format!("webhook node: outbound DLP denied delivery: {error}"))?;
    // Resolve, classify, and pin the exact addresses immediately before the
    // request. The shared helper also disables redirects, so a later DNS
    // answer or 30x cannot cross the private-network boundary.
    let (parsed, screened) = crate::server::screen_egress_url_pinned(url, true, None)
        .await
        .map_err(|e| format!("webhook node: destination rejected: {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "webhook node: destination has no host".to_owned())?;
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30));
    if let crate::server::ScreenedEgress::Pinned(addresses) = screened {
        builder = builder.resolve_to_addrs(host, &addresses);
    }
    let client = builder
        .build()
        .map_err(|e| format!("webhook node: client build failed: {e}"))?;
    let req = match method.to_uppercase().as_str() {
        "GET" => client.get(parsed.clone()),
        "PUT" => client.put(parsed.clone()),
        "DELETE" => client.delete(parsed.clone()),
        _ => client.post(parsed.clone()),
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
        .map_err(|e| format!("webhook node: request failed: {}", e.without_url()))?;
    let status = resp.status();
    if resp
        .content_length()
        .is_some_and(|length| length > MAX_WEBHOOK_RESPONSE_BYTES as u64)
    {
        return Err(format!(
            "webhook node: response exceeds {MAX_WEBHOOK_RESPONSE_BYTES} bytes"
        ));
    }
    let mut stream = resp.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|e| format!("webhook node: response read failed: {}", e.without_url()))?;
        if body.len().saturating_add(chunk.len()) > MAX_WEBHOOK_RESPONSE_BYTES {
            return Err(format!(
                "webhook node: response exceeds {MAX_WEBHOOK_RESPONSE_BYTES} bytes"
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&body).into_owned();
    if !status.is_success() {
        return Err(format!("webhook node: HTTP {status}: {text}"));
    }
    Ok(text)
}

#[cfg(test)]
#[path = "executor_tests.rs"]
mod tests;
