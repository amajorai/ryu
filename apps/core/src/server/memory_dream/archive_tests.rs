//! Dream archive: model archives limited to the memories sent, stale events
//! proposed without a model, declined archives not proposed again, an
//! accepted archive taking its target out of recall, and accepting a proposal
//! whose memory was deleted refused as a conflict. The stale-event filters
//! and their bounds are tested in `archive_bounds_tests` and the memory store.

use std::collections::{HashMap, HashSet};

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension,
};
use serde_json::json;

use super::archive::{self, DREAM_STALE_EVENT_AGE_MS, DREAM_STALE_EVENT_REASON};
use super::{candidates, prompt, routes, sources, wire};
use crate::server::{memory, ServerState};

const DAY_MS: i64 = 24 * 60 * 60 * 1_000;

pub(super) fn state(directory: &std::path::Path) -> ServerState {
    crate::server::isolated_plugin_hook_test_state(directory)
}

fn source(message_id: &str, content: &str) -> sources::DreamSource {
    sources::DreamSource {
        conversation_id: Some("c1".to_owned()),
        conversation_title: "Trip planning".to_owned(),
        message_id: message_id.to_owned(),
        role: "user".to_owned(),
        content: content.to_owned(),
        created_at: 10,
    }
}

fn entry(id: &str, category: &str, created_at: i64) -> memory::LongTermEntry {
    serde_json::from_value(json!({
        "id": id,
        "content": format!("memory {id}"),
        "scope": "project",
        "scope_id": "/work/ryu",
        "category": category,
        "importance": 4,
        "tags": ["travel"],
        "created_at": created_at,
    }))
    .unwrap()
}

fn archives(value: serde_json::Value) -> Vec<prompt::DreamModelArchive> {
    serde_json::from_value(value).unwrap()
}

#[test]
fn model_output_archives_parse_under_either_key() {
    for key in ["archive", "archives"] {
        let output = prompt::parse_model_output(
            &json!({ key: [{ "targetMemoryId": "mem-1", "reason": "Trip is over" }] }).to_string(),
        )
        .unwrap();
        assert_eq!(output.archive.len(), 1, "{key}");
        assert_eq!(output.archive[0].target_memory_id, "mem-1");
        assert!(output.archive[0].source_message_ids.is_empty());
    }
}

#[test]
fn model_archives_are_limited_to_the_memories_sent() {
    let related = [
        entry("mem-trip", "event", 1),
        entry("mem-seat", "preference", 1),
    ];
    let by_id = HashMap::from([("m-1".to_owned(), source("m-1", "We got back from Lisbon."))]);
    let blocked = HashSet::from(["mem-seat".to_owned()]);
    let output = archives(json!([
        { "target_memory_id": " mem-trip ", "reason": "The Lisbon trip is over.",
          "source_message_ids": ["m-1", "invented"] },
        { "target_memory_id": "mem-trip", "reason": "duplicate" },
        { "target_memory_id": "mem-seat" },
        { "target_memory_id": "mem-unknown" },
    ]));

    let proposals =
        archive::model_archive_proposals(&output, &related, &blocked, &by_id, memory::LOCAL_USER);
    assert_eq!(proposals.len(), 1, "{proposals:?}");
    let proposal = &proposals[0];
    assert_eq!(proposal.operation, memory::MemoryProposalOperation::Archive);
    assert_eq!(proposal.target_memory_id.as_deref(), Some("mem-trip"));
    assert_eq!(proposal.rationale, "The Lisbon trip is over.");
    // The draft writes nothing: empty content, the target's classification.
    assert_eq!(proposal.draft.content, "");
    assert_eq!(proposal.draft.scope, memory::MemoryScope::Project);
    assert_eq!(proposal.draft.scope_id.as_deref(), Some("/work/ryu"));
    assert_eq!(proposal.draft.category, memory::MemoryCategory::Event);
    let provenance = &proposal.draft.metadata.provenance;
    assert_eq!(provenance.message_ids, ["m-1"]);
    assert_eq!(provenance.memory_ids, ["mem-trip"]);
    assert_eq!(
        proposal.draft.sources[0].excerpt,
        "We got back from Lisbon."
    );

    // Without a reason or citations the archive still stands, with a fallback.
    let bare = archive::model_archive_proposals(
        &archives(json!([{ "target_memory_id": "mem-trip" }])),
        &related,
        &HashSet::new(),
        &HashMap::new(),
        memory::LOCAL_USER,
    );
    assert_eq!(bare.len(), 1);
    assert!(bare[0].draft.sources.is_empty());
    assert!(!bare[0].rationale.is_empty());
}

