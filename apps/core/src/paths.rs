//! Centralized resolution of Ryu's data directory (the "data folder").
//!
//! Historically every store computed its own path as
//! `dirs::home_dir().join(".ryu").join(<file>)`, scattered across ~100 files.
//! This module is now the **single source of truth** so a user can relocate the
//! entire data folder (DBs, conversations, spaces, media, models, `bin/`) to
//! another disk via the desktop "Storage" setting.
//!
//! Resolution order (resolved once, then cached for the process lifetime — a
//! change requires a Core restart to take effect):
//!   1. env `RYU_DIR` — power users / headless / tests.
//!   2. the **pointer file** in the OS config dir (written by the Storage UI).
//!   3. the default `~/.ryu`.
//!
//! The pointer lives **outside** the data dir on purpose: the preferences DB is
//! *inside* the data dir, so it can't record its own location (chicken-and-egg).
//! This mirrors how Jan keeps `data_folder` in its app config, not in the data
//! folder itself.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Env var that overrides the data dir outright.
pub const RYU_DIR_ENV: &str = "RYU_DIR";

/// The default data dir: `~/.ryu` (falling back to `./.ryu` if home is unknown).
pub fn default_ryu_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ryu")
}

/// Directory holding the bootstrap pointer file. Lives in the OS *config* dir
/// (`%APPDATA%\ryu` on Windows, `~/.config/ryu` on Linux, `~/Library/Application
/// Support/ryu` on macOS), NOT inside the data dir.
fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(default_ryu_dir)
        .join("ryu")
}

/// Path to the data-path pointer file (`<config>/ryu/data-path.json`).
pub fn pointer_path() -> PathBuf {
    config_dir().join("data-path.json")
}

/// Bootstrap pointer persisted outside the data dir.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct DataPathPointer {
    /// Absolute path of the active data dir. `None`/absent ⇒ use the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
}

/// Read the pointer file; returns the default (empty) pointer if absent/unparseable.
pub fn read_pointer() -> DataPathPointer {
    let Ok(bytes) = std::fs::read(pointer_path()) else {
        return DataPathPointer::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

/// Persist the pointer file (creating the config dir if needed).
pub fn write_pointer(pointer: &DataPathPointer) -> std::io::Result<()> {
    let path = pointer_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(pointer).map_err(std::io::Error::other)?;
    std::fs::write(&path, json)
}

/// Set (or clear, with `None`) the active data dir in the pointer file. Takes
/// effect on the next Core start.
pub fn set_data_dir(dir: Option<&Path>) -> std::io::Result<()> {
    write_pointer(&DataPathPointer {
        data_dir: dir.map(|d| d.to_string_lossy().into_owned()),
    })
}

fn resolve() -> PathBuf {
    if let Some(v) = std::env::var_os(RYU_DIR_ENV) {
        let p = PathBuf::from(v);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    if let Some(dir) = read_pointer().data_dir {
        let p = PathBuf::from(dir);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    default_ryu_dir()
}

static RYU_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The active data dir, resolved once and cached for the process lifetime.
pub fn ryu_dir() -> PathBuf {
    RYU_DIR.get_or_init(resolve).clone()
}

/// True when the active data dir differs from the default (user-relocated).
pub fn is_custom() -> bool {
    ryu_dir() != default_ryu_dir()
}

// ── Sizing / free space (used by the data-path API + relocate validation) ────────

/// Recursively sum the byte size of a directory tree. Best-effort: unreadable
/// entries are skipped; returns 0 if `path` doesn't exist.
pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    walk_size(path, &mut total);
    total
}

fn walk_size(path: &Path, acc: &mut u64) {
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            walk_size(&entry.path(), acc);
        } else {
            *acc += meta.len();
        }
    }
}

/// Bytes available on the filesystem that would contain `path`. Picks the disk
/// whose mount point is the longest prefix of `path`. Returns 0 if undeterminable.
/// Works for not-yet-existing paths (the comparison is lexical against mounts).
pub fn available_space_for(path: &Path) -> u64 {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    let mut best: Option<(usize, u64)> = None;
    for disk in disks.list() {
        let mount = disk.mount_point();
        if path.starts_with(mount) {
            let len = mount.as_os_str().len();
            if best.is_none_or(|(b, _)| len > b) {
                best = Some((len, disk.available_space()));
            }
        }
    }
    best.map_or(0, |(_, s)| s)
}

/// Best-effort canonicalization that tolerates a not-yet-existing leaf: it
/// canonicalizes the longest existing ancestor and re-appends the remainder.
pub fn canonical_ish(path: &Path) -> PathBuf {
    if let Ok(c) = std::fs::canonicalize(path) {
        return c;
    }
    let mut ancestor = path;
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    while let Some(parent) = ancestor.parent() {
        if let Some(name) = ancestor.file_name() {
            tail.push(name);
        }
        if let Ok(c) = std::fs::canonicalize(parent) {
            let mut out = c;
            for name in tail.iter().rev() {
                out.push(name);
            }
            return out;
        }
        ancestor = parent;
    }
    path.to_path_buf()
}

/// True if either path is the same as or contained within the other — used to
/// reject relocating a data dir into itself (which would copy forever).
pub fn paths_overlap(a: &Path, b: &Path) -> bool {
    let a = canonical_ish(a);
    let b = canonical_ish(b);
    a.starts_with(&b) || b.starts_with(&a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_dir_ends_with_dot_ryu() {
        assert!(default_ryu_dir().ends_with(".ryu"));
    }

    #[test]
    fn pointer_roundtrips() {
        let p = DataPathPointer {
            data_dir: Some("D:/somewhere/ryu".to_string()),
        };
        let json = serde_json::to_string(&p).unwrap();
        let back: DataPathPointer = serde_json::from_str(&json).unwrap();
        assert_eq!(back.data_dir.as_deref(), Some("D:/somewhere/ryu"));
    }

    #[test]
    fn empty_pointer_serializes_without_data_dir() {
        let json = serde_json::to_string(&DataPathPointer::default()).unwrap();
        assert_eq!(json, "{}");
    }

    #[test]
    fn overlap_detects_nesting() {
        let base = std::env::temp_dir();
        let parent = base.join("ryu-overlap-parent");
        let child = parent.join("child");
        assert!(paths_overlap(&parent, &child));
        assert!(paths_overlap(&child, &parent));
        let sibling = base.join("ryu-overlap-sibling");
        assert!(!paths_overlap(&parent, &sibling));
    }
}
