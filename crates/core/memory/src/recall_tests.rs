//! Recall: agent scoping, level/project filters, visibility, sensitive paging, default levels.

use super::*;

#[tokio::test]
async fn record_and_recall_round_trips() {
    let store = MemoryStore::open_in_memory().unwrap();
    store
        .record(LOCAL_USER, "default", "User prefers dark mode")
        .await
        .unwrap();
    store
        .record(LOCAL_USER, "default", "User is based in Singapore")
        .await
        .unwrap();

    let recalled = store.recall(LOCAL_USER, "default", 10).await.unwrap();
    assert_eq!(recalled.len(), 2);
    // Newest first.
    assert_eq!(recalled[0].content, "User is based in Singapore");
    assert_eq!(recalled[1].content, "User prefers dark mode");
}

#[tokio::test]
async fn recall_is_scoped_by_agent() {
    let store = MemoryStore::open_in_memory().unwrap();
    store
        .record(LOCAL_USER, "agent-a", "fact for a")
        .await
        .unwrap();
    store
        .record(LOCAL_USER, "agent-b", "fact for b")
        .await
        .unwrap();

    let a = store.recall(LOCAL_USER, "agent-a", 10).await.unwrap();
    assert_eq!(a.len(), 1);
    assert_eq!(a[0].content, "fact for a");

    let none = store.recall(LOCAL_USER, "agent-c", 10).await.unwrap();
    assert!(none.is_empty());
}

#[tokio::test]
async fn sensitive_filter_pages_until_it_finds_visible_facts() {
    let store = MemoryStore::open_in_memory().unwrap();
    store
        .record(LOCAL_USER, "agent-a", "ordinary preference")
        .await
        .unwrap();
    for index in 0..129 {
        store
            .record(
                LOCAL_USER,
                "agent-a",
                &format!("I have a diagnosis number {index}"),
            )
            .await
            .unwrap();
    }

    let visible = store
        .recall_with_sensitive(LOCAL_USER, "agent-a", 1, false)
        .await
        .unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].content, "ordinary preference");

    let listed = store
        .list_visible_with_sensitive(
            &MemoryFilter {
                limit: Some(1),
                ..Default::default()
            },
            MemoryVisibility::unrestricted(),
            false,
        )
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].content, "ordinary preference");
}

#[tokio::test]
async fn recall_scoped_filters_by_level_and_project() {
    let store = MemoryStore::open_in_memory().unwrap();
    store
        .record_full(LOCAL_USER, "a", {
            let mut m = NewMemory::user_fact("global user fact");
            m.scope = MemoryScope::User;
            m
        })
        .await
        .unwrap();
    store
        .record_full(LOCAL_USER, "a", {
            let mut m = NewMemory::user_fact("fact for project X");
            m.scope = MemoryScope::Project;
            m.scope_id = Some("/proj/x".into());
            m
        })
        .await
        .unwrap();
    store
        .record_full(LOCAL_USER, "a", {
            let mut m = NewMemory::user_fact("fact for project Y");
            m.scope = MemoryScope::Project;
            m.scope_id = Some("/proj/y".into());
            m
        })
        .await
        .unwrap();

    // User-only agent: sees just the global fact.
    let user_only = store
        .recall_scoped(&[MemoryScope::User], Some("/proj/x"), 10)
        .await
        .unwrap();
    assert_eq!(user_only.len(), 1);
    assert_eq!(user_only[0].content, "global user fact");

    // Project-enabled agent in project X: global + X, not Y.
    let in_x = store
        .recall_scoped(
            &[MemoryScope::User, MemoryScope::Project],
            Some("/proj/x"),
            10,
        )
        .await
        .unwrap();
    let contents: Vec<_> = in_x.iter().map(|e| e.content.as_str()).collect();
    assert!(contents.contains(&"global user fact"));
    assert!(contents.contains(&"fact for project X"));
    assert!(!contents.contains(&"fact for project Y"));
}

#[tokio::test]
async fn visible_scoped_recall_applies_levels_project_and_owner() {
    let store = MemoryStore::open_in_memory().unwrap();
    store
        .record_full(
            "alice",
            "agent-a",
            NewMemory::user_fact("alice private fact"),
        )
        .await
        .unwrap();
    store
        .record_full("bob", "agent-a", NewMemory::user_fact("bob private fact"))
        .await
        .unwrap();
    store
        .record_full("alice", "agent-a", {
            let mut memory = NewMemory::user_fact("project X fact");
            memory.scope = MemoryScope::Project;
            memory.scope_id = Some("/proj/x".to_owned());
            memory
        })
        .await
        .unwrap();
    store
        .record_full("alice", "agent-a", {
            let mut memory = NewMemory::user_fact("project Y fact");
            memory.scope = MemoryScope::Project;
            memory.scope_id = Some("/proj/y".to_owned());
            memory
        })
        .await
        .unwrap();
    store
        .record_full("alice", "agent-a", {
            let mut memory = NewMemory::user_fact("shared node fact");
            memory.scope = MemoryScope::Node;
            memory
        })
        .await
        .unwrap();

    let entries = store
        .recall_visible_scoped_for_agent(
            "bob",
            &[MemoryScope::User, MemoryScope::Project],
            Some("agent-a"),
            Some("/proj/x"),
            MemoryVisibility::for_caller_in_org(Some("bob"), Some("acme"), true),
            10,
            false,
        )
        .await
        .unwrap();
    let contents: Vec<&str> = entries.iter().map(|entry| entry.content.as_str()).collect();
    assert!(contents.contains(&"bob private fact"));
    assert!(!contents.contains(&"alice private fact"));
    assert!(contents.contains(&"project X fact"));
    assert!(!contents.contains(&"project Y fact"));
    assert!(!contents.contains(&"shared node fact"));
}

#[tokio::test]
async fn visible_scoped_recall_ranks_importance_before_recency() {
    let store = MemoryStore::open_in_memory().unwrap();
    store
        .record_full(LOCAL_USER, "default", {
            let mut memory = NewMemory::user_fact("older but important");
            memory.importance = 5;
            memory
        })
        .await
        .unwrap();
    for content in ["newer routine one", "newer routine two"] {
        store
            .record_full(LOCAL_USER, "default", NewMemory::user_fact(content))
            .await
            .unwrap();
    }

    let recall = |limit| {
        store.recall_visible_scoped_for_agent(
            LOCAL_USER,
            &[MemoryScope::User],
            None,
            None,
            MemoryVisibility::unrestricted(),
            limit,
            false,
        )
    };
    let top = recall(1).await.unwrap();
    assert_eq!(top.len(), 1);
    assert_eq!(top[0].content, "older but important");

    let all = recall(10).await.unwrap();
    let contents: Vec<&str> = all.iter().map(|entry| entry.content.as_str()).collect();
    assert_eq!(
        contents,
        vec![
            "older but important",
            "newer routine two",
            "newer routine one"
        ]
    );
}

#[test]
fn org_is_not_in_the_default_read_levels() {
    // An unconfigured agent must NOT silently gain organization-wide reads.
    let levels = MemoryStore::effective_levels(&[]);
    assert!(!levels.contains(&MemoryScope::Org));
    assert_eq!(
        levels,
        vec![
            MemoryScope::Agent,
            MemoryScope::User,
            MemoryScope::Node,
            MemoryScope::Project,
        ]
    );
    // But an agent that explicitly asks for it gets it.
    assert!(MemoryStore::effective_levels(&[MemoryScope::Org]).contains(&MemoryScope::Org));
}
