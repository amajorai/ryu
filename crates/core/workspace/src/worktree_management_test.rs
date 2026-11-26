use super::*;
use std::process::Command;
use tempfile::TempDir;

#[test]
fn foreign_process_worktree_lease_helper() {
    let Ok(id) = std::env::var("RYU_TEST_WORKTREE_LEASE_ID") else {
        return;
    };
    let ready = std::env::var("RYU_TEST_WORKTREE_LEASE_READY").unwrap();
    let _lease = worktree_lease(&id)
        .unwrap()
        .expect("foreign lease acquired");
    std::fs::write(ready, "ready").unwrap();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).unwrap();
}

#[test]
fn another_process_lease_protects_forged_completed_worktrees() {
    let repo = repo();
    let root = TempDir::new().unwrap();
    let options = ManagedWorktreeOptions {
        root: Some(root.path().to_owned()),
        auto_delete_limit: 1,
        ..Default::default()
    };
    let mut victim = create_managed_worktree(repo.path(), None, &options).unwrap();
    let id = victim
        .path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    // Hand authority to a distinct process, so a process-local registry
    // cannot make this security regression pass.
    victim
        .management
        .as_ref()
        .unwrap()
        .lease
        .lock()
        .unwrap()
        .take();
    let ready = root.path().join("foreign-lease-ready");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "worktree::management::tests::foreign_process_worktree_lease_helper",
        ])
        .env("RYU_TEST_WORKTREE_LEASE_ID", &id)
        .env("RYU_TEST_WORKTREE_LEASE_READY", &ready)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .no_window()
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !ready.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    if !ready.exists() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("foreign worktree lease did not start");
    }
    let record_path = root.path().join(".ryu-managed").join(format!("{id}.json"));
    let mut forged: Record = serde_json::from_slice(&std::fs::read(&record_path).unwrap()).unwrap();
    forged.completed_at = Some(1);
    write_record(&record_path, &forged).unwrap();
    let first = create_managed_worktree(repo.path(), None, &options).unwrap();
    let first_path = first.path.clone();
    drop(first);
    drop(create_managed_worktree(repo.path(), None, &options).unwrap());
    assert!(
        !first_path.exists(),
        "legitimate completed worktree was pruned"
    );
    assert!(
        victim.path.exists(),
        "foreign active lease prevented pruning"
    );
    child.stdin.take();
    assert!(child.wait().unwrap().success());
    victim.suspend_managed_pruning();
}

fn repo() -> TempDir {
    let directory = TempDir::new().expect("temporary repository");
    git(directory.path(), &["init"]).expect("initialize git");
    git(directory.path(), &["config", "user.name", "Test"]).expect("set name");
    git(
        directory.path(),
        &["config", "user.email", "test@ryu.local"],
    )
    .expect("set email");
    std::fs::write(directory.path().join("README"), "initial").expect("write initial file");
    git(directory.path(), &["add", "README"]).expect("stage initial file");
    git(directory.path(), &["commit", "-m", "Initial"]).expect("commit initial file");
    directory
}

#[test]
fn custom_root_and_disabled_cleanup_retain_completed_worktrees() {
    let repo = repo();
    let root = TempDir::new().expect("custom root");
    let options = ManagedWorktreeOptions {
        root: Some(root.path().to_owned()),
        auto_delete: false,
        ..Default::default()
    };
    let guard =
        create_managed_worktree(repo.path(), None, &options).expect("create managed worktree");
    let path = guard.path.clone();
    assert_eq!(
        path.parent(),
        Some(
            canonical_path(root.path())
                .expect("canonical root")
                .as_path()
        )
    );
    drop(guard);
    assert!(
        path.exists(),
        "disabled auto-delete retains completed worktree"
    );
    let record: Record = serde_json::from_slice(
        &std::fs::read(root.path().join(".ryu-managed").join(format!(
            "{}.json",
            path.file_name().expect("id").to_string_lossy()
        )))
        .expect("read metadata"),
    )
    .expect("parse metadata");
    assert!(record.completed_at.is_some());
}

