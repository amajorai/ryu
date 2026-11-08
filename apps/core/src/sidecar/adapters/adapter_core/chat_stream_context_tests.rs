//! Per-turn memory capture: provenance and the write-frequency policy.

use super::*;
use crate::memory_policy::MemoryPolicy;
use crate::server::memory::{MemoryFilter, MemorySource};

fn saved_turn() -> ChatStreamRequest {
    ChatStreamRequest {
        conversation_id: Some("conv-42".into()),
        enable_long_term: true,
        persist: true,
        ..ChatStreamRequest::default()
    }
}

async fn capture(policy: MemoryPolicy, message_id: Option<&str>) -> MemoryStore {
    let memory = MemoryStore::open_in_memory().unwrap();
    let traces = TraceStore::open_in_memory().unwrap();
    record_turn_memory(
        &saved_turn(),
        &memory,
        &traces,
        &policy,
        true,
        LOCAL_USER,
        &None,
        &None,
        "I prefer metric units",
        message_id,
    )
    .await;
    memory
}

#[tokio::test]
async fn a_captured_turn_cites_its_conversation_and_stored_message() {
    let memory = capture(MemoryPolicy::default(), Some("msg-7")).await;
    let entries = memory.list(&MemoryFilter::default()).await.unwrap();
    assert_eq!(entries.len(), 1);
    let provenance = &entries[0].provenance;
    assert_eq!(provenance.source, MemorySource::Conversation);
    assert_eq!(provenance.conversation_id.as_deref(), Some("conv-42"));
    assert_eq!(provenance.message_ids, ["msg-7"]);
}

#[tokio::test]
async fn a_turn_whose_message_was_not_stored_still_names_its_conversation() {
    let memory = capture(MemoryPolicy::default(), None).await;
    let entries = memory.list(&MemoryFilter::default()).await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].provenance.source, MemorySource::Conversation);
    assert_eq!(
        entries[0].provenance.conversation_id.as_deref(),
        Some("conv-42")
    );
    assert!(entries[0].provenance.message_ids.is_empty());
}

#[tokio::test]
async fn reviewed_write_frequency_stores_no_raw_turn() {
    let policy = MemoryPolicy::from_raw(None, None, Some("reviewed"));
    let memory = capture(policy, Some("msg-7")).await;
    let entries = memory.list(&MemoryFilter::default()).await.unwrap();
    assert!(entries.is_empty(), "reviewed mode wrote {entries:?}");
}
