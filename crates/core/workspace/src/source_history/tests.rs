use super::*;

fn files_contain(root: &Path, needle: &str) -> Vec<PathBuf> {
    let mut hits = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                stack.push(path);
            } else if std::fs::read(&path)
                .is_ok_and(|bytes| String::from_utf8_lossy(&bytes).contains(needle))
            {
                hits.push(path);
            }
        }
    }
    hits
}

/// Build a legacy Git history the way earlier builds did.
fn legacy_history(root: &Path) -> Vec<(String, SourceHistoryVersion, String)> {
    std::fs::create_dir_all(root).unwrap();
    let git = GitHistory::new(root);
    let mut written = Vec::new();
    for (path, content, label) in [
        ("workflows/flow.json", "legacy-one-marker\n", Some("First")),
        ("workflows/flow.json", "legacy-two-marker\n", None),
        (
            "agents/a/system-prompt.md",
            "legacy-agent-marker\n",
            Some("Agent saved"),
        ),
        (
            "workflows/flow.json",
            "legacy-two-marker\n",
            Some("Named only"),
        ),
    ] {
        let version = git.checkpoint(path, content, label).unwrap();
        written.push((path.to_owned(), version, content.to_owned()));
    }
    written
}

fn mark_attempted(root: &Path) {
    MIGRATION_ATTEMPTED
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap()
        .insert(root.to_path_buf());
}

#[test]
fn checkpoints_list_read_and_reject_unsafe_paths() {
    let root = tempfile::tempdir().expect("temp source history");
    let history = SourceHistory::new(root.path().join("source-history"));

    let first = history
        .checkpoint("workflows/example.json", "one\n", Some("First"))
        .expect("first checkpoint");
    let second = history
        .checkpoint("workflows/example.json", "two\n", Some("Second"))
        .expect("second checkpoint");
    let duplicate = history
        .checkpoint("workflows/example.json", "two\n", None)
        .expect("idempotent checkpoint");
    let named = history
        .checkpoint("workflows/example.json", "two\n", Some("Named"))
        .expect("named checkpoint");
    history
        .checkpoint("agents/example.json", "agent\n", Some("Other source"))
        .expect("other source checkpoint");

    assert_ne!(first.id, second.id);
    assert_eq!(first.id.len(), 40);
    assert_eq!(duplicate.id, second.id);
    assert_ne!(named.id, second.id);
    assert_eq!(
        history.read("workflows/example.json", &first.id).unwrap(),
        Some("one\n".to_owned())
    );
    assert_eq!(
        history.read("workflows/example.json", &second.id).unwrap(),
        Some("two\n".to_owned())
    );
    // A unique prefix reads like a Git abbreviation; another path's id does not.
    assert_eq!(
        history
            .read("workflows/example.json", &first.id[..7])
            .unwrap(),
        Some("one\n".to_owned())
    );
    assert_eq!(
        history.read("agents/example.json", &first.id).unwrap(),
        None
    );
    let versions = history.list("workflows/example.json", None).expect("list");
    assert_eq!(versions.len(), 3);
    assert!(versions[0]
        .label
        .as_deref()
        .is_some_and(|label| label.contains("Named")));
    assert!(history.checkpoint("../outside.json", "x", None).is_err());
    assert!(history
        .read("workflows/example.json", "not-a-commit")
        .is_err());
    assert_eq!(history.state(), SourceHistoryState::Sealed);
}

#[test]
fn content_and_labels_are_sealed_on_disk() {
    let root = tempfile::tempdir().unwrap();
    let history = SourceHistory::new(root.path().join("source-history"));
    let content = "system prompt with plaintext-marker-7731 inside";
    let version = history
        .checkpoint(
            "agents/x/system-prompt.md",
            content,
            Some("label-marker-7731"),
        )
        .unwrap();
    assert_eq!(
        history
            .read("agents/x/system-prompt.md", &version.id)
            .unwrap()
            .as_deref(),
        Some(content)
    );
    assert!(files_contain(root.path(), "plaintext-marker-7731").is_empty());
    assert!(files_contain(root.path(), "label-marker-7731").is_empty());
    // No working-tree copy and no Git objects.
    assert!(!root.path().join("source-history/.git").exists());
    assert!(!root
        .path()
        .join("source-history/agents/x/system-prompt.md")
        .exists());
}

