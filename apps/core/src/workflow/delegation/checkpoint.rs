//! Durable fan-out checkpoints: one sealed file per finished delegate.
// test-exempt: moved verbatim out of workflow/delegation.rs by the module split; covered by delegation/tests/checkpoints.rs.

use super::*;

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
pub(super) fn safe_segment(s: &str) -> anyhow::Result<&str> {
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
pub(super) fn checkpoint_root() -> std::path::PathBuf {
    crate::paths::state_path("fanout-checkpoints")
}

/// Compute the checkpoint directory for a fan-out step, validating all segments.
pub(super) fn checkpoint_dir(key: &FanoutCheckpointKey) -> anyhow::Result<std::path::PathBuf> {
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
    super::super::store::state_codec(KIND_FANOUT)?
        .encode(&checkpoint_record_id(key, delegate_id), json)
}

pub(super) fn decode_checkpoint(
    key: &FanoutCheckpointKey,
    delegate_id: &str,
    stored: &[u8],
) -> std::io::Result<Vec<u8>> {
    use ryu_durable::CheckpointCodec as _;
    super::super::store::state_codec(KIND_FANOUT)?
        .decode(&checkpoint_record_id(key, delegate_id), stored)
}

/// Load a persisted delegate result from its checkpoint file, if it exists.
/// A checkpoint that does not open is treated as absent (the delegate reruns),
/// and logged.
pub(super) fn load_delegate_checkpoint(
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
/// [`super::super::store::reseal_stored_workflows`]). A checkpoint holds a delegate's
/// output and is only read again while its run can still resume, so:
/// - the checkpoints of a run whose record is `Completed` are deleted (they are
///   never read again);
/// - every other plaintext checkpoint is rewritten sealed, same content;
/// - temporary files a crashed write left are removed.
///
/// Idempotent. Returns how many files were sealed or removed.
pub(crate) fn reseal_fanout_checkpoints() -> usize {
    reseal_fanout_checkpoints_in(&checkpoint_root(), |run_id| {
        super::super::store::load_run(run_id)
            .ok()
            .map(|run| run.status)
    })
}

pub(super) fn reseal_fanout_checkpoints_in(
    root: &std::path::Path,
    run_status: impl Fn(&str) -> Option<super::super::store::RunStatus>,
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
        if run_status(&run_id) == Some(super::super::store::RunStatus::Completed) {
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
