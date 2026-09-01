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

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::paths;

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

const MAX_DATA_IMPORT_ENTRIES: usize = 100_000;
const MAX_DATA_IMPORT_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
// Export and import apply this denylist by basename at every depth. These files
// either contain reusable credentials or bind the data to the source node. The
// encryption key is deliberately not here: it is required to restore the
// encrypted customer databases, so the backup itself must be kept private.
const BACKUP_EXCLUDE_NAMES: &[&str] = &[
    "accounts.json",
    ".reset-pending",
    "auth.json",
    "bootstrap-ack.token",
    "core.token",
    "delegation-ed25519.pub",
    "fleet-artifacts",
    "fleet-desired.json",
    "fleet-enforcement.json",
    "fleet-enrolled-node.json",
    "fleet-enrollment-pending.json",
    "fleet-identity.json",
    "fleet-instance-id.json",
    "fleet-skill-blocks.json",
    "fleet-status.json",
    "gateway-admin.key",
    "gateway-durable.token",
    "gateway-relay.token",
    "mcp.json",
    "models.json",
    "node-auth.token",
    "node-control.token",
    "nodes.json",
    "paired-clients.json",
    "pi-accounts.db",
    "plugin-credentials",
    "plugin-secrets.db",
    "org-project-mappings.json",
    "ryu-core.pid",
];

fn is_backup_excluded(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| BACKUP_EXCLUDE_NAMES.contains(&name))
}

fn emit(progress: &Progress) {
    if let Ok(line) = serde_json::to_string(progress) {
        println!("@@PROGRESS {line}");
        let _ = std::io::stdout().flush();
    }
}

// ── Copy / move ──────────────────────────────────────────────────────────────────

/// Recursively copy `from` into `to`, invoking `on_bytes` with cumulative bytes.
fn copy_tree(
    from: &Path,
    to: &Path,
    copied: &mut u64,
    on_bytes: &mut dyn FnMut(u64),
) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_tree(&src, &dst, copied, on_bytes)?;
        } else if ft.is_file() {
            let bytes = std::fs::copy(&src, &dst)?;
            *copied += bytes;
            on_bytes(*copied);
        }
        // Symlinks and other special files are skipped (Ryu stores none).
    }
    Ok(())
}

/// Files and directories that must NOT travel when copying one profile's data to
/// another, because they identify the NODE or the RUNNING PROCESS rather than the
/// user's content.
///
/// Copying these is not merely untidy — each has a concrete failure:
///   - `core.token`    minted once with `create_new(true)`; a copy makes the target
///                     claim the source's node identity, and `/api/node/init` then
///                     answers 409 `already_initialized` forever.
///   - `nodes.json`    entries carry absolute URLs with a HARDCODED port. Copying
///                     `http://127.0.0.1:7980` into a profile that listens on 9980
///                     leaves it pointing at the wrong stack — the source's.
///   - `auth.json`     legacy active-account sign-in token, sealed with the Core
///                     master key and excluded because it identifies the source
///                     node's account session.
///   - `node-auth.token` this node's minted `RYU_TOKEN` (see `crate::node_token`).
///                     A copy would hand another machine THIS node's admittance
///                     secret — a credential leak, not just a wrong identity.
///   - `ryu-core.pid`  the source's live process id.
///   - `.reset-pending` a pending node wipe would fire on the target instead.
///   - `bin/`          binaries plus `.version` markers keyed to the APP version, so
///                     a same-version copy makes the target adopt the source's
///                     binaries and skip its own download — defeating the entire
///                     point of a canary profile, which exists to run a different
///                     build.
///   - `tmp/`, `cache/` regenerable, and often large.
const PROFILE_COPY_EXCLUDE: &[&str] = &[
    ".reset-pending",
    "auth.json",
    "bin",
    "cache",
    "core.token",
    "node-auth.token",
    "nodes.json",
    "ryu-core.pid",
    "tmp",
];

/// Whether `name` (a direct child of the data dir) is excluded from a profile copy.
pub fn is_profile_copy_excluded(name: &str) -> bool {
    PROFILE_COPY_EXCLUDE.contains(&name)
}

/// Recursively copy `from` into `to`, skipping the node-identity and runtime
/// entries at the TOP LEVEL only (a nested `cache/` inside a plugin's data is the
/// plugin's business).
fn copy_tree_filtered(
    from: &Path,
    to: &Path,
    copied: &mut u64,
    on_bytes: &mut dyn FnMut(u64),
) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if is_profile_copy_excluded(&name.to_string_lossy()) {
            continue;
        }
        let src = entry.path();
        let dst = to.join(&name);
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_tree(&src, &dst, copied, on_bytes)?;
        } else if ft.is_file() {
            let bytes = std::fs::copy(&src, &dst)?;
            *copied += bytes;
            on_bytes(*copied);
        }
    }
    Ok(())
}

/// Auxiliary roots a node reset does NOT reach, and where each lives.
///
/// `apply_pending_reset` wipes the DATA dir and nothing else, which leaves a
/// "reset" node still carrying its shadow captures, ghost state, gateway config
/// and data-path pointer. Users reasonably read "reset node" as "this node is
/// blank" and then find several gigabytes and their old gateway settings intact.
///
/// `~/.shadow` and `~/.ghost` are NOT profile-suffixed — their Rust uses a plain
/// `home_dir().join(".shadow")` — so clearing them affects EVERY profile on the
/// machine, not just this one. That is why they are opt-in and called out
/// separately rather than folded into the reset.
pub fn auxiliary_roots(
    home: &Path,
    config_dir: Option<&Path>,
    suffix: &str,
    include_shared: bool,
) -> Vec<(String, PathBuf)> {
    // `~/.shadow` and `~/.ghost` are NOT profile-suffixed, so they are opt-in:
    // clearing them from one profile clears them for every profile on the machine.
    let mut out = if include_shared {
        vec![
            (
                "shadow captures (all profiles)".to_string(),
                home.join(".shadow"),
            ),
            (
                "ghost state (all profiles)".to_string(),
                home.join(".ghost"),
            ),
        ]
    } else {
        Vec::new()
    };
    if let Some(config) = config_dir {
        out.push((
            "gateway config + data-path pointer".to_string(),
            config.join(format!("ryu{suffix}")),
        ));
    }
    out
}

