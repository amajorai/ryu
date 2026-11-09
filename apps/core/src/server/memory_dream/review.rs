//! Accepting and rejecting a Dream proposal, and keeping retrieval in step
//! with what an acceptance wrote.
//!
//! Both answers describe the proposal's real state. A review that could not
//! change the proposal is a 409 whose `code` names why ([`ReviewConflict`]), so
//! a client can tell "someone already handled it" from "the memory it would
//! change is gone". Rejecting a proposal a reviewer already rejected stays an
//! idempotent success: the proposal is in the state the caller asked for.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

use crate::server::{memory, retrieval::RetrievalStore};

/// Why a review left a proposal unchanged. Sent as the 409's `code`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReviewConflict {
    /// A reviewer accepted it before.
    AlreadyAccepted,
    /// A reviewer rejected it before.
    AlreadyRejected,
    /// It was accepted and then undone.
    AlreadyUndone,
    /// The memory it targeted was deleted (the store rejected it then).
    TargetDeleted,
    /// The memory it targeted was revised or archived since it was proposed.
    TargetChanged,
}

impl ReviewConflict {
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::AlreadyAccepted => "already_accepted",
            Self::AlreadyRejected => "already_rejected",
            Self::AlreadyUndone => "already_undone",
            Self::TargetDeleted => "target_deleted",
            Self::TargetChanged => "target_changed",
        }
    }

    fn response(self) -> Response {
        let code = self.code();
        match self {
            Self::AlreadyAccepted => conflict(code, "proposal was already accepted"),
            Self::AlreadyRejected => conflict(code, "proposal was already rejected"),
            Self::AlreadyUndone => conflict(code, "proposal was accepted and then undone"),
            Self::TargetDeleted => conflict(code, "the memory this proposal targets was deleted"),
            Self::TargetChanged => conflict(
                code,
                "the memory this proposal targets changed since it was proposed",
            ),
        }
    }
}

/// A 409 carrying the conflict's `code` beside its message.
fn conflict(code: &str, message: &str) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "error": message, "code": code })),
    )
        .into_response()
}

/// The conflict a reviewed proposal reports, or `None` when it is in the
/// state the review asked for (applied for accept; rejected by a reviewer for
/// reject).
pub(super) fn review_conflict(
    proposal: &memory::MemoryRevisionProposal,
    approve: bool,
) -> Option<ReviewConflict> {
    match proposal.status {
        memory::MemoryProposalStatus::Applied if approve => None,
        memory::MemoryProposalStatus::Applied => Some(ReviewConflict::AlreadyAccepted),
        memory::MemoryProposalStatus::RolledBack => Some(ReviewConflict::AlreadyUndone),
        memory::MemoryProposalStatus::Rejected if proposal.rejected_by_system() => {
            Some(ReviewConflict::TargetDeleted)
        }
        memory::MemoryProposalStatus::Rejected if approve => Some(ReviewConflict::AlreadyRejected),
        memory::MemoryProposalStatus::Rejected => None,
        // The store reviews a pending proposal before returning it.
        memory::MemoryProposalStatus::Pending => None,
    }
}

