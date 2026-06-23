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
}

impl DelegateResult {
    pub fn ok(id: String, preset: PermissionPreset, output: String) -> Self {
        Self {
            id,
            preset,
            output: Some(output),
            error: None,
        }
    }

    pub fn failed(id: String, preset: PermissionPreset, error: String) -> Self {
        Self {
            id,
            preset,
            output: None,
            error: Some(error),
        }
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
    crate::paths::ryu_dir().join("fanout-checkpoints")
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
fn save_delegate_checkpoint(key: &FanoutCheckpointKey, result: &DelegateResult) {
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
    let tmp_path = dir.join(format!("{id}.json.tmp"));
    let json = match serde_json::to_vec_pretty(result) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("fanout checkpoint: serialise failed for {id}: {e}");
            return;
        }
    };

    #[cfg(unix)]
    let write_result = {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp_path)
            .and_then(|mut f| f.write_all(&json))
    };
    #[cfg(not(unix))]
    let write_result = std::fs::write(&tmp_path, &json);

    if let Err(e) = write_result {
        tracing::warn!("fanout checkpoint: write tmp failed {tmp_path:?}: {e}");
        return;
    }
    if let Err(e) = std::fs::rename(&tmp_path, &path) {
        tracing::warn!("fanout checkpoint: rename failed {tmp_path:?} -> {path:?}: {e}");
    }
}

