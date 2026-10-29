use super::*;

// ── Auto-recall block assembly (U17) ────────────────────────────────────────
// Pure assembly + merge, exercised without a network embed.

fn mem_chunk(content: &str) -> ScoredChunk {
    ScoredChunk {
        id: "m".to_owned(),
        source: crate::server::retrieval::ChunkSource::Memory,
        space_id: None,
        content: content.to_owned(),
        score: 0.9,
    }
}

fn chat_hit(conversation_id: &str, content: &str) -> MessageSearchHit {
    MessageSearchHit {
        conversation_id: conversation_id.to_owned(),
        message_id: "x".to_owned(),
        role: "user".to_owned(),
        content: content.to_owned(),
        created_at: 0,
        score: 0.8,
    }
}

#[test]
fn recall_block_labels_and_caps() {
    let mem = vec![mem_chunk("user prefers dark mode")];
    let chats = vec![
        chat_hit("c1", "we discussed the rust build"),
        chat_hit("c2", "and the gateway routing"),
    ];
    // top_k = 2 caps to two lines total (memory line + first chat line).
    let block = assemble_recall_block(&mem, &chats, 2).expect("non-empty");
    assert!(block.contains("Relevant context from memory and past conversations"));
    assert!(block.contains("- [memory] user prefers dark mode"));
    assert!(block.contains("- [past chat] we discussed the rust build"));
    // The third candidate is dropped by the top_k cap.
    assert!(!block.contains("gateway routing"));
    // Exactly two bullet lines.
    assert_eq!(block.matches("- [").count(), 2);
}

#[test]
fn recall_context_cites_only_memory_lines_within_the_budget() {
    let memory = vec![mem_chunk_id("memory-1", "prefers dark mode")];
    let space = ScoredChunk {
        id: "space-1".to_owned(),
        source: ChunkSource::Space,
        space_id: Some("space".to_owned()),
        content: "The product ships on Friday".to_owned(),
        score: 0.8,
    };
    let context = assemble_recall_context(&[memory[0].clone(), space], &[], 2)
        .expect("memory and space lines should be assembled");

    assert_eq!(
        context.memory_citations,
        vec![MemoryCitation {
            id: "memory-1".to_owned(),
            content: "prefers dark mode".to_owned(),
        }]
    );
}

/// A Space document chunk must be labelled `[space]`, not `[memory]`.
///
/// This became reachable when `RetrievalStore` gained its Spaces delegate: the
/// agent's Space allowlist now returns real document text on this list, and the
/// label is the only provenance the model gets. Telling it a document is
/// "memory" asserts the user said it — a claim nothing in the retrieval path
/// makes. Both sources in one block, so the labels cannot be swapped wholesale.
#[test]
fn recall_block_labels_space_chunks_by_their_own_source() {
    let space = ScoredChunk {
        id: "s".to_owned(),
        source: crate::server::retrieval::ChunkSource::Space,
        space_id: Some("space-1".to_owned()),
        content: "Acme is based in Rotterdam".to_owned(),
        score: 0.5,
    };
    let block =
        assemble_recall_block(&[mem_chunk("user prefers dark mode"), space], &[], 5).unwrap();
    assert!(
        block.contains("- [space] Acme is based in Rotterdam"),
        "{block}"
    );
    assert!(
        block.contains("- [memory] user prefers dark mode"),
        "{block}"
    );
}

#[test]
fn recall_block_empty_when_no_chunks() {
    assert!(assemble_recall_block(&[], &[], 5).is_none());
    // top_k = 0 short-circuits to None even with content.
    assert!(assemble_recall_block(&[mem_chunk("x")], &[], 0).is_none());
}

#[test]
fn recall_block_truncates_long_snippets() {
    let long = "word ".repeat(400); // far over the snippet cap
    let block = assemble_recall_block(&[mem_chunk(&long)], &[], 5).expect("non-empty");
    assert!(block.contains('…'), "long snippet should be ellipsised");
}

#[test]
fn recall_block_appends_after_existing_long_term() {
    // Mirror the route_chat_stream merge: append recall AFTER persona+memory so
    // persona/memory stay leading.
    let existing = Some("You are a helpful persona.".to_owned());
    let block = assemble_recall_block(&[mem_chunk("a fact")], &[], 5).unwrap();
    let merged = match existing {
        Some(e) if !e.is_empty() => format!("{e}\n\n{block}"),
        _ => block,
    };
    let persona_pos = merged.find("helpful persona").unwrap();
    let recall_pos = merged.find("[memory] a fact").unwrap();
    assert!(
        persona_pos < recall_pos,
        "persona must lead the recall block"
    );
}

// ── Long-term fact bridge: dedup-by-id + lazy backfill ──────────────────────

