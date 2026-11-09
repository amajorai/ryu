//! Dream archive bounds: the stale-event sweep finds an old candidate behind
//! hundreds of newer events, and neither the sweep nor a model archive brings
//! back an archive the user declined before hundreds of later declines.

use serde_json::json;

use super::archive::{self, DREAM_MAX_STALE_EVENT_ARCHIVES, DREAM_STALE_EVENT_REASON};
use super::archive_tests::{far_future, record_event, state};
use super::{candidates, prompt};
use crate::server::{memory, ServerState};

async fn propose(state: &ServerState) -> usize {
    archive::propose_stale_event_archives(state, &None, memory::LOCAL_USER, false, far_future())
        .await
        .unwrap()
}

async fn pending_archive_targets(state: &ServerState) -> Vec<String> {
    candidates::pending_proposals(state, memory::LOCAL_USER, false)
        .await
        .unwrap()
        .into_iter()
        .filter(|item| item.proposal.operation == memory::MemoryProposalOperation::Archive)
        .filter_map(|item| item.proposal.target_memory_id)
        .collect()
}

async fn reject_pending(state: &ServerState) {
    let pending = candidates::pending_proposals(state, memory::LOCAL_USER, false)
        .await
        .unwrap();
    for item in pending {
        state
            .memory
            .review_proposal(&item.proposal.id, false, Some(memory::LOCAL_USER))
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn an_old_stale_event_is_proposed_behind_more_than_500_newer_events() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let oldest = record_event(&state, "Flew to Lisbon on 3 March").await;
    let mut newer = Vec::new();
    for n in 0..600 {
        newer.push(record_event(&state, &format!("Visited market number {n}")).await);
    }
    // Every newer event was used in a chat, so only the oldest is stale.
    let now = chrono::Utc::now().timestamp_millis();
    for chunk in newer.chunks(memory::MAX_MARK_RECALLED_IDS) {
        state.memory.mark_recalled(chunk, now).await.unwrap();
    }

    assert_eq!(propose(&state).await, 1);
    assert_eq!(pending_archive_targets(&state).await, [oldest]);
}

#[tokio::test]
async fn an_archive_declined_before_hundreds_of_later_declines_is_not_proposed_again() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    let declined = record_event(&state, "Conference in Porto next week").await;
    assert_eq!(propose(&state).await, 1);
    reject_pending(&state).await;

    // 250 later archives, each declined after the first one.
    for round in 0..50 {
        for n in 0..DREAM_MAX_STALE_EVENT_ARCHIVES {
            record_event(&state, &format!("Dinner booking {round}-{n}")).await;
        }
        assert_eq!(propose(&state).await, DREAM_MAX_STALE_EVENT_ARCHIVES);
        assert!(!pending_archive_targets(&state).await.contains(&declined));
        reject_pending(&state).await;
    }
    let rejected = state
        .memory
        .list_proposals(
            memory::LOCAL_USER,
            &memory::MemoryProposalFilter {
                status: Some(memory::MemoryProposalStatus::Rejected),
                limit: Some(500),
            },
        )
        .await
        .unwrap();
    assert_eq!(rejected.len(), 251);

    // The sweep proposes only a new event, never the long-ago decline.
    assert_eq!(propose(&state).await, 0);
    let fresh = record_event(&state, "Flight to Oslo on Friday").await;
    assert_eq!(propose(&state).await, 1);
    let pending = candidates::pending_proposals(&state, memory::LOCAL_USER, false)
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(
        pending[0].proposal.target_memory_id.as_deref(),
        Some(fresh.as_str())
    );
    assert_eq!(pending[0].proposal.rationale, DREAM_STALE_EVENT_REASON);
    reject_pending(&state).await;

    // A model archive of the declined memory is dropped too.
    let related = [state.memory.get(&declined).await.unwrap().unwrap()];
    let output = prompt::parse_model_output(
        &json!({ "archive": [{ "target_memory_id": declined, "reason": "It is over." }] })
            .to_string(),
    )
    .unwrap();
    candidates::store_model_output(
        &state,
        &None,
        memory::LOCAL_USER,
        false,
        &output,
        &[],
        &related,
    )
    .await
    .unwrap();
    assert!(pending_archive_targets(&state).await.is_empty());
    let entry = state.memory.get(&declined).await.unwrap().unwrap();
    assert_eq!(entry.lifecycle, memory::MemoryLifecycle::Active);
}
