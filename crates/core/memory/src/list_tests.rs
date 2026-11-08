//! Listing and wiping long-term facts.

use super::*;

#[tokio::test]
async fn clear_all_forgets_every_entry() {
    let store = MemoryStore::open_in_memory().unwrap();
    store.record(LOCAL_USER, "agent-a", "fact a").await.unwrap();
    store.record(LOCAL_USER, "agent-b", "fact b").await.unwrap();
    let proposal_id = store
        .create_proposal(NewMemoryProposal {
            owner_user_id: LOCAL_USER.to_owned(),
            agent_id: "agent-a".to_owned(),
            target_memory_id: None,
            operation: MemoryProposalOperation::Create,
            draft: MemoryProposalDraft {
                content: "proposal to forget".to_owned(),
                scope: MemoryScope::User,
                scope_id: None,
                category: MemoryCategory::UserFact,
                importance: DEFAULT_IMPORTANCE,
                when_to_use: None,
                tags: Vec::new(),
                author_agent_id: Some("agent-a".to_owned()),
                metadata: MemoryMetadata::default(),
                sources: Vec::new(),
            },
            rationale: "test".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(store.count().await.unwrap(), 2);

    let removed = store.clear_all().await.unwrap();
    assert_eq!(removed, 2);
    assert_eq!(store.count().await.unwrap(), 0);
    assert!(store.get_proposal(&proposal_id).await.unwrap().is_none());
    // The key is intact, so new memories still record + recall afterward.
    store.record(LOCAL_USER, "agent-a", "fresh").await.unwrap();
    let recalled = store.recall(LOCAL_USER, "agent-a", 10).await.unwrap();
    assert_eq!(recalled.len(), 1);
    assert_eq!(recalled[0].content, "fresh");
}

#[tokio::test]
async fn list_visible_scopes_user_facts_per_owner_on_bound_node() {
    let store = MemoryStore::open_in_memory().unwrap();
    // Alice's private user fact.
    store
        .record_full("alice", "a", NewMemory::user_fact("alice private secret"))
        .await
        .unwrap();
    // Bob's private user fact.
    store
        .record_full("bob", "a", NewMemory::user_fact("bob private secret"))
        .await
        .unwrap();
    // A shared node-scope fact (the company brain).
    store
        .record_full("alice", "a", {
            let mut m = NewMemory::user_fact("shared org policy");
            m.scope = MemoryScope::Node;
            m
        })
        .await
        .unwrap();

    let filter = MemoryFilter::default();

    // Bob (bound node): sees his own user fact + the shared node fact, NOT Alice's.
    let bob = store
        .list_visible(&filter, MemoryVisibility::for_caller(Some("bob"), true))
        .await
        .unwrap();
    let bob_contents: Vec<&str> = bob.iter().map(|e| e.content.as_str()).collect();
    assert!(
        !bob_contents.contains(&"alice private secret"),
        "Bob must not read Alice's user memory"
    );
    assert!(bob_contents.contains(&"bob private secret"));
    assert!(
        bob_contents.contains(&"shared org policy"),
        "node-scope memory is shared"
    );

    // Alice (bound node): her own + shared, not Bob's — no lockout on her data.
    let alice = store
        .list_visible(&filter, MemoryVisibility::for_caller(Some("alice"), true))
        .await
        .unwrap();
    let alice_contents: Vec<&str> = alice.iter().map(|e| e.content.as_str()).collect();
    assert!(alice_contents.contains(&"alice private secret"));
    assert!(alice_contents.contains(&"shared org policy"));
    assert!(!alice_contents.contains(&"bob private secret"));

    // UNBOUND node: byte-identical — every fact visible regardless of owner.
    let unbound = store
        .list_visible(&filter, MemoryVisibility::unrestricted())
        .await
        .unwrap();
    assert_eq!(
        unbound.len(),
        3,
        "unbound node sees all facts (no filtering)"
    );
}