#[test]
fn a_version_moved_to_another_row_does_not_open() {
    let root = tempfile::tempdir().unwrap();
    let history_root = root.path().join("source-history");
    let history = SourceHistory::new(history_root.clone());
    let a = history.checkpoint("a.md", "alpha", None).unwrap();
    let b = history.checkpoint("b.md", "beta", None).unwrap();
    let conn = Connection::open(history_root.join(HISTORY_DB_FILE)).unwrap();
    conn.execute(
        "UPDATE versions SET content = (SELECT content FROM versions WHERE id = ?1)
         WHERE id = ?2",
        params![a.id, b.id],
    )
    .unwrap();
    drop(conn);
    assert!(history.read("b.md", &b.id).is_err());
    assert_eq!(
        history.read("a.md", &a.id).unwrap().as_deref(),
        Some("alpha")
    );
}

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
fn many_edits_of_a_large_document_stay_small_and_are_capped() {
    let root = tempfile::tempdir().unwrap();
    let history_root = root.path().join("source-history");
    let history = SourceHistory::new(history_root.clone());
    // About 100 KB of prose-like text from a small vocabulary.
    let words = [
        "plan", "agent", "workflow", "review", "draft", "space", "note", "model", "task", "result",
        "context", "change", "summary", "update", "source", "version",
    ];
    let mut state = 0x2545_f491_u64;
    let mut base = String::new();
    while base.len() < 100 * 1024 {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        base.push_str(words[(state >> 33) as usize % words.len()]);
        base.push(if (state >> 20) % 11 == 0 { '\n' } else { ' ' });
    }
    for edit in 0..100 {
        let content = format!("{base}\nedit {edit}\n");
        history
            .checkpoint("spaces/s/documents/d.md", &content, None)
            .unwrap();
    }
    let db_bytes = std::fs::metadata(history_root.join(HISTORY_DB_FILE))
        .unwrap()
        .len();
    // 100 raw copies are 10 MB; compressed-then-sealed rows stay under 4 MiB.
    assert!(db_bytes < 4 * 1024 * 1024, "history.db is {db_bytes} bytes");
    assert_eq!(
        history
            .list("spaces/s/documents/d.md", Some(1000))
            .unwrap()
            .len(),
        100
    );
}

#[test]
fn retention_keeps_the_newest_versions_per_path() {
    let root = tempfile::tempdir().unwrap();
    let history =
        SourceHistory::new(root.path().join("source-history")).with_retention(Retention {
            keep_newest: 5,
            max_age_days: 365,
            keep_after_age: 2,
        });
    let mut ids = Vec::new();
    for n in 0..8 {
        ids.push(
            history
                .checkpoint("a.md", &format!("v{n}"), None)
                .unwrap()
                .id,
        );
    }
    history.checkpoint("b.md", "other", None).unwrap();
    let kept = history.list("a.md", Some(1000)).unwrap();
    assert_eq!(kept.len(), 5);
    assert_eq!(kept[0].id, ids[7]);
    assert_eq!(history.read("a.md", &ids[0]).unwrap(), None);
    assert_eq!(history.list("b.md", None).unwrap().len(), 1);

    // Old versions beyond `keep_after_age` are pruned by age.
    let conn = Connection::open(root.path().join("source-history").join(HISTORY_DB_FILE)).unwrap();
    conn.execute(
        "UPDATE versions SET created_at = created_at - ?1 * 400 WHERE path = 'a.md'",
        [DAY_MS],
    )
    .unwrap();
    drop(conn);
    history.checkpoint("a.md", "fresh", None).unwrap();
    // The fresh version (rank 1) and the newest old one (rank 2) survive.
    let kept = history.list("a.md", Some(1000)).unwrap();
    assert_eq!(kept.len(), 2);
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

#[test]
fn imported_versions_keep_their_time_label_and_id_and_are_sealed() {
    let root = tempfile::tempdir().unwrap();
    let history = SourceHistory::new(root.path().join("source-history"));
    let path = "skills/s/SKILL.md";
    let created_at = now_ms() - 5 * DAY_MS;
    let legacy_id = "0f8b2c4e-1a2b-4c3d-8e9f-0123456789ab";
    let content = "legacy skill import-marker-5521";
    let version = history
        .import_version(path, Some(legacy_id), created_at, Some("import-label-5521"), content)
        .unwrap();
    assert_eq!(version.id, "0f8b2c4e1a2b4c3d8e9f0123456789ab");
    assert_eq!(version.created_at, created_at);
    assert_eq!(version.label.as_deref(), Some("import-label-5521"));
    // Idempotent for the same id and bytes.
    let again = history
        .import_version(path, Some(legacy_id), created_at, Some("import-label-5521"), content)
        .unwrap();
    assert_eq!(again, version);
    assert_eq!(history.list(path, None).unwrap(), vec![version.clone()]);
    assert_eq!(
        history.read(path, &version.id).unwrap().as_deref(),
        Some(content)
    );
    // Same id, different bytes: refused rather than silently ignored.
    assert!(history
        .import_version(path, Some(legacy_id), created_at, None, "other bytes")
        .is_err());
    // A non-hex id gets a fresh one.
    let minted = history
        .import_version(path, Some("not-a-hex-id!"), created_at, None, "second")
        .unwrap();
    assert!(validate_version_id(&minted.id).is_ok());
    assert!(files_contain(root.path(), "import-marker-5521").is_empty());
    assert!(files_contain(root.path(), "import-label-5521").is_empty());
}

#[test]
fn import_is_refused_while_the_legacy_git_history_still_serves() {
    let root = tempfile::tempdir().unwrap();
    let history_root = root.path().join("source-history");
    legacy_history(&history_root);
    mark_attempted(&history_root);
    let history = SourceHistory::new(history_root);
    assert!(history
        .import_version("skills/s/SKILL.md", None, 1, None, "body")
        .is_err());
}
