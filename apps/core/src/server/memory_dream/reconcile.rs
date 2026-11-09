//! Dream reconcile: show the model a bounded set of the caller's existing
//! memories related to the sources, and turn the revisions it proposes into
//! `Revise` proposals. Accepting one supersedes the target, so a wrong or
//! duplicated memory is replaced instead of living on beside its correction.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use super::candidates::{bounded_text, memory_visibility, normalize_key};
use super::prompt::DreamModelRevision;
use super::proposal_draft::{
    cited_sources, clamp_confidence, consolidation_provenance, source_excerpts,
    DREAM_REASON_FALLBACK,
};
use super::sources::DreamSource;
use super::{
    DREAM_MAX_MEMORY_CHARS, DREAM_MAX_REASON_CHARS, DREAM_MAX_RELATED_MEMORIES,
    DREAM_MAX_RELATED_MEMORY_CHARS,
};
use crate::server::retrieval::{ChunkSource, RetrievalOptions};
use crate::server::{memory, ServerState};

/// Longest slice of the joined sources used as the relatedness query, so a
/// long transcript does not become an oversized embedding input.
const DREAM_RELATED_QUERY_CHARS: usize = 4_000;
/// Relatedness only orders the memories; a stalled embedder must not stall
/// Dream, so the lookup gives up and falls back to recency.
const DREAM_RELATED_TIMEOUT: Duration = Duration::from_secs(10);
/// Most revisions one run may propose.
const DREAM_MAX_REVISIONS: usize = 10;

/// The caller's active memories most related to `sources`, for the model to
/// check against them. Only memories the caller can see are candidates (the
/// same visibility filter Dream uses everywhere), and on an org-bound node
/// only the caller's own, so Dream never shows or rewrites a colleague's note.
pub(super) async fn load_related_memories(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    owner: &str,
    include_sensitive: bool,
    sources: &[DreamSource],
) -> anyhow::Result<Vec<memory::LongTermEntry>> {
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    let node_bound = crate::sidecar::control_plane::registered_org().is_some();
    let visible = state
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
    let owned = visible
        .into_iter()
        .filter(|entry| !node_bound || entry_owner(entry) == owner)
        .collect();
    let ranked = related_ids(state, caller, include_sensitive, node_bound, sources).await;
    Ok(select_related(owned, &ranked))
}

pub(super) fn entry_owner(entry: &memory::LongTermEntry) -> &str {
    entry.owner_user_id.as_deref().unwrap_or(memory::LOCAL_USER)
}

