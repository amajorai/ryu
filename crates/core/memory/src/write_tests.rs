//! Recording long-term facts: empty content, metadata, stable ids, and scope_id guards.

use super::*;

#[tokio::test]
async fn empty_content_is_not_recorded() {
    let store = MemoryStore::open_in_memory().unwrap();
    assert!(store
        .record(LOCAL_USER, "default", "   ")
        .await
        .unwrap()
        .is_none());
    assert!(store
        .recall(LOCAL_USER, "default", 10)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn record_full_persists_metadata() {
    let store = MemoryStore::open_in_memory().unwrap();
    let id = store
        .record_full(
            LOCAL_USER,
            "agent-a",
            NewMemory {
                content: "Uses pnpm not npm".into(),
                scope: MemoryScope::Project,
                scope_id: Some("/work/ryu".into()),
                category: MemoryCategory::Preference,
                importance: 5,
                when_to_use: Some("when installing deps".into()),
                tags: vec!["tooling".into()],
                author_agent_id: Some("agent-a".into()),
            },
        )
        .await
        .unwrap()
        .unwrap();
    let got = store.get(&id).await.unwrap().unwrap();
    assert_eq!(got.content, "Uses pnpm not npm");
    assert_eq!(got.scope, MemoryScope::Project);
    assert_eq!(got.scope_id.as_deref(), Some("/work/ryu"));
    assert_eq!(got.category, MemoryCategory::Preference);
    assert_eq!(got.importance, 5);
    assert_eq!(got.when_to_use.as_deref(), Some("when installing deps"));
    assert_eq!(got.tags, vec!["tooling".to_string()]);
}

#[tokio::test]
async fn record_full_with_id_preserves_a_stable_identifier() {
    let store = MemoryStore::open_in_memory().unwrap();
    let id = store
        .record_full_with_id(
            "remembered-command",
            LOCAL_USER,
            "default",
            NewMemory::user_fact("Use the focused test command"),
        )
        .await
        .unwrap();
    assert_eq!(id.as_deref(), Some("remembered-command"));
    assert_eq!(
        store.get("remembered-command").await.unwrap().unwrap().id,
        "remembered-command"
    );
}

#[tokio::test]
async fn agent_scope_requires_and_matches_its_agent_id() {
    let store = MemoryStore::open_in_memory().unwrap();
    let mut memory = NewMemory::user_fact("agent-only fact");
    memory.scope = MemoryScope::Agent;
    memory.scope_id = Some("agent-a".to_owned());
    store
        .record_full(LOCAL_USER, "agent-a", memory)
        .await
        .unwrap();

    let a = store
        .recall_scoped_for_agent(&[MemoryScope::Agent], Some("agent-a"), None, 10)
        .await
        .unwrap();
    assert_eq!(a.len(), 1);
    let b = store
        .recall_scoped_for_agent(&[MemoryScope::Agent], Some("agent-b"), None, 10)
        .await
        .unwrap();
    assert!(b.is_empty());
}

#[tokio::test]
async fn an_org_fact_without_a_scope_id_is_refused_at_write() {
    // Such a row would match no caller in the predicate, i.e. be readable by
    // nobody. Better to fail loudly at the write than to store a black hole.
    let store = MemoryStore::open_in_memory().unwrap();
    let mut m = NewMemory::user_fact("orphan org fact");
    m.scope = MemoryScope::Org;
    let err = store.record_full("alice", "a", m).await.unwrap_err();
    assert!(
        err.to_string().contains("scope_id"),
        "error should name the missing scope_id, got: {err}"
    );
}

#[tokio::test]
async fn a_project_fact_without_a_scope_id_is_refused_at_write() {
    let store = MemoryStore::open_in_memory().unwrap();
    let mut memory = NewMemory::user_fact("orphan project fact");
    memory.scope = MemoryScope::Project;
    let error = store.record_full("alice", "a", memory).await.unwrap_err();
    assert!(error.to_string().contains("scope_id"));
}
