//! File-backed persistence for workflow definitions and runs.
//!
//! Definitions live under `~/.ryu/workflows/<id>.json`. Run state lives under
//! `~/.ryu/workflow-runs/<run_id>.json` and is rewritten after every node so a
//! run is resumable: on resume we skip nodes already marked `Completed`.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::Workflow;

fn ryu_dir() -> PathBuf {
    crate::paths::ryu_dir()
}

fn workflows_dir() -> PathBuf {
    ryu_dir().join("workflows")
}

fn runs_dir() -> PathBuf {
    ryu_dir().join("workflow-runs")
}

/// Per-node execution status within a run.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Skipped,
}

/// Overall status of a workflow run.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Completed,
    Failed,
    /// The run is suspended at a durable `Awakeable` gate, waiting for an
    /// external resume call. The gate node id is recorded in
    /// [`WorkflowRun::awaiting_node`]. Re-invoke [`run_workflow`] with the
    /// same `run_id` after setting the gate node to `Completed` to continue.
    AwaitingInput,
}

/// Persisted state of a single node within a run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeRunState {
    pub status: NodeStatus,
    /// The value produced by the node (string-serialized).
    #[serde(default)]
    pub output: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// Number of execution attempts made so far (including the initial run),
    /// incremented before each attempt by the retry loop. Persisted so a
    /// Temporal-style retry budget (`RetryPolicy.max_attempts`) is honoured
    /// across a Core restart: the count is total, not per-process. Defaults to 0
    /// for backward compatibility with run JSON written before retries existed.
    #[serde(default)]
    pub attempts: u32,
    /// Durable timer wake-up instant (RFC3339, UTC) for a `Delay` node. Written
    /// when the delay is first reached and checkpointed before sleeping, so a
    /// crash mid-sleep resumes with only the *remaining* time rather than
    /// restarting the full delay (Restate/Temporal durable-timer parity).
    /// `None` for every non-delay node and for runs written before this existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_at: Option<String>,
}

/// Persisted, resumable state of a workflow run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowRun {
    pub run_id: String,
    pub workflow_id: String,
    pub status: RunStatus,
    /// Initial run input map (key → value).
    #[serde(default)]
    pub input: HashMap<String, String>,
    /// Final/partial output map populated by `Output` nodes.
    #[serde(default)]
    pub output: HashMap<String, String>,
    /// Per-node state keyed by node id.
    #[serde(default)]
    pub nodes: HashMap<String, NodeRunState>,
    /// Free-form run state (key → string value). Written by `SetState` nodes and
    /// readable by the template resolver as `{{state.<key>}}`. The reserved key
    /// `trigger` holds the JSON-encoded trigger payload when a workflow is fired
    /// by a trigger; it is surfaced as `{{trigger.<field>}}`. Everything is a
    /// string; JSON passes through verbatim.
    #[serde(default)]
    pub state: HashMap<String, String>,
    #[serde(default)]
    pub error: Option<String>,
    /// Set when `status == AwaitingInput`. Identifies the `Awakeable` gate node
    /// that suspended this run. The resume endpoint writes the caller-supplied
    /// payload as the gate's output and flips it to `Completed`, then re-runs
    /// the workflow so downstream nodes continue from there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub awaiting_node: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl WorkflowRun {
    pub fn new(run_id: String, workflow_id: String, input: HashMap<String, String>) -> Self {
        let now = now_iso();
        Self {
            run_id,
            workflow_id,
            status: RunStatus::Running,
            input,
            output: HashMap::new(),
            nodes: HashMap::new(),
            state: HashMap::new(),
            error: None,
            awaiting_node: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    /// True when a node finished successfully on a prior (or current) attempt.
    pub fn is_completed(&self, node_id: &str) -> bool {
        self.nodes
            .get(node_id)
            .map(|n| n.status == NodeStatus::Completed)
            .unwrap_or(false)
    }
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Reject ids that could escape the storage directory before they are
/// interpolated into a file path. Only the charset used for generated ids is
/// allowed (ASCII alphanumeric, `_`, `-`); this excludes path separators and
/// `.`, so `../` traversal and absolute paths are impossible.
fn validate_id(id: &str) -> std::io::Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok {
        Ok(())
    } else {
        Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("invalid id (must match [A-Za-z0-9_-], 1..=128 chars): {id:?}"),
        ))
    }
}

// ── Definition CRUD ─────────────────────────────────────────────────────────

/// Persist (create or overwrite) a workflow definition.
pub fn save_workflow(workflow: &Workflow) -> std::io::Result<()> {
    validate_id(&workflow.id)?;
    let dir = workflows_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", workflow.id));
    let json = serde_json::to_string_pretty(workflow)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

/// Load a workflow definition by id.
pub fn load_workflow(id: &str) -> std::io::Result<Workflow> {
    validate_id(id)?;
    let path = workflows_dir().join(format!("{id}.json"));
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// List all persisted workflow definitions.
pub fn list_workflows() -> Vec<Workflow> {
    let dir = workflows_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(wf) = serde_json::from_slice::<Workflow>(&bytes) {
                out.push(wf);
            }
        }
    }
    out
}

/// Delete a workflow definition by id. Returns `true` when a file was removed.
pub fn delete_workflow(id: &str) -> std::io::Result<bool> {
    validate_id(id)?;
    let path = workflows_dir().join(format!("{id}.json"));
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

// ── Run persistence ─────────────────────────────────────────────────────────

/// Persist (create or overwrite) a run's state. Called after every node (and
/// after a durable `Delay` stamps its `wake_at`) so the run is resumable from
/// disk.
///
/// The write is **atomic and durable**: the JSON is written to a per-run temp
/// file, flushed + `fsync`'d, then renamed over the destination (an atomic
/// replace on both Windows and Unix). This guarantees a crash mid-write can
/// never leave a torn/half-written run file — a reader always sees either the
/// previous complete state or the new complete state — which is what makes the
/// durable-timer / resume guarantees real rather than best-effort.
pub fn save_run(run: &WorkflowRun) -> std::io::Result<()> {
    validate_id(&run.run_id)?;
    let dir = runs_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", run.run_id));
    let json = serde_json::to_string_pretty(run)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    // Unique temp name so two concurrent saves of different runs never collide;
    // the run_id is already path-safe (validated above).
    let tmp = dir.join(format!("{}.json.tmp", run.run_id));
    {
        use std::io::Write as _;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(json.as_bytes())?;
        // Flush to the OS and force the bytes to disk before the rename so a
        // hard crash right after this returns still has the data on platter.
        f.sync_all()?;
    }
    // Atomic replace. If the rename fails, clean up the temp so it doesn't leak.
    match std::fs::rename(&tmp, &path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Load a run's state by run id.
pub fn load_run(run_id: &str) -> std::io::Result<WorkflowRun> {
    validate_id(run_id)?;
    let path = runs_dir().join(format!("{run_id}.json"));
    let bytes = std::fs::read(path)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}
