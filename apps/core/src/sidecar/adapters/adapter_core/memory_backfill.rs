use super::*;

/// Lazy-backfill long-term memory FACTS into the retrieval index so semantic
/// search can find them. Mirrors the message-index lazy-backfill pattern: only
/// facts whose id is NOT already indexed (under the current embedder) are embedded
/// + indexed, so the steady-state cost is one cheap `recall` SELECT plus zero
/// embeds.
///
/// The chunk id is the `MemoryStore` fact id — this stable id is what makes the
/// id-based dedup against the recency path work. Facts are indexed as
/// `ChunkSource::Memory` (Space-less), the same source the recall memory half
/// searches.
///
/// FAIL-OPEN + BOUNDED: a per-fact embed failure logs and skips that fact (the
/// loop never aborts); at most [`MEMORY_BACKFILL_LIMIT`] new facts are embedded
/// per call, while indexed facts are scanned in pages so an already-indexed head
/// cannot starve older facts forever. The whole call already runs inside the
/// [`AUTO_RECALL_TIMEOUT`] budget. Never panics or propagates.
/// Enumerates facts across ALL scope levels (per-agent/level filtering happens at
/// retrieve time, using the chunk's denormalized `mem_scope`/`mem_scope_id`), so a
/// fact recorded at any level becomes searchable once indexed.
pub(crate) async fn backfill_memory_facts(memory: &MemoryStore, retrieval: &RetrievalStore) {
    let mut indexed = match retrieval.indexed_memory_ids().await {
        Ok(ids) => ids,
        Err(e) => {
            tracing::warn!(
                "auto-recall: reading indexed memory ids failed (skipping backfill): {e:#}"
            );
            return;
        }
    };
    let node_org = crate::sidecar::control_plane::registered_org().map(|o| o.id);
    let mut offset = 0usize;
    let mut newly_indexed = 0usize;
    loop {
        let facts = match memory
            .all_for_backfill_page(MEMORY_BACKFILL_PAGE_SIZE, offset)
            .await
        {
            Ok(facts) => facts,
            Err(error) => {
                tracing::warn!(
                    "auto-recall: enumerating memory facts failed (skipping backfill): {error:#}"
                );
                return;
            }
        };
        if facts.is_empty() {
            return;
        }
        offset += facts.len();
        for fact in facts {
            let consent_user = fact
                .owner_user_id
                .as_deref()
                .unwrap_or(crate::server::memory::LOCAL_USER);
            let sensitive = !fact.sensitive_topics.is_empty();
            if sensitive
                && !memory
                    .include_sensitive_topics(consent_user)
                    .await
                    .unwrap_or(false)
            {
                // Revocation removes the derived copy while the encrypted source
                // remains available for an explicit owner review.
                let _ = retrieval.remove_chunk(&fact.id).await;
                continue;
            }
            // Denormalize the fact's own owner onto its retrieval chunk so the
            // per-caller filter can gate it. A legacy `'local'`/None owner → shared
            // (the retrieval memory-owner backfill re-stamps it on the next open).
            let owner = match (node_org.as_deref(), fact.owner_user_id.as_deref()) {
                (Some(org), Some(uid)) if uid != crate::server::memory::LOCAL_USER => {
                    crate::server::retrieval::RetrievalOwner::owned(Some(uid), Some(org), None)
                }
                _ => crate::server::retrieval::RetrievalOwner::shared(),
            };
            if indexed.contains(&fact.id) {
                if let Err(error) = retrieval
                    .update_memory_metadata(
                        &fact.id,
                        fact.scope.as_str(),
                        fact.scope_id.as_deref(),
                        fact.category.as_str(),
                        fact.importance,
                        fact.author_agent_id.as_deref(),
                        sensitive,
                        owner,
                    )
                    .await
                {
                    tracing::warn!(
                        "auto-recall: refreshing memory metadata {} failed (skipping): {error:#}",
                        fact.id
                    );
                }
                continue;
            }
            if let Err(error) = retrieval
                .index_memory_chunk_with_metadata(
                    &fact.id,
                    &fact.content,
                    fact.scope.as_str(),
                    fact.scope_id.as_deref(),
                    fact.category.as_str(),
                    fact.importance,
                    fact.author_agent_id.as_deref(),
                    sensitive,
                    owner,
                )
                .await
            {
                tracing::warn!(
                    "auto-recall: indexing memory fact {} failed (skipping): {error:#}",
                    fact.id
                );
            } else {
                indexed.insert(fact.id);
                newly_indexed += 1;
                if newly_indexed >= MEMORY_BACKFILL_LIMIT {
                    return;
                }
            }
        }
    }
}

