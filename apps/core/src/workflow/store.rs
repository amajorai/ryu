//! File-backed persistence for workflow definitions and runs.
//!
//! Definitions live under `~/.ryu/workflows/<id>.json`. Run state lives under
//! `~/.ryu/workflow-runs/<run_id>.json` and is rewritten after every node so a
//! run is resumable: on resume we skip nodes already marked `Completed`.
//!
//! Encryption at rest: every file this module writes (live definitions, script
//! workflows, run records, legacy version snapshots) is one whole-body
//! `encb:v1:` value under the `workflow-state` content key, bound to its record
//! kind and id ([`state_codec`]). Every reader goes through the same codec;
//! legacy plaintext files are read as-is and sealed on their next write (and by
//! [`reseal_stored_workflows`] at boot).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use ryu_workspace::source_history::SourceHistory;
use serde::{Deserialize, Serialize};

use super::Workflow;

fn workflows_dir() -> PathBuf {
    crate::paths::state_path("workflows")
}

fn runs_dir() -> PathBuf {
    crate::paths::state_path("workflow-runs")
}

/// The registered content store of workflow state files (KDF input; never
/// rename). Shared with the fan-out checkpoints and the scheduler's job files.
pub(crate) const STATE_STORE: &str = "workflow-state";

/// Record kinds (AAD purposes) of the files this module seals.
const KIND_RUN: &str = "workflow-run";
const KIND_DEFINITION: &str = "workflow-definition";
const KIND_SCRIPT: &str = "workflow-script";
const KIND_VERSION: &str = "workflow-version";

/// The codec that seals one kind of workflow-state file: the whole body as one
/// `encb:v1:` value under the `workflow-state` content key, bound to `(kind,
/// id)`. Fails closed without a key; reads accept legacy plaintext.
pub(crate) fn state_codec(kind: &str) -> std::io::Result<ryu_durable::SealingCodec> {
    let cipher = ryu_crypto::content_cipher(STATE_STORE)
        .map_err(|error| std::io::Error::other(format!("workflow state key: {error:#}")))?;
    Ok(ryu_durable::SealingCodec::new(cipher, kind))
}

/// A sealed checkpoint store of `kind` rooted at `dir`.
pub(crate) fn sealed_store(
    dir: PathBuf,
    kind: &str,
) -> std::io::Result<ryu_durable::FileCheckpointStore> {
    Ok(ryu_durable::FileCheckpointStore::with_codec(
        dir,
        Arc::new(state_codec(kind)?),
    ))
}

fn runs_store() -> std::io::Result<ryu_durable::FileCheckpointStore> {
    sealed_store(runs_dir(), KIND_RUN)
}

fn scripts_store() -> std::io::Result<ryu_durable::FileCheckpointStore> {
    sealed_store(script_workflows_dir(), KIND_SCRIPT)
}

/// Seal a definition's JSON for disk.
fn encode_definition(id: &str, json: &str) -> std::io::Result<Vec<u8>> {
    use ryu_durable::CheckpointCodec as _;
    state_codec(KIND_DEFINITION)?.encode(id, json.as_bytes())
}

/// Open a definition file's bytes back to JSON (legacy plaintext passes).
fn decode_definition(id: &str, stored: &[u8]) -> std::io::Result<Vec<u8>> {
    use ryu_durable::CheckpointCodec as _;
    state_codec(KIND_DEFINITION)?.decode(id, stored)
}

/// The file stem of a `<id>.json` path.
fn json_stem(path: &std::path::Path) -> Option<&str> {
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
        return None;
    }
    path.file_stem().and_then(|s| s.to_str())
}

fn source_history() -> SourceHistory {
    SourceHistory::new(crate::paths::files_path("source-history"))
}

fn source_history_path(workflow_id: &str) -> String {
    format!("workflows/{workflow_id}.json")
}

/// Keep live writes and their Git projections ordered with named checkpoints.
/// Locks are keyed by the authoritative definition path, including its profile.
fn workflow_mutation_lock(id: &str) -> std::io::Result<Arc<Mutex<()>>> {
    validate_id(id)?;
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| std::io::Error::other("workflow mutation lock poisoned"))?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    let path = workflows_dir().join(format!("{id}.json"));
    if let Some(lock) = locks.get(&path).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(path, Arc::downgrade(&lock));
    Ok(lock)
}

/// A per-record write lock for one kind of state file. Every writer of a run
/// record (or script workflow) and the boot reseal pass hold the record's lock
/// across read and write, so the pass never writes back a body that a save
/// replaced meanwhile.
type RecordLocks = OnceLock<Mutex<HashMap<String, Weak<Mutex<()>>>>>;

fn record_lock(locks: &'static RecordLocks, id: &str) -> std::io::Result<Arc<Mutex<()>>> {
    let mut locks = locks
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| std::io::Error::other("workflow record lock poisoned"))?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(id.to_owned(), Arc::downgrade(&lock));
    Ok(lock)
}

fn run_write_lock(run_id: &str) -> std::io::Result<Arc<Mutex<()>>> {
    static LOCKS: RecordLocks = OnceLock::new();
    record_lock(&LOCKS, run_id)
}

fn script_write_lock(id: &str) -> std::io::Result<Arc<Mutex<()>>> {
    static LOCKS: RecordLocks = OnceLock::new();
    record_lock(&LOCKS, id)
}

/// Hold `lock` for the length of `write`.
fn with_record_lock<T>(
    lock: &Mutex<()>,
    write: impl FnOnce() -> std::io::Result<T>,
) -> std::io::Result<T> {
    let _guard = lock
        .lock()
        .map_err(|_| std::io::Error::other("workflow record lock poisoned"))?;
    write()
}

/// How old an atomic-write temp file must be before the boot pass treats it as
/// a crash orphan (a write in flight lasts milliseconds).
const ORPHAN_TEMP_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(60);

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
    /// The run is suspended at a durable input/acknowledgement gate, either
    /// directly or inside a nested workflow. The enclosing node id is recorded
    /// in [`WorkflowRun::awaiting_node`]; durable child links route decisions to
    /// the actual gate without prematurely completing its enclosing node.
    AwaitingInput,
    /// The run hit a provider rate, usage, or session limit and is parked until
    /// [`WorkflowRun::resume_at`]. Nothing failed: the interrupted node stays
    /// unfinished and runs again when the run is woken (see
    /// [`super::auto_resume`]). Like `AwaitingInput`, this survives a restart.
    Waiting,
}