#[test]
fn pruning_snapshots_commits_staged_and_untracked_files_and_never_active_worktrees() {
    let repo = repo();
    let root = TempDir::new().expect("custom root");
    let options = ManagedWorktreeOptions {
        root: Some(root.path().to_owned()),
        auto_delete_limit: 1,
        ..Default::default()
    };
    let active = create_managed_worktree(repo.path(), None, &options).expect("active worktree");
    let forged_path = root.path().join(".ryu-managed").join(format!(
        "{}.json",
        active.path.file_name().unwrap().to_string_lossy()
    ));
    let mut forged: Record = serde_json::from_slice(&std::fs::read(&forged_path).unwrap()).unwrap();
    forged.completed_at = Some(1);
    write_record(&forged_path, &forged).unwrap();
    let first = create_managed_worktree(repo.path(), None, &options).expect("first worktree");
    let first_path = first.path.clone();
    let id = first_path.file_name().expect("id").to_string_lossy();
    let reference = format!("refs/ryu/worktree-snapshots/{id}");
    std::fs::write(first.path.join("README"), "committed").expect("write committed");
    git(&first.path, &["add", "README"]).expect("stage");
    git(&first.path, &["commit", "-m", "Worktree commit"]).expect("commit");
    std::fs::write(first.path.join("README"), "staged").expect("write staged");
    git(&first.path, &["add", "README"]).expect("stage");
    std::fs::write(first.path.join("README"), "unstaged").expect("write unstaged");
    std::fs::write(first.path.join("new.txt"), "untracked").expect("write untracked");
    drop(first);
    assert!(
        first_path.exists(),
        "within limit retains completed worktree"
    );
    let second = create_managed_worktree(repo.path(), None, &options).expect("second worktree");
    let second_path = second.path.clone();
    drop(second);
    assert!(!first_path.exists(), "oldest completed worktree is pruned");
    assert!(second_path.exists(), "newest completed worktree retained");
    assert!(active.path.exists(), "active worktree never pruned");
    assert_eq!(
        git(repo.path(), &["show", &format!("{reference}:README")]).expect("recover unstaged"),
        "unstaged"
    );
    assert_eq!(
        git(repo.path(), &["show", &format!("{reference}^:README")]).expect("recover staged"),
        "staged"
    );
    assert_eq!(
        git(repo.path(), &["show", &format!("{reference}^^:README")]).expect("recover committed"),
        "committed"
    );
    assert_eq!(
        git(repo.path(), &["show", &format!("{reference}:new.txt")]).expect("recover untracked"),
        "untracked"
    );
    let recovered = root.path().join("recovered");
    git(
        repo.path(),
        &[
            "worktree",
            "add",
            "--detach",
            recovered.to_str().expect("recovery path"),
            &reference,
        ],
    )
    .expect("restore recovery snapshot into an actual worktree");
    assert_eq!(
        std::fs::read_to_string(recovered.join("README")).expect("restored tracked file"),
        "unstaged"
    );
    assert_eq!(
        std::fs::read_to_string(recovered.join("new.txt")).expect("restored untracked file"),
        "untracked"
    );
    drop(active);
    assert!(
        recovered.exists(),
        "unregistered recovery worktree is never pruned"
    );
    git(
        repo.path(),
        &[
            "worktree",
            "remove",
            recovered.to_str().expect("recovery path"),
        ],
    )
    .expect("remove test recovery worktree");
}

#[test]
fn failed_fetch_prevents_worktree_allocation() {
    let repo = repo();
    git(
        repo.path(),
        &[
            "remote",
            "add",
            "origin",
            repo.path()
                .join("missing-remote")
                .to_str()
                .expect("remote path"),
        ],
    )
    .expect("remote");
    let root = repo.path().join("custom-root");
    let options = ManagedWorktreeOptions {
        root: Some(root.clone()),
        fetch_upstream: true,
        ..Default::default()
    };
    assert!(create_managed_worktree(repo.path(), None, &options).is_err());
    assert!(!root.exists(), "failed fetch must not allocate a directory");
}

