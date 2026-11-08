//! Proposal status/operation string round trips and draft conversion.

use super::*;

#[test]
fn proposal_status_round_trips_and_unknown_values_stay_pending() {
    for status in [
        MemoryProposalStatus::Pending,
        MemoryProposalStatus::Applied,
        MemoryProposalStatus::Rejected,
        MemoryProposalStatus::RolledBack,
    ] {
        assert_eq!(MemoryProposalStatus::from_str(status.as_str()), status);
    }
    // An unrecognized stored status must never read as applied or rolled back.
    assert_eq!(
        MemoryProposalStatus::from_str("archived"),
        MemoryProposalStatus::Pending
    );
}

#[test]
fn proposal_operation_round_trips_and_unknown_values_create() {
    for operation in [
        MemoryProposalOperation::Create,
        MemoryProposalOperation::Revise,
    ] {
        assert_eq!(
            MemoryProposalOperation::from_str(operation.as_str()),
            operation
        );
    }
    // An unknown operation must not supersede an existing memory.
    assert_eq!(
        MemoryProposalOperation::from_str("delete"),
        MemoryProposalOperation::Create
    );
}

#[test]
fn draft_into_new_memory_carries_every_field() {
    let draft = MemoryProposalDraft {
        content: "Ships on Fridays".to_owned(),
        scope: MemoryScope::Project,
        scope_id: Some("/work/ryu".to_owned()),
        category: MemoryCategory::ProjectContext,
        importance: 5,
        when_to_use: Some("release planning".to_owned()),
        tags: vec!["release".to_owned()],
        author_agent_id: Some("agent-a".to_owned()),
        metadata: MemoryMetadata::default(),
        sources: Vec::new(),
    };
    let memory = draft.into_new_memory();
    assert_eq!(memory.content, "Ships on Fridays");
    assert_eq!(memory.scope, MemoryScope::Project);
    assert_eq!(memory.scope_id.as_deref(), Some("/work/ryu"));
    assert_eq!(memory.category, MemoryCategory::ProjectContext);
    assert_eq!(memory.importance, 5);
    assert_eq!(memory.when_to_use.as_deref(), Some("release planning"));
    assert_eq!(memory.tags, vec!["release".to_owned()]);
    assert_eq!(memory.author_agent_id.as_deref(), Some("agent-a"));
}

#[test]
fn a_legacy_draft_without_sources_still_opens() {
    let draft: MemoryProposalDraft =
        serde_json::from_str(r#"{"content":"Prefers tea","category":"preference"}"#).unwrap();
    assert!(draft.sources.is_empty());
    // An empty list stays off the wire so older readers see the same payload.
    let json = serde_json::to_value(&draft).unwrap();
    assert!(json.get("sources").is_none());
}

#[tokio::test]
async fn proposal_sources_round_trip_through_the_encrypted_payload() {
    let store = MemoryStore::open_in_memory().unwrap();
    let source = MemoryProposalSource {
        message_id: "m-1".to_owned(),
        conversation_id: Some("c-1".to_owned()),
        excerpt: "I prefer window seats.".to_owned(),
    };
    let id = store
        .create_proposal(NewMemoryProposal {
            owner_user_id: LOCAL_USER.to_owned(),
            agent_id: "dream".to_owned(),
            target_memory_id: None,
            operation: MemoryProposalOperation::Create,
            draft: MemoryProposalDraft {
                content: "Prefers window seats".to_owned(),
                scope: MemoryScope::User,
                scope_id: None,
                category: MemoryCategory::Preference,
                importance: 3,
                when_to_use: None,
                tags: Vec::new(),
                author_agent_id: Some("dream".to_owned()),
                metadata: MemoryMetadata::default(),
                sources: vec![source.clone()],
            },
            rationale: "stated preference".to_owned(),
        })
        .await
        .unwrap();
    let stored = store.get_proposal(&id).await.unwrap().unwrap();
    assert_eq!(stored.draft.sources, vec![source]);

    // Accepting writes the fact, not the chat excerpt.
    let reviewed = store
        .review_proposal(&id, true, Some(LOCAL_USER))
        .await
        .unwrap()
        .unwrap();
    let memory_id = reviewed.applied_memory_id.unwrap();
    let entry = store.get(&memory_id).await.unwrap().unwrap();
    assert_eq!(entry.content, "Prefers window seats");
    assert!(!serde_json::to_string(&entry)
        .unwrap()
        .contains("I prefer window seats."));
}
