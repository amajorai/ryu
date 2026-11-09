//! Dream archive: propose retiring memories that no longer hold. The model
//! may name a memory it was shown when the sources show it is no longer true
//! and nothing replaces it, or when it records an event that is over. Without
//! a model, every run also proposes archiving `Event` memories older than
//! [`DREAM_STALE_EVENT_AGE_MS`] that no chat recalled in that window. Accepting an
//! archive only moves the memory out of recall; nothing is deleted, and the
//! user can roll it back.

use std::collections::{HashMap, HashSet};

use super::candidates::{bounded_text, memory_visibility};
use super::prompt::DreamModelArchive;
use super::proposal_draft::{cited_sources, first_conversation, source_excerpts};
use super::sources::DreamSource;
use super::DREAM_MAX_REASON_CHARS;
use crate::server::{memory, ServerState};

/// Most model-proposed archives one run keeps.
const DREAM_MAX_ARCHIVES: usize = 10;
/// Most stale-event archives one run proposes.
pub(super) const DREAM_MAX_STALE_EVENT_ARCHIVES: usize = 5;
/// An `Event` memory older than this that was never recalled is stale.
pub(super) const DREAM_STALE_EVENT_AGE_MS: i64 = 90 * 24 * 60 * 60 * 1_000;

const DREAM_ARCHIVE_REASON_FALLBACK: &str =
    "Recent chats suggest this memory no longer holds; review before archiving.";
pub(super) const DREAM_STALE_EVENT_REASON: &str =
    "This event is more than 90 days old and no chat has used it in the last 90 days.";

/// The archive proposal for `target`. Nothing is written from an archive
/// draft, so it follows the store's convention: empty `content` and the
/// target's classification. Provenance names the target and any cited
/// messages, which also travel as excerpts for the reviewer.
pub(super) fn archive_proposal(
    target: &memory::LongTermEntry,
    rationale: String,
    cited: &[&DreamSource],
    owner: &str,
) -> memory::NewMemoryProposal {
    let provenance = memory::MemoryProvenance {
        source: memory::MemorySource::Consolidation,
        conversation_id: first_conversation(cited),
        message_ids: cited
            .iter()
            .map(|source| source.message_id.clone())
            .collect(),
        memory_ids: vec![target.id.clone()],
        confidence: None,
    };
    let draft = memory::MemoryProposalDraft {
        content: String::new(),
        scope: target.scope,
        scope_id: target.scope_id.clone(),
        category: target.category,
        importance: target.importance,
        when_to_use: None,
        tags: Vec::new(),
        author_agent_id: Some("dream".to_owned()),
        metadata: memory::MemoryMetadata {
            provenance,
            ..Default::default()
        },
        sources: source_excerpts(cited),
    };
    memory::NewMemoryProposal {
        owner_user_id: owner.to_owned(),
        agent_id: "dream".to_owned(),
        target_memory_id: Some(target.id.clone()),
        operation: memory::MemoryProposalOperation::Archive,
        draft,
        rationale,
    }
}

/// Validate the model's archives and build their proposals. An archive is
/// dropped when its target was not among the memories sent (`related`), is in
/// `blocked`, or was already named this run. Cited ids that were not sent
/// are ignored rather than failing the archive, since citations are optional.
pub(super) fn model_archive_proposals(
    archives: &[DreamModelArchive],
    related: &[memory::LongTermEntry],
    blocked: &HashSet<String>,
    source_by_id: &HashMap<String, DreamSource>,
    owner: &str,
) -> Vec<memory::NewMemoryProposal> {
    let by_id: HashMap<&str, &memory::LongTermEntry> = related
        .iter()
        .map(|entry| (entry.id.as_str(), entry))
        .collect();
    let mut named = HashSet::new();
    let mut proposals = Vec::new();
    for archive in archives.iter().take(DREAM_MAX_ARCHIVES) {
        let target_id = archive.target_memory_id.trim();
        let Some(target) = by_id.get(target_id) else {
            continue;
        };
        if blocked.contains(target_id) || !named.insert(target_id) {
            continue;
        }
        let rationale = archive
            .reason
            .as_deref()
            .and_then(|reason| bounded_text(reason, DREAM_MAX_REASON_CHARS))
            .unwrap_or_else(|| DREAM_ARCHIVE_REASON_FALLBACK.to_owned());
        let cited = cited_sources(&archive.source_message_ids, source_by_id);
        proposals.push(archive_proposal(target, rationale, &cited, owner));
    }
    proposals
}

/// Memory ids among `targets` Dream must not propose archiving for `owner`:
/// those with a pending proposal of any kind (only one could apply) and those
/// whose archive the owner rejected or rolled back, however long ago. The
/// store looks each target up, so no recency window can forget a decline.
pub(super) async fn archive_blocked_targets(
    state: &ServerState,
    owner: &str,
    targets: &[memory::LongTermEntry],
) -> anyhow::Result<HashSet<String>> {
    let ids: Vec<String> = targets.iter().map(|entry| entry.id.clone()).collect();
    state.memory.archive_blocked_targets(owner, &ids).await
}

/// Propose archiving the caller's events that are stale at `now` (Unix ms):
/// active `Event` memories that no turn recalled for the whole of the last
/// [`DREAM_STALE_EVENT_AGE_MS`], oldest first and at most
/// [`DREAM_MAX_STALE_EVENT_ARCHIVES`]. The store applies every condition
/// before the limit, so an old candidate is found however many events are
/// newer, and an archive the owner declined is never proposed again. Only
/// memories the caller can see are considered (the visibility filter Dream
/// uses everywhere), and on an org-bound node only the caller's own. Returns
/// how many were proposed; a proposal the store refuses is logged and skipped.
pub(super) async fn propose_stale_event_archives(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    owner: &str,
    include_sensitive: bool,
    now: i64,
) -> anyhow::Result<usize> {
    let node_bound = crate::sidecar::control_plane::registered_org().is_some();
    let stale = state
        .memory
        .unused_event_memories(
            &memory::UnusedEventQuery {
                idle_before: now.saturating_sub(DREAM_STALE_EVENT_AGE_MS),
                owner_user_id: node_bound.then_some(owner),
                archive_owner: owner,
                limit: DREAM_MAX_STALE_EVENT_ARCHIVES,
            },
            memory_visibility(caller),
            include_sensitive,
        )
        .await?;
    let mut proposed = 0;
    for target in stale {
        let proposal = archive_proposal(&target, DREAM_STALE_EVENT_REASON.to_owned(), &[], owner);
        match state.memory.create_proposal(proposal).await {
            Ok(_) => proposed += 1,
            Err(error) => tracing::warn!("Dream skipped a stale-event archive: {error:#}"),
        }
    }
    Ok(proposed)
}
