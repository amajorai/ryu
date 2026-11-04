//! Importing the legacy Git history into the sealed store, and what is
//! reported when that import cannot finish.

use super::*;

#[test]
fn legacy_git_history_is_imported_with_its_ids_and_removed() {
    let root = tempfile::tempdir().unwrap();
    let history_root = root.path().join("source-history");
    let legacy = legacy_history(&history_root);
    // The working tree holds the latest version in the clear (Git objects are
    // only zlib-compressed).
    assert!(!files_contain(&history_root, "legacy-two-marker").is_empty());

    let history = SourceHistory::new(history_root.clone());
    // The first call imports the repository.
    let versions = history.list("workflows/flow.json", None).unwrap();
    assert_eq!(history.state(), SourceHistoryState::Sealed);
    assert_eq!(versions.len(), 3);
    assert_eq!(versions[0].label.as_deref(), Some("Named only"));
    for (path, version, content) in &legacy {
        // Full commit ids and Git-style abbreviations keep working.
        assert_eq!(
            history.read(path, &version.id).unwrap().as_deref(),
            Some(content.as_str())
        );
        assert_eq!(
            history.read(path, &version.id[..7]).unwrap().as_deref(),
            Some(content.as_str())
        );
    }
    assert_eq!(
        history.list("agents/a/system-prompt.md", None).unwrap()[0]
            .label
            .as_deref(),
        Some("Agent saved")
    );
    // Git objects and working-tree copies are gone; nothing readable remains.
    assert!(!history_root.join(".git").exists());
    for marker in [
        "legacy-one-marker",
        "legacy-two-marker",
        "legacy-agent-marker",
    ] {
        assert!(files_contain(&history_root, marker).is_empty(), "{marker}");
    }
    // Unchanged content still returns the latest imported version.
    let latest = history
        .checkpoint("workflows/flow.json", "legacy-two-marker\n", None)
        .unwrap();
    assert_eq!(latest.id, versions[0].id);

    // A second import attempt changes nothing.
    let count = |root: &Path| -> i64 {
        Connection::open(root.join(HISTORY_DB_FILE))
            .unwrap()
            .query_row("SELECT COUNT(*) FROM versions", [], |row| row.get(0))
            .unwrap()
    };
    let before = count(&history_root);
    history.migrate_from_git(|| {}).unwrap();
    assert_eq!(count(&history_root), before);
}

#[test]
fn a_checkpoint_made_during_the_import_is_not_lost() {
    let root = tempfile::tempdir().unwrap();
    let history_root = root.path().join("source-history");
    legacy_history(&history_root);
    let history = SourceHistory::new(history_root.clone());
    // Another caller's import is in flight, so this process's calls use Git.
    mark_attempted(&history_root);
    let mut concurrent = None;
    history
        .migrate_from_git(|| {
            let version = history
                .checkpoint(
                    "workflows/flow.json",
                    "written-during-import\n",
                    Some("Late"),
                )
                .unwrap();
            concurrent = Some(version);
        })
        .unwrap();
    let concurrent = concurrent.unwrap();
    assert_eq!(
        history
            .read("workflows/flow.json", &concurrent.id)
            .unwrap()
            .as_deref(),
        Some("written-during-import\n")
    );
    assert_eq!(
        history.list("workflows/flow.json", Some(1)).unwrap()[0].id,
        concurrent.id
    );
    assert!(!history_root.join(".git").exists());
}

#[test]
fn a_git_history_restored_after_the_migration_is_imported_not_dropped() {
    let root = tempfile::tempdir().unwrap();
    let history_root = root.path().join("source-history");
    let legacy = legacy_history(&history_root);
    let history = SourceHistory::new(history_root.clone());
    history.list("workflows/flow.json", None).unwrap();
    assert!(!history_root.join(".git").exists());

    // An older build (a restored export or a downgrade) writes Git history
    // into the migrated folder again.
    let restored = GitHistory::new(&history_root)
        .checkpoint("workflows/flow.json", "restored-marker\n", Some("Restored"))
        .unwrap();
    assert!(history_root.join(".git").exists());

    // The next call imports it before removing the repository.
    assert_eq!(
        history
            .read("workflows/flow.json", &restored.id)
            .unwrap()
            .as_deref(),
        Some("restored-marker\n")
    );
    assert!(!history_root.join(".git").exists());
    assert!(files_contain(&history_root, "restored-marker").is_empty());
    for (path, version, content) in &legacy {
        assert_eq!(
            history.read(path, &version.id).unwrap().as_deref(),
            Some(content.as_str())
        );
    }
}