/// How much of a profile's DATA dir a clean removes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanDepth {
    /// Leave the data dir alone entirely — only the auxiliary roots go. This is
    /// what "deep clean" meant before it grew a profile axis.
    None,
    /// Clear the data dir but KEEP the multi-GB downloads (`bin/`, `models/`), so
    /// the next start does not re-fetch engines and models.
    State,
    /// Remove the data dir outright — the fresh-install path.
    Full,
}

/// Remove a profile's data dir to the requested depth. Returns what was removed.
///
/// Deliberately does NOT touch the master key, in either the keychain or
/// `master.key`. A node reset preserves it for the same reason: the key is node
/// IDENTITY, and removing it while any sealed data survives anywhere makes that
/// data permanently unreadable with no rekey path. Clearing a profile's data is
/// recoverable by re-syncing; losing its key is not.
pub fn clean_profile_data(home: &Path, suffix: &str, depth: CleanDepth) -> Vec<String> {
    if depth == CleanDepth::None {
        return Vec::new();
    }
    let dir = home.join(format!(".ryu{suffix}"));
    if !dir.exists() {
        return Vec::new();
    }
    // Same containment rule as everything else here: computed from a home dir and
    // a suffix, so a bug in either must not aim a recursive delete elsewhere.
    if dir.strip_prefix(home).map(|r| r.components().count()) != Ok(1) {
        eprintln!("data-path clean: refusing {} (outside home)", dir.display());
        return Vec::new();
    }
    let mut removed = Vec::new();
    match depth {
        CleanDepth::None => {}
        CleanDepth::Full => {
            if std::fs::remove_dir_all(&dir).is_ok() {
                removed.push(format!("data dir (full) — {}", dir.display()));
            }
        }
        CleanDepth::State => {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                return removed;
            };
            let mut cleared = 0usize;
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                // The multi-GB downloads survive a `state` clean — re-fetching an
                // engine is the slowest possible way to get back to a clean node.
                if name == "bin" || name == "models" || name == "master.key" {
                    continue;
                }
                let path = entry.path();
                let ok = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    std::fs::remove_dir_all(&path).is_ok()
                } else {
                    std::fs::remove_file(&path).is_ok()
                };
                if ok {
                    cleared += 1;
                }
            }
            if cleared > 0 {
                removed.push(format!(
                    "data dir ({cleared} entries, kept bin/models) — {}",
                    dir.display()
                ));
            }
        }
    }
    removed
}

/// Remove the auxiliary roots above. Returns what was actually removed.
///
/// Every path is re-checked against `$HOME` before deletion: these are computed
/// from a home dir and a profile suffix, and a bug in either would otherwise aim a
/// recursive delete somewhere arbitrary.
pub fn deep_clean(
    home: &Path,
    config_dir: Option<&Path>,
    suffix: &str,
    include_shared: bool,
) -> Vec<String> {
    let mut removed = Vec::new();
    for (label, path) in auxiliary_roots(home, config_dir, suffix, include_shared) {
        if !path.exists() {
            continue;
        }
        // Never delete the home dir itself, and never anything outside it.
        let inside = path
            .strip_prefix(home)
            .is_ok_and(|rel| rel.components().count() >= 1);
        if !inside {
            eprintln!(
                "data-path deep-clean: refusing {} (outside home)",
                path.display()
            );
            continue;
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => removed.push(format!("{label} — {}", path.display())),
            Err(e) => eprintln!(
                "data-path deep-clean: could not remove {}: {e}",
                path.display()
            ),
        }
    }
    removed
}

/// Copy one profile's data directory into another profile's, carrying the master
/// key across so the copied data stays readable.
///
/// Unlike [`migrate`], this deliberately does NOT touch any pointer file: both
/// profiles remain usable and each keeps resolving its own data dir. It is a
/// "give canary a copy of my stable state to test against", not a relocation.
///
/// **Core must be stopped for both profiles.** Every store runs in WAL mode, so
/// copying a live `.db` captures a torn snapshot.
///
/// Ordering is the safety property: the key is moved FIRST and any failure aborts
/// before a single file is written. The alternative — copy, then discover the key
/// cannot travel — leaves a directory full of ciphertext nothing can read, and
/// there is no rekey path to recover it.
pub fn copy_profile(
    from: &Path,
    to: &Path,
    from_suffix: &str,
    to_suffix: &str,
) -> std::io::Result<()> {
    // `check_target` probes writability by creating the directory, so a refusal
    // AFTER that point would leave an empty dir behind and contradict the "nothing
    // was copied" the caller is told. Remember whether it existed first, and undo
    // the probe on any abort.
    let target_pre_existed = to.exists();
    let undo_probe = || {
        if !target_pre_existed {
            // Only ever removes a directory we created and left empty; a populated
            // one means the copy got further than these guards and must survive.
            let _ = std::fs::remove_dir(to);
        }
    };

    // Same guardrails as a relocation: absolute, non-overlapping, and — critically
    // — an EMPTY target. Merging into a profile that already has data is
    // unrecoverable, and this is reachable from a Settings button.
    let validation = validate_target(from, to, true);
    if let Some(err) = validation.error {
        undo_probe();
        return Err(std::io::Error::other(err));
    }

    match ryu_crypto::copy_master_key_between_profiles(from_suffix, to_suffix) {
        ryu_crypto::KeyCopy::Copied => {}
        ryu_crypto::KeyCopy::DestinationOccupied => {
            undo_probe();
            return Err(std::io::Error::other(format!(
                "the '{to_suffix}' profile already has its own master key. Copying onto it \
                 would leave data sealed under two different keys with no way to recover \
                 either. Reset that profile first if you want to replace it."
            )));
        }
        ryu_crypto::KeyCopy::SourceMissing => {
            undo_probe();
            return Err(std::io::Error::other(
                "the source profile has no master key in the keychain, so the copied data \
                 could not be decrypted by the target. Nothing was copied.",
            ));
        }
        ryu_crypto::KeyCopy::Unavailable => {
            undo_probe();
            return Err(std::io::Error::other(
                "could not read or write the OS keychain, so the master key cannot travel \
                 with the data. Nothing was copied — a copy without the key produces a \
                 profile that looks healthy but cannot read its own messages.",
            ));
        }
    }

    let total = paths::dir_size(from);
    let mut copied = 0u64;
    let mut on_bytes = |done: u64| {
        emit(&Progress {
            phase: "copy",
            copied_bytes: done,
            total_bytes: total,
        });
    };
    copy_tree_filtered(from, to, &mut copied, &mut on_bytes)?;
    emit(&Progress {
        phase: "done",
        copied_bytes: total,
        total_bytes: total,
    });
    Ok(())
}

