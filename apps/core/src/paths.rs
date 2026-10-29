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

use ryu_sidecar_runtime::layout;

pub use ryu_runtime_install::data_paths::DataPathPointer;

fn bootstrap_paths() -> ryu_runtime_install::data_paths::DataPaths {
    ryu_runtime_install::data_paths::DataPaths::for_profile(
        crate::profile::profile(),
        dirs::home_dir(),
        dirs::config_dir(),
    )
    .expect("Core validated its active profile")
}

/// Env var that overrides the data dir outright.
pub const RYU_DIR_ENV: &str = "RYU_DIR";

/// The default data dir: `~/.ryu` (falling back to `./.ryu` if home is unknown).
///
/// Profile-aware (`RYU_PROFILE`): release ⇒ `~/.ryu` (byte-identical to today),
/// any other profile ⇒ `~/.ryu-<profile>` (e.g. `~/.ryu-dev`), so a dev stack's
/// data folder never overlaps a release stack's. Keeping this suffixed also keeps
/// [`is_custom`] honest under a profile (dev's default is its own baseline, not a
/// "relocation" off the release default).
pub fn default_ryu_dir() -> PathBuf {
    bootstrap_paths().default_data_dir
}

/// Directory holding the bootstrap pointer file. Lives in the OS *config* dir
/// (`%APPDATA%\ryu` on Windows, `~/.config/ryu` on Linux, `~/Library/Application
/// Support/ryu` on macOS), NOT inside the data dir.
///
/// Public because it is the only place a piece of state can live that must
/// SURVIVE a wipe of the data dir. `preferences.db` is inside the data dir, so it
/// cannot hold "did the user turn the wipe off" or "when did it last run" — the
/// first wipe erases both.
pub fn config_dir() -> PathBuf {
    // Profile-suffixed (`ryu` ⇒ `ryu-dev`) so the bootstrap pointer file is
    // isolated per profile too — a release relocation must not silently move a
    // dev stack's data dir (and vice-versa).
    bootstrap_paths().config_dir
}

/// Path to the data-path pointer file (`<config>/ryu/data-path.json`).
pub fn pointer_path() -> PathBuf {
    bootstrap_paths().pointer_path
}

/// Read the pointer file; returns the default (empty) pointer if absent/unparseable.
pub fn read_pointer() -> DataPathPointer {
    bootstrap_paths().read_pointer().unwrap_or_default()
}

/// Persist the pointer file (creating the config dir if needed).
pub fn write_pointer(pointer: &DataPathPointer) -> std::io::Result<()> {
    let path = pointer_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(pointer).map_err(std::io::Error::other)?;
    crate::atomic_file::write_atomic(&path, &json)
}

/// Set (or clear, with `None`) the active data dir in the pointer file. Takes
/// effect on the next Core start.
pub fn set_data_dir(dir: Option<&Path>) -> std::io::Result<()> {
    write_pointer(&DataPathPointer {
        data_dir: dir.map(|d| d.to_string_lossy().into_owned()),
    })
}

fn resolve() -> PathBuf {
    let paths = bootstrap_paths();
    // Preserve legacy boot behavior. Lifecycle discovery uses discover_ryu_dir
    // and must surface corrupt/inaccessible pointers instead of guessing a home.
    paths
        .resolve_data_dir(std::env::var_os(RYU_DIR_ENV))
        .unwrap_or(paths.default_data_dir)
}