#[test]
fn fetch_updates_remote_tracking_before_creation() {
    let remote = repo();
    let local = repo();
    git(
        local.path(),
        &[
            "remote",
            "add",
            "origin",
            remote.path().to_str().expect("remote path"),
        ],
    )
    .expect("remote");
    let options = ManagedWorktreeOptions {
        fetch_upstream: true,
        ..Default::default()
    };
    let guard = create_managed_worktree(local.path(), None, &options).expect("fetch and create");
    let remote_head = git(remote.path(), &["rev-parse", "HEAD"]).expect("remote head");
    let branch = git(remote.path(), &["symbolic-ref", "--short", "HEAD"]).expect("remote branch");
    assert_eq!(
        git(
            local.path(),
            &["rev-parse", &format!("refs/remotes/origin/{branch}")]
        )
        .expect("tracking head"),
        remote_head
    );
    drop(guard);
}

#[test]
fn invalid_root_and_limit_are_rejected_before_creation() {
    let repo = repo();
    let relative = ManagedWorktreeOptions {
        root: Some(PathBuf::from("relative")),
        ..Default::default()
    };
    assert!(create_managed_worktree(repo.path(), None, &relative).is_err());
    let zero = ManagedWorktreeOptions {
        auto_delete_limit: 0,
        ..Default::default()
    };
    assert!(create_managed_worktree(repo.path(), None, &zero).is_err());
    assert!(!repo.path().join(".ryu-worktrees").exists());
}

#[test]
fn snapshot_failure_retains_original_worktree() {
    let repo = repo();
    let options = ManagedWorktreeOptions {
        auto_delete_limit: 1,
        ..Default::default()
    };
    let first = create_managed_worktree(repo.path(), None, &options).expect("first");
    let first_path = first.path.clone();
    drop(first);
    // An invalid index prevents a complete snapshot; no force removal follows.
    let git_dir = git(&first_path, &["rev-parse", "--absolute-git-dir"]).expect("git dir");
    std::fs::write(Path::new(&git_dir).join("index"), "invalid").expect("invalidate index");
    drop(create_managed_worktree(repo.path(), None, &options).expect("second"));
    assert!(
        first_path.exists(),
        "snapshot failure preserves original files"
    );
}

#[test]
fn failed_removal_preserves_durable_snapshot_without_overwriting_on_retry() {
    let repo = repo();
    let options = ManagedWorktreeOptions {
        auto_delete_limit: 1,
        ..Default::default()
    };
    let first = create_managed_worktree(repo.path(), None, &options).expect("first");
    let first_path = first.path.clone();
    let reference = format!(
        "refs/ryu/worktree-snapshots/{}",
        first_path.file_name().expect("id").to_string_lossy()
    );
    drop(first);
    git(
        repo.path(),
        &[
            "worktree",
            "lock",
            first_path.to_str().expect("worktree path"),
        ],
    )
    .expect("lock worktree to prevent removal");
    drop(create_managed_worktree(repo.path(), None, &options).expect("second"));
    assert!(
        first_path.exists(),
        "failed removal retains original worktree"
    );
    assert_eq!(
        git(repo.path(), &["show", &format!("{reference}:README")]).expect("durable snapshot"),
        "initial"
    );
    std::fs::write(first_path.join("README"), "modified after failed removal")
        .expect("modify retained worktree");
    drop(create_managed_worktree(repo.path(), None, &options).expect("third"));
    assert!(
        first_path.exists(),
        "failed removal must not be retried automatically"
    );
    assert_eq!(
        git(repo.path(), &["show", &format!("{reference}:README")])
            .expect("original recovery snapshot"),
        "initial"
    );
    git(
        repo.path(),
        &[
            "worktree",
            "unlock",
            first_path.to_str().expect("worktree path"),
        ],
    )
    .expect("unlock test worktree");
}

