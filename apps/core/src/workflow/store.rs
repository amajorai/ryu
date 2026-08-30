//! File-backed persistence for workflow definitions and runs.
//!
//! Definitions live under `~/.ryu/workflows/<id>.json`. Run state lives under
//! `~/.ryu/workflow-runs/<run_id>.json` and is rewritten after every node so a
//! run is resumable: on resume we skip nodes already marked `Completed`.

use std::collections::HashMap;
use std::path::PathBuf;

use ryu_workspace::source_history::SourceHistory;
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

fn source_history() -> SourceHistory {
    SourceHistory::new(ryu_dir().join("source-history"))
}

fn source_history_path(workflow_id: &str) -> String {
    format!("workflows/{workflow_id}.json")
}

/// Record the Git audit projection without turning a successful live workflow
/// write into a reported failure. The JSON definition is authoritative and Git
/// history can be repaired after a transient disk or repository failure.
fn checkpoint_source_history_best_effort(relative_path: &str, content: &str, label: Option<&str>) {
    if let Err(error) = source_history().checkpoint(relative_path, content, label) {
        tracing::warn!(
            path = relative_path,
            error = %error,
            "workflow source-history checkpoint was not recorded"
        );
    }
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
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
    std::fs::write(path, &json)?;
    checkpoint_source_history_best_effort(
        &source_history_path(&workflow.id),
        &json,
        Some("Workflow saved"),
    );
    Ok(())
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
    let removed = match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e),
    };
    // Git history is intentionally immutable: deleting the live definition does
    // not erase its audit trail. Remove only the legacy pre-Git snapshots.
    let _ = delete_workflow_versions(id);
    Ok(removed)
}

// ── Version history (Prompt-Studio-style snapshots) ─────────────────────────
//
// Each workflow keeps an immutable history in the managed local Git repository
// under `source-history/workflows/<workflow_id>.json`. The old JSON snapshot
// directory remains readable as a migration fallback, but new versions are Git
// commits rather than a second bespoke version store.

fn versions_root() -> PathBuf {
    ryu_dir().join("workflow-versions")
}

fn workflow_versions_dir(workflow_id: &str) -> std::io::Result<PathBuf> {
    validate_id(workflow_id)?;
    Ok(versions_root().join(workflow_id))
}

/// Metadata for one saved workflow version (no embedded graph, so lists stay
/// light).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowVersionMeta {
    pub id: String,
    pub workflow_id: String,
    /// The workflow name captured at snapshot time.
    pub name: String,
    /// Optional user label for a manual snapshot (`None` for auto ones).
    pub label: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
}

/// A full saved workflow version, including the captured definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowVersion {
    pub id: String,
    pub workflow_id: String,
    pub name: String,
    pub label: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    /// The full definition captured at snapshot time.
    pub workflow: Workflow,
}

/// Snapshot a workflow definition as a new Git version and return its metadata.
/// Git history is immutable and is not pruned by the workflow store.
pub fn save_workflow_version(
    workflow: &Workflow,
    label: Option<&str>,
) -> std::io::Result<WorkflowVersionMeta> {
    let json = serde_json::to_string_pretty(workflow)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let version = source_history().checkpoint(&source_history_path(&workflow.id), &json, label)?;

    Ok(WorkflowVersionMeta {
        id: version.id,
        workflow_id: workflow.id.clone(),
        name: workflow.name.clone(),
        label: version.label,
        created_at: version.created_at,
    })
}

/// Read every version file for a workflow (full, unsorted). Corrupt files are
/// skipped rather than failing the whole read.
fn read_workflow_versions(workflow_id: &str) -> std::io::Result<Vec<WorkflowVersion>> {
    let dir = workflow_versions_dir(workflow_id)?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&path) {
            if let Ok(v) = serde_json::from_slice::<WorkflowVersion>(&bytes) {
                out.push(v);
            }
        }
    }
    Ok(out)
}

/// List a workflow's saved versions, newest first (metadata only).
pub fn list_workflow_versions(workflow_id: &str) -> std::io::Result<Vec<WorkflowVersionMeta>> {
    validate_id(workflow_id)?;
    let path = source_history_path(workflow_id);
    let history = source_history();
    let mut versions = Vec::new();
    for version in history.list(&path, None)? {
        let Some(source) = history.read(&path, &version.id)? else {
            continue;
        };
        let Ok(workflow) = serde_json::from_str::<Workflow>(&source) else {
            continue;
        };
        versions.push(WorkflowVersionMeta {
            id: version.id,
            workflow_id: workflow_id.to_owned(),
            name: workflow.name,
            label: version.label,
            created_at: version.created_at,
        });
    }
    versions.extend(
        read_workflow_versions(workflow_id)?
            .into_iter()
            .map(|version| WorkflowVersionMeta {
                id: version.id,
                workflow_id: version.workflow_id,
                name: version.name,
                label: version.label,
                created_at: version.created_at,
            }),
    );
    versions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(versions)
}

