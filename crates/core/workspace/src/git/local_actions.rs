//! Repository state, memory traces, and local init/branch/commit actions.

use super::*;

pub(super) fn current_branch(cwd: &str) -> Option<String> {
    // `rev-parse --abbrev-ref HEAD` returns the literal `HEAD` for a freshly
    // initialized repository with no commits. The symbolic ref is authoritative
    // in that state and keeps the Environment row on the branch Git initialized.
    run_git(cwd, &["symbolic-ref", "--short", "HEAD"])
        .or_else(|| run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]))
}

pub(super) fn command_failure(operation: &str, output: &Output) -> String {
    let details = String::from_utf8_lossy(&output.stderr)
        .trim()
        .chars()
        .take(400)
        .collect::<String>();
    if details.is_empty() {
        format!("git {operation} failed")
    } else {
        format!("git {operation} failed: {details}")
    }
}

/// Compute the working-tree state for `cwd` (branch, ahead/behind, dirty, diff
/// totals). Returns `is_repo:false` when `cwd` is not a git repository.
pub fn query_git_state(cwd: &str) -> GitState {
    // Confirm this is actually a git repo.
    let branch = current_branch(cwd);
    let is_repo = branch.is_some();

    if !is_repo {
        return GitState {
            is_repo: false,
            branch: None,
            ahead: 0,
            behind: 0,
            dirty: false,
            changed_files_count: 0,
            insertions: 0,
            deletions: 0,
        };
    }

    // Dirty state from porcelain output — one line per changed file.
    // `--untracked-files=all` lists new files individually rather than collapsing
    // a new directory into a single row, so `changed_files_count` counts the same
    // files the insertion total below is summed over.
    let porcelain =
        run_git(cwd, &["status", "--porcelain", "--untracked-files=all"]).unwrap_or_default();
    let changed: Vec<&str> = porcelain.lines().filter(|l| !l.is_empty()).collect();
    let dirty = !changed.is_empty();

    // Ahead / behind relative to the upstream branch. Fails gracefully when no
    // tracking branch is configured — defaults to 0/0.
    let ahead_behind = run_git(cwd, &["rev-list", "--count", "--left-right", "@{u}...HEAD"]);
    let (behind, ahead) = parse_ahead_behind(ahead_behind.as_deref());

    let (tracked_insertions, deletions) = query_diff_totals(cwd);
    let insertions =
        tracked_insertions.saturating_add(untracked_insertions(cwd, &untracked_paths(&porcelain)));

    GitState {
        is_repo: true,
        branch,
        ahead,
        behind,
        dirty,
        changed_files_count: changed.len(),
        insertions,
        deletions,
    }
}

/// Read the bounded Git history for the Markdown memory subtree.
///
/// The caller supplies a repository that the user explicitly configured as the
/// Memory source. Keeping this primitive read-only and path-scoped lets agents
/// inspect what changed without granting them an arbitrary repository walker.
pub fn query_memory_trace(
    cwd: &str,
    path: &str,
    limit: usize,
) -> Result<Vec<GitMemoryTraceCommit>, String> {
    if !Path::new(cwd).is_dir() {
        return Err("memory Git source is not a directory".to_string());
    }
    if current_branch(cwd).is_none() {
        return Err("memory Git source is not a repository".to_string());
    }
    let path = path.trim();
    if path.is_empty() {
        return Err("memory Git trace path is required".to_string());
    }
    let relative = Path::new(path);
    if relative.is_absolute()
        || path.chars().any(|character| character.is_control())
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
        || (path != "memory" && !path.starts_with("memory/"))
    {
        return Err("memory Git trace path must stay below memory/".to_string());
    }

    let max_count = limit.clamp(1, 50).to_string();
    let output = Command::new("git")
        .args([
            "log",
            "--no-renames",
            &format!("--max-count={max_count}"),
            "--date=iso-strict",
            "--format=%H%x1f%an%x1f%aI%x1f%s",
            "--name-only",
            "--",
            path,
        ])
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|error| format!("could not read memory Git history: {error}"))?;
    if !output.status.success() {
        return Err(command_failure("log", &output));
    }

    let mut commits = Vec::new();
    let mut current: Option<GitMemoryTraceCommit> = None;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split('\u{1f}').collect();
        if fields.len() == 4 && fields[0].len() >= 7 {
            if let Some(commit) = current.take() {
                commits.push(commit);
            }
            current = Some(GitMemoryTraceCommit {
                author: fields[1].to_owned(),
                files: Vec::new(),
                hash: fields[0].to_owned(),
                subject: fields[3].to_owned(),
                timestamp: fields[2].to_owned(),
            });
            continue;
        }
        if line.starts_with("memory/") {
            if let Some(commit) = current.as_mut() {
                if !commit.files.iter().any(|file| file == line) {
                    commit.files.push(line.to_owned());
                }
            }
        }
    }
    if let Some(commit) = current {
        commits.push(commit);
    }
    Ok(commits)
}