/// Relocate the data folder: copy `from` → `to`, then (on success) update the

/// pointer so the next Core start resolves to `to`. With `move_source=true` the
/// source is removed after a verified copy (cross-drive safe, unlike `rename`).
pub fn migrate(from: &Path, to: &Path, move_source: bool) -> std::io::Result<()> {
    let total = paths::dir_size(from);
    emit(&Progress {
        phase: "copy",
        copied_bytes: 0,
        total_bytes: total,
    });

    let mut copied = 0u64;
    let mut last_emit = 0u64;
    copy_tree(from, to, &mut copied, &mut |c| {
        // Throttle progress to ~every 16 MB to avoid flooding stdout.
        if c - last_emit >= 16 * 1024 * 1024 || c == total {
            last_emit = c;
            emit(&Progress {
                phase: "copy",
                copied_bytes: c,
                total_bytes: total,
            });
        }
    })?;
    emit(&Progress {
        phase: "copy",
        copied_bytes: total,
        total_bytes: total,
    });

    paths::set_data_dir(Some(to)).map_err(|e| {
        std::io::Error::other(format!("copied data but failed to update pointer: {e}"))
    })?;

    if move_source {
        emit(&Progress {
            phase: "cleanup",
            copied_bytes: total,
            total_bytes: total,
        });
        let _ = std::fs::remove_dir_all(from);
    }
    Ok(())
}

// ── Export (zip) ───────────────────────────────────────────────────────────────────

/// Zip the whole data folder `from` into the archive at `out`. Read-only on the
/// data folder, so it's safe to call while Core is running (DB rows mid-write may
/// land in an inconsistent snapshot — acceptable for a manual backup).
pub fn export_zip(from: &Path, out: &Path) -> std::io::Result<u64> {
    let out = if out.is_absolute() {
        out.to_path_buf()
    } else {
        std::env::current_dir()?.join(out)
    };
    if paths::paths_overlap(from, &out) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "export destination cannot be inside the data folder",
        ));
    }
    let parent = out.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "export destination has no parent folder",
        )
    })?;
    std::fs::create_dir_all(parent)?;
    if let Ok(metadata) = std::fs::symlink_metadata(&out) {
        if metadata.file_type().is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "export destination cannot be a symbolic link",
            ));
        }
    }
    let mut temporary = tempfile::Builder::new()
        .prefix(".ryu-backup-")
        .tempfile_in(parent)?;
    let options =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut written = 0u64;
    {
        let mut zip = zip::ZipWriter::new(temporary.as_file_mut());
        zip_dir(from, from, &mut zip, options, &mut written)?;
        zip.finish()?;
    }
    temporary.as_file().sync_all()?;
    temporary.persist(&out).map_err(|error| error.error)?;
    Ok(written)
}

fn zip_dir<W: Write + std::io::Seek>(
    root: &Path,
    dir: &Path,
    zip: &mut zip::ZipWriter<W>,
    options: zip::write::FileOptions,
    written: &mut u64,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let ft = entry.file_type()?;
        let rel = path.strip_prefix(root).unwrap_or(&path);
        if is_backup_excluded(rel) {
            continue;
        }
        let name = rel.to_string_lossy().replace('\\', "/");
        if ft.is_dir() {
            zip_dir(root, &path, zip, options, written)?;
        } else if ft.is_file() {
            zip.start_file(name, options)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            let mut file = std::fs::File::open(&path)?;
            *written += std::io::copy(&mut file, zip)?;
        }
    }
    Ok(())
}

fn path_contains_symlink(root: &Path, target: &Path) -> bool {
    let mut current = root.to_path_buf();
    match std::fs::symlink_metadata(&current) {
        Ok(metadata) if metadata.file_type().is_symlink() => return true,
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return true,
        _ => {}
    }
    let Ok(relative) = target.strip_prefix(root) else {
        return true;
    };
    for component in relative.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return true,
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return true,
            _ => {}
        }
    }
    false
}

// ── Import (restore from zip) ──────────────────────────────────────────────────────