/// Load one saved version in full (including its captured definition).
pub fn load_workflow_version(
    workflow_id: &str,
    version_id: &str,
) -> std::io::Result<Option<WorkflowVersion>> {
    validate_id(workflow_id)?;
    if is_git_version_id(version_id) {
        let path = source_history_path(workflow_id);
        let history = source_history();
        if let Some(source) = history.read(&path, version_id)? {
            let workflow = serde_json::from_str::<Workflow>(&source)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            let label = history
                .list(&path, Some(1000))?
                .into_iter()
                .find(|version| version.id == version_id)
                .and_then(|version| version.label);
            return Ok(Some(WorkflowVersion {
                id: version_id.to_owned(),
                workflow_id: workflow_id.to_owned(),
                name: workflow.name.clone(),
                label,
                created_at: history
                    .list(&path, Some(1000))?
                    .into_iter()
                    .find(|version| version.id == version_id)
                    .map(|version| version.created_at)
                    .unwrap_or_else(now_millis),
                workflow,
            }));
        }
    }
    validate_id(version_id)?;
    let path = workflow_versions_dir(workflow_id)?.join(format!("{version_id}.json"));
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Delete legacy JSON snapshots for a workflow. Git source history is immutable
/// and is intentionally not removed by this compatibility operation.
pub fn delete_workflow_versions(workflow_id: &str) -> std::io::Result<bool> {
    validate_id(workflow_id)?;
    let dir = workflow_versions_dir(workflow_id)?;
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

fn is_git_version_id(version_id: &str) -> bool {
    (7..=64).contains(&version_id.len())
        && version_id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

// ── Run persistence ─────────────────────────────────────────────────────────

/// Persist (create or overwrite) a run's state. Called after every node (and
/// after a durable `Delay` stamps its `wake_at`) so the run is resumable from
/// disk.
///
/// The atomically-durable write (temp file + `fsync` + atomic rename) lives in
/// the `ryu-durable` [`FileCheckpointStore`](ryu_durable::FileCheckpointStore) —
/// the extracted durable-execution primitive — so a crash mid-write can never
/// leave a torn/half-written run file. This thin wrapper only supplies the run
/// directory and run-id key; the executor consumes the durable primitive through
/// it after every node.
pub fn save_run(run: &WorkflowRun) -> std::io::Result<()> {
    ryu_durable::FileCheckpointStore::new(runs_dir()).save(&run.run_id, run)
}

/// Load a run's state by run id.
pub fn load_run(run_id: &str) -> std::io::Result<WorkflowRun> {
    ryu_durable::FileCheckpointStore::new(runs_dir()).load(run_id)
}

/// How many runs are LIVE right now, split by why they are live.
///
/// Exists to answer one question honestly: "if this node restarts in the next
/// minute, what breaks?" That is the sentence a deferred resize or update has to
/// show before a human agrees to it, and a number nobody measured is worse than
/// no number at all — it reads as a promise that nothing will be lost.
///
/// `AwaitingInput` runs are counted SEPARATELY rather than lumped in with
/// running ones. They survive a restart by design (that is the point of a
/// durable gate), so reporting them as work-about-to-be-destroyed would overstate
/// the damage and train people to ignore the warning.
///
/// A corrupt or unreadable run file is skipped, not fatal: this is called to
/// render a warning, and failing the whole count because one file is bad would
/// turn a cosmetic problem into "we cannot tell you what you are about to lose".
pub fn live_run_counts() -> LiveRunCounts {
    let mut counts = LiveRunCounts::default();
    let Ok(entries) = std::fs::read_dir(runs_dir()) else {
        return counts;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(run) = serde_json::from_slice::<WorkflowRun>(&bytes) else {
            continue;
        };
        match run.status {
            RunStatus::Running => counts.running += 1,
            RunStatus::AwaitingInput => counts.awaiting_input += 1,
            _ => {}
        }
    }
    counts
}

/// The result of [`live_run_counts`].
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveRunCounts {
    /// Runs actively executing — these are what a restart destroys.
    pub running: u64,
    /// Runs parked at a durable gate. These SURVIVE a restart.
    pub awaiting_input: u64,
}

#[cfg(test)]
mod version_store_tests {
    use super::*;

    /// Build a minimal valid workflow (only `id`/`name`/`nodes` are required).
    fn make_wf(id: &str, name: &str) -> Workflow {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": name,
            "nodes": [],
        }))
        .expect("valid workflow json")
    }

    #[test]
    fn snapshot_list_load_prune_delete() {
        // A unique id keeps this test isolated from real data (and other tests)
        // regardless of where `ryu_dir()` resolves; the version dir is removed at
        // the end.
        let wf_id = format!("wftest{}", uuid::Uuid::new_v4().simple());

        // Snapshot returns metadata that echoes the label + workflow id.
        let meta = save_workflow_version(&make_wf(&wf_id, "v1"), Some("first")).expect("save v1");
        assert_eq!(meta.workflow_id, wf_id);
        assert_eq!(meta.label.as_deref(), Some("first"));
        assert_eq!(meta.name, "v1");

        // The list has exactly the one version.
        let list = list_workflow_versions(&wf_id).expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, meta.id);

        // Loading the full version round-trips the captured definition.
        let full = load_workflow_version(&wf_id, &meta.id)
            .expect("load")
            .expect("version exists");
        assert_eq!(full.workflow.id, wf_id);
        assert_eq!(full.workflow.name, "v1");

        // Missing versions load as None rather than erroring.
        assert!(load_workflow_version(&wf_id, "wv_does_not_exist")
            .expect("load missing")
            .is_none());

        // Git history is not pruned by the workflow store.
        for i in 0..55 {
            save_workflow_version(&make_wf(&wf_id, &format!("n{i}")), None).expect("save n");
        }
        let history = list_workflow_versions(&wf_id).expect("list history");
        assert_eq!(history.len(), 56);

        // Deleting the live workflow does not erase its Git audit trail.
        assert!(!delete_workflow_versions(&wf_id).expect("delete legacy history"));
        assert_eq!(
            list_workflow_versions(&wf_id)
                .expect("list after delete")
                .len(),
            56
        );
    }
}
