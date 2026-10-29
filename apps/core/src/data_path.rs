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
// Export and import exclude every credential under `secrets/` except the key
// custody files, plus this denylist by basename at every depth. These files
// either contain reusable credentials or bind the data to the source node. The
// encryption keys (`secrets/master.key`, `secrets/memory.key`) are deliberately
// kept: they are required to restore the encrypted customer databases, so the
// backup itself must be kept private.
const BACKUP_KEPT_SECRETS: &[&str] = &["master.key", "memory.key"];
const BACKUP_EXCLUDE_NAMES: &[&str] = &[
    "accounts.json",
    ".reset-pending",
    "auth.json",
    // A Codex auth copy backup older builds kept in the isolated CODEX_HOME.
    "auth.json.ryu-safety-backup",
    "bootstrap-ack.token",
    // The CLIs' own sign-in files: Claude Code's OAuth (`.credentials.json`) and
    // account file (`.claude.json`).
    ".claude.json",
    ".credentials.json",
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
    "gateway-relay.key",
    "gateway-relay.token",
    "mcp.json",
    "models.json",
    "native-accounts",
    "node-auth.token",
    "node-control.token",
    "nodes.json",
    "paired-clients.json",
    "pi-accounts.db",
    // Linked plan accounts (`state/plan-accounts/<provider>-<id>`): each is a
    // CLI config folder holding that account's own sign-in.
    "plan-accounts",
    "plugin-credentials",
    "plugin-secrets.db",
    "org-project-mappings.json",
    "ryu-core.pid",
    // The Ryu Relay routing token; re-minted on the next register.
    "relay.json",
    // Third-party tunnel identities Ryu cannot seal (tailscaled's node keys and
    // the OpenTunnel CLI's token and private key): a restored copy would clone
    // this node's network identity, so they are left out.
    "tailscaled.state",
    "tunnel.json",
];

/// True for a path (relative to the data dir) inside `secrets/` that is not one
/// of the key custody files a backup must carry.
fn is_excluded_secret(path: &Path) -> bool {
    let mut components = path.components();
    let Some(first) = components.next() else {
        return false;
    };
    if !first
        .as_os_str()
        .to_str()
        .is_some_and(|name| name.eq_ignore_ascii_case(layout::top::SECRETS))
    {
        return false;
    }
    let rest: Vec<_> = components.collect();
    match rest.as_slice() {
        // The `secrets/` dir itself is walked so the kept keys can be found.
        [] => false,
        [only] => !only.as_os_str().to_str().is_some_and(|name| {
            BACKUP_KEPT_SECRETS
                .iter()
                .any(|kept| name.eq_ignore_ascii_case(kept))
        }),
        _ => true,
    }
}

pub(crate) fn is_backup_excluded(path: &Path) -> bool {
    is_excluded_secret(path)
        || path.components().any(|component| {
            component.as_os_str().to_str().is_some_and(|name| {
                BACKUP_EXCLUDE_NAMES
                    .iter()
                    .any(|excluded| name.eq_ignore_ascii_case(excluded))
            })
        })
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
        } else if ft.is_symlink() {
            copy_symlink(&src, &dst)?;
        }
        // Other special files (sockets, FIFOs) are skipped.
    }
    Ok(())
}

/// Recreate the symlink at `src` as `dst` with its target copied verbatim.
///
/// Core writes relative symlinks into the data dir (llama.cpp's
/// `libfoo.dylib -> libfoo.N.dylib` aliases, links inside installed bundles), so
/// they resolve the same way in the copied tree. Links are never followed, which
/// also keeps a directory link from causing a loop or an escape.
#[cfg(unix)]
fn copy_symlink(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(std::fs::read_link(src)?, dst)
}

/// Ryu creates no symlinks on this platform. Refuse rather than silently drop one,
/// because a move deletes the source after the copy.
#[cfg(not(unix))]
fn copy_symlink(src: &Path, _dst: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        format!("cannot copy symlink {}", src.display()),
    ))
}

/// Files and directories that must NOT travel when copying one profile's data to
/// another, because they identify the NODE or the RUNNING PROCESS rather than the
/// user's content. Paths are relative to the data dir.
///
/// Copying these is not merely untidy — each has a concrete failure:
///   - `secrets/core.token` minted once with `create_new(true)`; a copy makes the
///                     target claim the source's node identity, and
///                     `/api/node/init` then answers 409 `already_initialized` forever.
///   - `state/nodes.json` entries carry absolute URLs with a HARDCODED port. Copying
///                     `http://127.0.0.1:7980` into a profile that listens on 9980
///                     leaves it pointing at the wrong stack — the source's.
///   - `secrets/auth.json` legacy active-account sign-in token, sealed with the Core
///                     master key and excluded because it identifies the source
///                     node's account session.
///   - `secrets/node-auth.token` this node's minted `RYU_TOKEN` (see
///                     `crate::node_token`). A copy would hand another machine THIS
///                     node's admittance secret — a credential leak, not just a
///                     wrong identity.
///   - `secrets/master.key`, `secrets/memory.key` raw master-key material.
///                     [`copy_profile`] moves the key through the profile-scoped
///                     keychain first and aborts when it cannot, so a raw copy is
///                     never needed; carrying one (notably a retired legacy
///                     `memory.key`) would leave a decryption key in a tree that
///                     can be shared or snapshotted without the source keychain.
///   - `secrets/node-control.token`, `secrets/gateway-relay.token`,
///     `secrets/gateway-durable.token`, `secrets/bootstrap-ack.token`,
///     `secrets/gateway-relay.key` the node's control-plane credentials.
///   - `state/ryu-core.pid` the source's live process id.
///   - `.reset-pending` a pending node wipe would fire on the target instead.
///   - `bin/`          binaries plus `.version` markers keyed to the APP version, so
///                     a same-version copy makes the target adopt the source's
///                     binaries and skip its own download — defeating the entire
///                     point of a canary profile, which exists to run a different
///                     build.
///   - `tmp/`, `cache/` regenerable, and often large.
const PROFILE_COPY_EXCLUDE: &[&str] = &[
    ".reset-pending",
    "bin",
    "cache",
    "secrets/auth.json",
    "secrets/bootstrap-ack.token",
    "secrets/core.token",
    "secrets/gateway-durable.token",
    "secrets/gateway-relay.key",
    "secrets/gateway-relay.token",
    "secrets/master.key",
    "secrets/memory.key",
    "secrets/node-auth.token",
    "secrets/node-control.token",
    "state/nodes.json",
    "state/ryu-core.pid",
    "tmp",
];

/// Whether `rel` (a `/`-separated path relative to the data dir) is excluded
/// from a profile copy.
pub fn is_profile_copy_excluded(rel: &str) -> bool {
    PROFILE_COPY_EXCLUDE.contains(&rel)
}

/// Recursively copy `from` into `to`, skipping the node-identity and runtime
/// entries named by their data-dir-relative path (a nested `cache/` inside a
/// plugin's data is the plugin's business, so only exact relative paths match).
fn copy_tree_filtered(
    from: &Path,
    to: &Path,
    copied: &mut u64,
    on_bytes: &mut dyn FnMut(u64),
) -> std::io::Result<()> {
    copy_tree_filtered_at(from, to, "", copied, on_bytes)
}

fn copy_tree_filtered_at(
    from: &Path,
    to: &Path,
    rel_prefix: &str,
    copied: &mut u64,
    on_bytes: &mut dyn FnMut(u64),
) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        let rel = format!("{rel_prefix}{}", name.to_string_lossy());
        if is_profile_copy_excluded(&rel) {
            continue;
        }
        let src = entry.path();
        let dst = to.join(&name);
        let ft = entry.file_type()?;
        if ft.is_dir() {
            // Only descend with filtering where an excluded path can live.
            if PROFILE_COPY_EXCLUDE
                .iter()
                .any(|excluded| excluded.starts_with(&format!("{rel}/")))
            {
                copy_tree_filtered_at(&src, &dst, &format!("{rel}/"), copied, on_bytes)?;
            } else {
                copy_tree(&src, &dst, copied, on_bytes)?;
            }
        } else if ft.is_file() {
            let bytes = std::fs::copy(&src, &dst)?;
            *copied += bytes;
            on_bytes(*copied);
        } else if ft.is_symlink() {
            copy_symlink(&src, &dst)?;
        }
    }
    Ok(())
}

/// Auxiliary roots a node reset does NOT reach, and where each lives.
///
/// `apply_pending_reset` wipes the DATA dir and nothing else, which leaves a
/// "reset" node still carrying its gateway config and data-path pointer. Users
/// reasonably read "reset node" as "this node is blank" and then find their old
/// gateway settings intact. (Shadow captures and Ghost state live under the data
/// dir's `services/`, so the reset already reaches them.)
pub fn auxiliary_roots(config_dir: Option<&Path>, suffix: &str) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
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
                if name == layout::top::BIN
                    || name == layout::top::MODELS
                    || name == layout::top::ENGINES
                {
                    continue;
                }
                let path = entry.path();
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                let ok = if is_dir && name == layout::top::SECRETS {
                    // Keep the key custody files; every token/credential goes.
                    scrub_secrets_keeping_keys(&path)
                } else if is_dir {
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
                    "data dir ({cleared} entries, kept bin/engines/models/keys) — {}",
                    dir.display()
                ));
            }
        }
    }
    removed
}

/// Delete every entry of a `secrets/` dir except the key custody files.
fn scrub_secrets_keeping_keys(secrets: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(secrets) else {
        return false;
    };
    let mut ok = true;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if BACKUP_KEPT_SECRETS.contains(&name.to_string_lossy().as_ref()) {
            continue;
        }
        let path = entry.path();
        let result = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        ok &= result.is_ok();
    }
    ok
}

