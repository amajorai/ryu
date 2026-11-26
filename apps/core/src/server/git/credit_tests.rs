use std::path::Path;
use std::process::Command;

use axum::http::StatusCode;
use ryu_workspace::git::{GIT_CREDIT_RYU_PREF_KEY, RYU_COAUTHOR_TRAILER};

use super::super::repo_actions::commit_push;
use super::super::tests::body_json;
use super::super::GitCommitPushBody;
use super::git_credit_enabled;
use crate::server::preferences::PreferencesStore;

fn store(directory: &tempfile::TempDir) -> PreferencesStore {
    PreferencesStore::open(directory.path().join("preferences.db")).expect("preferences store")
}

#[tokio::test]
async fn a_node_that_never_saved_the_preference_credits_ryu() {
    let directory = tempfile::tempdir().expect("temp dir");
    assert!(git_credit_enabled(&store(&directory)).await);
}

#[tokio::test]
async fn the_saved_preference_turns_credit_off_and_back_on() {
    let directory = tempfile::tempdir().expect("temp dir");
    let preferences = store(&directory);

    preferences
        .set(GIT_CREDIT_RYU_PREF_KEY, "false")
        .await
        .expect("save off");
    assert!(!git_credit_enabled(&preferences).await);

    preferences
        .set(GIT_CREDIT_RYU_PREF_KEY, "true")
        .await
        .expect("save on");
    assert!(git_credit_enabled(&preferences).await);
}

#[tokio::test]
async fn an_unrecognized_saved_value_keeps_credit_on() {
    let directory = tempfile::tempdir().expect("temp dir");
    let preferences = store(&directory);
    preferences
        .set(GIT_CREDIT_RYU_PREF_KEY, "maybe")
        .await
        .expect("save");
    assert!(git_credit_enabled(&preferences).await);
}

fn git(cwd: &Path, args: &[&str]) -> String {
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
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// `git commit --trailer` arrived in Git 2.32; an older Git commits without
/// the trailer.
fn git_has_commit_trailer(cwd: &Path) -> bool {
    let help = Command::new("git")
        .args(["commit", "-h"])
        .current_dir(cwd)
        .output()
        .expect("spawn git");
    let text = [help.stdout, help.stderr].concat();
    String::from_utf8_lossy(&text).contains("--trailer")
}

/// Change one file, commit it through the commit handler with the node's
/// preference store, and return the message of the commit it made.
async fn commit_through_handler(
    repo: &Path,
    preferences: &PreferencesStore,
    file: &str,
    message: &str,
) -> String {
    std::fs::write(repo.join(file), "change\n").expect("write file");
    let body = GitCommitPushBody {
        cwd: repo.to_string_lossy().into_owned(),
        message: Some(message.to_string()),
        action: Some("commit".to_string()),
        include_unstaged: true,
    };
    let (status, json) = body_json(commit_push(body, Some(preferences)).await).await;
    assert_eq!(status, StatusCode::OK, "commit failed: {json}");
    assert_eq!(json["committed"], true);
    git(repo, &["log", "-1", "--format=%B"])
}

#[tokio::test]
async fn the_commit_handler_credits_ryu_unless_the_node_turned_it_off() {
    let home = tempfile::tempdir().expect("temp dir");
    let preferences = store(&home);
    let directory = tempfile::tempdir().expect("repo dir");
    let repo = directory.path();
    git(repo, &["init", "-q"]);
    git(repo, &["config", "user.name", "Ryu Test"]);
    git(repo, &["config", "user.email", "ryu-test@example.com"]);
    git(repo, &["config", "commit.gpgSign", "false"]);
    let credited = |message: &str| {
        if git_has_commit_trailer(repo) {
            format!("{message}\n\n{RYU_COAUTHOR_TRAILER}")
        } else {
            message.to_string()
        }
    };

    // Never saved: on.
    let first = commit_through_handler(repo, &preferences, "a.txt", "Add a").await;
    assert_eq!(first, credited("Add a"));

    preferences
        .set(GIT_CREDIT_RYU_PREF_KEY, "false")
        .await
        .expect("save off");
    let second = commit_through_handler(repo, &preferences, "b.txt", "Add b").await;
    assert_eq!(second, "Add b");

    preferences
        .set(GIT_CREDIT_RYU_PREF_KEY, "true")
        .await
        .expect("save on");
    let third = commit_through_handler(repo, &preferences, "c.txt", "Add c").await;
    assert_eq!(third, credited("Add c"));
}
