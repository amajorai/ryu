//! Append-only checkpoint history of a workflow run ("time travel").
//!
//! The run file in [`super::store`] is overwritten after every node, so it only
//! ever holds the *latest* state. This module keeps the trail: every time the
//! executor settles a node (completed, failed, suspended at a gate, parked on a
//! provider limit) and when a run starts, finishes, or is forked, it appends one
//! [`RunCheckpoint`] carrying a full snapshot of the run's state map, node
//! statuses, and outputs.
//!
//! The history answers "what did the run look like right after node X?" and is
//! the source a fork starts from ([`super::executor::fork_run`]): a new run is
//! seeded with a checkpoint's completed nodes and state (optionally patched) and
//! resumes executing from that point.
//!
//! Storage is one JSON-lines file per run under the data dir's
//! `state/workflow-run-history/<run_id>.jsonl`. Each line is self-contained and
//! appended with `fsync`, so a crash can lose at most the line being written; a
//! torn trailing line is skipped on read. Recording is best effort: a history
//! write failure is logged and never fails the run, because the run file stays
//! the authoritative durable state.
//!
//! Every snapshot carries the run's state and node outputs, so each line is
//! sealed like the run record itself: one `encb:v1:` value under the
//! `workflow-state` content key, bound to `(run id, sequence)` so a line cannot
//! be moved to another run or position. Reads accept legacy plaintext lines, and
//! [`reseal_plaintext_histories`] seals them at boot.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use super::store::{state_codec, NodeRunState, RunStatus, WorkflowRun};

/// Upper bound on recorded checkpoints per run. Later checkpoints are dropped
/// (with a warning) so a pathological run cannot grow its history without bound.
pub const MAX_HISTORY_ENTRIES: u64 = 2_000;

/// Why a checkpoint was recorded.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointEvent {
    /// A fresh run was created (before any node ran).
    RunStarted,
    /// This run was created by forking another run's checkpoint.
    Forked,
    /// A node finished successfully.
    NodeCompleted,
    /// A node failed (after its retry budget).
    NodeFailed,
    /// A node suspended the run at a human-in-the-loop gate.
    NodeSuspended,
    /// A node hit a provider limit and the run was parked.
    NodeParked,
    /// The run reached `completed`.
    RunCompleted,
    /// The run reached `failed`.
    RunFailed,
}

/// One recorded checkpoint of a run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunCheckpoint {
    /// Stable id of this checkpoint within its run (`cp-<sequence>`). Pass it
    /// to the fork endpoint.
    pub checkpoint_id: String,
    /// 0-based position in the run's history.
    pub sequence: u64,
    /// The run this checkpoint belongs to.
    pub run_id: String,
    /// What happened.
    pub event: CheckpointEvent,
    /// The node the event is about (`None` for run-level events).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    /// How many times the node has run in this run: its `repeat` iteration
    /// count, its `while` loop count, or 1. 0 for run-level events.
    pub iteration: u64,
    /// The run status at this checkpoint.
    pub status: RunStatus,
    /// When the checkpoint was recorded (RFC3339, UTC).
    pub created_at: String,
    /// Snapshot of the run's `state` map.
    #[serde(default)]
    pub state: HashMap<String, String>,
    /// Snapshot of every node's run state.
    #[serde(default)]
    pub nodes: HashMap<String, NodeRunState>,
    /// Snapshot of the run's output map.
    #[serde(default)]
    pub output: HashMap<String, String>,
}

fn history_dir() -> PathBuf {
    crate::paths::state_path("workflow-run-history")
}

/// Record kind (AAD purpose) of a history line in the `workflow-state` content store.
const KIND_HISTORY: &str = "workflow-run-history";

/// The identity a history line is sealed to: its run and its position.
fn line_record_id(run_id: &str, sequence: u64) -> String {
    format!("{run_id}/{sequence}")
}