/// Persisted state of a single node within a run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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
    /// True when this is an in-memory read-only dry-run projection. Dry runs
    /// are never checkpointed and are not resumable run history.
    #[serde(default, rename = "dryRun", alias = "dry_run")]
    pub dry_run: bool,
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
    /// string; JSON passes through verbatim. Keys beginning with `__workflow_`
    /// are reserved for durable parent/child execution links.
    #[serde(default)]
    pub state: HashMap<String, String>,
    #[serde(default)]
    pub error: Option<String>,
    /// Set when `status == AwaitingInput`. Identifies the gate or enclosing
    /// composition node that suspended this run. Resume routes through child
    /// links to the actual gate; only that gate receives the supplied payload.
    /// Enclosing nodes remain unfinished until the child workflow completes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub awaiting_node: Option<String>,
    /// Set when `status == Waiting`: when (RFC3339, UTC) the run is woken.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_at: Option<String>,
    /// Set when `status == Waiting`: the limit error that parked the run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_reason: Option<String>,
    /// How many times this run has been parked on a limit. Bounded by
    /// [`super::auto_resume::MAX_LIMIT_WAITS`] so a limit that never clears
    /// eventually fails the run instead of parking it forever.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub limit_waits: u32,
    /// How many times Core has restarted this run on its own after the process
    /// running it died (a crash, restart, or a panicked background task).
    /// Written before the restarted run does any work, so a run that keeps
    /// taking Core down cannot loop; see [`super::auto_resume::MAX_CRASH_RESUMES`].
    #[serde(default, skip_serializing_if = "is_zero")]
    pub crash_resumes: u32,
    /// Ad-hoc script runs only: a digest of the caller scope (plugin, calling
    /// agent, conversation) that started the run. Plugin reads of the run
    /// (`host.workflowRunStatus`) must present the same scope; a run without
    /// one (written before this existed) is not readable by plugins until its
    /// owner re-attaches through `host.workflowScript`. See
    /// [`super::script::wait_for_script_run`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller_scope: Option<String>,
    /// Set on a run created by forking another run from one of its history
    /// checkpoints (see [`super::executor::fork_run`]): the parent run and the
    /// checkpoint the fork resumed from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forked_from: Option<RunLineage>,
    pub created_at: String,
    pub updated_at: String,
}

/// Where a forked run came from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunLineage {
    /// The run the fork was taken from.
    pub run_id: String,
    /// The history checkpoint of that run the fork resumed from.
    pub checkpoint_id: String,
}

#[allow(clippy::trivially_copy_pass_by_ref)] // serde's skip_serializing_if signature
fn is_zero(value: &u32) -> bool {
    *value == 0
}

impl WorkflowRun {
    pub fn new(run_id: String, workflow_id: String, input: HashMap<String, String>) -> Self {
        let now = now_iso();
        Self {
            run_id,
            workflow_id,
            dry_run: false,
            status: RunStatus::Running,
            input,
            output: HashMap::new(),
            nodes: HashMap::new(),
            state: HashMap::new(),
            error: None,
            awaiting_node: None,
            resume_at: None,
            wait_reason: None,
            limit_waits: 0,
            crash_resumes: 0,
            caller_scope: None,
            forked_from: None,
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
    let lock = workflow_mutation_lock(&workflow.id)?;
    let _guard = lock
        .lock()
        .map_err(|_| std::io::Error::other("workflow mutation lock poisoned"))?;
    save_workflow_unlocked(workflow)
}

/// Atomically guard the authoritative write with the caller's saved revision.
pub fn save_workflow_if_revision(
    workflow: &Workflow,
    expected_revision: Option<&str>,
) -> Result<(), WorkflowCheckpointError> {
    let lock = workflow_mutation_lock(&workflow.id).map_err(WorkflowCheckpointError::Store)?;
    let _guard = lock.lock().map_err(|_| {
        WorkflowCheckpointError::Store(std::io::Error::other("workflow mutation lock poisoned"))
    })?;
    if let Some(expected) = expected_revision {
        match load_workflow(&workflow.id) {
            Ok(stored) if stored.updated_at.as_deref() != Some(expected) => {
                return Err(WorkflowCheckpointError::RevisionConflict(stored.updated_at))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(WorkflowCheckpointError::RevisionConflict(None))
            }
            Err(error) => return Err(WorkflowCheckpointError::Store(error)),
        }
    }
    save_workflow_unlocked(workflow).map_err(WorkflowCheckpointError::Store)
}

fn save_workflow_unlocked(workflow: &Workflow) -> std::io::Result<()> {
    validate_id(&workflow.id)?;
    let dir = workflows_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", workflow.id));
    // Credentials are sealed before the bytes exist, so the live file and the
    // Git projection below both receive only the sealed form; the live file is
    // then sealed whole.
    let previous = read_stored_workflow(&workflow.id).ok();
    let sealed = super::secrets::sealed_for_storage(workflow, previous.as_ref())?;
    let json = serde_json::to_string_pretty(&sealed)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let encoded = encode_definition(&workflow.id, &json)?;
    crate::atomic_file::write_atomic(&path, &encoded)?;
    checkpoint_source_history_best_effort(
        &source_history_path(&workflow.id),
        &json,
        Some("Workflow saved"),
    );
    Ok(())
}

/// A live definition's JSON, opened from its sealed file.
fn read_definition_json(id: &str) -> std::io::Result<Vec<u8>> {
    validate_id(id)?;
    let bytes = std::fs::read(workflows_dir().join(format!("{id}.json")))?;
    decode_definition(id, &bytes)
}

/// A definition as stored (credentials still sealed; the file opened).
fn read_stored_workflow(id: &str) -> std::io::Result<Workflow> {
    serde_json::from_slice(&read_definition_json(id)?)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Parse a stored definition and open its sealed credentials.
fn open_stored_workflow(bytes: &[u8]) -> std::io::Result<Workflow> {
    let mut workflow: Workflow = serde_json::from_slice(bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    super::secrets::open_from_storage(&mut workflow)?;
    Ok(workflow)
}

/// Load a workflow definition by id.
pub fn load_workflow(id: &str) -> std::io::Result<Workflow> {
    open_stored_workflow(&read_definition_json(id)?)
}

/// Id prefix of an ad-hoc script workflow (see [`super::script`]). These are
/// started by an agent, not authored in the Workflows app, so they live in
/// their own directory and never appear in [`list_workflows`].
pub const SCRIPT_WORKFLOW_PREFIX: &str = "script-";

fn script_workflows_dir() -> PathBuf {
    crate::paths::state_path("workflow-scripts")
}

/// Persist an ad-hoc script workflow so its runs can be resumed after a
/// restart. Content-addressed ids make this idempotent.
pub fn save_script_workflow(workflow: &Workflow) -> std::io::Result<()> {
    if !workflow.id.starts_with(SCRIPT_WORKFLOW_PREFIX) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "script workflow ids must start with `script-`",
        ));
    }
    let store = scripts_store()?;
    with_record_lock(&*script_write_lock(&workflow.id)?, || {
        let previous: Option<Workflow> = store.load(&workflow.id).ok();
        let sealed = super::secrets::sealed_for_storage(workflow, previous.as_ref())?;
        store.save(&workflow.id, &sealed)
    })
}

/// Load the definition a run executes: an ad-hoc script workflow or a saved one.
pub fn load_runnable_workflow(id: &str) -> std::io::Result<Workflow> {
    if id.starts_with(SCRIPT_WORKFLOW_PREFIX) {
        let mut workflow: Workflow = scripts_store()?.load(id)?;
        super::secrets::open_from_storage(&mut workflow)?;
        return Ok(workflow);
    }
    load_workflow(id)
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
        let Some(id) = json_stem(&path) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        match decode_definition(id, &bytes).and_then(|json| open_stored_workflow(&json)) {
            Ok(wf) => out.push(wf),
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "skipping unreadable workflow definition");
            }
        }
    }
    out
}