/// Memory ids ranked by relatedness to the sources. Empty when retrieval is
/// unavailable; [`select_related`] then falls back to recency.
async fn related_ids(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    include_sensitive: bool,
    node_bound: bool,
    sources: &[DreamSource],
) -> Vec<String> {
    let joined = sources
        .iter()
        .map(|source| source.content.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let query: String = joined.chars().take(DREAM_RELATED_QUERY_CHARS).collect();
    let options = RetrievalOptions {
        top_k: DREAM_MAX_RELATED_MEMORIES,
        space_ids: Some(Vec::new()),
        include_memory: true,
        include_sensitive,
        node_bound,
        caller_user_id: caller.as_ref().map(|caller| caller.user_id.clone()),
        caller_org_id: caller.as_ref().and_then(|caller| caller.org_id.clone()),
        ..RetrievalOptions::default()
    };
    let lookup = state.retrieval.retrieve(&query, &options);
    match tokio::time::timeout(DREAM_RELATED_TIMEOUT, lookup).await {
        Ok(Ok(chunks)) => chunks
            .into_iter()
            .filter(|chunk| chunk.source == ChunkSource::Memory)
            .map(|chunk| chunk.id)
            .collect(),
        Ok(Err(error)) => {
            tracing::debug!("Dream: related-memory lookup failed, using recency: {error:#}");
            Vec::new()
        }
        Err(_) => {
            tracing::debug!("Dream: related-memory lookup timed out, using recency");
            Vec::new()
        }
    }
}

/// Order `candidates` with the `ranked` ids first (in rank order), then the
/// rest by most recently updated, and keep at most
/// [`DREAM_MAX_RELATED_MEMORIES`] within [`DREAM_MAX_RELATED_MEMORY_CHARS`].
/// A ranked id that is not among `candidates` is ignored, so retrieval can
/// only reorder what the caller may see, never add to it.
pub(super) fn select_related(
    candidates: Vec<memory::LongTermEntry>,
    ranked: &[String],
) -> Vec<memory::LongTermEntry> {
    let rank: HashMap<&str, usize> = ranked
        .iter()
        .enumerate()
        .rev()
        .map(|(index, id)| (id.as_str(), index))
        .collect();
    let mut ordered: Vec<(Option<usize>, memory::LongTermEntry)> = candidates
        .into_iter()
        .map(|entry| (rank.get(entry.id.as_str()).copied(), entry))
        .collect();
    ordered.sort_by(
        |(left_rank, left), (right_rank, right)| match (left_rank, right_rank) {
            (Some(left_rank), Some(right_rank)) => left_rank.cmp(right_rank),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => right.updated_at.cmp(&left.updated_at),
        },
    );
    let mut chars = 0;
    let mut selected = Vec::new();
    for (_, entry) in ordered {
        if selected.len() == DREAM_MAX_RELATED_MEMORIES {
            break;
        }
        let cost = entry.content.chars().count() + entry.id.len() + 40;
        if chars + cost > DREAM_MAX_RELATED_MEMORY_CHARS {
            continue;
        }
        chars += cost;
        selected.push(entry);
    }
    selected
}

/// Build the `Revise` proposal for one revision whose `content` is already
/// bounded. Returns `None` when it cites no message that was sent. The new
/// row keeps the target's scope, category and importance; only its content
/// changes.
pub(super) fn revision_proposal(
    revision: &DreamModelRevision,
    content: String,
    target: &memory::LongTermEntry,
    source_by_id: &HashMap<String, DreamSource>,
    owner: &str,
) -> Option<memory::NewMemoryProposal> {
    let cited = cited_sources(&revision.source_message_ids, source_by_id);
    let provenance = consolidation_provenance(
        &cited,
        vec![target.id.clone()],
        clamp_confidence(revision.confidence.as_ref()),
    )?;
    let rationale = revision
        .reason
        .as_deref()
        .and_then(|reason| bounded_text(reason, DREAM_MAX_REASON_CHARS))
        .unwrap_or_else(|| DREAM_REASON_FALLBACK.to_owned());
    let draft = memory::MemoryProposalDraft {
        content,
        scope: target.scope,
        scope_id: target.scope_id.clone(),
        category: target.category,
        importance: target.importance,
        when_to_use: target.when_to_use.clone(),
        tags: target.tags.clone(),
        author_agent_id: Some("dream".to_owned()),
        metadata: memory::MemoryMetadata {
            provenance,
            ..Default::default()
        },
        sources: source_excerpts(&cited),
    };
    Some(memory::NewMemoryProposal {
        owner_user_id: owner.to_owned(),
        agent_id: "dream".to_owned(),
        target_memory_id: Some(target.id.clone()),
        operation: memory::MemoryProposalOperation::Revise,
        draft,
        rationale,
    })
}

/// Validate the model's revisions and build their proposals. A revision is
/// dropped when its target was not among the memories sent (`related`), when
/// that target already has a pending revision or was already revised this
/// run, when it cites no sent message, or when its content is empty, already
/// known, or sensitive without consent or on a target outside user scope.
/// Accepted content keys join `known`.
pub(super) fn revision_proposals(
    revisions: &[DreamModelRevision],
    related: &[memory::LongTermEntry],
    pending_targets: &HashSet<String>,
    source_by_id: &HashMap<String, DreamSource>,
    known: &mut HashSet<String>,
    owner: &str,
    include_sensitive: bool,
) -> Vec<memory::NewMemoryProposal> {
    let by_id: HashMap<&str, &memory::LongTermEntry> = related
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();
    let mut revised = HashSet::new();
    let mut proposals = Vec::new();
    for revision in revisions.iter().take(DREAM_MAX_REVISIONS) {
        let target_id = revision.target_memory_id.trim();
        let Some(target) = by_id.get(target_id) else {
            continue;
        };
        if pending_targets.contains(target_id) || revised.contains(target_id) {
            continue;
        }
        let Some(content) = bounded_text(&revision.content, DREAM_MAX_MEMORY_CHARS) else {
            continue;
        };
        if !revision_sensitivity_allowed(&content, target.scope, include_sensitive) {
            continue;
        }
        let key = normalize_key(&content);
        if key.is_empty() || known.contains(&key) {
            continue;
        }
        let Some(proposal) = revision_proposal(revision, content, target, source_by_id, owner)
        else {
            continue;
        };
        known.insert(key);
        revised.insert(target_id);
        proposals.push(proposal);
    }
    proposals
}

/// Whether revision `content` may be proposed for a target in `scope`. A
/// revision keeps its target's scope, and the store keeps sensitive memory in
/// user scope only, so sensitive content on any other scope is dropped even
/// with consent; without consent it is always dropped.
fn revision_sensitivity_allowed(
    content: &str,
    scope: memory::MemoryScope,
    include_sensitive: bool,
) -> bool {
    memory::detect_sensitive_topics(content).is_empty()
        || (include_sensitive && scope == memory::MemoryScope::User)
}

/// Targets of the owner's pending revisions, which Dream must not revise
/// again until the first one is reviewed: only one could ever apply.
pub(super) async fn pending_revision_targets(
    state: &ServerState,
    owner: &str,
) -> anyhow::Result<HashSet<String>> {
    let pending = state
        .memory
        .list_proposals(
            owner,
            &memory::MemoryProposalFilter {
                status: Some(memory::MemoryProposalStatus::Pending),
                limit: Some(500),
            },
        )
        .await?;
    Ok(pending
        .into_iter()
        .filter_map(|proposal| proposal.target_memory_id)
        .collect())
}
