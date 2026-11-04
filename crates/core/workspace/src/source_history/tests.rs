use super::*;

mod migration;

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
fn imported_versions_keep_their_time_label_and_id_and_are_sealed() {
    let root = tempfile::tempdir().unwrap();
    let history = SourceHistory::new(root.path().join("source-history"));
    let path = "skills/s/SKILL.md";
    let created_at = now_ms() - 5 * DAY_MS;
    let legacy_id = "0f8b2c4e-1a2b-4c3d-8e9f-0123456789ab";
    let content = "legacy skill import-marker-5521";
    let version = history
        .import_version(
            path,
            Some(legacy_id),
            created_at,
            Some("import-label-5521"),
            content,
        )
        .unwrap();
    assert_eq!(version.id, "0f8b2c4e1a2b4c3d8e9f0123456789ab");
    assert_eq!(version.created_at, created_at);
    assert_eq!(version.label.as_deref(), Some("import-label-5521"));
    // Idempotent for the same id and bytes.
    let again = history
        .import_version(
            path,
            Some(legacy_id),
            created_at,
            Some("import-label-5521"),
            content,
        )
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