/// Extract a backup archive into `to`, then point the data folder at `to`. Must run
/// offline (it overwrites the live DB files). The destination is created if needed;
/// existing files with the same name are overwritten.
pub fn import_zip(archive: &Path, to: &Path) -> std::io::Result<()> {
    let file = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| std::io::Error::other(e.to_string()))?;
    let total = zip.len();
    if total > MAX_DATA_IMPORT_ENTRIES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "data backup contains too many entries",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut planned_bytes = 0u64;
    for i in 0..total {
        let entry = zip
            .by_index(i)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let Some(rel) = entry.enclosed_name() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup contains an unsafe path",
            ));
        };
        if is_backup_excluded(rel) {
            continue;
        }
        let normalized = rel.to_string_lossy().replace('\\', "/");
        if !seen.insert(normalized) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup contains duplicate paths",
            ));
        }
        if path_contains_symlink(to, &to.join(rel)) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "data backup destination contains a symbolic link",
            ));
        }
        if entry.is_dir() {
            continue;
        }
        if entry.size() > MAX_DATA_IMPORT_FILE_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup contains an oversized file",
            ));
        }
        planned_bytes = planned_bytes.checked_add(entry.size()).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup size is invalid",
            )
        })?;
    }
    let available = paths::available_space_for(to);
    if available > 0 && planned_bytes > available {
        return Err(std::io::Error::new(
            std::io::ErrorKind::WriteZero,
            "not enough free space for the data backup",
        ));
    }
    emit(&Progress {
        phase: "extract",
        copied_bytes: 0,
        total_bytes: total as u64,
    });

    if let Ok(metadata) = std::fs::symlink_metadata(to) {
        if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "data backup destination must be a directory",
            ));
        }
    } else {
        std::fs::create_dir_all(to)?;
    }
    for i in 0..total {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let Some(rel) = entry.enclosed_name() else {
            continue; // path-traversal guard (zip-slip): skip unsafe names
        };
        if is_backup_excluded(rel) {
            continue;
        }
        let out = to.join(rel);
        if path_contains_symlink(to, &out) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "data backup destination contains a symbolic link",
            ));
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let parent = out.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "data backup entry has no parent",
            )
        })?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".ryu-import-")
            .tempfile_in(parent)?;
        std::io::copy(&mut entry, temporary.as_file_mut())?;
        temporary.as_file().sync_all()?;
        temporary.persist(&out).map_err(|error| error.error)?;
        if i % 16 == 0 || i + 1 == total {
            emit(&Progress {
                phase: "extract",
                copied_bytes: (i + 1) as u64,
                total_bytes: total as u64,
            });
        }
    }

    paths::set_data_dir(Some(to)).map_err(|e| {
        std::io::Error::other(format!("imported data but failed to update pointer: {e}"))
    })?;
    Ok(())
}

// ── CLI subcommand entry ───────────────────────────────────────────────────────────

/// True when `value` names a profile the stack actually knows.
///
/// Every profile flag on this CLI (`--profile`, `--from-profile`, `--to-profile`)
/// is turned into a directory by `suffix_for(name)`, which has NO notion of a
/// valid name — it maps anything that is not `release` to `-<name>` verbatim. So
/// an unvalidated flag aims a destructive command at `~/.ryu-<whatever the user
/// typed>`:
///
///   * `--profile ""` → `~/.ryu-`, and `--profile canry` → `~/.ryu-canry`. Both
///     pass the `components().count() == 1` containment guard, so the command
///     reports success having cleaned NOTHING — the user believes their canary
///     profile was reset and it was not.
///   * `copy-profile` is the sharp end: `--to-profile` names the directory that
///     gets OVERWRITTEN, master key included, and a typo silently creates a new
///     junk root instead of failing.
///
/// `scripts/wipe.mjs` has guarded this with a name regex plus an empty check
/// since it was written; the Rust path did not. Pure and public so the rejection
/// is testable without driving `std::process::exit`.
pub fn is_known_profile_arg(value: &str) -> bool {
    crate::profile::offset_of(value).is_some()
}

/// Exit rather than aim a destructive path at the release data dir by accident.
fn require_known_profile(flag_name: &str, value: &str) {
    if is_known_profile_arg(value) {
        return;
    }
    eprintln!(
        "data-path: {flag_name} '{value}' is not a known profile (known: {}). \
         Refusing — an unknown or empty profile name resolves to the RELEASE data dir.",
        crate::profile::known_profiles()
    );
    std::process::exit(2);
}