/// The store refuses an approval, changing nothing, when the target it would
/// replace or archive is gone or no longer active. Anything else that is not a
/// database failure is a proposal that cannot be applied as it stands.
fn approval_error(error: &anyhow::Error) -> Response {
    if error
        .chain()
        .any(|cause| cause.downcast_ref::<rusqlite::Error>().is_some())
    {
        return crate::server::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    match error.to_string().as_str() {
        "target memory no longer exists" => ReviewConflict::TargetDeleted.response(),
        "target memory is no longer active" => ReviewConflict::TargetChanged.response(),
        message => crate::server::json_error(StatusCode::UNPROCESSABLE_ENTITY, message.to_owned()),
    }
}

pub(super) async fn review_dream_proposal(
    memory: memory::MemoryStore,
    retrieval: RetrievalStore,
    owner: String,
    reviewer: Option<String>,
    id: &str,
    approve: bool,
) -> Response {
    let proposal = match memory.get_proposal(id).await {
        Ok(Some(proposal)) if proposal.owner_user_id == owner => proposal,
        Ok(_) => {
            return crate::server::json_error(
                StatusCode::NOT_FOUND,
                "proposal not found".to_owned(),
            )
        }
        Err(error) => {
            return crate::server::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    if approve
        && proposal.status == memory::MemoryProposalStatus::Pending
        && !memory::detect_sensitive_topics(&proposal.draft.content).is_empty()
        && !memory
            .include_sensitive_topics(&owner)
            .await
            .unwrap_or(false)
    {
        return crate::server::json_error(
            StatusCode::BAD_REQUEST,
            "sensitive topics are disabled in Settings → Memory".to_owned(),
        );
    }
    // The store reviews only a pending proposal and otherwise returns it as it
    // is, so the returned state is what the conflict is judged on, including
    // a concurrent review that won the race.
    let reviewed = match memory
        .review_proposal(id, approve, reviewer.as_deref())
        .await
    {
        Ok(Some(reviewed)) => reviewed,
        Ok(None) => {
            return crate::server::json_error(
                StatusCode::NOT_FOUND,
                "proposal not found".to_owned(),
            );
        }
        Err(error) if approve => return approval_error(&error),
        Err(error) => {
            return crate::server::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    if let Some(conflict) = review_conflict(&reviewed, approve) {
        return conflict.response();
    }
    if !approve {
        return Json(json!({ "success": true })).into_response();
    }
    let Some(memory_id) = reviewed.applied_memory_id.as_deref() else {
        return crate::server::json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "accepted proposal did not produce a memory".to_owned(),
        );
    };
    match memory.get(memory_id).await {
        Ok(Some(entry)) if entry.lifecycle != memory::MemoryLifecycle::Active => {
            // An accepted archive retires its target: drop the derived vector so
            // auto-recall stops finding it, and never re-index it.
            let _ = retrieval.remove_chunk(&entry.id).await;
            Json(json!({ "memory": entry })).into_response()
        }
        Ok(Some(entry)) => {
            if let Some(superseded_id) = entry.supersedes_id.as_deref() {
                // A revision creates a new source row; remove the old derived
                // vector before it can remain recallable as a stale answer.
                let _ = retrieval.remove_chunk(superseded_id).await;
            }
            index_reviewed_memory(memory.clone(), retrieval, entry.clone()).await;
            Json(json!({ "memory": entry })).into_response()
        }
        Ok(None) => crate::server::json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "accepted memory could not be read back".to_owned(),
        ),
        Err(error) => {
            crate::server::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        }
    }
}

pub(super) async fn index_reviewed_memory(
    memory: memory::MemoryStore,
    retrieval: RetrievalStore,
    entry: memory::LongTermEntry,
) {
    let consent_user = entry.owner_user_id.as_deref().unwrap_or(memory::LOCAL_USER);
    if !entry.sensitive_topics.is_empty()
        && !memory
            .include_sensitive_topics(consent_user)
            .await
            .unwrap_or(false)
    {
        let _ = retrieval.remove_chunk(&entry.id).await;
        return;
    }
    let node_org = crate::server::node_org_id();
    let owner = match (node_org.as_deref(), entry.owner_user_id.as_deref()) {
        (Some(org), Some(uid)) if uid != memory::LOCAL_USER => {
            crate::server::retrieval::RetrievalOwner::owned(Some(uid), Some(org), None)
        }
        _ => crate::server::retrieval::RetrievalOwner::shared(),
    };
    if let Err(error) = retrieval
        .index_memory_chunk_with_metadata(
            &entry.id,
            &entry.content,
            entry.scope.as_str(),
            entry.scope_id.as_deref(),
            entry.category.as_str(),
            entry.importance,
            entry.author_agent_id.as_deref(),
            !entry.sensitive_topics.is_empty(),
            owner,
        )
        .await
    {
        tracing::warn!(
            "memory: indexing entry {} failed (search may lag): {error:#}",
            entry.id
        );
    }
}