/// Load a persisted delegate result from its checkpoint file, if it exists.
fn load_delegate_checkpoint(
    key: &FanoutCheckpointKey,
    delegate_id: &str,
) -> Option<DelegateResult> {
    let dir = checkpoint_dir(key).ok()?;
    let id = safe_segment(delegate_id).ok()?;
    let path = dir.join(format!("{id}.json"));
    let data = std::fs::read(&path).ok()?;
    serde_json::from_slice(&data).ok()
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
    run_fanout_with_checkpoint(delegates, caps, depth, progress, None).await
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
    if delegates.is_empty() {
        return Err(DelegationError::Empty);
    }
    if depth > MAX_DELEGATION_DEPTH {
        return Err(DelegationError::DepthExceeded { depth });
    }

    let semaphore = Arc::new(Semaphore::new(caps.effective_concurrency()));
    let caps = Arc::new(caps);
    let mut handles: Vec<(String, tokio::task::JoinHandle<DelegateResult>)> =
        Vec::with_capacity(delegates.len());

    for spec in delegates {
        // Check for an existing checkpoint — skip the model call if found.
        if let Some(ref key) = checkpoint_key {
            if let Some(saved) = load_delegate_checkpoint(key, &spec.id) {
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
        }

        let semaphore = Arc::clone(&semaphore);
        let caps = Arc::clone(&caps);
        let progress = progress.clone();
        let checkpoint_key = checkpoint_key.clone();

        let id = spec.id.clone();
        let handle = tokio::spawn(async move {
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

            let result = run_one(&spec, &caps).await;

            // Persist the result before emitting the Finished event so a
            // restart between the save and the event still recovers correctly.
            if let Some(ref key) = checkpoint_key {
                save_delegate_checkpoint(key, &result);
            }

            if let Some(tx) = &progress {
                let _ = tx.send(DelegateProgress::Finished {
                    result: result.clone(),
                });
            }
            result
        });
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

/// Execute a single delegate with a clean context under its wall-time cap.
async fn run_one(spec: &DelegateSpec, caps: &DelegationCaps) -> DelegateResult {
    let wall_time = Duration::from_secs(caps.wall_time_secs.max(1));
    let fut = call_sub_agent(spec, caps.max_tokens);

    match tokio::time::timeout(wall_time, fut).await {
        Ok(Ok(text)) => DelegateResult::ok(spec.id.clone(), spec.preset, text),
        Ok(Err(e)) => DelegateResult::failed(spec.id.clone(), spec.preset, e),
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
async fn call_sub_agent(spec: &DelegateSpec, max_tokens: u32) -> Result<String, String> {
    // A configured delegate agent + an available runner: invoke the real agent
    // through the chat path so its own engine binding, gateway routing, tools, and
    // system prompt govern the sub-task. The per-delegate `max_tokens` cap and the
    // synthetic preset system message do NOT apply on this path — the chosen
    // agent's own config takes over (the `run_one` wall-time timeout still bounds
    // it). The `None` path below keeps both.
    if let Some(id) = spec.agent_id.as_deref().filter(|s| !s.is_empty()) {
        if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
            let conversation_id = format!("delegate-{}", uuid::Uuid::new_v4().simple());
            return runner
                .run(Some(id.to_string()), conversation_id, spec.task.clone())
                .await
                .map_err(|e| format!("delegate '{id}' failed: {e}"));
        }
    }

    let gw_url = crate::sidecar::gateway::gateway_url();
    let gw_token = crate::sidecar::gateway::gateway_token();

    let model = std::env::var("RYU_DEFAULT_LLM_MODEL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "gpt-4o-mini".to_string());

    // Clean context: a fresh system message describing the preset, then ONLY the
    // task. No parent conversation history is ever included.
    let system = format!(
        "You are a Ryu sub-agent running under the '{:?}' permission preset. \
         Allowed tools: {}. You have no access to the parent agent's conversation \
         history; work only from the task below.",
        spec.preset,
        spec.preset.allowed_tools().join(", "),
    );

    let payload = serde_json::json!({
        "model": model,
        "stream": false,
        "max_tokens": max_tokens,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": spec.task },
        ],
    });

    let client = reqwest::Client::new();
    let endpoint = format!("{}/v1/chat/completions", gw_url.trim_end_matches('/'));
    let mut builder = client.post(&endpoint).json(&payload);
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
                call_sub_agent_direct(spec, max_tokens, &payload).await
            } else {
                Err(format!(
                    "sub-agent: fail-closed — gateway unreachable at {gw_url} \
                     and RYU_ALLOW_GATEWAY_FALLBACK is not set: {e}"
                ))
            }
        }
        Ok(resp) => {
            if !resp.status().is_success() {
                return Err(format!(
                    "sub-agent: gateway returned HTTP {}",
                    resp.status()
                ));
            }
            let body: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("sub-agent: invalid gateway response: {e}"))?;
            Ok(extract_completion_text(&body))
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

    #[tokio::test]
    async fn rejects_excess_depth() {
        let specs = vec![DelegateSpec {
            id: "d1".into(),
            task: "x".into(),
            agent_id: None,
            preset: PermissionPreset::Summarise,
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
        unsafe {
            std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
        }

        let spec = DelegateSpec {
            id: "slow".into(),
            task: "hang".into(),
            agent_id: None,
            preset: PermissionPreset::Summarise,
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
            std::env::remove_var("RYU_GATEWAY_URL");
        }
    }

    #[tokio::test]
    async fn fanout_preserves_order_and_streams_progress() {
        // Three summarise delegates against an unreachable gateway: each fails
        // fast but ordering and progress events must still hold.
        unsafe {
            std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
        }

        let specs: Vec<DelegateSpec> = (0..3)
            .map(|i| DelegateSpec {
                id: format!("d{i}"),
                task: format!("task {i}"),
                agent_id: None,
                preset: PermissionPreset::Summarise,
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
            std::env::remove_var("RYU_GATEWAY_URL");
        }
    }

    /// Verify that a fan-out with a checkpoint key skips already-completed
    /// delegates on resume and preserves input-order results with sentinel output.
    #[tokio::test]
    async fn durable_fanout_skips_completed_delegates_on_resume() {
        // Point gateway at blackhole so any live call fails fast.
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
            },
            DelegateSpec {
                id: "d1".into(),
                task: "will fail fast (gateway unreachable)".into(),
                agent_id: None,
                preset: PermissionPreset::Summarise,
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
            std::env::remove_var("RYU_GATEWAY_URL");
        }
    }

    /// Verify fail-closed: when gateway is unreachable and fallback is not
    /// opted in, the delegate error message mentions the gateway.
    #[tokio::test]
    async fn fail_closed_when_gateway_unreachable() {
        unsafe {
            std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
            std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
        }

        let spec = DelegateSpec {
            id: "fc".into(),
            task: "any task".into(),
            agent_id: None,
            preset: PermissionPreset::Summarise,
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
            std::env::remove_var("RYU_GATEWAY_URL");
        }
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
}
