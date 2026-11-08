//! One Dream review run: load sources and the related existing memories,
//! skip an automatic run with nothing new, call the model, then filter,
//! dedupe and store the candidate memories and revisions as pending
//! proposals.

use std::collections::{HashMap, HashSet};

use axum::http::StatusCode;
use serde_json::Value;

use super::language;
use super::prompt::{dream_prompt, parse_model_output, resolve_dream_model, DreamModelOutput};
use super::proposal_draft::candidate_proposal;
use super::reconcile::{load_related_memories, pending_revision_targets, revision_proposals};
use super::run_state::{newest_source_at, read_run_state, record_run, should_skip, DreamRunState};
use super::sources::{load_sources, DreamSource};
use super::wire::{pending_summary, review_body, ReviewProposal};
use super::{DREAM_MAX_MEMORY_CHARS, DREAM_MAX_REASON_CHARS};
use crate::server::{memory, ServerState};

/// Run one Dream decomposition using the same path for manual and automatic
/// reviews. Keeping proposal creation in one function prevents the scheduler
/// from becoming a second, weaker implementation of the review contract.
pub(super) async fn run_dream_review_inner(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    mode: &str,
) -> Result<Value, (StatusCode, String)> {
    if !state.conversations.chat_memory_enabled() {
        return Err((
            StatusCode::CONFLICT,
            "turn on Remember chats before running Dream review".to_owned(),
        ));
    }

    let owner = crate::server::memory_owner_user_id(caller);
    let include_sensitive = state
        .memory
        .include_sensitive_topics(&owner)
        .await
        .unwrap_or(false);
    let sources = load_sources(state, caller, include_sensitive)
        .await
        .map_err(internal)?;
    let previous = read_run_state(state).await;
    let newest = newest_source_at(&sources);
    if mode == "automatic" && should_skip(newest, previous.last_source_at) {
        // Nothing newer than the last completed run: show the queue as it is
        // instead of re-sending the same chats to the model.
        let proposals = pending_proposals(state, &owner, include_sensitive)
            .await
            .map_err(internal)?;
        let summary = pending_summary(&proposals);
        return Ok(review_body(mode, &proposals, summary, previous.last_run));
    }
    if sources.is_empty() {
        let run_at = finish_run(state, previous, None).await;
        return Ok(review_body(
            mode,
            &[],
            Some("No recent chat sources are available to decompose."),
            Some(run_at),
        ));
    }

    let related = load_related_memories(state, caller, &owner, include_sensitive, &sources)
        .await
        .map_err(internal)?;
    let (model, effort) = resolve_dream_model(state).await;
    let (system, user) = dream_prompt(&sources, &related);
    let system = language::with_dream_language(system, crate::i18n::locale::node_locale().await);
    let raw = crate::server::call_side_model(
        state,
        &crate::sidecar::gateway::SidePurpose::MemoryDream,
        &model,
        &effort,
        &system,
        &user,
    )
    .await
    .map_err(|error| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Dream model unavailable: {error}"),
        )
    })?;
    let output = parse_model_output(&raw).map_err(|error| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Dream returned invalid structured output: {error}"),
        )
    })?;

    store_model_output(
        state,
        caller,
        &owner,
        include_sensitive,
        &output,
        &sources,
        &related,
    )
    .await
    .map_err(internal)?;

    let proposals = pending_proposals(state, &owner, include_sensitive)
        .await
        .map_err(internal)?;
    let summary = bounded_text(
        output
            .summary
            .as_deref()
            .unwrap_or("Dream decomposed recent chats into reviewable memory suggestions."),
        DREAM_MAX_REASON_CHARS,
    );
    let run_at = finish_run(state, previous, newest).await;
    Ok(review_body(
        mode,
        &proposals,
        summary.as_deref(),
        Some(run_at),
    ))
}

/// Store the model's output as pending proposals: new memories that are not
/// already known, and revisions of the `related` memories the model was shown.
/// Both must cite messages from `sources`.
pub(super) async fn store_model_output(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    owner: &str,
    include_sensitive: bool,
    output: &DreamModelOutput,
    sources: &[DreamSource],
    related: &[memory::LongTermEntry],
) -> anyhow::Result<()> {
    let mut known = known_content(state, caller, owner, include_sensitive).await?;
    let source_by_id: HashMap<String, DreamSource> = sources
        .iter()
        .cloned()
        .map(|source| (source.message_id.clone(), source))
        .collect();

    // Revisions first: a correction should win over a new memory restating it.
    let pending_targets = pending_revision_targets(state, owner).await?;
    let revisions = revision_proposals(
        &output.revisions,
        related,
        &pending_targets,
        &source_by_id,
        &mut known,
        owner,
        include_sensitive,
    );
    for proposal in revisions {
        store_proposal(state, proposal).await;
    }

    for candidate in output.memories.iter().take(20) {
        let Some(content) = bounded_text(&candidate.content, DREAM_MAX_MEMORY_CHARS) else {
            continue;
        };
        if !include_sensitive && !memory::detect_sensitive_topics(&content).is_empty() {
            continue;
        }
        let key = normalize_key(&content);
        if key.is_empty() || known.contains(&key) {
            continue;
        }
        let Some(proposal) = candidate_proposal(candidate, content, &source_by_id, owner) else {
            continue;
        };
        known.insert(key);
        store_proposal(state, proposal).await;
    }
    Ok(())
}

