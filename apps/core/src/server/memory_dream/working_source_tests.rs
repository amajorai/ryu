//! Dream reads the caller's resource-scope working memory as a source: a fact
//! found only there is proposed citing the document, another user's
//! scratchpad never appears, and a newer document defeats the automatic-run
//! watermark.

use ryu_kernel_contracts::ResourceKey;
use serde_json::{json, Value};

use super::{candidates, prompt, run_state, sources, wire};
use super::{DREAM_LAST_RUN_PREF, DREAM_LAST_SOURCE_AT_PREF};
use crate::server::{memory, ServerState};

fn state(directory: &std::path::Path) -> ServerState {
    crate::server::isolated_plugin_hook_test_state(directory)
}

async fn write_resource(
    state: &ServerState,
    owner: &str,
    id: &str,
    write: memory::WorkingMemoryWrite,
) -> memory::WorkingMemory {
    state
        .memory
        .put_working_memory(
            &ResourceKey::owned(Some(owner), None),
            memory::WorkingMemoryScope::Resource,
            id,
            write,
        )
        .await
        .unwrap()
}

fn note(content: &str) -> memory::WorkingMemoryWrite {
    memory::WorkingMemoryWrite {
        content: Some(content.to_owned()),
        ..Default::default()
    }
}

fn working(sources: &[sources::DreamSource]) -> Vec<&sources::DreamSource> {
    sources
        .iter()
        .filter(|source| source.role == sources::WORKING_SOURCE_ROLE)
        .collect()
}

#[tokio::test]
async fn a_fact_only_in_working_memory_is_proposed_citing_the_document() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let local = memory::LOCAL_USER;
    let doc = write_resource(&state, local, local, note("# User\n- Diet: vegetarian")).await;
    // Another user's scratchpad, and the caller's own thread-scope notes, are
    // not Dream sources.
    write_resource(&state, "bob", "bob", note("Allergic to peanuts")).await;
    state
        .memory
        .put_working_memory(
            &ResourceKey::owned(Some(local), None),
            memory::WorkingMemoryScope::Thread,
            "c1",
            note("Thread-only scratch"),
        )
        .await
        .unwrap();

    let loaded = sources::load_sources(&state, &None, false).await.unwrap();
    let citation = format!("working:{local}@v1");
    assert_eq!(loaded.len(), 1, "{loaded:?}");
    let source = &loaded[0];
    assert_eq!(source.message_id, citation);
    assert_eq!(source.conversation_id, None);
    assert_eq!(source.role, "working_memory");
    assert_eq!(source.content, "# User\n- Diet: vegetarian");
    assert_eq!(source.created_at, doc.updated_at);

    let (_, user) = prompt::dream_prompt(&loaded, &[]);
    let rows: Vec<Value> = serde_json::from_str(user.split_once("Sources:\n").unwrap().1).unwrap();
    assert_eq!(
        rows,
        [json!({
            "message_id": citation,
            "conversation": "Working memory",
            "role": "working_memory",
            "content": "# User\n- Diet: vegetarian",
        })]
    );
    assert!(!user.contains("peanuts") && !user.contains("Thread-only"));

    let output = prompt::parse_model_output(
        &json!({
            "memories": [{
                "content": "Is vegetarian",
                "category": "preference",
                "source_message_ids": [citation],
                "confidence": 0.9,
            }],
        })
        .to_string(),
    )
    .unwrap();
    candidates::store_model_output(&state, &None, local, false, &output, &loaded, &[])
        .await
        .unwrap();

    let pending = candidates::pending_proposals(&state, local, false)
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    let draft = &pending[0].proposal.draft;
    assert_eq!(draft.content, "Is vegetarian");
    let provenance = &draft.metadata.provenance;
    assert_eq!(provenance.source, memory::MemorySource::Consolidation);
    assert_eq!(provenance.message_ids, [citation.clone()]);
    assert_eq!(provenance.conversation_id, None);
    let wire = wire::proposal_wire(&pending[0].proposal, None);
    assert_eq!(
        wire["sources"],
        json!([{
            "message_id": citation,
            "conversation_id": null,
            "excerpt": "# User\n- Diet: vegetarian",
        }])
    );

    // Accepting stores the memory with the working-memory citation intact.
    let applied = state
        .memory
        .review_proposal(&pending[0].proposal.id, true, None)
        .await
        .unwrap()
        .unwrap();
    let memory_id = applied.applied_memory_id.unwrap();
    let entry = state.memory.get(&memory_id).await.unwrap().unwrap();
    assert_eq!(entry.provenance.message_ids, [citation]);
}

