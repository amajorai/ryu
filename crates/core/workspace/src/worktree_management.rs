//! Managed retention only touches registered worktrees, and snapshots before removal.
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context};
use serde::{Deserialize, Serialize};

use super::{create_worktree_at, WorktreeGuard};
use crate::git_command::git_command;
use crate::win_process::NoWindow;

static MANAGEMENT_LOCK: Mutex<()> = Mutex::new(());

fn worktree_lease(id: &str) -> anyhow::Result<Option<File>> {
    // Locks live outside writable project metadata and stay bound to their inode.
    // Never unlink them: another Core may hold the same worktree's lease.
    let root = dirs::cache_dir()
        .context("worktree lease cache directory")?
        .join("ryu-worktree-leases");
    std::fs::create_dir_all(&root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(root.join(format!("{id}.lock")))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error.into()),
    }
}

/// Attempts made by [`worktree_lease_for_pruning`] before treating a lease as
/// held by a live owner.
const PRUNE_LEASE_ATTEMPTS: u32 = 25;
/// Pause between [`worktree_lease_for_pruning`] attempts.
const PRUNE_LEASE_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(20);

/// Acquire a worktree lease for pruning with a short bounded retry.
///
/// `flock` locks belong to the open file description, so a lease that was just
/// released can still read as held for a moment: a concurrently forked child
/// (any `git` this process spawns) keeps a duplicate of the descriptor until
/// it execs. Retrying briefly keeps such a transient duplicate from silently
/// skipping a completed worktree, while a lease held by a live owner (another
/// Core) still reports `None` once the attempts run out.
fn worktree_lease_for_pruning(id: &str) -> anyhow::Result<Option<File>> {
    for attempt in 0..PRUNE_LEASE_ATTEMPTS {
        if let Some(lease) = worktree_lease(id)? {
            return Ok(Some(lease));
        }
        if attempt + 1 < PRUNE_LEASE_ATTEMPTS {
            std::thread::sleep(PRUNE_LEASE_RETRY_DELAY);
        }
    }
    Ok(None)
}

#[derive(Debug, Clone)]
pub struct ManagedWorktreeOptions {
    pub root: Option<PathBuf>,
    pub fetch_upstream: bool,
    pub auto_delete: bool,
    pub auto_delete_limit: usize,
}

impl Default for ManagedWorktreeOptions {
    fn default() -> Self {
        Self {
            root: None,
            fetch_upstream: false,
            auto_delete: true,
            auto_delete_limit: 15,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    schema_version: u8,
    repo_root: PathBuf,
    branch: String,
    completed_at: Option<u128>,
    snapshot_ref: Option<String>,
}

pub(super) struct ManagedWorktree {
    root: PathBuf,
    id: String,
    options: ManagedWorktreeOptions,
    release_armed: bool,
    lease: Mutex<Option<File>>,
}

fn git(repo: &Path, args: &[&str]) -> anyhow::Result<String> {
    let output = git_command(args)
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .no_window()
        .output()?;
    if !output.status.success() {
        bail!(
            "git {} failed: {}",
            args[0],
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

fn write_record(path: &Path, record: &Record) -> anyhow::Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, serde_json::to_vec(record)?)?;
    // Replace the complete record atomically; never remove the previous record first.
    std::fs::rename(temporary, path)?;
    Ok(())
}

fn canonical_path(path: &Path) -> std::io::Result<PathBuf> {
    let canonical = std::fs::canonicalize(path)?;
    // Git for Windows rejects verbatim prefixes in worktree path arguments.
    #[cfg(windows)]
    {
        let value = canonical.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{unc}")));
        }
        if let Some(normal) = value.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(normal));
        }
    }
    Ok(canonical)
}

