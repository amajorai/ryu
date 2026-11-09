//! Access tracking for the chat path: once a turn completes, the long-term
//! memories it actually injected (the recency notes plus the auto-recall
//! memory citations) get their recall counters bumped, so Dream can tell facts
//! in use from facts nobody reads. A turn that fails bumps nothing.

use super::*;

/// The distinct memory ids a persisted turn injected: the recency notes
/// first, then the auto-recall memory citations, blanks dropped, capped at the
/// store's bound. Both inputs come from recall that already ran under this
/// turn's owner and visibility, so the list never names a memory the caller
/// could not read. A turn that is not persisted (a temporary chat, even one
/// allowed to read memory) records nothing: its reads stay read-only and leave
/// no timestamp behind.
pub(crate) fn recalled_memory_ids(
    persisted: bool,
    recency_ids: &[String],
    citations: &[MemoryCitation],
) -> Vec<String> {
    if !persisted {
        return Vec::new();
    }
    let mut seen = std::collections::HashSet::new();
    recency_ids
        .iter()
        .chain(citations.iter().map(|citation| &citation.id))
        .filter(|id| !id.trim().is_empty())
        .filter(|id| seen.insert(id.as_str()))
        .take(crate::server::memory::MAX_MARK_RECALLED_IDS)
        .cloned()
        .collect()
}

/// Bump the recall counters for `ids`. Fail-open: a store error is logged and
/// never reaches the turn.
pub(crate) async fn mark_turn_recalled(memory: &MemoryStore, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    let now = chrono::Utc::now().timestamp_millis();
    if let Err(error) = memory.mark_recalled(ids, now).await {
        tracing::warn!("memory: could not record recalled facts: {error:#}");
    }
}

/// The recall marks a turn owes, paid only once the turn ends well.
///
/// Built when the turn's context is assembled, then handed to the turn's
/// finish: the shared reply persister of the OpenAI-compatible, local-engine,
/// SDK-app and A2A planes, and the ACP plane's completion task. A turn that
/// fails (or is abandoned for a retry on another plan) drops its marks unpaid,
/// so only facts that went into a reply that actually landed count as used.
#[derive(Clone)]
pub(crate) struct TurnRecallMarks {
    memory: MemoryStore,
    ids: Vec<String>,
}

impl TurnRecallMarks {
    pub(crate) fn new(memory: &MemoryStore, ids: Vec<String>) -> Self {
        Self {
            memory: memory.clone(),
            ids,
        }
    }

    /// Whether a finished turn with this run outcome earns its marks: only a
    /// `completed` turn does, never a `failed` one.
    pub(crate) fn earned_by(outcome: &str) -> bool {
        outcome == "completed"
    }

    /// Pay the marks if `outcome` earned them, waiting for the write.
    /// Fail-open, like [`mark_turn_recalled`].
    pub(crate) async fn settle(self, outcome: &str) {
        if Self::earned_by(outcome) {
            mark_turn_recalled(&self.memory, &self.ids).await;
        }
    }

    /// [`Self::settle`] off the turn's critical path, so the reply's final
    /// frames never wait on the memory database.
    pub(crate) fn spawn_settle(self, outcome: &str) {
        if self.ids.is_empty() || !Self::earned_by(outcome) {
            return;
        }
        tokio::spawn(async move { mark_turn_recalled(&self.memory, &self.ids).await });
    }
}

#[cfg(test)]
#[path = "recall_tracking_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "recall_tracking_finish_tests.rs"]
mod finish_tests;
