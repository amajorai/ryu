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

// Split by responsibility. Each child starts with `use super::*;`, so the imports above
// and the items below reach it as they did in the single file, and the re-exports keep
// every `workflow::delegation::` path.
mod checkpoint;
mod fanout;
mod sub_agent;
#[cfg(test)]
mod tests;

pub use checkpoint::*;
pub use fanout::*;
use sub_agent::*;

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