pub fn create_managed_worktree(
    repo: &Path,
    branch: Option<&str>,
    options: &ManagedWorktreeOptions,
) -> anyhow::Result<WorktreeGuard> {
    if options.auto_delete_limit == 0 || options.auto_delete_limit > 100 {
        bail!("worktree auto-delete limit must be between 1 and 100");
    }
    let repo = canonical_path(repo)?;
    // A fork from HEAD would leave the handed-off uncommitted changes behind.
    if crate::handoff::is_handoff_worktree(&repo) {
        bail!("this folder is a handed-off worktree; switch the run mode to Local to keep working in it");
    }
    let root = options
        .root
        .clone()
        .unwrap_or_else(|| repo.join(".ryu-worktrees"));
    if !root.is_absolute() {
        bail!("worktree root must be an absolute path");
    }
    if options.fetch_upstream {
        git(&repo, &["fetch", "--all", "--prune"])
            .context("fetch upstream before worktree creation")?;
    }
    std::fs::create_dir_all(&root)?;
    let root = canonical_path(&root)?;
    let _lock = MANAGEMENT_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("worktree management lock poisoned"))?;
    let mut guard = create_worktree_at(&repo, branch, &root)?;
    let id = guard
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .context("invalid worktree identifier")?
        .to_owned();
    let records = root.join(".ryu-managed");
    std::fs::create_dir_all(&records)?;
    let lease = worktree_lease(&id)?.context("worktree is already owned by another process")?;
    write_record(
        &records.join(format!("{id}.json")),
        &Record {
            schema_version: 1,
            repo_root: repo,
            branch: guard.branch.clone(),
            completed_at: None,
            snapshot_ref: None,
        },
    )?;
    guard.management = Some(ManagedWorktree {
        root,
        id,
        options: options.clone(),
        release_armed: true,
        lease: Mutex::new(Some(lease)),
    });
    Ok(guard)
}

impl ManagedWorktree {
    pub(super) fn suspend_pruning(&mut self) {
        self.release_armed = false;
    }

    pub(super) fn update_options(&mut self, options: &ManagedWorktreeOptions) {
        self.options = options.clone();
        self.release_armed = true;
    }

