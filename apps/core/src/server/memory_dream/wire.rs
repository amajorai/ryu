//! Dream's review response bodies and request-mode parsing.

use serde_json::{json, Value};

use crate::server::memory;

/// A proposal as the review lists it: for a revision, the memory it would
/// replace, so the reviewer sees Before and Proposed side by side.
#[derive(Debug, Clone)]
pub(super) struct ReviewProposal {
    pub(super) proposal: memory::MemoryRevisionProposal,
    pub(super) current: Option<memory::LongTermEntry>,
}

/// The review body. `generated_at` is when Dream last ran (Unix ms); it is
/// left out when Dream has never run, which clients show as "not run yet".
pub(super) fn review_body(
    mode: &str,
    proposals: &[ReviewProposal],
    summary: Option<&str>,
    generated_at: Option<i64>,
) -> Value {
    let mut body = json!({
        "review": {
            "mode": mode,
            "proposals": proposals
                .iter()
                .map(|item| proposal_wire(&item.proposal, item.current.as_ref()))
                .collect::<Vec<_>>(),
            "summary": summary,
        }
    });
    if let Some(generated_at) = generated_at {
        body["review"]["generated_at"] = json!(generated_at);
    }
    body
}

/// The summary shown over a queue Dream did not just regenerate.
pub(super) fn pending_summary(proposals: &[ReviewProposal]) -> Option<&'static str> {
    // Clients swap this fallback for their own localized count.
    if proposals.is_empty() {
        None
    } else {
        Some("Chat-derived suggestions waiting for your review.")
    }
}

/// The cited messages behind a proposal. Proposals stored before excerpts
/// were kept fall back to their provenance message ids without text.
fn proposal_sources(draft: &memory::MemoryProposalDraft) -> Vec<Value> {
    if !draft.sources.is_empty() {
        return draft
            .sources
            .iter()
            .map(|source| {
                json!({
                    "conversation_id": source.conversation_id.as_deref(),
                    "excerpt": source.excerpt.as_str(),
                    "message_id": source.message_id.as_str(),
                })
            })
            .collect();
    }
    let provenance = &draft.metadata.provenance;
    let single = provenance.message_ids.len() == 1;
    provenance
        .message_ids
        .iter()
        .map(|message_id| {
            json!({
                "conversation_id": provenance.conversation_id.as_deref().filter(|_| single),
                "excerpt": Value::Null,
                "message_id": message_id,
            })
        })
        .collect()
}

/// The memory a revision would replace, in the same shape as `proposed`.
fn current_wire(entry: &memory::LongTermEntry) -> Value {
    json!({
        "author_agent_id": entry.author_agent_id.as_deref(),
        "category": entry.category.as_str(),
        "content": entry.content.as_str(),
        "created_at": entry.created_at,
        "id": entry.id.as_str(),
        "importance": entry.importance,
        "scope": entry.scope.as_str(),
        "scope_id": entry.scope_id.as_deref(),
        "tags": &entry.tags,
        "updated_at": entry.updated_at,
        "when_to_use": entry.when_to_use.as_deref(),
    })
}

/// One proposal on the wire. `current` is the memory a revision replaces, or
/// `null` for a new memory (and for a revision whose target is gone).
pub(super) fn proposal_wire(
    proposal: &memory::MemoryRevisionProposal,
    current: Option<&memory::LongTermEntry>,
) -> Value {
    let draft = &proposal.draft;
    json!({
        "confidence": draft.metadata.provenance.confidence,
        "created_at": proposal.created_at,
        "current": current.map_or(Value::Null, current_wire),
        "id": proposal.id,
        "operation": proposal.operation,
        "proposed": {
            "author_agent_id": draft.author_agent_id.as_deref(),
            "category": draft.category.as_str(),
            "content": draft.content.as_str(),
            "created_at": proposal.created_at,
            "id": format!("proposal-memory-{}", proposal.id),
            "importance": draft.importance,
            "scope": draft.scope.as_str(),
            "scope_id": draft.scope_id.as_deref(),
            "tags": &draft.tags,
            "updated_at": proposal.updated_at,
            "when_to_use": draft.when_to_use.as_deref(),
        },
        "reason": proposal.rationale.as_str(),
        "source": "Chat decomposition",
        "sources": proposal_sources(draft),
        "status": proposal.status.as_str(),
        "target_memory_id": proposal.target_memory_id.as_deref(),
    })
}

pub(super) fn requested_mode(mode: Option<&str>) -> &'static str {
    if mode.is_some_and(|mode| mode.eq_ignore_ascii_case("automatic")) {
        "automatic"
    } else {
        "manual"
    }
}
