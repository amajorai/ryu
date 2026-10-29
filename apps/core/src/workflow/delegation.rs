//! Sub-agent delegation engine for Ryu Core.
//!
//! A *parent* agent (or workflow node) can hand a self-contained task to one or
//! more *sub-agents*. Each sub-agent runs with a **clean context** — only the
//! task prompt is sent, never the parent's conversation history — under a named
//! **permission preset** and within hard **safety caps**:
//!
//!   - max delegation depth: [`MAX_DELEGATION_DEPTH`] (3)
//!   - max concurrent delegates per fan-out: [`MAX_CONCURRENT_DELEGATES`] (5)
//!   - per-delegate token budget and wall-time limit (configurable, with
//!     defaults [`DEFAULT_MAX_TOKENS`] / [`DEFAULT_WALL_TIME_SECS`]).
//!
//! Same-depth delegates run **concurrently** (bounded by the concurrency cap);
//! progress for each delegate streams back through a caller-supplied channel.
//!
//! Per the Core-vs-Gateway rule this is **Core**: it decides *what runs* (which
//! sub-agent, with what task, how deep, how many at once). The permission preset
//! here is an *intent label* Core attaches to the delegate; the Gateway remains
//! the place that actually *enforces* tool/data policy on the model call. Core
//! never reaches around the Gateway to grant capability — it only narrows it.
//!
//! # Durable fan-out
//!
//! When `run_fanout` is given a `checkpoint_key` (composed of `run_id` and
//! `node_id`), each completed delegate's result is persisted to
//! `~/.ryu/fanout-checkpoints/<run_id>/<node_id>/<delegate_id>.json`. On resume
//! with the same key, delegates whose checkpoint file exists are skipped and
//! their recorded result reused, preserving input-order results without
//! re-running completed delegates.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

/// Maximum nesting depth for delegation. A depth-3 delegate may not delegate
/// further; this bounds the worst-case fan-out tree and prevents runaway
/// recursion (an agent that keeps delegating to itself).
pub const MAX_DELEGATION_DEPTH: usize = 3;

/// Maximum number of sibling delegates that may run at the same time within a
/// single fan-out. Excess delegates queue behind a semaphore.
pub const MAX_CONCURRENT_DELEGATES: usize = 5;

/// Default per-delegate token budget when a request omits one.
pub const DEFAULT_MAX_TOKENS: u32 = 4096;

/// Default per-delegate wall-time limit (seconds) when a request omits one.
pub const DEFAULT_WALL_TIME_SECS: u64 = 120;

/// Hard upper bound for one delegate's model output budget. This is enforced at
/// the delegation engine boundary so callers cannot bypass the cap by invoking
/// `host.runFanout` directly instead of going through a plugin's input schema.
pub const MAX_DELEGATION_TOKENS: u32 = 32_768;

/// A named permission preset attached to a delegate. The four presets are the
/// complete, closed set (see issue "Out of scope: no new presets"). Each maps
/// to the concrete capabilities Core advertises to the delegate; the Gateway
/// enforces the matching policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionPreset {
    /// Read-only web/research tools, no filesystem or code mutation.
    Research,
    /// Read source files and metadata; no writes, no shell side effects.
    CodeRead,
    /// Read and write source files; may run code-mutating tools.
    CodeWrite,
    /// Pure text reduction; no tools at all.
    Summarise,
}

impl Default for PermissionPreset {
    fn default() -> Self {
        // The safest non-trivial default: read but never mutate.
        Self::CodeRead
    }
}

impl PermissionPreset {
    /// The concrete tool/capability allowlist this preset grants. Returned as
    /// stable string ids so the value can travel to the Gateway unchanged.
    pub fn allowed_tools(self) -> &'static [&'static str] {
        match self {
            Self::Research => &["web_search", "web_fetch", "read_memory"],
            Self::CodeRead => &["read_file", "list_files", "grep", "read_memory"],
            Self::CodeWrite => &[
                "read_file",
                "list_files",
                "grep",
                "write_file",
                "apply_patch",
                "run_command",
                "read_memory",
            ],
            Self::Summarise => &[],
        }
    }

    /// Whether the preset permits any side-effecting (write/exec) capability.
    pub fn allows_mutation(self) -> bool {
        matches!(self, Self::CodeWrite)
    }
}

/// An **inline, ephemeral sub-agent definition** — a "dynamic subagent" the
/// parent (or the calling LLM) invents at runtime instead of naming a
/// pre-registered [`agent_id`](DelegateSpec::agent_id). It carries just enough to
/// run one focused, clean-context turn: an LLM-authored system prompt, an optional
/// model override, and an advertised tool allowlist. This is the lightweight
/// counterpart to the registered-agent path: it runs as a single Gateway-routed
/// completion (no ACP tool loop, no persisted agent row), so every call still
/// passes through the Gateway firewall/DLP/budget/audit pipeline. For a
/// tool-executing sub-agent, name a registered `agent_id` instead.
///
/// `Eq`-safe by construction (no float fields) so [`DelegateSpec`] keeps `Eq`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InlineAgentDef {
    /// The role/instructions for this ephemeral sub-agent, authored at runtime.
    pub system_prompt: String,
    /// Optional model id for this sub-agent. Falls back to `RYU_DEFAULT_LLM_MODEL`
    /// then the built-in default when omitted/empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Tool names listed in this sub-agent's system prompt **for awareness only**.
    /// The inline path is a single clean-context completion with no tool loop, so
    /// an inline sub-agent *cannot execute* these — name a registered `agent_id`
    /// (which runs the full ACP tool loop) for a tool-executing specialist. An
    /// empty list lists none.
    #[serde(default)]
    pub tools: Vec<String>,
}

/// A single delegation request: a self-contained task for one sub-agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DelegateSpec {
    /// Stable id for this delegate within its fan-out (used in progress events).
    pub id: String,
    /// The self-contained task prompt. This is the *only* context the sub-agent
    /// receives — parent history is deliberately excluded.
    pub task: String,
    /// Optional agent id to route the sub-agent to (defaults to plain LLM).
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Permission preset governing the delegate's capabilities.
    #[serde(default)]
    pub preset: PermissionPreset,
    /// Optional **inline ephemeral agent** definition. When set (and no registered
    /// `agent_id` runner takes the call), the delegate runs as an LLM-authored,
    /// clean-context sub-agent using this definition instead of the preset-derived
    /// system prompt — the "dynamic subagent" path. See [`InlineAgentDef`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline: Option<InlineAgentDef>,
}

/// Caps applied to a fan-out of delegates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DelegationCaps {
    /// Per-delegate token budget.
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    /// Per-delegate wall-time limit in seconds.
    #[serde(default = "default_wall_time_secs")]
    pub wall_time_secs: u64,
    /// Max concurrent delegates (clamped to [`MAX_CONCURRENT_DELEGATES`]).
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent: usize,
}

fn default_max_tokens() -> u32 {
    DEFAULT_MAX_TOKENS
}
fn default_wall_time_secs() -> u64 {
    DEFAULT_WALL_TIME_SECS
}
fn default_max_concurrent() -> usize {
    MAX_CONCURRENT_DELEGATES
}

impl Default for DelegationCaps {
    fn default() -> Self {
        Self {
            max_tokens: DEFAULT_MAX_TOKENS,
            wall_time_secs: DEFAULT_WALL_TIME_SECS,
            max_concurrent: MAX_CONCURRENT_DELEGATES,
        }
    }
}

impl DelegationCaps {
    /// Effective concurrency: never exceed the hard cap and never zero.
    pub fn effective_concurrency(&self) -> usize {
        self.max_concurrent.clamp(1, MAX_CONCURRENT_DELEGATES)
    }

    /// Effective per-delegate output budget: never zero and never above the
    /// process-wide hard ceiling.
    pub fn effective_max_tokens(&self) -> u32 {
        self.max_tokens.clamp(1, MAX_DELEGATION_TOKENS)
    }
}

