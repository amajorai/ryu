//! Turning one model candidate into a reviewable proposal: validate its
//! citations, bound its text, clamp its confidence, and attach short excerpts
//! of the cited messages so the reviewer can see the evidence.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::candidates::bounded_text;
use super::prompt::DreamModelMemory;
use super::sources::DreamSource;
use super::{
    DREAM_MAX_REASON_CHARS, DREAM_MAX_SOURCE_IDS, DREAM_MAX_TAG_CHARS, DREAM_MAX_WHEN_TO_USE_CHARS,
};
use crate::server::memory;

/// Longest excerpt of a cited message kept with a proposal.
pub(super) const DREAM_SOURCE_EXCERPT_CHARS: usize = 160;

pub(super) const DREAM_REASON_FALLBACK: &str =
    "Derived from recent chat context; review before saving.";

/// The model's confidence as a number in `0.0..=1.0`. Numbers and numeric
/// strings are clamped into range; anything else (missing, `NaN`, prose such
/// as `"high"`) is no confidence rather than a guessed one.
pub(super) fn clamp_confidence(value: Option<&Value>) -> Option<f32> {
    let number = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    if !number.is_finite() {
        return None;
    }
    Some(number.clamp(0.0, 1.0) as f32)
}

/// The cited messages that were actually sent to the model, in citation
/// order, without duplicates and at most [`DREAM_MAX_SOURCE_IDS`] of them.
/// Invented ids are dropped.
pub(super) fn cited_sources<'a>(
    ids: &[String],
    source_by_id: &'a HashMap<String, DreamSource>,
) -> Vec<&'a DreamSource> {
    let mut seen = HashSet::new();
    ids.iter()
        .map(|id| id.trim())
        .filter(|id| seen.insert(*id))
        .filter_map(|id| source_by_id.get(id))
        .take(DREAM_MAX_SOURCE_IDS)
        .collect()
}

/// Dream's provenance for a proposal backed by `cited`, or `None` when it
/// cites nothing that was sent. `memory_ids` names existing memories the
/// proposal revises.
pub(super) fn consolidation_provenance(
    cited: &[&DreamSource],
    memory_ids: Vec<String>,
    confidence: Option<f32>,
) -> Option<memory::MemoryProvenance> {
    let first_source = cited.first()?;
    Some(memory::MemoryProvenance {
        source: memory::MemorySource::Consolidation,
        conversation_id: Some(first_source.conversation_id.clone()),
        message_ids: cited.iter().map(|s| s.message_id.clone()).collect(),
        memory_ids,
        confidence,
    })
}

/// Short excerpts of the cited messages, kept with the proposal as evidence.
pub(super) fn source_excerpts(cited: &[&DreamSource]) -> Vec<memory::MemoryProposalSource> {
    cited
        .iter()
        .map(|source| memory::MemoryProposalSource {
            message_id: source.message_id.clone(),
            conversation_id: Some(source.conversation_id.clone()),
            excerpt: bounded_text(&source.content, DREAM_SOURCE_EXCERPT_CHARS).unwrap_or_default(),
        })
        .collect()
}

/// Build the proposal for one candidate whose `content` has already been
/// bounded, filtered and deduplicated. Returns `None` when the candidate cites
/// no message that was actually sent to the model.
pub(super) fn candidate_proposal(
    candidate: &DreamModelMemory,
    content: String,
    source_by_id: &HashMap<String, DreamSource>,
    owner: &str,
) -> Option<memory::NewMemoryProposal> {
    let cited = cited_sources(&candidate.source_message_ids, source_by_id);
    let provenance = consolidation_provenance(
        &cited,
        Vec::new(),
        clamp_confidence(candidate.confidence.as_ref()),
    )?;
    let sources = source_excerpts(&cited);
    let rationale = candidate
        .reason
        .as_deref()
        .and_then(|reason| bounded_text(reason, DREAM_MAX_REASON_CHARS))
        .unwrap_or_else(|| DREAM_REASON_FALLBACK.to_owned());
    let when_to_use = candidate
        .when_to_use
        .as_deref()
        .and_then(|value| bounded_text(value, DREAM_MAX_WHEN_TO_USE_CHARS));
    let tags = candidate
        .tags
        .iter()
        .filter_map(|tag| bounded_text(tag, DREAM_MAX_TAG_CHARS))
        .map(|tag| tag.to_ascii_lowercase())
        .take(8)
        .collect();
    let draft = memory::MemoryProposalDraft {
        content,
        scope: memory::MemoryScope::User,
        scope_id: None,
        category: candidate
            .category
            .as_deref()
            .map(memory::MemoryCategory::from_str)
            .unwrap_or_default(),
        importance: candidate
            .importance
            .unwrap_or(memory::DEFAULT_IMPORTANCE)
            .clamp(1, 5),
        when_to_use,
        tags,
        author_agent_id: Some("dream".to_owned()),
        metadata: memory::MemoryMetadata {
            provenance,
            ..Default::default()
        },
        sources,
    };
    Some(memory::NewMemoryProposal {
        owner_user_id: owner.to_owned(),
        agent_id: "dream".to_owned(),
        target_memory_id: None,
        operation: memory::MemoryProposalOperation::Create,
        draft,
        rationale,
    })
}