/// Seal, once, every workflow credential still stored as legacy plaintext: live
/// definitions (each rewrite also records a sealed Git checkpoint), legacy
/// `workflow-versions` snapshots, and ad-hoc script workflows; and seal whole
/// every such file (and every run record) still stored as plaintext JSON.
/// Idempotent and cheap when nothing is plaintext. Returns how many files were
/// rewritten.
///
/// Git commits recorded before this ran still hold the old plaintext: history is
/// immutable here, so credentials that were ever saved unsealed should be
/// rotated (documented in the encryption-at-rest docs).
pub fn reseal_stored_workflows() -> usize {
    let mut resealed = 0usize;
    let json_files = |dir: PathBuf| -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
                    .collect()
            })
            .unwrap_or_default()
    };
    for path in json_files(workflows_dir()) {
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_owned) else {
            continue;
        };
        let result = (|| -> std::io::Result<bool> {
            let lock = workflow_mutation_lock(&id)?;
            let _guard = lock
                .lock()
                .map_err(|_| std::io::Error::other("workflow mutation lock poisoned"))?;
            let stored = std::fs::read(&path)?;
            let json = decode_definition(&id, &stored)?;
            let mut workflow: Workflow = serde_json::from_slice(&json)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            if workflow.id != id {
                return Ok(false);
            }
            if super::secrets::open_from_storage(&mut workflow)? {
                save_workflow_unlocked(&workflow)?;
                return Ok(true);
            }
            if ryu_durable::SealingCodec::is_sealed(&stored) {
                return Ok(false);
            }
            // Credentials already sealed, body still plaintext: seal the same
            // JSON whole (no new history checkpoint: the content is unchanged).
            let text = std::str::from_utf8(&json)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            crate::atomic_file::write_atomic(&path, &encode_definition(&id, text)?)?;
            Ok(true)
        })();
        match result {
            Ok(true) => resealed += 1,
            Ok(false) => {}
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "workflow credentials were not sealed")
            }
        }
    }
    for dir in json_files_dirs(versions_root()) {
        let Some(workflow_id) = dir.file_name().and_then(|s| s.to_str()).map(str::to_owned) else {
            continue;
        };
        for path in json_files(dir) {
            let Some(version_id) = json_stem(&path).map(str::to_owned) else {
                continue;
            };
            let result = (|| -> std::io::Result<bool> {
                let stored_bytes = std::fs::read(&path)?;
                let bytes = decode_version(&workflow_id, &version_id, &stored_bytes)?;
                let mut version: WorkflowVersion = serde_json::from_slice(&bytes)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
                let stored = version.workflow.clone();
                let credentials = super::secrets::open_from_storage(&mut version.workflow)?;
                if !credentials && ryu_durable::SealingCodec::is_sealed(&stored_bytes) {
                    return Ok(false);
                }
                if credentials {
                    version.workflow =
                        super::secrets::sealed_for_storage(&version.workflow, Some(&stored))?;
                } else {
                    version.workflow = stored;
                }
                let json = serde_json::to_string_pretty(&version)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
                let encoded = encode_version(&workflow_id, &version_id, &json)?;
                crate::atomic_file::write_atomic(&path, &encoded)?;
                Ok(true)
            })();
            match result {
                Ok(true) => resealed += 1,
                Ok(false) => {}
                Err(error) => tracing::warn!(
                    path = %path.display(),
                    %error,
                    "legacy workflow version credentials were not sealed"
                ),
            }
        }
    }
    for path in json_files(script_workflows_dir()) {
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let result = (|| -> std::io::Result<bool> {
            let store = scripts_store()?;
            // Read and rewrite under the script's write lock: a save made
            // meanwhile is never overwritten with the body read here.
            let lock = script_write_lock(id)?;
            let _guard = lock
                .lock()
                .map_err(|_| std::io::Error::other("workflow record lock poisoned"))?;
            let stored = std::fs::read(&path)?;
            let mut workflow: Workflow = store.decode(id, &stored)?;
            if workflow.id != id {
                return Ok(false);
            }
            if super::secrets::open_from_storage(&mut workflow)? {
                let sealed = super::secrets::sealed_for_storage(&workflow, None)?;
                store.save(id, &sealed)?;
                return Ok(true);
            }
            if ryu_durable::SealingCodec::is_sealed(&stored) {
                return Ok(false);
            }
            let as_stored: Workflow = store.decode(id, &stored)?;
            store.save(id, &as_stored)?;
            Ok(true)
        })();
        match result {
            Ok(true) => resealed += 1,
            Ok(false) => {}
            Err(error) => tracing::warn!(
                path = %path.display(),
                %error,
                "script workflow credentials were not sealed"
            ),
        }
    }
    resealed += reseal_plaintext_runs();
    resealed += super::history::reseal_plaintext_histories();
    resealed += super::delegation::reseal_fanout_checkpoints();
    let orphans = remove_orphaned_workflow_temps();
    if resealed > 0 {
        tracing::info!(files = resealed, "workflows: sealed legacy plaintext files");
    }
    if orphans > 0 {
        tracing::info!(
            files = orphans,
            "workflows: removed orphaned temporary files"
        );
    }
    // Core runs this pass once while starting (`main.rs`); the voice staging
    // sweep shares it so orphaned voice samples are removed at start too.
    crate::server::voice::sweep_voice_staging_at_boot();
    resealed
}

