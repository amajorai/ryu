//! Shadow-Git workspace checkpoints for chat rewind.
//!
//! Every chat turn can snapshot the files of its working folder before an agent
//! runs, so the user can later restore the folder to the state it had before
//! that turn. Agents write files in many ways (ACP `fs/write_text_file`, their
//! own edit tools, shell commands, `apply_patch`), so the snapshot is taken of
//! the folder itself rather than of individual tool calls. That keeps the
//! behavior identical for every agent and provider.
//!
//! The snapshots live in a private Git directory per workspace, under a
//! caller-supplied store root (Core uses `RYU_DIR/state/chat-checkpoints`). The
//! user's own `.git` is never read or written: Git is always invoked with an
//! explicit `--git-dir` (the shadow store) and `--work-tree` (the workspace).
//! The workspace's `.gitignore` files apply, plus a small set of dependency and
//! build directories that are never worth snapshotting. Content is stored
//! byte-for-byte: the shadow repository overrides every `.gitattributes`
//! filter, line-ending, and encoding rule.
//!
//! Every snapshot is a parentless commit. `HEAD` names the latest one (an
//! unchanged folder reuses it), and each snapshot a caller still needs is kept
//! reachable by an owner ref, `refs/ryu/owners/<owner>/<commit>` ([`pin`]).
//! Releasing an owner ([`WorkspaceCheckpoints::release_owner`], Core calls it
//! when a conversation is deleted) or the age cap
//! ([`WorkspaceCheckpoints::prune_older_than`]) drops refs and garbage-collects
//! the objects nothing else references; a store with nothing left is deleted.
//! Stores written by older builds chained every snapshot on `main`; that chain
//! is kept under `refs/ryu/legacy` until it ages out.
//!
//! Snapshots are not encrypted: they are Git objects so restore and diff work,
//! and they copy the user's own plaintext folder. Credential files are never
//! captured (see `SENSITIVE_EXCLUDES`).
//!
//! [`pin`]: WorkspaceCheckpoints::pin
//!
//! The first snapshot of a folder that is itself a Git repository is seeded
//! from that repository: its index is copied and its objects are borrowed
//! read-only (Git alternates), then every tracked file is re-hashed byte-exact.
//! That turns a full re-compression of the project into a fast hash pass. A
//! background step then copies the borrowed objects into the private store
//! and drops the alternates link, so later garbage collection or history
//! rewrites in the user's repository can never break a checkpoint.
//!
//! # Restore safety
//!
//! A restore first snapshots the current folder, then changes a path only
//! when the bytes on disk are provably saved in that snapshot. A path that is
//! not saved (ignored, too large, unreadable, or changed mid-restore), a path
//! blocked by a folder, and a path below a symbolic link are skipped and
//! reported, never overwritten or deleted. Each file is written to a temporary
//! sibling and renamed into place, so a failure leaves either the old or the
//! new content, never a partial file.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use crate::win_process::NoWindow;

/// More pending paths than this and a snapshot is skipped instead of stalling
/// the turn. Only the first snapshot of a folder stages every file; later ones
/// stage just the changes.
pub const MAX_SNAPSHOT_PENDING_PATHS: usize = 200_000;
/// Files larger than this are excluded from snapshots (and therefore are never
/// restored or removed by a rewind).
pub const MAX_SNAPSHOT_FILE_BYTES: u64 = 25 * 1024 * 1024;

const DEFAULT_EXCLUDES: &str = "\
# Managed by Ryu chat checkpoints. Paths below the marker are files that were
# too large to snapshot; they are never restored or removed by a rewind.
node_modules/
target/
.venv/
venv/
__pycache__/
.next/
.turbo/
.gradle/
.ryu-worktrees/
.DS_Store
# ryu:large-files
";

/// Credential files never enter a checkpoint: the shadow store is plain Git
/// objects that outlive the workspace copy, so a `.env` or private key copied
/// once would stay on disk after the user deleted it. These files are treated
/// like ignored files (never restored or removed by a rewind). Appended to
/// every store's `info/exclude`, including stores created by older builds.
const SENSITIVE_EXCLUDES_MARKER: &str = "# ryu:sensitive";
const SENSITIVE_EXCLUDES: &str = "\
# ryu:sensitive -- credential files are never snapshotted.
.env
.env.*
*.pem
*.key
*.p12
*.pfx
id_rsa*
id_dsa*
id_ecdsa*
id_ed25519*
.npmrc
.netrc
.pgpass
credentials.json
";

/// `$GIT_DIR/info/attributes` outranks every in-tree `.gitattributes`, so this
/// turns off clean/smudge filters (Git LFS and friends), line-ending and
/// encoding conversion, and keyword expansion: snapshots hold the exact bytes.
const BYTE_EXACT_ATTRIBUTES: &str = "* -text -filter -ident -working-tree-encoding\n";

/// Present while a seeded store still has to re-hash its copied index.
const SEED_PENDING: &str = "ryu-seed-pending";
/// Owner refs: `refs/ryu/owners/<owner>/<commit>`.
const OWNER_REF_PREFIX: &str = "refs/ryu/owners/";
/// The snapshot chain an older build left on `main`.
const LEGACY_REF: &str = "refs/ryu/legacy";
/// Present in stores whose snapshots are parentless (owner-pinned).
const PARENTLESS_MARKER: &str = "ryu-parentless";

/// How long an unchanged `HEAD` is reused as the next snapshot. Older trees get
/// a fresh commit so every pin carries a current date for the age cap (whose
/// shortest setting is one day).
const HEAD_REUSE_WINDOW_SECS: i64 = 60 * 60;
const GITLINK_MODE: &str = "160000";
const SYMLINK_MODE: &str = "120000";
const EXECUTABLE_MODE: &str = "100755";

/// Where a checkpoint skipped capturing the workspace, and why.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "reason")]
pub enum SkipReason {
    /// The workspace path is missing or is not a directory.
    NotADirectory,
    /// The workspace is a filesystem root or the home directory.
    UnsafeRoot,
    /// The workspace has more pending paths than a snapshot will capture.
    TooManyFiles { count: usize },
    /// `git` could not be run on this machine.
    GitUnavailable,
}

/// One captured snapshot.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Commit id in the shadow repository.
    pub commit: String,
    /// Canonical workspace path the snapshot was taken of.
    pub workspace: PathBuf,
}

/// The result of asking for a snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotOutcome {
    Captured(Snapshot),
    Skipped(SkipReason),
}

/// How a file differs between a checkpoint and the current workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    /// Created after the checkpoint; a restore removes it.
    Added,
    /// Changed after the checkpoint; a restore puts the old content back.
    Modified,
    /// Deleted after the checkpoint; a restore recreates it.
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Workspace-relative path with `/` separators.
    pub path: String,
    pub kind: FileChangeKind,
}