/// Outcome of one delegate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegateResult {
    pub id: String,
    pub preset: PermissionPreset,
    /// Final text produced by the sub-agent, if it completed.
    pub output: Option<String>,
    /// Error message, if the delegate failed (including cap violations).
    pub error: Option<String>,
    /// Conversation id used by a registered agent/ACP delegate, when one exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_conversation_id: Option<String>,
}

impl DelegateResult {
    pub fn ok(id: String, preset: PermissionPreset, output: String) -> Self {
        Self {
            id,
            preset,
            output: Some(output),
            error: None,
            child_conversation_id: None,
        }
    }

    pub fn failed(id: String, preset: PermissionPreset, error: String) -> Self {
        Self {
            id,
            preset,
            output: None,
            error: Some(error),
            child_conversation_id: None,
        }
    }

    fn with_child_conversation_id(mut self, child_conversation_id: Option<String>) -> Self {
        self.child_conversation_id = child_conversation_id;
        self
    }
}

/// A progress event streamed while a fan-out runs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum DelegateProgress {
    /// A delegate has been admitted past the concurrency gate and started.
    Started {
        id: String,
        preset: PermissionPreset,
    },
    /// A delegate finished (success or failure carried in `result`).
    Finished { result: DelegateResult },
}

/// The intentionally small lifecycle carrier for delegated-agent activity.
///
/// This is a transition, not a snapshot of the delegate or its work: no task,
/// transcript, command, cwd, prompt, or result crosses this seam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DelegationLifecycleTransition {
    pub run_id: String,
    pub agent_id: String,
    pub active_count: usize,
    pub transition_id: u64,
    #[serde(default)]
    pub run_active_count: usize,
}

static NEXT_LIFECYCLE_TRANSITION_ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE_DELEGATES: AtomicU64 = AtomicU64::new(0);

fn active_by_run() -> &'static std::sync::Mutex<std::collections::HashMap<String, usize>> {
    static COUNTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, usize>>> =
        std::sync::OnceLock::new();
    COUNTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn lifecycle_dispatch_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn next_lifecycle_transition_id() -> u64 {
    NEXT_LIFECYCLE_TRANSITION_ID.fetch_add(1, Ordering::Relaxed)
}

fn emit_lifecycle_transition(
    run_id: &str,
    agent_id: &str,
    active_count: usize,
    run_active_count: usize,
) {
    let transition = DelegationLifecycleTransition {
        run_id: run_id.to_owned(),
        agent_id: agent_id.to_owned(),
        active_count,
        transition_id: next_lifecycle_transition_id(),
        run_active_count,
    };
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    handle.spawn(async move {
        let _guard = lifecycle_dispatch_lock().lock().await;
        let _ = crate::plugin_host::dispatch_global(
            crate::plugin_host::ON_DELEGATION_LIFECYCLE,
            crate::plugin_host::HookContext {
                event: Some(serde_json::to_value(transition).unwrap_or_default()),
                ..Default::default()
            },
        )
        .await;
    });
}

/// One queued delegate's place in its fan-out run's `run_active_count`.
///
/// The fan-out reserves every delegate it will run before it spawns any of them,
/// so a delegate still waiting for a concurrency permit keeps the run's count
/// above zero. Without this, a fan-out wider than its concurrency limit drained
/// to zero between delegates and observers saw the run as finished early.
struct DelegationRunReservation {
    run_id: String,
    agent_id: String,
    released: bool,
}

impl DelegationRunReservation {
    fn reserve(run_id: &str, agent_id: &str) -> Self {
        if let Ok(mut counts) = active_by_run().lock() {
            *counts.entry(run_id.to_owned()).or_default() += 1;
        }
        Self {
            run_id: run_id.to_owned(),
            agent_id: agent_id.to_owned(),
            released: false,
        }
    }

    /// The delegate got its permit: it now counts as globally active, and its
    /// reservation becomes the lease that `finish` releases.
    fn admit(mut self) -> DelegationLifecycleLease {
        self.released = true;
        let run_id = std::mem::take(&mut self.run_id);
        let agent_id = std::mem::take(&mut self.agent_id);
        let active_count = ACTIVE_DELEGATES.fetch_add(1, Ordering::AcqRel) + 1;
        let run_active_count = active_by_run()
            .lock()
            .ok()
            .and_then(|counts| counts.get(&run_id).copied())
            .unwrap_or(1);
        emit_lifecycle_transition(&run_id, &agent_id, active_count as usize, run_active_count);
        DelegationLifecycleLease {
            run_id,
            agent_id,
            finished: false,
        }
    }
}

impl Drop for DelegationRunReservation {
    /// A delegate that never got admitted (its task panicked or was aborted
    /// while queued) still leaves the run, so the run can reach zero.
    fn drop(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let run_active_count = release_run_slot(&self.run_id);
        emit_lifecycle_transition(
            &self.run_id,
            &self.agent_id,
            ACTIVE_DELEGATES.load(Ordering::Acquire) as usize,
            run_active_count,
        );
    }
}

/// Drop one delegate from its run's count, forgetting the run at zero.
fn release_run_slot(run_id: &str) -> usize {
    active_by_run()
        .lock()
        .map(|mut counts| {
            let count = counts.entry(run_id.to_owned()).or_default();
            *count = count.saturating_sub(1);
            let remaining = *count;
            if remaining == 0 {
                counts.remove(run_id);
            }
            remaining
        })
        .unwrap_or(0)
}

/// One admitted delegate owns exactly one lease. Drop is the safety net for a
/// panic/abort path; the finished bit prevents normal completion from
/// decrementing the global registry a second time.
struct DelegationLifecycleLease {
    run_id: String,
    agent_id: String,
    finished: bool,
}

impl DelegationLifecycleLease {
    fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        let previous = ACTIVE_DELEGATES
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                count.checked_sub(1)
            })
            .unwrap_or(0);
        let run_active_count = release_run_slot(&self.run_id);
        emit_lifecycle_transition(
            &self.run_id,
            &self.agent_id,
            previous.saturating_sub(1) as usize,
            run_active_count,
        );
    }
}

impl Drop for DelegationLifecycleLease {
    fn drop(&mut self) {
        self.finish();
    }
}

/// Errors raised before any delegate runs (validation failures).
#[derive(Debug)]
pub enum DelegationError {
    /// The requested depth would exceed [`MAX_DELEGATION_DEPTH`].
    DepthExceeded { depth: usize },
    /// No delegates were supplied.
    Empty,
}

impl std::fmt::Display for DelegationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DepthExceeded { depth } => write!(
                f,
                "delegation depth {depth} exceeds max of {MAX_DELEGATION_DEPTH}"
            ),
            Self::Empty => write!(f, "no delegates supplied to fan-out"),
        }
    }
}

impl std::error::Error for DelegationError {}

/// Durable checkpoint key identifying a fan-out node within a workflow run.
/// When supplied to [`run_fanout`], each completed delegate result is persisted
/// to disk so the fan-out can resume without re-running completed delegates.
#[derive(Debug, Clone)]
pub struct FanoutCheckpointKey {
    /// The workflow run id (from `WorkflowRun::run_id`).
    pub run_id: String,
    /// The `AgentDelegate` node id within the workflow.
    pub node_id: String,
}

/// Validate that `s` is a safe path segment: ASCII alphanumeric, `-`, or `_`,
/// 1–128 characters, with no directory separators, dots, or null bytes.
/// Rejects anything that could escape the checkpoint root via path traversal.
fn safe_segment(s: &str) -> anyhow::Result<&str> {
    if s.is_empty() || s.len() > 128 {
        anyhow::bail!("path segment is empty or too long (max 128 chars): {s:?}");
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        anyhow::bail!(
            "path segment contains disallowed characters (only [A-Za-z0-9_-] allowed): {s:?}"
        );
    }
    Ok(s)
}

/// Checkpoint root directory (`~/.ryu/fanout-checkpoints`).
fn checkpoint_root() -> std::path::PathBuf {
    crate::paths::state_path("fanout-checkpoints")
}