pub(super) async fn record_event(state: &ServerState, content: &str) -> String {
    let mut event = memory::NewMemory::user_fact(content);
    event.category = memory::MemoryCategory::Event;
    state
        .memory
        .record_full(memory::LOCAL_USER, "default", event)
        .await
        .unwrap()
        .unwrap()
}

/// A time at which every memory recorded now is past the stale-event age.
pub(super) fn far_future() -> i64 {
    chrono::Utc::now().timestamp_millis() + DREAM_STALE_EVENT_AGE_MS + DAY_MS
}

#[tokio::test]
async fn stale_events_are_proposed_once_and_a_rejection_is_remembered() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let stale = record_event(&state, "Flew to Lisbon on 3 March").await;
    let used = record_event(&state, "Moved house in April").await;
    state
        .memory
        .mark_recalled(&[used.clone()], chrono::Utc::now().timestamp_millis())
        .await
        .unwrap();

    // Nothing is stale yet.
    let now = chrono::Utc::now().timestamp_millis();
    let proposed =
        archive::propose_stale_event_archives(&state, &None, memory::LOCAL_USER, false, now)
            .await
            .unwrap();
    assert_eq!(proposed, 0);

    let later = far_future();
    let proposed =
        archive::propose_stale_event_archives(&state, &None, memory::LOCAL_USER, false, later)
            .await
            .unwrap();
    assert_eq!(proposed, 1, "only the never-recalled event is stale");
    let pending = candidates::pending_proposals(&state, memory::LOCAL_USER, false)
        .await
        .unwrap();
    let body = wire::review_body("manual", &pending, None, None);
    let listed = &body["review"]["proposals"][0];
    assert_eq!(listed["operation"], "archive");
    assert_eq!(listed["target_memory_id"], stale.as_str());
    assert_eq!(listed["current"]["content"], "Flew to Lisbon on 3 March");
    assert_eq!(listed["proposed"]["content"], "");
    assert_eq!(listed["reason"], DREAM_STALE_EVENT_REASON);

    // A pending archive is not proposed twice.
    let again =
        archive::propose_stale_event_archives(&state, &None, memory::LOCAL_USER, false, later)
            .await
            .unwrap();
    assert_eq!(again, 0);

    // Once rejected, it is not proposed again either, and stays active.
    let proposal_id = listed["id"].as_str().unwrap().to_owned();
    let response =
        routes::reject_dream_proposal(State(state.clone()), Extension(None), Path(proposal_id))
            .await;
    assert_eq!(response.status(), StatusCode::OK);
    let after_reject =
        archive::propose_stale_event_archives(&state, &None, memory::LOCAL_USER, false, later)
            .await
            .unwrap();
    assert_eq!(after_reject, 0);
    let entry = state.memory.get(&stale).await.unwrap().unwrap();
    assert_eq!(entry.lifecycle, memory::MemoryLifecycle::Active);
}