/// Remove the auxiliary roots above. Returns what was actually removed.
///
/// Every path is re-checked against `$HOME` before deletion: these are computed
/// from a home dir and a profile suffix, and a bug in either would otherwise aim a
/// recursive delete somewhere arbitrary.
pub fn deep_clean(home: &Path, config_dir: Option<&Path>, suffix: &str) -> Vec<String> {
    let mut removed = Vec::new();
    for (label, path) in auxiliary_roots(config_dir, suffix) {
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

    // Retired keys the source holds in its keychain are stored per profile, so
    // the copied retired-key index would name slots the target does not have.
    // Carry them first: the copy is idempotent, so a refusal of the main key
    // below leaves nothing a retry would trip over.
    if let Err(error) =
        ryu_crypto::custody::copy_retired_keys_between_profiles(from, from_suffix, to_suffix)
    {
        undo_probe();
        return Err(std::io::Error::other(format!(
            "the source profile's retired master keys could not be carried to the '{to_suffix}' \
             profile, so data sealed under them would not open there. Nothing was copied. \
             ({error:#})"
        )));
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
        if let Err(e) = std::fs::remove_dir_all(from) {
            eprintln!(
                "data-path migrate: copied and switched to {}, but could not remove {}: {e}",
                to.display(),
                from.display()
            );
        }
    }
    Ok(())
}

// ── Export (passphrase-encrypted zip) ──────────────────────────────────────────────
//
// A data-folder export carries `secrets/master.key` (file custody) and every
// store, so it is never written in the clear. The file is:
//
//   "RYU-DX01" | iterations: u32 BE | salt: 16 bytes | RYU-BK01 stream
//
// where the RYU-BK01 stream is `ryu_backup::encryption` (the S3 backup format:
// authenticated 1 MiB AES-256-GCM frames) keyed by PBKDF2-HMAC-SHA256 of the
// operator's passphrase (the vault snapshot KDF). The zip itself only ever exists
// in an anonymous temporary file. Archives written by older builds (a plain zip)
// still import without a passphrase.
//
// An export of the active data folder also carries the master key in every
// custody (keychain or file), the retired keys and the key check value, as one
// `ryu_crypto::custody::seal_key_bundle` value in the archive entry
// [`KEY_BUNDLE_ENTRY`]. It is sealed under a key derived from the archive key, so
// it only exists inside the passphrase-encrypted stream. Import adopts it: when
// the archive key differs from the target's, the archive key becomes current and
// the target's previous key is retired, so data the target already sealed keeps
// opening (see `docs/encryption-at-rest.md`).

/// Archive entry holding the sealed key bundle. Never extracted.
const KEY_BUNDLE_ENTRY: &str = "ryu-export/master-key.bundle";
/// Archive entries the key bundle supersedes on import: copying them would
/// overwrite the target's key file or its key records before the target's own
/// key is retired.
const KEY_CUSTODY_ENTRIES: &[&str] = &[
    "secrets/master.key",
    "state/master-key.kcv",
    "state/retired-keys.json",
];
/// Domain label for the key-bundle wrapping key (HMAC of the archive key).
const KEY_BUNDLE_WRAP_LABEL: &[u8] = b"ryu-data-export-key-bundle-v1";

const EXPORT_MAGIC: &[u8; 8] = b"RYU-DX01";
const EXPORT_SALT_LEN: usize = 16;
const EXPORT_MIN_ITERATIONS: u32 = 100_000;
const EXPORT_MAX_ITERATIONS: u32 = 2_000_000;
/// Minimum passphrase length, matching vault snapshots.
pub(crate) const EXPORT_MIN_PASSPHRASE_CHARS: usize = 12;
/// Env var the `data-path export|import` CLI reads the archive passphrase from
/// (the desktop shell sets it on the child it spawns; never a CLI argument,
/// which other local users could read from the process list).
pub(crate) const ARCHIVE_PASSPHRASE_ENV: &str = "RYU_DATA_ARCHIVE_PASSPHRASE";

fn invalid_input(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message.into())
}

fn check_export_passphrase(passphrase: &str) -> std::io::Result<()> {
    if passphrase.chars().count() < EXPORT_MIN_PASSPHRASE_CHARS {
        return Err(invalid_input(format!(
            "the backup passphrase must be at least {EXPORT_MIN_PASSPHRASE_CHARS} characters"
        )));
    }
    Ok(())
}

fn export_key(passphrase: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    crate::vault::snapshot::pbkdf2_sha256(passphrase.as_bytes(), salt, iterations)
}

/// The key that wraps the key bundle inside an archive keyed by `archive_key`.
fn key_bundle_wrap(archive_key: &[u8; 32]) -> [u8; 32] {
    use hmac::Mac;
    let mut mac = <hmac::Hmac<sha2::Sha256> as Mac>::new_from_slice(archive_key)
        .expect("HMAC accepts any key length");
    mac.update(KEY_BUNDLE_WRAP_LABEL);
    mac.finalize().into_bytes().into()
}

/// Archive key material chosen before the zip is written, so the key bundle can
/// be wrapped under it.
struct ExportKey {
    salt: [u8; EXPORT_SALT_LEN],
    iterations: u32,
    key: [u8; 32],
}

impl ExportKey {
    fn generate(passphrase: &str, iterations: u32) -> Self {
        use rand::RngCore;
        let mut salt = [0u8; EXPORT_SALT_LEN];
        rand::thread_rng().fill_bytes(&mut salt);
        let key = export_key(passphrase, &salt, iterations);
        Self {
            salt,
            iterations,
            key,
        }
    }
}

/// Seals and adopts the master-key bundle. Production goes through
/// `ryu_crypto::custody`; tests inject a fake so they never touch the test
/// binary's own key custody.
pub(crate) trait KeyBundlePort {
    /// The sealed bundle for the data folder `from`, or `None` when `from` is
    /// not the folder this process holds the key of.
    fn seal_for(&self, from: &Path, wrap: &[u8; 32]) -> std::io::Result<Option<String>>;
    /// Adopt `sealed` as the key of the data folder `to` (Core stopped).
    fn adopt_into(&self, to: &Path, wrap: &[u8; 32], sealed: &str) -> std::io::Result<()>;
}

/// The real key custody.
struct CustodyKeyBundles;

fn same_folder(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Hidden `data-path` command that adopts a key bundle into the data folder
/// named by `RYU_DIR` (stdin: wrapping key base64, then the sealed bundle).
const ADOPT_KEY_BUNDLE_CMD: &str = "adopt-key-bundle";

impl KeyBundlePort for CustodyKeyBundles {
    fn seal_for(&self, from: &Path, wrap: &[u8; 32]) -> std::io::Result<Option<String>> {
        if !same_folder(from, &paths::ryu_dir()) {
            return Ok(None);
        }
        crate::crypto_host::install();
        ryu_crypto::custody::seal_key_bundle(&ryu_crypto::FieldCipher::new(wrap))
            .map(Some)
            .map_err(|error| {
                std::io::Error::other(format!(
                    "could not read the master key to include it in the export: {error:#}"
                ))
            })
    }

    fn adopt_into(&self, to: &Path, wrap: &[u8; 32], sealed: &str) -> std::io::Result<()> {
        if same_folder(to, &paths::ryu_dir()) {
            crate::crypto_host::install();
            return adopt_key_bundle_here(wrap, sealed);
        }
        // Another folder: resolve its custody in a child whose data dir is `to`
        // (the key ladder caches the data dir for the life of a process).
        adopt_key_bundle_in_child(to, wrap, sealed)
    }
}

fn adopt_key_bundle_here(wrap: &[u8; 32], sealed: &str) -> std::io::Result<()> {
    let outcome =
        ryu_crypto::custody::import_key_bundle(&ryu_crypto::FieldCipher::new(wrap), sealed)
            .map_err(|error| {
                std::io::Error::other(format!(
            "could not adopt the backup's master key: {error:#}. Import the backup into a new \
             profile instead"
        ))
            })?;
    match outcome.retired {
        Some(retired) => eprintln!(
            "data-path import: adopted the backup's master key ({}, {} custody); this folder's \
             previous key {retired} is retired and still opens its data",
            outcome.kcv, outcome.custody
        ),
        None => eprintln!(
            "data-path import: the backup uses this folder's master key ({})",
            outcome.kcv
        ),
    }
    Ok(())
}

/// The keychain switch the adoption child must run with.
const ADOPT_CHILD_KEYCHAIN: &str = "off";

/// The child that adopts a key bundle into the non-active folder `to`.
///
/// The keychain slot belongs to the profile, not to a folder: it holds the
/// active folder's key. The child therefore runs with the keychain off, so the
/// archive key lands as `to`'s own `secrets/master.key` (`file` custody) and
/// the active folder's keychain entry is neither retired into `to` nor
/// overwritten.
fn adopt_child_command(exe: &Path, to: &Path) -> std::process::Command {
    let mut command = std::process::Command::new(exe);
    command
        .args(["data-path", ADOPT_KEY_BUNDLE_CMD])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null());
    ryu_crypto::scrub_seal_env(&mut command);
    command
        .env(paths::RYU_DIR_ENV, to)
        .env(ADOPT_CHILD_KEYCHAIN_ENV, ADOPT_CHILD_KEYCHAIN);
    command
}

/// `RYU_KEYCHAIN`: `off` keeps a process away from the profile's keychain slot.
const ADOPT_CHILD_KEYCHAIN_ENV: &str = "RYU_KEYCHAIN";

fn adopt_child_keychain_is_off() -> bool {
    std::env::var(ADOPT_CHILD_KEYCHAIN_ENV)
        .is_ok_and(|value| value.trim().eq_ignore_ascii_case(ADOPT_CHILD_KEYCHAIN))
}