/// Why a restore left a path alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkippedReason {
    /// The current bytes are not in any snapshot (ignored, too large,
    /// unreadable, or changed while restoring), so changing them could lose
    /// work.
    NotSaved,
    /// A folder now occupies the path, or a file occupies one of its parent
    /// folders.
    PathBlocked,
    /// A parent folder is a symbolic link; writing through it could leave the
    /// workspace.
    SymlinkParent,
    /// The filesystem refused the write or delete.
    WriteFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedPath {
    /// Workspace-relative path with `/` separators.
    pub path: String,
    pub reason: SkippedReason,
}

/// What a restore did.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    /// Files written back to their checkpoint content (modified or recreated).
    pub restored: Vec<String>,
    /// Files created after the checkpoint that were removed.
    pub removed: Vec<String>,
    /// Paths left untouched to protect unsaved work. Empty for a full restore.
    pub skipped: Vec<SkippedPath>,
    /// Snapshot of the workspace taken immediately before the restore, so the
    /// restore itself can be undone.
    pub pre_restore: Snapshot,
}

/// Shadow-Git checkpoint store rooted at one directory.
#[derive(Debug, Clone)]
pub struct WorkspaceCheckpoints {
    store_root: PathBuf,
}

impl WorkspaceCheckpoints {
    pub fn new(store_root: PathBuf) -> Self {
        Self { store_root }
    }

    /// Snapshot the workspace's current files. Unchanged content reuses the
    /// previous commit, so repeated snapshots are cheap and idempotent.
    pub fn snapshot(&self, workspace: &Path, label: &str) -> std::io::Result<SnapshotOutcome> {
        self.snapshot_for(workspace, label, None)
    }

    /// [`Self::snapshot`] and [`Self::pin`] under one lock acquisition, so a
    /// concurrent release or prune cannot collect the snapshot before it is
    /// pinned for `owner`.
    pub fn snapshot_pinned(
        &self,
        workspace: &Path,
        label: &str,
        owner: &str,
    ) -> std::io::Result<SnapshotOutcome> {
        self.snapshot_for(workspace, label, Some(owner))
    }

    fn snapshot_for(
        &self,
        workspace: &Path,
        label: &str,
        owner: Option<&str>,
    ) -> std::io::Result<SnapshotOutcome> {
        let workspace = match resolve_workspace(workspace) {
            Ok(path) => path,
            Err(reason) => return Ok(SnapshotOutcome::Skipped(reason)),
        };
        if !git_available() {
            return Ok(SnapshotOutcome::Skipped(SkipReason::GitUnavailable));
        }
        let shadow = self.shadow_for(&workspace);
        let lock = shadow.lock();
        let _guard = lock
            .lock()
            .map_err(|_| io_error("checkpoint lock is poisoned"))?;
        shadow.ensure_repository()?;
        let outcome = shadow.snapshot_locked(label)?;
        if let (Some(owner), SnapshotOutcome::Captured(snapshot)) = (owner, &outcome) {
            shadow.pin_locked(owner, &snapshot.commit)?;
        }
        drop(_guard);
        if shadow.borrows_objects() {
            spawn_localize(shadow);
        }
        Ok(outcome)
    }

    /// Copy any objects still borrowed from the workspace's own repository
    /// into the private store, synchronously. Snapshots schedule this in the
    /// background; it is public for tests and maintenance.
    pub fn localize_objects(&self, workspace: &Path) -> std::io::Result<()> {
        let workspace = resolve_workspace(workspace).map_err(skip_error)?;
        let shadow = self.shadow_for(&workspace);
        localize_locked(&shadow)
    }

    /// List how the workspace differs from `commit` now. This is what a
    /// restore of `commit` would undo.
    pub fn changes_since(
        &self,
        workspace: &Path,
        commit: &str,
    ) -> std::io::Result<Vec<FileChange>> {
        validate_commit_id(commit)?;
        let workspace = resolve_workspace(workspace).map_err(skip_error)?;
        let shadow = self.shadow_for(&workspace);
        let lock = shadow.lock();
        let _guard = lock
            .lock()
            .map_err(|_| io_error("checkpoint lock is poisoned"))?;
        shadow.require_commit(commit)?;
        shadow.ensure_repository()?;
        let current = match shadow.stage_workspace()? {
            Staged::Tree(tree) => tree,
            Staged::Skipped(reason) => return Err(skip_error(reason)),
        };
        let entries = shadow.diff_trees(commit, &current)?;
        Ok(entries
            .into_iter()
            .filter(|entry| !entry.is_gitlink())
            .filter_map(|entry| {
                let kind = match entry.status {
                    b'A' => FileChangeKind::Added,
                    b'D' => FileChangeKind::Deleted,
                    b'M' | b'T' => FileChangeKind::Modified,
                    _ => return None,
                };
                Some(FileChange {
                    path: display_path(&entry.path),
                    kind,
                })
            })
            .collect())
    }

    /// Restore the workspace to `commit`: files changed or deleted since are
    /// written back and files created since are removed. Ignored files, files
    /// over [`MAX_SNAPSHOT_FILE_BYTES`], and nested Git repositories are left
    /// alone. A snapshot of the current state is taken first and returned, so
    /// the restore can itself be undone. See the module docs for the safety
    /// rules; paths they protect are listed in [`RestoreReport::skipped`].
    pub fn restore(&self, workspace: &Path, commit: &str) -> std::io::Result<RestoreReport> {
        self.restore_for(workspace, commit, None)
    }

    /// [`Self::restore`], pinning the pre-restore snapshot for `owner` under
    /// the same lock acquisition.
    pub fn restore_pinned(
        &self,
        workspace: &Path,
        commit: &str,
        owner: &str,
    ) -> std::io::Result<RestoreReport> {
        self.restore_for(workspace, commit, Some(owner))
    }