/// Remove the temporary copies crashed atomic writes left in the workflow state
/// folders (each a full, possibly plaintext copy of a record). A run's or
/// script's `<id>.json.tmp` is removed under that record's write lock, so never
/// mid-write; other temps only once older than [`ORPHAN_TEMP_MIN_AGE`].
fn remove_orphaned_workflow_temps() -> usize {
    let mut removed = 0;
    for (dir, lock) in [
        (
            runs_dir(),
            run_write_lock as fn(&str) -> std::io::Result<Arc<Mutex<()>>>,
        ),
        (script_workflows_dir(), script_write_lock),
    ] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(id) = name
                .to_str()
                .and_then(|name| name.strip_suffix(".json.tmp"))
            else {
                continue;
            };
            let Ok(record_lock) = lock(id) else {
                continue;
            };
            if with_record_lock(&record_lock, || std::fs::remove_file(entry.path())).is_ok() {
                removed += 1;
            }
        }
        removed += ryu_durable::remove_orphaned_temp_files(&dir, ORPHAN_TEMP_MIN_AGE);
    }
    removed += ryu_durable::remove_orphaned_temp_files(&workflows_dir(), ORPHAN_TEMP_MIN_AGE);
    for dir in json_files_dirs(versions_root()) {
        removed += ryu_durable::remove_orphaned_temp_files(&dir, ORPHAN_TEMP_MIN_AGE);
    }
    removed
}

/// Seal every run record still stored as plaintext JSON (the same content,
/// rewritten through the run store), each under its run's write lock.
fn reseal_plaintext_runs() -> usize {
    let Ok(store) = runs_store() else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(runs_dir()) else {
        return 0;
    };
    let mut resealed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = json_stem(&path) else {
            continue;
        };
        // Read and rewrite under the run's write lock (held by every save):
        // a run saved meanwhile is never overwritten with the body read here.
        let result = run_write_lock(id).and_then(|lock| {
            with_record_lock(&lock, || {
                let stored = std::fs::read(&path)?;
                if ryu_durable::SealingCodec::is_sealed(&stored) {
                    return Ok(false);
                }
                let run = store.decode::<serde_json::Value>(id, &stored)?;
                store.save(id, &run)?;
                Ok(true)
            })
        });
        match result {
            Ok(true) => resealed += 1,
            Ok(false) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "workflow run was not sealed")
            }
        }
    }
    resealed
}

/// The immediate subdirectories of `root` (legacy per-workflow version dirs).
fn json_files_dirs(root: PathBuf) -> Vec<PathBuf> {
    std::fs::read_dir(root)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .collect()
        })
        .unwrap_or_default()
}

/// Delete a workflow definition by id. Returns `true` when a file was removed.
pub fn delete_workflow(id: &str) -> std::io::Result<bool> {
    let lock = workflow_mutation_lock(id)?;
    let _guard = lock
        .lock()
        .map_err(|_| std::io::Error::other("workflow mutation lock poisoned"))?;
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
    crate::paths::state_path("workflow-versions")
}

fn workflow_versions_dir(workflow_id: &str) -> std::io::Result<PathBuf> {
    validate_id(workflow_id)?;
    Ok(versions_root().join(workflow_id))
}

/// The AAD id of a legacy version snapshot.
fn version_record_id(workflow_id: &str, version_id: &str) -> String {
    format!("{workflow_id}/{version_id}")
}

fn encode_version(workflow_id: &str, version_id: &str, json: &str) -> std::io::Result<Vec<u8>> {
    use ryu_durable::CheckpointCodec as _;
    state_codec(KIND_VERSION)?.encode(&version_record_id(workflow_id, version_id), json.as_bytes())
}

fn decode_version(workflow_id: &str, version_id: &str, stored: &[u8]) -> std::io::Result<Vec<u8>> {
    use ryu_durable::CheckpointCodec as _;
    state_codec(KIND_VERSION)?.decode(&version_record_id(workflow_id, version_id), stored)
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
    let lock = workflow_mutation_lock(&workflow.id)?;
    let _guard = lock
        .lock()
        .map_err(|_| std::io::Error::other("workflow mutation lock poisoned"))?;
    checkpoint_workflow_version(workflow, label)
}

#[derive(Debug)]
pub enum WorkflowCheckpointError {
    RevisionConflict(Option<String>),
    Store(std::io::Error),
}

/// Compare and checkpoint one owned definition while excluding live writers.
pub fn checkpoint_current_workflow(
    id: &str,
    expected_revision: Option<&str>,
    label: Option<&str>,
) -> Result<WorkflowVersionMeta, WorkflowCheckpointError> {
    let lock = workflow_mutation_lock(id).map_err(WorkflowCheckpointError::Store)?;
    let _guard = lock.lock().map_err(|_| {
        WorkflowCheckpointError::Store(std::io::Error::other("workflow mutation lock poisoned"))
    })?;
    let workflow = load_workflow(id).map_err(WorkflowCheckpointError::Store)?;
    if expected_revision.is_some() && workflow.updated_at.as_deref() != expected_revision {
        return Err(WorkflowCheckpointError::RevisionConflict(
            workflow.updated_at,
        ));
    }
    #[cfg(test)]
    CHECKPOINT_RENDEZVOUS.with(|hook| {
        if let Some(hook) = hook.borrow().as_ref() {
            hook();
        }
    });
    checkpoint_workflow_version(&workflow, label).map_err(WorkflowCheckpointError::Store)
}