fn adopt_key_bundle_in_child(to: &Path, wrap: &[u8; 32], sealed: &str) -> std::io::Result<()> {
    use base64::Engine as _;
    std::fs::create_dir_all(to)?;
    let mut command = adopt_child_command(&std::env::current_exe()?, to);
    let mut child = command.spawn()?;
    {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("no stdin for the key adoption step"))?;
        let wrap_key = base64::engine::general_purpose::STANDARD.encode(wrap);
        writeln!(stdin, "{wrap_key}")?;
        writeln!(stdin, "{sealed}")?;
    }
    let status = child.wait()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(
            "could not adopt the backup's master key into the target folder; import the backup \
             into a new profile instead",
        ))
    }
}

/// Encrypt the plaintext zip in `zip` (any position) into `output`.
fn seal_export(
    zip: &mut std::fs::File,
    output: &mut impl Write,
    archive: &ExportKey,
) -> std::io::Result<()> {
    use std::io::Seek;
    let ExportKey {
        salt,
        iterations,
        key,
    } = archive;
    output.write_all(EXPORT_MAGIC)?;
    output.write_all(&iterations.to_be_bytes())?;
    output.write_all(salt)?;
    zip.rewind()?;
    let length = zip.metadata()?.len();
    ryu_backup::encryption::encrypt(&mut *zip, &mut *output, length, key)
        .map_err(|error| std::io::Error::other(error.to_string()))
}

/// `tmp/<owner>` scratch for the plaintext zip of an export or import.
const EXPORT_SCRATCH_OWNER: &str = "exports";
const IMPORT_SCRATCH_OWNER: &str = "imports";

/// An anonymous (already unlinked) file for a plaintext data zip. It lives in
/// the owner-only `tmp/<owner>` of the local data folder `root`, never next to
/// the archive: the archive's folder is the backup medium (USB stick, network
/// share, sync folder) the passphrase protects, and filesystems without
/// `O_TMPFILE` briefly name the file (or keep a silly-renamed copy on NFS/SMB).
/// When `root` is not an existing real directory, the OS temp dir is used.
fn plaintext_scratch(root: &Path, owner: &str) -> std::io::Result<std::fs::File> {
    let usable_root = std::fs::symlink_metadata(root)
        .is_ok_and(|metadata| metadata.file_type().is_dir() && !metadata.file_type().is_symlink());
    if usable_root {
        let scratch = layout::tmp_dir_for(root, owner);
        if ryu_backup::archive::private_directory(&scratch).is_ok() {
            if let Ok(file) = tempfile::tempfile_in(&scratch) {
                return Ok(file);
            }
        }
    }
    tempfile::tempfile()
}

/// Open a data backup for import into `destination`. An encrypted export is
/// decrypted into an anonymous temporary file (see [`plaintext_scratch`]); a
/// legacy plain zip is returned as is.
fn open_data_archive(
    archive: &Path,
    destination: &Path,
    passphrase: Option<&str>,
) -> std::io::Result<std::fs::File> {
    open_data_archive_keyed(archive, destination, passphrase).map(|(file, _)| file)
}

/// [`open_data_archive`] plus the archive key (`None` for a legacy plain zip),
/// which unwraps the key bundle.
fn open_data_archive_keyed(
    archive: &Path,
    destination: &Path,
    passphrase: Option<&str>,
) -> std::io::Result<(std::fs::File, Option<[u8; 32]>)> {
    use std::io::Seek;
    let mut file = std::fs::File::open(archive)?;
    let mut magic = [0u8; 8];
    let read = file.read(&mut magic)?;
    file.rewind()?;
    if read < magic.len() || &magic != EXPORT_MAGIC {
        // A pre-encryption export: an ordinary zip, validated by the caller.
        return Ok((file, None));
    }
    let passphrase = passphrase
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            invalid_input("this data backup is encrypted; supply its passphrase to restore it")
        })?;
    let mut header = [0u8; 8 + 4 + EXPORT_SALT_LEN];
    file.read_exact(&mut header)?;
    let iterations = u32::from_be_bytes(header[8..12].try_into().expect("4 bytes"));
    if !(EXPORT_MIN_ITERATIONS..=EXPORT_MAX_ITERATIONS).contains(&iterations) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "data backup has an unsupported key-derivation setting",
        ));
    }
    let key = export_key(passphrase, &header[12..], iterations);
    let mut plain = plaintext_scratch(destination, IMPORT_SCRATCH_OWNER)?;
    ryu_backup::encryption::decrypt(&mut file, &mut plain, &key).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "could not decrypt the data backup: wrong passphrase or damaged file",
        )
    })?;
    plain.rewind()?;
    Ok((plain, Some(key)))
}

/// Zip the whole data folder `from` and write it, encrypted under `passphrase`,
/// to `out`. Read-only on the data folder, so it's safe to call while Core is
/// running (DB rows mid-write may land in an inconsistent snapshot — acceptable
/// for a manual backup). Refuses (fails closed) without a usable passphrase.
///
/// An export of the active data folder always carries its master key, retired
/// keys and key check value inside the encrypted stream (any custody); it fails
/// rather than write an archive that could not be restored.
pub fn export_zip(from: &Path, out: &Path, passphrase: &str) -> std::io::Result<u64> {
    export_zip_with(
        from,
        out,
        passphrase,
        crate::vault::snapshot::DEFAULT_ITERATIONS,
        &CustodyKeyBundles,
    )
}

#[cfg(test)]
fn export_zip_with_iterations(
    from: &Path,
    out: &Path,
    passphrase: &str,
    iterations: u32,
) -> std::io::Result<u64> {
    export_zip_with(from, out, passphrase, iterations, &CustodyKeyBundles)
}

/// Whether the data folder `dir` carries key records (a key check value or
/// retired keys) that a bundle-less archive would silently drop. An unreadable
/// retired-key index counts as present, so the export fails closed.
fn holds_key_records(dir: &Path) -> bool {
    dir.join(KEY_RECORD_KCV_ENTRY).exists()
        || ryu_crypto::custody::read_retired_index(dir).map_or(true, |index| !index.is_empty())
}

fn export_zip_with(
    from: &Path,
    out: &Path,
    passphrase: &str,
    iterations: u32,
    keys: &dyn KeyBundlePort,
) -> std::io::Result<u64> {
    check_export_passphrase(passphrase)?;
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
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let archive_key = ExportKey::generate(passphrase, iterations);
    let key_bundle = keys.seal_for(from, &key_bundle_wrap(&archive_key.key))?;
    if key_bundle.is_none() && holds_key_records(from) {
        // A folder this process does not hold the key of cannot contribute its
        // retired keys (or a keychain-held current key) to the archive, and the
        // raw-file fallback on import skips them: the archive would not restore.
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "export the active data folder, or switch to this folder first, so its master and \
             retired keys can be included",
        ));
    }

    let mut written = 0u64;
    // The plaintext zip is an anonymous file in the data folder's owner-only
    // scratch, never on the destination medium: nothing can open it by name and
    // the OS reclaims it even if this process is killed mid-export. Only the
    // ciphertext below is written next to `out`.
    let mut plain = {
        let mut zip = zip::ZipWriter::new(plaintext_scratch(from, EXPORT_SCRATCH_OWNER)?);
        zip_dir(from, from, &mut zip, options, &mut written)?;
        if let Some(bundle) = &key_bundle {
            zip.start_file(KEY_BUNDLE_ENTRY, options)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            zip.write_all(bundle.as_bytes())?;
        }
        zip.finish()?
    };
    // `tempfile` creates the named output owner-only (0600 on Unix).
    let mut temporary = tempfile::Builder::new()
        .prefix(".ryu-backup-")
        .tempfile_in(parent)?;
    {
        let mut output = std::io::BufWriter::new(temporary.as_file_mut());
        seal_export(&mut plain, &mut output, &archive_key)?;
        output.flush()?;
    }
    drop(plain);
    temporary.as_file().sync_all()?;
    temporary.persist(&out).map_err(|error| error.error)?;
    Ok(written)
}

fn zip_dir<W: Write + std::io::Seek>(
    root: &Path,
    dir: &Path,
    zip: &mut zip::ZipWriter<W>,
    options: zip::write::SimpleFileOptions,
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

fn copy_declared_backup_entry(
    reader: &mut impl Read,
    writer: &mut impl Write,
    declared_size: u64,
    remaining_planned: u64,
) -> std::io::Result<u64> {
    let copied = std::io::copy(
        &mut reader.take(declared_size.min(remaining_planned) + 1),
        writer,
    )?;
    if copied > declared_size || copied > remaining_planned {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "data backup expands beyond its declared size",
        ));
    }
    Ok(copied)
}

// ── Import (restore from zip) ──────────────────────────────────────────────────────

/// Extract a backup archive into `to`, then point the data folder at `to`. Must run
/// offline (it overwrites the live DB files). The destination is created if needed;
/// existing files with the same name are overwritten. An encrypted export needs
/// its `passphrase`; a legacy plain-zip export imports without one.
///
/// When the archive carries a key bundle, the bundle's master key is adopted for
/// `to` before any file is replaced (the target's previous key is retired), and
/// the archive's own key file and key records are not extracted.
pub fn import_zip(archive: &Path, to: &Path, passphrase: Option<&str>) -> std::io::Result<()> {
    import_zip_with(archive, to, passphrase, &CustodyKeyBundles)
}

/// Largest key bundle accepted from an archive.
const MAX_KEY_BUNDLE_BYTES: u64 = 64 * 1024;

/// Read the archive's sealed key bundle, if it has one.
fn read_key_bundle<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
) -> std::io::Result<Option<String>> {
    let entry = match zip.by_name(KEY_BUNDLE_ENTRY) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => return Err(std::io::Error::other(error.to_string())),
    };
    if entry.size() > MAX_KEY_BUNDLE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "data backup key bundle is too large",
        ));
    }
    let mut text = String::new();
    entry.take(MAX_KEY_BUNDLE_BYTES).read_to_string(&mut text)?;
    Ok(Some(text.trim().to_owned()))
}

/// How an import takes over the archive's master key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyAdoption {
    /// Nothing to adopt: the archive carries no key (its files are restored).
    None,
    /// The archive's sealed key bundle.
    Bundle,
    /// The raw key files of an archive made before key bundles.
    RawFiles,
}