/// Resolve the active data directory without executing Core or opening stores.
/// Unlike ordinary boot, lifecycle discovery fails on an invalid pointer.
pub fn discover_ryu_dir() -> std::io::Result<PathBuf> {
    bootstrap_paths().resolve_data_dir(std::env::var_os(RYU_DIR_ENV))
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

// ── Layout accessors ─────────────────────────────────────────────────────────
//
// Thin wrappers binding `ryu_sidecar_runtime::layout` to the active data dir.
// Never join a literal name onto `ryu_dir()`: every Core-owned path is built
// through one of these so the data dir stays one consistent hierarchy.
//
// The category dirs (`db/`, `state/`, `secrets/`, …) are created on first use,
// once per process, so a store that opens `db/<name>.db` never fails because a
// fresh (or freshly reset) data dir has no `db/` yet. `secrets/` is owner-only.

fn ensure_once(dir: PathBuf, once: &'static OnceLock<()>, private: bool) -> PathBuf {
    once.get_or_init(|| {
        if std::fs::create_dir_all(&dir).is_ok() && private {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
            }
        }
    });
    dir
}

/// `<data dir>/db` (created on first use).
pub fn db_dir() -> PathBuf {
    static ONCE: OnceLock<()> = OnceLock::new();
    ensure_once(layout::db_dir(&ryu_dir()), &ONCE, false)
}

/// `<data dir>/db/<file>` — a Core SQLite database.
pub fn db_path(file: &str) -> PathBuf {
    db_dir().join(file)
}

/// `<data dir>/state` (created on first use).
pub fn state_dir() -> PathBuf {
    static ONCE: OnceLock<()> = OnceLock::new();
    ensure_once(layout::state_dir(&ryu_dir()), &ONCE, false)
}

/// `<data dir>/state/<rel>` — Core JSON state or a structured state dir.
pub fn state_path(rel: &str) -> PathBuf {
    state_dir().join(rel)
}

/// `<data dir>/secrets` (created owner-only on first use).
pub fn secrets_dir() -> PathBuf {
    static ONCE: OnceLock<()> = OnceLock::new();
    ensure_once(layout::secrets_dir(&ryu_dir()), &ONCE, true)
}

/// `<data dir>/secrets/<file>` — a key, token or credential.
pub fn secret_path(file: &str) -> PathBuf {
    secrets_dir().join(file)
}

/// `<data dir>/cache` (created on first use).
pub fn cache_dir() -> PathBuf {
    static ONCE: OnceLock<()> = OnceLock::new();
    ensure_once(layout::cache_dir(&ryu_dir()), &ONCE, false)
}

/// `<data dir>/cache/<rel>` — a regenerable cache.
pub fn cache_path(rel: &str) -> PathBuf {
    cache_dir().join(rel)
}

/// `<data dir>/files/<rel>` — user content (blobs, media, voice, source-history).
pub fn files_path(rel: &str) -> PathBuf {
    static ONCE: OnceLock<()> = OnceLock::new();
    ensure_once(ryu_dir().join(layout::top::FILES), &ONCE, false);
    layout::files_path(&ryu_dir(), rel)
}

/// `<data dir>/logs` (created on first use).
pub fn logs_dir() -> PathBuf {
    static ONCE: OnceLock<()> = OnceLock::new();
    ensure_once(layout::logs_dir(&ryu_dir()), &ONCE, false)
}

/// `<data dir>/runtimes/<name>` — agent/tool runtimes (pi, acp-npm, npm, …).
pub fn runtime_dir(name: &str) -> PathBuf {
    layout::runtime_dir(&ryu_dir(), name)
}

/// `<data dir>/services/<name>` — first-party service state (ghost, shadow, …).
pub fn service_dir(name: &str) -> PathBuf {
    layout::service_dir(&ryu_dir(), name)
}

/// `<data dir>/bin` — Core/Gateway runtime generations and small standalone tools.
pub fn bin_dir() -> PathBuf {
    layout::bin_dir(&ryu_dir())
}

/// `<data dir>/tmp/<owner>` — scratch space owned by one component.
pub fn tmp_dir_for(owner: &str) -> PathBuf {
    layout::tmp_dir_for(&ryu_dir(), owner)
}