#[cfg(test)]
thread_local! {
    static CHECKPOINT_RENDEZVOUS: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
}

fn checkpoint_workflow_version(
    workflow: &Workflow,
    label: Option<&str>,
) -> std::io::Result<WorkflowVersionMeta> {
    // The live definition already holds this content sealed; reuse its
    // ciphertext so a named checkpoint of an unchanged definition stays
    // byte-identical to the last Git projection.
    let previous = read_stored_workflow(&workflow.id).ok();
    let sealed = super::secrets::sealed_for_storage(workflow, previous.as_ref())?;
    let json = serde_json::to_string_pretty(&sealed)
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
        let Some(version_id) = json_stem(&path) else {
            continue;
        };
        if let Ok(bytes) = std::fs::read(&path) {
            match decode_version(workflow_id, version_id, &bytes).and_then(|json| {
                serde_json::from_slice::<WorkflowVersion>(&json).map_err(Into::into)
            }) {
                Ok(v) => out.push(v),
                Err(error) => tracing::warn!(
                    path = %path.display(),
                    %error,
                    "skipping unreadable workflow version"
                ),
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
            let workflow = open_stored_workflow(source.as_bytes())?;
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
        Ok(bytes) => {
            let bytes = decode_version(workflow_id, version_id, &bytes)?;
            let mut version: WorkflowVersion = serde_json::from_slice(&bytes)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            super::secrets::open_from_storage(&mut version.workflow)?;
            Ok(Some(version))
        }
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
/// directory and run-id key; dry-run projections are rejected before reaching
/// the durable primitive.
pub fn save_run(run: &WorkflowRun) -> std::io::Result<()> {
    if run.dry_run {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "dry-run projections cannot be persisted",
        ));
    }
    let store = runs_store()?;
    with_record_lock(&*run_write_lock(&run.run_id)?, || {
        store.save(&run.run_id, run)
    })
}

/// Load a run's state by run id.
pub fn load_run(run_id: &str) -> std::io::Result<WorkflowRun> {
    runs_store()?.load(run_id)
}

/// Every `<run_id>.json` in the runs directory, opened and parsed. Files that
/// do not open or parse are counted in the second value (and logged).
fn read_all_runs() -> (Vec<WorkflowRun>, u64) {
    let Ok(entries) = std::fs::read_dir(runs_dir()) else {
        return (Vec::new(), 0);
    };
    let store = match runs_store() {
        Ok(store) => store,
        Err(error) => {
            tracing::warn!(%error, "workflow runs cannot be read without the state key");
            return (Vec::new(), 0);
        }
    };
    let mut runs = Vec::new();
    let mut unreadable = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = json_stem(&path) else {
            continue;
        };
        match std::fs::read(&path).and_then(|bytes| store.decode::<WorkflowRun>(id, &bytes)) {
            Ok(run) => runs.push(run),
            Err(error) => {
                unreadable += 1;
                tracing::warn!(path = %path.display(), "skipping unreadable workflow run: {error}");
            }
        }
    }
    if unreadable > 0 {
        tracing::warn!(
            unreadable,
            "workflow runs: files skipped because they do not open"
        );
    }
    (runs, unreadable)
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
    for run in read_all_runs().0 {
        match run.status {
            RunStatus::Running => counts.running += 1,
            RunStatus::AwaitingInput => counts.awaiting_input += 1,
            RunStatus::Waiting => counts.waiting += 1,
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
    /// Runs parked until a provider limit resets. These SURVIVE a restart.
    #[serde(default)]
    pub waiting: u64,
}

/// Every persisted, non-dry run, for boot recovery. Unreadable or corrupt
/// files are skipped (logged), for the same reason as [`live_run_counts`].
pub fn list_runs() -> Vec<WorkflowRun> {
    read_all_runs()
        .0
        .into_iter()
        .filter(|run| !run.dry_run)
        .collect()
}

#[cfg(test)]
mod version_store_tests {
    use super::*;

    #[test]
    fn workflow_checkpoint_excludes_interleaved_live_writer_and_preserves_history_order() {
        assert_eq!(std::env::var("RYU_KEYCHAIN").as_deref(), Ok("off"));
        let configured = PathBuf::from(std::env::var_os("RYU_DIR").expect("isolated RYU_DIR"));
        assert!(
            configured.starts_with(std::env::temp_dir()) || configured.starts_with("/private/tmp")
        );
        let id = format!("wfatomic{}", uuid::Uuid::new_v4().simple());
        let mut draft_b = make_wf(&id, "B");
        draft_b.updated_at = Some("2026-10-05T00:00:01Z".to_owned());
        save_workflow(&draft_b).unwrap();
        let mut draft_c = draft_b.clone();
        draft_c.name = "C".into();
        draft_c.updated_at = Some("2026-10-05T00:00:02Z".to_owned());
        let (loaded_tx, loaded_rx) = std::sync::mpsc::channel();
        let (writer_started_tx, writer_started_rx) = std::sync::mpsc::channel();
        let (written_tx, written_rx) = std::sync::mpsc::channel();
        let writer_id = id.clone();
        let writer = std::thread::spawn(move || {
            loaded_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            // This is the same lock save_workflow uses, and the snapshot has
            // already loaded B. A writer cannot acquire it before checkpoint.
            assert!(workflow_mutation_lock(&writer_id)
                .unwrap()
                .try_lock()
                .is_err());
            writer_started_tx.send(()).unwrap();
            save_workflow(&draft_c).unwrap();
            let _ = written_tx.send(());
            draft_c
        });
        CHECKPOINT_RENDEZVOUS.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(move || {
                loaded_tx.send(()).unwrap();
                writer_started_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                assert!(written_rx.try_recv().is_err());
            }));
        });
        let result =
            checkpoint_current_workflow(&id, draft_b.updated_at.as_deref(), Some("Named B"));
        CHECKPOINT_RENDEZVOUS.with(|hook| *hook.borrow_mut() = None);
        let checkpoint = result.expect("guarded named checkpoint");
        let draft_c = writer.join().unwrap();
        assert_eq!(
            serde_json::to_value(load_workflow(&id).unwrap()).unwrap(),
            serde_json::to_value(&draft_c).unwrap()
        );
        let captured = load_workflow_version(&id, &checkpoint.id).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(captured.workflow).unwrap(),
            serde_json::to_value(draft_b).unwrap()
        );
        let latest = list_workflow_versions(&id)
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        let latest = load_workflow_version(&id, &latest.id).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(latest.workflow).unwrap(),
            serde_json::to_value(draft_c).unwrap()
        );
    }

    #[test]
    fn workflow_guarded_writer_refuses_second_save_from_same_base_without_checkpoint() {
        assert_eq!(std::env::var("RYU_KEYCHAIN").as_deref(), Ok("off"));
        let configured = PathBuf::from(std::env::var_os("RYU_DIR").expect("isolated RYU_DIR"));
        assert!(
            configured.starts_with(std::env::temp_dir()) || configured.starts_with("/private/tmp")
        );
        let id = format!("wfcas{}", uuid::Uuid::new_v4().simple());
        let mut initial = make_wf(&id, "A");
        initial.updated_at = Some("2026-10-05T00:00:00Z".into());
        save_workflow(&initial).unwrap();
        let mut first = initial.clone();
        first.name = "B".into();
        first.updated_at = Some("2026-10-05T00:00:01Z".into());
        save_workflow_if_revision(&first, initial.updated_at.as_deref()).unwrap();
        let before = list_workflow_versions(&id).unwrap();
        let mut second = initial.clone();
        second.name = "C".into();
        second.updated_at = Some("2026-10-05T00:00:02Z".into());
        assert!(
            matches!(save_workflow_if_revision(&second, initial.updated_at.as_deref()), Err(WorkflowCheckpointError::RevisionConflict(revision)) if revision == first.updated_at)
        );
        assert_eq!(
            serde_json::to_value(load_workflow(&id).unwrap()).unwrap(),
            serde_json::to_value(first).unwrap()
        );
        let after = list_workflow_versions(&id).unwrap();
        assert_eq!(
            serde_json::to_value(after).unwrap(),
            serde_json::to_value(before).unwrap()
        );
    }

    #[test]
    fn workflow_guarded_writer_refuses_deleted_resource_without_recreation_or_checkpoint() {
        assert_eq!(std::env::var("RYU_KEYCHAIN").as_deref(), Ok("off"));
        let configured = PathBuf::from(std::env::var_os("RYU_DIR").expect("isolated RYU_DIR"));
        assert!(
            configured.starts_with(std::env::temp_dir()) || configured.starts_with("/private/tmp")
        );
        let id = format!("wfdeletedcas{}", uuid::Uuid::new_v4().simple());
        let mut initial = make_wf(&id, "Acknowledged definition");
        initial.updated_at = Some("2026-10-05T00:00:00Z".into());
        save_workflow(&initial).unwrap();
        assert!(!list_workflow_versions(&id).unwrap().is_empty());

        // The REST preflight has read this revision, but deletion wins the
        // canonical mutation lock before the guarded writer reaches storage.
        let mut draft = initial.clone();
        draft.name = "Stale draft".into();
        draft.updated_at = Some("2026-10-05T00:00:01Z".into());
        assert!(delete_workflow(&id).unwrap());
        let before = list_workflow_versions(&id).unwrap();
        assert!(matches!(
            save_workflow_if_revision(&draft, initial.updated_at.as_deref()),
            Err(WorkflowCheckpointError::RevisionConflict(None))
        ));
        assert_eq!(
            load_workflow(&id).unwrap_err().kind(),
            std::io::ErrorKind::NotFound
        );
        assert!(!workflows_dir().join(format!("{id}.json")).exists());
        assert_eq!(
            serde_json::to_value(list_workflow_versions(&id).unwrap()).unwrap(),
            serde_json::to_value(before).unwrap()
        );

        // Unguarded creation remains available for new definitions and legacy
        // restoration callers that intentionally recreate a deleted workflow.
        save_workflow_if_revision(&draft, None).unwrap();
        assert_eq!(load_workflow(&id).unwrap().name, "Stale draft");
    }

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

