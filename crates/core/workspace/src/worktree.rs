use std::path::{Path, PathBuf};
use std::process::Command;

use crate::git_command::git_command;
use crate::win_process::NoWindow;

use uuid::Uuid;

#[path = "worktree_management.rs"]
mod management;
pub use management::{create_managed_worktree, ManagedWorktreeOptions};

mod apply;
mod diff;
pub use apply::{apply_worktree, ApplyMode, ApplySuccess, ConflictError};
pub use diff::{worktree_diff, FileChangeKind, FileSummary, WorktreeDiff};

/// A live isolated worktree. [`create_managed_worktree`] registers durable
/// retention metadata; dropping its guard runs environment cleanup and releases
/// the worktree for retention or recoverable pruning. Guards held for an active
/// conversation remain protected. The ephemeral [`create_worktree`] and
/// [`create_worktree_in`] helpers remove their worktree and branch on drop.
pub struct WorktreeGuard {
    /// Absolute path to the worktree directory.
    pub path: PathBuf,
    /// `ryu/run-<id>` branch created with the worktree.
    pub branch: String,
    /// Root of the repository (where `git worktree remove` must be run from).
    repo_root: PathBuf,
    /// The commit SHA from which this worktree was forked (the base for diff).
    pub base_hash: String,
    /// Environment variables inherited by setup/cleanup and the ACP child.
    pub environment: Vec<(String, String)>,
    cleanup_script: Option<String>,
    management: Option<management::ManagedWorktree>,
}

impl Drop for WorktreeGuard {
    fn drop(&mut self) {
        if let Some(script) = self.cleanup_script.as_deref() {
            if let Err(error) =
                run_environment_script(script, &self.path, &self.repo_root, &self.environment)
            {
                tracing::warn!(error = %error, path = %self.path.display(), "worktree cleanup script failed");
            }
        }
        if let Some(managed) = &self.management {
            if let Err(error) = managed.complete(self) {
                tracing::warn!(error = %error, path = %self.path.display(), "managed worktree retained after cleanup failure");
            }
        } else {
            remove_worktree_sync(&self.repo_root, &self.path, &self.branch);
        }
    }
}

/// Create a git worktree for one agent run with an auto-generated branch name
/// (`ryu/run-<id>`). Thin wrapper over [`create_worktree_in`].
pub fn create_worktree(repo_path: &Path) -> anyhow::Result<WorktreeGuard> {
    create_worktree_in(repo_path, None)
}

/// Sanitize a user-supplied branch name into a git-legal ref segment.
///
/// Replaces whitespace with `-`, drops characters git forbids in refs, collapses
/// `..` sequences, and trims leading/trailing separators. Returns `None` when
/// nothing usable remains (caller falls back to the auto-generated name).
pub(crate) fn sanitize_branch_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_whitespace() {
            out.push('-');
        } else if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '/' | '.') {
            out.push(ch);
        }
        // Everything else (~^:?*[\ etc.) is dropped.
    }
    // Git forbids `..` in a ref; collapse any that survived.
    while out.contains("..") {
        out = out.replace("..", ".");
    }
    let cleaned = out
        .trim_matches(|c| c == '/' || c == '.' || c == '-')
        .to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Whether a local branch already exists in `repo_path`.
