//! Actual bounded filesystem scan -> production import handler -> reopened SQLite.
use super::*;
#[tokio::test]
async fn edited_and_restored_same_locator_refreshes_the_persisted_instruction_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    std::fs::create_dir_all(&source).unwrap();
    let source = source.canonicalize().unwrap();
    let path = source.join("CLAUDE.md");
    let original = "# First instructions\n";
    let edited = "# Other instructions\n";
    assert_eq!(
        original.len(),
        edited.len(),
        "same length cannot serve as a revision"
    );
    std::fs::write(&path, original).unwrap();
    let mut state = isolated_plugin_hook_test_state(directory.path());
    let database = directory.path().join("revision-preferences.db");
    state.preferences = preferences::PreferencesStore::open(database.clone()).unwrap();
    let key = format!(
        "project.instructions.{}",
        crate::import::content_sha256(&source.to_string_lossy())
    );
    let mut previous_revision = None;
    let mut initial_revision = None;
    for (index, content) in [original, edited, original].into_iter().enumerate() {
        std::fs::write(&path, content).unwrap();
        let scan = crate::import::scan_source(&source).unwrap();
        let item = scan
            .items
            .iter()
            .find(|item| item.kind == crate::import::kind::INSTRUCTIONS)
            .unwrap();
        assert_eq!(item.id, "instructions/CLAUDE.md");
        let revision = item
            .content_revision
            .clone()
            .expect("current scanner must expose content revision");
        assert_eq!(revision.len(), 64);
        assert_ne!(previous_revision.as_ref(), Some(&revision));
        if index == 0 {
            initial_revision = Some(revision.clone());
        }
        if index == 2 {
            assert_eq!(initial_revision.as_ref(), Some(&revision));
        }
        let outcome = import_instructions_item(
            &state,
            &source,
            &crate::import::ImportSelection {
                kind: crate::import::kind::INSTRUCTIONS.into(),
                id: item.id.clone(),
            },
        )
        .await;
        assert_eq!(outcome.status, "imported");
        assert_eq!(outcome.content_revision.as_ref(), Some(&revision));
        let reopened = preferences::PreferencesStore::open(database.clone()).unwrap();
        let saved: serde_json::Value =
            serde_json::from_str(&reopened.get(&key).await.unwrap().unwrap()).unwrap();
        assert_eq!(saved["content"], content);
        assert_eq!(saved["path"], path.to_string_lossy().as_ref());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            content,
            "import is read-only against source"
        );
        let unchanged = crate::import::scan_source(&source).unwrap();
        assert_eq!(
            unchanged
                .items
                .iter()
                .find(|same| same.id == item.id)
                .unwrap()
                .content_revision
                .as_ref(),
            Some(&revision)
        );
        previous_revision = Some(revision);
    }
}

#[tokio::test]
async fn import_acknowledges_written_bytes_when_source_changes_after_scan() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    std::fs::create_dir_all(&source).unwrap();
    let source = source.canonicalize().unwrap();
    let path = source.join("AGENTS.md");
    std::fs::write(&path, "alpha").unwrap();
    let scan = crate::import::scan_source(&source).unwrap();
    let item = scan
        .items
        .iter()
        .find(|item| item.kind == crate::import::kind::INSTRUCTIONS)
        .unwrap();
    let scanned_revision = item.content_revision.clone().unwrap();
    std::fs::write(&path, "bravo").unwrap();
    let mut state = isolated_plugin_hook_test_state(directory.path());
    let database = directory.path().join("ack-preferences.db");
    state.preferences = preferences::PreferencesStore::open(database.clone()).unwrap();
    let outcome = import_instructions_item(
        &state,
        &source,
        &crate::import::ImportSelection {
            kind: crate::import::kind::INSTRUCTIONS.into(),
            id: item.id.clone(),
        },
    )
    .await;
    assert_eq!(outcome.status, "imported");
    let key = format!(
        "project.instructions.{}",
        crate::import::content_sha256(&source.to_string_lossy())
    );
    let reopened = preferences::PreferencesStore::open(database).unwrap();
    let saved: serde_json::Value =
        serde_json::from_str(&reopened.get(&key).await.unwrap().unwrap()).unwrap();
    assert_eq!(saved["content"], "bravo");
    assert_eq!(
        outcome.content_revision.as_deref(),
        Some(crate::import::content_sha256("bravo").as_str())
    );
    assert_ne!(outcome.content_revision.as_ref(), Some(&scanned_revision));
    std::fs::write(&path, "alpha").unwrap();
    let restored = crate::import::scan_source(&source).unwrap();
    assert_eq!(
        restored
            .items
            .iter()
            .find(|same| same.id == item.id)
            .unwrap()
            .content_revision
            .as_ref(),
        Some(&scanned_revision)
    );
    assert_eq!(
        saved["content"], "bravo",
        "scan remains read-only; an acknowledged reimport must refresh the snapshot"
    );
}

#[tokio::test]
async fn refused_destination_write_never_acknowledges_revision_and_retry_persists_the_same_source()
{
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    std::fs::create_dir_all(&source).unwrap();
    let source = source.canonicalize().unwrap();
    let path = source.join("CLAUDE.md");
    std::fs::write(&path, "alpha").unwrap();
    let mut state = isolated_plugin_hook_test_state(directory.path());
    let database = directory.path().join("refusal-preferences.db");
    state.preferences = preferences::PreferencesStore::open(database.clone()).unwrap();
    let selection = crate::import::ImportSelection {
        kind: crate::import::kind::INSTRUCTIONS.into(),
        id: "instructions/CLAUDE.md".into(),
    };
    let accepted = import_instructions_item(&state, &source, &selection).await;
    assert_eq!(accepted.status, "imported");
    assert!(accepted.content_revision.is_some());
    let key = format!(
        "project.instructions.{}",
        crate::import::content_sha256(&source.to_string_lossy())
    );
    let before = state.preferences.get(&key).await.unwrap().unwrap();
    let raw = rusqlite::Connection::open(&database).unwrap();
    raw.execute_batch(
        "CREATE TRIGGER refuse_owned_instruction_write BEFORE INSERT ON preferences
        WHEN NEW.key LIKE 'project.instructions.%'
        BEGIN SELECT RAISE(ABORT, 'owned instruction write refused'); END;",
    )
    .unwrap();
    std::fs::write(&path, "bravo").unwrap();
    let refused = import_instructions_item(&state, &source, &selection).await;
    assert_eq!(refused.status, "failed");
    assert!(refused.content_revision.is_none());
    assert!(refused.folder_path.is_none());
    assert!(refused
        .detail
        .as_deref()
        .unwrap()
        .contains("could not save instructions"));
    let reopened = preferences::PreferencesStore::open(database.clone()).unwrap();
    assert_eq!(reopened.get(&key).await.unwrap().unwrap(), before);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "bravo");
    raw.execute_batch("DROP TRIGGER refuse_owned_instruction_write;")
        .unwrap();
    let retry = import_instructions_item(&state, &source, &selection).await;
    assert_eq!(retry.status, "imported");
    assert_eq!(
        retry.content_revision.as_deref(),
        Some(crate::import::content_sha256("bravo").as_str())
    );
    let reopened = preferences::PreferencesStore::open(database).unwrap();
    let saved: serde_json::Value =
        serde_json::from_str(&reopened.get(&key).await.unwrap().unwrap()).unwrap();
    assert_eq!(saved["content"], "bravo");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "bravo");
}