#[cfg(test)]
mod credential_sealing_tests {
    use super::*;

    /// Tests that run the boot reseal pass (which walks every file in the
    /// shared test data folder) take this lock so their counts do not race.
    static RESEAL_PASS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn reseal_pass_lock() -> std::sync::MutexGuard<'static, ()> {
        RESEAL_PASS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    use crate::workflow::{ChannelPlatform, NodeKind, WorkflowNode, WorkflowTrigger};

    const BOT_TOKEN: &str = "424242:store-bot-token-secret";
    const HOOK_URL: &str = "https://hooks.slack.test/services/T1/B1/store-hook-secret";
    const TRIGGER_SECRET: &str = "store-trigger-hmac-secret";

    fn credential_workflow(id: &str) -> Workflow {
        Workflow {
            id: id.to_owned(),
            name: "sealed".into(),
            description: None,
            nodes: vec![WorkflowNode {
                id: "send".into(),
                kind: NodeKind::ChannelSend {
                    platform: ChannelPlatform::Telegram,
                    recipient: "@ops".into(),
                    text: "hello".into(),
                    bot_token: Some(BOT_TOKEN.into()),
                    webhook_url: Some(HOOK_URL.into()),
                },
                retry: None,
                timeout_ms: None,
                repeat: None,
            }],
            edges: vec![],
            triggers: vec![WorkflowTrigger::Webhook {
                secret: Some(TRIGGER_SECRET.into()),
            }],
            max_concurrency: None,
            created_at: None,
            updated_at: Some("2026-10-18T00:00:00Z".into()),
        }
    }