fn mem_chunk_id(id: &str, content: &str) -> ScoredChunk {
    ScoredChunk {
        id: id.to_owned(),
        source: ChunkSource::Memory,
        space_id: None,
        content: content.to_owned(),
        score: 0.9,
    }
}

/// (i) A fact already injected by the RECENCY path (its id is in the recency
/// set) is NOT injected a second time by auto-recall. (ii) A Memory-source
/// chunk whose id is NOT in the recency set still passes through.
#[test]
fn drop_recency_dupes_drops_by_id_keeps_misses() {
    let mut recency = std::collections::HashSet::new();
    recency.insert("fact-recent".to_owned());

    let chunks = vec![
        mem_chunk_id("fact-recent", "recency already showed this"),
        mem_chunk_id("fact-missed", "semantically relevant but old"),
    ];
    let kept = drop_recency_dupes(chunks, &recency);

    assert_eq!(kept.len(), 1, "the recency-injected fact must be dropped");
    assert_eq!(
        kept[0].id, "fact-missed",
        "the fact the recency window missed must pass through"
    );
}

/// A past-chat / non-fact Memory chunk is unaffected even if a SAME-VALUED
/// id collision is impossible here — dedup only touches Memory-source ids in
/// the set. (Guards against accidentally widening the filter.)
#[test]
fn drop_recency_dupes_only_touches_ids_in_set() {
    let recency = std::collections::HashSet::new(); // empty set
    let chunks = vec![mem_chunk_id("fact-a", "a"), mem_chunk_id("fact-b", "b")];
    let kept = drop_recency_dupes(chunks, &recency);
    assert_eq!(kept.len(), 2, "empty recency set drops nothing");
}

/// (iii) Backfill indexes a not-yet-indexed fact id, and a second backfill is
/// a no-op (already-indexed facts are skipped). Network-free: in-memory stores
/// with the local hashing embedder.
#[tokio::test]
async fn backfill_indexes_new_facts_then_is_idempotent() {
    let memory = MemoryStore::open_in_memory().unwrap();
    let retrieval = RetrievalStore::open_in_memory(
        crate::registry::DEFAULT_EMBED_DIMS,
        crate::registry::DEFAULT_RERANKER_MODEL.to_owned(),
    )
    .unwrap();
    let scope = "default";

    let fact_id = memory
        .record(
            LOCAL_USER,
            scope,
            "User lives in Singapore and prefers dark mode",
        )
        .await
        .unwrap()
        .expect("a fact id");

    // Nothing indexed yet.
    assert!(retrieval.indexed_memory_ids().await.unwrap().is_empty());

    backfill_memory_facts(&memory, &retrieval).await;

    let indexed = retrieval.indexed_memory_ids().await.unwrap();
    assert!(
        indexed.contains(&fact_id),
        "backfill must index the new fact under its MemoryStore id"
    );
    assert_eq!(indexed.len(), 1);

    // Second backfill: already indexed → no change.
    backfill_memory_facts(&memory, &retrieval).await;
    assert_eq!(
        retrieval.indexed_memory_ids().await.unwrap().len(),
        1,
        "re-running backfill must be a no-op for already-indexed facts"
    );

    // And the indexed fact is now semantically retrievable as a Memory chunk.
    let opts = RetrievalOptions {
        top_k: 5,
        space_ids: Some(Vec::new()),
        include_memory: true,
        ..RetrievalOptions::default()
    };
    let hits = retrieval
        .retrieve("where does the user live", &opts)
        .await
        .unwrap();
    assert!(
        hits.iter()
            .any(|c| c.id == fact_id && c.source == ChunkSource::Memory),
        "the backfilled fact must be retrievable via semantic search"
    );
}

#[tokio::test]
async fn backfill_reaches_older_facts_after_the_newest_page_is_indexed() {
    let memory = MemoryStore::open_in_memory().unwrap();
    let retrieval = RetrievalStore::open_in_memory(
        crate::registry::DEFAULT_EMBED_DIMS,
        crate::registry::DEFAULT_RERANKER_MODEL.to_owned(),
    )
    .unwrap();
    let oldest_id = memory
        .record(LOCAL_USER, "default", "the oldest searchable fact")
        .await
        .unwrap()
        .unwrap();
    for index in 0..500 {
        memory
            .record(
                LOCAL_USER,
                "default",
                &format!("newer searchable fact {index}"),
            )
            .await
            .unwrap();
    }

    backfill_memory_facts(&memory, &retrieval).await;
    assert!(!retrieval
        .indexed_memory_ids()
        .await
        .unwrap()
        .contains(&oldest_id));

    backfill_memory_facts(&memory, &retrieval).await;
    assert!(retrieval
        .indexed_memory_ids()
        .await
        .unwrap()
        .contains(&oldest_id));
}

