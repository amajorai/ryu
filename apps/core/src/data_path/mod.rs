//! Data-folder relocation, backup (export) and restore (import).
//!
//! The *destructive* operations (copy/move a relocation, restore an import) must
//! run while **no store has its SQLite files open** — copying a live `.db` (plus
//! its `-wal`/`-shm`) corrupts it. So those run as a one-shot CLI subcommand
//! (`ryu-core data-path …`) that the desktop invokes while Core is stopped, then
//! restarts Core (which re-resolves [`crate::paths::ryu_dir`] from the pointer
//! file). Export (read-only zip) is safe to run online and is exposed on the API.
//!
//! All path *logic* lives here in Core per the Core-vs-Gateway rule — the desktop
//! only orchestrates stop → run subcommand (with progress) → restart.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::paths;
use ryu_sidecar_runtime::layout;

mod archive;
mod archive_key;
mod backup_exclusions;
mod clean;
mod cli;
mod copy;
mod export;
mod import;
mod key_bundle;
mod restore;
#[cfg(test)]
mod tests;

pub(crate) use self::archive_key::EXPORT_MIN_PASSPHRASE_CHARS;
pub(crate) use self::backup_exclusions::is_backup_excluded;
pub use self::clean::{auxiliary_roots, clean_profile_data, deep_clean, CleanDepth};
pub use self::cli::{is_known_profile_arg, run_cli};
pub use self::copy::{copy_profile, is_profile_copy_excluded, migrate};
pub use self::export::export_zip;
pub use self::import::import_zip;
use self::{archive::*, archive_key::*, backup_exclusions::*, key_bundle::*, restore::*};

/// Snapshot of the data folder for the desktop "Storage" setting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataPathInfo {
    /// The active data dir.
    pub current: String,
    /// The default (`~/.ryu`) — shown so the user can reset.
    pub default: String,
    /// True when `current` differs from `default`.
    pub is_custom: bool,
    /// Bytes the current data folder occupies on disk.
    pub size_bytes: u64,
    /// Bytes free on the filesystem that holds the current data folder.
    pub free_space_bytes: u64,
}

/// Build the current data-path snapshot.
pub fn info() -> DataPathInfo {
    let current = paths::ryu_dir();
    let default = paths::default_ryu_dir();
    DataPathInfo {
        is_custom: current != default,
        size_bytes: paths::dir_size(&current),
        free_space_bytes: paths::available_space_for(&current),
        current: current.to_string_lossy().into_owned(),
        default: default.to_string_lossy().into_owned(),
    }
}

/// Result of validating a relocation/import target.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidateResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Size of the source data folder (what a copy would move).
    pub source_size_bytes: u64,
    /// Free space at the target.
    pub target_free_bytes: u64,
}

/// Validate that `target` is a usable destination for a relocation that will copy
/// `source` into it. Pass `require_space=false` for a point-only switch.
pub fn validate_target(source: &Path, target: &Path, require_space: bool) -> ValidateResult {
    let source_size_bytes = paths::dir_size(source);
    let target_free_bytes = paths::available_space_for(target);

    let err = check_target(
        source,
        target,
        source_size_bytes,
        target_free_bytes,
        require_space,
    );
    ValidateResult {
        ok: err.is_none(),
        error: err,
        source_size_bytes,
        target_free_bytes,
    }
}

fn check_target(
    source: &Path,
    target: &Path,
    source_size: u64,
    target_free: u64,
    require_space: bool,
) -> Option<String> {
    if target.as_os_str().is_empty() {
        return Some("Target path is empty.".to_string());
    }
    if !target.is_absolute() {
        return Some("Target path must be absolute.".to_string());
    }
    // Reject nesting in either direction — copying a folder into itself loops.
    if paths::paths_overlap(source, target) {
        return Some(
            "Target cannot be inside the current data folder (or vice versa).".to_string(),
        );
    }
    // Target must be empty or non-existent (don't clobber an unrelated folder).
    if let Ok(mut entries) = std::fs::read_dir(target) {
        if entries.next().is_some() {
            return Some("Target folder is not empty.".to_string());
        }
    }
    // Probe writability by creating (and removing) the dir.
    if let Err(e) = std::fs::create_dir_all(target) {
        return Some(format!("Target is not writable: {e}"));
    }
    if require_space && target_free > 0 && target_free < source_size {
        return Some(format!(
            "Not enough free space: need {}, have {}.",
            human_bytes(source_size),
            human_bytes(target_free)
        ));
    }
    None
}

fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    format!("{v:.1} {}", UNITS[i])
}

// ── Progress ─────────────────────────────────────────────────────────────────────

/// A progress tick emitted to stdout (one JSON line) during a CLI operation so the
/// desktop can render a bar.
#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub phase: &'static str,
    pub copied_bytes: u64,
    pub total_bytes: u64,
}

fn emit(progress: &Progress) {
    if let Ok(line) = serde_json::to_string(progress) {
        println!("@@PROGRESS {line}");
        let _ = std::io::stdout().flush();
    }
}
