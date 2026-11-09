//! Undoing accepted Dream proposals over HTTP: the store transition, the
//! retrieval index kept in step, the recent list in the review, refusals, and
//! the Library's active-by-default listing with history on request.

use axum::{
    body::to_bytes,
    extract::{Path, Query, State},
    http::StatusCode,
    response::Response,
    Extension,
};
use serde_json::{json, Value};

use super::{rollback, routes};
use crate::server::{memory, ServerState};

fn state(directory: &std::path::Path) -> ServerState {
    crate::server::isolated_plugin_hook_test_state(directory)
}

async fn body(response: Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn record(state: &ServerState, content: &str) -> String {
    state
        .memory
        .record(memory::LOCAL_USER, "default", content)
        .await
        .unwrap()
        .unwrap()
}

async fn propose(
    state: &ServerState,
    owner: &str,
    operation: memory::MemoryProposalOperation,
    target: Option<&str>,
    content: &str,
) -> String {
    state
        .memory
        .create_proposal(memory::NewMemoryProposal {
            owner_user_id: owner.to_owned(),
            agent_id: "default".to_owned(),
            target_memory_id: target.map(str::to_owned),
            operation,
            draft: memory::MemoryProposalDraft {
                content: content.to_owned(),
                scope: memory::MemoryScope::User,
                scope_id: None,
                category: memory::MemoryCategory::Preference,
                importance: 3,
                when_to_use: None,
                tags: Vec::new(),
                author_agent_id: None,
                metadata: memory::MemoryMetadata::default(),
                sources: Vec::new(),
            },
            rationale: "The user said so.".to_owned(),
        })
        .await
        .unwrap()
}

async fn accept(state: &ServerState, id: &str) -> Response {
    routes::accept_dream_proposal(State(state.clone()), Extension(None), Path(id.to_owned())).await
}

async fn undo(state: &ServerState, id: &str) -> Response {
    rollback::rollback_dream_proposal(State(state.clone()), Extension(None), Path(id.to_owned()))
        .await
}

async fn lifecycle(state: &ServerState, id: &str) -> memory::MemoryLifecycle {
    state.memory.get(id).await.unwrap().unwrap().lifecycle
}

async fn indexed(state: &ServerState) -> std::collections::HashSet<String> {
    state.retrieval.indexed_memory_ids().await.unwrap()
}

async fn listed(state: &ServerState, query: Value) -> Vec<(String, String)> {
    let query = serde_json::from_value(query).unwrap();
    let response =
        crate::server::list_memory(State(state.clone()), Extension(None), Query(query)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let mut rows: Vec<(String, String)> = body(response).await["memories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["content"].as_str().unwrap().to_owned(),
                entry["lifecycle"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    rows.sort();
    rows
}

fn rows(expected: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut rows: Vec<(String, String)> = expected
        .iter()
        .map(|(content, lifecycle)| ((*content).to_owned(), (*lifecycle).to_owned()))
        .collect();
    rows.sort();
    rows
}

async fn recent_ids(state: &ServerState) -> Vec<String> {
    let now = chrono::Utc::now().timestamp_millis();
    rollback::recent_applied(state, memory::LOCAL_USER, false, now)
        .await
        .unwrap()
        .into_iter()
        .map(|item| item.proposal.id)
        .collect()
}

#[tokio::test]
async fn undoing_a_revision_restores_the_original_in_store_index_and_library() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let target = record(&state, "Prefers aisle seats").await;
    let id = propose(
        &state,
        memory::LOCAL_USER,
        memory::MemoryProposalOperation::Revise,
        Some(&target),
        "Prefers window seats",
    )
    .await;
    assert_eq!(accept(&state, &id).await.status(), StatusCode::OK);
    let revision = state
        .memory
        .get_proposal(&id)
        .await
        .unwrap()
        .unwrap()
        .applied_memory_id
        .unwrap();
    assert!(indexed(&state).await.contains(&revision));
    assert!(!indexed(&state).await.contains(&target));

    // The Library lists what Ryu recalls; history is opt-in.
    assert_eq!(
        listed(&state, json!({})).await,
        rows(&[("Prefers window seats", "active")])
    );
    assert_eq!(
        listed(&state, json!({ "include_history": true })).await,
        rows(&[
            ("Prefers aisle seats", "superseded"),
            ("Prefers window seats", "active"),
        ])
    );
    assert_eq!(
        listed(&state, json!({ "lifecycle": "superseded" })).await,
        rows(&[("Prefers aisle seats", "superseded")])
    );

    // The review offers the accepted revision for undo, with what it replaced.
    assert_eq!(recent_ids(&state).await, [id.clone()]);
    let now = chrono::Utc::now().timestamp_millis();
    let recent = rollback::recent_applied(&state, memory::LOCAL_USER, false, now)
        .await
        .unwrap();
    let wire = rollback::recent_wire(&recent);
    assert_eq!(wire[0]["status"], "applied");
    assert_eq!(wire[0]["current"]["content"], "Prefers aisle seats");
    assert_eq!(wire[0]["proposed"]["content"], "Prefers window seats");

    let response = undo(&state, &id).await;
    assert_eq!(response.status(), StatusCode::OK);
    let undone = body(response).await;
    assert_eq!(undone["proposal"]["status"], "rolled_back");
    assert_eq!(undone["restored"]["id"], target.as_str());

    assert_eq!(
        lifecycle(&state, &target).await,
        memory::MemoryLifecycle::Active
    );
    assert_eq!(
        lifecycle(&state, &revision).await,
        memory::MemoryLifecycle::Retracted
    );
    let index = indexed(&state).await;
    assert!(index.contains(&target), "{index:?}");
    assert!(!index.contains(&revision), "{index:?}");
    assert_eq!(
        listed(&state, json!({})).await,
        rows(&[("Prefers aisle seats", "active")])
    );
    assert_eq!(
        listed(&state, json!({ "include_history": true })).await,
        rows(&[
            ("Prefers aisle seats", "active"),
            ("Prefers window seats", "retracted"),
        ])
    );
    assert!(recent_ids(&state).await.is_empty());

    // Undoing twice is refused and changes nothing.
    assert_eq!(undo(&state, &id).await.status(), StatusCode::CONFLICT);
    assert_eq!(
        lifecycle(&state, &target).await,
        memory::MemoryLifecycle::Active
    );
}

#[tokio::test]
async fn undoing_a_new_memory_retracts_it_and_drops_its_vector() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let id = propose(
        &state,
        memory::LOCAL_USER,
        memory::MemoryProposalOperation::Create,
        None,
        "Drinks green tea",
    )
    .await;
    assert_eq!(accept(&state, &id).await.status(), StatusCode::OK);
    let written = state
        .memory
        .get_proposal(&id)
        .await
        .unwrap()
        .unwrap()
        .applied_memory_id
        .unwrap();
    assert!(indexed(&state).await.contains(&written));

    let response = undo(&state, &id).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await["restored"], Value::Null);
    assert_eq!(
        lifecycle(&state, &written).await,
        memory::MemoryLifecycle::Retracted
    );
    assert!(!indexed(&state).await.contains(&written));
    assert!(listed(&state, json!({})).await.is_empty());
}

#[tokio::test]
async fn undoing_an_archive_makes_the_memory_recallable_again() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let target = record(&state, "Conference in Porto next week").await;
    let id = propose(
        &state,
        memory::LOCAL_USER,
        memory::MemoryProposalOperation::Archive,
        Some(&target),
        "",
    )
    .await;
    assert_eq!(accept(&state, &id).await.status(), StatusCode::OK);
    assert!(!indexed(&state).await.contains(&target));
    let now = chrono::Utc::now().timestamp_millis();
    let recent = rollback::recent_applied(&state, memory::LOCAL_USER, false, now)
        .await
        .unwrap();
    // An archive is listed with the memory it retired.
    assert_eq!(
        rollback::recent_wire(&recent)[0]["current"]["content"],
        "Conference in Porto next week"
    );

    assert_eq!(undo(&state, &id).await.status(), StatusCode::OK);
    assert_eq!(
        lifecycle(&state, &target).await,
        memory::MemoryLifecycle::Active
    );
    assert!(indexed(&state).await.contains(&target));
}