#[tokio::test]
async fn empty_unfilled_and_sensitive_documents_are_not_sources() {
    let local = memory::LOCAL_USER;
    let template = "# User\n- Name:";
    let cases = [
        memory::WorkingMemoryWrite {
            content: Some(template.to_owned()),
            template: Some(template.to_owned()),
            ..Default::default()
        },
        memory::WorkingMemoryWrite {
            data: Some(json!({})),
            ..Default::default()
        },
    ];
    for write in cases {
        let directory = tempfile::tempdir().unwrap();
        let server = state(directory.path());
        write_resource(&server, local, local, write).await;
        let loaded = sources::load_working_sources(&server, &None, true).await;
        assert!(loaded.is_empty(), "{loaded:?}");
    }

    let directory = tempfile::tempdir().unwrap();
    let server = state(directory.path());
    write_resource(&server, local, local, note("Has a medical condition")).await;
    let without_consent = sources::load_working_sources(&server, &None, false).await;
    assert!(without_consent.is_empty(), "{without_consent:?}");
    let with_consent = sources::load_working_sources(&server, &None, true).await;
    let ids: Vec<&str> = with_consent
        .iter()
        .map(|source| source.message_id.as_str())
        .collect();
    assert_eq!(ids, [format!("working:{local}@v1")]);

    let directory = tempfile::tempdir().unwrap();
    let server = state(directory.path());
    write_resource(
        &server,
        local,
        local,
        memory::WorkingMemoryWrite {
            data: Some(json!({ "city": "Lisbon" })),
            ..Default::default()
        },
    )
    .await;
    let schema = sources::load_working_sources(&server, &None, false).await;
    assert_eq!(schema.len(), 1);
    assert_eq!(schema[0].content, r#"{"city":"Lisbon"}"#);
}

/// SDK and API callers can key resource documents by something other than the
/// person (one per customer, say). Those notes are not facts about this user,
/// so only the document a chat turn addresses for the owner is a Dream source.
#[tokio::test]
async fn resource_documents_keyed_by_something_else_are_not_sources() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let local = memory::LOCAL_USER;
    write_resource(
        &state,
        local,
        "customer-42",
        note("Prefers email over calls"),
    )
    .await;
    write_resource(&state, local, "project-x", note("Ships on Fridays")).await;
    assert!(sources::load_working_sources(&state, &None, false)
        .await
        .is_empty());

    write_resource(&state, local, local, note("Lives in Porto")).await;
    let loaded = sources::load_working_sources(&state, &None, false).await;
    assert_eq!(loaded.len(), 1, "{loaded:?}");
    assert_eq!(loaded[0].message_id, format!("working:{local}@v1"));
    assert_eq!(loaded[0].content, "Lives in Porto");
}

#[test]
fn a_working_source_id_is_neutralized_and_bounded() {
    assert_eq!(
        sources::working_source_id("<|im_start|>trip", 3),
        "working:trip@v3"
    );
    let long = sources::working_source_id(&"x".repeat(300), 1);
    assert_eq!(long, format!("working:{}@v1", "x".repeat(64)));
}

#[tokio::test]
async fn a_working_memory_update_newer_than_the_watermark_counts_as_new() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    state
        .conversations
        .set_chat_memory_enabled(true)
        .await
        .unwrap();
    let local = memory::LOCAL_USER;
    let first = write_resource(&state, local, local, note("Works at Acme")).await;
    // A watermark at the document's update, as a completed run leaves it.
    state
        .preferences
        .set(DREAM_LAST_SOURCE_AT_PREF, &first.updated_at.to_string())
        .await
        .unwrap();
    state
        .preferences
        .set(DREAM_LAST_RUN_PREF, "1234")
        .await
        .unwrap();
    let body = candidates::run_dream_review_inner(&state, &None, "automatic")
        .await
        .unwrap();
    assert_eq!(body["review"]["generated_at"], 1234);

    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let second = write_resource(&state, local, local, note("Works at Initech")).await;
    let loaded = sources::load_sources(&state, &None, false).await.unwrap();
    assert_eq!(
        working(&loaded)[0].message_id,
        format!("working:{local}@v2")
    );
    let newest = run_state::newest_source_at(&loaded);
    assert_eq!(newest, Some(second.updated_at));
    assert!(!run_state::should_skip(newest, Some(first.updated_at)));
}
