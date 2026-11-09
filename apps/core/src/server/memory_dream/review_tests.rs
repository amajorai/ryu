//! Accepting and rejecting Dream proposals over HTTP report the proposal's
//! real state: a review that could not change it is a 409 whose `code` names
//! why, and nothing is written or undone by the refused request.

use axum::{
    body::to_bytes,
    extract::{Path, State},
    http::StatusCode,
    response::Response,
    Extension,
};
use serde_json::Value;

use super::{review, rollback, routes};
use crate::server::{memory, ServerState};

fn state(directory: &std::path::Path) -> ServerState {
    crate::server::isolated_plugin_hook_test_state(directory)
}

async fn status_and_body(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

async fn record(state: &ServerState, content: &str) -> String {
    state
        .memory
        .record(memory::LOCAL_USER, "default", content)
        .await
        .unwrap()
        .unwrap()
}

async fn propose(state: &ServerState, target: Option<&str>, content: &str) -> String {
    let operation = if target.is_some() {
        memory::MemoryProposalOperation::Revise
    } else {
        memory::MemoryProposalOperation::Create
    };
    state
        .memory
        .create_proposal(memory::NewMemoryProposal {
            owner_user_id: memory::LOCAL_USER.to_owned(),
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

async fn accept(state: &ServerState, id: &str) -> (StatusCode, Value) {
    status_and_body(
        routes::accept_dream_proposal(State(state.clone()), Extension(None), Path(id.to_owned()))
            .await,
    )
    .await
}

async fn reject(state: &ServerState, id: &str) -> (StatusCode, Value) {
    status_and_body(
        routes::reject_dream_proposal(State(state.clone()), Extension(None), Path(id.to_owned()))
            .await,
    )
    .await
}

async fn proposal(state: &ServerState, id: &str) -> memory::MemoryRevisionProposal {
    state.memory.get_proposal(id).await.unwrap().unwrap()
}

fn assert_conflict((status, body): (StatusCode, Value), code: &str) {
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], code, "{body}");
    assert!(body["error"]
        .as_str()
        .is_some_and(|error| !error.is_empty()));
}

#[tokio::test]
async fn rejecting_a_pending_proposal_succeeds_and_rejecting_it_again_is_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let id = propose(&state, None, "Prefers green tea").await;

    let (status, body) = reject(&state, &id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["success"], true);
    let rejected = proposal(&state, &id).await;
    assert_eq!(rejected.status, memory::MemoryProposalStatus::Rejected);

    let (status, body) = reject(&state, &id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        proposal(&state, &id).await.reviewed_at,
        rejected.reviewed_at
    );
    assert_eq!(state.memory.count().await.unwrap(), 0);

    // Accepting what a reviewer rejected writes nothing.
    assert_conflict(accept(&state, &id).await, "already_rejected");
    assert_eq!(state.memory.count().await.unwrap(), 0);
}

#[tokio::test]
async fn rejecting_an_accepted_proposal_is_a_conflict_that_keeps_the_memory() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let id = propose(&state, None, "Prefers green tea").await;
    let (status, body) = accept(&state, &id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let written = body["memory"]["id"].as_str().unwrap().to_owned();

    assert_conflict(reject(&state, &id).await, "already_accepted");
    assert_eq!(
        proposal(&state, &id).await.status,
        memory::MemoryProposalStatus::Applied
    );
    let entry = state.memory.get(&written).await.unwrap().unwrap();
    assert_eq!(entry.lifecycle, memory::MemoryLifecycle::Active);

    // Accepting it again returns the same memory.
    let (status, body) = accept(&state, &id).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["memory"]["id"], written.as_str());
}

#[tokio::test]
async fn reviewing_an_undone_proposal_is_a_conflict() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let id = propose(&state, None, "Prefers green tea").await;
    assert_eq!(accept(&state, &id).await.0, StatusCode::OK);
    let undone =
        rollback::rollback_dream_proposal(State(state.clone()), Extension(None), Path(id.clone()))
            .await;
    assert_eq!(undone.status(), StatusCode::OK);

    assert_conflict(reject(&state, &id).await, "already_undone");
    assert_conflict(accept(&state, &id).await, "already_undone");
    assert_eq!(
        proposal(&state, &id).await.status,
        memory::MemoryProposalStatus::RolledBack
    );
}

#[tokio::test]
async fn reviewing_a_proposal_whose_target_was_deleted_says_so() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let target = record(&state, "Prefers aisle seats").await;
    let id = propose(&state, Some(&target), "Prefers window seats").await;
    assert!(state.memory.delete(&target).await.unwrap());

    assert_conflict(reject(&state, &id).await, "target_deleted");
    assert_conflict(accept(&state, &id).await, "target_deleted");
    assert!(proposal(&state, &id).await.rejected_by_system());
    assert_eq!(state.memory.count().await.unwrap(), 0);
}

#[tokio::test]
async fn accepting_a_revision_of_a_memory_revised_since_is_a_conflict_left_pending() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let target = record(&state, "Prefers aisle seats").await;
    let first = propose(&state, Some(&target), "Prefers window seats").await;
    let second = propose(&state, Some(&target), "Prefers middle seats").await;
    assert_eq!(accept(&state, &first).await.0, StatusCode::OK);

    assert_conflict(accept(&state, &second).await, "target_changed");
    // Nothing was written, and the reviewer can still decline it.
    assert_eq!(
        proposal(&state, &second).await.status,
        memory::MemoryProposalStatus::Pending
    );
    let (status, _) = reject(&state, &second).await;
    assert_eq!(status, StatusCode::OK);
}

#[test]
fn conflict_codes_are_stable_wire_values() {
    let codes = [
        review::ReviewConflict::AlreadyAccepted,
        review::ReviewConflict::AlreadyRejected,
        review::ReviewConflict::AlreadyUndone,
        review::ReviewConflict::TargetDeleted,
        review::ReviewConflict::TargetChanged,
    ]
    .map(review::ReviewConflict::code);
    assert_eq!(
        codes,
        [
            "already_accepted",
            "already_rejected",
            "already_undone",
            "target_deleted",
            "target_changed",
        ]
    );
}