    fn assert_no_secret(text: &str, place: &str) {
        for secret in [
            "store-bot-token-secret",
            "store-hook-secret",
            TRIGGER_SECRET,
        ] {
            assert!(
                !text.contains(secret),
                "{secret} is in plaintext in {place}"
            );
        }
    }

    fn channel_token(workflow: &Workflow) -> Option<String> {
        match &workflow.nodes[0].kind {
            NodeKind::ChannelSend { bot_token, .. } => bot_token.clone(),
            _ => None,
        }
    }

    #[test]
    fn saved_definition_and_history_hold_only_sealed_credentials() {
        assert_eq!(std::env::var("RYU_KEYCHAIN").as_deref(), Ok("off"));
        let id = format!("wfsealed{}", uuid::Uuid::new_v4().simple());
        let workflow = credential_workflow(&id);
        save_workflow(&workflow).unwrap();
        let meta = save_workflow_version(&workflow, Some("named")).unwrap();

        let path = workflows_dir().join(format!("{id}.json"));
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_no_secret(&on_disk, "the live definition");
        assert!(
            on_disk.starts_with("encb:v1:"),
            "the live file is sealed whole"
        );
        let opened = String::from_utf8(read_definition_json(&id).unwrap()).unwrap();
        assert_no_secret(&opened, "the opened live definition");
        assert!(opened.contains("enc:v1:"), "credentials stay sealed inside");
        // Source history is a sealed SQLite store: no file under its folder
        // (database, WAL) holds a credential in plaintext.
        for entry in std::fs::read_dir(crate::paths::files_path("source-history"))
            .unwrap()
            .flatten()
        {
            if entry.path().is_file() {
                let bytes = std::fs::read(entry.path()).unwrap();
                assert_no_secret(
                    &String::from_utf8_lossy(&bytes),
                    &format!("source history file {}", entry.path().display()),
                );
            }
        }
        for version in source_history()
            .list(&source_history_path(&id), None)
            .unwrap()
        {
            let source = source_history()
                .read(&source_history_path(&id), &version.id)
                .unwrap()
                .unwrap();
            assert_no_secret(&source, "a source-history commit");
        }

        // Every reader sees plaintext.
        let loaded = load_workflow(&id).unwrap();
        assert_eq!(channel_token(&loaded).as_deref(), Some(BOT_TOKEN));
        assert!(list_workflows()
            .iter()
            .any(|wf| wf.id == id && channel_token(wf).as_deref() == Some(BOT_TOKEN)));
        let version = load_workflow_version(&id, &meta.id).unwrap().unwrap();
        assert_eq!(channel_token(&version.workflow).as_deref(), Some(BOT_TOKEN));

        // Re-saving unchanged credentials keeps their ciphertext.
        save_workflow(&loaded).unwrap();
        assert_eq!(
            String::from_utf8(read_definition_json(&id).unwrap()).unwrap(),
            opened
        );
        let _ = delete_workflow(&id);
    }

    #[test]
    fn legacy_plaintext_definition_is_read_then_resealed() {
        let _reseal = reseal_pass_lock();
        assert_eq!(std::env::var("RYU_KEYCHAIN").as_deref(), Ok("off"));
        let id = format!("wflegacy{}", uuid::Uuid::new_v4().simple());
        let workflow = credential_workflow(&id);
        std::fs::create_dir_all(workflows_dir()).unwrap();
        let path = workflows_dir().join(format!("{id}.json"));
        std::fs::write(&path, serde_json::to_string_pretty(&workflow).unwrap()).unwrap();
        // Legacy JSON snapshot dir, too.
        let legacy_dir = workflow_versions_dir(&id).unwrap();
        std::fs::create_dir_all(&legacy_dir).unwrap();
        let legacy_version = WorkflowVersion {
            id: "wv_legacy".into(),
            workflow_id: id.clone(),
            name: "sealed".into(),
            label: None,
            created_at: 1,
            workflow: workflow.clone(),
        };
        let legacy_path = legacy_dir.join("wv_legacy.json");
        std::fs::write(
            &legacy_path,
            serde_json::to_string(&legacy_version).unwrap(),
        )
        .unwrap();

        assert_eq!(
            channel_token(&load_workflow(&id).unwrap()).as_deref(),
            Some(BOT_TOKEN)
        );
        assert!(reseal_stored_workflows() >= 2);
        assert_no_secret(
            &std::fs::read_to_string(&path).unwrap(),
            "the resealed definition",
        );
        assert_no_secret(
            &std::fs::read_to_string(&legacy_path).unwrap(),
            "the resealed legacy version",
        );
        assert_eq!(
            channel_token(&load_workflow(&id).unwrap()).as_deref(),
            Some(BOT_TOKEN)
        );
        let legacy = load_workflow_version(&id, "wv_legacy").unwrap().unwrap();
        assert_eq!(channel_token(&legacy.workflow).as_deref(), Some(BOT_TOKEN));
        let _ = delete_workflow(&id);
    }

    #[test]
    fn script_workflow_checkpoint_is_sealed() {
        let id = format!(
            "{SCRIPT_WORKFLOW_PREFIX}sealed{}",
            uuid::Uuid::new_v4().simple()
        );
        save_script_workflow(&credential_workflow(&id)).unwrap();
        let raw =
            std::fs::read_to_string(script_workflows_dir().join(format!("{id}.json"))).unwrap();
        assert_no_secret(&raw, "the script workflow checkpoint");
        let loaded = load_runnable_workflow(&id).unwrap();
        assert_eq!(channel_token(&loaded).as_deref(), Some(BOT_TOKEN));
    }

    fn run_with_marker(run_id: &str, marker: &str) -> WorkflowRun {
        let mut run = WorkflowRun::new(
            run_id.to_owned(),
            "wf-sealed-runs".to_owned(),
            HashMap::from([("prompt".to_owned(), format!("input {marker}"))]),
        );
        run.output
            .insert("answer".into(), format!("output {marker}"));
        run.state
            .insert("trigger".into(), format!("{{\"body\":\"{marker}\"}}"));
        run
    }

