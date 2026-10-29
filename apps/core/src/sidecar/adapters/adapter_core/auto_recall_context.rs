use super::*;

/// Run the auto-recall retrieval and return a ready-to-merge context block, or
/// `None`. FAIL-OPEN: every error logs and yields `None`.
///
/// - Memory: lazy-backfill long-term FACTS into the retrieval index, then the
///   unified retrieval path with Spaces excluded (`space_ids: Some(vec![])`,
///   `include_memory: true`), then drop facts the RECENCY path already injected
///   this turn (dedup by id) so no fact appears twice.
/// - Past chats: `ConversationStore::search_messages` with the CURRENT
///   conversation excluded (pass `None` then post-filter, since the param is an
///   include-filter).
///
/// `recency_ids` are the long-term fact ids the recency path injected this turn
/// (empty when `enable_long_term` is off — see the call site). `project_id` is the
/// active working folder (from the request's `cwd`): project-scoped memory only
/// matches when it equals this. The agent's readable levels + Space allowlist come
/// from `cfg.read_levels` / `cfg.space_ids`.
pub(crate) async fn run_auto_recall_context(
    cfg: &AutoRecallConfig,
    conversations: &ConversationStore,
    memory: &MemoryStore,
    project_id: Option<&str>,
    recency_ids: &std::collections::HashSet<String>,
    query: &str,
    current_conversation_id: Option<&str>,
) -> Option<RecallContext> {
    if query.trim().is_empty() || cfg.top_k == 0 {
        return None;
    }

    // Bridge long-term facts into the retrieval index BEFORE retrieving, so a
    // just-recorded fact is searchable this turn. Bounded + fail-open.
    backfill_memory_facts(memory, &cfg.retrieval).await;

    // Per-caller tenancy: auto-recall is the BUSIEST memory read path (every chat
    // turn), so it must apply the same owner filter as `/api/retrieval/search`, or a
    // bound-node member's turn would inject a colleague's private user-scope memory
    // into the model context. On an interactive turn the verified caller wins; the
    // conversation owner is only the fallback for trusted programmatic callers.
    // Unbound node → `node_bound` false → no filter (byte-identical).
    let registered_org = crate::sidecar::control_plane::registered_org();
    let node_bound = registered_org.is_some();
    // `caller_org_id` ALWAYS falls back to the node's own registered org when bound
    // (never left `None`), even if the conversation lookup is empty (no conversation
    // id yet / a not-yet-created chat). A bound node has exactly one org, so this is
    // lossless — but it matters now: `space_tenancy_allows` gates explicit org/team
    // shared content (OKF bundles) on `caller_org_id` matching the chunk's stamped
    // org, and a `None` here would silently drop OKF grounding out of every first-turn
    // auto-recall on a bound node.
    let node_org_id = registered_org.map(|o| o.id);
    let (conversation_owner_id, caller_org_id) = match current_conversation_id {
        Some(cid) => match conversations.get_access_meta(cid).await {
            Ok(Some(t)) => (t.owner_user_id, t.org_id.or_else(|| node_org_id.clone())),
            _ => (None, node_org_id.clone()),
        },
        None => (None, node_org_id.clone()),
    };
    let caller_user_id =
        effective_recall_user_id(cfg.caller_user_id.as_deref(), conversation_owner_id);

    // Memory + Space half, gated by the agent's readable levels + Space allowlist
    // and the active project. Fetch more than top_k so dropping the recency-injected
    // facts still leaves room for the ones the recency window MISSED.
    //
    // The Space half is answered by the SPACES store, not by `retrieval.db`: the
    // store's `ryu_rag::SpaceRecall` delegate (wired once in `main.rs`) runs each
    // allowlisted Space under its own `retrieval_mode`, so a Space the user set to
    // Graph is traversed here exactly as it is in the Spaces search box, and the two
    // rankings are merged by rank (their scores are not comparable — a graph hit has
    // none). An EMPTY allowlist skips `spaces.db` entirely, which is what keeps the
    // default agent's turn free of that work.
    let graph_chunks = graph_memory_chunks(
        memory,
        cfg,
        project_id,
        caller_user_id.as_deref(),
        caller_org_id.as_deref(),
        node_bound,
        query,
        cfg.top_k + recency_ids.len(),
    )
    .await;
    let memory_chunks = {
        let opts = RetrievalOptions {
            top_k: cfg.top_k + recency_ids.len(),
            // Empty allowlist => no Spaces (prior behaviour); non-empty => those.
            space_ids: Some(cfg.space_ids.clone()),
            include_memory: true,
            // Empty => all levels (unconfigured agent); non-empty => those levels.
            read_levels: if cfg.read_levels.is_empty() {
                None
            } else {
                Some(cfg.read_levels.clone())
            },
            project_id: project_id.map(str::to_string),
            agent_id: cfg.agent_id.clone(),
            include_sensitive: cfg.include_sensitive_topics,
            node_bound,
            caller_user_id: caller_user_id.clone(),
            caller_org_id: caller_org_id.clone(),
            ..RetrievalOptions::default()
        };
        let vector_chunks = match cfg.retrieval.retrieve(query, &opts).await {
            Ok(chunks) => chunks,
            Err(e) => {
                tracing::warn!(
                    "auto-recall: vector memory retrieve failed (using graph only): {e:#}"
                );
                Vec::new()
            }
        };
        drop_recency_dupes(
            fuse_memory_graph_candidates(
                vector_chunks,
                graph_chunks,
                cfg.top_k + recency_ids.len(),
            ),
            recency_ids,
        )
    };

    // The past-chat half must scope to the caller's readable conversations on a
    // bound node — exactly like `/api/conversations/search` (server/mod.rs) — or a
    // member's turn would fold a colleague's PRIVATE conversation snippets into the
    // model context via `search_messages(.., None)` ("search ALL conversations").
    // Unbound node → `None` (every conversation, byte-identical AND no per-turn id
    // scan). Bound node → the caller's visible id set; failure or an empty set means
    // no chat hits (fail closed), never a node-wide dump.
    let visible_convo_ids: Option<Vec<String>> = if node_bound {
        match conversations
            .visible_conversation_ids(
                caller_user_id.as_deref(),
                caller_org_id.as_deref(),
                node_bound,
            )
            .await
        {
            Ok(ids) => Some(ids),
            Err(e) => {
                tracing::warn!("auto-recall: visible-id resolve failed (no chat hits): {e:#}");
                Some(Vec::new())
            }
        }
    } else {
        None
    };
    // Remember chats gates the read path as well as append-time indexing. Calling
    // `search_messages` while it is off can lazily rebuild the semantic index.
    let chat_memory_enabled = conversations.chat_memory_enabled();
    let chat_filter = visible_convo_ids.as_deref();
    // An EMPTY visible set on a bound node (anonymous caller, or a resolve error)
    // must yield NO chat hits — but `MessageIndex::search`/`MessageFtsIndex::search`
    // treat `Some(empty)` identically to `None` (= unfiltered), so passing it through
    // would dump the whole node at the index layer. Short-circuit before searching,
    // exactly as the sibling callers do (search_conversations.rs, the REST
    // /api/conversations/search), so the guard is structural — not solely the
    // `hit_allowed` post-filter below.
    let visible_empty = visible_convo_ids.as_ref().is_some_and(Vec::is_empty);
    // Belt and braces on a bound node: post-filter every hit against the same id set
    // so a stale index row (e.g. orphaned by a re-tenanted conversation) can never
    // leak a snippet even if the index-side filter were bypassed.
    let chat_allowed: Option<std::collections::HashSet<&str>> = visible_convo_ids
        .as_ref()
        .map(|ids| ids.iter().map(String::as_str).collect());
    let hit_allowed = |cid: &str| chat_allowed.as_ref().is_none_or(|set| set.contains(cid));

    // Past-chat half (current conversation excluded). `search_messages` returns
    // `Ok(None)` when no message index is wired — treat as no hits.
    let mut chat_hits = if !chat_memory_enabled || visible_empty {
        Vec::new()
    } else {
        match conversations
            .search_messages(query, cfg.top_k, chat_filter)
            .await
        {
            Ok(Some(hits)) => hits
                .into_iter()
                .filter(|h| Some(h.conversation_id.as_str()) != current_conversation_id)
                .filter(|h| hit_allowed(h.conversation_id.as_str()))
                .collect::<Vec<_>>(),
            Ok(None) => Vec::new(),
            Err(e) => {
                tracing::warn!("auto-recall: chat search failed (skipping): {e:#}");
                Vec::new()
            }
        }
    };

    // FTS (lexical) session-search source — default-OFF sub-source. When enabled,
    // run a keyword FTS pass over past messages and merge its hits into the
    // past-chat set, deduped BY MESSAGE ID (the semantic and lexical passes can
    // both surface the same message). The current conversation is excluded, same as
    // the semantic half. Fully fail-open. `assemble_recall_block` still caps the
    // TOTAL injected lines at `top_k`.
    if cfg.fts_enabled && chat_memory_enabled && !visible_empty {
        match conversations
            .fts_search_messages(query, cfg.top_k, chat_filter)
            .await
        {
            Ok(Some(hits)) => {
                let mut seen: std::collections::HashSet<String> =
                    chat_hits.iter().map(|h| h.message_id.clone()).collect();
                for hit in hits {
                    if Some(hit.conversation_id.as_str()) == current_conversation_id {
                        continue;
                    }
                    if !hit_allowed(hit.conversation_id.as_str()) {
                        continue;
                    }
                    if seen.insert(hit.message_id.clone()) {
                        chat_hits.push(hit);
                    }
                }
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("auto-recall: fts session search failed (skipping): {e:#}");
            }
        }
    }

    assemble_recall_context(&memory_chunks, &chat_hits, cfg.top_k)
}

/// String-only compatibility view for callers that only need the assembled
/// prompt block. The route uses [`run_auto_recall_context`] so the same selected
/// memory chunks can also be surfaced in the message toolbar.
pub(crate) async fn run_auto_recall(
    cfg: &AutoRecallConfig,
    conversations: &ConversationStore,
    memory: &MemoryStore,
    project_id: Option<&str>,
    recency_ids: &std::collections::HashSet<String>,
    query: &str,
    current_conversation_id: Option<&str>,
) -> Option<String> {
    run_auto_recall_context(
        cfg,
        conversations,
        memory,
        project_id,
        recency_ids,
        query,
        current_conversation_id,
    )
    .await
    .map(|context| context.block)
}
