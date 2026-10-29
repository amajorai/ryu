//! User-supplied worktree / handoff branch names: sanitization rules and the
//! collision suffix in `create_worktree_in`.

use std::path::Path;
use std::process::Command;

use crate::worktree::{create_worktree_in, sanitize_branch_name};

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

fn init_repo(dir: &Path) {
    git(dir, &["init", "-b", "main"]);
    git(dir, &["config", "user.email", "test@ryu"]);
    git(dir, &["config", "user.name", "Test"]);
    std::fs::write(dir.join("README"), "init").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-m", "init"]);
}

#[test]
fn sanitize_maps_whitespace_and_drops_forbidden_characters() {
    let cases = [
        ("my feature branch", "my-feature-branch"),
        ("  padded name\t", "padded-name"),
        ("tab\there", "tab-here"),
        ("feat~^:?*[\\x", "featx"),
        ("a@{b}<c>|d\"e'", "abcde"),
        ("café/ünïcode", "caf/ncode"),
        ("handoff/thread-1", "handoff/thread-1"),
        ("snake_case.v2", "snake_case.v2"),
    ];
    for (raw, expected) in cases {
        assert_eq!(
            sanitize_branch_name(raw).as_deref(),
            Some(expected),
            "input {raw:?}"
        );
    }
}

#[test]
fn sanitize_collapses_dot_runs_and_trims_separators() {
    let cases = [
        ("a..b", "a.b"),
        ("a...b....c", "a.b.c"),
        ("/leading/slash", "leading/slash"),
        ("trailing/", "trailing"),
        (".hidden", "hidden"),
        ("-dash-", "dash"),
        ("/.-mixed/x-./", "mixed/x"),
        ("v1..~..2", "v1.2"),
    ];
    for (raw, expected) in cases {
        assert_eq!(
            sanitize_branch_name(raw).as_deref(),
            Some(expected),
            "input {raw:?}"
        );
    }
}

#[test]
fn sanitize_rejects_input_with_nothing_usable() {
    for raw in ["", "   ", "\t\n", "~^:?*", "../..", "/-./", "@{}"] {
        assert_eq!(sanitize_branch_name(raw), None, "input {raw:?}");
    }
}

#[test]
fn unusable_name_falls_back_to_an_auto_run_branch() {
    let tmp = tempfile::tempdir().unwrap();
    init_repo(tmp.path());
    let guard = create_worktree_in(tmp.path(), Some("~^:?*")).expect("create");
    let suffix = guard
        .branch
        .strip_prefix("ryu/run-")
        .unwrap_or_else(|| panic!("unexpected branch {}", guard.branch));
    assert!(uuid::Uuid::parse_str(suffix).is_ok(), "suffix {suffix}");
}

#[test]
fn sanitized_name_is_used_for_the_worktree_branch() {
    let tmp = tempfile::tempdir().unwrap();
    init_repo(tmp.path());
    let guard = create_worktree_in(tmp.path(), Some(" fix: the  bug.. ")).expect("create");
    assert_eq!(guard.branch, "fix-the--bug");
    assert_eq!(
        git(&guard.path, &["branch", "--show-current"]),
        guard.branch
    );
}

#[test]
fn existing_branch_name_gets_a_short_suffix_instead_of_failing() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_repo(repo);
    git(repo, &["branch", "handoff/thread-1"]);
    let original_tip = git(repo, &["rev-parse", "handoff/thread-1"]);

    // Sanitizes to the taken `handoff/thread-1`.
    let guard = create_worktree_in(repo, Some("handoff/thread 1")).expect("create on a taken name");
    let suffix = guard
        .branch
        .strip_prefix("handoff/thread-1-")
        .unwrap_or_else(|| panic!("unexpected branch {}", guard.branch));
    assert_eq!(suffix.len(), 8, "suffix {suffix}");
    assert!(
        suffix.chars().all(|c| c.is_ascii_hexdigit()),
        "suffix {suffix}"
    );
    assert_eq!(
        git(&guard.path, &["branch", "--show-current"]),
        guard.branch
    );
    assert_eq!(
        git(repo, &["rev-parse", "handoff/thread-1"]),
        original_tip,
        "the existing branch is left untouched"
    );
}
