use std::path::Path;
use std::process::Command;

use super::*;
use crate::git::pull_request::commit_staged_for_pull_request;
use crate::git::{initialize_repository, run_git_action};

const NEW_GIT: Option<(u32, u32)> = Some((2, 45));

fn git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgSign=false",
        ])
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("spawn git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// A repository with one commit and one uncommitted file.
fn repo_with_pending_change() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    initialize_repository(dir.path().to_str().unwrap()).unwrap();
    git(dir.path(), &["config", "user.name", "Ryu Test"]);
    git(
        dir.path(),
        &["config", "user.email", "ryu-test@example.com"],
    );
    git(dir.path(), &["config", "commit.gpgSign", "false"]);
    std::fs::write(dir.path().join("README.md"), "one\n").unwrap();
    git(dir.path(), &["add", "README.md"]);
    git(dir.path(), &["commit", "-m", "init"]);
    std::fs::write(dir.path().join("notes.md"), "notes\n").unwrap();
    dir
}

fn last_message(cwd: &Path) -> String {
    git(cwd, &["log", "-1", "--format=%B"])
}

/// What a credited commit of `message` reads as on this machine: with the
/// trailer on a Git that has `commit --trailer`, unchanged on an older one.
fn credited(message: &str) -> String {
    if installed_git_version().is_some_and(|version| version >= GIT_COMMIT_TRAILER_MIN) {
        format!("{message}\n\n{RYU_COAUTHOR_TRAILER}")
    } else {
        message.to_string()
    }
}

#[test]
fn credit_is_on_unless_the_preference_says_false() {
    assert!(DEFAULT_GIT_CREDIT_RYU);
    assert!(git_credit_ryu(None));
    assert!(git_credit_ryu(Some("")));
    assert!(git_credit_ryu(Some("not-a-boolean")));
    assert!(git_credit_ryu(Some(" TRUE ")));
    assert!(!git_credit_ryu(Some("false")));
    assert!(!git_credit_ryu(Some(" False ")));
}

#[test]
fn the_trailer_is_a_github_co_author_line() {
    assert_eq!(
        RYU_COAUTHOR_TRAILER,
        "Co-authored-by: Ryu <amajorhq@gmail.com>"
    );
}

#[test]
fn commit_arguments_gain_the_trailer_only_when_credit_is_on() {
    let commit = ["commit", "--no-verify", "-m", "Add notes"];
    assert_eq!(
        credited_commit_args_for(&commit, true, NEW_GIT),
        vec![
            "-c",
            "trailer.ifexists=addIfDifferent",
            "commit",
            "--no-verify",
            "-m",
            "Add notes",
            "--trailer",
            RYU_COAUTHOR_TRAILER,
        ]
    );
    assert_eq!(credited_commit_args_for(&commit, false, NEW_GIT), commit);
}

#[test]
fn a_git_without_commit_trailer_support_commits_without_credit() {
    let commit = ["commit", "-m", "Add notes"];
    assert_eq!(
        credited_commit_args_for(&commit, true, Some((2, 31))),
        commit
    );
    assert_eq!(credited_commit_args_for(&commit, true, None), commit);
    assert_eq!(
        credited_commit_args_for(&commit, true, Some(GIT_COMMIT_TRAILER_MIN)).len(),
        commit.len() + 4
    );
}

#[test]
fn commit_action_credits_ryu_when_the_setting_is_on() {
    let dir = repo_with_pending_change();
    let path = dir.path().to_str().unwrap();

    let outcome = run_git_action(path, "Add notes", "commit", true, true).unwrap();

    assert!(outcome.committed);
    assert_eq!(last_message(dir.path()), credited("Add notes"));
}

#[test]
fn commit_action_adds_no_trailer_when_the_setting_is_off() {
    let dir = repo_with_pending_change();
    let path = dir.path().to_str().unwrap();

    let outcome = run_git_action(path, "Add notes", "commit", true, false).unwrap();

    assert!(outcome.committed);
    assert_eq!(last_message(dir.path()), "Add notes");
}

#[test]
fn a_message_that_already_credits_ryu_is_not_credited_twice() {
    let dir = repo_with_pending_change();
    let path = dir.path().to_str().unwrap();
    let message = format!("Add notes\n\n{RYU_COAUTHOR_TRAILER}");

    run_git_action(path, &message, "commit", true, true).unwrap();

    let committed = last_message(dir.path());
    assert_eq!(committed, message);
    assert_eq!(committed.matches(RYU_COAUTHOR_TRAILER).count(), 1);
}

#[test]
fn the_trailer_joins_trailers_already_in_the_message() {
    let dir = repo_with_pending_change();
    let path = dir.path().to_str().unwrap();
    let message = "Add notes\n\nSigned-off-by: Dev <dev@example.com>";

    run_git_action(path, message, "commit", true, true).unwrap();

    let expected =
        if installed_git_version().is_some_and(|version| version >= GIT_COMMIT_TRAILER_MIN) {
            format!("{message}\n{RYU_COAUTHOR_TRAILER}")
        } else {
            message.to_string()
        };
    assert_eq!(last_message(dir.path()), expected);
}

#[test]
fn the_pull_request_commit_follows_the_setting() {
    let on = repo_with_pending_change();
    git(on.path(), &["add", "-A"]);
    commit_staged_for_pull_request(on.path().to_str().unwrap(), Some("Add notes"), true).unwrap();
    assert_eq!(last_message(on.path()), credited("Add notes"));

    let off = repo_with_pending_change();
    git(off.path(), &["add", "-A"]);
    commit_staged_for_pull_request(off.path().to_str().unwrap(), None, false).unwrap();
    assert_eq!(last_message(off.path()), "Update via Ryu");
}

#[test]
fn the_pull_request_commit_is_skipped_when_nothing_is_staged() {
    let dir = repo_with_pending_change();
    commit_staged_for_pull_request(dir.path().to_str().unwrap(), Some("Add notes"), true).unwrap();
    assert_eq!(last_message(dir.path()), "init");
}