    #[test]
    fn run_records_are_sealed_whole_and_bound_to_their_id() {
        let run_id = format!("run_sealed{}", uuid::Uuid::new_v4().simple());
        let marker = format!("quillfeather{}", uuid::Uuid::new_v4().simple());
        save_run(&run_with_marker(&run_id, &marker)).unwrap();
        let path = runs_dir().join(format!("{run_id}.json"));
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.starts_with("encb:v1:"));
        assert!(
            !raw.contains(&marker),
            "run content is not on disk in plaintext"
        );
        assert_eq!(
            load_run(&run_id).unwrap().output["answer"],
            format!("output {marker}")
        );
        assert!(list_runs().iter().any(|run| run.run_id == run_id));

        // A record copied to another run id does not open, and a listing skips it.
        let copy_id = format!("run_copy{}", uuid::Uuid::new_v4().simple());
        let copy = runs_dir().join(format!("{copy_id}.json"));
        std::fs::copy(&path, &copy).unwrap();
        assert!(load_run(&copy_id).is_err());
        assert!(!list_runs()
            .iter()
            .any(|run| run.run_id == run_id && run.run_id == copy_id));
        let (_, unreadable) = read_all_runs();
        assert!(unreadable >= 1);
        let _ = std::fs::remove_file(copy);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn legacy_plaintext_runs_read_and_are_sealed_once() {
        let _reseal = reseal_pass_lock();
        let run_id = format!("run_legacy{}", uuid::Uuid::new_v4().simple());
        let marker = format!("legacymarker{}", uuid::Uuid::new_v4().simple());
        let run = run_with_marker(&run_id, &marker);
        std::fs::create_dir_all(runs_dir()).unwrap();
        let path = runs_dir().join(format!("{run_id}.json"));
        std::fs::write(&path, serde_json::to_string_pretty(&run).unwrap()).unwrap();
        assert_eq!(
            load_run(&run_id).unwrap().input["prompt"],
            format!("input {marker}")
        );
        assert!(list_runs().iter().any(|listed| listed.run_id == run_id));

        assert!(reseal_plaintext_runs() >= 1);
        let sealed = std::fs::read_to_string(&path).unwrap();
        assert!(sealed.starts_with("encb:v1:"));
        assert!(!sealed.contains(&marker));
        // Idempotent: a second pass leaves the sealed file alone.
        reseal_plaintext_runs();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), sealed);
        assert_eq!(
            load_run(&run_id).unwrap().output["answer"],
            format!("output {marker}")
        );
        let _ = std::fs::remove_file(path);
    }

    /// The boot pass reads a legacy run under the run's write lock, so a run
    /// saved while the pass waits is kept, never replaced by the stale body.
    #[test]
    fn the_boot_pass_never_writes_back_a_run_saved_meanwhile() {
        let _reseal = reseal_pass_lock();
        let run_id = format!("run_race{}", uuid::Uuid::new_v4().simple());
        let stale = run_with_marker(&run_id, "stale");
        std::fs::create_dir_all(runs_dir()).unwrap();
        let path = runs_dir().join(format!("{run_id}.json"));
        std::fs::write(&path, serde_json::to_string_pretty(&stale).unwrap()).unwrap();

        // Hold the run's write lock as a save in progress does; the pass blocks.
        let lock = run_write_lock(&run_id).unwrap();
        let guard = lock.lock().unwrap();
        let pass = std::thread::spawn(reseal_plaintext_runs);
        std::thread::sleep(std::time::Duration::from_millis(200));
        let mut newer = run_with_marker(&run_id, "newer");
        newer.status = RunStatus::Completed;
        runs_store().unwrap().save(&run_id, &newer).unwrap();
        drop(guard);
        pass.join().unwrap();

        let loaded = load_run(&run_id).unwrap();
        assert_eq!(loaded.status, RunStatus::Completed);
        assert_eq!(loaded.output["answer"], "output newer");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn the_boot_pass_removes_orphaned_run_and_script_temps() {
        let _reseal = reseal_pass_lock();
        let marker = format!("orphanmarker{}", uuid::Uuid::new_v4().simple());
        let run_id = format!("run_orphan{}", uuid::Uuid::new_v4().simple());
        let script_id = format!(
            "{SCRIPT_WORKFLOW_PREFIX}orphan{}",
            uuid::Uuid::new_v4().simple()
        );
        std::fs::create_dir_all(runs_dir()).unwrap();
        std::fs::create_dir_all(script_workflows_dir()).unwrap();
        let run_temp = runs_dir().join(format!("{run_id}.json.tmp"));
        let script_temp = script_workflows_dir().join(format!("{script_id}.json.tmp"));
        let old_temp = workflows_dir().join(format!(".tmp{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(workflows_dir()).unwrap();
        for temp in [&run_temp, &script_temp, &old_temp] {
            std::fs::write(temp, format!("{{\"input\":\"{marker}\"}}")).unwrap();
        }
        std::fs::File::options()
            .write(true)
            .open(&old_temp)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(600))
            .unwrap();
        assert!(remove_orphaned_workflow_temps() >= 3);
        assert!(!run_temp.exists());
        assert!(!script_temp.exists());
        assert!(!old_temp.exists());
        // Idempotent.
        reseal_stored_workflows();
        assert!(!run_temp.exists());
    }

    #[test]
    fn a_plaintext_definition_without_credentials_is_sealed_whole_by_the_boot_pass() {
        let _reseal = reseal_pass_lock();
        let id = format!("wfplain{}", uuid::Uuid::new_v4().simple());
        let marker = format!("definitionmarker{}", uuid::Uuid::new_v4().simple());
        let mut workflow: Workflow = serde_json::from_value(serde_json::json!({
            "id": id,
            "name": marker,
            "nodes": [],
        }))
        .unwrap();
        workflow.description = Some(format!("prompt {marker}"));
        std::fs::create_dir_all(workflows_dir()).unwrap();
        let path = workflows_dir().join(format!("{id}.json"));
        std::fs::write(&path, serde_json::to_string_pretty(&workflow).unwrap()).unwrap();
        assert!(reseal_stored_workflows() >= 1);
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.starts_with("encb:v1:"));
        assert!(!raw.contains(&marker));
        assert_eq!(load_workflow(&id).unwrap().name, marker);
        assert!(list_workflows().iter().any(|wf| wf.id == id));
        let _ = delete_workflow(&id);
    }
}