pub(crate) fn branch_exists(repo_path: &Path, branch: &str) -> bool {
    git_command(&["show-ref", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch}"))
        .current_dir(repo_path)
        .no_window()
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Create a git worktree for one agent run.
///
/// Shells `git worktree add <dir> -b <branch>` from `repo_path`. The new
/// worktree lives under `<repo_root>/.ryu-worktrees/ryu-run-<id>` (inside the
/// repo, below `.gitignore`). When `branch_name` is `Some`, it is sanitized and
/// used as the branch (with a short uuid suffix appended on collision); when
/// `None` (or unusable), the branch is auto-named `ryu/run-<id>`. Returns a
/// [`WorktreeGuard`] whose `Drop` cleans up the worktree directory and its
/// branch automatically.
pub fn create_worktree_in(
    repo_path: &Path,
    branch_name: Option<&str>,
) -> anyhow::Result<WorktreeGuard> {
    create_worktree_at(repo_path, branch_name, &repo_path.join(".ryu-worktrees"))
}

fn create_worktree_at(
    repo_path: &Path,
    branch_name: Option<&str>,
    worktree_base: &Path,
) -> anyhow::Result<WorktreeGuard> {
    let run_id = Uuid::new_v4().to_string();
    let branch = match branch_name.and_then(sanitize_branch_name) {
        Some(name) if branch_exists(repo_path, &name) => {
            format!("{name}-{}", &run_id[..8])
        }
        Some(name) => name,
        None => format!("ryu/run-{run_id}"),
    };

    // Capture the current HEAD SHA so we have a stable base for diff later.
    let base_hash = git_command(&["rev-parse", "HEAD"])
        .current_dir(repo_path)
        .no_window()
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    // Place worktrees under a Core-owned sub-directory of the repo.
    std::fs::create_dir_all(worktree_base)?;
    let worktree_path = worktree_base.join(format!("ryu-run-{run_id}"));

    let output = git_command(&["worktree", "add", "-b", &branch])
        .arg(&worktree_path)
        .arg("HEAD")
        .current_dir(repo_path)
        .no_window()
        .output()
        .map_err(|e| anyhow::anyhow!("git worktree add: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow::anyhow!("git worktree add failed: {stderr}"));
    }

    tracing::info!(
        branch = %branch,
        path = %worktree_path.display(),
        "worktree created"
    );

    Ok(WorktreeGuard {
        path: worktree_path,
        branch,
        repo_root: repo_path.to_owned(),
        base_hash,
        environment: Vec::new(),
        cleanup_script: None,
        management: None,
    })
}

impl WorktreeGuard {
    /// Active hosts defer completion until they can resolve the latest cleanup policy.
    pub fn suspend_managed_pruning(&mut self) {
        if let Some(managed) = &mut self.management {
            managed.suspend_pruning();
        }
    }

    /// Resolve retention policy and arm completion for a known release.
    pub fn update_managed_options(&mut self, options: &ManagedWorktreeOptions) {
        if let Some(managed) = &mut self.management {
            managed.update_options(options);
        }
    }

    /// Configure and bootstrap this worktree. The cleanup hook is armed before
    /// setup runs, so a partially completed setup still gets its matching cleanup.
    pub fn configure_environment(
        &mut self,
        setup_script: Option<&str>,
        cleanup_script: Option<&str>,
        environment: Vec<(String, String)>,
    ) -> anyhow::Result<()> {
        self.environment = environment;
        self.cleanup_script = cleanup_script
            .map(str::trim)
            .filter(|script| !script.is_empty())
            .map(str::to_owned);
        if let Some(script) = setup_script
            .map(str::trim)
            .filter(|script| !script.is_empty())
        {
            run_environment_script(script, &self.path, &self.repo_root, &self.environment)?;
        }
        Ok(())
    }
}

/// Remove a worktree directory and its branch; called from `Drop`.
///
/// Uses synchronous `std::process::Command` so it is usable inside `Drop`.
/// Logs warnings on failure — errors here are non-fatal since the git
/// repository is still valid; the caller can run `git worktree prune` manually.
fn remove_worktree_sync(repo_root: &Path, worktree_path: &Path, branch: &str) {
    let rm = git_command(&["worktree", "remove", "--force"])
        .arg(worktree_path)
        .current_dir(repo_root)
        .no_window()
        .output();

    match rm {
        Ok(out) if out.status.success() => {
            tracing::info!(path = %worktree_path.display(), "worktree removed");
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            tracing::warn!("git worktree remove failed: {stderr}");
        }
        Err(e) => tracing::warn!("git worktree remove exec error: {e}"),
    }

    let prune = git_command(&["worktree", "prune"])
        .current_dir(repo_root)
        .no_window()
        .output();
    if let Err(e) = prune {
        tracing::warn!("git worktree prune exec error: {e}");
    }

    let del_branch = git_command(&["branch", "-D", branch])
        .current_dir(repo_root)
        .no_window()
        .output();

    match del_branch {
        Ok(out) if out.status.success() => {
            tracing::info!(branch = %branch, "run branch deleted");
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            tracing::warn!("git branch -D failed: {stderr}");
        }
        Err(e) => tracing::warn!("git branch -D exec error: {e}"),
    }
}

fn run_environment_script(
    script: &str,
    worktree_path: &Path,
    repo_root: &Path,
    environment: &[(String, String)],
) -> anyhow::Result<()> {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("powershell");
        command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        command
    };
    #[cfg(not(target_os = "windows"))]
    let mut command = {
        let mut command = Command::new("sh");
        command.args(["-lc", script]);
        command
    };

    command
        .current_dir(worktree_path)
        .env("RYU_PROJECT_PATH", repo_root)
        .env("RYU_WORKTREE_PATH", worktree_path)
        .envs(environment.iter().cloned())
        .no_window();
    let output = command
        .output()
        .map_err(|error| anyhow::anyhow!("environment script spawn failed: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    Err(anyhow::anyhow!(
        "environment script exited with {}{}",
        output.status,
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    ))
}

/// Detect whether `path` is inside a git repository. Used to gate worktree
/// isolation — non-repo directories fall back to the plain cwd path.
pub fn is_git_repo(path: &Path) -> bool {
    git_command(&["-C"])
        .arg(path)
        .args(["rev-parse", "--is-inside-work-tree"])
        .no_window()
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Find the root of the git repository containing `path`.
pub fn find_git_root(path: &Path) -> Option<PathBuf> {
    let output = git_command(&["-C"])
        .arg(path)
        .args(["rev-parse", "--show-toplevel"])
        .no_window()
        .output()
        .ok()?;
    if output.status.success() {
        let root = String::from_utf8(output.stdout).ok()?;
        Some(PathBuf::from(root.trim()))
    } else {
        None
    }
}

// ── Diff ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests;