fn memory_graph_document(entry: &crate::server::memory::LongTermEntry) -> MemoryGraphDocument {
    MemoryGraphDocument {
        memory_id: entry.id.clone(),
        content: entry.content.clone(),
        scope: entry.scope.as_str().to_owned(),
        scope_id: entry.scope_id.clone(),
        category: entry.category.as_str().to_owned(),
        agent_id: entry.author_agent_id.clone(),
        owner_user_id: entry.owner_user_id.clone(),
        owner_org_id: None,
        importance: entry.importance,
        tags: entry.tags.clone(),
        sensitive_topics: entry
            .sensitive_topics
            .iter()
            .map(|topic| topic.as_str().to_owned())
            .collect(),
    }
}

/// Run the local typed Memory GraphRAG projection. The graph is rebuilt from a
/// bounded source snapshot so it never becomes a second authority or a stale
/// plaintext database. Every returned fact is still selected by the same scope,
/// caller, project, and sensitive-topic filters used by vector retrieval.
pub(crate) async fn graph_memory_chunks(
    memory: &MemoryStore,
    cfg: &AutoRecallConfig,
    project_id: Option<&str>,
    caller_user_id: Option<&str>,
    caller_org_id: Option<&str>,
    node_bound: bool,
    query: &str,
    limit: usize,
) -> Vec<ScoredChunk> {
    let facts = match memory.all_for_backfill(MEMORY_BACKFILL_LIMIT).await {
        Ok(facts) => facts,
        Err(error) => {
            tracing::warn!("auto-recall: memory graph source scan failed (skipping): {error:#}");
            return Vec::new();
        }
    };
    let graph = MemoryGraph::from_documents(facts.iter().map(memory_graph_document));
    let allowed_scopes = if cfg.read_levels.is_empty() {
        None
    } else {
        Some(cfg.read_levels.as_slice())
    };
    let filter = MemoryGraphQuery {
        agent_id: cfg.agent_id.as_deref(),
        include_all_agents: false,
        allowed_scopes,
        project_id,
        include_all_projects: false,
        node_bound,
        caller_user_id,
        caller_org_id,
        include_sensitive: cfg.include_sensitive_topics,
    };
    graph
        .search(query, &filter, limit)
        .into_iter()
        .filter_map(|hit| {
            graph.document(&hit.memory_id).map(|entry| ScoredChunk {
                id: entry.memory_id.clone(),
                source: ChunkSource::Memory,
                space_id: None,
                content: entry.content.clone(),
                score: hit.score,
            })
        })
        .collect()
}

/// Merge graph candidates with the ordinary vector/Space result without
/// inventing a score scale. Reciprocal-rank fusion is the existing primitive for
/// combining independently ranked sources, and it deduplicates by memory id.
pub(crate) fn fuse_memory_graph_candidates(
    vector_chunks: Vec<ScoredChunk>,
    graph_chunks: Vec<ScoredChunk>,
    limit: usize,
) -> Vec<ScoredChunk> {
    if graph_chunks.is_empty() {
        return vector_chunks;
    }
    crate::server::retrieval::fuse_ranked_lists(vector_chunks, vec![graph_chunks], limit)
}
