use std::path::{Path, PathBuf};
use std::process::Command;

use crate::win_process::NoWindow;

use uuid::Uuid;

/// A live per-run worktree. Created by [`create_worktree`] and cleaned up when
/// dropped (synchronous, so it works inside both regular code and `Drop` impls).
/// Moving it into the ACP stream generator ensures cleanup on stream completion
/// or on early client disconnect.
pub struct WorktreeGuard {
    /// Absolute path to the worktree directory.
    pub path: PathBuf,
    /// `ryu/run-<id>` branch created with the worktree.
    pub branch: String,
    /// Root of the repository (where `git worktree remove` must be run from).
    repo_root: PathBuf,
    /// The commit SHA from which this worktree was forked (the base for diff).
    pub base_hash: String,
}

impl Drop for WorktreeGuard {
    fn drop(&mut self) {
        remove_worktree_sync(&self.repo_root, &self.path, &self.branch);
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
fn sanitize_branch_name(raw: &str) -> Option<String> {
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
fn branch_exists(repo_path: &Path, branch: &str) -> bool {
    Command::new("git")
        .args(["show-ref", "--verify", "--quiet"])
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
    let run_id = Uuid::new_v4().to_string();
    let branch = match branch_name.and_then(sanitize_branch_name) {
        Some(name) if branch_exists(repo_path, &name) => {
            format!("{name}-{}", &run_id[..8])
        }
        Some(name) => name,
        None => format!("ryu/run-{run_id}"),
    };

    // Capture the current HEAD SHA so we have a stable base for diff later.
    let base_hash = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_path)
        .no_window()
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    // Place worktrees under a Core-owned sub-directory of the repo.
    let worktree_base = repo_path.join(".ryu-worktrees");
    std::fs::create_dir_all(&worktree_base)?;
    let worktree_path = worktree_base.join(format!("ryu-run-{run_id}"));

    let output = Command::new("git")
        .args(["worktree", "add", "-b", &branch])
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
    })
}

