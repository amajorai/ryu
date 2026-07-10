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
    let removed = match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(e) => return Err(e),
    };
    // The definition is gone — its version history is dead weight; drop it too.
    let _ = delete_workflow_versions(id);
    Ok(removed)
}

// ── Version history (Prompt-Studio-style snapshots) ─────────────────────────
//
// Each workflow keeps a bounded, immutable history of past definitions under
// `~/.ryu/workflow-versions/<workflow_id>/<version_id>.json`. A version wraps a
// full [`Workflow`] snapshot plus metadata. Versions are created manually
// ("Save version") or automatically just before a restore, so a restore is
// itself undoable.

/// Maximum retained versions per workflow. Oldest beyond this are pruned on each
/// new snapshot so history stays bounded (mirrors the pages `MAX_DOC_VERSIONS`).
const MAX_WORKFLOW_VERSIONS: usize = 50;

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

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Snapshot a workflow definition as a new version and return its metadata.
/// Prunes the oldest versions past [`MAX_WORKFLOW_VERSIONS`].
pub fn save_workflow_version(
    workflow: &Workflow,
    label: Option<&str>,
) -> std::io::Result<WorkflowVersionMeta> {
    let dir = workflow_versions_dir(&workflow.id)?;
    std::fs::create_dir_all(&dir)?;
    let version_id = format!("wv_{}", uuid::Uuid::new_v4().simple());
    let created_at = now_millis();
    let version = WorkflowVersion {
        id: version_id.clone(),
        workflow_id: workflow.id.clone(),
        name: workflow.name.clone(),
        label: label.map(str::to_string),
        created_at,
        workflow: workflow.clone(),
    };
    let json = serde_json::to_string_pretty(&version)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(dir.join(format!("{version_id}.json")), json)?;

    prune_workflow_versions(&workflow.id)?;

    Ok(WorkflowVersionMeta {
        id: version_id,
        workflow_id: workflow.id.clone(),
        name: workflow.name.clone(),
        label: label.map(str::to_string),
        created_at,
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
    let mut versions = read_workflow_versions(workflow_id)?;
    versions.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    Ok(versions
        .into_iter()
        .map(|v| WorkflowVersionMeta {
            id: v.id,
            workflow_id: v.workflow_id,
            name: v.name,
            label: v.label,
            created_at: v.created_at,
        })
        .collect())
}

/// Load one saved version in full (including its captured definition).
pub fn load_workflow_version(
    workflow_id: &str,
    version_id: &str,
) -> std::io::Result<Option<WorkflowVersion>> {
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

/// Delete a workflow's entire version history directory. Returns `true` when a
/// directory was removed.
pub fn delete_workflow_versions(workflow_id: &str) -> std::io::Result<bool> {
    let dir = workflow_versions_dir(workflow_id)?;
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Remove the oldest version files beyond [`MAX_WORKFLOW_VERSIONS`].
fn prune_workflow_versions(workflow_id: &str) -> std::io::Result<()> {
    let mut versions = read_workflow_versions(workflow_id)?;
    if versions.len() <= MAX_WORKFLOW_VERSIONS {
        return Ok(());
    }
    // Newest first, then delete the tail past the cap.
    versions.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
    let dir = workflow_versions_dir(workflow_id)?;
    for v in versions.into_iter().skip(MAX_WORKFLOW_VERSIONS) {
        let _ = std::fs::remove_file(dir.join(format!("{}.json", v.id)));
    }
    Ok(())
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
        let meta = save_workflow_version(&make_wf(&wf_id, "v1"), Some("first"))
            .expect("save v1");
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
        assert!(
            load_workflow_version(&wf_id, "wv_does_not_exist")
                .expect("load missing")
                .is_none()
        );

        // Exceeding the cap bounds retained history to exactly MAX.
        for i in 0..MAX_WORKFLOW_VERSIONS + 5 {
            save_workflow_version(&make_wf(&wf_id, &format!("n{i}")), None)
                .expect("save n");
        }
        let bounded = list_workflow_versions(&wf_id).expect("list bounded");
        assert_eq!(bounded.len(), MAX_WORKFLOW_VERSIONS);

        // Delete clears the whole history.
        assert!(delete_workflow_versions(&wf_id).expect("delete"));
        assert!(
            list_workflow_versions(&wf_id)
                .expect("list after delete")
                .is_empty()
        );
        // Deleting an absent history is a no-op, not an error.
        assert!(!delete_workflow_versions(&wf_id).expect("delete again"));
    }
}