/// Raw key files an archive without a key bundle may carry.
const RAW_MASTER_KEY_ENTRY: &str = "secrets/master.key";
const RAW_LEGACY_KEY_ENTRY: &str = "secrets/memory.key";
/// Largest raw key file read from an archive (base64 of 32 bytes is 44).
const MAX_RAW_KEY_FILE_BYTES: u64 = 4 * 1024;

/// Key records a bundle-less archive without a raw key never restores over the
/// target's own: the archive's key check value names a key the target does not
/// hold, so restoring it would make the target's key mismatch at the next boot.
const KEY_RECORD_KCV_ENTRY: &str = "state/master-key.kcv";
const KEY_RECORD_RETIRED_ENTRY: &str = "state/retired-keys.json";

/// Whether an archive entry is restored into `target`: the key bundle never is,
/// and the key custody files are not when the archive's key was adopted (which
/// retires the target's key instead of overwriting it). With nothing adopted the
/// archive's key check value is never restored, and its retired-key index only
/// when the target has none of its own, so the target's key records always
/// describe the key the target holds.
fn is_restored_entry(rel: &Path, adoption: KeyAdoption, target: &Path) -> bool {
    if is_backup_excluded(rel) {
        return false;
    }
    let name = rel.to_string_lossy().replace('\\', "/");
    if name.eq_ignore_ascii_case(KEY_BUNDLE_ENTRY) {
        return false;
    }
    let superseded = match adoption {
        KeyAdoption::None => {
            name.eq_ignore_ascii_case(KEY_RECORD_KCV_ENTRY)
                || (name.eq_ignore_ascii_case(KEY_RECORD_RETIRED_ENTRY)
                    && std::fs::symlink_metadata(target.join(KEY_RECORD_RETIRED_ENTRY)).is_ok())
        }
        KeyAdoption::Bundle => KEY_CUSTODY_ENTRIES
            .iter()
            .any(|entry| name.eq_ignore_ascii_case(entry)),
        KeyAdoption::RawFiles => {
            name.eq_ignore_ascii_case(RAW_LEGACY_KEY_ENTRY)
                || KEY_CUSTODY_ENTRIES
                    .iter()
                    .any(|entry| name.eq_ignore_ascii_case(entry))
        }
    };
    !superseded
}

/// The raw key files of a bundle-less archive, as a key bundle sealed under a
/// fresh wrapping key: `secrets/master.key` is the current key (else the
/// legacy `secrets/memory.key`), and a different legacy key is carried as
/// retired. `None` when the archive carries neither.
fn raw_key_bundle(
    master: Option<&str>,
    legacy: Option<&str>,
) -> std::io::Result<Option<([u8; 32], String)>> {
    let decode = |text: &str| {
        ryu_crypto::custody::decode_key_file(text).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup carries a malformed master key",
            )
        })
    };
    let master = master.map(decode).transpose()?;
    let legacy = legacy.map(decode).transpose()?;
    let (current, retired) = match (master, legacy) {
        (Some(master), legacy) => (master, legacy.into_iter().collect::<Vec<_>>()),
        (None, Some(legacy)) => (legacy, Vec::new()),
        (None, None) => return Ok(None),
    };
    let mut wrap = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut wrap);
    let sealed = ryu_crypto::custody::seal_raw_key_bundle(
        &ryu_crypto::FieldCipher::new(&wrap),
        &current,
        &retired,
    )
    .map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(Some((wrap, sealed)))
}