/// Store one proposal. A proposal the store refuses is logged and skipped, so
/// one bad suggestion cannot fail the run, drop the rest of its proposals, or
/// keep the watermark from advancing.
async fn store_proposal(state: &ServerState, proposal: memory::NewMemoryProposal) {
    if let Err(error) = state.memory.create_proposal(proposal).await {
        tracing::warn!("Dream skipped a proposal the memory store refused: {error:#}");
    }
}

fn internal(error: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

/// Persist the run watermark after proposals are written. A failure here only
/// costs one repeated model call on the next tick, so it is logged, not fatal.
async fn finish_run(state: &ServerState, previous: DreamRunState, newest: Option<i64>) -> i64 {
    let run_at = chrono::Utc::now().timestamp_millis();
    if let Err(error) = record_run(state, previous, newest, run_at).await {
        tracing::warn!("Dream could not record its run watermark: {error:#}");
    }
    run_at
}

/// How many declined (rejected or rolled-back) proposals of each status feed
/// deduplication, so a fact the user turned down is not proposed again.
const DREAM_DECLINED_LIMIT: usize = 200;

/// Normalized content Dream must not propose again: active memories the caller
/// can see, proposals still waiting for review, and proposals the user
/// rejected or rolled back.
pub(super) async fn known_content(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    owner: &str,
    include_sensitive: bool,
) -> anyhow::Result<HashSet<String>> {
    let active = state
        .memory
        .list_visible_with_sensitive(
            &memory::MemoryFilter {
                lifecycle: Some(memory::MemoryLifecycle::Active),
                limit: Some(500),
                ..Default::default()
            },
            memory_visibility(caller),
            include_sensitive,
        )
        .await?;
    let mut known: HashSet<String> = active
        .iter()
        .map(|entry| normalize_key(&entry.content))
        .collect();
    let statuses = [
        (memory::MemoryProposalStatus::Pending, 100),
        (memory::MemoryProposalStatus::Rejected, DREAM_DECLINED_LIMIT),
        (
            memory::MemoryProposalStatus::RolledBack,
            DREAM_DECLINED_LIMIT,
        ),
    ];
    for (status, limit) in statuses {
        let proposals = state
            .memory
            .list_proposals(
                owner,
                &memory::MemoryProposalFilter {
                    status: Some(status),
                    limit: Some(limit),
                },
            )
            .await?;
        known.extend(
            proposals
                .iter()
                .map(|proposal| normalize_key(&proposal.draft.content)),
        );
    }
    Ok(known)
}

/// The owner's pending proposals, each with the memory a revision would
/// replace. Without sensitive-topic consent, a proposal whose content or
/// target is sensitive is left out.
pub(super) async fn pending_proposals(
    state: &ServerState,
    owner: &str,
    include_sensitive: bool,
) -> anyhow::Result<Vec<ReviewProposal>> {
    let proposals = state
        .memory
        .list_proposals(
            owner,
            &memory::MemoryProposalFilter {
                status: Some(memory::MemoryProposalStatus::Pending),
                limit: Some(100),
            },
        )
        .await?;
    let mut review = Vec::with_capacity(proposals.len());
    for proposal in proposals {
        if !include_sensitive
            && !memory::detect_sensitive_topics(&proposal.draft.content).is_empty()
        {
            continue;
        }
        let current = match proposal.target_memory_id.as_deref() {
            Some(target) => state.memory.get(target).await?,
            None => None,
        };
        if !include_sensitive
            && current
                .as_ref()
                .is_some_and(|entry| !entry.sensitive_topics.is_empty())
        {
            continue;
        }
        review.push(ReviewProposal { proposal, current });
    }
    Ok(review)
}

pub(super) fn memory_visibility(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> memory::MemoryVisibility<'_> {
    memory::MemoryVisibility::for_caller_in_org(
        caller.as_ref().map(|caller| caller.user_id.as_str()),
        caller.as_ref().and_then(|caller| caller.org_id.as_deref()),
        crate::sidecar::control_plane::registered_org().is_some(),
    )
}

pub(super) fn bounded_text(value: &str, max_chars: usize) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(max_chars).collect())
}

pub(super) fn normalize_key(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}
