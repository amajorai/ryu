//! Destination side of a handoff: fetching the base and rebuilding the
//! reviewed working tree as a persistent worktree.

use super::*;

// ── Destination ───────────────────────────────────────────────────────────────

/// Make sure every commit in `commits` exists in `repo_root`, fetching from
/// `origin` by id first and deepening a shallow clone as the fallback.
/// `clone_repository` uses `--depth 1`, so a base older than the remote's tip
/// is normally missing.
pub fn ensure_base(repo_root: &Path, commits: &[String]) -> HandoffResult<()> {
    let missing = |commits: &[String]| -> Vec<String> {
        commits
            .iter()
            .filter(|commit| !commit_exists(repo_root, commit))
            .cloned()
            .collect()
    };
    for commit in commits {
        if !is_hex_commit(commit) {
            return Err(HandoffError::Refused(
                "base commit is not a commit id".to_owned(),
            ));
        }
    }
    let wanted = missing(commits);
    if wanted.is_empty() {
        return Ok(());
    }
    let cwd = repo_root.to_string_lossy().into_owned();
    for commit in &wanted {
        // Best effort: hosts that refuse unadvertised ids fall through below.
        let _ = run_remote_git_command(&cwd, &["fetch", "--no-tags", "--quiet", "origin", commit]);
    }
    let wanted = missing(&wanted);
    if wanted.is_empty() {
        return Ok(());
    }
    let shallow = git_optional(repo_root, &["rev-parse", "--is-shallow-repository"])
        .is_some_and(|value| value == "true");
    let args: &[&str] = if shallow {
        &["fetch", "--no-tags", "--quiet", "--unshallow", "origin"]
    } else {
        &["fetch", "--no-tags", "--quiet", "origin"]
    };
    match run_remote_git_command(&cwd, args) {
        Ok(output) if output.status.success() => {}
        Ok(output) => return Err(git_failure("fetch", &output)),
        Err(error) => return Err(HandoffError::Git(format!("git fetch {error}"))),
    }
    let wanted = missing(&wanted);
    if wanted.is_empty() {
        Ok(())
    } else {
        Err(HandoffError::MissingCommit(format!(
            "the remote does not have commit {}; push it from the source first",
            wanted[0]
        )))
    }
}

pub(super) fn unique_branch(repo_root: &Path, desired: &str) -> HandoffResult<String> {
    let base = crate::worktree::sanitize_branch_name(desired)
        .ok_or_else(|| HandoffError::Refused("handoff branch name is empty".to_owned()))?;
    for attempt in 0..100 {
        let candidate = if attempt == 0 {
            base.clone()
        } else {
            format!("{base}-{}", attempt + 1)
        };
        if !crate::worktree::branch_exists(repo_root, &candidate)
            && git_optional(repo_root, &["check-ref-format", "--branch", &candidate]).is_some()
        {
            return Ok(candidate);
        }
    }
    Err(HandoffError::Refused(
        "no free handoff branch name is left".to_owned(),
    ))
}

/// Paths `git apply --numstat -z` reports for `patch`. With renames disabled at
/// export, every row is `added\tdeleted\tpath`.
pub(super) fn patch_paths(cwd: &Path, patch: &Path) -> HandoffResult<BTreeSet<String>> {
    let patch_arg = patch.to_string_lossy().into_owned();
    let raw = git_ok(cwd, &["apply", "--numstat", "-z", "--binary", &patch_arg])?;
    let mut paths = BTreeSet::new();
    for row in split_nul(&raw) {
        let mut columns = row.splitn(3, '\t');
        let path = columns.nth(2).unwrap_or_default();
        if path.is_empty() {
            return Err(HandoffError::Refused(
                "the patch renames or copies a path; it was not produced by a handoff export"
                    .to_owned(),
            ));
        }
        paths.insert(path.to_owned());
    }
    Ok(paths)
}