/// Compute the checkpoint directory for a fan-out step, validating all segments.
fn checkpoint_dir(key: &FanoutCheckpointKey) -> anyhow::Result<std::path::PathBuf> {
    let run_id = safe_segment(&key.run_id)?;
    let node_id = safe_segment(&key.node_id)?;
    Ok(checkpoint_root().join(run_id).join(node_id))
}

/// Persist a single delegate result to its checkpoint file.
/// Uses atomic write (temp-file + rename) so a mid-write crash cannot leave a
/// partial checkpoint that would be mistakenly treated as complete on resume.
/// Directory is created with mode 0o700 and the file with mode 0o600 on Unix.
pub(crate) fn save_delegate_checkpoint(key: &FanoutCheckpointKey, result: &DelegateResult) {
    let dir = match checkpoint_dir(key) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!("fanout checkpoint: invalid checkpoint key: {e}");
            return;
        }
    };
    let id = match safe_segment(&result.id) {
        Ok(id) => id,
        Err(e) => {
            tracing::warn!("fanout checkpoint: invalid result id: {e}");
            return;
        }
    };

    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        if let Err(e) = std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
        {
            tracing::warn!("fanout checkpoint: could not create dir {dir:?}: {e}");
            return;
        }
    }
    #[cfg(not(unix))]
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!("fanout checkpoint: could not create dir {dir:?}: {e}");
        return;
    }

    let path = dir.join(format!("{id}.json"));
    let json = match serde_json::to_vec_pretty(result) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("fanout checkpoint: serialise failed for {id}: {e}");
            return;
        }
    };
    // The delegate's output is user content: seal the whole body (fails closed:
    // without a key nothing is written and the delegate simply reruns on resume).
    let encoded = match encode_checkpoint(key, id, &json) {
        Ok(encoded) => encoded,
        Err(e) => {
            tracing::warn!("fanout checkpoint: not written for {id}: {e}");
            return;
        }
    };
    if let Err(e) = ryu_durable::atomic_write_private(&path, &encoded) {
        tracing::warn!("fanout checkpoint: write failed {path:?}: {e}");
    }
}

/// Record kind (AAD purpose) of a fan-out checkpoint in the `workflow-state`
/// content store.
const KIND_FANOUT: &str = "fanout-checkpoint";

/// The AAD id of one delegate's checkpoint: `<run_id>/<node_id>/<delegate_id>`.
fn checkpoint_record_id(key: &FanoutCheckpointKey, delegate_id: &str) -> String {
    format!("{}/{}/{delegate_id}", key.run_id, key.node_id)
}

fn encode_checkpoint(
    key: &FanoutCheckpointKey,
    delegate_id: &str,
    json: &[u8],
) -> std::io::Result<Vec<u8>> {
    use ryu_durable::CheckpointCodec as _;
    super::store::state_codec(KIND_FANOUT)?.encode(&checkpoint_record_id(key, delegate_id), json)
}

fn decode_checkpoint(
    key: &FanoutCheckpointKey,
    delegate_id: &str,
    stored: &[u8],
) -> std::io::Result<Vec<u8>> {
    use ryu_durable::CheckpointCodec as _;
    super::store::state_codec(KIND_FANOUT)?.decode(&checkpoint_record_id(key, delegate_id), stored)
}

/// Load a persisted delegate result from its checkpoint file, if it exists.
/// A checkpoint that does not open is treated as absent (the delegate reruns),
/// and logged.
fn load_delegate_checkpoint(
    key: &FanoutCheckpointKey,
    delegate_id: &str,
) -> Option<DelegateResult> {
    let dir = checkpoint_dir(key).ok()?;
    let id = safe_segment(delegate_id).ok()?;
    let path = dir.join(format!("{id}.json"));
    let data = std::fs::read(&path).ok()?;
    match decode_checkpoint(key, id, &data) {
        Ok(json) => serde_json::from_slice(&json).ok(),
        Err(error) => {
            tracing::warn!("fanout checkpoint: {path:?} does not open: {error}");
            None
        }
    }
}

/// Seal, once, the fan-out checkpoints still stored as legacy plaintext, and
/// remove dead ones (Core runs this while starting, through
/// [`super::store::reseal_stored_workflows`]). A checkpoint holds a delegate's
/// output and is only read again while its run can still resume, so:
/// - the checkpoints of a run whose record is `Completed` are deleted (they are
///   never read again);
/// - every other plaintext checkpoint is rewritten sealed, same content;
/// - temporary files a crashed write left are removed.
///
/// Idempotent. Returns how many files were sealed or removed.
pub(crate) fn reseal_fanout_checkpoints() -> usize {
    reseal_fanout_checkpoints_in(&checkpoint_root(), |run_id| {
        super::store::load_run(run_id).ok().map(|run| run.status)
    })
}