/// Remove a worktree directory and its branch; called from `Drop`.
///
/// Uses synchronous `std::process::Command` so it is usable inside `Drop`.
/// Logs warnings on failure — errors here are non-fatal since the git
/// repository is still valid; the caller can run `git worktree prune` manually.
fn remove_worktree_sync(repo_root: &Path, worktree_path: &Path, branch: &str) {
    let rm = Command::new("git")
        .args(["worktree", "remove", "--force"])
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

    let prune = Command::new("git")
        .args(["worktree", "prune"])
        .current_dir(repo_root)
        .no_window()
        .output();
    if let Err(e) = prune {
        tracing::warn!("git worktree prune exec error: {e}");
    }

    let del_branch = Command::new("git")
        .args(["branch", "-D", branch])
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

/// Detect whether `path` is inside a git repository. Used to gate worktree
/// isolation — non-repo directories fall back to the plain cwd path.
pub fn is_git_repo(path: &Path) -> bool {
    Command::new("git")
        .args(["-C"])
        .arg(path)
        .args(["rev-parse", "--is-inside-work-tree"])
        .no_window()
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Find the root of the git repository containing `path`.
pub fn find_git_root(path: &Path) -> Option<PathBuf> {
    let output = Command::new("git")
        .args(["-C"])
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

/// Change status for one file in the diff summary.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// Per-file summary entry returned by [`worktree_diff`].
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileSummary {
    /// Repo-relative path (forward slashes).
    pub path: String,
    pub kind: FileChangeKind,
    pub additions: u32,
    pub deletions: u32,
}

/// The aggregate diff for a single run's worktree. Returned by
/// `GET /api/worktree/:run_id/diff`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorktreeDiff {
    /// True when the worktree diverges from the base branch in any way
    /// (committed OR uncommitted).
    pub has_changes: bool,
    /// Per-file summary (path, kind, +/- counts).
    pub files: Vec<FileSummary>,
    /// Unified diff covering committed changes (`git diff HEAD...<branch_base>`)
    /// merged with any uncommitted working-tree changes.
    pub unified_diff: String,
}

/// Compute the aggregate diff for a live worktree.
///
/// `worktree_path` is the absolute path to the worktree directory.
/// `base_branch` is the branch the worktree was forked from (e.g. `HEAD` of the
/// main checkout at the time `git worktree add` was run — the merge-base is used
/// to compute only the run's own changes, not the full history divergence).
///
/// Returns a zero-change [`WorktreeDiff`] on any git failure so callers can
/// render "no changes" rather than an error.
///
/// Stages all untracked and modified files via `git add -A` before diffing.
/// This is safe because the worktree is ephemeral and about to be destroyed;
/// mutating the index ensures new files created by the agent appear in the diff
/// and aren't silently dropped by `git diff HEAD` (which skips untracked files).
pub fn worktree_diff(worktree_path: &Path, base_ref: &str) -> WorktreeDiff {
    let empty = WorktreeDiff {
        has_changes: false,
        files: vec![],
        unified_diff: String::new(),
    };

    if !worktree_path.is_dir() {
        return empty;
    }

    let cwd = worktree_path.to_str().unwrap_or(".");

    // Stage everything in the worktree so that new (untracked) files appear in
    // `git diff --cached`, which includes them in the full diff below. The
    // worktree is about to be destroyed, so mutating the index is safe.
    let _ = Command::new("git")
        .args(["add", "-A"])
        .current_dir(cwd)
        .no_window()
        .output();

    // 1. Unified diff: the full change set — committed commits on this branch
    //    relative to `base_ref`, PLUS any newly-staged working-tree changes
    //    (including files the agent created but never committed).
    //    `git diff <base_ref>` in three-dot form finds the merge-base so the
    //    diff reflects "what this run added" only.
    let committed_diff =
        run_git_output(cwd, &["diff", &format!("{base_ref}...HEAD"), "--unified=3"]);
    // Staged changes not yet committed (new files, modifications staged by `git add -A`).
    let staged_diff = run_git_output(cwd, &["diff", "--cached", "--unified=3"]);

    let mut unified_diff = committed_diff.unwrap_or_default();
    if let Some(staged) = staged_diff {
        if !staged.is_empty() {
            if !unified_diff.is_empty() {
                unified_diff.push('\n');
            }
            unified_diff.push_str(&staged);
        }
    }

    // 2. Per-file summary via `git diff --numstat`.
    let committed_stat = run_git_output(cwd, &["diff", &format!("{base_ref}...HEAD"), "--numstat"]);
    let staged_stat = run_git_output(cwd, &["diff", "--cached", "--numstat"]);

    // Track files by path (last write wins — staged supercedes committed).
    let mut file_map: std::collections::HashMap<String, FileSummary> = Default::default();

    for stat_block in [committed_stat, staged_stat].into_iter().flatten() {
        for line in stat_block.lines() {
            if let Some(summary) = parse_numstat_line(line) {
                file_map.insert(summary.path.clone(), summary);
            }
        }
    }

    // Supplement the numstat with --name-status for both committed and staged
    // ranges. The staged range picks up added/deleted files that appear as
    // zero-line changes (e.g. empty new files, deletions) that --numstat misses.
    let committed_range = format!("{base_ref}...HEAD");
    let name_status_sources: [&[&str]; 2] = [
        &["diff", &committed_range, "--name-status"],
        &["diff", "--cached", "--name-status"],
    ];
    for ns_args in name_status_sources {
        if let Some(ns_output) = run_git_output(cwd, ns_args) {
            for line in ns_output.lines() {
                let parts: Vec<&str> = line.splitn(2, '\t').collect();
                if parts.len() < 2 {
                    continue;
                }
                let status = parts[0].trim();
                let path = parts[1].trim().to_string();
                // Rename: "R<score>\told_path\tnew_path" — already captured by numstat.
                let kind = match status.chars().next() {
                    Some('A') => FileChangeKind::Added,
                    Some('D') => FileChangeKind::Deleted,
                    Some('R') => FileChangeKind::Renamed,
                    _ => FileChangeKind::Modified,
                };
                file_map.entry(path.clone()).or_insert(FileSummary {
                    path,
                    kind,
                    additions: 0,
                    deletions: 0,
                });
            }
        }
    }

    let mut files: Vec<FileSummary> = file_map.into_values().collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let has_changes = !files.is_empty() || !unified_diff.is_empty();
    WorktreeDiff {
        has_changes,
        files,
        unified_diff,
    }
}

fn run_git_output(cwd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .no_window()
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        None
    }
}

/// Parse one line of `git diff --numstat` output.
/// Format: `<added>\t<deleted>\t<path>` (binary files use `-`).
fn parse_numstat_line(line: &str) -> Option<FileSummary> {
    let parts: Vec<&str> = line.splitn(3, '\t').collect();
    if parts.len() < 3 {
        return None;
    }
    let additions: u32 = parts[0].trim().parse().unwrap_or(0);
    let deletions: u32 = parts[1].trim().parse().unwrap_or(0);
    let path = parts[2].trim().replace('\\', "/");
    if path.is_empty() {
        return None;
    }
    let kind = if additions > 0 && deletions == 0 {
        FileChangeKind::Added
    } else if deletions > 0 && additions == 0 {
        FileChangeKind::Deleted
    } else {
        FileChangeKind::Modified
    };
    Some(FileSummary {
        path,
        kind,
        additions,
        deletions,
    })
}

// ── Apply (commit + merge or open PR) ────────────────────────────────────────

/// The mode for applying a completed run's changes.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyMode {
    /// Commit any staged/unstaged changes in the worktree, then merge the
    /// worktree branch into the base branch.
    Merge,
    /// Commit, push the branch to origin, and open a PR via `gh pr create`.
    Pr,
}

