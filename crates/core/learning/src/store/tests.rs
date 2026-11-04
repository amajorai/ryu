use super::*;

pub(super) fn sample(id: &str, reward: Option<f64>) -> Experience {
    Experience {
        id: id.to_string(),
        conversation_id: "conv-1".to_string(),
        agent_id: None,
        user_text: "how do I reverse a string in rust".to_string(),
        assistant_text: "use chars().rev().collect::<String>()".to_string(),
        outcome: "completed".to_string(),
        reward,
        base_model: Some("gemma-4-E2B-it-Q4_K_M".to_string()),
        skill_generation: 0,
        excluded: false,
        created_at: "2026-07-01T00:00:00Z".to_string(),
    }
}

pub(super) async fn open_tmp(tag: &str) -> ExperienceStore {
    // Unique path per test so parallel tests don't share a WAL db (lock).
    let dir = std::env::temp_dir().join(format!("ryu-exp-test-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    ExperienceStore::open(dir.join("experience.db")).expect("open")
}

fn test_cipher() -> ContentCipher {
    ContentCipher::from_root(&[3u8; 32], STORE)
}

fn file_contains(path: &Path, needle: &str) -> bool {
    std::fs::read(path)
        .map(|bytes| bytes.windows(needle.len()).any(|w| w == needle.as_bytes()))
        .unwrap_or(false)
}

fn raw_texts(path: &Path, id: &str) -> (String, String) {
    let conn = Connection::open(path).unwrap();
    conn.query_row(
        "SELECT user_text, assistant_text FROM experience WHERE id = ?1",
        params![id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .unwrap()
}

#[tokio::test]
async fn texts_are_sealed_on_disk_and_open_on_read() {
    let dir = tempfile_dir("sealed");
    let path = dir.join("experience.db");
    let store = ExperienceStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
    let mut exp = sample("a", Some(0.9));
    exp.user_text = "my-private-prompt-marker".into();
    exp.assistant_text = "my-private-reply-marker".into();
    store.record_if_absent(&exp).await.unwrap();

    let (user, assistant) = raw_texts(&path, "a");
    assert!(user.starts_with("encb:v1:") && assistant.starts_with("encb:v1:"));
    for file in [path.clone(), dir.join("experience.db-wal")] {
        assert!(!file_contains(&file, "my-private-prompt-marker"));
        assert!(!file_contains(&file, "my-private-reply-marker"));
    }
    let rows = store.list_for_training(0.5, 10).await.unwrap();
    assert_eq!(rows[0].user_text, "my-private-prompt-marker");
    assert_eq!(rows[0].assistant_text, "my-private-reply-marker");
}

#[tokio::test]
async fn legacy_rows_are_sealed_once_and_still_read() {
    let dir = tempfile_dir("legacy");
    let path = dir.join("experience.db");
    {
        let conn = Connection::open(&path).unwrap();
        ExperienceStore::init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO experience (id, conversation_id, user_text, assistant_text, outcome,
                   skill_generation, excluded, created_at)
                 VALUES ('old', 'conv-1', 'legacy-prompt-marker', 'legacy-reply-marker',
                   'completed', 0, 0, '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    }
    let leftover = dir.join("state").join("learning");
    std::fs::create_dir_all(&leftover).unwrap();
    std::fs::write(leftover.join("dataset-1.jsonl"), "legacy-prompt-marker").unwrap();
    std::fs::write(leftover.join("keep.txt"), "x").unwrap();

    let store = ExperienceStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
    purge_legacy_datasets(&dir);
    assert!(!leftover.join("dataset-1.jsonl").exists());
    assert!(leftover.join("keep.txt").exists());
    let rows = store.list_unscored(10).await.unwrap();
    assert_eq!(rows[0].user_text, "legacy-prompt-marker");
    let sealed = raw_texts(&path, "old");
    assert!(sealed.0.starts_with("encb:v1:"));
    drop(store);
    for file in [path.clone(), dir.join("experience.db-wal")] {
        assert!(!file_contains(&file, "legacy-prompt-marker"));
    }
    let store = ExperienceStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
    assert_eq!(raw_texts(&path, "old"), sealed, "second open is a no-op");
    let conn = Connection::open(&path).unwrap();
    ryu_crypto::content_sqlite::assert_all_open(&conn, &test_cipher(), &column_plans().unwrap())
        .unwrap();
    assert_eq!(store.list(10).await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_text_swapped_between_rows_is_skipped_and_counted() {
    let dir = tempfile_dir("swap");
    let path = dir.join("experience.db");
    let store = ExperienceStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
    store.record_if_absent(&sample("a", None)).await.unwrap();
    store.record_if_absent(&sample("b", None)).await.unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE experience SET user_text = (SELECT user_text FROM experience WHERE id = 'a')
                 WHERE id = 'b'",
            [],
        )
        .unwrap();
    }
    let rows = store.list(10).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "a");
    assert_eq!(store.unreadable_rows(), 1);
}

fn tempfile_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ryu-exp-seal-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn record_is_idempotent_and_preserves_reward() {
    let store = open_tmp("idempotent").await;
    assert!(store.record_if_absent(&sample("a", None)).await.unwrap());
    store.set_reward("a", 0.9).await.unwrap();
    // Re-sweep: same id must NOT clobber the reward.
    assert!(!store.record_if_absent(&sample("a", None)).await.unwrap());
    let rows = store.list(10).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].reward, Some(0.9));
}

#[tokio::test]
async fn clear_reward_reverts_to_unscored() {
    let store = open_tmp("clear").await;
    store.record_if_absent(&sample("a", None)).await.unwrap();
    store.set_reward("a", 1.0).await.unwrap();
    assert_eq!(store.list_for_training(0.7, 10).await.unwrap().len(), 1);
    // Clearing a human vote reverts the row to unscored (NULL), so it drops
    // out of the training set and re-enters the PRM work queue.
    assert!(store.clear_reward("a").await.unwrap());
    assert_eq!(store.list_for_training(0.7, 10).await.unwrap().len(), 0);
    assert_eq!(store.list_unscored(10).await.unwrap().len(), 1);
}

#[tokio::test]
async fn exclude_conversation_blocks_training() {
    let store = open_tmp("exclude").await;
    store
        .record_if_absent(&sample("a", Some(0.95)))
        .await
        .unwrap();
    assert_eq!(store.list_for_training(0.7, 10).await.unwrap().len(), 1);
    let n = store.exclude_conversation("conv-1", true).await.unwrap();
    assert_eq!(n, 1);
    assert_eq!(store.list_for_training(0.7, 10).await.unwrap().len(), 0);
}