    fn restore_for(
        &self,
        workspace: &Path,
        commit: &str,
        owner: Option<&str>,
    ) -> std::io::Result<RestoreReport> {
        validate_commit_id(commit)?;
        let workspace = resolve_workspace(workspace).map_err(skip_error)?;
        let shadow = self.shadow_for(&workspace);
        let lock = shadow.lock();
        let _guard = lock
            .lock()
            .map_err(|_| io_error("checkpoint lock is poisoned"))?;
        shadow.require_commit(commit)?;
        shadow.ensure_repository()?;
        let pre_restore = match shadow.snapshot_locked("Before rewind")? {
            SnapshotOutcome::Captured(snapshot) => snapshot,
            SnapshotOutcome::Skipped(reason) => return Err(skip_error(reason)),
        };
        if let Some(owner) = owner {
            shadow.pin_locked(owner, &pre_restore.commit)?;
        }
        // Tracked paths whose bytes on disk differ from the pre-restore
        // snapshot (unreadable, or changed since it was staged).
        let unsaved = shadow.unsaved_paths()?;
        let entries = shadow.diff_trees(commit, &pre_restore.commit)?;

        let mut removals = Vec::new();
        let mut writes = Vec::new();
        for entry in entries.into_iter().filter(|entry| !entry.is_gitlink()) {
            match entry.status {
                b'A' => removals.push(entry),
                b'D' | b'M' | b'T' => writes.push(entry),
                _ => {}
            }
        }
        // Everything below only reads Git objects and edits the workspace one
        // path at a time. Nothing returns early, so the pre-restore snapshot is
        // always handed back with an accurate report.
        let mut report = RestoreReport {
            restored: Vec::new(),
            removed: Vec::new(),
            skipped: Vec::new(),
            pre_restore,
        };
        removals.sort_by(|left, right| right.path.cmp(&left.path));
        for entry in removals {
            let result = if unsaved.contains(&entry.path) {
                Err(SkippedReason::NotSaved)
            } else {
                shadow.remove_workspace_file(&entry.path)
            };
            match result {
                Ok(()) => report.removed.push(display_path(&entry.path)),
                Err(reason) => report.skipped.push(SkippedPath {
                    path: display_path(&entry.path),
                    reason,
                }),
            }
        }

        writes.sort_by(|left, right| left.path.cmp(&right.path));
        let blobs = shadow.read_blobs(writes.iter().map(|entry| entry.src_sha.as_str()));
        for entry in writes {
            let result = if entry.status != b'D' && unsaved.contains(&entry.path) {
                Err(SkippedReason::NotSaved)
            } else {
                match blobs.as_ref().map(|blobs| blobs.get(&entry.src_sha)) {
                    Ok(Some(content)) => shadow.write_workspace_file(
                        &entry.path,
                        &entry.src_mode,
                        content,
                        entry.status == b'D',
                    ),
                    _ => Err(SkippedReason::WriteFailed),
                }
            };
            match result {
                Ok(()) => report.restored.push(display_path(&entry.path)),
                Err(reason) => report.skipped.push(SkippedPath {
                    path: display_path(&entry.path),
                    reason,
                }),
            }
        }
        if let Err(error) = &blobs {
            tracing::warn!(%error, "checkpoint restore could not read snapshot objects");
        }
        Ok(report)
    }

    /// Keep `commit` (a snapshot of `workspace`) until `owner` is released.
    /// Core pins every snapshot it records under the conversation id.
    pub fn pin(&self, workspace: &Path, owner: &str, commit: &str) -> std::io::Result<()> {
        validate_commit_id(commit)?;
        let workspace = resolve_workspace(workspace).unwrap_or_else(|_| workspace.to_path_buf());
        let shadow = self.shadow_for(&workspace);
        let lock = shadow.lock();
        let _guard = lock
            .lock()
            .map_err(|_| io_error("checkpoint lock is poisoned"))?;
        shadow.pin_locked(owner, commit)
    }

    /// Drop every snapshot `owner` pinned in `workspace`. A store left with no
    /// owner and no legacy chain is deleted; otherwise unreferenced objects are
    /// garbage-collected. Works when the folder itself is gone.
    pub fn release_owner(&self, workspace: &Path, owner: &str) -> std::io::Result<()> {
        self.release_owners(workspace, &[owner])
    }

    /// Drop every snapshot any of `owners` pinned in `workspace`, then collect
    /// the store once. A bulk clear releases all the conversations it removed
    /// on one folder through here, so the store is garbage-collected once
    /// rather than once per conversation.
    pub fn release_owners(&self, workspace: &Path, owners: &[&str]) -> std::io::Result<()> {
        if owners.is_empty() {
            return Ok(());
        }
        let workspace = resolve_workspace(workspace).unwrap_or_else(|_| workspace.to_path_buf());
        let shadow = self.shadow_for(&workspace);
        if !shadow.git_dir.join("HEAD").is_file() {
            return Ok(());
        }
        let lock = shadow.lock();
        let _guard = lock
            .lock()
            .map_err(|_| io_error("checkpoint lock is poisoned"))?;
        let prefixes: Vec<String> = owners
            .iter()
            .map(|owner| format!("{OWNER_REF_PREFIX}{}/", owner_ref_segment(owner)))
            .collect();
        for reference in shadow.refs()? {
            if prefixes
                .iter()
                .any(|prefix| reference.name.starts_with(prefix.as_str()))
            {
                shadow.maintenance(&["update-ref", "-d", &reference.name])?;
            }
        }
        shadow.collect(None).map(|_| ())
    }

    /// Apply the age cap to every store under the root: owner refs and legacy
    /// chains whose snapshot is older than `max_age` are dropped, and stores
    /// with nothing left are deleted.
    pub fn prune_older_than(&self, max_age: std::time::Duration) -> std::io::Result<PruneReport> {
        let cutoff = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|now| now.saturating_sub(max_age).as_secs())
            .unwrap_or(0);
        let cutoff = i64::try_from(cutoff).unwrap_or(i64::MAX);
        let mut report = PruneReport::default();
        let Ok(entries) = std::fs::read_dir(&self.store_root) else {
            return Ok(report);
        };
        for entry in entries.flatten() {
            let git_dir = entry.path();
            if !git_dir.join("HEAD").is_file() {
                continue;
            }
            let workspace = std::fs::read_to_string(git_dir.join("ryu-workspace"))
                .map(PathBuf::from)
                .unwrap_or_else(|_| git_dir.clone());
            let shadow = ShadowRepo { git_dir, workspace };
            let lock = shadow.lock();
            let _guard = lock
                .lock()
                .map_err(|_| io_error("checkpoint lock is poisoned"))?;
            for reference in shadow.refs()? {
                let prunable =
                    reference.name.starts_with(OWNER_REF_PREFIX) || reference.name == LEGACY_REF;
                if prunable && reference.committed_at < cutoff {
                    shadow.maintenance(&["update-ref", "-d", &reference.name])?;
                    report.dropped_snapshots += 1;
                }
            }
            match shadow.collect(Some(cutoff)) {
                Ok(true) => report.removed_stores += 1,
                Ok(false) => {}
                Err(error) => {
                    tracing::warn!(%error, "could not prune a chat checkpoint store");
                }
            }
        }
        Ok(report)
    }

    fn shadow_for(&self, workspace: &Path) -> ShadowRepo {
        let key = workspace_key(workspace);
        ShadowRepo {
            git_dir: self.store_root.join(key),
            workspace: workspace.to_path_buf(),
        }
    }
}

