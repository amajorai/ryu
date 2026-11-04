//! Owner-only scratch space for backup and restore staging inside the data dir.

use super::*;

/// `tmp/<owner>` scratch for backup and restore staging. It sits inside the data
/// dir (never the shared system temp dir), is owner-only, is skipped by node
/// snapshots (top-level `tmp`), and is emptied when the service opens so a crash
/// mid-job cannot leave staging behind.
const STAGING_OWNER: &str = "backups";

pub(crate) fn staging_root(root: &Path) -> PathBuf {
    ryu_sidecar_runtime::layout::tmp_dir_for(root, STAGING_OWNER)
}

/// A private (`0700`) per-job directory under [`staging_root`]. It holds only
/// ciphertext (`snapshot.ryubak`) and, briefly, SQLite snapshot copies; the
/// plaintext archive itself lives in an anonymous file (see [`plaintext_scratch`]).
pub(super) fn stage_dir(root: &Path, prefix: &str) -> Result<tempfile::TempDir> {
    let parent = staging_root(root);
    ryu_backup::archive::private_directory(&parent)?;
    let stage = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in(&parent)?;
    ryu_backup::archive::private_directory(stage.path())?;
    Ok(stage)
}

/// An anonymous, already-unlinked file for a plaintext archive: it has no path
/// another process can open, and the OS reclaims it when the handle closes,
/// including when Core is killed mid-job.
pub(super) fn plaintext_scratch(stage: &Path) -> Result<File> {
    Ok(tempfile::tempfile_in(stage)?)
}

/// Remove staging a previous process left behind (crash, kill or power loss):
/// everything under [`staging_root`] and any half-extracted `.ryu-restore-*`
/// directory under `state/backups/recovered`. Runs once, before any job starts.
pub(crate) fn sweep_stale_staging(root: &Path) {
    let staging = staging_root(root);
    if let Ok(entries) = std::fs::read_dir(&staging) {
        for entry in entries.flatten() {
            let path = entry.path();
            let removed = if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            if let Err(error) = removed {
                tracing::warn!(path = %path.display(), "could not remove stale backup staging: {error}");
            }
        }
    }
    let recovered = store::state_dir(root).join("recovered");
    if let Ok(entries) = std::fs::read_dir(&recovered) {
        for entry in entries.flatten() {
            let is_partial = entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(".ryu-restore-"));
            if is_partial && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                if let Err(error) = std::fs::remove_dir_all(entry.path()) {
                    tracing::warn!("could not remove a partial recovery directory: {error}");
                }
            }
        }
    }
}