// ── Node reset ("wipe this node") ────────────────────────────────────────────
//
// A full node reset returns the node to a fresh, just-installed state: every
// store DB, session, download, and preference under the data dir is deleted, so
// the next start re-runs onboarding. It CANNOT be done live: the SQLite files are
// open (a live delete corrupts the `-wal`/`-shm` sidecars, and on Windows an open
// file can't be deleted at all). So the flow mirrors the data-path reset — the API
// handler only drops a marker and asks the desktop to restart Core; the actual
// wipe runs at the very start of the next boot, before any store opens.

/// Marker filename requesting a wipe on the next Core start (see [`request_node_reset`]).
const RESET_MARKER: &str = ".reset-pending";

/// Key-custody files inside `secrets/` that a reset must PRESERVE. Every other
/// secret (tokens, credentials, account vaults) is wiped.
///
/// `master.key` / `memory.key` hold the encryption keys when no OS keychain is
/// available; deleting them would change the node's identity and (on
/// keychain-less machines) orphan the key needed to boot.
const SECRETS_PRESERVE: &[&str] = &["master.key", "memory.key"];

/// Entries inside `bin/` that must survive a node reset so the desktop can
/// still resolve and launch Core/gateway without a full reinstall: the flat
/// `ryu-core`/`ryu-gateway` installs plus Desktop's runtime-generation layout
/// (`active.json` → `generations/generation-*/ryu-core`, and the
/// `prepared-stack.json` marker of a staged release). Deleting `generations/`
/// would delete the running Core itself.
const BIN_PRESERVE: &[&str] = &[
    "ryu-core",
    "ryu-core.exe",
    "ryu-core.version",
    "ryu-gateway",
    "ryu-gateway.exe",
    "ryu-gateway.version",
    "active.json",
    "prepared-stack.json",
    "generations",
];

/// Top-level dirs a reset SCRUBS instead of deleting: the folder stays, every
/// entry inside except the listed names is deleted. Everything else under the
/// data dir — every DB, download, cache, model and the `plugins/` tree — is
/// wiped whole. Scrubbing `bin/` (rather than keeping it) matters: otherwise a
/// "reset" leaves every previously-installed app binary on disk and the
/// catalog/onboarding path happily re-adopts them as still installed.
const RESET_SCRUBBED: &[(&str, &[&str])] = &[
    (layout::top::SECRETS, SECRETS_PRESERVE),
    (layout::top::BIN, BIN_PRESERVE),
];

fn scrub_allowlist(top_level_name: &str) -> Option<&'static [&'static str]> {
    RESET_SCRUBBED
        .iter()
        .find(|(name, _)| *name == top_level_name)
        .map(|(_, keep)| *keep)
}

/// Path of the reset marker inside the active data dir.
pub fn reset_marker_path() -> PathBuf {
    ryu_dir().join(RESET_MARKER)
}

/// Request a full node reset on the next Core start. Best-effort creates the data
/// dir first so the marker can be written even on an otherwise-empty install.
pub fn request_node_reset() -> std::io::Result<()> {
    let dir = ryu_dir();
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(RESET_MARKER), b"1")
}

/// If a reset was requested, wipe every entry in the data dir except the key
/// custody files and the boot runtime, then clear the marker. MUST run at
/// startup BEFORE any store opens its DB.
///
/// Fail-closed: if the wipe cannot finish (typically Windows sharing violations
/// from a still-alive sidecar), this process EXITS without opening any store.
/// Continuing to boot would re-lock the DBs forever and the marker could never
/// be consumed — the bug that left agents/plugins/apps intact after "reset".
/// The desktop's restart loop then starts a fresh Core against unlocked files.
pub fn apply_pending_reset() {
    let dir = ryu_dir();
    if !dir.join(RESET_MARKER).exists() {
        return;
    }
    crate::log_rotation::write_diagnostic(format!(
        "ryu-core: pending node reset — wiping data dir {}",
        dir.display()
    ));
    match wipe_dir_preserving_keys(&dir) {
        Ok(()) => crate::log_rotation::write_diagnostic("ryu-core: node reset wipe complete"),
        Err(e) => {
            crate::log_rotation::write_diagnostic(format!(
                "ryu-core: node reset wipe incomplete ({e}); exiting without opening stores so locks release and the next start can retry"
            ));
            // EX_TEMPFAIL-ish: desktop restartRyuCore will spawn us again.
            std::process::exit(75);
        }
    }
}