fn import_zip_with(
    archive: &Path,
    to: &Path,
    passphrase: Option<&str>,
    keys: &dyn KeyBundlePort,
) -> std::io::Result<()> {
    let (file, archive_key) = open_data_archive_keyed(archive, to, passphrase)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| std::io::Error::other(e.to_string()))?;
    let key_bundle = read_key_bundle(&mut zip)?;
    let has_bundle = key_bundle.is_some();
    let listed = if has_bundle {
        KeyAdoption::Bundle
    } else {
        KeyAdoption::None
    };
    // Raw key files of an archive made before key bundles, read while it is
    // validated and adopted before anything is replaced.
    let mut raw_master: Option<String> = None;
    let mut raw_legacy: Option<String> = None;
    let total = zip.len();
    if total > MAX_DATA_IMPORT_ENTRIES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "data backup contains too many entries",
        ));
    }
    let mut seen = std::collections::BTreeMap::<String, bool>::new();
    let mut planned_bytes = 0u64;
    for i in 0..total {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let Some(rel) = entry.enclosed_name() else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup contains an unsafe path",
            ));
        };
        if !is_restored_entry(&rel, listed, to) {
            continue;
        }
        let normalized = rel.to_string_lossy().replace('\\', "/");
        let normalized = normalized.trim_end_matches('/').to_ascii_lowercase();
        if seen.contains_key(&normalized) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup contains duplicate paths",
            ));
        }
        // A file cannot also be a directory for another archive entry. Detect
        // both entry orders before any current data-folder bytes are replaced.
        let has_file_ancestor = normalized
            .match_indices('/')
            .any(|(end, _)| seen.get(&normalized[..end]) == Some(&false));
        let prefix = format!("{normalized}/");
        let has_descendant = !entry.is_dir()
            && seen
                .range(prefix.clone()..)
                .next()
                .is_some_and(|(existing, _)| existing.starts_with(&prefix));
        if has_file_ancestor || has_descendant {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup contains conflicting file and directory paths",
            ));
        }
        // `normalized` is lowercase, like the raw key entry names.
        let raw_key_entry = if has_bundle {
            None
        } else if normalized == RAW_MASTER_KEY_ENTRY {
            Some(true)
        } else if normalized == RAW_LEGACY_KEY_ENTRY {
            Some(false)
        } else {
            None
        };
        seen.insert(normalized, entry.is_dir());
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
        // Validate every retained entry before replacing any destination file.
        // A late CRC/decompression failure must not leave the active data folder
        // with an earlier database already restored and another still original.
        let declared_size = entry.size();
        let raw_slot = match raw_key_entry {
            Some(true) => Some(&mut raw_master),
            Some(false) => Some(&mut raw_legacy),
            None => None,
        };
        if let Some(slot) = raw_slot {
            if declared_size > MAX_RAW_KEY_FILE_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "data backup carries a malformed master key",
                ));
            }
            let mut bytes = Vec::new();
            copy_declared_backup_entry(&mut entry, &mut bytes, declared_size, declared_size)?;
            *slot = Some(String::from_utf8_lossy(&bytes).into_owned());
        } else {
            copy_declared_backup_entry(
                &mut entry,
                &mut std::io::sink(),
                declared_size,
                declared_size,
            )?;
        }
    }
    let available = paths::available_space_for(to);
    if available > 0 && planned_bytes > available {
        return Err(std::io::Error::new(
            std::io::ErrorKind::WriteZero,
            "not enough free space for the data backup",
        ));
    }
    // Adopt the backup's master key before any file is replaced: the target's
    // own key is retired, never overwritten, so a refusal here (retired set full,
    // unreadable key) leaves the folder exactly as it was.
    if let Some(bundle) = &key_bundle {
        let archive_key = archive_key.ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "data backup carries a key bundle but is not encrypted",
            )
        })?;
        keys.adopt_into(to, &key_bundle_wrap(&archive_key), bundle)?;
    }
    // An archive made before key bundles carries the raw key files instead.
    // Restoring them would overwrite the target's key without retiring it, so
    // they are adopted the same way: the archive key becomes current and the
    // target's key is retired, then the files themselves are not extracted.
    let mut adoption = listed;
    if !has_bundle {
        if let Some((wrap, sealed)) = raw_key_bundle(raw_master.as_deref(), raw_legacy.as_deref())?
        {
            keys.adopt_into(to, &wrap, &sealed)?;
            adoption = KeyAdoption::RawFiles;
        }
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
    let mut extracted_bytes = 0u64;
    for i in 0..total {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let Some(rel) = entry.enclosed_name() else {
            continue; // path-traversal guard (zip-slip): skip unsafe names
        };
        if !is_restored_entry(&rel, adoption, to) {
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
        let declared_size = entry.size();
        let remaining_planned = planned_bytes.saturating_sub(extracted_bytes);
        let copied = copy_declared_backup_entry(
            &mut entry,
            temporary.as_file_mut(),
            declared_size,
            remaining_planned,
        )?;
        extracted_bytes += copied;
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

/// Validate recovery admission before obtaining a maintenance lease.
fn maintenance_lease(
    roots: &[PathBuf],
    exclusive: bool,
) -> std::io::Result<ryu_runtime_install::data_lease::DataLease> {
    let cache = dirs::cache_dir()
        .ok_or_else(|| std::io::Error::other("could not resolve recovery cache"))?
        .join("ryu-update-recovery");
    let admitted = ryu_runtime_install::data_lease::admit_runtime(
        &cache,
        roots,
        crate::profile::profile(),
        env!("CARGO_PKG_VERSION"),
        None,
    )
    .map_err(|error| {
        std::io::Error::other(format!(
            "update recovery blocked data maintenance: {error:#}"
        ))
    })?;
    if !exclusive {
        return Ok(admitted);
    }
    drop(admitted);
    ryu_runtime_install::data_lease::DataLease::recovery(&cache, roots).map_err(|error| {
        std::io::Error::other(format!(
            "data maintenance requires stopped runtimes: {error:#}"
        ))
    })
}

fn require_maintenance_lease(roots: &[PathBuf]) -> ryu_runtime_install::data_lease::DataLease {
    match maintenance_lease(roots, true) {
        Ok(lease) => lease,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

/// Handle a data-path command without starting the normal Core server.
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
    // The archive passphrase comes from the environment (set by the desktop on
    // the child it spawns) or one line of stdin; never from argv.
    let archive_passphrase = || -> Option<String> {
        if let Some(value) = std::env::var(ARCHIVE_PASSPHRASE_ENV)
            .ok()
            .filter(|value| !value.is_empty())
        {
            return Some(value);
        }
        if !rest.iter().any(|a| a == "--passphrase-stdin") {
            return None;
        }
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).ok()?;
        let value = line.trim_end_matches(['\r', '\n']).to_owned();
        (!value.is_empty()).then_some(value)
    };

    let result: std::io::Result<()> = match cmd.as_str() {
        // Resolve exactly as a normal boot would, without opening stores or
        // scanning model/media files. The independent update supervisor uses
        // this to capture the actual configured folder rather than guessing it.
        "location" => {
            let profile =
                flag("--profile").unwrap_or_else(|| crate::profile::profile().to_string());
            require_known_profile("--profile", &profile);
            ryu_runtime_install::data_paths::DataPaths::for_profile(
                &profile,
                dirs::home_dir(),
                dirs::config_dir(),
            )
            .and_then(|location| {
                let data = location.resolve_data_dir(std::env::var_os(paths::RYU_DIR_ENV))?;
                let pi_config_root =
                    crate::required_update_runtime::pi_config_root(&data, &location.config_dir)
                        .map_err(std::io::Error::other)?;
                println!(
                    "{}",
                    serde_json::json!({
                        "data": data,
                        "config": location.config_dir,
                        "profile": profile,
                        "piConfigRoot": pi_config_root,
                        "runtimeRoots": [pi_config_root],
                    })
                );
                Ok(())
            })
        }
        // Copy THIS profile's data into another profile's data dir, carrying the
        // master key. Neither pointer file is touched: both profiles stay usable.
        //
        // `--from-profile` / `--to-profile` are the profile NAMES (release, dev,
        // canary, …); the suffixes they map to are what key the keychain slots, and
        // getting them wrong is what silently orphans the data.
        // Remove the auxiliary roots a node reset never reaches (the OS config
        // dir), optionally clearing the profile's data dir too.
        "deep-clean" => {
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
            // Defaults: THIS profile, no data touched.
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
            let mut protected = auxiliary_roots(dirs::config_dir().as_deref(), &suffix)
                .into_iter()
                .map(|(_, path)| path)
                .collect::<Vec<_>>();
            protected.push(home.join(format!(".ryu{suffix}")));
            let _maintenance = require_maintenance_lease(&protected);
            let mut removed = clean_profile_data(&home, &suffix, depth);
            removed.extend(deep_clean(&home, dirs::config_dir().as_deref(), &suffix));
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
            let _maintenance = require_maintenance_lease(&[from.clone(), to.clone()]);
            copy_profile(&from, &to, &from_suffix, &to_suffix)
        }
        "migrate" => {
            let from = flag("--from")
                .map(PathBuf::from)
                .unwrap_or_else(paths::ryu_dir);
            let to = flag("--to").map(PathBuf::from);
            let move_source = rest.iter().any(|a| a == "--move");
            match to {
                Some(to) => {
                    let _maintenance =
                        require_maintenance_lease(&[from.clone(), to.clone(), paths::config_dir()]);
                    migrate(&from, &to, move_source)
                }
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
                Some(archive) => {
                    let _maintenance = require_maintenance_lease(&[
                        archive.clone(),
                        to.clone(),
                        paths::config_dir(),
                    ]);
                    import_zip(&archive, &to, archive_passphrase().as_deref())
                }
                None => {
                    eprintln!("data-path import requires --archive <zip> [--to <dir>] [--passphrase-stdin]");
                    std::process::exit(2);
                }
            }
        }
        // Internal: adopt a key bundle into the folder named by `RYU_DIR` (the
        // import above runs this in a child when restoring into another folder).
        ADOPT_KEY_BUNDLE_CMD => {
            use base64::Engine as _;
            let mut wrap_line = String::new();
            let mut bundle = String::new();
            let read = std::io::stdin()
                .read_line(&mut wrap_line)
                .and_then(|_| std::io::stdin().read_line(&mut bundle));
            match read {
                Err(error) => Err(error),
                Ok(_) => base64::engine::general_purpose::STANDARD
                    .decode(wrap_line.trim())
                    .ok()
                    .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
                    .ok_or_else(|| invalid_input("malformed key-bundle wrapping key"))
                    .and_then(|wrap| {
                        if !adopt_child_keychain_is_off() {
                            // Never let this step touch the profile's keychain
                            // slot: it holds the active folder's key.
                            return Err(invalid_input(format!(
                                "{ADOPT_KEY_BUNDLE_CMD} runs only with \
                                 {ADOPT_CHILD_KEYCHAIN_ENV}={ADOPT_CHILD_KEYCHAIN}"
                            )));
                        }
                        crate::crypto_host::install();
                        adopt_key_bundle_here(&wrap, bundle.trim())
                    }),
            }
        }
        "export" => {
            let from = flag("--from")
                .map(PathBuf::from)
                .unwrap_or_else(paths::ryu_dir);
            let out = flag("--out").map(PathBuf::from);
            match out {
                Some(out) => match maintenance_lease(&[from.clone(), out.clone()], false) {
                    Ok(_maintenance) => match archive_passphrase() {
                        Some(passphrase) => export_zip(&from, &out, &passphrase).map(|_| ()),
                        None => Err(invalid_input(format!(
                            "data-path export needs a passphrase: set {ARCHIVE_PASSPHRASE_ENV} or pass --passphrase-stdin"
                        ))),
                    },
                    Err(error) => Err(error),
                },
                None => {
                    eprintln!("data-path export requires --out <zip> [--from <dir>] [--passphrase-stdin]");
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

    const TEST_PASSPHRASE: &str = "correct horse battery";

    /// Export with the minimum accepted KDF cost so the suite stays fast.
    fn test_export(from: &Path, out: &Path) -> std::io::Result<u64> {
        export_zip_with_iterations(from, out, TEST_PASSPHRASE, EXPORT_MIN_ITERATIONS)
    }

    fn open_test_archive(path: &Path) -> zip::ZipArchive<std::fs::File> {
        // A destination that does not exist decrypts into the OS temp dir.
        let destination = path.with_extension("restore-target");
        zip::ZipArchive::new(open_data_archive(path, &destination, Some(TEST_PASSPHRASE)).unwrap())
            .unwrap()
    }

    #[test]
    fn mutating_maintenance_requires_stopped_runtime_but_export_can_read_online() {
        let base = tempfile::tempdir().unwrap();
        let data = base.path().join("data");
        std::fs::create_dir_all(data.join("nested")).unwrap();
        let cache = dirs::cache_dir().unwrap().join("ryu-update-recovery");
        let runtime =
            ryu_runtime_install::data_lease::DataLease::writer(&cache, &[data.clone()]).unwrap();
        assert!(maintenance_lease(&[data.join("nested")], true).is_err());
        assert!(maintenance_lease(&[data.clone()], false).is_ok());
        drop(runtime);
        assert!(maintenance_lease(&[data], true).is_ok());
    }

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
        let bytes = test_export(&src, &zip).unwrap();
        assert_eq!(bytes, 10); // "hello" + "world"

        let dest = base.join("restored");
        // import_zip also writes the pointer; that's fine in a test (config dir).
        let mut archive = open_test_archive(&zip);
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

    #[cfg(unix)]
    #[test]
    fn copy_tree_and_profile_copy_recreate_relative_symlinks() {
        let base = std::env::temp_dir().join(format!("ryu-dp-symlink-{}", uniq()));
        let from = base.join("from");
        let engine = from.join("engines/llm/llamacpp");
        std::fs::create_dir_all(&engine).unwrap();
        std::fs::write(engine.join("libllama.1.dylib"), b"lib").unwrap();
        std::os::unix::fs::symlink("libllama.1.dylib", engine.join("libllama.dylib")).unwrap();

        for (label, to) in [
            ("copy_tree", base.join("to")),
            ("filtered", base.join("profile")),
        ] {
            let mut copied = 0u64;
            if label == "copy_tree" {
                copy_tree(&from, &to, &mut copied, &mut |_| {}).unwrap();
            } else {
                copy_tree_filtered(&from, &to, &mut copied, &mut |_| {}).unwrap();
            }
            let alias = to.join("engines/llm/llamacpp/libllama.dylib");
            assert!(
                std::fs::symlink_metadata(&alias)
                    .unwrap()
                    .file_type()
                    .is_symlink(),
                "{label}: alias stays a symlink"
            );
            assert_eq!(
                std::fs::read_link(&alias).unwrap(),
                Path::new("libllama.1.dylib"),
                "{label}: target copied verbatim"
            );
            assert_eq!(
                std::fs::read(&alias).unwrap(),
                b"lib",
                "{label}: alias resolves"
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn export_zip_of_empty_dir_writes_zero_bytes() {
        let base = std::env::temp_dir().join(format!("ryu-dp-empty-{}", uniq()));
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let zip = base.join("out.zip");
        let written = test_export(&src, &zip).unwrap();
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
        std::fs::create_dir_all(src.join("secrets")).unwrap();
        std::fs::write(src.join("secrets/master.key"), b"key").unwrap();
        std::fs::write(src.join("secrets/opaque-credential"), b"secret").unwrap();

        let archive_path = base.join("backup.zip");
        test_export(&src, &archive_path).unwrap();
        let mut archive = open_test_archive(&archive_path);
        let names = (0..archive.len())
            .map(|index| {
                archive
                    .by_index(index)
                    .unwrap()
                    .name()
                    .unwrap()
                    .into_owned()
            })
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
            "secrets/opaque-credential",
        ] {
            assert!(!names.iter().any(|entry| entry == name), "exported {name}");
        }
        assert!(names.iter().any(|entry| entry == "conversations.db"));
        assert!(
            names.iter().any(|entry| entry == "secrets/master.key"),
            "the encryption key must travel with the encrypted databases"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn export_is_encrypted_on_disk_and_needs_the_passphrase() {
        let base = tempfile::tempdir().unwrap();
        let src = base.path().join("src");
        std::fs::create_dir_all(src.join("secrets")).unwrap();
        let secret = "sk-live-export-credential-0123456789";
        std::fs::write(src.join("preferences.json"), secret).unwrap();
        std::fs::write(src.join("secrets/master.key"), "master-key-bytes-base64").unwrap();
        let out = base.path().join("backup.zip");
        test_export(&src, &out).unwrap();

        // Neither the stored secret, the key file, nor zip structure is visible.
        let bytes = std::fs::read(&out).unwrap();
        assert!(bytes.starts_with(EXPORT_MAGIC));
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains(secret));
        assert!(!text.contains("master-key-bytes-base64"));
        assert!(!text.contains("preferences.json"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&out).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "export must be owner-only");
        }
        // No plaintext staging file is left next to the export.
        let siblings: Vec<_> = std::fs::read_dir(base.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(siblings.len(), 2, "{siblings:?}");

        // Round-trip with the passphrase.
        let mut archive = open_test_archive(&out);
        let mut restored = String::new();
        archive
            .by_name("preferences.json")
            .unwrap()
            .read_to_string(&mut restored)
            .unwrap();
        assert_eq!(restored, secret);

        // Missing or wrong passphrases fail closed.
        let missing = open_data_archive(&out, &src, None).unwrap_err();
        assert!(missing.to_string().contains("passphrase"));
        let wrong = open_data_archive(&out, &src, Some("wrong passphrase!!")).unwrap_err();
        assert_eq!(wrong.kind(), std::io::ErrorKind::PermissionDenied);
        // A truncated or edited file is rejected, never partially imported.
        let mut damaged = bytes.clone();
        let last = damaged.len() - 1;
        damaged[last] ^= 1;
        let damaged_path = base.path().join("damaged.zip");
        std::fs::write(&damaged_path, damaged).unwrap();
        assert!(open_data_archive(&damaged_path, &src, Some(TEST_PASSPHRASE)).is_err());
    }

    /// The plaintext zip of an export or import lives in the data folder's
    /// owner-only `tmp/<owner>`, never in the archive's folder (the backup
    /// medium). Linux names an anonymous file's directory in `/proc/self/fd`,
    /// whether it was made with `O_TMPFILE` or named and then unlinked.
    #[cfg(target_os = "linux")]
    #[test]
    fn plaintext_scratch_stays_in_the_data_folder_tmp_not_the_backup_medium() {
        use std::os::unix::io::AsRawFd;
        let base = tempfile::tempdir().unwrap();
        let data = base.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let medium = base.path().join("usb");
        std::fs::create_dir_all(&medium).unwrap();
        for owner in [EXPORT_SCRATCH_OWNER, IMPORT_SCRATCH_OWNER] {
            let file = plaintext_scratch(&data, owner).unwrap();
            let link = std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).unwrap();
            let scratch = layout::tmp_dir_for(&data, owner);
            assert!(link.starts_with(&scratch), "{link:?} not under {scratch:?}");
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&scratch).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "scratch dir must be owner-only");
            // Nothing in the scratch dir is reachable by name.
            assert_eq!(std::fs::read_dir(&scratch).unwrap().count(), 0);
        }
        // A destination that does not exist yet falls back to the OS temp dir,
        // never the archive's folder.
        let file = plaintext_scratch(&medium.join("missing"), IMPORT_SCRATCH_OWNER).unwrap();
        let link = std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).unwrap();
        assert!(!link.starts_with(&medium), "{link:?}");

        // A full export and import write only the final archive to the medium.
        std::fs::write(data.join("preferences.json"), "sk-medium-check").unwrap();
        let out = medium.join("backup.zip");
        test_export(&data, &out).unwrap();
        let restore = base.path().join("restore");
        std::fs::create_dir_all(&restore).unwrap();
        import_zip(&out, &restore, Some(TEST_PASSPHRASE)).unwrap();
        let on_medium: Vec<_> = std::fs::read_dir(&medium)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(on_medium, vec![std::ffi::OsString::from("backup.zip")]);
        assert_eq!(
            std::fs::read_to_string(restore.join("preferences.json")).unwrap(),
            "sk-medium-check"
        );
    }

    #[test]
    fn export_refuses_a_short_passphrase_and_writes_nothing() {
        let base = tempfile::tempdir().unwrap();
        let src = base.path().join("src");
        std::fs::create_dir_all(&src).unwrap();
        let out = base.path().join("backup.zip");
        for passphrase in ["", "short"] {
            let error = export_zip(&src, &out, passphrase).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        }
        assert!(!out.exists());
    }

    #[test]
    fn legacy_plain_zip_exports_still_open_without_a_passphrase() {
        let base = tempfile::tempdir().unwrap();
        let legacy = base.path().join("legacy.zip");
        {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&legacy).unwrap());
            zip.start_file("a.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"hello").unwrap();
            zip.finish().unwrap();
        }
        for passphrase in [None, Some(TEST_PASSPHRASE)] {
            let mut archive =
                zip::ZipArchive::new(open_data_archive(&legacy, base.path(), passphrase).unwrap())
                    .unwrap();
            let mut text = String::new();
            archive
                .by_name("a.txt")
                .unwrap()
                .read_to_string(&mut text)
                .unwrap();
            assert_eq!(text, "hello");
        }
    }

    #[test]
    fn export_zip_rejects_a_destination_inside_the_data_folder() {
        let base = std::env::temp_dir().join(format!("ryu-dp-overlap-{}", uniq()));
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let result = test_export(&src, &src.join("backup.zip"));
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
        assert!(is_backup_excluded(Path::new("nested/NODE-AUTH.TOKEN")));
        assert!(is_backup_excluded(Path::new("Core.Token")));
        assert!(is_backup_excluded(Path::new("plugin-credentials")));
        assert!(is_backup_excluded(Path::new(
            "plugin-credentials/service.json"
        )));
        assert!(is_backup_excluded(Path::new(
            "nested/PLUGIN-CREDENTIALS/service.json"
        )));
        assert!(is_backup_excluded(Path::new(
            "fleet-artifacts/nested/private.json"
        )));
        assert!(!is_backup_excluded(Path::new(
            "plugin-credentials-copy/notes.json"
        )));
        assert!(is_backup_excluded(Path::new(
            "state/fleet-enrolled-node.json"
        )));
        assert!(is_backup_excluded(Path::new(
            "runtimes/codex-home/auth.json.ryu-safety-backup"
        )));
        assert!(!is_backup_excluded(Path::new("db/conversations.db")));
    }

    #[test]
    fn backup_excludes_linked_plan_account_sign_ins() {
        assert!(is_backup_excluded(Path::new(
            "state/plan-accounts/anthropic-0a1b2c3d4e5f/.credentials.json"
        )));
        assert!(is_backup_excluded(Path::new(
            "state/plan-accounts/anthropic-0a1b2c3d4e5f/.claude.json"
        )));
        assert!(is_backup_excluded(Path::new(
            "state/plan-accounts/openai-0a1b2c3d4e5f/auth.json"
        )));
        assert!(is_backup_excluded(Path::new("state/plan-accounts")));
        // The same files are left out wherever a CLI keeps them under the data dir.
        assert!(is_backup_excluded(Path::new(
            "runtimes/claude-home/.credentials.json"
        )));
    }

    #[test]
    fn backup_keeps_only_the_key_custody_files_from_secrets() {
        assert!(!is_backup_excluded(Path::new("secrets")));
        assert!(!is_backup_excluded(Path::new("secrets/master.key")));
        assert!(!is_backup_excluded(Path::new("secrets/memory.key")));
        assert!(is_backup_excluded(Path::new("secrets/core.token")));
        assert!(is_backup_excluded(Path::new("secrets/some-new-credential")));
        assert!(is_backup_excluded(Path::new(
            "secrets/native-accounts/a.json"
        )));
        assert!(is_backup_excluded(Path::new("secrets/plugin-credentials")));
        assert!(!is_backup_excluded(Path::new("state/secrets-notes.json")));
    }

    #[test]
    fn backup_copy_stops_at_declared_expansion_limit() {
        let mut source = std::io::Cursor::new(b"forged-expanded-payload".to_vec());
        let mut output = Vec::new();
        let error = copy_declared_backup_entry(&mut source, &mut output, 4, 100)
            .expect_err("understated ZIP size must fail");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert_eq!(output.len(), 5);
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
            "secrets/core.token", // target would claim the source's node identity (409 on init)
            "secrets/master.key", // key material travels only through the keychain copy operation
            "secrets/memory.key", // retired legacy raw key must never be resurrected on the target
            "secrets/node-auth.token", // this node's minted RYU_TOKEN — copying it leaks the secret
            "state/nodes.json",   // absolute URLs with the SOURCE profile's hardcoded port
            "secrets/auth.json",  // plaintext device sign-in token
            "state/ryu-core.pid", // the source's live process id
            ".reset-pending",     // a pending wipe would fire on the target
            "bin",                // .version markers make the target adopt source binaries
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
            "db",
            "db/conversations.db",
            "db/spaces.db",
            "db/agents.db",
            "db/plugins.db",
            "db/preferences.db",
            "files",
            "files/media",
            "models",
            "plugins",
            "state",
            "state/workflows",
            "secrets",
        ] {
            assert!(
                !is_profile_copy_excluded(name),
                "'{name}' is user content and must be copied"
            );
        }
    }

    /// The exclusion matches exact data-dir-relative paths. A plugin that keeps
    /// its own `cache/` inside its data directory is the plugin's business, and
    /// dropping it would corrupt that plugin's state rather than protect anything.
    #[test]
    fn exclusion_is_by_exact_path_not_by_substring() {
        assert!(is_profile_copy_excluded("cache"));
        assert!(!is_profile_copy_excluded("plugin-data/acme/cache"));
        assert!(!is_profile_copy_excluded("my-cache"));
        assert!(is_profile_copy_excluded("bin"));
        assert!(!is_profile_copy_excluded("binaries"));
        assert!(!is_profile_copy_excluded("nodes.json"));
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
        let roots = auxiliary_roots(Some(&config), "-canary");
        let paths: Vec<String> = roots
            .iter()
            .map(|(_, p)| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(paths.len(), 1, "shadow/ghost live under the data dir now");
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
        std::fs::create_dir_all(config.join("ryu")).unwrap();
        std::fs::write(config.join("ryu/gateway.toml"), b"[gateway]").unwrap();
        // Must survive: not one of the auxiliary roots.
        std::fs::create_dir_all(home.join(".ryu")).unwrap();

        let removed = deep_clean(&home, Some(&config), "");
        assert_eq!(removed.len(), 1, "the config dir");
        assert!(!config.join("ryu").exists());
        assert!(
            home.join(".ryu").exists(),
            "the DATA dir is the node reset's job, not deep-clean's"
        );

        // Second run is a no-op rather than an error.
        assert!(deep_clean(&home, Some(&config), "").is_empty());
        let _ = std::fs::remove_dir_all(&base);
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
        std::fs::create_dir_all(dir.join("engines")).unwrap();
        std::fs::create_dir_all(dir.join("plugins")).unwrap();
        std::fs::create_dir_all(dir.join("db")).unwrap();
        std::fs::create_dir_all(dir.join("secrets")).unwrap();
        std::fs::write(dir.join("db/conversations.db"), b"db").unwrap();
        std::fs::write(dir.join("bin/ryu-core"), b"ELF").unwrap();
        std::fs::write(dir.join("secrets/master.key"), b"key").unwrap();
        std::fs::write(dir.join("secrets/core.token"), b"token").unwrap();

        assert!(!clean_profile_data(&home, "-canary", CleanDepth::State).is_empty());
        assert!(
            dir.join("bin/ryu-core").exists(),
            "bin survives a state clean"
        );
        assert!(dir.join("models").exists(), "models survive a state clean");
        assert!(
            dir.join("engines").exists(),
            "engines survive a state clean"
        );
        assert!(
            dir.join("secrets/master.key").exists(),
            "the key is node identity and must survive — there is no rekey path"
        );
        assert!(!dir.join("secrets/core.token").exists());
        assert!(!dir.join("db").exists());
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
        std::fs::create_dir_all(from.join("files/media/clips")).unwrap();
        std::fs::create_dir_all(from.join("plugin-data/acme/cache")).unwrap();
        std::fs::create_dir_all(from.join("secrets")).unwrap();
        std::fs::create_dir_all(from.join("state")).unwrap();
        std::fs::create_dir_all(from.join("db")).unwrap();

        // Must NOT travel.
        std::fs::write(from.join("secrets/core.token"), b"node-identity").unwrap();
        std::fs::write(from.join("secrets/master.key"), b"raw-master-key").unwrap();
        std::fs::write(from.join("secrets/memory.key"), b"raw-legacy-key").unwrap();
        std::fs::write(
            from.join("state/nodes.json"),
            b"{\"url\":\"127.0.0.1:7980\"}",
        )
        .unwrap();
        std::fs::write(from.join("state/ryu-core.pid"), b"1234").unwrap();
        std::fs::write(from.join("bin/ryu-core"), b"ELF").unwrap();

        // Must travel.
        let db = b"SQLite format 3\0payload";
        std::fs::write(from.join("db/conversations.db"), db).unwrap();
        std::fs::write(from.join("state/catalog-sources.json"), b"{}").unwrap();
        std::fs::write(from.join("files/media/clips/a.mp4"), b"video-bytes").unwrap();
        // A plugin's OWN nested cache is its business — exact-path exclusion only.
        std::fs::write(from.join("plugin-data/acme/cache/warm"), b"warm").unwrap();

        let mut copied = 0u64;
        let mut sink = |_: u64| {};
        copy_tree_filtered(&from, &to, &mut copied, &mut sink).unwrap();

        for gone in [
            "secrets/core.token",
            "secrets/master.key",
            "secrets/memory.key",
            "state/nodes.json",
            "state/ryu-core.pid",
            "bin",
        ] {
            assert!(
                !to.join(gone).exists(),
                "'{gone}' must not be copied between profiles"
            );
        }
        assert_eq!(
            std::fs::read(to.join("db/conversations.db")).unwrap(),
            db,
            "user content must arrive byte for byte"
        );
        assert!(to.join("state/catalog-sources.json").exists());
        assert_eq!(
            std::fs::read(to.join("files/media/clips/a.mp4")).unwrap(),
            b"video-bytes"
        );
        assert!(
            to.join("plugin-data/acme/cache/warm").exists(),
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

    /// A key custody stand-in: the "source" holds key A, adoption records the
    /// target's key file as it was at that moment (it must not have been
    /// replaced by the archive yet).
    struct FakeKeys {
        current: [u8; 32],
        adopted: std::sync::Mutex<Vec<(PathBuf, String, Option<Vec<u8>>)>>,
    }

    impl KeyBundlePort for FakeKeys {
        fn seal_for(&self, _from: &Path, wrap: &[u8; 32]) -> std::io::Result<Option<String>> {
            use base64::Engine as _;
            let body = serde_json::json!({
                "v": 1,
                "current": base64::engine::general_purpose::STANDARD.encode(self.current),
            });
            Ok(Some(
                ryu_crypto::FieldCipher::new(wrap)
                    .seal(&body.to_string())
                    .unwrap(),
            ))
        }

        fn adopt_into(&self, to: &Path, wrap: &[u8; 32], sealed: &str) -> std::io::Result<()> {
            let opened = ryu_crypto::FieldCipher::new(wrap)
                .open(sealed)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            let key_file = std::fs::read(to.join("secrets/master.key")).ok();
            self.adopted
                .lock()
                .unwrap()
                .push((to.to_path_buf(), opened, key_file));
            Ok(())
        }
    }

    #[test]
    fn export_carries_the_key_bundle_and_import_adopts_it_before_restoring() {
        use base64::Engine as _;
        let base = tempfile::tempdir().unwrap();
        let source_key = [0x41u8; 32];
        let target_key = [0x42u8; 32];
        // The source folder: a sealed row and its own key records.
        let src = base.path().join("src");
        std::fs::create_dir_all(src.join("secrets")).unwrap();
        std::fs::create_dir_all(src.join("state")).unwrap();
        std::fs::create_dir_all(src.join("db")).unwrap();
        let source_row = ryu_crypto::FieldCipher::new(&source_key)
            .seal("source row")
            .unwrap();
        std::fs::write(src.join("db/rows.txt"), &source_row).unwrap();
        std::fs::write(src.join("secrets/master.key"), "source-file-key").unwrap();
        std::fs::write(src.join("state/master-key.kcv"), "{\"kcv\":\"source\"}").unwrap();
        std::fs::write(src.join("state/retired-keys.json"), "[]").unwrap();
        let keys = FakeKeys {
            current: source_key,
            adopted: std::sync::Mutex::new(Vec::new()),
        };
        let out = base.path().join("backup.zip");
        export_zip_with(&src, &out, TEST_PASSPHRASE, EXPORT_MIN_ITERATIONS, &keys).unwrap();

        // The bundle sits inside the encrypted stream only.
        let raw = std::fs::read(&out).unwrap();
        let encoded_key = base64::engine::general_purpose::STANDARD.encode(source_key);
        assert!(!String::from_utf8_lossy(&raw).contains(&encoded_key));
        assert!(!String::from_utf8_lossy(&raw).contains(KEY_BUNDLE_ENTRY));
        let mut archive = open_test_archive(&out);
        assert!(archive.by_name(KEY_BUNDLE_ENTRY).is_ok());

        // A fresh install that already sealed a row of its own under its key.
        let target = base.path().join("target");
        std::fs::create_dir_all(target.join("secrets")).unwrap();
        std::fs::create_dir_all(target.join("db")).unwrap();
        std::fs::write(target.join("secrets/master.key"), "target-file-key").unwrap();
        let target_row = ryu_crypto::FieldCipher::new(&target_key)
            .seal("target row")
            .unwrap();
        std::fs::write(target.join("db/own.txt"), &target_row).unwrap();

        import_zip_with(&out, &target, Some(TEST_PASSPHRASE), &keys).unwrap();

        let adopted = keys.adopted.lock().unwrap();
        assert_eq!(adopted.len(), 1);
        let (to, bundle, key_file_then) = &adopted[0];
        assert_eq!(to, &target);
        assert!(bundle.contains(&encoded_key));
        // Adoption ran before any file was replaced.
        assert_eq!(key_file_then.as_deref(), Some(&b"target-file-key"[..]));
        // The archive's key file and key records are superseded by the bundle;
        // the bundle itself is never written into the folder.
        assert_eq!(
            std::fs::read(target.join("secrets/master.key")).unwrap(),
            b"target-file-key"
        );
        assert!(!target.join("state/master-key.kcv").exists());
        assert!(!target.join("state/retired-keys.json").exists());
        assert!(!target.join(KEY_BUNDLE_ENTRY).exists());
        // The restored store and the target's own row both open under the
        // adopted key with the target's previous key retired (what custody's
        // import does with the bundle).
        let adopted_cipher = ryu_crypto::FieldCipher::new(&source_key).with_retired(&[target_key]);
        let restored = std::fs::read_to_string(target.join("db/rows.txt")).unwrap();
        assert_eq!(adopted_cipher.open(&restored).unwrap(), "source row");
        assert_eq!(adopted_cipher.open(&target_row).unwrap(), "target row");
    }

    /// A custody that never holds the exported folder's key (a non-active folder).
    struct ForeignFolderKeys;

    impl KeyBundlePort for ForeignFolderKeys {
        fn seal_for(&self, _from: &Path, _wrap: &[u8; 32]) -> std::io::Result<Option<String>> {
            Ok(None)
        }

        fn adopt_into(&self, _to: &Path, _wrap: &[u8; 32], _sealed: &str) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn export_of_a_non_active_folder_with_key_records_fails_closed() {
        let base = tempfile::tempdir().unwrap();
        let src = base.path().join("src");
        std::fs::create_dir_all(src.join("state")).unwrap();
        std::fs::write(src.join("state/master-key.kcv"), "{\"kcv\":\"source\"}").unwrap();
        let out = base.path().join("backup.zip");
        let error = export_zip_with(
            &src,
            &out,
            TEST_PASSPHRASE,
            EXPORT_MIN_ITERATIONS,
            &ForeignFolderKeys,
        )
        .unwrap_err();
        assert!(error.to_string().contains("active data folder"), "{error}");
        assert!(!out.exists(), "no archive was written");

        // A folder with no key records still exports without a bundle.
        let plain = base.path().join("plain");
        std::fs::create_dir_all(plain.join("db")).unwrap();
        std::fs::write(plain.join("db/rows.txt"), "plaintext").unwrap();
        export_zip_with(
            &plain,
            &out,
            TEST_PASSPHRASE,
            EXPORT_MIN_ITERATIONS,
            &ForeignFolderKeys,
        )
        .unwrap();
        assert!(out.exists());
    }

    #[test]
    fn real_key_bundle_is_only_written_for_the_active_folder_and_opens_its_data() {
        use base64::Engine as _;
        let wrap = [9u8; 32];
        let other = tempfile::tempdir().unwrap();
        assert!(CustodyKeyBundles
            .seal_for(other.path(), &wrap)
            .unwrap()
            .is_none());
        let sealed = CustodyKeyBundles
            .seal_for(&paths::ryu_dir(), &wrap)
            .unwrap()
            .expect("the active folder always exports its key");
        let bundle: serde_json::Value =
            serde_json::from_str(&ryu_crypto::FieldCipher::new(&wrap).open(&sealed).unwrap())
                .unwrap();
        let current: [u8; 32] = base64::engine::general_purpose::STANDARD
            .decode(bundle["current"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let value = ryu_crypto::global_cipher().unwrap().seal("row").unwrap();
        assert_eq!(
            ryu_crypto::FieldCipher::new(&current).open(&value).unwrap(),
            "row"
        );
        assert_eq!(
            bundle["kcv"].as_str().unwrap(),
            ryu_crypto::key_check_value(&current)
        );
    }

    #[test]
    fn adopting_into_another_folder_never_reaches_the_profile_keychain() {
        let target = tempfile::tempdir().unwrap();
        let command = adopt_child_command(Path::new("/bin/true"), target.path());
        let envs: std::collections::HashMap<_, _> = command
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(
            envs.get("RYU_KEYCHAIN"),
            Some(&Some("off".to_owned())),
            "the child must keep the active folder's keychain slot untouched"
        );
        assert_eq!(
            envs.get(paths::RYU_DIR_ENV),
            Some(&Some(target.path().to_string_lossy().into_owned()))
        );
        assert!(
            !matches!(envs.get("RYU_MASTER_KEY"), Some(Some(_))),
            "the child must not inherit the active folder's env key"
        );
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["data-path", ADOPT_KEY_BUNDLE_CMD]);
    }

    #[test]
    fn a_bundle_in_an_unencrypted_archive_is_refused() {
        let base = tempfile::tempdir().unwrap();
        let legacy = base.path().join("legacy.zip");
        {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&legacy).unwrap());
            zip.start_file(KEY_BUNDLE_ENTRY, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"enc:v1:bogus").unwrap();
            zip.finish().unwrap();
        }
        let keys = FakeKeys {
            current: [1; 32],
            adopted: std::sync::Mutex::new(Vec::new()),
        };
        let target = base.path().join("target");
        std::fs::create_dir_all(&target).unwrap();
        let error = import_zip_with(&legacy, &target, None, &keys).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(keys.adopted.lock().unwrap().is_empty());
    }

    fn bundle_less_archive(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, bytes) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn a_bundle_less_archive_adopts_its_raw_key_instead_of_overwriting_the_target_key() {
        use base64::Engine as _;
        let base = tempfile::tempdir().unwrap();
        let archive_key = [0x51u8; 32];
        let legacy_key = [0x52u8; 32];
        let encoded = base64::engine::general_purpose::STANDARD.encode(archive_key);
        let encoded_legacy = base64::engine::general_purpose::STANDARD.encode(legacy_key);
        let archive = base.path().join("old.zip");
        bundle_less_archive(
            &archive,
            &[
                ("secrets/master.key", encoded.as_bytes()),
                ("secrets/memory.key", encoded_legacy.as_bytes()),
                ("db/rows.txt", b"archive row"),
            ],
        );
        // A file-custody target with its own key and key check value.
        let target = base.path().join("target");
        std::fs::create_dir_all(target.join("secrets")).unwrap();
        std::fs::create_dir_all(target.join("state")).unwrap();
        std::fs::write(target.join("secrets/master.key"), "target-file-key").unwrap();
        std::fs::write(target.join("state/master-key.kcv"), "{\"kcv\":\"target\"}").unwrap();
        let keys = FakeKeys {
            current: [0; 32],
            adopted: std::sync::Mutex::new(Vec::new()),
        };

        import_zip_with(&archive, &target, None, &keys).unwrap();

        let adopted = keys.adopted.lock().unwrap();
        assert_eq!(adopted.len(), 1, "the raw key goes through adoption");
        let (to, bundle, key_file_then) = &adopted[0];
        assert_eq!(to, &target);
        let bundle: serde_json::Value = serde_json::from_str(bundle).unwrap();
        assert_eq!(bundle["current"], encoded);
        assert_eq!(bundle["retired"], serde_json::json!([encoded_legacy]));
        // Adopted before any file was replaced, and the archive's key files are
        // never extracted over the target's (adoption retired that key).
        assert_eq!(key_file_then.as_deref(), Some(&b"target-file-key"[..]));
        assert_eq!(
            std::fs::read(target.join("secrets/master.key")).unwrap(),
            b"target-file-key"
        );
        assert!(!target.join("secrets/memory.key").exists());
        assert_eq!(
            std::fs::read(target.join("db/rows.txt")).unwrap(),
            b"archive row"
        );
    }

    #[test]
    fn a_bundle_less_archive_with_a_malformed_key_restores_nothing() {
        let base = tempfile::tempdir().unwrap();
        let archive = base.path().join("old.zip");
        bundle_less_archive(
            &archive,
            &[
                ("db/rows.txt", b"archive row"),
                ("secrets/master.key", b"not a key"),
            ],
        );
        let target = base.path().join("target");
        std::fs::create_dir_all(&target).unwrap();
        let keys = FakeKeys {
            current: [0; 32],
            adopted: std::sync::Mutex::new(Vec::new()),
        };
        let error = import_zip_with(&archive, &target, None, &keys).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
        assert!(keys.adopted.lock().unwrap().is_empty());
        assert!(!target.join("db/rows.txt").exists());
    }

    #[test]
    fn a_bundle_less_archive_without_key_files_restores_as_before() {
        let base = tempfile::tempdir().unwrap();
        let archive = base.path().join("old.zip");
        bundle_less_archive(&archive, &[("db/rows.txt", b"archive row")]);
        let target = base.path().join("target");
        std::fs::create_dir_all(&target).unwrap();
        let keys = FakeKeys {
            current: [0; 32],
            adopted: std::sync::Mutex::new(Vec::new()),
        };
        import_zip_with(&archive, &target, None, &keys).unwrap();
        assert!(keys.adopted.lock().unwrap().is_empty());
        assert!(target.join("db/rows.txt").exists());
    }

    #[test]
    fn a_bundle_less_archive_never_replaces_the_target_key_records() {
        // An export of a folder that is not the active one carries that
        // folder's key records but no key to adopt.
        let base = tempfile::tempdir().unwrap();
        let archive = base.path().join("other-folder.zip");
        bundle_less_archive(
            &archive,
            &[
                ("db/rows.txt", b"archive row"),
                ("state/master-key.kcv", b"{\"kcv\":\"foreign\"}"),
                (
                    "state/retired-keys.json",
                    b"[{\"kcv\":\"foreign-retired\"}]",
                ),
            ],
        );
        let target = base.path().join("target");
        std::fs::create_dir_all(target.join("state")).unwrap();
        std::fs::write(target.join("state/master-key.kcv"), "{\"kcv\":\"target\"}").unwrap();
        std::fs::write(
            target.join("state/retired-keys.json"),
            "[{\"kcv\":\"target-retired\"}]",
        )
        .unwrap();
        let keys = FakeKeys {
            current: [0; 32],
            adopted: std::sync::Mutex::new(Vec::new()),
        };

        import_zip_with(&archive, &target, None, &keys).unwrap();

        assert!(keys.adopted.lock().unwrap().is_empty());
        assert_eq!(
            std::fs::read(target.join("db/rows.txt")).unwrap(),
            b"archive row"
        );
        // The target's key check value and retired index still describe the
        // key it holds, so custody resolves it at the next boot.
        assert_eq!(
            std::fs::read_to_string(target.join("state/master-key.kcv")).unwrap(),
            "{\"kcv\":\"target\"}"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("state/retired-keys.json")).unwrap(),
            "[{\"kcv\":\"target-retired\"}]"
        );

        // A fresh target records the key it holds at first boot: the foreign
        // check value is not restored, a retired index (which names keys the
        // target may or may not hold) is.
        let fresh = base.path().join("fresh");
        std::fs::create_dir_all(&fresh).unwrap();
        import_zip_with(&archive, &fresh, None, &keys).unwrap();
        assert!(!fresh.join("state/master-key.kcv").exists());
        assert!(fresh.join("state/retired-keys.json").exists());
    }
}