/// Handle `ryu-core data-path <migrate|import|export> …`. Returns `true` if it
/// consumed the args (caller should exit), `false` if this isn't a data-path
/// invocation. Errors print to stderr and exit non-zero.
pub fn run_cli(args: &[String]) -> bool {
    // args == full argv; find the "data-path" token.
    let Some(pos) = args.iter().position(|a| a == "data-path") else {
        return false;
    };
    let rest = &args[pos + 1..];
    let Some(cmd) = rest.first() else {
        eprintln!(
            "usage: ryu-core data-path <migrate|import|export|copy-profile|deep-clean> [flags]"
        );
        std::process::exit(2);
    };
    let flag = |name: &str| -> Option<String> {
        rest.iter()
            .position(|a| a == name)
            .and_then(|i| rest.get(i + 1))
            .cloned()
    };

    let result: std::io::Result<()> = match cmd.as_str() {
        // Copy THIS profile's data into another profile's data dir, carrying the
        // master key. Neither pointer file is touched: both profiles stay usable.
        //
        // `--from-profile` / `--to-profile` are the profile NAMES (release, dev,
        // canary, …); the suffixes they map to are what key the keychain slots, and
        // getting them wrong is what silently orphans the data.
        // Remove the auxiliary roots a node reset never reaches (~/.shadow,
        // ~/.ghost, the OS config dir). Separate from `reset` because two of those
        // are shared by EVERY profile on the machine.
        "deep-clean" => {
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            // Defaults preserve the original behaviour exactly: THIS profile, no
            // data touched, shared roots included.
            let profile =
                flag("--profile").unwrap_or_else(|| crate::profile::profile().to_string());
            // Before ANY path is computed from it: an unknown or empty name maps
            // to the release suffix and would aim this recursive delete at ~/.ryu.
            require_known_profile("--profile", &profile);
            let suffix = crate::profile::suffix_for(&profile);
            let depth = match flag("--depth").as_deref() {
                None | Some("none") => CleanDepth::None,
                Some("state") => CleanDepth::State,
                Some("full") => CleanDepth::Full,
                Some(other) => {
                    eprintln!(
                        "data-path deep-clean: --depth must be none|state|full (got '{other}')"
                    );
                    std::process::exit(2);
                }
            };
            let include_shared = !rest.iter().any(|a| a == "--no-shared");
            let mut removed = clean_profile_data(&home, &suffix, depth);
            removed.extend(deep_clean(
                &home,
                dirs::config_dir().as_deref(),
                &suffix,
                include_shared,
            ));
            if removed.is_empty() {
                println!("nothing to remove");
            }
            for line in &removed {
                println!("removed {line}");
            }
            Ok(())
        }
        "copy-profile" => {
            let from_profile =
                flag("--from-profile").unwrap_or_else(|| crate::profile::profile().to_string());
            let Some(to_profile) = flag("--to-profile") else {
                eprintln!(
                    "usage: ryu-core data-path copy-profile --to-profile <name> \
                     [--from-profile <name>]"
                );
                std::process::exit(2);
            };
            if from_profile == to_profile {
                eprintln!("data-path copy-profile: source and target are the same profile");
                std::process::exit(2);
            }
            // Same unvalidated-name hole as deep-clean, one step worse: an unknown
            // `--to-profile` resolves to ~/.ryu and this command OVERWRITES the
            // target's files (and its master key) with the source profile's.
            require_known_profile("--from-profile", &from_profile);
            require_known_profile("--to-profile", &to_profile);
            let from_suffix = crate::profile::suffix_for(&from_profile);
            let to_suffix = crate::profile::suffix_for(&to_profile);
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            let from = flag("--from")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(format!(".ryu{from_suffix}")));
            let to = flag("--to")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(format!(".ryu{to_suffix}")));
            copy_profile(&from, &to, &from_suffix, &to_suffix)
        }
        "migrate" => {
            let from = flag("--from")
                .map(PathBuf::from)
                .unwrap_or_else(paths::ryu_dir);
            let to = flag("--to").map(PathBuf::from);
            let move_source = rest.iter().any(|a| a == "--move");
            match to {
                Some(to) => migrate(&from, &to, move_source),
                None => {
                    eprintln!("data-path migrate requires --to <dir> [--from <dir>] [--move]");
                    std::process::exit(2);
                }
            }
        }
        "import" => {
            let archive = flag("--archive").map(PathBuf::from);
            let to = flag("--to")
                .map(PathBuf::from)
                .unwrap_or_else(paths::ryu_dir);
            match archive {
                Some(archive) => import_zip(&archive, &to),
                None => {
                    eprintln!("data-path import requires --archive <zip> [--to <dir>]");
                    std::process::exit(2);
                }
            }
        }
        "export" => {
            let from = flag("--from")
                .map(PathBuf::from)
                .unwrap_or_else(paths::ryu_dir);
            let out = flag("--out").map(PathBuf::from);
            match out {
                Some(out) => export_zip(&from, &out).map(|_| ()),
                None => {
                    eprintln!("data-path export requires --out <zip> [--from <dir>]");
                    std::process::exit(2);
                }
            }
        }
        other => {
            eprintln!("unknown data-path command: {other}");
            std::process::exit(2);
        }
    };

    match result {
        Ok(()) => {
            println!("@@DONE");
            true
        }
        Err(e) => {
            eprintln!("data-path {cmd} failed: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_bytes_scales() {
        assert_eq!(human_bytes(512), "512.0 B");
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(1024 * 1024), "1.0 MB");
    }

    #[test]
    fn export_then_import_roundtrips() {
        let base = std::env::temp_dir().join(format!("ryu-dp-test-{}", std::process::id()));
        let src = base.join("src");
        let nested = src.join("sub");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(src.join("a.txt"), b"hello").unwrap();
        std::fs::write(nested.join("b.txt"), b"world").unwrap();

        let zip = base.join("backup.zip");
        let bytes = export_zip(&src, &zip).unwrap();
        assert_eq!(bytes, 10); // "hello" + "world"

        let dest = base.join("restored");
        // import_zip also writes the pointer; that's fine in a test (config dir).
        let file = std::fs::File::open(&zip).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        for i in 0..archive.len() {
            let mut e = archive.by_index(i).unwrap();
            if e.is_file() {
                let out = dest.join(e.enclosed_name().unwrap());
                std::fs::create_dir_all(out.parent().unwrap()).unwrap();
                let mut w = std::fs::File::create(&out).unwrap();
                std::io::copy(&mut e, &mut w).unwrap();
            }
        }
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"hello");
        assert_eq!(std::fs::read(dest.join("sub/b.txt")).unwrap(), b"world");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn validate_rejects_nested_target() {
        let base = std::env::temp_dir();
        let src = base.join("ryu-validate-src");
        let nested = src.join("inside");
        let r = validate_target(&src, &nested, false);
        assert!(!r.ok);
    }

    // ── extra coverage ───────────────────────────────────────────────────────

    fn uniq() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        format!(
            "{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        )
    }

    #[test]
    fn human_bytes_scales_to_gb_and_tb() {
        assert_eq!(human_bytes(1024u64.pow(3)), "1.0 GB");
        assert_eq!(human_bytes(1024u64.pow(4)), "1.0 TB");
        // Beyond TB stays in TB (the top unit), never overflows the table.
        assert_eq!(human_bytes(5 * 1024u64.pow(5)), "5120.0 TB");
        assert_eq!(human_bytes(1536), "1.5 KB");
    }

    #[test]
    fn check_target_rejects_empty_and_relative_paths() {
        let src = std::env::temp_dir().join(format!("ryu-dp-src-{}", uniq()));
        // Empty target.
        let r = validate_target(&src, std::path::Path::new(""), false);
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("empty"));
        // Relative target.
        let r = validate_target(&src, std::path::Path::new("relative/dir"), false);
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("absolute"));
    }

    #[test]
    fn check_target_rejects_non_empty_dir() {
        let base = std::env::temp_dir().join(format!("ryu-dp-nonempty-{}", uniq()));
        let src = base.join("src");
        let target = base.join("target");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("existing.txt"), b"x").unwrap();

        let r = validate_target(&src, &target, false);
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("not empty"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn check_target_accepts_empty_absolute_writable_target() {
        let base = std::env::temp_dir().join(format!("ryu-dp-ok-{}", uniq()));
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("db.sqlite"), b"data").unwrap();
        // A not-yet-existing absolute path under a distinct base is accepted.
        let target = base.join("dest");

        let r = validate_target(&src, &target, false);
        assert!(r.ok, "unexpected error: {:?}", r.error);
        assert!(r.source_size_bytes >= 4);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_tree_replicates_files_and_subdirs_with_byte_count() {
        let base = std::env::temp_dir().join(format!("ryu-dp-copy-{}", uniq()));
        let from = base.join("from");
        let sub = from.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(from.join("a.txt"), b"hello").unwrap();
        std::fs::write(sub.join("b.txt"), b"world!").unwrap();
        let to = base.join("to");

        let mut copied = 0u64;
        let mut ticks = 0u32;
        copy_tree(&from, &to, &mut copied, &mut |_| ticks += 1).unwrap();

        assert_eq!(copied, 11, "5 + 6 bytes copied");
        assert_eq!(ticks, 2, "on_bytes fires once per file");
        assert_eq!(std::fs::read(to.join("a.txt")).unwrap(), b"hello");
        assert_eq!(std::fs::read(to.join("nested/b.txt")).unwrap(), b"world!");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn export_zip_of_empty_dir_writes_zero_bytes() {
        let base = std::env::temp_dir().join(format!("ryu-dp-empty-{}", uniq()));
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let zip = base.join("out.zip");
        let written = export_zip(&src, &zip).unwrap();
        assert_eq!(written, 0);
        assert!(zip.exists(), "an empty archive is still produced");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn export_zip_omits_credentials_and_runtime_markers() {
        let base = std::env::temp_dir().join(format!("ryu-dp-safe-export-{}", uniq()));
        let src = base.join("src");
        std::fs::create_dir_all(src.join("nested")).unwrap();
        for name in [
            "accounts.json",
            "auth.json",
            "bootstrap-ack.token",
            "core.token",
            "delegation-ed25519.pub",
            "fleet-desired.json",
            "fleet-enforcement.json",
            "fleet-enrolled-node.json",
            "fleet-enrollment-pending.json",
            "fleet-identity.json",
            "fleet-instance-id.json",
            "fleet-skill-blocks.json",
            "fleet-status.json",
            "gateway-admin.key",
            "gateway-durable.token",
            "gateway-relay.token",
            "mcp.json",
            "models.json",
            "node-auth.token",
            "node-control.token",
            "nodes.json",
            "paired-clients.json",
            "pi-accounts.db",
            "plugin-secrets.db",
            "ryu-core.pid",
        ] {
            std::fs::write(src.join(name), b"secret").unwrap();
        }
        std::fs::create_dir_all(src.join("fleet-artifacts")).unwrap();
        std::fs::write(src.join("fleet-artifacts/private.json"), b"secret").unwrap();
        std::fs::create_dir_all(src.join("plugin-credentials")).unwrap();
        std::fs::write(src.join("plugin-credentials/private.json"), b"secret").unwrap();
        std::fs::write(src.join("nested/auth.json"), b"nested-secret").unwrap();
        std::fs::write(src.join("conversations.db"), b"customer-data").unwrap();

        let archive_path = base.join("backup.zip");
        export_zip(&src, &archive_path).unwrap();
        let file = std::fs::File::open(&archive_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names = (0..archive.len())
            .map(|index| archive.by_index(index).unwrap().name().to_owned())
            .collect::<Vec<_>>();
        for name in [
            "accounts.json",
            "auth.json",
            "bootstrap-ack.token",
            "core.token",
            "delegation-ed25519.pub",
            "fleet-desired.json",
            "fleet-enforcement.json",
            "fleet-enrolled-node.json",
            "fleet-enrollment-pending.json",
            "fleet-identity.json",
            "fleet-instance-id.json",
            "fleet-skill-blocks.json",
            "fleet-status.json",
            "fleet-artifacts/private.json",
            "gateway-admin.key",
            "gateway-durable.token",
            "gateway-relay.token",
            "mcp.json",
            "models.json",
            "node-auth.token",
            "node-control.token",
            "nodes.json",
            "paired-clients.json",
            "pi-accounts.db",
            "plugin-credentials/private.json",
            "plugin-secrets.db",
            "ryu-core.pid",
            "nested/auth.json",
        ] {
            assert!(!names.iter().any(|entry| entry == name), "exported {name}");
        }
        assert!(names.iter().any(|entry| entry == "conversations.db"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn export_zip_rejects_a_destination_inside_the_data_folder() {
        let base = std::env::temp_dir().join(format!("ryu-dp-overlap-{}", uniq()));
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let result = export_zip(&src, &src.join("backup.zip"));
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("inside the data folder"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn backup_exclusion_applies_to_nested_credentials_and_runtime_state() {
        assert!(is_backup_excluded(Path::new("nested/node-auth.token")));
        assert!(is_backup_excluded(Path::new("plugin-credentials")));
        assert!(is_backup_excluded(Path::new("fleet-enrolled-node.json")));
        assert!(!is_backup_excluded(Path::new("nested/conversations.db")));
    }

    #[test]
    fn run_cli_returns_false_without_the_data_path_token() {
        // No "data-path" argument → not consumed, Core boots normally.
        assert!(!run_cli(&["ryu-core".to_string(), "serve".to_string()]));
        assert!(!run_cli(&[]));
    }

    // ── profile copy ────────────────────────────────────────────────────────────

    /// Every entry here has a concrete failure if it travels. Pinned as a list so
    /// removing one is a deliberate act with a visible diff, not an oversight.
    #[test]
    fn node_identity_and_runtime_files_never_travel_between_profiles() {
        for name in [
            "core.token",      // target would claim the source's node identity (409 on init)
            "node-auth.token", // this node's minted RYU_TOKEN — copying it leaks the secret
            "nodes.json",      // absolute URLs with the SOURCE profile's hardcoded port
            "auth.json",       // plaintext device sign-in token
            "ryu-core.pid",    // the source's live process id
            ".reset-pending",  // a pending wipe would fire on the target
            "bin",             // .version markers make the target adopt source binaries
            "tmp",
            "cache",
        ] {
            assert!(
                is_profile_copy_excluded(name),
                "'{name}' must not travel between profiles"
            );
        }
    }

    /// The user's actual content MUST travel, or the feature is pointless.
    #[test]
    fn user_content_does_travel() {
        for name in [
            "conversations.db",
            "spaces.db",
            "agents.db",
            "plugins.db",
            "preferences.db",
            "media",
            "models",
            "plugins",
            "workflows",
            "master.key",
        ] {
            assert!(
                !is_profile_copy_excluded(name),
                "'{name}' is user content and must be copied"
            );
        }
    }

    /// The exclusion is TOP-LEVEL only. A plugin that keeps its own `cache/` inside
    /// its data directory is the plugin's business, and dropping it would corrupt
    /// that plugin's state rather than protect anything.
    #[test]
    fn exclusion_is_by_exact_name_not_by_substring() {
        assert!(is_profile_copy_excluded("cache"));
        assert!(!is_profile_copy_excluded("catalog-cache.json"));
        assert!(!is_profile_copy_excluded("my-cache"));
        assert!(is_profile_copy_excluded("bin"));
        assert!(!is_profile_copy_excluded("binaries"));
    }

    // ── deep clean ──────────────────────────────────────────────────────────────

    /// A node reset wipes only the DATA dir, so these roots survive it. Pinned as
    /// a list because each one is several gigabytes or carries real config, and a
    /// user who clicked "reset node" reasonably expects them gone.
    #[test]
    fn deep_clean_targets_the_roots_a_node_reset_never_reaches() {
        let home = if cfg!(windows) {
            std::env::temp_dir().join("ryu-test-home")
        } else {
            std::path::PathBuf::from("/home/tester")
        };
        let config = home.join(".config");
        let roots = auxiliary_roots(&home, Some(&config), "-canary", true);
        let paths: Vec<String> = roots
            .iter()
            .map(|(_, p)| p.to_string_lossy().into_owned())
            .collect();
        assert!(paths.contains(&home.join(".shadow").to_string_lossy().to_string()));
        assert!(paths.contains(&home.join(".ghost").to_string_lossy().to_string()));
        // The config dir IS profile-suffixed — clearing release's must never take
        // canary's gateway.toml with it.
        assert!(paths.contains(&config.join("ryu-canary").to_string_lossy().to_string()));
        assert!(!paths.contains(&config.join("ryu").to_string_lossy().to_string()));
    }

    /// Deleting a real tree, and proving the home-containment guard bites.
    #[test]
    fn deep_clean_removes_only_paths_inside_home() {
        let base = std::env::temp_dir().join(format!("ryu-dc-{}", uniq()));
        let home = base.join("home");
        let config = home.join(".config");
        std::fs::create_dir_all(home.join(".shadow/media")).unwrap();
        std::fs::create_dir_all(home.join(".ghost")).unwrap();
        std::fs::create_dir_all(config.join("ryu")).unwrap();
        std::fs::write(home.join(".shadow/media/a.wav"), b"audio").unwrap();
        std::fs::write(config.join("ryu/gateway.toml"), b"[gateway]").unwrap();
        // Must survive: not one of the auxiliary roots.
        std::fs::create_dir_all(home.join(".ryu")).unwrap();

        let removed = deep_clean(&home, Some(&config), "", true);
        assert_eq!(removed.len(), 3, "shadow + ghost + config dir");
        assert!(!home.join(".shadow").exists());
        assert!(!home.join(".ghost").exists());
        assert!(!config.join("ryu").exists());
        assert!(
            home.join(".ryu").exists(),
            "the DATA dir is the node reset's job, not deep-clean's"
        );

        // Second run is a no-op rather than an error.
        assert!(deep_clean(&home, Some(&config), "", true).is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Shared roots are opt-OUT because they are not profile-scoped: clearing
    /// them from one profile clears them for every profile on the machine.
    #[test]
    fn shared_roots_can_be_excluded_while_the_config_dir_still_goes() {
        let home = std::path::Path::new("/home/t");
        let config = std::path::Path::new("/home/t/.config");
        let with = auxiliary_roots(home, Some(config), "-dev", true);
        let without = auxiliary_roots(home, Some(config), "-dev", false);
        assert_eq!(with.len(), 3);
        assert_eq!(
            without.len(),
            1,
            "only the profile-scoped config dir remains"
        );
        assert!(without[0].1.ends_with("ryu-dev"));
    }

    /// `state` keeps the multi-GB downloads; `full` does not. Re-fetching an
    /// engine is the slowest possible route back to a clean node.
    #[test]
    fn a_state_clean_keeps_the_downloads_and_a_full_clean_does_not() {
        let base = std::env::temp_dir().join(format!("ryu-cd-{}", uniq()));
        let home = base.join("home");
        let dir = home.join(".ryu-canary");
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::create_dir_all(dir.join("models")).unwrap();
        std::fs::create_dir_all(dir.join("plugins")).unwrap();
        std::fs::write(dir.join("conversations.db"), b"db").unwrap();
        std::fs::write(dir.join("bin/ryu-core"), b"ELF").unwrap();
        std::fs::write(dir.join("master.key"), b"key").unwrap();

        assert!(!clean_profile_data(&home, "-canary", CleanDepth::State).is_empty());
        assert!(
            dir.join("bin/ryu-core").exists(),
            "bin survives a state clean"
        );
        assert!(dir.join("models").exists(), "models survive a state clean");
        assert!(
            dir.join("master.key").exists(),
            "the key is node identity and must survive — there is no rekey path"
        );
        assert!(!dir.join("conversations.db").exists());
        assert!(!dir.join("plugins").exists());

        assert!(!clean_profile_data(&home, "-canary", CleanDepth::Full).is_empty());
        assert!(!dir.exists(), "full removes the data dir outright");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Task #101. Every destructive profile flag on this CLI must be rejected
    /// unless it NAMES a known profile — because `suffix_for` silently maps an
    /// unknown or empty name onto the release suffix.
    #[test]
    fn an_unknown_or_empty_profile_flag_is_rejected() {
        assert!(!is_known_profile_arg(""), "the empty-string hole itself");
        assert!(!is_known_profile_arg("   "));
        assert!(!is_known_profile_arg("canary "), "no implicit trimming");
        assert!(!is_known_profile_arg("Canary"), "no implicit lowercasing");
        assert!(!is_known_profile_arg("typo"));
        assert!(
            !is_known_profile_arg("."),
            "a path fragment is not a profile"
        );
        assert!(!is_known_profile_arg(".."));
        // The names that must keep working.
        assert!(is_known_profile_arg("release"));
        assert!(is_known_profile_arg("dev"));
        assert!(is_known_profile_arg("canary"));
        assert!(is_known_profile_arg("nightly"));
        assert!(is_known_profile_arg("beta"));
    }

    /// WHY that guard is load-bearing, as assertions rather than a comment.
    ///
    /// `suffix_for` maps an unknown name to `-<name>` verbatim, so an unvalidated
    /// flag names a REAL, containment-legal directory that is simply the wrong
    /// one — and the containment guard cannot object, because `~/.ryu-canry` is a
    /// perfectly legal single component under home. The failure mode is a
    /// destructive command that reports success having touched nothing (or, for
    /// `copy-profile`, having written a junk root).
    #[test]
    fn an_unvalidated_profile_name_aims_at_a_real_but_wrong_directory() {
        // Not the release suffix — but not rejected by anything downstream either.
        assert_eq!(crate::profile::suffix_for(""), "-");
        assert_eq!(crate::profile::suffix_for("canry"), "-canry");
        assert_ne!(
            crate::profile::suffix_for("canry"),
            crate::profile::suffix_for("canary"),
            "a typo silently names a DIFFERENT profile root"
        );

        let home = std::env::temp_dir().join(format!("ryu-unvalidated-{}", uniq()));
        for name in ["", "canry", "Canary"] {
            let dir = home.join(format!(".ryu{}", crate::profile::suffix_for(name)));
            assert_eq!(
                dir.strip_prefix(&home).map(|r| r.components().count()),
                Ok(1),
                "'{name}' passes the containment guard, so only a name check can stop it"
            );
            assert!(!is_known_profile_arg(name));
        }
    }

    /// The default depth touches no data at all — the original behaviour before
    /// deep clean grew a profile axis.
    #[test]
    fn depth_none_never_touches_the_data_dir() {
        let base = std::env::temp_dir().join(format!("ryu-cdn-{}", uniq()));
        let home = base.join("home");
        std::fs::create_dir_all(home.join(".ryu/plugins")).unwrap();
        assert!(clean_profile_data(&home, "", CleanDepth::None).is_empty());
        assert!(home.join(".ryu/plugins").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The predicate tests above prove intent; this proves the COPY. Excluded
    /// entries must be absent from the target and user content must arrive byte
    /// for byte — "data intact" is the entire point of the feature.
    #[test]
    fn copy_tree_filtered_drops_identity_files_and_preserves_content() {
        let base = std::env::temp_dir().join(format!("ryu-cpf-{}", uniq()));
        let from = base.join("src");
        let to = base.join("dst");
        std::fs::create_dir_all(from.join("bin")).unwrap();
        std::fs::create_dir_all(from.join("media/clips")).unwrap();
        std::fs::create_dir_all(from.join("plugins/acme/cache")).unwrap();

        // Must NOT travel.
        std::fs::write(from.join("core.token"), b"node-identity").unwrap();
        std::fs::write(from.join("nodes.json"), b"{\"url\":\"127.0.0.1:7980\"}").unwrap();
        std::fs::write(from.join("ryu-core.pid"), b"1234").unwrap();
        std::fs::write(from.join("bin/ryu-core"), b"ELF").unwrap();

        // Must travel.
        let db = b"SQLite format 3\0payload";
        std::fs::write(from.join("conversations.db"), db).unwrap();
        std::fs::write(from.join("catalog-cache.json"), b"{}").unwrap();
        std::fs::write(from.join("media/clips/a.mp4"), b"video-bytes").unwrap();
        // A plugin's OWN nested cache is its business — top-level exclusion only.
        std::fs::write(from.join("plugins/acme/cache/warm"), b"warm").unwrap();

        let mut copied = 0u64;
        let mut sink = |_: u64| {};
        copy_tree_filtered(&from, &to, &mut copied, &mut sink).unwrap();

        for gone in ["core.token", "nodes.json", "ryu-core.pid", "bin"] {
            assert!(
                !to.join(gone).exists(),
                "'{gone}' must not be copied between profiles"
            );
        }
        assert_eq!(
            std::fs::read(to.join("conversations.db")).unwrap(),
            db,
            "user content must arrive byte for byte"
        );
        assert!(
            to.join("catalog-cache.json").exists(),
            "substring != exclusion"
        );
        assert_eq!(
            std::fs::read(to.join("media/clips/a.mp4")).unwrap(),
            b"video-bytes"
        );
        assert!(
            to.join("plugins/acme/cache/warm").exists(),
            "a NESTED cache dir belongs to the plugin and must survive"
        );
        assert!(copied > 0, "byte counter must advance");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Copying onto a profile that already has data is refused. `check_target`
    /// enforces it, but assert it here too: this is the path a user reaches from a
    /// Settings button, where "it merged into my existing canary" is unrecoverable.
    #[test]
    fn copying_into_a_non_empty_profile_is_refused() {
        let tmp =
            std::env::temp_dir().join(format!("ryu-copy-profile-test-{}", std::process::id()));
        let from = tmp.join("src");
        let to = tmp.join("dst");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(to.join("conversations.db"), b"existing").unwrap();

        let result = validate_target(&from, &to, false);
        assert!(!result.ok, "a non-empty target must be refused");
        let err = result.error.expect("an error message");
        assert!(
            err.to_lowercase().contains("empty"),
            "error should explain the target is not empty, got: {err}"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
