//! Memory data-model string round trips.

use super::*;

#[test]
fn org_scope_round_trips_and_unknown_scopes_decode_to_the_narrowest() {
    assert_eq!(MemoryScope::from_str("org"), MemoryScope::Org);
    assert_eq!(MemoryScope::Org.as_str(), "org");
    // A scope written by a newer node must not decode to something broader.
    assert_eq!(MemoryScope::from_str("team"), MemoryScope::User);
    assert_eq!(MemoryScope::from_str("galaxy"), MemoryScope::User);
}

#[test]
fn source_metadata_is_active_and_cites_nothing_else() {
    let metadata = MemoryMetadata::from_source(MemorySource::Import);
    assert_eq!(metadata.provenance.source, MemorySource::Import);
    assert_eq!(metadata.lifecycle, MemoryLifecycle::Active);
    assert!(metadata.provenance.conversation_id.is_none());
    assert!(metadata.provenance.message_ids.is_empty());
    assert!(metadata.supersedes_id.is_none());
}

#[test]
fn conversation_metadata_cites_the_turn_and_drops_blank_ids() {
    let metadata =
        MemoryMetadata::conversation(Some("conv-1".into()), ["msg-1".to_string(), " ".into()]);
    assert_eq!(metadata.provenance.source, MemorySource::Conversation);
    assert_eq!(
        metadata.provenance.conversation_id.as_deref(),
        Some("conv-1")
    );
    assert_eq!(metadata.provenance.message_ids, ["msg-1"]);

    let unsaved = MemoryMetadata::conversation(Some(String::new()), None);
    assert_eq!(unsaved.provenance.source, MemorySource::Conversation);
    assert!(unsaved.provenance.conversation_id.is_none());
    assert!(unsaved.provenance.message_ids.is_empty());
}

#[tokio::test]
async fn conversation_provenance_round_trips_through_the_store() {
    let store = MemoryStore::open_in_memory().unwrap();
    let id = store
        .record_full_with_metadata(
            LOCAL_USER,
            "default",
            NewMemory::user_fact("prefers tabs"),
            MemoryMetadata::conversation(Some("conv-9".into()), Some("msg-9".to_string())),
        )
        .await
        .unwrap()
        .unwrap();
    let entry = store.get(&id).await.unwrap().unwrap();
    assert_eq!(entry.provenance.source, MemorySource::Conversation);
    assert_eq!(entry.provenance.conversation_id.as_deref(), Some("conv-9"));
    assert_eq!(entry.provenance.message_ids, ["msg-9"]);
}
