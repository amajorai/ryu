//! Undoing an accepted Dream proposal, and the review's short list of
//! recently accepted proposals that can still be undone.
//!
//! Rollback is the store's guarded transition (`MemoryStore::rollback_proposal`):
//! the memory the proposal wrote is retracted and the memory it replaced, or the
//! one it archived, is active again. This module keeps retrieval in step the
//! way accepting does: the retracted row's vector is removed and the restored
//! row is indexed again, so recall never finds the undone version.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde_json::{json, Value};

use super::review::index_reviewed_memory;
use super::wire::{proposal_wire, ReviewProposal};
use crate::server::{memory, ServerState};

/// How far back the review lists accepted proposals as undoable.
pub(super) const DREAM_RECENT_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1_000;
/// The most accepted proposals the review lists.
pub(super) const DREAM_RECENT_LIMIT: usize = 5;
/// How many applied proposals are read to find the recent ones.
const DREAM_RECENT_SCAN: usize = 100;

#[utoipa::path(
    post,
    path = "/api/memory/dream/review/proposals/{id}/rollback",
    tag = "Memory",
    summary = "Undo an accepted Dream memory proposal",
    description = "Retracts the memory an accepted proposal wrote and makes the memory it replaced or archived active again. Refused with 409 when the proposal is not applied, or when a later change builds on it.",
    params(("id" = String, Path)),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "The caller may not write memory"),
        (status = 404, description = "No such proposal for this caller"),
        (status = 409, description = "The proposal cannot be undone")
    )
)]
pub(in crate::server) async fn rollback_dream_proposal(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = crate::server::require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
    )
    .await
    {
        return response;
    }
    let owner = crate::server::memory_owner_user_id(&caller);
    let reviewer = caller.as_ref().map(|caller| caller.user_id.clone());
    rollback(
        &state.memory,
        &state.retrieval,
        &owner,
        reviewer.as_deref(),
        &id,
    )
    .await
}

async fn rollback(
    memory: &memory::MemoryStore,
    retrieval: &crate::server::retrieval::RetrievalStore,
    owner: &str,
    reviewer: Option<&str>,
    id: &str,
) -> Response {
    match memory.get_proposal(id).await {
        Ok(Some(proposal)) if proposal.owner_user_id == owner => {
            if proposal.status != memory::MemoryProposalStatus::Applied {
                return crate::server::json_error(
                    StatusCode::CONFLICT,
                    "only an accepted proposal can be undone".to_owned(),
                );
            }
        }
        Ok(_) => {
            return crate::server::json_error(
                StatusCode::NOT_FOUND,
                "proposal not found".to_owned(),
            );
        }
        Err(error) => {
            return crate::server::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    }
    let rolled_back = match memory.rollback_proposal(id, reviewer).await {
        Ok(Some(proposal)) if proposal.status == memory::MemoryProposalStatus::RolledBack => {
            proposal
        }
        // A concurrent review changed it first; nothing was undone here.
        Ok(Some(_)) => {
            return crate::server::json_error(
                StatusCode::CONFLICT,
                "proposal is no longer applied".to_owned(),
            );
        }
        Ok(None) => {
            return crate::server::json_error(
                StatusCode::NOT_FOUND,
                "proposal not found".to_owned(),
            );
        }
        // The store refuses, changing nothing, when the written memory was
        // revised or deleted since, or the replaced one is gone. A database
        // failure is reported as one.
        Err(error) if is_storage_error(&error) => {
            return crate::server::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
        Err(error) => {
            return crate::server::json_error(StatusCode::CONFLICT, error.to_string());
        }
    };
    let restored = reindex_after_rollback(memory, retrieval, &rolled_back).await;
    Json(json!({
        "success": true,
        "proposal": proposal_wire(&rolled_back, restored.as_ref()),
        "restored": restored,
    }))
    .into_response()
}

fn is_storage_error(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<rusqlite::Error>().is_some())
}

/// Keep retrieval in step with a rollback: drop the retracted revision's
/// vector and index the memory that is active again. Returns that memory.
async fn reindex_after_rollback(
    memory: &memory::MemoryStore,
    retrieval: &crate::server::retrieval::RetrievalStore,
    proposal: &memory::MemoryRevisionProposal,
) -> Option<memory::LongTermEntry> {
    let restored_id = if proposal.operation == memory::MemoryProposalOperation::Archive {
        // An archive wrote nothing: its target is the memory restored.
        proposal.applied_memory_id.as_deref()
    } else {
        if let Some(retracted) = proposal.applied_memory_id.as_deref() {
            let _ = retrieval.remove_chunk(retracted).await;
        }
        proposal.target_memory_id.as_deref()
    }?;
    let restored = match memory.get(restored_id).await {
        Ok(Some(entry)) if entry.lifecycle == memory::MemoryLifecycle::Active => entry,
        _ => return None,
    };
    index_reviewed_memory(memory.clone(), retrieval.clone(), restored.clone()).await;
    Some(restored)
}

/// Proposals accepted in the last [`DREAM_RECENT_WINDOW_MS`], newest first,
/// that can still be undone: the change they made is still the current one.
/// Sensitive ones are left out unless the caller consented, as in the queue.
pub(super) async fn recent_applied(
    state: &ServerState,
    owner: &str,
    include_sensitive: bool,
    now: i64,
) -> anyhow::Result<Vec<ReviewProposal>> {
    let mut applied = state
        .memory
        .list_proposals(
            owner,
            &memory::MemoryProposalFilter {
                status: Some(memory::MemoryProposalStatus::Applied),
                limit: Some(DREAM_RECENT_SCAN),
            },
        )
        .await?;
    let accepted_at = |proposal: &memory::MemoryRevisionProposal| {
        proposal.reviewed_at.unwrap_or(proposal.updated_at)
    };
    applied.retain(|proposal| accepted_at(proposal) >= now - DREAM_RECENT_WINDOW_MS);
    applied.sort_by_key(|proposal| std::cmp::Reverse(accepted_at(proposal)));

    let mut recent = Vec::new();
    for proposal in applied {
        if recent.len() >= DREAM_RECENT_LIMIT {
            break;
        }
        let Some(written_id) = proposal.applied_memory_id.as_deref() else {
            continue;
        };
        let Some(written) = state.memory.get(written_id).await? else {
            continue;
        };
        let archive = proposal.operation == memory::MemoryProposalOperation::Archive;
        let expected = if archive {
            memory::MemoryLifecycle::Archived
        } else {
            memory::MemoryLifecycle::Active
        };
        if written.lifecycle != expected {
            continue;
        }
        let current = match (archive, proposal.target_memory_id.as_deref()) {
            (true, _) => Some(written.clone()),
            (false, Some(target)) => state.memory.get(target).await?,
            (false, None) => None,
        };
        let sensitive = !written.sensitive_topics.is_empty()
            || current
                .as_ref()
                .is_some_and(|entry| !entry.sensitive_topics.is_empty());
        if sensitive && !include_sensitive {
            continue;
        }
        recent.push(ReviewProposal { proposal, current });
    }
    Ok(recent)
}

/// The recent list on the wire, in the same shape as pending proposals.
pub(super) fn recent_wire(recent: &[ReviewProposal]) -> Value {
    Value::Array(
        recent
            .iter()
            .map(|item| proposal_wire(&item.proposal, item.current.as_ref()))
            .collect(),
    )
}