fn reseal_fanout_checkpoints_in(
    root: &std::path::Path,
    run_status: impl Fn(&str) -> Option<super::store::RunStatus>,
) -> usize {
    let subdirectories = |dir: &std::path::Path| -> Vec<(String, std::path::PathBuf)> {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|entry| entry.path().is_dir())
                    .filter_map(|entry| {
                        let name = entry.file_name().to_str()?.to_owned();
                        safe_segment(&name).ok()?;
                        Some((name, entry.path()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut changed = 0;
    for (run_id, run_dir) in subdirectories(root) {
        if run_status(&run_id) == Some(super::store::RunStatus::Completed) {
            match std::fs::remove_dir_all(&run_dir) {
                Ok(()) => changed += 1,
                Err(error) => tracing::warn!(
                    "fanout checkpoint: could not remove finished run {run_dir:?}: {error}"
                ),
            }
            continue;
        }
        for (node_id, node_dir) in subdirectories(&run_dir) {
            changed += ryu_durable::remove_orphaned_temp_files(
                &node_dir,
                std::time::Duration::from_secs(60),
            );
            let key = FanoutCheckpointKey {
                run_id: run_id.clone(),
                node_id,
            };
            let Ok(entries) = std::fs::read_dir(&node_dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Some(delegate_id) = path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .and_then(|stem| safe_segment(stem).ok())
                else {
                    continue;
                };
                let result = std::fs::read(&path).and_then(|stored| {
                    if ryu_durable::SealingCodec::is_sealed(&stored) {
                        return Ok(false);
                    }
                    // A completed delegate's checkpoint is written once and
                    // never again, so the same body is rewritten sealed.
                    let encoded = encode_checkpoint(&key, delegate_id, &stored)?;
                    ryu_durable::atomic_write_private(&path, &encoded)?;
                    Ok(true)
                });
                match result {
                    Ok(true) => changed += 1,
                    Ok(false) => {}
                    Err(error) => {
                        tracing::warn!("fanout checkpoint: {path:?} was not sealed: {error}")
                    }
                }
            }
        }
    }
    changed
}

/// Run a fan-out of sibling delegates concurrently, honouring the depth and
/// concurrency caps. Same-depth delegates execute at the same time (bounded by
/// `caps.effective_concurrency()`), each in a clean context. Progress events are
/// sent on `progress` as delegates start and finish.
///
/// `depth` is the depth of the delegates being launched (a top-level parent
/// delegating is `depth == 1`). Returns one [`DelegateResult`] per spec, in the
/// input order, regardless of completion order.
///
/// When `checkpoint_key` is `Some`, each completed delegate result is checkpointed
/// to disk and already-completed delegates are skipped on re-entry, making the
/// fan-out resumable after a Core restart.
pub async fn run_fanout(
    delegates: Vec<DelegateSpec>,
    caps: DelegationCaps,
    depth: usize,
    progress: Option<tokio::sync::mpsc::UnboundedSender<DelegateProgress>>,
) -> Result<Vec<DelegateResult>, DelegationError> {
    run_fanout_with_policy(
        delegates,
        caps,
        depth,
        progress,
        None,
        DelegationExecutionPolicy::Normal,
        format!("delegation-{}", uuid::Uuid::new_v4().simple()),
    )
    .await
}

/// Run a catalog review through the clean Gateway completion path, even when
/// the delegate names a registered agent. A registered agent owns its own tool
/// loop, so it cannot be used for a read-only catalog review without making the
/// preset prompt-only. The clean path exposes no executable tools.
pub async fn run_read_only_fanout(
    delegates: Vec<DelegateSpec>,
    caps: DelegationCaps,
    depth: usize,
    progress: Option<tokio::sync::mpsc::UnboundedSender<DelegateProgress>>,
) -> Result<Vec<DelegateResult>, DelegationError> {
    run_fanout_with_policy(
        delegates,
        caps,
        depth,
        progress,
        None,
        DelegationExecutionPolicy::ReadOnly,
        format!("delegation-{}", uuid::Uuid::new_v4().simple()),
    )
    .await
}

/// Like [`run_fanout`] but accepts an optional [`FanoutCheckpointKey`] that
/// enables per-delegate durable checkpointing.
pub async fn run_fanout_with_checkpoint(
    delegates: Vec<DelegateSpec>,
    caps: DelegationCaps,
    depth: usize,
    progress: Option<tokio::sync::mpsc::UnboundedSender<DelegateProgress>>,
    checkpoint_key: Option<Arc<FanoutCheckpointKey>>,
) -> Result<Vec<DelegateResult>, DelegationError> {
    let lifecycle_run_id = checkpoint_key
        .as_ref()
        .map(|key| key.run_id.clone())
        .unwrap_or_else(|| format!("delegation-{}", uuid::Uuid::new_v4().simple()));
    run_fanout_with_policy(
        delegates,
        caps,
        depth,
        progress,
        checkpoint_key,
        DelegationExecutionPolicy::Normal,
        lifecycle_run_id,
    )
    .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DelegationExecutionPolicy {
    Normal,
    ReadOnly,
}

async fn run_fanout_with_policy(
    delegates: Vec<DelegateSpec>,
    caps: DelegationCaps,
    depth: usize,
    progress: Option<tokio::sync::mpsc::UnboundedSender<DelegateProgress>>,
    checkpoint_key: Option<Arc<FanoutCheckpointKey>>,
    execution_policy: DelegationExecutionPolicy,
    run_id: String,
) -> Result<Vec<DelegateResult>, DelegationError> {
    if delegates.is_empty() {
        return Err(DelegationError::Empty);
    }
    if depth > MAX_DELEGATION_DEPTH {
        return Err(DelegationError::DepthExceeded { depth });
    }

    let mut caps = caps;
    caps.max_tokens = caps.effective_max_tokens();
    let semaphore = Arc::new(Semaphore::new(caps.effective_concurrency()));
    let caps = Arc::new(caps);
    let mut handles: Vec<(String, tokio::task::JoinHandle<DelegateResult>)> =
        Vec::with_capacity(delegates.len());

    // Reserve every delegate that will run before spawning any of them, so the
    // run's lifecycle count reaches zero only when the last one finishes, not
    // whenever the delegates holding permits drain ahead of the queued ones.
    let slots: Vec<(DelegateSpec, FanoutSlot)> = delegates
        .into_iter()
        .map(|spec| {
            // Check for an existing checkpoint — skip the model call if found.
            let saved = checkpoint_key
                .as_deref()
                .and_then(|key| load_delegate_checkpoint(key, &spec.id));
            let slot = match saved {
                Some(saved) => FanoutSlot::Checkpointed(saved),
                None => FanoutSlot::Queued(DelegationRunReservation::reserve(
                    &run_id,
                    lifecycle_agent_id(&spec),
                )),
            };
            (spec, slot)
        })
        .collect();

    // `delegate.*` runs under the caller's sub-agent Box scope (a task-local),
    // which `tokio::spawn` below does not inherit. Carry it into each delegate so
    // its machine verbs run on its own child Box.
    let box_scope = crate::sidecar::mcp::box_desktop::current_subagent_scope();
    for (spec, slot) in slots {
        let reservation = match slot {
            FanoutSlot::Checkpointed(saved) => {
                // Emit the progress events so callers see the delegate as
                // started-and-finished even on resume.
                if let Some(tx) = &progress {
                    let _ = tx.send(DelegateProgress::Started {
                        id: saved.id.clone(),
                        preset: saved.preset,
                    });
                    let _ = tx.send(DelegateProgress::Finished {
                        result: saved.clone(),
                    });
                }
                // Push a handle that resolves immediately with the saved result.
                let id = saved.id.clone();
                let handle = tokio::spawn(async move { saved });
                handles.push((id, handle));
                continue;
            }
            FanoutSlot::Queued(reservation) => reservation,
        };

        let semaphore = Arc::clone(&semaphore);
        let caps = Arc::clone(&caps);
        let progress = progress.clone();
        let checkpoint_key = checkpoint_key.clone();
        let box_scope = box_scope.clone();

        let id = spec.id.clone();
        let delegate = async move {
            // The permit gates how many delegates run at once; acquiring it is
            // the moment a delegate "starts".
            let _permit = semaphore
                .acquire_owned()
                .await
                .expect("delegation semaphore closed");

            if let Some(tx) = &progress {
                let _ = tx.send(DelegateProgress::Started {
                    id: spec.id.clone(),
                    preset: spec.preset,
                });
            }

            let mut lifecycle_lease = reservation.admit();

            let result = crate::sidecar::mcp::box_desktop::with_subagent_scope(
                box_scope,
                run_one(&spec, &caps, execution_policy),
            )
            .await;
            lifecycle_lease.finish();

            // SubagentStop hooks (Claude parity): fire detached when a delegated
            // sub-agent finishes, observation-only. Fires for every delegation
            // path (workflow steps, teams, host.runAgent) since all funnel here.
            fire_subagent_stop_hooks(&spec, &result);

            // Persist the result before emitting the Finished event so a
            // restart between the save and the event still recovers correctly.
            // Only successes are durable: a failed delegate (a rate or usage
            // limit, a wall-time cap, a crashed agent) runs again when the
            // fan-out is resumed instead of replaying its failure forever.
            if let Some(ref key) = checkpoint_key {
                if result.error.is_none() {
                    save_delegate_checkpoint(key, &result);
                }
            }

            if let Some(tx) = &progress {
                let _ = tx.send(DelegateProgress::Finished {
                    result: result.clone(),
                });
            }
            result
        };
        // Each delegate is a sub-turn of the caller's turn: keep its attribution.
        let attribution = crate::profile_activity::current_attribution();
        let handle = tokio::spawn(crate::profile_activity::with_attribution(
            attribution,
            delegate,
        ));
        handles.push((id, handle));
    }

    let mut results = Vec::with_capacity(handles.len());
    for (_, handle) in handles {
        match handle.await {
            Ok(r) => results.push(r),
            Err(join_err) => results.push(DelegateResult::failed(
                "unknown".to_string(),
                PermissionPreset::default(),
                format!("delegate task panicked: {join_err}"),
            )),
        }
    }
    Ok(results)
}

/// A fan-out delegate either replays its checkpointed result or is queued to
/// run, holding its place in the run's lifecycle count until it finishes.
enum FanoutSlot {
    Checkpointed(DelegateResult),
    Queued(DelegationRunReservation),
}

/// The agent id a delegate reports on lifecycle transitions.
fn lifecycle_agent_id(spec: &DelegateSpec) -> &str {
    spec.agent_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .unwrap_or(&spec.id)
}

/// Fire `subagent_stop` hooks (Claude's SubagentStop) DETACHED when a delegate
/// finishes. Observation-only; never blocks the delegation. `ctx.output` carries
/// the sub-agent's final text, `ctx.event` its id/agent/error. Directives ignored.
/// The global dispatcher's own DB-free fast path skips instantly when no
/// `subagent_stop` plugin is loaded.
fn fire_subagent_stop_hooks(spec: &DelegateSpec, result: &DelegateResult) {
    let ctx = crate::plugin_host::HookContext {
        conversation_id: result.child_conversation_id.clone(),
        agent_id: spec.agent_id.clone(),
        output: result.output.clone(),
        event: Some(serde_json::json!({
            "id": result.id,
            "agent_id": spec.agent_id,
            "error": result.error,
            "ok": result.error.is_none(),
        })),
        ..Default::default()
    };
    let attribution = crate::profile_activity::current_attribution();
    tokio::spawn(crate::profile_activity::with_attribution(
        attribution,
        async move {
            let _ = crate::plugin_host::dispatch_global(crate::plugin_host::ON_SUBAGENT_STOP, ctx)
                .await;
        },
    ));
}

/// Execute a single delegate with a clean context under its wall-time cap.
async fn run_one(
    spec: &DelegateSpec,
    caps: &DelegationCaps,
    execution_policy: DelegationExecutionPolicy,
) -> DelegateResult {
    let wall_time = Duration::from_secs(caps.wall_time_secs.max(1));
    let fut = call_sub_agent(spec, caps.max_tokens, execution_policy);

    match tokio::time::timeout(wall_time, fut).await {
        Ok(Ok(call)) => DelegateResult::ok(spec.id.clone(), spec.preset, call.text)
            .with_child_conversation_id(call.child_conversation_id),
        Ok(Err(e)) => DelegateResult::failed(spec.id.clone(), spec.preset, e.message)
            .with_child_conversation_id(e.child_conversation_id),
        Err(_) => DelegateResult::failed(
            spec.id.clone(),
            spec.preset,
            format!("wall-time limit of {}s exceeded", caps.wall_time_secs),
        ),
    }
}

/// Call the sub-agent with a clean context (task prompt only) and the preset's
/// capability hints. Routes through the Gateway (`gateway_url()`/`gateway_token()`)
/// so every delegate model call passes through the Gateway firewall, DLP, budget,
/// and audit pipeline — never direct to a provider.
///
/// Fail-closed: if the gateway URL resolves to the default and is unreachable,
/// the call returns an error (matching the hard constraint for `via_gateway=true`).
/// Set `RYU_ALLOW_GATEWAY_FALLBACK=1` to opt in to provider-direct fallback.
struct SubAgentCall {
    text: String,
    child_conversation_id: Option<String>,
}

struct SubAgentError {
    message: String,
    child_conversation_id: Option<String>,
}

impl SubAgentError {
    fn new(message: String) -> Self {
        Self {
            message,
            child_conversation_id: None,
        }
    }

    fn with_child(message: String, child_conversation_id: String) -> Self {
        Self {
            message,
            child_conversation_id: Some(child_conversation_id),
        }
    }
}

fn should_use_registered_agent(
    spec: &DelegateSpec,
    execution_policy: DelegationExecutionPolicy,
) -> bool {
    matches!(execution_policy, DelegationExecutionPolicy::Normal)
        && spec.inline.is_none()
        && spec.preset.allows_mutation()
        && spec.agent_id.as_deref().is_some_and(|id| !id.is_empty())
}

/// Ends a registered-agent delegate's one-shot conversation when the call
/// returns. The pooled ACP instance behind `delegate-<uuid>` would otherwise
/// idle out with a resident agent process for the whole idle timeout, although
/// nothing will send it another turn. A call dropped by the wall-time limit
/// also cancels its in-flight turn, so a subagent whose result was already
/// discarded stops working instead of finishing in the background.
struct DelegateConversationGuard {
    conversation_id: String,
    finished: bool,
}

impl Drop for DelegateConversationGuard {
    fn drop(&mut self) {
        if !self.finished {
            crate::sidecar::adapters::acp::request_cancel(&self.conversation_id);
        }
        crate::sidecar::adapters::acp::close_conversation_instances(&self.conversation_id);
        // The delegate is done: park its child Box and free its sub-agent
        // number, so later delegates neither share one number nor keep
        // finished children's Boxes registered.
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let conversation_id = self.conversation_id.clone();
            handle.spawn(async move {
                crate::sidecar::mcp::box_desktop::release_child_conversation(&conversation_id)
                    .await;
            });
        }
    }
}

async fn call_sub_agent(
    spec: &DelegateSpec,
    max_tokens: u32,
    execution_policy: DelegationExecutionPolicy,
) -> Result<SubAgentCall, SubAgentError> {
    // Only an explicitly mutation-capable delegate may enter a registered agent's
    // full tool loop. Research/read/summarise presets use the clean completion path
    // below, so their read-only promise cannot be bypassed by naming a powerful
    // registered agent.
    //
    // An **inline** ephemeral definition always takes the clean-context Gateway
    // path below, regardless of any `agent_id` also present. This keeps precedence
    // identical across every entry point (the `delegate.fanout` tool, the workflow
    // `AgentDelegate` node, and the raw `/api/delegate/stream` API) and independent
    // of whether a runner happens to be live: `inline` set ⇒ inline runs, period.
    if should_use_registered_agent(spec, execution_policy) {
        if let Some(id) = spec.agent_id.as_deref().filter(|s| !s.is_empty()) {
            if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
                let conversation_id = format!("delegate-{}", uuid::Uuid::new_v4().simple());
                crate::sidecar::mcp::box_desktop::bind_child_conversation(&conversation_id);
                let mut guard = DelegateConversationGuard {
                    conversation_id: conversation_id.clone(),
                    finished: false,
                };
                let text = runner
                    .run_with_max_tokens(
                        Some(id.to_string()),
                        conversation_id.clone(),
                        spec.task.clone(),
                        max_tokens,
                    )
                    .await;
                guard.finished = true;
                let text = text.map_err(|e| {
                    SubAgentError::with_child(
                        format!("delegate '{id}' failed: {e}"),
                        conversation_id.clone(),
                    )
                })?;
                return Ok(SubAgentCall {
                    text,
                    child_conversation_id: Some(conversation_id),
                });
            }
        }
    }

    let gw_url = crate::sidecar::gateway::gateway_url();
    let gw_token = crate::sidecar::gateway::gateway_inference_token();

    // Model + clean-context system message. An inline ephemeral agent definition
    // (an LLM-authored "dynamic subagent" with no registered `agent_id`) overrides
    // the preset-derived model and system prompt; otherwise the preset supplies
    // both. Either way this is a single clean-context completion routed through the
    // Gateway — no parent conversation history is ever included.
    let env_model = || {
        std::env::var("RYU_DEFAULT_LLM_MODEL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "gpt-4o-mini".to_string())
    };
    let (model, system) = match spec.inline.as_ref() {
        Some(inline) => {
            let model = inline
                .model
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(env_model);
            let advertised = if inline.tools.is_empty() {
                "none".to_string()
            } else {
                inline.tools.join(", ")
            };
            let system = format!(
                "{}\n\nYou are a Ryu sub-agent running in a clean context: you have no \
                 access to the parent agent's conversation history — work only from the \
                 task below. Advertised tools: {}.",
                inline.system_prompt.trim(),
                advertised,
            );
            (model, system)
        }
        None => {
            let system = format!(
                "You are a Ryu sub-agent running under the '{:?}' permission preset. \
                 Allowed tools: {}. You have no access to the parent agent's conversation \
                 history; work only from the task below.",
                spec.preset,
                spec.preset.allowed_tools().join(", "),
            );
            (env_model(), system)
        }
    };

    let payload = serde_json::json!({
        "model": model,
        "stream": false,
        "max_tokens": max_tokens,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": spec.task },
        ],
    });

    let client = crate::sidecar::gateway::gateway_http_client();
    let endpoint = format!("{}/v1/chat/completions", gw_url.trim_end_matches('/'));
    let mut builder = crate::sidecar::gateway::with_side_call_headers(
        client.post(&endpoint).json(&payload),
        &crate::sidecar::gateway::SidePurpose::Delegate,
    );
    if let Some(token) = gw_token.as_deref() {
        builder = builder.bearer_auth(token);
    }

    let result = builder.send().await;

    match result {
        Err(e) => {
            // Gateway unreachable — fail-closed unless fallback is opted in.
            let allow_fallback = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK")
                .map(|v| v == "1")
                .unwrap_or(false);
            if allow_fallback {
                // Opt-in: fall back to direct provider POST using the legacy env vars.
                call_sub_agent_direct(spec, max_tokens, &payload)
                    .await
                    .map(|text| SubAgentCall {
                        text,
                        child_conversation_id: None,
                    })
                    .map_err(SubAgentError::new)
            } else {
                Err(SubAgentError::new(format!(
                    "sub-agent: fail-closed — gateway unreachable at {gw_url} \
                     and RYU_ALLOW_GATEWAY_FALLBACK is not set: {e}"
                )))
            }
        }
        Ok(resp) => {
            if !resp.status().is_success() {
                let status = resp.status();
                let retry_after = resp
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                let body = resp.text().await.unwrap_or_default();
                return Err(SubAgentError::new(super::limits::gateway_error_message(
                    "sub-agent",
                    status,
                    retry_after.as_deref(),
                    &body,
                )));
            }
            let body: serde_json::Value = resp.json().await.map_err(|e| {
                SubAgentError::new(format!("sub-agent: invalid gateway response: {e}"))
            })?;
            crate::sidecar::gateway::log_side_usage(
                &crate::sidecar::gateway::SidePurpose::Delegate,
                &model,
                &body,
            );
            Ok(SubAgentCall {
                text: extract_completion_text(&body),
                child_conversation_id: None,
            })
        }
    }
}

/// Opt-in direct-provider fallback for `call_sub_agent` (only used when
/// `RYU_ALLOW_GATEWAY_FALLBACK=1`). Mirrors the legacy env-var approach so
/// test helpers that point at a blackhole can still exercise wall-time caps.
async fn call_sub_agent_direct(
    spec: &DelegateSpec,
    _max_tokens: u32,
    payload: &serde_json::Value,
) -> Result<String, String> {
    let base_url = std::env::var("RYU_DEFAULT_LLM_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.openai.com".to_string());
    let api_key = std::env::var("RYU_DEFAULT_LLM_API_KEY")
        .ok()
        .or_else(|| std::env::var("OPENAI_API_KEY").ok())
        .filter(|s| !s.is_empty());

    let client = reqwest::Client::new();
    let endpoint = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));
    let mut builder = client.post(&endpoint).json(payload);
    if let Some(key) = api_key.as_deref() {
        builder = builder.bearer_auth(key);
    }

    let resp = builder
        .send()
        .await
        .map_err(|e| format!("sub-agent (direct): provider unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "sub-agent (direct): provider returned HTTP {}",
            resp.status()
        ));
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("sub-agent (direct): invalid response: {e}"))?;
    let _ = spec; // suppress unused warning
    Ok(extract_completion_text(&body))
}