/// What [`WorkspaceCheckpoints::prune_older_than`] did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneReport {
    /// Snapshot refs dropped for age.
    pub dropped_snapshots: usize,
    /// Stores deleted because nothing in them was still needed.
    pub removed_stores: usize,
}

struct RefEntry {
    name: String,
    committed_at: i64,
}

/// A ref-safe path segment for an owner id.
fn owner_ref_segment(owner: &str) -> String {
    if !owner.is_empty()
        && owner.len() <= 128
        && owner
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        owner.to_owned()
    } else {
        let mut hex = String::from("x");
        for byte in owner.as_bytes() {
            hex.push_str(&format!("{byte:02x}"));
        }
        hex
    }
}

fn owner_ref(owner: &str, commit: &str) -> String {
    format!("{OWNER_REF_PREFIX}{}/{commit}", owner_ref_segment(owner))
}

enum Staged {
    Tree(String),
    Skipped(SkipReason),
}

struct DiffEntry {
    src_mode: String,
    dst_mode: String,
    src_sha: String,
    status: u8,
    path: Vec<u8>,
}

impl DiffEntry {
    fn is_gitlink(&self) -> bool {
        self.src_mode == GITLINK_MODE || self.dst_mode == GITLINK_MODE
    }
}

struct ShadowRepo {
    git_dir: PathBuf,
    workspace: PathBuf,
}

