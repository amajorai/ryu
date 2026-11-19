//! Pasted-memory import: provenance, per-owner dedup and the sensitive gate.

use super::*;
use crate::server::memory::MemoryStore;

const PASTE: &str = "```\n## Instructions\n[unknown] - Always answer in British English.\n\n## Preferences\n[2024-06-01] - Prefers concise answers.\n```";

#[test]
fn unknown_sources_record_as_other() {
    assert_eq!(paste_source(Some(" ChatGPT ")), "chatgpt");
    assert_eq!(paste_source(Some("grok")), "grok");
    assert_eq!(paste_source(Some("../evil")), "other");
    assert_eq!(paste_source(None), "other");
}

#[tokio::test]
async fn records_imported_user_memories_once_per_owner() {
    let store = MemoryStore::open_in_memory().unwrap();
    let first =
        record_pasted_memories(&store, "alice", "grok", parse_pasted_memories(PASTE), false)
            .await
            .unwrap();
    assert_eq!(
        (first.found, first.imported, first.already_present),
        (2, 2, 0)
    );

    let entry = store.get(&first.ids[0]).await.unwrap().unwrap();
    assert_eq!(entry.content, "Always answer in British English.");
    assert_eq!(entry.category, memory::MemoryCategory::Directive);
    assert_eq!(entry.scope, memory::MemoryScope::User);
    assert_eq!(entry.importance, 4);
    assert!(entry.tags.contains(&"import:grok".to_owned()));
    assert_eq!(entry.provenance.source, memory::MemorySource::Import);

    let again =
        record_pasted_memories(&store, "alice", "grok", parse_pasted_memories(PASTE), false)
            .await
            .unwrap();
    assert_eq!((again.imported, again.already_present), (0, 2));

    // Another member pasting the same text still gets their own copy.
    let bob = record_pasted_memories(&store, "bob", "claude", parse_pasted_memories(PASTE), false)
        .await
        .unwrap();
    assert_eq!((bob.imported, bob.already_present), (2, 0));
}

#[tokio::test]
async fn sensitive_entries_need_consent() {
    let store = MemoryStore::open_in_memory().unwrap();
    let paste = "- Has a diabetes diagnosis.\n- Likes hiking.";
    let entries = parse_pasted_memories(paste);
    assert!(!memory::detect_sensitive_topics(&entries[0].content).is_empty());

    let blocked = record_pasted_memories(&store, "alice", "other", entries.clone(), false)
        .await
        .unwrap();
    assert_eq!((blocked.imported, blocked.skipped_sensitive), (1, 1));

    let allowed = record_pasted_memories(&store, "alice", "other", entries, true)
        .await
        .unwrap();
    assert_eq!((allowed.imported, allowed.already_present), (1, 1));
}

#[test]
fn summary_wire_shape_omits_ids() {
    let summary = PastedMemorySummary {
        found: 3,
        imported: 1,
        already_present: 1,
        skipped_sensitive: 1,
        ids: vec!["m1".to_owned()],
    };
    assert_eq!(
        serde_json::to_value(&summary).unwrap(),
        serde_json::json!({
            "found": 3,
            "imported": 1,
            "already_present": 1,
            "skipped_sensitive": 1,
        })
    );
}
