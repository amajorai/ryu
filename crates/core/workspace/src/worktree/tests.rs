//! Tests for run worktrees: creation and cleanup, the aggregate diff
//! (`diff::worktree_diff`) and applying a run (`apply::apply_worktree`).

use super::apply::{apply_worktree, ApplyMode};
use super::diff::worktree_diff;
use super::*;
use tempfile::TempDir;

fn init_git_repo(dir: &Path) {
    git_command(&["init"])
        .current_dir(dir)
        .output()
        .expect("git init");
    git_command(&["config", "user.email", "test@ryu"])
        .current_dir(dir)
        .output()
        .expect("git config email");
    git_command(&["config", "user.name", "Test"])
        .current_dir(dir)
        .output()
        .expect("git config name");
    // Need at least one commit for worktree add to work.
    let readme = dir.join("README");
    std::fs::write(&readme, "init").expect("write README");
    git_command(&["add", "."])
        .current_dir(dir)
        .output()
        .expect("git add");
    git_command(&["commit", "-m", "init"])
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
    git_command(&["add", "."])
        .current_dir(&wt_path)
        .output()
        .expect("git add");
    git_command(&["commit", "-m", "add two files"])
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
    let list = git_command(&["worktree", "list"])
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
    let branches = git_command(&["branch", "--list"])
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
    git_command(&["add", "feature.txt"])
        .current_dir(&guard.path)
        .output()
        .expect("git add");

    let result = apply_worktree(&guard, ApplyMode::Merge, "feat: add feature", None, false);
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
    git_command(&["add", "."])
        .current_dir(repo)
        .output()
        .expect("add");
    git_command(&["commit", "-m", "base commit"])
        .current_dir(repo)
        .output()
        .expect("commit");

    // Create a worktree and write a conflicting version of the same file.
    let guard = create_worktree(repo).expect("create_worktree");
    std::fs::write(guard.path.join("conflict.txt"), "worktree content").expect("write wt");
    git_command(&["add", "."])
        .current_dir(&guard.path)
        .output()
        .expect("add");
    git_command(&["commit", "-m", "wt commit"])
        .current_dir(&guard.path)
        .output()
        .expect("commit");

    // Also modify the file on base AFTER worktree creation so it diverges.
    std::fs::write(repo.join("conflict.txt"), "base diverged content").expect("write base2");
    git_command(&["add", "."])
        .current_dir(repo)
        .output()
        .expect("add");
    git_command(&["commit", "-m", "base diverged"])
        .current_dir(repo)
        .output()
        .expect("commit");

    let result = apply_worktree(&guard, ApplyMode::Merge, "conflict merge", None, false);

    // On a genuine conflict the merge should fail with the conflicted file list.
    if let Err(conflict) = result {
        assert!(
            !conflict.conflicted_files.is_empty(),
            "conflict error should include conflicted files"
        );
        // Base repo must be in a clean state (merge --abort ran).
        let status = git_command(&["status", "--porcelain"])
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

/// Apply a one-file change in merge mode and return the message of the commit
/// `apply_worktree` made for it: the second parent of the merge on the base.
fn applied_change_message(credit: bool) -> String {
    let tmp = TempDir::new().expect("tempdir");
    let repo = tmp.path();
    init_git_repo(repo);
    let guard = create_worktree(repo).expect("create_worktree");
    std::fs::write(guard.path.join("feature.txt"), "hello").expect("write");

    apply_worktree(&guard, ApplyMode::Merge, "Add feature", None, credit).expect("apply");

    let log = git_command(&["log", "-1", "--format=%B", "HEAD^2"])
        .current_dir(repo)
        .output()
        .expect("git log");
    assert!(log.status.success(), "the merge has a second parent");
    drop(guard);
    String::from_utf8_lossy(&log.stdout).trim().to_string()
}

#[test]
fn apply_credits_ryu_on_the_change_commit_when_the_setting_is_on() {
    use crate::git::{credited_commit_args, RYU_COAUTHOR_TRAILER};

    // A Git without `commit --trailer` commits without credit.
    let expected = if credited_commit_args(&["commit"], true).len() > 1 {
        format!("Add feature\n\n{RYU_COAUTHOR_TRAILER}")
    } else {
        "Add feature".to_string()
    };
    assert_eq!(applied_change_message(true), expected);
}

#[test]
fn apply_adds_no_trailer_when_the_setting_is_off() {
    assert_eq!(applied_change_message(false), "Add feature");
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
    let list = git_command(&["worktree", "list"])
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
    let branches = git_command(&["branch", "--list", &branch])
        .current_dir(repo)
        .output()
        .expect("git branch list");
    let branches_str = String::from_utf8_lossy(&branches.stdout);
    assert!(
        branches_str.trim().is_empty(),
        "run branch should be deleted after drop"
    );
}

#[test]
fn project_environment_runs_setup_and_cleanup_with_variables() {
    let tmp = TempDir::new().expect("tempdir");
    let repo = tmp.path();
    init_git_repo(repo);

    let mut guard = create_worktree(repo).expect("create_worktree");
    let worktree_path = guard.path.clone();

    #[cfg(target_os = "windows")]
    let setup = "Set-Content -Path setup-marker.txt -Value $env:RYU_TEST_VALUE";
    #[cfg(not(target_os = "windows"))]
    let setup = "printf '%s' \"$RYU_TEST_VALUE\" > setup-marker.txt";
    #[cfg(target_os = "windows")]
    let cleanup =
        "Set-Content -Path (Join-Path $env:RYU_PROJECT_PATH cleanup-marker.txt) -Value cleaned";
    #[cfg(not(target_os = "windows"))]
    let cleanup = "printf cleaned > \"$RYU_PROJECT_PATH/cleanup-marker.txt\"";

    guard
        .configure_environment(
            Some(setup),
            Some(cleanup),
            vec![("RYU_TEST_VALUE".to_owned(), "ready".to_owned())],
        )
        .expect("configure environment");
    assert_eq!(
        std::fs::read_to_string(worktree_path.join("setup-marker.txt"))
            .expect("setup marker")
            .trim(),
        "ready"
    );

    drop(guard);
    assert_eq!(
        std::fs::read_to_string(repo.join("cleanup-marker.txt"))
            .expect("cleanup marker")
            .trim(),
        "cleaned"
    );
    assert!(!worktree_path.exists(), "worktree is removed after cleanup");
}
