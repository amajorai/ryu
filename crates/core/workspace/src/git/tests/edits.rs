//! Reversing text edits and scoped per-file diffs.

use super::*;

fn initialize_reverse_repo(path: &std::path::Path) {
    test_git(path, &["init"]);
    test_git(path, &["config", "user.name", "Ryu Test"]);
    test_git(path, &["config", "user.email", "ryu-test@example.com"]);
    std::fs::write(path.join("first.txt"), "alpha\none\nomega\n").unwrap();
    std::fs::write(path.join("second.txt"), "left\nright\n").unwrap();
    test_git(path, &["add", "first.txt", "second.txt"]);
    test_git(path, &["commit", "-m", "initial"]);
}

#[test]
fn reverse_text_edits_preserves_unrelated_changes_and_reverses_in_order() {
    let dir = tempfile::tempdir().unwrap();
    initialize_reverse_repo(dir.path());
    std::fs::write(
        dir.path().join("first.txt"),
        "user note\nalpha\nthree\nomega\n",
    )
    .unwrap();

    let result = reverse_text_edits(
        dir.path().to_str().unwrap(),
        &[
            TextReplacement {
                after: "two".to_string(),
                before: "one".to_string(),
                path: "first.txt".to_string(),
            },
            TextReplacement {
                after: "three".to_string(),
                before: "two".to_string(),
                path: "first.txt".to_string(),
            },
        ],
    )
    .unwrap();

    assert_eq!(
        result,
        ReverseEditsOutcome::Applied {
            paths: vec!["first.txt".to_string()]
        }
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("first.txt")).unwrap(),
        "user note\nalpha\none\nomega\n"
    );
}

#[test]
fn reverse_text_edits_conflicts_without_writing_any_file() {
    let dir = tempfile::tempdir().unwrap();
    initialize_reverse_repo(dir.path());
    std::fs::write(
        dir.path().join("first.txt"),
        "alpha\nchanged later\nomega\n",
    )
    .unwrap();
    std::fs::write(dir.path().join("second.txt"), "LEFT\nright\n").unwrap();

    let result = reverse_text_edits(
        dir.path().to_str().unwrap(),
        &[
            TextReplacement {
                after: "changed by agent".to_string(),
                before: "one".to_string(),
                path: "first.txt".to_string(),
            },
            TextReplacement {
                after: "LEFT".to_string(),
                before: "left".to_string(),
                path: "second.txt".to_string(),
            },
        ],
    )
    .unwrap();

    assert_eq!(
        result,
        ReverseEditsOutcome::Conflict {
            paths: vec!["first.txt".to_string()],
            reason: ReverseEditsConflictReason::ChangedSinceTurn,
        }
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("second.txt")).unwrap(),
        "LEFT\nright\n"
    );
}

#[test]
fn reverse_text_edits_rejects_staged_targets() {
    let dir = tempfile::tempdir().unwrap();
    initialize_reverse_repo(dir.path());
    std::fs::write(dir.path().join("first.txt"), "alpha\ntwo\nomega\n").unwrap();
    test_git(dir.path(), &["add", "first.txt"]);

    let result = reverse_text_edits(
        dir.path().to_str().unwrap(),
        &[TextReplacement {
            after: "two".to_string(),
            before: "one".to_string(),
            path: "first.txt".to_string(),
        }],
    )
    .unwrap();

    assert_eq!(
        result,
        ReverseEditsOutcome::Conflict {
            paths: vec!["first.txt".to_string()],
            reason: ReverseEditsConflictReason::StagedChanges,
        }
    );
}

#[test]
fn reverse_text_edits_rejects_ambiguous_binary_and_escaping_paths() {
    let dir = tempfile::tempdir().unwrap();
    initialize_reverse_repo(dir.path());
    std::fs::write(dir.path().join("first.txt"), "two and two\n").unwrap();
    let ambiguous = reverse_text_edits(
        dir.path().to_str().unwrap(),
        &[TextReplacement {
            after: "two".to_string(),
            before: "one".to_string(),
            path: "first.txt".to_string(),
        }],
    )
    .unwrap();
    assert_eq!(
        ambiguous,
        ReverseEditsOutcome::Conflict {
            paths: vec!["first.txt".to_string()],
            reason: ReverseEditsConflictReason::ChangedSinceTurn,
        }
    );

    std::fs::write(dir.path().join("first.txt"), [0xff, 0x00]).unwrap();
    let binary = reverse_text_edits(
        dir.path().to_str().unwrap(),
        &[TextReplacement {
            after: "two".to_string(),
            before: "one".to_string(),
            path: "first.txt".to_string(),
        }],
    )
    .unwrap();
    assert_eq!(
        binary,
        ReverseEditsOutcome::Conflict {
            paths: vec!["first.txt".to_string()],
            reason: ReverseEditsConflictReason::UnsupportedFile,
        }
    );

    let escaped = reverse_text_edits(
        dir.path().to_str().unwrap(),
        &[TextReplacement {
            after: "new".to_string(),
            before: "old".to_string(),
            path: "../outside.txt".to_string(),
        }],
    )
    .unwrap_err();
    assert!(escaped.contains("inside the repository"));
}

#[test]
fn query_file_diff_is_scoped_and_includes_untracked_text() {
    let dir = tempfile::tempdir().unwrap();
    initialize_reverse_repo(dir.path());
    std::fs::write(dir.path().join("first.txt"), "alpha\nTWO\nomega\n").unwrap();
    std::fs::write(dir.path().join("untracked.txt"), "new\nlines\n").unwrap();
    std::fs::write(dir.path().join("second.txt"), "changed but excluded\n").unwrap();

    let diff = query_file_diff(
        dir.path().to_str().unwrap(),
        &["first.txt".to_string(), "untracked.txt".to_string()],
    )
    .unwrap();

    assert_eq!(diff.paths, vec!["first.txt", "untracked.txt"]);
    assert!(diff.patch.contains("first.txt"));
    assert!(diff.patch.contains("+TWO"));
    assert!(diff.patch.contains("new file mode"));
    assert!(diff.patch.contains("+lines"));
    assert!(!diff.patch.contains("second.txt"));
}
