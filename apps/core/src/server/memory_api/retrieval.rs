//! Retrieval handlers (spec unit U17).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Retrieval handlers (spec unit U17) ────────────────────────────────────────
//
// Auto-injection IS now wired: the `chat_stream` handler resolves the
// `auto-recall-enabled` pref (default ON) and threads an `AutoRecallConfig` into
// `route_chat_stream`, which retrieves relevant long-term memory + past chat
// messages (current conversation excluded) and folds them into `long_term_system`
// so both planes inherit it (fail-open). These explicit endpoints remain for
// indexing chunks and for direct/manual retrieval queries.

#[derive(serde::Deserialize)]
pub(in crate::server) struct IndexChunkBody {
    pub(in crate::server) id: String,
    /// "memory" or "space" (defaults to "memory").
    #[serde(default)]
    pub(in crate::server) source: Option<String>,
    #[serde(default)]
    pub(in crate::server) space_id: Option<String>,
    pub(in crate::server) content: String,
    /// Filterable JSON metadata object (Space chunks only) matched by the
    /// `filter` of `POST /api/retrieval/search`.
    #[serde(default)]
    pub(in crate::server) metadata: Option<serde_json::Value>,
}

pub(in crate::server) fn valid_retrieval_chunk_id(id: &str) -> bool {
    let id = id.trim();
    !id.is_empty() && id.len() <= 200 && !id.chars().any(char::is_control)
}