#[test]
fn plaintext_leftovers_without_git_are_removed_on_a_later_call() {
    let root = tempfile::tempdir().unwrap();
    let history_root = root.path().join("source-history");
    legacy_history(&history_root);
    let history = SourceHistory::new(history_root.clone());
    history.list("workflows/flow.json", None).unwrap();
    // A working-tree copy whose delete failed after `.git` was gone.
    let stray = history_root.join("agents/a/system-prompt.md");
    std::fs::create_dir_all(stray.parent().unwrap()).unwrap();
    std::fs::write(&stray, "leftover-plaintext-marker\n").unwrap();

    history.list("workflows/flow.json", None).unwrap();
    assert!(files_contain(&history_root, "leftover-plaintext-marker").is_empty());
    assert!(history_root.join(HISTORY_DB_FILE).is_file());
}

#[test]
fn an_import_that_fails_stays_on_git_and_reports_why() {
    let root = tempfile::tempdir().unwrap();
    let history_root = root.path().join("source-history");
    legacy_history(&history_root);
    // Lose one stored file version, as a damaged repository would: the import
    // cannot read it back, so it must not flip the store or delete `.git`.
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD:agents/a/system-prompt.md"])
        .current_dir(&history_root)
        .output()
        .unwrap();
    let blob = String::from_utf8(output.stdout).unwrap().trim().to_owned();
    assert_eq!(blob.len(), 40, "blob id of the agent prompt");
    std::fs::remove_file(
        history_root
            .join(".git/objects")
            .join(&blob[..2])
            .join(&blob[2..]),
    )
    .unwrap();

    let history = SourceHistory::new(history_root.clone());
    match history.migrate_and_report() {
        SourceHistoryState::LegacyGit(reason) => {
            assert!(!reason.is_empty());
            assert_ne!(
                reason, "the Git history has not been imported yet",
                "the recorded import error is reported"
            );
        }
        SourceHistoryState::Sealed => panic!("a failed import must not report sealed"),
    }
    assert!(history_root.join(".git").is_dir(), "Git history is kept");
    // The state stays reported without another import attempt.
    assert!(matches!(history.state(), SourceHistoryState::LegacyGit(_)));
}

#[test]
fn a_restored_git_that_fails_to_reimport_is_reported_not_sealed() {
    let root = tempfile::tempdir().unwrap();
    let history_root = root.path().join("source-history");
    legacy_history(&history_root);
    let history = SourceHistory::new(history_root.clone());
    assert_eq!(history.migrate_and_report(), SourceHistoryState::Sealed);
    assert!(!history_root.join(".git").exists());

    // An older build writes Git history into the migrated folder again, and
    // that repository is damaged, so the re-import cannot verify it.
    GitHistory::new(&history_root)
        .checkpoint(
            "notes/restored.md",
            "restored-damaged-marker\n",
            Some("Restored"),
        )
        .unwrap();
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD:notes/restored.md"])
        .current_dir(&history_root)
        .output()
        .unwrap();
    let blob = String::from_utf8(output.stdout).unwrap().trim().to_owned();
    assert_eq!(blob.len(), 40, "blob id of the restored note");
    std::fs::remove_file(
        history_root
            .join(".git/objects")
            .join(&blob[..2])
            .join(&blob[2..]),
    )
    .unwrap();

    match history.migrate_and_report() {
        SourceHistoryState::LegacyGit(reason) => assert!(!reason.is_empty()),
        SourceHistoryState::Sealed => {
            panic!("a migrated root with a surviving plaintext .git must not report sealed")
        }
    }
    assert!(
        history_root.join(".git").is_dir(),
        "the restored history is kept"
    );
}

#[test]
fn a_migrated_root_with_plaintext_leftovers_is_reported_not_sealed() {
    let root = tempfile::tempdir().unwrap();
    let history_root = root.path().join("source-history");
    legacy_history(&history_root);
    let history = SourceHistory::new(history_root.clone());
    assert_eq!(history.migrate_and_report(), SourceHistoryState::Sealed);

    // A working-tree copy that could not be removed (the removal is not
    // retried again in this process).
    mark_attempted(&history_root);
    let stray = history_root.join("agents/a/system-prompt.md");
    std::fs::create_dir_all(stray.parent().unwrap()).unwrap();
    std::fs::write(&stray, "leftover-plaintext-marker\n").unwrap();

    match history.migrate_and_report() {
        SourceHistoryState::LegacyGit(reason) => {
            assert!(reason.contains("still present"), "{reason}");
        }
        SourceHistoryState::Sealed => {
            panic!("plaintext leftovers beside a migrated store must not report sealed")
        }
    }
    assert!(stray.is_file());
}