/// Extract the assistant content text from an OpenAI-compatible completion response.
fn extract_completion_text(body: &serde_json::Value) -> String {
    body.get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_map_to_capabilities() {
        assert!(PermissionPreset::Summarise.allowed_tools().is_empty());
        assert!(!PermissionPreset::CodeRead.allows_mutation());
        assert!(PermissionPreset::CodeWrite.allows_mutation());
        assert!(PermissionPreset::Research
            .allowed_tools()
            .contains(&"web_search"));
        // code_read must never grant a write capability.
        assert!(!PermissionPreset::CodeRead
            .allowed_tools()
            .contains(&"write_file"));
    }

    #[test]
    fn catalog_read_only_execution_skips_write_capable_registered_agent() {
        let spec = DelegateSpec {
            id: "catalog-review".into(),
            task: "review the listing".into(),
            agent_id: Some("write-capable-agent".into()),
            preset: PermissionPreset::CodeRead,
            inline: None,
        };

        assert!(!should_use_registered_agent(
            &spec,
            DelegationExecutionPolicy::ReadOnly
        ));
        assert!(!should_use_registered_agent(
            &spec,
            DelegationExecutionPolicy::Normal
        ));
    }

    #[test]
    fn caps_clamp_concurrency() {
        let caps = DelegationCaps {
            max_concurrent: 99,
            ..Default::default()
        };
        assert_eq!(caps.effective_concurrency(), MAX_CONCURRENT_DELEGATES);

        let zero = DelegationCaps {
            max_concurrent: 0,
            ..Default::default()
        };
        assert_eq!(zero.effective_concurrency(), 1);
    }

    #[test]
    fn caps_clamp_token_budget() {
        let caps = DelegationCaps {
            max_tokens: u32::MAX,
            ..Default::default()
        };
        assert_eq!(caps.effective_max_tokens(), MAX_DELEGATION_TOKENS);

        let caps = DelegationCaps {
            max_tokens: 0,
            ..Default::default()
        };
        assert_eq!(caps.effective_max_tokens(), 1);
    }

    #[test]
    fn lifecycle_transition_is_narrow_and_monotonic() {
        let first = next_lifecycle_transition_id();
        let second = next_lifecycle_transition_id();
        assert!(second > first);
        let transition = DelegationLifecycleTransition {
            run_id: "run-1".into(),
            agent_id: "agent-a".into(),
            active_count: 0,
            transition_id: second,
            run_active_count: 0,
        };
        let value = serde_json::to_value(transition).expect("transition serialises");
        assert_eq!(
            value,
            serde_json::json!({
                "run_id": "run-1",
                "agent_id": "agent-a",
                "active_count": 0,
                "transition_id": second,
                "run_active_count": 0,
            })
        );
        assert_eq!(value.as_object().expect("object").len(), 5);
    }

    #[test]
    fn read_only_presets_never_enter_a_registered_agent_tool_loop() {
        let mut spec = DelegateSpec {
            id: "review".into(),
            task: "inspect".into(),
            agent_id: Some("configured-agent".into()),
            preset: PermissionPreset::CodeRead,
            inline: None,
        };
        assert!(!should_use_registered_agent(
            &spec,
            DelegationExecutionPolicy::Normal
        ));
        spec.preset = PermissionPreset::Summarise;
        assert!(!should_use_registered_agent(
            &spec,
            DelegationExecutionPolicy::Normal
        ));
        spec.preset = PermissionPreset::CodeWrite;
        assert!(should_use_registered_agent(
            &spec,
            DelegationExecutionPolicy::Normal
        ));
    }

    #[test]
    fn lifecycle_registry_tracks_overlapping_runs() {
        let mut first = DelegationRunReservation::reserve("run-a", "agent-a").admit();
        assert_eq!(active_by_run().lock().unwrap().get("run-a"), Some(&1));
        let mut second = DelegationRunReservation::reserve("run-b", "agent-b").admit();
        assert_eq!(active_by_run().lock().unwrap().get("run-a"), Some(&1));
        assert_eq!(active_by_run().lock().unwrap().get("run-b"), Some(&1));
        first.finish();
        assert!(!active_by_run().lock().unwrap().contains_key("run-a"));
        assert_eq!(active_by_run().lock().unwrap().get("run-b"), Some(&1));
        second.finish();
        assert!(!active_by_run().lock().unwrap().contains_key("run-b"));
    }

    #[test]
    fn queued_delegates_keep_their_run_active_until_the_last_finishes() {
        // Three delegates at concurrency 1: each is reserved at fan-out, then
        // admitted and finished one at a time. The run only drains on the last.
        let run = "run-queued-serial";
        let count = || active_by_run().lock().unwrap().get(run).copied();
        let mut queued: Vec<_> = ["a", "b", "c"]
            .into_iter()
            .map(|agent| DelegationRunReservation::reserve(run, agent))
            .collect();
        assert_eq!(count(), Some(3));
        let mut remaining = 3;
        while !queued.is_empty() {
            let mut lease = queued.remove(0).admit();
            assert_eq!(count(), Some(remaining));
            lease.finish();
            remaining -= 1;
            if remaining > 0 {
                assert_eq!(count(), Some(remaining));
            }
        }
        assert_eq!(count(), None);
    }

    #[test]
    fn an_unadmitted_reservation_still_leaves_its_run() {
        let run = "run-queued-dropped";
        let mut admitted = DelegationRunReservation::reserve(run, "a").admit();
        let never_admitted = DelegationRunReservation::reserve(run, "b");
        admitted.finish();
        assert_eq!(active_by_run().lock().unwrap().get(run), Some(&1));
        drop(never_admitted);
        assert!(!active_by_run().lock().unwrap().contains_key(run));
    }

    #[tokio::test]
    async fn rejects_excess_depth() {
        let specs = vec![DelegateSpec {
            id: "d1".into(),
            task: "x".into(),
            agent_id: None,
            preset: PermissionPreset::Summarise,
            inline: None,
        }];
        let err = run_fanout(
            specs,
            DelegationCaps::default(),
            MAX_DELEGATION_DEPTH + 1,
            None,
        )
        .await
        .expect_err("over-depth must be rejected");
        assert!(matches!(err, DelegationError::DepthExceeded { .. }));
    }

    #[tokio::test]
    async fn rejects_empty_fanout() {
        let err = run_fanout(vec![], DelegationCaps::default(), 1, None)
            .await
            .expect_err("empty fan-out must be rejected");
        assert!(matches!(err, DelegationError::Empty));
    }

    #[tokio::test]
    async fn wall_time_cap_is_enforced() {
        // Point gateway at an unroutable address so the request hangs, then
        // assert the wall-time cap fires fast and yields a cap-violation error.
        // RYU_GATEWAY_URL is the gateway URL; fallback is disabled by default.
        // Process-global var shared with other modules' tests: hold the gateway-env
        // lock across the body and restore on exit.
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
        unsafe {
            std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
        }

        let spec = DelegateSpec {
            id: "slow".into(),
            task: "hang".into(),
            agent_id: None,
            preset: PermissionPreset::Summarise,
            inline: None,
        };
        let caps = DelegationCaps {
            wall_time_secs: 1,
            ..Default::default()
        };
        let results = run_fanout(vec![spec], caps, 1, None)
            .await
            .expect("fan-out runs");
        assert_eq!(results.len(), 1);
        assert!(results[0].error.is_some());

        unsafe {
            match prev_url {
                Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
                None => std::env::remove_var("RYU_GATEWAY_URL"),
            }
        }
    }

    #[tokio::test]
    async fn fanout_preserves_order_and_streams_progress() {
        // Three summarise delegates against an unreachable gateway: each fails
        // fast but ordering and progress events must still hold.
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
        unsafe {
            std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
        }

        let specs: Vec<DelegateSpec> = (0..3)
            .map(|i| DelegateSpec {
                id: format!("d{i}"),
                task: format!("task {i}"),
                agent_id: None,
                preset: PermissionPreset::Summarise,
                inline: None,
            })
            .collect();

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let caps = DelegationCaps {
            wall_time_secs: 2,
            ..Default::default()
        };
        let results = run_fanout(specs, caps, 1, Some(tx))
            .await
            .expect("fan-out runs");

        assert_eq!(results.len(), 3);
        for (i, r) in results.iter().enumerate() {
            assert_eq!(r.id, format!("d{i}"));
        }

        let mut started = 0;
        let mut finished = 0;
        while let Ok(ev) = rx.try_recv() {
            match ev {
                DelegateProgress::Started { .. } => started += 1,
                DelegateProgress::Finished { .. } => finished += 1,
            }
        }
        assert_eq!(started, 3);
        assert_eq!(finished, 3);

        unsafe {
            match prev_url {
                Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
                None => std::env::remove_var("RYU_GATEWAY_URL"),
            }
        }
    }

    /// Verify that a fan-out with a checkpoint key skips already-completed
    /// delegates on resume and preserves input-order results with sentinel output.
    #[tokio::test]
    async fn durable_fanout_skips_completed_delegates_on_resume() {
        // Point gateway at blackhole so any live call fails fast.
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
        unsafe {
            std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
        }

        let key = Arc::new(FanoutCheckpointKey {
            run_id: format!("test-run-{}", uuid::Uuid::new_v4().simple()),
            node_id: "delegate-node".to_string(),
        });

        // Pre-seed: checkpoint d0 as completed with a sentinel; d1 is pending.
        let sentinel = DelegateResult::ok(
            "d0".to_string(),
            PermissionPreset::Summarise,
            "__SENTINEL_D0__".to_string(),
        );
        save_delegate_checkpoint(&key, &sentinel);

        let specs: Vec<DelegateSpec> = vec![
            DelegateSpec {
                id: "d0".into(),
                task: "should be skipped".into(),
                agent_id: None,
                preset: PermissionPreset::Summarise,
                inline: None,
            },
            DelegateSpec {
                id: "d1".into(),
                task: "will fail fast (gateway unreachable)".into(),
                agent_id: None,
                preset: PermissionPreset::Summarise,
                inline: None,
            },
        ];

        let caps = DelegationCaps {
            wall_time_secs: 2,
            ..Default::default()
        };

        let results = run_fanout_with_checkpoint(specs, caps, 1, None, Some(Arc::clone(&key)))
            .await
            .expect("fan-out with checkpoint runs");

        assert_eq!(results.len(), 2);
        // d0 must carry the sentinel, proving it was resumed from checkpoint.
        assert_eq!(results[0].id, "d0");
        assert_eq!(
            results[0].output.as_deref(),
            Some("__SENTINEL_D0__"),
            "d0 must carry sentinel from checkpoint, not be re-run"
        );
        // d1 must have been attempted (and failed, since gateway is unreachable).
        assert_eq!(results[1].id, "d1");
        assert!(
            results[1].error.is_some(),
            "d1 must have failed (gateway unreachable)"
        );

        unsafe {
            match prev_url {
                Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
                None => std::env::remove_var("RYU_GATEWAY_URL"),
            }
        }
    }

    /// Verify fail-closed: when gateway is unreachable and fallback is not
    /// opted in, the delegate error message mentions the gateway.
    #[tokio::test]
    async fn fail_closed_when_gateway_unreachable() {
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
        let prev_fb = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
        unsafe {
            std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
            std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
        }

        let spec = DelegateSpec {
            id: "fc".into(),
            task: "any task".into(),
            agent_id: None,
            preset: PermissionPreset::Summarise,
            inline: None,
        };
        let caps = DelegationCaps {
            wall_time_secs: 3,
            ..Default::default()
        };
        let results = run_fanout(vec![spec], caps, 1, None)
            .await
            .expect("fan-out itself doesn't error");
        assert_eq!(results.len(), 1);
        let err = results[0].error.as_deref().unwrap_or("");
        assert!(
            err.contains("gateway") || err.contains("wall-time"),
            "expected gateway or wall-time error, got: {err}"
        );

        unsafe {
            match prev_url {
                Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
                None => std::env::remove_var("RYU_GATEWAY_URL"),
            }
            match prev_fb {
                Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
                None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
            }
        }
    }

    #[tokio::test]
    async fn inline_delegate_takes_clean_context_gateway_path() {
        // An inline ephemeral sub-agent (no registered agent_id) must run through
        // the Gateway completion path — proven here by the fail-closed error when
        // the gateway is unreachable. This exercises the inline branch of
        // `call_sub_agent` end-to-end without a live gateway.
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
        let prev_fb = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
        unsafe {
            std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
            std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
        }

        let spec = DelegateSpec {
            id: "inline0".into(),
            task: "classify this ticket".into(),
            agent_id: None,
            preset: PermissionPreset::default(),
            inline: Some(InlineAgentDef {
                system_prompt: "You are a terse ticket triager. Reply with one label.".into(),
                model: Some("gpt-4o-mini".into()),
                tools: vec!["read_memory".into()],
            }),
        };
        let caps = DelegationCaps {
            wall_time_secs: 3,
            ..Default::default()
        };
        let results = run_fanout(vec![spec], caps, 1, None)
            .await
            .expect("fan-out itself doesn't error");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "inline0");
        let err = results[0].error.as_deref().unwrap_or("");
        assert!(
            err.contains("gateway") || err.contains("wall-time"),
            "inline delegate must go through the gateway path (fail-closed), got: {err}"
        );

        unsafe {
            match prev_url {
                Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
                None => std::env::remove_var("RYU_GATEWAY_URL"),
            }
            match prev_fb {
                Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
                None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
            }
        }
    }

    #[tokio::test]
    async fn inline_takes_precedence_over_agent_id() {
        // A spec that carries BOTH an agent_id and an inline def must take the
        // inline clean-context Gateway path uniformly (never the registered-agent
        // path), so behavior does not depend on whether a runner is live. With an
        // unreachable gateway this surfaces as the fail-closed gateway error.
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
        let prev_fb = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
        unsafe {
            std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
            std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
        }
        let spec = DelegateSpec {
            id: "both".into(),
            task: "do the thing".into(),
            agent_id: Some("ryu".into()),
            preset: PermissionPreset::default(),
            inline: Some(InlineAgentDef {
                system_prompt: "You are an inline specialist.".into(),
                model: None,
                tools: vec![],
            }),
        };
        let results = run_fanout(
            vec![spec],
            DelegationCaps {
                wall_time_secs: 3,
                ..Default::default()
            },
            1,
            None,
        )
        .await
        .expect("fan-out runs");
        assert_eq!(results.len(), 1);
        let err = results[0].error.as_deref().unwrap_or("");
        assert!(
            err.contains("gateway") || err.contains("wall-time"),
            "inline+agent_id must take the inline gateway path, got: {err}"
        );
        unsafe {
            match prev_url {
                Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
                None => std::env::remove_var("RYU_GATEWAY_URL"),
            }
            match prev_fb {
                Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
                None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
            }
        }
    }

    #[test]
    fn inline_agent_def_survives_json_round_trip() {
        // The inline field must (de)serialize so workflow-authored `AgentDelegate`
        // nodes and the `delegate.fanout` tool can carry inline sub-agents.
        let spec = DelegateSpec {
            id: "d0".into(),
            task: "t".into(),
            agent_id: None,
            preset: PermissionPreset::default(),
            inline: Some(InlineAgentDef {
                system_prompt: "be brief".into(),
                model: None,
                tools: vec!["web_search".into(), "web_fetch".into()],
            }),
        };
        let json = serde_json::to_string(&spec).expect("serialize");
        let back: DelegateSpec = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(spec, back);
        // A spec without inline omits the field and still parses (back-compat).
        let legacy: DelegateSpec =
            serde_json::from_str(r#"{"id":"d1","task":"t"}"#).expect("legacy parse");
        assert!(legacy.inline.is_none());
        assert!(legacy.agent_id.is_none());
    }

    #[test]
    fn safe_segment_accepts_valid_identifiers() {
        assert!(safe_segment("abc123").is_ok());
        assert!(safe_segment("run-id_01").is_ok());
        assert!(safe_segment("A-Z_0-9").is_ok());
        assert!(safe_segment(&"x".repeat(128)).is_ok());
    }

    #[test]
    fn safe_segment_rejects_path_traversal() {
        assert!(safe_segment("../etc/passwd").is_err());
        assert!(safe_segment("../../secret").is_err());
        assert!(safe_segment("foo/bar").is_err());
        assert!(safe_segment("foo\\bar").is_err());
        assert!(safe_segment("foo\0bar").is_err());
        assert!(safe_segment(".hidden").is_err());
        assert!(safe_segment("").is_err());
        assert!(safe_segment(&"x".repeat(129)).is_err());
    }

    #[test]
    fn checkpoint_dir_rejects_traversal_in_run_id() {
        let key = FanoutCheckpointKey {
            run_id: "../evil".to_string(),
            node_id: "node-1".to_string(),
        };
        assert!(
            checkpoint_dir(&key).is_err(),
            "traversal in run_id must be rejected"
        );
    }

    #[test]
    fn checkpoint_dir_rejects_traversal_in_node_id() {
        let key = FanoutCheckpointKey {
            run_id: "run-1".to_string(),
            node_id: "../../etc".to_string(),
        };
        assert!(
            checkpoint_dir(&key).is_err(),
            "traversal in node_id must be rejected"
        );
    }

    #[test]
    fn fanout_checkpoints_are_sealed_and_bound_to_their_place() {
        let run_id = format!("run{}", uuid::Uuid::new_v4().simple());
        let key = FanoutCheckpointKey {
            run_id: run_id.clone(),
            node_id: "node-1".to_string(),
        };
        let marker = format!("delegatemarker{}", uuid::Uuid::new_v4().simple());
        let result = DelegateResult::ok("d0".into(), PermissionPreset::default(), marker.clone());
        save_delegate_checkpoint(&key, &result);
        let dir = checkpoint_dir(&key).unwrap();
        let raw = std::fs::read_to_string(dir.join("d0.json")).unwrap();
        assert!(raw.starts_with("encb:v1:"));
        assert!(!raw.contains(&marker));
        assert_eq!(
            load_delegate_checkpoint(&key, "d0").and_then(|r| r.output),
            Some(marker.clone())
        );
        // Copied to another delegate: does not open, so that delegate reruns.
        std::fs::copy(dir.join("d0.json"), dir.join("d1.json")).unwrap();
        assert!(load_delegate_checkpoint(&key, "d1").is_none());
        // A legacy plaintext checkpoint still reads.
        std::fs::write(
            dir.join("d2.json"),
            serde_json::to_vec(&DelegateResult::ok(
                "d2".into(),
                PermissionPreset::default(),
                "legacy".into(),
            ))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            load_delegate_checkpoint(&key, "d2").and_then(|r| r.output),
            Some("legacy".to_owned())
        );
        let _ = std::fs::remove_dir_all(checkpoint_root().join(run_id));
    }

    #[test]
    fn boot_pass_seals_legacy_checkpoints_and_drops_finished_runs() {
        use super::super::store::RunStatus;
        let root = tempfile::tempdir().unwrap();
        let marker = format!("legacyoutput{}", uuid::Uuid::new_v4().simple());
        let legacy = |run: &str, delegate: &str| {
            let dir = root.path().join(run).join("node-1");
            std::fs::create_dir_all(&dir).unwrap();
            let body = serde_json::to_vec(&DelegateResult::ok(
                delegate.into(),
                PermissionPreset::default(),
                marker.clone(),
            ))
            .unwrap();
            std::fs::write(dir.join(format!("{delegate}.json")), &body).unwrap();
            // A crashed write's leftover copy.
            std::fs::write(dir.join(format!("{delegate}.json.tmp")), &body).unwrap();
            dir
        };
        let live = legacy("runlive", "d0");
        let finished = legacy("rundone", "d0");
        let status = |run: &str| match run {
            "rundone" => Some(RunStatus::Completed),
            _ => Some(RunStatus::AwaitingInput),
        };
        // Fresh temps may belong to a write in flight: age them past the gate.
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        std::fs::File::options()
            .write(true)
            .open(live.join("d0.json.tmp"))
            .unwrap()
            .set_modified(old)
            .unwrap();

        // Sealed d0, removed temp, removed finished run.
        assert_eq!(reseal_fanout_checkpoints_in(root.path(), status), 3);
        assert!(
            !finished.exists(),
            "a completed run's checkpoints are dead state"
        );
        assert!(!live.join("d0.json.tmp").exists());
        let raw = std::fs::read_to_string(live.join("d0.json")).unwrap();
        assert!(raw.starts_with("encb:v1:"));
        assert!(!raw.contains(&marker));
        let key = FanoutCheckpointKey {
            run_id: "runlive".into(),
            node_id: "node-1".into(),
        };
        let stored = std::fs::read(live.join("d0.json")).unwrap();
        let opened: DelegateResult =
            serde_json::from_slice(&decode_checkpoint(&key, "d0", &stored).unwrap()).unwrap();
        assert_eq!(opened.output, Some(marker.clone()));
        // Run twice: nothing left to do.
        assert_eq!(reseal_fanout_checkpoints_in(root.path(), status), 0);
        assert_eq!(std::fs::read(live.join("d0.json")).unwrap(), stored);
    }
}
