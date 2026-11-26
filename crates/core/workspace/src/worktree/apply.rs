//! Applying a finished run: commit, then merge into the base or open a pull request.

use super::*;
use crate::git::credited_commit_args;

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
///
/// When `credit` is set, the commit of the run's changes carries
/// [`crate::git::RYU_COAUTHOR_TRAILER`].
pub fn apply_worktree(
    guard: &WorktreeGuard,
    mode: ApplyMode,
    message: &str,
    base: Option<&str>,
    credit: bool,
) -> Result<ApplySuccess, ConflictError> {
    let wt = guard.path.as_path();
    let repo = guard.repo_root.as_path();

    // Stage all changes in the worktree.
    let _ = git_command(&["add", "-A"])
        .current_dir(wt)
        .no_window()
        .output();

    // Check if there is anything to commit.
    let status = git_command(&["status", "--porcelain"])
        .current_dir(wt)
        .no_window()
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();

    if !status.trim().is_empty() {
        let commit_out = git_command(&credited_commit_args(&["commit", "-m", message], credit))
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
        git_command(&["rev-parse", "--abbrev-ref", "HEAD"])
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
            let merge_out = git_command(&["merge", "--no-ff", &guard.branch, "-m", message])
                .current_dir(repo)
                .no_window()
                .output();

            match merge_out {
                Ok(out) if out.status.success() => {
                    let commit_sha = git_command(&["rev-parse", "HEAD"])
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
                    let conflicted = git_command(&["diff", "--name-only", "--diff-filter=U"])
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
                    let _ = git_command(&["merge", "--abort"])
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
            let push_out = git_command(&["push", "-u", "origin", &guard.branch])
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