/// Delete every entry in `dir` except the reset marker, the key custody files
/// in `secrets/` and the boot runtime in `bin/`, then remove the marker. Split
/// out from [`apply_pending_reset`] so it is testable against an arbitrary
/// directory (the public entry point is bound to the cached `ryu_dir()`).
///
/// Retries briefly: on Windows the previous Core/sidecar process can still hold
/// SQLite handles for a short window after exit. Returns `Err` (and leaves the
/// marker in place) if anything non-preserved still remains after retries.
fn wipe_dir_preserving_keys(dir: &Path) -> std::io::Result<()> {
    const ATTEMPTS: u32 = 12;
    const SLEEP_MS: u64 = 400;

    let mut last_err: Option<std::io::Error> = None;
    for attempt in 1..=ATTEMPTS {
        last_err = None;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                // Keep the marker (removed last).
                if name_str == RESET_MARKER {
                    continue;
                }
                let path = entry.path();
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                let result = match scrub_allowlist(&name_str) {
                    Some(keep) if is_dir => scrub_dir(&path, keep),
                    _ if is_dir => std::fs::remove_dir_all(&path),
                    _ => std::fs::remove_file(&path),
                };
                if let Err(e) = result {
                    crate::log_rotation::write_diagnostic(format!(
                        "ryu-core: reset wipe attempt {attempt}/{ATTEMPTS} failed on {}: {e}",
                        path.display()
                    ));
                    last_err = Some(e);
                }
            }
        }

        if !reset_wipe_has_leftovers(dir) {
            let _ = std::fs::remove_file(dir.join(RESET_MARKER));
            return Ok(());
        }

        if attempt < ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(SLEEP_MS));
        }
    }

    Err(last_err.unwrap_or_else(|| {
        std::io::Error::other("node reset wipe left non-preserved entries after retries")
    }))
}