    pub(super) fn complete(&self, guard: &WorktreeGuard) -> anyhow::Result<()> {
        drop(
            self.lease
                .lock()
                .map_err(|_| anyhow::anyhow!("worktree lease lock poisoned"))?
                .take(),
        );
        if !self.release_armed {
            return Ok(());
        }
        let _lock = MANAGEMENT_LOCK
            .lock()
            .map_err(|_| anyhow::anyhow!("worktree management lock poisoned"))?;
        let records = self.root.join(".ryu-managed");
        let record_path = records.join(format!("{}.json", self.id));
        let mut record: Record = serde_json::from_slice(&std::fs::read(&record_path)?)?;
        record.completed_at = Some(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis());
        write_record(&record_path, &record)?;
        if !self.options.auto_delete {
            return Ok(());
        }
        let registered_worktrees =
            git(&guard.repo_root, &["worktree", "list", "--porcelain", "-z"])?
                .split('\0')
                .filter_map(|field| field.strip_prefix("worktree "))
                .filter_map(|path| canonical_path(Path::new(path)).ok())
                .collect::<Vec<_>>();
        let mut completed = Vec::new();
        for entry in std::fs::read_dir(&records)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let Ok(candidate) = serde_json::from_slice::<Record>(&bytes) else {
                continue;
            };
            if candidate.schema_version != 1
                || candidate.repo_root != guard.repo_root
                || candidate.snapshot_ref.is_some()
            {
                continue;
            }
            let Some(timestamp) = candidate.completed_at else {
                continue;
            };
            let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let Some(uuid) = id.strip_prefix("ryu-run-") else {
                continue;
            };
            if uuid::Uuid::parse_str(uuid).is_err() {
                continue;
            }
            let worktree = self.root.join(id);
            let Some(lease) = worktree_lease_for_pruning(id)? else {
                continue;
            };
            // Refuse symlinks/reparse points or paths redirected outside the managed root.
            if canonical_path(&worktree).ok().as_ref() != Some(&worktree) {
                continue;
            }
            // Removing a parent also removes ignored nested checkouts. Protect
            // every registered child before counting candidates or snapshotting.
            if registered_worktrees
                .iter()
                .any(|registered| registered != &worktree && registered.starts_with(&worktree))
            {
                continue;
            }
            let common = git(
                &worktree,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            )?;
            let expected = git(
                &guard.repo_root,
                &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            )?;
            if std::fs::canonicalize(common)? != std::fs::canonicalize(expected)? {
                continue;
            }
            drop(lease);
            completed.push((timestamp, path, worktree, candidate));
        }
        completed.sort_by_key(|entry| entry.0);
        let excess = completed
            .len()
            .saturating_sub(self.options.auto_delete_limit);
        for (_, record_path, worktree, mut candidate) in completed.into_iter().take(excess) {
            let id = worktree
                .file_name()
                .and_then(|name| name.to_str())
                .context("invalid worktree identifier")?;
            // Reclaim authority immediately before snapshot/removal and retain
            // it through removal without holding a handle for every candidate.
            let Some(_lease) = worktree_lease_for_pruning(id)? else {
                continue;
            };
            // Confirm Git still associates this exact worktree with the registered branch.
            if git(&worktree, &["symbolic-ref", "--short", "HEAD"])? != candidate.branch {
                continue;
            }
            let reference = snapshot(&worktree, &records, id)?;
            // Persist recovery before removal. If removal is interrupted or fails,
            // retain this record instead of replacing its snapshot on a later retry.
            candidate.snapshot_ref = Some(reference);
            write_record(&record_path, &candidate)?;
            let output = git_command(&["worktree", "remove", "--force"])
                .arg(&worktree)
                .current_dir(&guard.repo_root)
                .no_window()
                .output()?;
            if !output.status.success() {
                bail!(
                    "worktree removal failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            // The durable snapshot ref protects commits even if branch cleanup fails.
            git(&guard.repo_root, &["branch", "-D", &candidate.branch])?;
            tracing::info!(path = %worktree.display(), snapshot = ?candidate.snapshot_ref, "managed worktree pruned after snapshot");
        }
        Ok(())
    }
}

fn snapshot(worktree: &Path, records: &Path, id: &str) -> anyhow::Result<String> {
    let index = records.join(format!("{id}-{}.index", uuid::Uuid::new_v4()));
    let result = (|| {
        let run = |args: &[&str]| -> anyhow::Result<String> {
            let output = git_command(args)
                .env("GIT_INDEX_FILE", &index)
                .env("GIT_AUTHOR_NAME", "Ryu")
                .env("GIT_AUTHOR_EMAIL", "worktrees@ryu.local")
                .env("GIT_COMMITTER_NAME", "Ryu")
                .env("GIT_COMMITTER_EMAIL", "worktrees@ryu.local")
                .current_dir(worktree)
                .no_window()
                .output()?;
            if !output.status.success() {
                bail!(
                    "worktree snapshot failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            Ok(String::from_utf8(output.stdout)?.trim().to_owned())
        };
        let head = git(worktree, &["rev-parse", "HEAD"])?;
        let staged_tree = git(worktree, &["write-tree"])?;
        let staged_commit = run(&[
            "-c",
            "commit.gpgsign=false",
            "commit-tree",
            &staged_tree,
            "-p",
            &head,
            "-m",
            "Ryu managed worktree staged recovery snapshot",
        ])?;
        run(&["read-tree", "HEAD"])?;
        run(&["add", "-A", "--", "."])?;
        if run(&["ls-files", "--stage"])?
            .lines()
            .any(|entry| entry.starts_with("160000 "))
        {
            bail!("worktrees containing submodules or embedded Git repositories are retained because their contents cannot be fully snapshotted");
        }
        let tree = run(&["write-tree"])?;
        let commit = run(&[
            "-c",
            "commit.gpgsign=false",
            "commit-tree",
            &tree,
            "-p",
            &staged_commit,
            "-m",
            "Ryu managed worktree recovery snapshot",
        ])?;
        let reference = format!("refs/ryu/worktree-snapshots/{id}");
        git(worktree, &["update-ref", &reference, &commit])?;
        Ok(reference)
    })();
    let _ = std::fs::remove_file(index);
    result
}

#[cfg(test)]
#[path = "worktree_management_test.rs"]
mod tests;