#[test]
fn disabling_cleanup_before_release_retains_previously_created_worktrees() {
    let repo = repo();
    let options = ManagedWorktreeOptions {
        auto_delete_limit: 1,
        ..Default::default()
    };
    let first = create_managed_worktree(repo.path(), None, &options).expect("first");
    let first_path = first.path.clone();
    drop(first);
    let mut second = create_managed_worktree(repo.path(), None, &options).expect("second");
    let second_path = second.path.clone();
    let disabled = ManagedWorktreeOptions {
        auto_delete: false,
        ..options
    };
    second.suspend_managed_pruning();
    second.update_managed_options(&disabled);
    drop(second);
    assert!(
        first_path.exists(),
        "latest disabled cleanup protects older worktrees"
    );
    assert!(
        second_path.exists(),
        "latest disabled cleanup retains released worktree"
    );
}

#[test]
fn embedded_repository_is_retained_when_snapshot_cannot_preserve_its_contents() {
    let repo = repo();
    let options = ManagedWorktreeOptions {
        auto_delete_limit: 1,
        ..Default::default()
    };
    let first = create_managed_worktree(repo.path(), None, &options).expect("first");
    let first_path = first.path.clone();
    let nested = first.path.join("nested");
    git(
        repo.path(),
        &[
            "clone",
            repo.path().to_str().expect("repository path"),
            nested.to_str().expect("nested path"),
        ],
    )
    .expect("create embedded Git repository");
    drop(first);
    drop(create_managed_worktree(repo.path(), None, &options).expect("second"));
    assert!(
        first_path.exists(),
        "unsupported snapshot retains original worktree"
    );
    assert_eq!(
        std::fs::read_to_string(nested.join("README")).expect("nested contents preserved"),
        "initial"
    );
    assert!(
        nested.join(".git").exists(),
        "embedded Git history preserved"
    );
}

#[test]
fn interrupted_suspended_worktree_remains_ineligible_for_later_pruning() {
    let repo = repo();
    let options = ManagedWorktreeOptions {
        auto_delete_limit: 1,
        ..Default::default()
    };
    let mut interrupted =
        create_managed_worktree(repo.path(), None, &options).expect("interrupted");
    let path = interrupted.path.clone();
    interrupted.suspend_managed_pruning();
    drop(interrupted);
    drop(create_managed_worktree(repo.path(), None, &options).expect("second"));
    drop(create_managed_worktree(repo.path(), None, &options).expect("third"));
    assert!(path.exists(), "interrupted worktree must remain protected");
    let record: Record = serde_json::from_slice(
        &std::fs::read(
            path.parent()
                .expect("root")
                .join(".ryu-managed")
                .join(format!(
                    "{}.json",
                    path.file_name().expect("id").to_string_lossy()
                )),
        )
        .expect("read metadata"),
    )
    .expect("parse metadata");
    assert!(
        record.completed_at.is_none(),
        "unknown release must not become cleanup eligible"
    );
}

#[test]
fn registered_nested_active_worktree_protects_its_ignored_parent_from_pruning() {
    let repo = repo();
    std::fs::write(repo.path().join(".gitignore"), ".ryu-worktrees\n")
        .expect("ignore managed checkouts");
    git(repo.path(), &["add", ".gitignore"]).expect("stage ignore rule");
    git(repo.path(), &["commit", "-m", "Ignore managed checkouts"]).expect("commit ignore rule");
    let options = ManagedWorktreeOptions {
        auto_delete_limit: 1,
        ..Default::default()
    };
    let parent = create_managed_worktree(repo.path(), None, &options).expect("parent worktree");
    let parent_path = parent.path.clone();
    let mut child = create_managed_worktree(&parent.path, None, &options).expect("nested worktree");
    child.suspend_managed_pruning();
    let child_path = child.path.clone();
    std::fs::write(child.path.join("active.txt"), "active child work")
        .expect("write active child work");
    drop(parent);
    drop(create_managed_worktree(repo.path(), None, &options).expect("next completed worktree"));
    assert!(
        parent_path.exists(),
        "parent of a registered checkout is protected"
    );
    assert!(
        child_path.exists(),
        "nested active checkout must survive parent cleanup"
    );
    assert_eq!(
        std::fs::read_to_string(child_path.join("active.txt")).expect("preserved active work"),
        "active child work"
    );
    drop(child);
}