#[tokio::test]
async fn a_revision_built_on_is_not_undone_and_others_proposals_are_hidden() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let target = record(&state, "Prefers aisle seats").await;
    let first = propose(
        &state,
        memory::LOCAL_USER,
        memory::MemoryProposalOperation::Revise,
        Some(&target),
        "Prefers window seats",
    )
    .await;
    assert_eq!(accept(&state, &first).await.status(), StatusCode::OK);
    let revision = state
        .memory
        .get_proposal(&first)
        .await
        .unwrap()
        .unwrap()
        .applied_memory_id
        .unwrap();
    let second = propose(
        &state,
        memory::LOCAL_USER,
        memory::MemoryProposalOperation::Revise,
        Some(&revision),
        "Prefers exit rows",
    )
    .await;
    assert_eq!(accept(&state, &second).await.status(), StatusCode::OK);

    // Only the latest change is offered; undoing the first is refused.
    assert_eq!(recent_ids(&state).await, [second.clone()]);
    assert_eq!(undo(&state, &first).await.status(), StatusCode::CONFLICT);
    assert_eq!(
        lifecycle(&state, &revision).await,
        memory::MemoryLifecycle::Superseded
    );
    assert_eq!(
        lifecycle(&state, &target).await,
        memory::MemoryLifecycle::Superseded
    );

    // Another owner's proposal reads as missing and stays applied.
    let foreign = propose(
        &state,
        "someone-else",
        memory::MemoryProposalOperation::Create,
        None,
        "Lives in Oslo",
    )
    .await;
    state
        .memory
        .review_proposal(&foreign, true, Some("someone-else"))
        .await
        .unwrap();
    assert_eq!(undo(&state, &foreign).await.status(), StatusCode::NOT_FOUND);
    let stored = state.memory.get_proposal(&foreign).await.unwrap().unwrap();
    assert_eq!(stored.status, memory::MemoryProposalStatus::Applied);
    assert_eq!(
        undo(&state, "no-such-proposal").await.status(),
        StatusCode::NOT_FOUND
    );
}
