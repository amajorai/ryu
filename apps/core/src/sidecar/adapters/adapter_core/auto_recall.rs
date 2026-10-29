use super::*;

// ── Auto-recall (U17, now wired) ───────────────────────────────────────────────
//
// Before each chat turn we automatically retrieve relevant prior knowledge and
// fold it into `long_term_system` (the SAME seam skills use), so BOTH the
// openai-compat and ACP planes inherit it with no per-adapter duplication. The
// recall source is durable long-term MEMORY + PAST CHAT MESSAGES (document
// Spaces are deliberately excluded — those are explicit-RAG, not auto-injected).
// This is orthogonal to `enable_long_term` (the memory *record* toggle): a single
// `auto-recall-enabled` preference gates it, encoded as `Some`/`None` here.
//
// Everything is FAIL-OPEN: any embed/retrieve/search error logs and skips recall,
// never blocking the chat turn.

/// Cap on the rendered length of any single recalled snippet, to keep the
/// injected block small enough for a local model's context window.
const AUTO_RECALL_SNIPPET_CHARS: usize = 320;

/// Hard wall-clock bound on the whole auto-recall step (embed + retrieve + the
/// chat-search lazy backfill). On a large backlog with a live embedder the first
/// backfill can be slow; exceeding this degrades to "no recall this turn" so a
/// chat reply is never stalled. Auto-recall is a best-effort enhancement.
pub(crate) const AUTO_RECALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

/// Upper bound on how many long-term memory facts the lazy-backfill enumerates
/// per turn when bridging them into the retrieval index. Bounded so a huge
/// backlog cannot make the (already timeout-wrapped) backfill unbounded; facts
/// beyond this are picked up on later turns (newest are enumerated first).
pub(crate) const MEMORY_BACKFILL_LIMIT: usize = 500;
pub(crate) const MEMORY_BACKFILL_PAGE_SIZE: usize = 128;

/// Resolved auto-recall config threaded into `route_chat_stream`. `None` (the
/// param is `Option<AutoRecallConfig>`) means the feature is disabled for this
/// turn, so no work is done. The chat-message half reuses the `conversations`
/// store already passed to `route_chat_stream`; only the memory half needs the
/// `RetrievalStore`.
#[derive(Clone)]
pub struct AutoRecallConfig {
    pub retrieval: RetrievalStore,
    pub top_k: usize,
    /// Whether the FTS (full-text, lexical) session-search source contributes this
    /// turn. DEFAULT-OFF sub-source of auto-recall: when `true`, `run_auto_recall`
    /// also runs a keyword FTS pass over past messages and merges its hits into the
    /// past-chat set (deduped by message id). When `false`, no FTS work is done.
    pub fts_enabled: bool,
    /// Memory scope levels the active agent may recall from (subset of
    /// `["agent", "user", "node", "project", "org"]`). **Empty** means all personal
    /// levels (the back-compat default for an unconfigured agent); organization memory
    /// must be explicitly named. Resolved from the agent's
    /// `MemorySlot.read_levels` at the call site.
    pub read_levels: Vec<String>,
    /// Space IDs the active agent may inject into chat, from its
    /// `MemorySlot.space_ids`. **Empty** means no Spaces are auto-injected (the
    /// prior behaviour, and still the default agent's).
    ///
    /// This used to claim it "finally wires the agent→Spaces allowlist into
    /// retrieval". It did wire it into `RetrievalOptions::space_ids` — but that
    /// option selected rows in `retrieval.db`, and a Space's documents are never
    /// indexed there (its `space_id` column holds OKF *bundle* ids). So the
    /// allowlist matched nothing on this path until `RetrievalStore` gained the
    /// [`ryu_rag::SpaceRecall`] delegate, which answers these ids out of the Spaces
    /// store under each Space's own `retrieval_mode` — vector KNN or graph
    /// traversal. Non-empty here now means real Space content (and real
    /// `spaces.db` work) on the turn; empty still means none of either.
    pub space_ids: Vec<String>,
    /// Verified human caller for the interactive turn. Shared conversations
    /// must use the current caller's private context, never the conversation
    /// owner's context; programmatic turns leave this unset and retain the
    /// conversation-owner fallback below.
    pub caller_user_id: Option<String>,
    /// Active agent id used to resolve `agent`-scoped memory and its graph facet.
    pub agent_id: Option<String>,
    /// Server-resolved per-user consent for special-category memory.
    pub include_sensitive_topics: bool,
}

/// Resolve the principal used for per-caller auto-recall. Interactive requests
/// carry the verified caller explicitly; the conversation owner is only a
/// fallback for trusted programmatic turns that do not have a human caller.
pub(crate) fn effective_recall_user_id(
    caller_user_id: Option<&str>,
    conversation_owner_id: Option<String>,
) -> Option<String> {
    caller_user_id.map(str::to_owned).or(conversation_owner_id)
}