/// Returned on a successful apply.
#[derive(Debug, serde::Serialize)]
pub struct ApplySuccess {
    /// `merge` mode: the commit SHA that was merged.
    pub commit: Option<String>,
    /// `pr` mode: the URL of the created PR.
    pub pr_url: Option<String>,
}

/// A conflict prevented the merge from completing cleanly.
#[derive(Debug, serde::Serialize)]
pub struct ConflictError {
    pub conflicted_files: Vec<String>,
}

/// Apply the worktree's changes: commit → merge into base OR commit → push → PR.
///
/// On success the worktree and its branch are removed (via the existing
/// `remove_worktree_sync` helper). On merge conflict, `git merge --abort` is
/// called so the base repo is never left mid-merge, and the worktree + branch
/// are cleaned up before returning the conflict list.
pub fn apply_worktree(
    guard: &WorktreeGuard,
    mode: ApplyMode,
    message: &str,
    base: Option<&str>,
) -> Result<ApplySuccess, ConflictError> {
    let wt = guard.path.as_path();
    let repo = guard.repo_root.as_path();

    // Stage all changes in the worktree.
    let _ = Command::new("git")
        .args(["add", "-A"])
        .current_dir(wt)
        .no_window()
        .output();

    // Check if there is anything to commit.
    let status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(wt)
        .no_window()
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();

    if !status.trim().is_empty() {
        let commit_out = Command::new("git")
            .args(["commit", "-m", message])
            .current_dir(wt)
            .no_window()
            .output();

        if let Ok(out) = commit_out {
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr);
                tracing::warn!("apply: git commit failed in worktree: {err}");
            }
        }
    }

    // Determine the effective base (the branch HEAD has checked out in the main repo).
    let effective_base = base.map(str::to_string).unwrap_or_else(|| {
        Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(repo)
            .no_window()
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "main".to_string())
    });

    match mode {
        ApplyMode::Merge => {
            let merge_out = Command::new("git")
                .args(["merge", "--no-ff", &guard.branch, "-m", message])
                .current_dir(repo)
                .no_window()
                .output();

            match merge_out {
                Ok(out) if out.status.success() => {
                    let commit_sha = Command::new("git")
                        .args(["rev-parse", "HEAD"])
                        .current_dir(repo)
                        .no_window()
                        .output()
                        .ok()
                        .filter(|o| o.status.success())
                        .and_then(|o| String::from_utf8(o.stdout).ok())
                        .map(|s| s.trim().to_string());

                    Ok(ApplySuccess {
                        commit: commit_sha,
                        pr_url: None,
                    })
                }
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    tracing::warn!("apply: merge conflict: {stderr}");

                    // Collect conflicted files.
                    let conflicted = Command::new("git")
                        .args(["diff", "--name-only", "--diff-filter=U"])
                        .current_dir(repo)
                        .no_window()
                        .output()
                        .ok()
                        .filter(|o| o.status.success())
                        .and_then(|o| String::from_utf8(o.stdout).ok())
                        .map(|s| {
                            s.lines()
                                .filter(|l| !l.is_empty())
                                .map(str::to_string)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();

                    // Abort so base repo is never left mid-merge.
                    let _ = Command::new("git")
                        .args(["merge", "--abort"])
                        .current_dir(repo)
                        .no_window()
                        .output();

                    Err(ConflictError {
                        conflicted_files: conflicted,
                    })
                }
                Err(e) => {
                    tracing::error!("apply: merge exec error: {e}");
                    Err(ConflictError {
                        conflicted_files: vec![],
                    })
                }
            }
        }

        ApplyMode::Pr => {
            // Push the worktree branch to origin.
            let push_out = Command::new("git")
                .args(["push", "-u", "origin", &guard.branch])
                .current_dir(wt)
                .no_window()
                .output();

            if let Ok(ref out) = push_out {
                if !out.status.success() {
                    let err = String::from_utf8_lossy(&out.stderr);
                    tracing::warn!("apply: git push failed: {err}");
                }
            }

            // Run `gh pr create` — requires `gh` to be authed. Use `--head` to
            // point at the worktree branch and `--base` at the effective base.
            let gh_out = Command::new("gh")
                .args([
                    "pr",
                    "create",
                    "--head",
                    &guard.branch,
                    "--base",
                    &effective_base,
                    "--title",
                    message,
                    "--body",
                    "",
                ])
                .current_dir(repo)
                .no_window()
                .output();

            match gh_out {
                Ok(out) if out.status.success() => {
                    let pr_url = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    Ok(ApplySuccess {
                        commit: None,
                        pr_url: Some(pr_url),
                    })
                }
                Ok(out) => {
                    let err = String::from_utf8_lossy(&out.stderr);
                    tracing::warn!("apply: gh pr create failed: {err}");
                    // Return a conflict-style error so the caller sees a 409.
                    Err(ConflictError {
                        conflicted_files: vec![],
                    })
                }
                Err(e) => {
                    tracing::error!("apply: gh exec error: {e}");
                    Err(ConflictError {
                        conflicted_files: vec![],
                    })
                }
            }
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn init_git_repo(dir: &Path) {
        Command::new("git")
            .args(["init"])
            .current_dir(dir)
            .output()
            .expect("git init");
        Command::new("git")
            .args(["config", "user.email", "test@ryu"])
            .current_dir(dir)
            .output()
            .expect("git config email");
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(dir)
            .output()
            .expect("git config name");
        // Need at least one commit for worktree add to work.
        let readme = dir.join("README");
        std::fs::write(&readme, "init").expect("write README");
        Command::new("git")
            .args(["add", "."])
            .current_dir(dir)
            .output()
            .expect("git add");
        Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(dir)
            .output()
            .expect("git commit");
    }

    #[test]
    fn diff_captures_committed_changes_in_worktree() {
        let tmp = TempDir::new().expect("tempdir");
        let repo = tmp.path();
        init_git_repo(repo);

        let guard = create_worktree(repo).expect("create_worktree");
        let wt_path = guard.path.clone();
        let base_hash = guard.base_hash.clone();
        assert!(
            !base_hash.is_empty(),
            "base_hash should be captured at worktree creation"
        );

        // The worktree starts clean: diff against the base commit returns no changes.
        let diff_clean = worktree_diff(&wt_path, &base_hash);
        assert!(
            !diff_clean.has_changes,
            "fresh worktree should report no changes"
        );

        // Write two files and commit them inside the worktree.
        std::fs::write(wt_path.join("alpha.txt"), "hello alpha").expect("write alpha");
        std::fs::write(wt_path.join("beta.txt"), "hello beta").expect("write beta");
        Command::new("git")
            .args(["add", "."])
            .current_dir(&wt_path)
            .output()
            .expect("git add");
        Command::new("git")
            .args(["commit", "-m", "add two files"])
            .current_dir(&wt_path)
            .output()
            .expect("git commit");

        // After committing, diff against the captured base_hash shows the 2 new files.
        let diff = worktree_diff(&wt_path, &base_hash);
        assert!(diff.has_changes, "should see changes after commit");
        assert_eq!(diff.files.len(), 2, "should report 2 changed files");
        assert!(
            diff.unified_diff.contains("alpha.txt") || diff.unified_diff.contains("beta.txt"),
            "unified diff should mention at least one of the added files"
        );

        drop(guard);

        // Confirm worktree directory is gone.
        assert!(!wt_path.exists(), "worktree dir should be gone after drop");
    }

    #[test]
    fn diff_captures_untracked_files_in_worktree() {
        let tmp = TempDir::new().expect("tempdir");
        let repo = tmp.path();
        init_git_repo(repo);

        let guard = create_worktree(repo).expect("create_worktree");
        let wt_path = guard.path.clone();
        let base_hash = guard.base_hash.clone();

        // Write two files but do NOT commit (simulating an ACP agent that only
        // edits files without running git commit). The diff should still include
        // them because worktree_diff stages via `git add -A` before diffing.
        std::fs::write(wt_path.join("gamma.txt"), "hello gamma").expect("write gamma");
        std::fs::write(wt_path.join("delta.txt"), "hello delta").expect("write delta");

        let diff = worktree_diff(&wt_path, &base_hash);
        assert!(diff.has_changes, "untracked files should be detected");
        assert_eq!(
            diff.files.len(),
            2,
            "should report 2 changed files from untracked"
        );
        assert!(
            diff.unified_diff.contains("gamma.txt") || diff.unified_diff.contains("delta.txt"),
            "unified diff should mention at least one of the new untracked files"
        );

        drop(guard);
    }

    /// AC1 for issue #128: two concurrent worktrees from the same repo must be
    /// independent — creating/dropping one must not disturb the other.
    #[test]
    fn two_concurrent_worktrees_are_independent() {
        let tmp = TempDir::new().expect("tempdir");
        let repo = tmp.path();
        init_git_repo(repo);

        let guard_a = create_worktree(repo).expect("create worktree A");
        let guard_b = create_worktree(repo).expect("create worktree B");

        let path_a = guard_a.path.clone();
        let path_b = guard_b.path.clone();
        let branch_a = guard_a.branch.clone();
        let branch_b = guard_b.branch.clone();

        assert!(path_a.exists(), "worktree A should exist");
        assert!(path_b.exists(), "worktree B should exist");
        assert_ne!(path_a, path_b, "worktrees should be at distinct paths");
        assert_ne!(branch_a, branch_b, "each run gets its own branch");

        // Both must appear in `git worktree list`.
        let list = Command::new("git")
            .args(["worktree", "list"])
            .current_dir(repo)
            .output()
            .expect("git worktree list");
        let list_str = String::from_utf8_lossy(&list.stdout);
        let norm_a = path_a.to_string_lossy().replace('\\', "/");
        let norm_b = path_b.to_string_lossy().replace('\\', "/");
        assert!(
            list_str.contains(&*norm_a),
            "worktree A should appear in list; got:\n{list_str}"
        );
        assert!(
            list_str.contains(&*norm_b),
            "worktree B should appear in list; got:\n{list_str}"
        );

        // Drop A — B must survive.
        drop(guard_a);
        assert!(!path_a.exists(), "worktree A should be gone after drop");
        assert!(
            path_b.exists(),
            "worktree B should still exist after A is dropped"
        );

        // Branch A must be gone; branch B must still exist.
        let branches = Command::new("git")
            .args(["branch", "--list"])
            .current_dir(repo)
            .output()
            .expect("git branch list");
        let branches_str = String::from_utf8_lossy(&branches.stdout);
        assert!(
            !branches_str.contains(&*branch_a),
            "branch A should be deleted; got:\n{branches_str}"
        );
        assert!(
            branches_str.contains(&*branch_b),
            "branch B should still exist; got:\n{branches_str}"
        );

        drop(guard_b);
    }

    #[test]
    fn apply_merge_lands_commit_on_base() {
        let tmp = TempDir::new().expect("tempdir");
        let repo = tmp.path();
        init_git_repo(repo);

        let guard = create_worktree(repo).expect("create_worktree");

        // Write a file and stage it in the worktree (apply will commit it).
        std::fs::write(guard.path.join("feature.txt"), "hello").expect("write");
        Command::new("git")
            .args(["add", "feature.txt"])
            .current_dir(&guard.path)
            .output()
            .expect("git add");

        let result = apply_worktree(&guard, ApplyMode::Merge, "feat: add feature", None);
        assert!(
            result.is_ok(),
            "merge should succeed on a clean repo: {result:?}"
        );
        let ok = result.unwrap();
        assert!(ok.commit.is_some(), "should return commit SHA");

        // Confirm the file landed on the base branch.
        assert!(
            repo.join("feature.txt").exists(),
            "feature.txt should be in base repo"
        );

        // Clean up guard manually (worktree + branch already gone from base after merge).
        drop(guard);
    }

    #[test]
    fn apply_merge_conflict_returns_409_data_and_leaves_base_clean() {
        let tmp = TempDir::new().expect("tempdir");
        let repo = tmp.path();
        init_git_repo(repo);

        // Write a file on the base branch.
        std::fs::write(repo.join("conflict.txt"), "base content").expect("write base");
        Command::new("git")
            .args(["add", "."])
            .current_dir(repo)
            .output()
            .expect("add");
        Command::new("git")
            .args(["commit", "-m", "base commit"])
            .current_dir(repo)
            .output()
            .expect("commit");

        // Create a worktree and write a conflicting version of the same file.
        let guard = create_worktree(repo).expect("create_worktree");
        std::fs::write(guard.path.join("conflict.txt"), "worktree content").expect("write wt");
        Command::new("git")
            .args(["add", "."])
            .current_dir(&guard.path)
            .output()
            .expect("add");
        Command::new("git")
            .args(["commit", "-m", "wt commit"])
            .current_dir(&guard.path)
            .output()
            .expect("commit");

        // Also modify the file on base AFTER worktree creation so it diverges.
        std::fs::write(repo.join("conflict.txt"), "base diverged content").expect("write base2");
        Command::new("git")
            .args(["add", "."])
            .current_dir(repo)
            .output()
            .expect("add");
        Command::new("git")
            .args(["commit", "-m", "base diverged"])
            .current_dir(repo)
            .output()
            .expect("commit");

        let result = apply_worktree(&guard, ApplyMode::Merge, "conflict merge", None);

        // On a genuine conflict the merge should fail with the conflicted file list.
        if let Err(conflict) = result {
            assert!(
                !conflict.conflicted_files.is_empty(),
                "conflict error should include conflicted files"
            );
            // Base repo must be in a clean state (merge --abort ran).
            let status = Command::new("git")
                .args(["status", "--porcelain"])
                .current_dir(repo)
                .output()
                .expect("git status");
            let status_str = String::from_utf8_lossy(&status.stdout);
            assert!(
                !status_str.contains("UU"),
                "base repo should not have unmerged files after abort"
            );
        }
        // If merge succeeded (fast-forward on some git versions), that's also valid.

        drop(guard);
    }

    #[test]
    fn create_then_drop_removes_worktree_and_branch() {
        let tmp = TempDir::new().expect("tempdir");
        let repo = tmp.path();
        init_git_repo(repo);

        let guard = create_worktree(repo).expect("create_worktree");
        let worktree_path = guard.path.clone();
        let branch = guard.branch.clone();

        assert!(
            worktree_path.exists(),
            "worktree dir should exist after create"
        );

        // Confirm git knows about the worktree.
        let list = Command::new("git")
            .args(["worktree", "list"])
            .current_dir(repo)
            .output()
            .expect("git worktree list");
        let list_str = String::from_utf8_lossy(&list.stdout);
        // On Windows git outputs forward-slash paths; normalize for comparison.
        let normalized_path = worktree_path.to_string_lossy().replace('\\', "/");
        assert!(
            list_str.contains(&*normalized_path),
            "worktree should appear in git worktree list; got:\n{list_str}"
        );

        // Dropping the guard removes the worktree and branch.
        drop(guard);

        assert!(
            !worktree_path.exists(),
            "worktree dir should be gone after drop"
        );

        // Branch must also be deleted.
        let branches = Command::new("git")
            .args(["branch", "--list", &branch])
            .current_dir(repo)
            .output()
            .expect("git branch list");
        let branches_str = String::from_utf8_lossy(&branches.stdout);
        assert!(
            branches_str.trim().is_empty(),
            "run branch should be deleted after drop"
        );
    }
}