/// Parse `git rev-list --count --left-right @{u}...HEAD` output: "<behind>\t<ahead>".
pub(super) fn parse_ahead_behind(raw: Option<&str>) -> (u32, u32) {
    let Some(s) = raw else {
        return (0, 0);
    };
    let mut parts = s.split_whitespace();
    let behind = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let ahead = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    (behind, ahead)
}

/// Shaped `GET /api/git/branches` result: local branches plus the current one.
#[derive(serde::Serialize)]
pub struct GitBranches {
    pub is_repo: bool,
    pub current: Option<String>,
    pub branches: Vec<String>,
}

/// Shaped `POST /api/git/init` result: whether Core created the repository and
/// which branch Git initialized it on.
#[derive(serde::Serialize)]
pub struct GitInitOutcome {
    pub success: bool,
    pub initialized: bool,
    pub branch: Option<String>,
}

/// Initialize a local repository with `main` as its default branch.
///
/// This intentionally does not stage files or create a commit. The caller can
/// review the local Git state first, then use the normal commit flow before
/// publishing the repository to a provider.
pub fn initialize_repository(cwd: &str) -> Result<GitInitOutcome, String> {
    if !std::path::Path::new(cwd).is_dir() {
        return Err("cwd is not a directory".to_string());
    }
    if let Some(branch) = current_branch(cwd) {
        return Ok(GitInitOutcome {
            success: true,
            initialized: false,
            branch: Some(branch),
        });
    }

    let output = git_without_hooks(&["init", "-b", "main"])
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|_| "could not start git init".to_string())?;
    if !output.status.success() {
        return Err(command_failure("init", &output));
    }

    Ok(GitInitOutcome {
        success: true,
        initialized: true,
        branch: current_branch(cwd),
    })
}

/// List local branches plus the currently checked-out one for `cwd`. Returns
/// `is_repo:false` when `cwd` is not a git repository.
pub fn list_branches(cwd: &str) -> GitBranches {
    let current = current_branch(cwd);
    if current.is_none() {
        return GitBranches {
            is_repo: false,
            current: None,
            branches: Vec::new(),
        };
    }

    // Most-recently-committed first, not git's default alphabetical order. The
    // list is NOT paged — `checkout_branch` re-lists to validate its argument, so
    // a server-side limit would make any branch past the cut unreachable — but a
    // client that shows only the head of a long list should be showing the
    // branches actually in play, not the ones that happen to start with "a".
    let raw = run_git(
        cwd,
        &[
            "branch",
            "--sort=-committerdate",
            "--format=%(refname:short)",
        ],
    )
    .unwrap_or_default();
    let branches: Vec<String> = raw
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    GitBranches {
        is_repo: true,
        current,
        branches,
    }
}

