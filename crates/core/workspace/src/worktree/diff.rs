//! The aggregate diff of a run worktree against its base.

use super::*;

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
    let _ = git_command(&["add", "-A"])
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
    let out = git_command(args)
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