/// Seal one checkpoint's JSON into a single history line (no trailing newline).
fn seal_line(run_id: &str, sequence: u64, json: &str) -> std::io::Result<String> {
    use ryu_durable::CheckpointCodec as _;
    let sealed =
        state_codec(KIND_HISTORY)?.encode(&line_record_id(run_id, sequence), json.as_bytes())?;
    String::from_utf8(sealed).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Open one history line back to checkpoint JSON (a legacy plaintext line passes).
fn open_line(run_id: &str, sequence: u64, line: &str) -> std::io::Result<Vec<u8>> {
    use ryu_durable::CheckpointCodec as _;
    state_codec(KIND_HISTORY)?.decode(&line_record_id(run_id, sequence), line.trim().as_bytes())
}

fn history_path(run_id: &str) -> std::io::Result<PathBuf> {
    ryu_durable::validate_id(run_id)?;
    Ok(history_dir().join(format!("{run_id}.jsonl")))
}

/// Serializes appends so the sequence number read and the line written stay
/// consistent even if two writers ever touched one run's history.
fn append_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Format a checkpoint id from its sequence number.
pub fn checkpoint_id(sequence: u64) -> String {
    format!("cp-{sequence:06}")
}

fn count_entries(path: &std::path::Path) -> std::io::Result<u64> {
    match std::fs::File::open(path) {
        Ok(file) => {
            let mut count = 0;
            for line in std::io::BufReader::new(file).lines() {
                if !line?.trim().is_empty() {
                    count += 1;
                }
            }
            Ok(count)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error),
    }
}

fn ends_without_newline(file: &mut std::fs::File) -> std::io::Result<bool> {
    use std::io::{Read, Seek, SeekFrom};
    if file.metadata()?.len() == 0 {
        return Ok(false);
    }
    file.seek(SeekFrom::End(-1))?;
    let mut last = [0_u8; 1];
    file.read_exact(&mut last)?;
    Ok(last[0] != b'\n')
}

/// Append one checkpoint built from `run`. Returns the recorded checkpoint, or
/// `None` when the history is full.
pub fn append(
    run: &WorkflowRun,
    event: CheckpointEvent,
    node_id: Option<&str>,
    iteration: u64,
) -> std::io::Result<Option<RunCheckpoint>> {
    let path = history_path(&run.run_id)?;
    let _guard = append_lock()
        .lock()
        .map_err(|_| std::io::Error::other("workflow history lock poisoned"))?;
    let sequence = count_entries(&path)?;
    if sequence >= MAX_HISTORY_ENTRIES {
        return Ok(None);
    }
    let checkpoint = RunCheckpoint {
        checkpoint_id: checkpoint_id(sequence),
        sequence,
        run_id: run.run_id.clone(),
        event,
        node_id: node_id.map(str::to_owned),
        iteration,
        status: run.status,
        created_at: chrono::Utc::now().to_rfc3339(),
        state: run.state.clone(),
        nodes: run.nodes.clone(),
        output: run.output.clone(),
    };
    let json = serde_json::to_string(&checkpoint)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut line = seal_line(&run.run_id, sequence, &json)?;
    line.push('\n');
    std::fs::create_dir_all(history_dir())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .open(&path)?;
    // A crash mid-append can leave a torn last line. Start on a fresh line so
    // the new checkpoint never merges into it.
    if ends_without_newline(&mut file)? {
        line.insert(0, '\n');
    }
    file.write_all(line.as_bytes())?;
    file.sync_data()?;
    Ok(Some(checkpoint))
}

/// Record a checkpoint without failing the caller: history is an audit and
/// replay aid, while the run file stays the authoritative durable state.
pub fn record(run: &WorkflowRun, event: CheckpointEvent, node_id: Option<&str>, iteration: u64) {
    if run.dry_run {
        return;
    }
    match append(run, event, node_id, iteration) {
        Ok(Some(_)) => {}
        Ok(None) => tracing::warn!(
            run_id = %run.run_id,
            "workflow run history is full; checkpoint not recorded"
        ),
        Err(error) => tracing::warn!(
            run_id = %run.run_id,
            error = %error,
            "workflow run history checkpoint was not recorded"
        ),
    }
}

/// Every recorded checkpoint of a run, oldest first. A run without history
/// (one that predates it, or never ran a node) returns an empty list. A torn
/// or unreadable line is skipped.
pub fn list(run_id: &str) -> std::io::Result<Vec<RunCheckpoint>> {
    let path = history_path(run_id)?;
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut checkpoints = Vec::new();
    // A line's sequence is its position among the non-empty lines (a torn line
    // holds its slot), the same count `append` numbers the next checkpoint from.
    let mut sequence = 0_u64;
    for line in std::io::BufReader::new(file).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let opened = open_line(run_id, sequence, &line).and_then(|json| {
            serde_json::from_slice::<RunCheckpoint>(&json)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
        });
        sequence += 1;
        match opened {
            Ok(checkpoint) => checkpoints.push(checkpoint),
            Err(error) => tracing::warn!(
                run_id,
                error = %error,
                "skipping unreadable workflow history line"
            ),
        }
    }
    Ok(checkpoints)
}