#[tokio::test]
async fn accepting_an_archive_takes_the_memory_out_of_recall() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let target = record_event(&state, "Conference in Porto next week").await;
    archive::propose_stale_event_archives(&state, &None, memory::LOCAL_USER, false, far_future())
        .await
        .unwrap();
    let pending = candidates::pending_proposals(&state, memory::LOCAL_USER, false)
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);

    let response = routes::accept_dream_proposal(
        State(state.clone()),
        Extension(None),
        Path(pending[0].proposal.id.clone()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let archived = state.memory.get(&target).await.unwrap().unwrap();
    assert_eq!(archived.lifecycle, memory::MemoryLifecycle::Archived);
    let recalled = state
        .memory
        .recall_visible_scoped_for_agent(
            memory::LOCAL_USER,
            &[],
            None,
            None,
            memory::MemoryVisibility::for_caller_in_org(None, None, false),
            20,
            false,
        )
        .await
        .unwrap();
    assert!(recalled.is_empty(), "{recalled:?}");
}

#[tokio::test]
async fn accepting_a_proposal_whose_memory_was_deleted_is_a_conflict() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let target = record_event(&state, "Conference in Porto next week").await;
    archive::propose_stale_event_archives(&state, &None, memory::LOCAL_USER, false, far_future())
        .await
        .unwrap();
    let pending = candidates::pending_proposals(&state, memory::LOCAL_USER, false)
        .await
        .unwrap();
    let proposal_id = pending[0].proposal.id.clone();

    let deleted =
        crate::server::delete_memory(State(state.clone()), Extension(None), Path(target.clone()))
            .await;
    assert_eq!(deleted.status(), StatusCode::OK);
    // The delete rejected the proposal, so it left the review queue.
    let pending = candidates::pending_proposals(&state, memory::LOCAL_USER, false)
        .await
        .unwrap();
    assert!(pending.is_empty());

    let response = routes::accept_dream_proposal(
        State(state.clone()),
        Extension(None),
        Path(proposal_id.clone()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let proposal = state
        .memory
        .get_proposal(&proposal_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(proposal.status, memory::MemoryProposalStatus::Rejected);
    assert_eq!(proposal.reviewed_by.as_deref(), Some("system"));
    assert_eq!(state.memory.count().await.unwrap(), 0);

    // Rejecting it reports the cause too: the store already rejected it.
    let rejected =
        routes::reject_dream_proposal(State(state.clone()), Extension(None), Path(proposal_id))
            .await;
    assert_eq!(rejected.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn a_model_archive_never_targets_a_memory_revised_in_the_same_run() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let revised = record_event(&state, "Trip to Lisbon in May").await;
    let retired = record_event(&state, "Dentist appointment on Friday").await;
    let related = [
        state.memory.get(&revised).await.unwrap().unwrap(),
        state.memory.get(&retired).await.unwrap().unwrap(),
    ];
    let sources = [source(
        "m-1",
        "The Lisbon trip moved to June; the dentist visit is done.",
    )];
    let output = prompt::parse_model_output(
        &json!({
            "revisions": [{
                "target_memory_id": revised,
                "content": "Trip to Lisbon in June",
                "source_message_ids": ["m-1"],
            }],
            "archive": [
                { "target_memory_id": revised, "reason": "moved" },
                { "target_memory_id": retired, "reason": "The appointment is over.",
                  "source_message_ids": ["m-1"] },
            ],
        })
        .to_string(),
    )
    .unwrap();

    candidates::store_model_output(
        &state,
        &None,
        memory::LOCAL_USER,
        false,
        &output,
        &sources,
        &related,
    )
    .await
    .unwrap();

    let pending = candidates::pending_proposals(&state, memory::LOCAL_USER, false)
        .await
        .unwrap();
    let mut operations: Vec<(memory::MemoryProposalOperation, Option<String>)> = pending
        .iter()
        .map(|item| {
            (
                item.proposal.operation,
                item.proposal.target_memory_id.clone(),
            )
        })
        .collect();
    operations.sort_by_key(|(operation, _)| *operation == memory::MemoryProposalOperation::Archive);
    assert_eq!(
        operations,
        [
            (memory::MemoryProposalOperation::Revise, Some(revised)),
            (memory::MemoryProposalOperation::Archive, Some(retired)),
        ]
    );
}
