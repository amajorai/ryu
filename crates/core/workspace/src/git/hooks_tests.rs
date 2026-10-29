//! `run_git_action` must never execute repository hooks. `--no-verify` only
//! skips `pre-commit`, `commit-msg` and `pre-push`; the `core.hooksPath`
//! override in `git_without_hooks` is what also keeps `post-commit` (and any
//! hook configured through a local `core.hooksPath`) from running.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::process::Command;

use crate::git::{initialize_repository, run_git_action};

const HOOKS: [&str; 4] = ["pre-commit", "commit-msg", "post-commit", "pre-push"];

fn git(cwd: &Path, args: &[&str]) -> std::process::Output {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("spawn git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn stdout(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn init_repo(path: &Path) {
    initialize_repository(path.to_str().unwrap()).unwrap();
    git(path, &["config", "user.name", "Ryu Test"]);
    git(path, &["config", "user.email", "ryu-test@example.com"]);
}

/// Install every hook in `HOOKS` into `dir`: each appends its name to
/// `marker` and exits 1, so a hook that runs both leaves evidence and (for
/// the blocking hooks) fails the operation.
fn install_hooks(dir: &Path, marker: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    for hook in HOOKS {
        let path = dir.join(hook);
        std::fs::write(
            &path,
            format!("#!/bin/sh\necho {hook} >> '{}'\nexit 1\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

/// Prove the installed hooks are live for a plain `git commit`, then undo
/// the evidence so the real assertion starts from a clean marker.
fn assert_hooks_are_live(repo: &Path, marker: &Path) {
    let plain = Command::new("git")
        .args(["commit", "--allow-empty", "-m", "control"])
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(!plain.status.success(), "control commit should be blocked");
    assert!(marker.exists(), "control commit should run pre-commit");
    std::fs::remove_file(marker).unwrap();
}

#[test]
fn commit_push_action_skips_hooks_in_the_git_dir() {
    let root = tempfile::tempdir().unwrap();
    let remote = root.path().join("remote.git");
    let repo = root.path().join("repo");
    let marker = root.path().join("hook-ran.txt");
    git(
        root.path(),
        &["init", "--bare", "-b", "main", remote.to_str().unwrap()],
    );
    std::fs::create_dir_all(&repo).unwrap();
    init_repo(&repo);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    git(&repo, &["add", "a.txt"]);
    git(&repo, &["commit", "-m", "initial"]);
    git(
        &repo,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&repo, &["push", "-u", "origin", "main"]);

    install_hooks(&repo.join(".git/hooks"), &marker);
    assert_hooks_are_live(&repo, &marker);

    std::fs::write(repo.join("a.txt"), "two\n").unwrap();
    let outcome = run_git_action(repo.to_str().unwrap(), "hooked change", "commit-push", true)
        .expect("commit-push succeeds despite failing hooks");
    assert!(outcome.success && outcome.committed && outcome.pushed);
    assert!(
        !marker.exists(),
        "a repository hook ran: {}",
        std::fs::read_to_string(&marker).unwrap_or_default()
    );

    let head = stdout(&git(&repo, &["rev-parse", "HEAD"]));
    let subject = stdout(&git(&repo, &["log", "-1", "--format=%s"]));
    assert_eq!(subject, "hooked change");
    let remote_head = stdout(&git(
        root.path(),
        &["--git-dir", remote.to_str().unwrap(), "rev-parse", "main"],
    ));
    assert_eq!(remote_head, head, "push reached the remote");
}

#[test]
fn commit_action_ignores_a_local_core_hooks_path() {
    let root = tempfile::tempdir().unwrap();
    let repo = root.path().join("repo");
    let hooks = root.path().join("custom-hooks");
    let marker = root.path().join("hook-ran.txt");
    std::fs::create_dir_all(&repo).unwrap();
    init_repo(&repo);
    install_hooks(&hooks, &marker);
    git(
        &repo,
        &["config", "core.hooksPath", hooks.to_str().unwrap()],
    );
    assert_hooks_are_live(&repo, &marker);

    std::fs::write(repo.join("b.txt"), "hello\n").unwrap();
    let outcome = run_git_action(repo.to_str().unwrap(), "first", "commit", true)
        .expect("commit succeeds despite failing hooks");
    assert!(outcome.success && outcome.committed && !outcome.pushed);
    assert!(
        !marker.exists(),
        "a core.hooksPath hook ran: {}",
        std::fs::read_to_string(&marker).unwrap_or_default()
    );
    let files = stdout(&git(&repo, &["show", "--name-only", "--format=", "HEAD"]));
    assert_eq!(files, "b.txt");
}