/// Seal every history line still stored as plaintext (written before history
/// was sealed), one file at a time under the append lock. Returns how many files
/// were rewritten. Without the state key nothing is touched.
pub fn reseal_plaintext_histories() -> usize {
    let Ok(entries) = std::fs::read_dir(history_dir()) else {
        return 0;
    };
    let mut resealed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(run_id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if ryu_durable::validate_id(run_id).is_err() {
            continue;
        }
        let Ok(_guard) = append_lock().lock() else {
            return resealed;
        };
        match reseal_file(&path, run_id) {
            Ok(true) => resealed += 1,
            Ok(false) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(path = %path.display(), %error, "workflow run history was not sealed")
            }
        }
    }
    resealed
}

/// Rewrite one history file with every plaintext line sealed. `Ok(false)` when it
/// held none.
fn reseal_file(path: &std::path::Path, run_id: &str) -> std::io::Result<bool> {
    let text = std::fs::read_to_string(path)?;
    let mut rewritten = String::with_capacity(text.len());
    let mut changed = false;
    let mut sequence = 0_u64;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let line = line.trim();
        if ryu_durable::SealingCodec::is_sealed(line.as_bytes()) {
            rewritten.push_str(line);
        } else {
            rewritten.push_str(&seal_line(run_id, sequence, line)?);
            changed = true;
        }
        rewritten.push('\n');
        sequence += 1;
    }
    if !changed {
        return Ok(false);
    }
    ryu_durable::atomic_write_private(path, rewritten.as_bytes())?;
    Ok(true)
}

/// Find one checkpoint by id.
pub fn find(run_id: &str, checkpoint_id: &str) -> std::io::Result<Option<RunCheckpoint>> {
    Ok(list(run_id)?
        .into_iter()
        .find(|checkpoint| checkpoint.checkpoint_id == checkpoint_id))
}