/// Delete every entry in `dir` except the names in `keep`.
fn scrub_dir(dir: &Path, keep: &[&str]) -> std::io::Result<()> {
    let mut first_err: Option<std::io::Error> = None;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if keep.contains(&name_str.as_ref()) {
            continue;
        }
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let result = if is_dir {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        if let Err(e) = result {
            if first_err.is_none() {
                first_err = Some(e);
            }
        }
    }
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// True when `dir` still contains anything that a successful reset would delete.
fn reset_wipe_has_leftovers(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == RESET_MARKER {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        match scrub_allowlist(&name_str) {
            Some(keep) if is_dir => {
                if dir_has_entries_outside(&entry.path(), keep) {
                    return true;
                }
            }
            _ => return true,
        }
    }
    false
}

fn dir_has_entries_outside(dir: &Path, keep: &[&str]) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries
        .flatten()
        .any(|entry| !keep.contains(&entry.file_name().to_string_lossy().as_ref()))
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
/// The probe itself is the model catalog's, so install-fit and this agree.
pub fn available_space_for(path: &Path) -> u64 {
    crate::model_catalog::device::available_space_for(path).unwrap_or(0)
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
    fn default_dir_matches_the_active_profile() {
        let expected = format!(".ryu{}", crate::profile::suffix());
        assert!(default_ryu_dir().ends_with(expected));
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
    fn reset_wipes_all_but_keys() {
        // A private directory per run: concurrent test processes (other
        // worktrees or agents) must never share and delete one another's base.
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();
        let db = layout::db_dir(&base);
        let secrets = layout::secrets_dir(&base);
        let bin = layout::bin_dir(&base);
        // Data to wipe: DB files and nested store dirs.
        std::fs::create_dir_all(&db).unwrap();
        std::fs::write(db.join("conversations.db"), b"x").unwrap();
        std::fs::write(db.join("agents.db"), b"a").unwrap();
        std::fs::write(db.join("plugins.db"), b"p").unwrap();
        std::fs::create_dir_all(layout::models_root(&base)).unwrap();
        std::fs::write(layout::models_root(&base).join("a.bin"), b"y").unwrap();
        std::fs::create_dir_all(layout::plugins_dir(&base)).unwrap();
        // The on-disk name, not the id: a scoped id is flattened by
        // `plugin_manifest::plugin_dir_name` before it is ever joined onto a path,
        // precisely so it stays ONE component (the loader's `read_dir` is
        // single-level, so a nested dir would be invisible).
        std::fs::write(layout::plugins_dir(&base).join("@ryu+clips"), b"z").unwrap();
        // secrets/: key custody files survive; tokens and credentials are wiped.
        std::fs::create_dir_all(&secrets).unwrap();
        std::fs::write(secrets.join("master.key"), b"k").unwrap();
        std::fs::write(secrets.join("memory.key"), b"m").unwrap();
        std::fs::write(secrets.join("core.token"), b"t").unwrap();
        std::fs::create_dir_all(secrets.join("plugin-credentials")).unwrap();
        // bin/: Core/gateway (flat and generation layout) survive; every other
        // sidecar is wiped.
        std::fs::create_dir_all(bin.join("generations").join("generation-abc")).unwrap();
        std::fs::write(
            bin.join("generations")
                .join("generation-abc")
                .join("ryu-core"),
            b"elf",
        )
        .unwrap();
        std::fs::write(bin.join("active.json"), b"{}").unwrap();
        std::fs::write(bin.join("prepared-stack.json"), b"{}").unwrap();
        std::fs::write(bin.join("ryu-core.exe"), b"elf").unwrap();
        std::fs::write(bin.join("ryu-gateway.exe"), b"gw").unwrap();
        std::fs::write(bin.join("deno"), b"deno").unwrap();
        std::fs::write(bin.join("some-app.exe"), b"app").unwrap();
        // The marker that arms the wipe.
        std::fs::write(base.join(RESET_MARKER), b"1").unwrap();

        wipe_dir_preserving_keys(&base).expect("wipe succeeds against unlocked temp dir");

        assert!(!db.exists());
        assert!(!layout::models_root(&base).exists());
        assert!(!layout::plugins_dir(&base).exists());
        assert!(!base.join(RESET_MARKER).exists());
        assert!(secrets.join("master.key").exists());
        assert!(secrets.join("memory.key").exists());
        assert!(
            !secrets.join("core.token").exists(),
            "reset must wipe tokens"
        );
        assert!(
            !secrets.join("plugin-credentials").exists(),
            "reset must wipe stored credentials"
        );
        assert!(
            bin.join("ryu-core.exe").exists(),
            "reset must keep ryu-core so the node can reboot"
        );
        assert!(
            bin.join("ryu-gateway.exe").exists(),
            "reset must keep ryu-gateway"
        );
        assert!(
            bin.join("generations")
                .join("generation-abc")
                .join("ryu-core")
                .exists(),
            "reset must keep Desktop's runtime generations (the running Core lives there)"
        );
        assert!(bin.join("active.json").exists());
        assert!(bin.join("prepared-stack.json").exists());
        assert!(
            !bin.join("deno").exists(),
            "reset must wipe non-essential bin tools"
        );
        assert!(
            !bin.join("some-app.exe").exists(),
            "reset must wipe previously-installed app binaries"
        );
    }

    #[test]
    fn reset_keeps_marker_when_wipe_blocked() {
        // Simulate a locked leftover: after a partial failure the marker must
        // survive so the next boot retries instead of silently keeping data.
        // A private directory per run: concurrent test processes (other
        // worktrees or agents) must never share and delete one another's base.
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();
        std::fs::write(base.join(RESET_MARKER), b"1").unwrap();
        std::fs::create_dir_all(layout::db_dir(&base)).unwrap();
        std::fs::write(layout::db_file(&base, "conversations.db"), b"x").unwrap();

        // Pretend wipe left leftovers by only checking the leftover detector —
        // the full wipe against an unlocked temp dir always succeeds; this
        // asserts the contract the retry loop depends on.
        assert!(reset_wipe_has_leftovers(&base));
        assert!(base.join(RESET_MARKER).exists());
        wipe_dir_preserving_keys(&base).unwrap();
        assert!(!reset_wipe_has_leftovers(&base));
        assert!(!base.join(RESET_MARKER).exists());
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

    /// The non-test part of a Rust source: everything before its first inline
    /// `#[cfg(test)] mod <name> {` block. A bare `#[cfg(test)]` item (a
    /// `mod x;` declaration, a test lock) does not end production code, so it must
    /// not hide the rest of the file from the guard below.
    fn production_part(source: &str) -> &str {
        static INLINE_TEST_MOD: OnceLock<regex::Regex> = OnceLock::new();
        let inline_test_mod = INLINE_TEST_MOD.get_or_init(|| {
            regex::Regex::new(
                r"#\[cfg\(test\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{",
            )
            .unwrap()
        });
        inline_test_mod
            .find(source)
            .map_or(source, |found| &source[..found.start()])
    }

    #[test]
    fn production_part_ignores_test_items_before_the_test_module() {
        let source = "#[cfg(test)]\nmod lsp_tests;\n\n#[cfg(test)]\nstatic LOCK: () = ();\n\nfn cache() { ryu_dir().join(\"x\"); }\n\n#[cfg(test)]\n#[allow(dead_code)]\nmod tests {\n    fn t() { ryu_dir().join(\"y\"); }\n}\n";
        let production = production_part(source);
        assert!(production.contains("ryu_dir().join(\"x\")"));
        assert!(!production.contains("ryu_dir().join(\"y\")"));
        assert_eq!(production_part("fn a() {}"), "fn a() {}");
    }

    /// Every data-dir path must go through `ryu_sidecar_runtime::layout` (or the
    /// accessors above), never `ryu_dir().join("<name>")`: a hand-joined name is how
    /// the data dir drifted into 150+ unorganised top-level entries. Scans the
    /// non-test part of every Rust source tree that touches the data dir.
    #[test]
    fn no_hand_built_data_dir_paths_outside_the_layout() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let roots = [
            "apps/core/src",
            "apps/gateway/src",
            "apps/desktop/src-tauri/src",
            "apps/ghost/src",
            "apps/shadow/src",
            "apps/passport/src",
            "crates",
            "apps-store",
        ];
        // Only the layout boundary itself may join onto the root.
        let allowed = ["apps/core/src/paths.rs", "crates/core/sidecar-runtime/src/"];
        let joined = regex::Regex::new(r"ryu_dir\(\)\s*\.join\(").unwrap();
        let mut offenders = Vec::new();
        let mut stack: Vec<PathBuf> = roots.iter().map(|r| repo.join(r)).collect();
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if path.is_dir() {
                    if !matches!(name.as_ref(), "target" | "node_modules" | "tests" | ".venv") {
                        stack.push(path);
                    }
                    continue;
                }
                if !name.ends_with(".rs")
                    || name.ends_with("_test.rs")
                    || name.ends_with("tests.rs")
                {
                    continue;
                }
                let rel = path
                    .strip_prefix(&repo)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                if allowed.iter().any(|a| rel.starts_with(a)) {
                    continue;
                }
                let Ok(source) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let code: String = production_part(&source)
                    .lines()
                    .filter(|line| !line.trim_start().starts_with("//"))
                    .collect::<Vec<_>>()
                    .join("\n");
                if joined.is_match(&code) {
                    offenders.push(rel);
                }
            }
        }
        offenders.sort();
        assert!(
            offenders.is_empty(),
            "build data-dir paths through ryu_sidecar_runtime::layout, not ryu_dir().join(..): {offenders:#?}"
        );
    }
}