/// Switch `cwd` to an existing local branch via `git switch`.
///
/// The branch is validated against the actual branch list to reject typos and
/// argument injection (a name beginning with `-`). Returns the raw git stderr on
/// failure so the caller can surface it (e.g. uncommitted-changes conflicts).
pub fn checkout_branch(cwd: &str, branch: &str) -> Result<String, String> {
    // Only switch to a branch git itself reports — guards against typos and any
    // argument-injection (e.g. a name beginning with '-').
    let known = list_branches(cwd);
    if !known.is_repo {
        return Err("not a git repository".to_string());
    }
    if !known.branches.iter().any(|b| b == branch) {
        return Err(format!("branch '{branch}' not found"));
    }
    reject_local_executable_filters(cwd)?;

    let out = git_without_hooks(&["switch", branch])
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;

    if out.status.success() {
        Ok(branch.to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Create a new branch off the current HEAD and switch to it (`git switch -c`).
///
/// Guards against argument injection (a name beginning with `-`) and obvious bad
/// input; git validates the full ref-name grammar itself and errors cleanly.
/// Returns the raw git stderr on failure (e.g. the branch already exists).
pub fn create_branch(cwd: &str, branch: &str) -> Result<String, String> {
    if !list_branches(cwd).is_repo {
        return Err("not a git repository".to_string());
    }
    // Guard against argument injection (a name beginning with '-') and obvious bad
    // input; git validates the full ref-name grammar itself and errors cleanly.
    let name = branch.trim();
    if name.is_empty()
        || name.starts_with('-')
        || name.contains("..")
        || name.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(format!("'{branch}' is not a valid branch name"));
    }
    reject_local_executable_filters(cwd)?;

    let out = git_without_hooks(&["switch", "-c", name])
        .current_dir(cwd)
        .no_window()
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;

    if out.status.success() {
        Ok(name.to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Shaped `POST /api/git/commit-push` result: what the action actually did.
#[derive(serde::Serialize)]
pub struct CommitPushOutcome {
    pub success: bool,
    pub committed: bool,
    pub pushed: bool,
    pub commit: Option<String>,
}

/// Commit, push, or do both for `cwd`. `action` is one of `commit`,
/// `commit-push`, or `push` (validated by the caller). When `include_unstaged`
/// is set, stages everything before committing. Mutating commands reject
/// repo-local executable filters, disable hooks, and return bounded operation
/// errors rather than forwarding untrusted hook output to the caller.
pub fn run_git_action(
    cwd: &str,
    message: &str,
    action: &str,
    include_unstaged: bool,
) -> Result<CommitPushOutcome, String> {
    // Confirm this is a git repo before touching the working tree.
    if current_branch(cwd).is_none() {
        return Err("not a git repository".to_string());
    }
    if action != "push" && include_unstaged {
        reject_local_executable_filters(cwd)?;
    }

    if action != "push" && include_unstaged {
        // Stage everything. A failure here is fatal (e.g. corrupt index).
        let add = git_without_hooks(&["add", "-A"])
            .current_dir(cwd)
            .no_window()
            .output()
            .map_err(|_| "could not start git add".to_string())?;
        if !add.status.success() {
            return Err(git_mutation_failed("add"));
        }
    }

    let mut committed = false;
    if action != "push" {
        let has_head = run_git(cwd, &["rev-parse", "--verify", "HEAD"]).is_some();
        let staged_args = ["diff", "--cached", "--name-only"];
        let has_staged = run_git(cwd, &staged_args)
            .map(|s| s.lines().any(|l| !l.trim().is_empty()))
            .unwrap_or(false);

        if !has_staged && include_unstaged {
            let has_changes = run_git(cwd, &["status", "--porcelain"])
                .map(|s| s.lines().any(|l| !l.trim().is_empty()))
                .unwrap_or(false);
            if has_changes {
                return Err("no staged changes to commit".to_string());
            }
        }

        let mut commit_args = vec!["commit", "--no-verify", "-m", message];
        // A newly initialized, empty folder has no staged paths yet, but it
        // still needs an initial commit before `gh repo create --push` can
        // publish it. Preserve the normal no-op behavior for an established
        // repository while allowing the unborn branch to get a real root.
        if !has_head && !has_staged {
            commit_args.insert(1, "--allow-empty");
        }
        let commit = git_without_hooks(&commit_args)
            .current_dir(cwd)
            .no_window()
            .output()
            .map_err(|_| "could not start git commit".to_string())?;
        if (!has_head || has_staged) && commit.status.success() {
            committed = true;
        } else if has_staged || !has_head {
            return Err(git_mutation_failed("commit"));
        }
    }

    let mut pushed = false;
    if action != "commit" {
        // Push to the configured upstream. When there is no tracking branch git
        // exits non-zero with a helpful message — surface it verbatim.
        let push = git_without_hooks(&["push", "--no-verify"])
            .current_dir(cwd)
            .no_window()
            .output()
            .map_err(|_| "could not start git push".to_string())?;
        if !push.status.success() {
            return Err(git_mutation_failed("push"));
        }
        pushed = true;
    }

    let commit = run_git(cwd, &["rev-parse", "--short", "HEAD"]);

    Ok(CommitPushOutcome {
        success: true,
        committed,
        pushed,
        commit,
    })
}