/// Whether a run has any recorded history.
pub fn is_empty(run_id: &str) -> bool {
    history_path(run_id)
        .and_then(|path| count_entries(&path))
        .map_or(true, |count| count == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(id: &str) -> WorkflowRun {
        let mut run = WorkflowRun::new(id.to_owned(), "wf_history".to_owned(), HashMap::new());
        run.state.insert("k".to_owned(), "v".to_owned());
        run
    }

    #[test]
    fn appends_lists_and_finds_checkpoints_in_order() {
        let id = format!("hist{}", uuid::Uuid::new_v4().simple());
        assert!(is_empty(&id));
        let mut r = run(&id);
        let first = append(&r, CheckpointEvent::RunStarted, None, 0)
            .unwrap()
            .unwrap();
        r.state.insert("k".to_owned(), "w".to_owned());
        let second = append(&r, CheckpointEvent::NodeCompleted, Some("a"), 1)
            .unwrap()
            .unwrap();
        assert_eq!(first.checkpoint_id, "cp-000000");
        assert_eq!(second.sequence, 1);
        let all = list(&id).unwrap();
        assert_eq!(all, vec![first.clone(), second.clone()]);
        assert_eq!(all[0].state["k"], "v", "snapshots are immutable");
        assert_eq!(find(&id, "cp-000001").unwrap(), Some(second));
        assert_eq!(find(&id, "cp-999999").unwrap(), None);
        assert!(!is_empty(&id));
    }

    #[test]
    fn torn_trailing_line_is_skipped() {
        let id = format!("histtorn{}", uuid::Uuid::new_v4().simple());
        let r = run(&id);
        append(&r, CheckpointEvent::RunStarted, None, 0).unwrap();
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(history_path(&id).unwrap())
            .unwrap();
        file.write_all(b"{\"checkpoint_id\":\"cp-0").unwrap();
        assert_eq!(list(&id).unwrap().len(), 1);
        // The next append starts on a fresh line and stays readable.
        let next = append(&r, CheckpointEvent::RunCompleted, None, 0)
            .unwrap()
            .unwrap();
        let all = list(&id).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[1], next);
    }

    #[test]
    fn lines_are_sealed_on_disk_and_bound_to_their_run_and_position() {
        let id = format!("histseal{}", uuid::Uuid::new_v4().simple());
        let mut r = run(&id);
        r.state
            .insert("secret".to_owned(), "hunter2-token".to_owned());
        append(&r, CheckpointEvent::RunStarted, None, 0).unwrap();
        append(&r, CheckpointEvent::RunCompleted, None, 0).unwrap();
        let path = history_path(&id).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("hunter2-token"), "{raw}");
        assert!(raw.lines().all(|line| line.starts_with("encb:")), "{raw}");
        assert_eq!(list(&id).unwrap().len(), 2);

        // A line moved to another position (or run) no longer opens.
        let lines: Vec<&str> = raw.lines().collect();
        std::fs::write(&path, format!("{}\n{}\n", lines[1], lines[0])).unwrap();
        assert!(list(&id).unwrap().is_empty());
        let other = format!("histother{}", uuid::Uuid::new_v4().simple());
        std::fs::write(history_path(&other).unwrap(), format!("{}\n", lines[0])).unwrap();
        assert!(list(&other).unwrap().is_empty());
    }

    #[test]
    fn legacy_plaintext_lines_are_read_and_resealed() {
        let id = format!("histlegacy{}", uuid::Uuid::new_v4().simple());
        let mut r = run(&id);
        r.state
            .insert("secret".to_owned(), "legacy-token".to_owned());
        let checkpoint = RunCheckpoint {
            checkpoint_id: checkpoint_id(0),
            sequence: 0,
            run_id: id.clone(),
            event: CheckpointEvent::RunStarted,
            node_id: None,
            iteration: 0,
            status: r.status,
            created_at: chrono::Utc::now().to_rfc3339(),
            state: r.state.clone(),
            nodes: r.nodes.clone(),
            output: r.output.clone(),
        };
        std::fs::create_dir_all(history_dir()).unwrap();
        let path = history_path(&id).unwrap();
        std::fs::write(
            &path,
            format!("{}\n", serde_json::to_string(&checkpoint).unwrap()),
        )
        .unwrap();
        assert_eq!(list(&id).unwrap(), vec![checkpoint.clone()]);

        // Another test's boot pass may seal this file first; either way it ends sealed.
        reseal_plaintext_histories();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("legacy-token"), "{raw}");
        assert_eq!(list(&id).unwrap(), vec![checkpoint]);
        // A second pass finds nothing left to seal in this file.
        assert!(!reseal_file(&path, &id).unwrap());
        // The next append continues the sequence.
        let next = append(&r, CheckpointEvent::RunCompleted, None, 0)
            .unwrap()
            .unwrap();
        assert_eq!(next.sequence, 1);
        assert_eq!(list(&id).unwrap().len(), 2);
    }

    #[test]
    fn dry_runs_and_bad_ids_record_nothing() {
        let id = format!("histdry{}", uuid::Uuid::new_v4().simple());
        let mut r = run(&id);
        r.dry_run = true;
        record(&r, CheckpointEvent::RunStarted, None, 0);
        assert!(list(&id).unwrap().is_empty());
        assert!(list("../escape").is_err());
    }
}