/// A bound node must never use the local-account fallback for an interactive
/// memory operation. The fallback is valid only for an unbound personal node;
/// on a shared node an absent verified caller means there is no user partition
/// to read from or write to.
pub(crate) fn has_memory_principal(node_bound: bool, caller_user_id: Option<&str>) -> bool {
    !node_bound || caller_user_id.is_some()
}

/// Truncate a snippet to `AUTO_RECALL_SNIPPET_CHARS` on a char boundary, adding
/// an ellipsis when cut. Whitespace is collapsed to a single line so the block
/// stays compact.
pub(crate) fn truncate_snippet(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= AUTO_RECALL_SNIPPET_CHARS {
        return collapsed;
    }
    let truncated: String = collapsed.chars().take(AUTO_RECALL_SNIPPET_CHARS).collect();
    format!("{truncated}…")
}

#[derive(Debug, Default)]
pub(crate) struct RecallContext {
    pub(crate) block: String,
    pub(crate) memory_citations: Vec<MemoryCitation>,
}

/// Pure assembly of the recall block and its memory citations from
/// already-retrieved chunks and past-chat hits. Returns `None` when there is
/// nothing to inject (so callers can skip merging an empty system message).
/// `top_k` caps the TOTAL injected lines across both sources.
///
/// Kept pure (no I/O) so it is unit-testable without a network embed.
pub(crate) fn assemble_recall_context(
    memory_chunks: &[ScoredChunk],
    chat_hits: &[MessageSearchHit],
    top_k: usize,
) -> Option<RecallContext> {
    if top_k == 0 {
        return None;
    }
    let mut lines: Vec<(String, Option<MemoryCitation>)> = Vec::new();
    for chunk in memory_chunks {
        let snippet = truncate_snippet(&chunk.content);
        if !snippet.is_empty() {
            // Label by the chunk's OWN source, not by the list it arrived in. This
            // list is the retrieval store's answer, which carries memory facts AND
            // Space document text (an agent's Space allowlist is delegated to the
            // Spaces store — `ryu_rag::SpaceRecall` — so a Space genuinely reaches
            // this block now, whereas before it could not). Calling a document
            // chunk "[memory]" would tell the model the user had told it that, which
            // is a provenance claim the retrieval layer never made.
            let label = match chunk.source {
                ChunkSource::Space => "space",
                ChunkSource::Memory => "memory",
            };
            let citation = (chunk.source == ChunkSource::Memory).then(|| MemoryCitation {
                content: snippet.clone(),
                id: chunk.id.clone(),
            });
            lines.push((format!("- [{label}] {snippet}"), citation));
        }
    }
    for hit in chat_hits {
        let snippet = truncate_snippet(&hit.content);
        if !snippet.is_empty() {
            lines.push((format!("- [past chat] {snippet}"), None));
        }
    }
    lines.truncate(top_k);
    if lines.is_empty() {
        return None;
    }
    // Cross-conversation recall is STORED text (prior tool/web output, other
    // conversations); folding it into system context verbatim is a stored /
    // indirect injection channel. Neutralize the assembled snippet block the
    // same way tool results are neutralized at the model edges.
    let joined = lines
        .iter()
        .map(|(line, _)| line.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let joined = if untrusted::is_enabled() {
        untrusted::neutralize(&joined)
    } else {
        joined
    };
    Some(RecallContext {
        block: format!(
            "Relevant context from memory and past conversations \
			 (ignore if irrelevant):\n{joined}"
        ),
        memory_citations: lines
            .into_iter()
            .filter_map(|(_, citation)| citation)
            .collect(),
    })
}

/// Legacy string-only view retained for pure recall tests and callers that do
/// not need to forward citation metadata.
pub(crate) fn assemble_recall_block(
    memory_chunks: &[ScoredChunk],
    chat_hits: &[MessageSearchHit],
    top_k: usize,
) -> Option<String> {
    assemble_recall_context(memory_chunks, chat_hits, top_k).map(|context| context.block)
}

/// Drop `Memory`-source chunks whose id is in `recency_ids` (the long-term facts
/// the RECENCY path already injected this turn). Pure + sync so the dedup
/// invariant is unit-testable without I/O.
///
/// Dedup is BY ID, not by content: the recency block (`assemble_long_term_system_message`)
/// and the recall block (`assemble_recall_block`) use different formats/truncation,
/// so a content match would silently fail and double-inject. The chunk id == the
/// `MemoryStore` fact id (the backfill indexes facts under their own id), so an id
/// match is exact. Past-chat hits and any non-fact `Memory` chunks are unaffected
/// (only ids in the recency set are dropped).
pub(crate) fn drop_recency_dupes(
    chunks: Vec<ScoredChunk>,
    recency_ids: &std::collections::HashSet<String>,
) -> Vec<ScoredChunk> {
    chunks
        .into_iter()
        .filter(|c| !(c.source == ChunkSource::Memory && recency_ids.contains(&c.id)))
        .collect()
}