impl ShadowRepo {
    fn lock(&self) -> Arc<Mutex<()>> {
        static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
        let mut locks = LOCKS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        locks
            .entry(self.git_dir.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn git(&self) -> Command {
        let mut command = Command::new("git");
        command
            .arg("--literal-pathspecs")
            .arg("--git-dir")
            .arg(&self.git_dir)
            .arg("--work-tree")
            .arg(&self.workspace)
            .args([
                "-c",
                if cfg!(windows) {
                    "core.hooksPath=NUL"
                } else {
                    "core.hooksPath=/dev/null"
                },
                "-c",
                "core.autocrlf=false",
                "-c",
                "core.safecrlf=false",
                "-c",
                "core.quotepath=false",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
                "-c",
                "core.longpaths=true",
                "-c",
                "core.sparseCheckout=false",
                "-c",
                "gc.auto=0",
                "-c",
                "user.name=Ryu",
                "-c",
                "user.email=local@ryu.dev",
                "-c",
                "commit.gpgSign=false",
            ])
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
            .stdin(Stdio::null())
            .no_window()
            .current_dir(&self.workspace);
        command
    }

    fn run_bytes(&self, args: &[&str]) -> std::io::Result<Vec<u8>> {
        let output = self.git().args(args).output()?;
        checked_output(args.first().copied().unwrap_or("git"), output)
    }

    fn run(&self, args: &[&str]) -> std::io::Result<String> {
        self.run_bytes(args)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Git against the store only (no work tree), for ref maintenance and
    /// garbage collection; works after the folder was deleted.
    fn maintenance(&self, args: &[&str]) -> std::io::Result<String> {
        let output = Command::new("git")
            .arg("--git-dir")
            .arg(&self.git_dir)
            .args(["-c", "gc.auto=0", "-c", "core.fsmonitor=false"])
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
            .stdin(Stdio::null())
            .no_window()
            .current_dir(&self.git_dir)
            .output()?;
        checked_output(args.first().copied().unwrap_or("git"), output)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Pin `commit` for `owner`; the caller holds the store lock.
    fn pin_locked(&self, owner: &str, commit: &str) -> std::io::Result<()> {
        self.require_commit_maintenance(commit)?;
        self.maintenance(&["update-ref", &owner_ref(owner, commit), commit])?;
        Ok(())
    }

    fn require_commit_maintenance(&self, commit: &str) -> std::io::Result<()> {
        self.maintenance(&["cat-file", "-e", &format!("{commit}^{{commit}}")])
            .map(|_| ())
            .map_err(|_| not_found("checkpoint snapshot not found"))
    }

    /// `refs/ryu/*` with the committer time of the commit each one names.
    fn refs(&self) -> std::io::Result<Vec<RefEntry>> {
        let raw = self.maintenance(&[
            "for-each-ref",
            "--format=%(refname)%09%(committerdate:unix)",
            "refs/ryu/",
        ])?;
        Ok(raw
            .lines()
            .filter_map(|line| {
                let (name, time) = line.split_once('\t')?;
                Some(RefEntry {
                    name: name.to_owned(),
                    committed_at: time.trim().parse().unwrap_or(0),
                })
            })
            .collect())
    }

    /// After refs were dropped: delete the store when nothing in it is needed
    /// any more (no owner ref, no legacy chain, and for a store from an older
    /// build, a latest snapshot older than `legacy_cutoff`), else drop `HEAD`
    /// when nothing pins it and garbage-collect. Returns whether the store was
    /// deleted.
    fn collect(&self, legacy_cutoff: Option<i64>) -> std::io::Result<bool> {
        let refs = self.refs()?;
        let parentless = self.git_dir.join(PARENTLESS_MARKER).is_file();
        let head = self
            .maintenance(&["rev-parse", "--quiet", "--verify", "HEAD^{commit}"])
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let head_time = match &head {
            Some(head) => self
                .maintenance(&["show", "-s", "--format=%ct", head])?
                .trim()
                .parse::<i64>()
                .unwrap_or(0),
            None => 0,
        };
        // A store from an older build never pinned its snapshots: its `main`
        // chain is what other conversations' rows point at.
        let unpinned_legacy_needed =
            !parentless && head.is_some() && legacy_cutoff.is_none_or(|cutoff| head_time >= cutoff);
        if refs.is_empty() && !unpinned_legacy_needed {
            std::fs::remove_dir_all(&self.git_dir)?;
            return Ok(true);
        }
        if parentless {
            if let Some(head) = &head {
                let pinned = refs
                    .iter()
                    .any(|reference| reference.name.ends_with(&format!("/{head}")));
                let legacy_head = refs.iter().any(|reference| reference.name == LEGACY_REF)
                    && self
                        .maintenance(&["rev-parse", LEGACY_REF])
                        .is_ok_and(|legacy| legacy.trim() == head);
                if !pinned && !legacy_head {
                    self.maintenance(&["update-ref", "-d", "HEAD"])?;
                    // The shadow index still names the blobs of the last
                    // capture, and `gc` keeps whatever an index names. Drop
                    // it so a released capture's content is pruned too; the
                    // next snapshot simply re-stages every file.
                    match std::fs::remove_file(self.git_dir.join("index")) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error),
                    }
                }
            }
        }
        self.maintenance(&["reflog", "expire", "--expire=now", "--all"])?;
        self.maintenance(&["gc", "--prune=now", "--quiet"])?;
        Ok(false)
    }

    fn run_with_input(&self, args: &[&str], input: Vec<u8>) -> std::io::Result<Vec<u8>> {
        let mut child = self
            .git()
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdin = child.stdin.take();
        // Feed stdin from a thread so a large output cannot deadlock against a
        // large input.
        let writer = std::thread::spawn(move || {
            if let Some(mut stdin) = stdin {
                let _ = stdin.write_all(&input);
            }
        });
        let output = child.wait_with_output()?;
        let _ = writer.join();
        checked_output(args.first().copied().unwrap_or("git"), output)
    }

    fn ensure_repository(&self) -> std::io::Result<()> {
        if !self.git_dir.join("HEAD").is_file() {
            std::fs::create_dir_all(&self.git_dir)?;
            let output = Command::new("git")
                .arg("--git-dir")
                .arg(&self.git_dir)
                .args(["init", "--quiet", "-b", "main"])
                .env_remove("GIT_DIR")
                .env_remove("GIT_WORK_TREE")
                .stdin(Stdio::null())
                .no_window()
                .current_dir(&self.git_dir)
                .output()?;
            checked_output("init", output)?;
            std::fs::write(
                self.git_dir.join("ryu-workspace"),
                self.workspace.to_string_lossy().as_bytes(),
            )?;
            std::fs::write(self.git_dir.join(PARENTLESS_MARKER), b"1\n")?;
            self.seed_from_workspace_repository();
        }
        if !self.git_dir.join(PARENTLESS_MARKER).is_file() {
            // A store from an older build: keep its chained snapshots under a
            // ref before new snapshots stop chaining onto `main`.
            if let Ok(head) = self.run(&["rev-parse", "--quiet", "--verify", "HEAD^{commit}"]) {
                let head = head.trim();
                if !head.is_empty() {
                    self.run(&["update-ref", LEGACY_REF, head])?;
                }
            }
            std::fs::write(self.git_dir.join(PARENTLESS_MARKER), b"1\n")?;
        }
        let info = self.git_dir.join("info");
        std::fs::create_dir_all(&info)?;
        let exclude = info.join("exclude");
        let current = std::fs::read_to_string(&exclude).unwrap_or_default();
        if !current.contains("# ryu:large-files") {
            std::fs::write(&exclude, DEFAULT_EXCLUDES)?;
        }
        let current = std::fs::read_to_string(&exclude).unwrap_or_default();
        if !current.contains(SENSITIVE_EXCLUDES_MARKER) {
            let mut file = std::fs::OpenOptions::new().append(true).open(&exclude)?;
            if !current.is_empty() && !current.ends_with('\n') {
                file.write_all(b"\n")?;
            }
            file.write_all(SENSITIVE_EXCLUDES.as_bytes())?;
        }
        // A store inside its own workspace (a data folder kept in the project)
        // must never snapshot itself.
        if let Some(own) = self.store_pattern_inside_workspace() {
            let current = std::fs::read_to_string(&exclude).unwrap_or_default();
            if !current.lines().any(|line| line == own) {
                let mut file = std::fs::OpenOptions::new().append(true).open(&exclude)?;
                writeln!(file, "{own}")?;
            }
        }
        let attributes = info.join("attributes");
        if std::fs::read_to_string(&attributes).ok().as_deref() != Some(BYTE_EXACT_ATTRIBUTES) {
            std::fs::write(&attributes, BYTE_EXACT_ATTRIBUTES)?;
        }
        Ok(())
    }

    /// Seed a new store from the workspace's own repository: borrow its
    /// objects and copy its index (which carries the stat data that lets Git
    /// skip unchanged files). Read-only toward the user's repository. Any
    /// failure leaves an unseeded store, which simply stages every file.
    fn seed_from_workspace_repository(&self) {
        let user_git = self.workspace.join(".git");
        let objects = user_git.join("objects");
        let index = user_git.join("index");
        if !(user_git.is_dir() && objects.is_dir() && index.is_file()) {
            return;
        }
        let Ok(objects) = std::fs::canonicalize(&objects) else {
            return;
        };
        let alternates = self.git_dir.join("objects").join("info").join("alternates");
        let seeded = std::fs::create_dir_all(alternates.parent().unwrap_or(&self.git_dir))
            .and_then(|()| std::fs::write(&alternates, format!("{}\n", objects.to_string_lossy())))
            .and_then(|()| std::fs::copy(&index, self.git_dir.join("index")).map(|_| ()))
            .and_then(|()| std::fs::write(self.git_dir.join(SEED_PENDING), b""));
        if seeded.is_err() {
            self.drop_seed();
        }
    }

    /// The copied index holds the user's blobs, which may be the output of
    /// clean filters (Git LFS pointers, normalized line endings). Re-hash every
    /// tracked file under the byte-exact attributes before the first snapshot.
    fn finish_seed(&self) {
        let marker = self.git_dir.join(SEED_PENDING);
        if !marker.exists() {
            return;
        }
        let renormalized = self
            .git()
            .args(["add", "--renormalize", "--ignore-errors", "--", "."])
            .output()
            .is_ok_and(|output| output.status.success());
        if renormalized {
            let _ = std::fs::remove_file(marker);
        } else {
            tracing::warn!("checkpoint seed could not be verified; staging every file");
            self.drop_seed();
        }
    }

    fn drop_seed(&self) {
        let _ = std::fs::remove_file(self.git_dir.join("index"));
        let _ = std::fs::remove_file(self.alternates_path());
        let _ = std::fs::remove_file(self.git_dir.join(SEED_PENDING));
    }

    fn alternates_path(&self) -> PathBuf {
        self.git_dir.join("objects").join("info").join("alternates")
    }

    fn borrows_objects(&self) -> bool {
        self.alternates_path().is_file()
    }

    fn store_pattern_inside_workspace(&self) -> Option<String> {
        let store = std::fs::canonicalize(self.git_dir.parent()?).ok()?;
        let store = strip_verbatim_prefix(store);
        let relative = store.strip_prefix(&self.workspace).ok()?;
        if relative.as_os_str().is_empty() {
            return None;
        }
        let relative = relative.to_string_lossy().replace('\\', "/");
        let escaped = escape_ignore_pattern(relative.as_bytes());
        Some(format!("/{}/", String::from_utf8_lossy(&escaped)))
    }

    /// Only this process touches the shadow repository, and the caller holds
    /// its lock, so an `index.lock` here was left by a crash. Left in place it
    /// would make every later snapshot fail.
    fn clear_stale_index_lock(&self) {
        let lock = self.git_dir.join("index.lock");
        if lock.exists() {
            tracing::warn!("removing a stale checkpoint index lock");
            let _ = std::fs::remove_file(lock);
        }
    }

    fn snapshot_locked(&self, label: &str) -> std::io::Result<SnapshotOutcome> {
        let tree = match self.stage_workspace()? {
            Staged::Tree(tree) => tree,
            Staged::Skipped(reason) => return Ok(SnapshotOutcome::Skipped(reason)),
        };
        let parent = self
            .run(&["rev-parse", "--quiet", "--verify", "HEAD^{commit}"])
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if let Some(parent) = parent.as_deref() {
            let parent_tree = self.run(&["rev-parse", &format!("{parent}^{{tree}}")])?;
            // Reuse `HEAD` only while it is recent: the age cap measures a pin
            // by its commit's date, so pinning a stale `HEAD` for a new turn
            // would let the next prune drop the checkpoint it just recorded.
            // An older unchanged tree gets a fresh commit (no new objects but
            // the commit itself).
            if parent_tree.trim() == tree && self.committed_recently(parent) {
                return Ok(SnapshotOutcome::Captured(Snapshot {
                    commit: parent.to_owned(),
                    workspace: self.workspace.clone(),
                }));
            }
        }
        // Parentless: each snapshot stays only as long as an owner ref (or the
        // `HEAD` dedupe pointer) names it.
        let message = sanitize_label(label);
        let args = vec!["commit-tree", tree.as_str(), "-m", message.as_str()];
        let commit = self.run(&args)?.trim().to_owned();
        self.run(&["update-ref", "HEAD", &commit])?;
        Ok(SnapshotOutcome::Captured(Snapshot {
            commit,
            workspace: self.workspace.clone(),
        }))
    }

    /// Whether `commit` was committed within [`HEAD_REUSE_WINDOW_SECS`].
    fn committed_recently(&self, commit: &str) -> bool {
        let Ok(committed) = self.run(&["show", "-s", "--format=%ct", commit]) else {
            return false;
        };
        let Ok(committed) = committed.trim().parse::<i64>() else {
            return false;
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|now| i64::try_from(now.as_secs()).unwrap_or(i64::MAX))
            .unwrap_or(0);
        now.saturating_sub(committed) < HEAD_REUSE_WINDOW_SECS
    }

    /// Stage the workspace into the shadow index and return the tree id.
    fn stage_workspace(&self) -> std::io::Result<Staged> {
        self.clear_stale_index_lock();
        self.finish_seed();
        let pending = self.pending_paths()?;
        if pending.len() > MAX_SNAPSHOT_PENDING_PATHS {
            return Ok(Staged::Skipped(SkipReason::TooManyFiles {
                count: pending.len(),
            }));
        }
        let large = pending
            .into_iter()
            .filter(|path| {
                std::fs::symlink_metadata(self.workspace.join(bytes_to_path(path)))
                    .is_ok_and(|meta| meta.is_file() && meta.len() > MAX_SNAPSHOT_FILE_BYTES)
            })
            .collect::<Vec<_>>();
        if !large.is_empty() {
            self.exclude_large_files(&large)?;
        }
        let output = self
            .git()
            .args(["add", "--all", "--ignore-errors", "--", "."])
            .output()?;
        if !output.status.success() {
            // `--ignore-errors` still exits non-zero after skipping a file it
            // could not read; that file keeps its previous snapshot content and
            // a restore treats it as unsaved. Anything else is a real failure.
            let stderr = String::from_utf8_lossy(&output.stderr);
            let fatal = stderr
                .lines()
                .any(|line| line.starts_with("fatal:") && !line.contains("adding files failed"));
            if fatal {
                return Err(io_error(format!(
                    "git add: {}",
                    stderr.trim().chars().take(400).collect::<String>()
                )));
            }
            tracing::warn!(
                stderr = %stderr.trim(),
                "checkpoint staging skipped files it could not read"
            );
        }
        // `add --all` still refreshes tracked files that are now excluded (the
        // user's own repository may track a `.env`, and a seeded or older store
        // may hold one), so drop credential files from the index before the
        // tree is written.
        self.untrack_sensitive_files()?;
        let tree = self.run(&["write-tree"])?.trim().to_owned();
        Ok(Staged::Tree(tree))
    }

    fn untrack_sensitive_files(&self) -> std::io::Result<()> {
        let mut args = vec!["ls-files", "-z", "--cached", "--ignored"];
        for pattern in SENSITIVE_EXCLUDES
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
        {
            args.extend(["-x", pattern]);
        }
        let tracked = self.run_bytes(&args)?;
        if tracked.iter().all(|byte| *byte == 0) {
            return Ok(());
        }
        self.run_with_input(
            &[
                "rm",
                "--cached",
                "--quiet",
                "--ignore-unmatch",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            tracked,
        )?;
        Ok(())
    }

    fn pending_paths(&self) -> std::io::Result<Vec<Vec<u8>>> {
        let raw = self.run_bytes(&[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ])?;
        Ok(raw
            .split(|byte| *byte == 0)
            .filter(|record| record.len() > 3)
            .map(|record| record[3..].to_vec())
            .collect())
    }

    fn exclude_large_files(&self, paths: &[Vec<u8>]) -> std::io::Result<()> {
        let exclude = self.git_dir.join("info").join("exclude");
        let mut file = std::fs::OpenOptions::new().append(true).open(&exclude)?;
        let mut input = Vec::new();
        for path in paths {
            file.write_all(b"/")?;
            file.write_all(&escape_ignore_pattern(path))?;
            file.write_all(b"\n")?;
            input.extend_from_slice(path);
            input.push(0);
        }
        self.run_with_input(
            &[
                "rm",
                "--cached",
                "--quiet",
                "--ignore-unmatch",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            input,
        )?;
        Ok(())
    }

    /// Tracked paths whose working-tree bytes differ from the index that was
    /// just written into a snapshot.
    fn unsaved_paths(&self) -> std::io::Result<HashSet<Vec<u8>>> {
        // Refresh stat data first so a merely-touched file is not reported.
        let _ = self
            .git()
            .args(["update-index", "-q", "--refresh"])
            .output();
        let raw = self.run_bytes(&["diff-files", "--name-only", "-z"])?;
        Ok(raw
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(<[u8]>::to_vec)
            .collect())
    }

    fn require_commit(&self, commit: &str) -> std::io::Result<()> {
        if !self.git_dir.join("HEAD").is_file() {
            return Err(not_found("this folder has no checkpoints"));
        }
        let output = self
            .git()
            .args(["cat-file", "-e", &format!("{commit}^{{commit}}")])
            .output()?;
        if output.status.success() {
            Ok(())
        } else {
            Err(not_found("checkpoint is no longer available"))
        }
    }

    fn diff_trees(&self, from: &str, to: &str) -> std::io::Result<Vec<DiffEntry>> {
        let raw = self.run_bytes(&["diff-tree", "-r", "-z", "--raw", "--no-renames", from, to])?;
        Ok(parse_raw_diff(&raw))
    }

    /// Read blob contents by id in one `git cat-file --batch` process.
    fn read_blobs<'a>(
        &self,
        ids: impl Iterator<Item = &'a str>,
    ) -> std::io::Result<HashMap<String, Vec<u8>>> {
        let mut unique = ids
            .filter(|id| id.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .map(str::to_owned)
            .collect::<Vec<_>>();
        unique.sort();
        unique.dedup();
        let mut blobs = HashMap::with_capacity(unique.len());
        if unique.is_empty() {
            return Ok(blobs);
        }
        let mut child = self
            .git()
            .args(["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut input = Vec::new();
        for id in &unique {
            input.extend_from_slice(id.as_bytes());
            input.push(b'\n');
        }
        let stdin = child.stdin.take();
        let writer = std::thread::spawn(move || {
            if let Some(mut stdin) = stdin {
                let _ = stdin.write_all(&input);
            }
        });
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io_error("git cat-file has no output"))?;
        let mut reader = BufReader::new(stdout);
        for id in &unique {
            let mut header = String::new();
            reader.read_line(&mut header)?;
            let mut fields = header.split_whitespace();
            let (Some(_), Some(kind), Some(size)) = (fields.next(), fields.next(), fields.next())
            else {
                // `<id> missing`: leave it out; the caller reports the path.
                continue;
            };
            let size = size
                .parse::<usize>()
                .map_err(|_| io_error("git cat-file returned an invalid size"))?;
            let mut content = vec![0; size];
            reader.read_exact(&mut content)?;
            let mut newline = [0u8; 1];
            reader.read_exact(&mut newline)?;
            if kind == "blob" {
                blobs.insert(id.clone(), content);
            }
        }
        let _ = writer.join();
        let _ = child.wait();
        Ok(blobs)
    }

    /// Resolve a workspace-relative path for writing. Every existing ancestor
    /// must be a real directory: a symbolic link could point outside the
    /// workspace, and a file means the path is blocked.
    fn checked_target(&self, relative: &[u8]) -> Result<PathBuf, SkippedReason> {
        let relative_path = bytes_to_path(relative);
        if relative.is_empty()
            || relative_path.is_absolute()
            || relative_path
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(SkippedReason::PathBlocked);
        }
        let target = self.workspace.join(&relative_path);
        let mut ancestor = self.workspace.clone();
        let components = relative_path.components().collect::<Vec<_>>();
        for component in &components[..components.len().saturating_sub(1)] {
            ancestor.push(component);
            match std::fs::symlink_metadata(&ancestor) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(SkippedReason::SymlinkParent)
                }
                Ok(meta) if !meta.is_dir() => return Err(SkippedReason::PathBlocked),
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(_) => return Err(SkippedReason::WriteFailed),
            }
        }
        Ok(target)
    }

    fn remove_workspace_file(&self, relative: &[u8]) -> Result<(), SkippedReason> {
        let target = self.checked_target(relative)?;
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.is_dir() => return Err(SkippedReason::PathBlocked),
            Ok(_) => std::fs::remove_file(&target).map_err(|_| SkippedReason::WriteFailed)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(SkippedReason::WriteFailed),
        }
        // Drop directories the removed file leaves empty, never the workspace.
        let mut parent = target.parent();
        while let Some(dir) = parent {
            if dir == self.workspace || !dir.starts_with(&self.workspace) {
                break;
            }
            if std::fs::remove_dir(dir).is_err() {
                break;
            }
            parent = dir.parent();
        }
        Ok(())
    }

    /// Write one file's checkpoint content. `absent_now` is set when the path
    /// is not in the pre-restore snapshot: anything found there is unsaved.
    fn write_workspace_file(
        &self,
        relative: &[u8],
        mode: &str,
        content: &[u8],
        absent_now: bool,
    ) -> Result<(), SkippedReason> {
        let target = self.checked_target(relative)?;
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.is_dir() => return Err(SkippedReason::PathBlocked),
            Ok(_) if absent_now => return Err(SkippedReason::NotSaved),
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(SkippedReason::WriteFailed),
        }
        let parent = target.parent().ok_or(SkippedReason::PathBlocked)?;
        std::fs::create_dir_all(parent).map_err(|_| SkippedReason::PathBlocked)?;
        // Keep an existing file's permissions (a private `.env` stays
        // private); only the executable bit follows the checkpoint.
        let existing = std::fs::symlink_metadata(&target)
            .ok()
            .filter(std::fs::Metadata::is_file)
            .map(|meta| meta.permissions());
        let temporary = parent.join(format!(".ryu-restore-{}.tmp", uuid::Uuid::new_v4()));
        let written = write_temporary(&temporary, mode, content, existing)
            .and_then(|()| std::fs::rename(&temporary, &target));
        if written.is_err() {
            let _ = std::fs::remove_file(&temporary);
            return Err(SkippedReason::WriteFailed);
        }
        Ok(())
    }
}

