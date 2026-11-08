//! Long-term memory store: in-place updates, deletion, and the lifecycle and
//! sensitive-scope guards on update.

use rusqlite::params;

use super::*;

#[tokio::test]
async fn update_and_delete() {
    let store = MemoryStore::open_in_memory().unwrap();
    let id = store
        .record(LOCAL_USER, "a", "original")
        .await
        .unwrap()
        .unwrap();
    let updated = store
        .update(
            &id,
            MemoryPatch {
                content: Some("edited".into()),
                importance: Some(5),
                category: Some(MemoryCategory::Directive),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(updated.content, "edited");
    assert_eq!(updated.importance, 5);
    assert_eq!(updated.category, MemoryCategory::Directive);

    assert!(store.delete(&id).await.unwrap());
    assert!(store.get(&id).await.unwrap().is_none());
}

#[tokio::test]
async fn inactive_entries_cannot_be_updated_in_place() {
    let store = MemoryStore::open_in_memory().unwrap();
    let id = store
        .record(LOCAL_USER, "a", "immutable revision")
        .await
        .unwrap()
        .unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE memory_entries SET lifecycle = 'superseded' WHERE id = ?1",
            params![id],
        )
        .unwrap();
    }

    assert!(store
        .update(
            &id,
            MemoryPatch {
                content: Some("must not change".to_owned()),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        store.get(&id).await.unwrap().unwrap().content,
        "immutable revision"
    );
}

#[tokio::test]
async fn update_refuses_sensitive_content_in_shared_scopes() {
    let store = MemoryStore::open_in_memory().unwrap();
    let id = store
        .record(LOCAL_USER, "a", "ordinary preference")
        .await
        .unwrap()
        .unwrap();

    let error = store
        .update(
            &id,
            MemoryPatch {
                content: Some("I have a diabetes diagnosis".into()),
                scope: Some(MemoryScope::Node),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("user scope"));

    let existing_sensitive = store
        .record(LOCAL_USER, "a", "I have a peanut allergy")
        .await
        .unwrap()
        .unwrap();
    let error = store
        .update(
            &existing_sensitive,
            MemoryPatch {
                scope: Some(MemoryScope::Project),
                scope_id: Some(Some("/work/ryu".to_owned())),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("user scope"));
}
