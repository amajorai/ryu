//! The task worktree and its diff run `git` in the owner's checkout. Programs
//! that checkout's own configuration names must not start (finding CE-1, the
//! cloud task runner).

use super::*;
use crate::server::subscription_cloud::CloudTaskBackend;
use std::process::Command;

/// Plain `git`, as the owner's own shell would run it.
fn plain_git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn record(workspace: &Path, branch: &str) -> RunRecord {
    RunRecord {
        conversation_id: "ce1b-conversation".into(),
        owner: "node-owner".into(),
        backend: CloudTaskBackend::AnthropicSubscriptionSdk,
        environment_id: "env-1".into(),
        executor: "node".into(),
        account_id: None,
        external_id: None,
        url: None,
        status: "done".into(),
        summary: None,
        last_error: None,
        output_tail: None,
        workspace: Some(workspace.to_string_lossy().into_owned()),
        branch: Some(branch.to_owned()),
        created_at: 0,
        updated_at: 0,
        result_posted: false,
    }
}

#[tokio::test]
async fn a_checkout_s_own_programs_do_not_run_for_the_task_worktree_or_its_diff() {
    let checkout = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let marker = outside.path().join("ran");
    let shell_marker = marker.to_string_lossy().replace('\\', "/");
    let dir = checkout.path();
    plain_git(dir, &["init", "-q", "-b", "main"]);
    plain_git(dir, &["config", "user.name", "Ryu Test"]);
    plain_git(dir, &["config", "user.email", "ryu-test@example.com"]);
    plain_git(dir, &["config", "commit.gpgSign", "false"]);
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    plain_git(dir, &["add", "a.txt"]);
    plain_git(dir, &["commit", "-q", "-m", "init"]);
    // Programs named by the checkout's own configuration and hooks.
    let monitor = format!("touch '{shell_marker}'; false");
    plain_git(dir, &["config", "core.fsmonitor", &monitor]);
    let external = format!("touch '{shell_marker}'; true");
    plain_git(dir, &["config", "diff.external", &external]);
    let hooks = dir.join(".git").join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    std::fs::write(
        hooks.join("post-checkout"),
        format!("#!/bin/sh\ntouch '{shell_marker}'\n"),
    )
    .unwrap();

    set_worktree_root_for_test(Some(root.path().to_path_buf()));
    let made = ensure_worktree(dir, "ce1b-conversation").await;
    set_worktree_root_for_test(None);
    let (workspace, branch) = made.expect("worktree");
    assert!(!marker.exists(), "making the worktree started a program");

    std::fs::write(workspace.join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(workspace.join("new.txt"), "new\n").unwrap();
    let changes = diff(&record(&workspace, &branch)).await.expect("diff");
    assert!(!marker.exists(), "the diff started a program");
    assert_eq!(changes.files.len(), 2, "{:?}", changes.files);
    assert!(changes.patch.contains("+two"));
    assert!(changes.patch.contains("+new"));
    assert!(!changes.truncated);

    // Control: plain git in the same worktree does start the planted program,
    // so the assertions above fail without the hardened builder.
    plain_git(&workspace, &["status", "--porcelain"]);
    assert!(marker.exists(), "the fixture's program never runs");
}