/// Run [`localize_locked`] on a background thread, once per store at a time.
fn spawn_localize(shadow: ShadowRepo) {
    static RUNNING: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    let running = RUNNING.get_or_init(|| Mutex::new(HashSet::new()));
    if !running
        .lock()
        .map(|mut set| set.insert(shadow.git_dir.clone()))
        .unwrap_or(false)
    {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("ryu-checkpoint-localize".into())
        .spawn(move || {
            if let Err(error) = localize_locked(&shadow) {
                tracing::warn!(%error, "checkpoint objects are still borrowed from the workspace repository");
            }
            if let Ok(mut set) = running.lock() {
                set.remove(&shadow.git_dir);
            }
        });
    if spawned.is_err() {
        tracing::warn!("could not start checkpoint object copy");
    }
}

/// Copy borrowed objects into the private store, prove every snapshot is
/// complete without the user's repository, then drop the alternates link.
/// On any failure the link stays, so nothing becomes unreadable.
fn localize_locked(shadow: &ShadowRepo) -> std::io::Result<()> {
    let lock = shadow.lock();
    let _guard = lock
        .lock()
        .map_err(|_| io_error("checkpoint lock is poisoned"))?;
    let alternates = shadow.alternates_path();
    if !alternates.is_file() {
        return Ok(());
    }
    // Without `-l`, `repack -a` copies borrowed objects into the new pack.
    shadow.run(&["repack", "-a", "-d", "-q"])?;
    let parked = alternates.with_extension("ryu-pending");
    std::fs::rename(&alternates, &parked)?;
    let complete = shadow
        .git()
        .args([
            "fsck",
            "--connectivity-only",
            "--no-dangling",
            "--no-progress",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if complete {
        std::fs::remove_file(parked)?;
        Ok(())
    } else {
        std::fs::rename(&parked, &alternates)?;
        Err(io_error("copied checkpoint objects failed verification"))
    }
}

fn write_temporary(
    path: &Path,
    mode: &str,
    content: &[u8],
    existing: Option<std::fs::Permissions>,
) -> std::io::Result<()> {
    #[cfg(unix)]
    if mode == SYMLINK_MODE {
        use std::os::unix::ffi::OsStrExt as _;
        return std::os::unix::fs::symlink(std::ffi::OsStr::from_bytes(content), path);
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        // The process umask applies, as it does for `git checkout`.
        options.mode(if mode == EXECUTABLE_MODE {
            0o777
        } else {
            0o666
        });
    }
    #[cfg(not(unix))]
    let _ = (mode, EXECUTABLE_MODE, SYMLINK_MODE, existing.as_ref());
    let mut file = options.open(path)?;
    file.write_all(content)?;
    #[cfg(unix)]
    if let Some(existing) = existing {
        use std::os::unix::fs::PermissionsExt as _;
        let current = existing.mode() & 0o7777;
        let next = if mode == EXECUTABLE_MODE {
            // Grant execute wherever read is granted, as Git does.
            current | ((current & 0o444) >> 2)
        } else {
            current & !0o111
        };
        file.set_permissions(std::fs::Permissions::from_mode(next))?;
    }
    file.sync_all()
}

fn parse_raw_diff(raw: &[u8]) -> Vec<DiffEntry> {
    let mut entries = Vec::new();
    let mut fields = raw.split(|byte| *byte == 0);
    while let Some(header) = fields.next() {
        let Some(header) = header.strip_prefix(b":") else {
            continue;
        };
        let Some(path) = fields.next() else {
            break;
        };
        let header = String::from_utf8_lossy(header);
        let mut parts = header.split(' ');
        let src_mode = parts.next().unwrap_or_default().to_owned();
        let dst_mode = parts.next().unwrap_or_default().to_owned();
        let src_sha = parts.next().unwrap_or_default().to_owned();
        let status = parts
            .nth(1)
            .and_then(|value| value.bytes().next())
            .unwrap_or(b'?');
        entries.push(DiffEntry {
            src_mode,
            dst_mode,
            src_sha,
            status,
            path: path.to_vec(),
        });
    }
    entries
}

/// Git reports paths as raw bytes. On Unix those are the file name bytes; on
/// Windows Git uses UTF-8.
fn bytes_to_path(bytes: &[u8]) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt as _;
        PathBuf::from(std::ffi::OsStr::from_bytes(bytes))
    }
    #[cfg(not(unix))]
    {
        PathBuf::from(String::from_utf8_lossy(bytes).into_owned())
    }
}

fn display_path(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn resolve_workspace(workspace: &Path) -> Result<PathBuf, SkipReason> {
    let canonical = std::fs::canonicalize(workspace).map_err(|_| SkipReason::NotADirectory)?;
    if !canonical.is_dir() {
        return Err(SkipReason::NotADirectory);
    }
    if canonical.parent().is_none() {
        return Err(SkipReason::UnsafeRoot);
    }
    let home = dirs::home_dir().and_then(|home| std::fs::canonicalize(home).ok());
    if home.as_deref() == Some(canonical.as_path()) {
        return Err(SkipReason::UnsafeRoot);
    }
    Ok(strip_verbatim_prefix(canonical))
}

/// `canonicalize` on Windows returns `\\?\C:\…`, which Git does not accept as a
/// work tree. Use the plain drive path instead.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(stripped) = text.strip_prefix(r"\\?\") {
            if !stripped.starts_with("UNC\\") {
                return PathBuf::from(stripped);
            }
        }
    }
    path
}