/// Rebuild the reviewed working tree as a new, persistent worktree.
///
/// This is deliberately not a [`crate::worktree::WorktreeGuard`]: the guard's
/// `Drop` deletes the worktree, and a handoff must outlive the request.
pub fn materialize_handoff(request: &MaterializeRequest) -> HandoffResult<Materialized> {
    let root =
        std::fs::canonicalize(&request.repo_root).map_err(|_| HandoffError::NotAGitRepository)?;
    if git_optional(&root, &["rev-parse", "--git-dir"]).is_none() {
        return Err(HandoffError::NotAGitRepository);
    }
    reject_filters(&root)?;
    if !is_hex_commit(&request.head) {
        return Err(HandoffError::Refused("HEAD is not a commit id".to_owned()));
    }
    if !request.worktree_dir.is_absolute() {
        return Err(HandoffError::Refused(
            "worktree folder must be absolute".to_owned(),
        ));
    }
    if std::fs::symlink_metadata(&request.worktree_dir).is_ok() {
        return Err(HandoffError::Refused(
            "worktree folder already exists".to_owned(),
        ));
    }
    for path in &request.expected_paths {
        if !is_safe_repo_relative_path(path) {
            return Err(HandoffError::Refused(format!(
                "unsafe path in manifest: {path}"
            )));
        }
    }

    let handoff_ref = format!("refs/ryu/handoff/{}", uuid::Uuid::new_v4());
    if let Some(bundle) = &request.bundle {
        let bundle_arg = bundle.to_string_lossy().into_owned();
        let verify = run_command(
            git_command(&root, &["bundle", "verify", &bundle_arg]),
            "bundle",
        )?;
        if !verify.status.success() {
            let details = String::from_utf8_lossy(&verify.stderr);
            return Err(
                if details.contains("lacks") || details.contains("prerequisite") {
                    HandoffError::MissingCommit(
                        "this repository lacks a commit the handed-off history builds on"
                            .to_owned(),
                    )
                } else {
                    git_failure("bundle verify", &verify)
                },
            );
        }
        let refspec = format!("HEAD:{handoff_ref}");
        git_ok(
            &root,
            &["fetch", "--no-tags", "--quiet", &bundle_arg, &refspec],
        )?;
        let fetched = git_text(&root, &["rev-parse", "--verify", &handoff_ref])?;
        if fetched != request.head {
            let _ = git_ok(&root, &["update-ref", "-d", &handoff_ref]);
            return Err(HandoffError::Refused(
                "the bundle tip does not match the reviewed HEAD".to_owned(),
            ));
        }
    }
    if !commit_exists(&root, &request.head) {
        let _ = git_ok(&root, &["update-ref", "-d", &handoff_ref]);
        return Err(HandoffError::MissingCommit(format!(
            "commit {} is not available on this node",
            request.head
        )));
    }

    let branch = unique_branch(&root, &request.branch)?;
    if let Some(parent) = request.worktree_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            HandoffError::Git(format!("could not create worktree folder: {error}"))
        })?;
    }
    let worktree_arg = request.worktree_dir.to_string_lossy().into_owned();
    let added = git_ok(
        &root,
        &[
            "worktree",
            "add",
            "--quiet",
            "-b",
            &branch,
            &worktree_arg,
            &request.head,
        ],
    );
    let _ = git_ok(&root, &["update-ref", "-d", &handoff_ref]);
    added?;

    let rollback = |error: HandoffError| -> HandoffError {
        let _ = git_ok(&root, &["worktree", "remove", "--force", &worktree_arg]);
        let _ = std::fs::remove_dir_all(&request.worktree_dir);
        let _ = git_ok(&root, &["worktree", "prune"]);
        let _ = git_ok(&root, &["branch", "-D", &branch]);
        error
    };
    let worktree = request.worktree_dir.clone();
    let finish = || -> HandoffResult<()> {
        let git_dir = git_text(&worktree, &["rev-parse", "--absolute-git-dir"])?;
        std::fs::write(Path::new(&git_dir).join(HANDOFF_MARKER), &request.marker).map_err(
            |error| HandoffError::Git(format!("could not write handoff marker: {error}")),
        )?;
        match &request.diff {
            Some(patch) => {
                let actual = patch_paths(&worktree, patch)?;
                if actual != request.expected_paths {
                    return Err(HandoffError::Refused(
                        "the patch touches paths the reviewed manifest does not list".to_owned(),
                    ));
                }
                let patch_arg = patch.to_string_lossy().into_owned();
                git_ok(
                    &worktree,
                    &["apply", "--binary", "--whitespace=nowarn", &patch_arg],
                )?;
            }
            None if !request.expected_paths.is_empty() => {
                return Err(HandoffError::Refused(
                    "the manifest lists changed paths but no patch was supplied".to_owned(),
                ));
            }
            None => {}
        }
        Ok(())
    };
    finish().map_err(rollback)?;
    Ok(Materialized {
        worktree_path: worktree,
        branch,
    })
}

/// Initialise an empty repository for a handoff whose source had no network
/// remote. The bundle then carries the full history.
pub fn init_repository(path: &Path) -> HandoffResult<()> {
    std::fs::create_dir_all(path).map_err(|error| {
        HandoffError::Git(format!("could not create repository folder: {error}"))
    })?;
    git_ok(path, &["init", "--quiet"])?;
    Ok(())
}

/// The `origin` URL of `repo_root`, cleaned the same way the source cleans it.
pub fn origin_url(repo_root: &Path) -> Option<String> {
    git_optional(repo_root, &["config", "--get", "remote.origin.url"])
        .and_then(|url| clean_remote_url(&url))
}

/// True when `path` is (inside) a worktree created by [`materialize_handoff`].
pub fn is_handoff_worktree(path: &Path) -> bool {
    git_optional(path, &["rev-parse", "--absolute-git-dir"])
        .is_some_and(|git_dir| Path::new(&git_dir).join(HANDOFF_MARKER).is_file())
}