#[utoipa::path(
    post,
    path = "/api/retrieval/index",
    tag = "Retrieval",
    summary = "Index a retrieval chunk",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn index_retrieval_chunk(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<IndexChunkBody>,
) -> axum::response::Response {
    // Same coarse RBAC gate as `search_retrieval` below, but WRITE-side: indexing
    // plants a chunk into trusted RAG context, so it takes `space.write`, not
    // `space.read`. Without this gate a holder of only the node token resolved
    // `caller = None` and fell into the `shared()` arm below — attacker-authored
    // content became globally-retrievable context for every user on the node.
    // `enforce_permission` denies `None` callers on a bound node and allows
    // everyone on an unbound personal node, so local-first is untouched.
    if let Err(status) = enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
    )
    .await
    {
        return json_error(status, "forbidden".to_owned());
    }
    let chunk_id = body.id.trim();
    if !valid_retrieval_chunk_id(chunk_id) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "id must be between 1 and 200 bytes and contain no control characters".to_owned(),
        );
    }
    let source = match body.source.as_deref() {
        Some("space") => ChunkSource::Space,
        _ => ChunkSource::Memory,
    };
    if source == ChunkSource::Memory && body.metadata.as_ref().is_some_and(|m| !m.is_null()) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "metadata is only supported for space chunks; use the Memory API for memory facts"
                .to_owned(),
        );
    }
    if source == ChunkSource::Memory {
        // Memory content must enter the encrypted source of truth first. The old
        // endpoint used to create an orphaned plaintext retrieval row, bypassing
        // memory ownership, sensitivity, lifecycle, and the Memory Library.
        if !memory::detect_sensitive_topics(&body.content).is_empty()
            && !sensitive_memory_enabled(&state, &caller).await
        {
            return json_error(
                StatusCode::BAD_REQUEST,
                "sensitive topics are disabled in Settings → Memory".to_owned(),
            );
        }
        if body.content.trim().is_empty() {
            return json_error(StatusCode::BAD_REQUEST, "content is empty".to_owned());
        }
        let owner = memory_owner_user_id(&caller);
        match state.memory.get(chunk_id).await {
            Ok(Some(existing)) => {
                if !memory_access_ok(&caller, &existing)
                    || (!sensitive_memory_enabled(&state, &caller).await
                        && !existing.sensitive_topics.is_empty())
                {
                    return json_error(StatusCode::NOT_FOUND, "memory not found".to_owned());
                }
                let updated = state
                    .memory
                    .update(
                        chunk_id,
                        memory::MemoryPatch {
                            content: Some(body.content),
                            ..Default::default()
                        },
                    )
                    .await;
                match updated {
                    Ok(Some(entry)) => {
                        index_memory_entry(&state, &entry).await;
                        return Json(json!({ "success": true, "id": chunk_id })).into_response();
                    }
                    Ok(None) => {
                        return json_error(StatusCode::NOT_FOUND, "memory not found".to_owned());
                    }
                    Err(error) => {
                        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
                    }
                }
            }
            Ok(None) => {
                let mut memory = memory::NewMemory::user_fact(body.content);
                memory.author_agent_id = Some("default".to_owned());
                match state
                    .memory
                    .record_full_with_id(chunk_id, &owner, "default", memory)
                    .await
                {
                    Ok(Some(id)) => {
                        if let Ok(Some(entry)) = state.memory.get(&id).await {
                            index_memory_entry(&state, &entry).await;
                        }
                        return Json(json!({ "success": true, "id": id })).into_response();
                    }
                    Ok(None) => {
                        return json_error(StatusCode::BAD_REQUEST, "content is empty".to_owned());
                    }
                    Err(error) => {
                        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
                    }
                }
            }
            Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        }
    }
    // Stamp the indexing caller as the chunk's owner on a bound node so the
    // retrieval tenancy filter can gate it; unbound → shared (filter is a no-op).
    // A bound node with NO verified caller refuses outright rather than writing an
    // unattributed chunk: this handler carries no permission gate of its own (it
    // predates the RBAC epic), so any node-token holder — signed in or not — could
    // otherwise index content that lands owned by nobody. For a `Space` chunk that
    // used to be silently fail-open-visible to every member (the content-escape gap
    // `space_tenancy_allows` now closes); refusing here means the gap is never
    // reachable from this endpoint in the first place.
    let node_org = node_org_id();
    let owner = match (node_org.as_deref(), caller.as_ref()) {
        (Some(org), Some(c)) => {
            retrieval::RetrievalOwner::owned(Some(c.user_id.as_str()), Some(org), Some("private"))
        }
        // Bound node + unresolvable caller: refuse rather than stamp `shared()`
        // (globally retrievable). `enforce_permission` already denied this shape;
        // kept as a fail-closed backstop so a gate regression cannot reopen it.
        (Some(_), None) => {
            return json_error(
                StatusCode::FORBIDDEN,
                "authentication required to index retrieval content on a bound node".to_owned(),
            );
        }
        (None, _) => retrieval::RetrievalOwner::shared(),
    };
    if let Some(metadata) = body.metadata.as_ref().filter(|m| !m.is_null()) {
        let too_large = serde_json::to_string(metadata)
            .map(|encoded| encoded.len() > retrieval::MAX_CHUNK_METADATA_BYTES)
            .unwrap_or(true);
        if !metadata.is_object() || too_large {
            return json_error(
                StatusCode::BAD_REQUEST,
                format!(
                    "metadata must be a JSON object of at most {} bytes",
                    retrieval::MAX_CHUNK_METADATA_BYTES
                ),
            );
        }
    }
    // `space_id` is also the OKF bundle id column, so only a real Space id takes
    // the per-Space write check.
    if let Some(space_id) = body
        .space_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        if !matches!(state.spaces.space_access_meta(space_id).await, Ok(None)) {
            if let Err(response) =
                require_space_content_write(&state, &caller, space_id, "space not found").await
            {
                return response;
            }
        }
    }
    // The guarded upsert refuses to replace a memory projection, an OKF chunk,
    // or a chunk owned by someone else, so a caller-chosen id cannot take over
    // shared knowledge or another member's row.
    match state
        .retrieval
        .index_caller_space_chunk_with_metadata(
            chunk_id,
            body.space_id.as_deref(),
            &body.content,
            owner,
            body.metadata.as_ref(),
        )
        .await
    {
        Ok(true) => Json(json!({ "success": true, "id": chunk_id })).into_response(),
        Ok(false) => json_error(
            StatusCode::CONFLICT,
            "chunk id is already in use by content this caller cannot replace".to_owned(),
        ),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct RetrievalSearchBody {
    pub(in crate::server) query: String,
    #[serde(default)]
    pub(in crate::server) top_k: Option<usize>,
    #[serde(default)]
    pub(in crate::server) space_ids: Option<Vec<String>>,
    #[serde(default)]
    pub(in crate::server) include_memory: Option<bool>,
    #[serde(default)]
    pub(in crate::server) min_score: Option<f32>,
    #[serde(default)]
    pub(in crate::server) agent_id: Option<String>,
    /// Metadata predicate (`ryu_rag::MetadataFilter` JSON) every chunk must match.
    #[serde(default)]
    pub(in crate::server) filter: Option<serde_json::Value>,
    /// Hybrid BM25 + vector fusion for the Spaces searched (`{ "alpha": 0.5 }`).
    #[serde(default)]
    pub(in crate::server) hybrid: Option<retrieval::HybridOptions>,
    #[serde(flatten)]
    pub(in crate::server) expansion: retrieval_expansion::ExpansionRequest,
}

/// Parse and validate the shared filter / hybrid / expansion knobs of the
/// retrieval routes, or the 400 response explaining which one is malformed.
pub(in crate::server) fn parse_retrieval_knobs(
    filter: Option<&serde_json::Value>,
    hybrid: Option<&retrieval::HybridOptions>,
    expansion: &retrieval_expansion::ExpansionRequest,
) -> Result<Option<retrieval::MetadataFilter>, axum::response::Response> {
    if let Some(hybrid) = hybrid {
        hybrid
            .validate()
            .map_err(|e| json_error(StatusCode::BAD_REQUEST, format!("invalid hybrid: {e}")))?;
    }
    expansion
        .options()
        .validate()
        .map_err(|e| json_error(StatusCode::BAD_REQUEST, format!("invalid expansion: {e}")))?;
    filter
        .filter(|value| !value.is_null())
        .map(retrieval::MetadataFilter::parse)
        .transpose()
        .map_err(|e| json_error(StatusCode::BAD_REQUEST, format!("invalid filter: {e:#}")))
}