#[tokio::test]
async fn graph_recall_connects_people_and_shared_topics() {
    let memory = MemoryStore::open_in_memory().unwrap();
    let retrieval = RetrievalStore::open_in_memory(
        crate::registry::DEFAULT_EMBED_DIMS,
        crate::registry::DEFAULT_RERANKER_MODEL.to_owned(),
    )
    .unwrap();
    memory
        .record(LOCAL_USER, "agent-a", "Maya owns the launch plan")
        .await
        .unwrap();
    let related_id = memory
        .record(LOCAL_USER, "agent-a", "The launch plan needs a review")
        .await
        .unwrap()
        .unwrap();
    let cfg = AutoRecallConfig {
        retrieval,
        top_k: 5,
        fts_enabled: false,
        read_levels: Vec::new(),
        space_ids: Vec::new(),
        caller_user_id: None,
        agent_id: Some("agent-a".to_owned()),
        include_sensitive_topics: false,
    };
    let chunks = graph_memory_chunks(&memory, &cfg, None, None, None, false, "Maya", 5).await;
    assert!(chunks.iter().any(|chunk| chunk.content.contains("Maya")));
    assert!(
        chunks.iter().any(|chunk| chunk.id == related_id),
        "a shared launch topic should connect the related fact"
    );
}

/// FTS session-search sub-source: with `fts_enabled = false` the FTS pass does
/// no work (a matching past message is NOT surfaced); with `fts_enabled = true`
/// an FTS-only match surfaces in the assembled recall block. Network-free.
#[tokio::test]
async fn run_auto_recall_fts_source_gated_by_flag() {
    let memory = MemoryStore::open_in_memory().unwrap();
    let retrieval = RetrievalStore::open_in_memory(
        crate::registry::DEFAULT_EMBED_DIMS,
        crate::registry::DEFAULT_RERANKER_MODEL.to_owned(),
    )
    .unwrap();
    let fts = ryu_search::MessageFtsIndex::open_in_memory().unwrap();
    // Conversation store WITHOUT a semantic message index (so the only past-chat
    // contribution can come from the FTS source), WITH the FTS index wired.
    let conversations = ConversationStore::open_in_memory()
        .unwrap()
        .with_message_fts_index(fts);
    // A distinctive past message in a DIFFERENT conversation than the current.
    conversations
        .append_message(
            "c-past",
            "user",
            "the quarterly kubernetes migration retro",
            None,
            None,
            None,
        )
        .await
        .unwrap();

    let recency = std::collections::HashSet::new();

    // Gate OFF: FTS contributes nothing → no block (memory + semantic are empty).
    let cfg_off = AutoRecallConfig {
        retrieval: retrieval.clone(),
        top_k: 5,
        fts_enabled: false,
        read_levels: Vec::new(),
        space_ids: Vec::new(),
        caller_user_id: None,
        agent_id: None,
        include_sensitive_topics: false,
    };
    let block_off = run_auto_recall(
        &cfg_off,
        &conversations,
        &memory,
        None,
        &recency,
        "kubernetes migration",
        Some("c-current"),
    )
    .await;
    assert!(
        block_off.is_none(),
        "fts disabled must contribute no recall, got: {block_off:?}"
    );

    // Gate ON: the FTS-only match surfaces in the block.
    let cfg_on = AutoRecallConfig {
        retrieval,
        top_k: 5,
        fts_enabled: true,
        read_levels: Vec::new(),
        space_ids: Vec::new(),
        caller_user_id: None,
        agent_id: None,
        include_sensitive_topics: false,
    };
    let block_disabled = run_auto_recall(
        &cfg_on,
        &conversations,
        &memory,
        None,
        &recency,
        "kubernetes migration",
        Some("c-current"),
    )
    .await;
    assert!(
        block_disabled.is_none(),
        "chat memory disabled must suppress auto-recall chat hits, got: {block_disabled:?}"
    );

    conversations.set_chat_memory_enabled(true).await.unwrap();
    let block_on = run_auto_recall(
        &cfg_on,
        &conversations,
        &memory,
        None,
        &recency,
        "kubernetes migration",
        Some("c-current"),
    )
    .await
    .expect("fts match should produce a recall block");
    assert!(
        block_on.contains("kubernetes migration retro"),
        "fts-surfaced past chat must appear, got: {block_on}"
    );
}

#[test]
fn interactive_auto_recall_uses_current_caller_over_conversation_owner() {
    assert_eq!(
        effective_recall_user_id(Some("bob"), Some("alice".to_owned())),
        Some("bob".to_owned())
    );
    assert_eq!(
        effective_recall_user_id(None, Some("alice".to_owned())),
        Some("alice".to_owned())
    );
    assert_eq!(effective_recall_user_id(None, None), None);
}

#[test]
fn bound_node_memory_requires_a_verified_caller() {
    assert!(has_memory_principal(false, None));
    assert!(has_memory_principal(true, Some("alice")));
    assert!(!has_memory_principal(true, None));
}