fn workspace_key(workspace: &Path) -> String {
    // FNV-1a over the canonical path: stable across builds and platforms, and
    // only used to name a directory, never for integrity.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in workspace.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let name = workspace
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(32)
        .collect::<String>();
    if name.is_empty() {
        format!("{hash:016x}")
    } else {
        format!("{name}-{hash:016x}")
    }
}

fn git_available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        Command::new("git")
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .no_window()
            .status()
            .is_ok_and(|status| status.success())
    })
}

fn escape_ignore_pattern(path: &[u8]) -> Vec<u8> {
    let mut escaped = Vec::with_capacity(path.len());
    for byte in path {
        if matches!(byte, b'*' | b'?' | b'[' | b']' | b'\\' | b'!' | b'#' | b' ') {
            escaped.push(b'\\');
        }
        escaped.push(*byte);
    }
    escaped
}

fn sanitize_label(label: &str) -> String {
    let cleaned = label
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(200)
        .collect::<String>();
    if cleaned.trim().is_empty() {
        "Checkpoint".to_owned()
    } else {
        cleaned
    }
}

fn validate_commit_id(commit: &str) -> std::io::Result<()> {
    if commit.len() < 7
        || commit.len() > 64
        || !commit
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "checkpoint id is invalid",
        ));
    }
    Ok(())
}

fn checked_output(operation: &str, output: Output) -> std::io::Result<Vec<u8>> {
    if output.status.success() {
        return Ok(output.stdout);
    }
    let details = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(400)
        .collect::<String>();
    Err(io_error(if details.is_empty() {
        format!("git {operation} failed")
    } else {
        format!("git {operation}: {details}")
    }))
}

fn skip_error(reason: SkipReason) -> std::io::Error {
    let message = match reason {
        SkipReason::NotADirectory => "the chat folder no longer exists".to_owned(),
        SkipReason::UnsafeRoot => {
            "checkpoints are not taken of a home or filesystem root folder".to_owned()
        }
        SkipReason::TooManyFiles { count } => {
            format!("the chat folder has too many changed files to checkpoint ({count})")
        }
        SkipReason::GitUnavailable => "git is not available on this device".to_owned(),
    };
    std::io::Error::new(std::io::ErrorKind::Unsupported, message)
}

fn not_found(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::NotFound, message.to_owned())
}

fn io_error(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Other, message.into())
}

#[cfg(test)]
mod tests;
