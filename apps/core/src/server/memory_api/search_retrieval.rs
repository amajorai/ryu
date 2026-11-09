//! Retrieval handlers and the memory management API: `search_retrieval` through `memory_graph_filter_metadata`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    post,
    path = "/api/retrieval/search",
    tag = "Retrieval",
    summary = "Search indexed chunks + memory",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn search_retrieval(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<RetrievalSearchBody>,
) -> axum::response::Response {
    // This returns RAG chunks of SPACE/DOCUMENT content. It took no caller at all, so
    // on an org-bound node any holder of the node token — signed in or not — could
    // pull document text out of every user's spaces.
    //
    // What this closes: the TOKENLESS bypass. An anonymous or non-member caller on a
    // bound node is now refused (`enforce_permission` denies `None` callers there and
    // allows everyone on an unbound personal node, so local-first is untouched).
    //
    // Two gates run: coarse RBAC (tokenless caller on a bound node → 403), then the
    // per-caller tenancy filter threaded into `RetrievalOptions` below. The filter
    // (`memory_tenancy_allows` / `space_tenancy_allows`) is what stops a signed-in
    // member retrieving a colleague's user-scope memory or private document chunks —
    // the content-escape path the earlier build could not close because nothing
    // stamped an owner. Now every memory/Space chunk carries a denormalized owner.
    if let Err(status) = enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
    )
    .await
    {
        return json_error(status, "forbidden".to_owned());
    }
    let filter =
        match parse_retrieval_knobs(body.filter.as_ref(), body.hybrid.as_ref(), &body.expansion) {
            Ok(filter) => filter,
            Err(response) => return response,
        };
    let node_bound = crate::sidecar::node_binding::node_bound_for_tenancy();
    let include_sensitive = sensitive_memory_enabled(&state, &caller).await;
    let include_memory = body.include_memory.unwrap_or(true);
    let agent_id = body.agent_id.clone();
    let opts = retrieval::RetrievalOptions {
        filter: filter.clone(),
        hybrid: body.hybrid,
        top_k: body.top_k.unwrap_or(retrieval::DEFAULT_TOP_K),
        space_ids: body.space_ids,
        include_memory,
        min_score: body.min_score.unwrap_or(0.0),
        agent_id: agent_id.clone(),
        include_sensitive,
        node_bound,
        caller_user_id: caller.as_ref().map(|c| c.user_id.clone()),
        caller_org_id: caller.as_ref().and_then(|c| c.org_id.clone()),
        ..Default::default()
    };
    if include_memory {
        if let Ok(facts) = state.memory.all_for_backfill(500).await {
            refresh_memory_retrieval_metadata(&state, &facts).await;
        }
    }
    // Multi-query / HyDE: search with every expansion text and fuse the lists
    // by rank. A no-op request makes no model call (one text, the query).
    let expanded = retrieval_expansion::expand(
        &state,
        &body.query,
        &body.expansion,
        retrieval_expansion::caller_may_pick_model(&caller),
    )
    .await;
    let mut lists = Vec::new();
    for text in expanded.search_texts() {
        match state.retrieval.retrieve(&text, &opts).await {
            Ok(chunks) => lists.push(chunks),
            Err(e) => {
                tracing::warn!("retrieval vector search failed; trying memory graph: {e:#}");
            }
        }
    }
    let vector_chunks = if lists.len() <= 1 {
        lists.pop().unwrap_or_default()
    } else {
        let primary = lists.remove(0);
        retrieval::fuse_ranked_lists(primary, lists, opts.top_k)
    };
    let expansion_fields = |mut response: serde_json::Value| {
        if expanded.queries.len() > 1 || expanded.hypothetical_document.is_some() {
            response["queries"] = json!(expanded.queries);
            if let Some(passage) = &expanded.hypothetical_document {
                response["hypothetical_document"] = json!(passage);
            }
        }
        if let Some(warning) = &expanded.warning {
            response["warning"] = json!(warning);
        }
        response
    };
    if !include_memory {
        return Json(expansion_fields(json!({ "chunks": vector_chunks }))).into_response();
    }
    let graph_chunks = match state.memory.all_for_backfill(500).await {
        Ok(facts) => {
            let graph =
                retrieval::MemoryGraph::from_documents(facts.iter().map(memory_graph_document));
            let graph_filter = retrieval::MemoryGraphQuery {
                agent_id: agent_id.as_deref(),
                include_all_agents: false,
                allowed_scopes: None,
                project_id: opts.project_id.as_deref(),
                include_all_projects: false,
                node_bound,
                caller_user_id: opts.caller_user_id.as_deref(),
                caller_org_id: opts.caller_org_id.as_deref(),
                include_sensitive,
            };
            graph
                .search(&body.query, &graph_filter, opts.top_k)
                .into_iter()
                .filter_map(|hit| {
                    graph
                        .document(&hit.memory_id)
                        .filter(|entry| {
                            filter.as_ref().is_none_or(|predicate| {
                                predicate.matches(&memory_graph_filter_metadata(entry))
                            })
                        })
                        .map(|entry| retrieval::ScoredChunk {
                            id: entry.memory_id.clone(),
                            source: ChunkSource::Memory,
                            space_id: None,
                            content: entry.content.clone(),
                            score: hit.score,
                        })
                })
                .collect::<Vec<_>>()
        }
        Err(error) => {
            tracing::warn!("memory graph search source scan failed (skipping): {error:#}");
            Vec::new()
        }
    };
    let chunks = if graph_chunks.is_empty() {
        vector_chunks
    } else {
        retrieval::fuse_ranked_lists(vector_chunks, vec![graph_chunks], opts.top_k)
    };
    Json(expansion_fields(json!({ "chunks": chunks }))).into_response()
}

/// The metadata a retrieval `filter` sees for a memory-graph hit: the same
/// built-in fields `retrieval.db` memory chunks expose.
pub(in crate::server) fn memory_graph_filter_metadata(
    entry: &retrieval::MemoryGraphDocument,
) -> serde_json::Map<String, serde_json::Value> {
    let mut map = serde_json::Map::new();
    map.insert("source".into(), json!("memory"));
    map.insert("scope".into(), json!(entry.scope));
    if let Some(agent_id) = &entry.agent_id {
        map.insert("agent_id".into(), json!(agent_id));
    }
    map.insert("importance".into(), json!(entry.importance));
    map
}
