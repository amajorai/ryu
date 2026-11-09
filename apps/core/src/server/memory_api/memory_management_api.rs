//! Memory management API (/api/memory).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Memory management API (/api/memory) ──────────────────────────────────────
// First-class CRUD over long-term memory so the desktop Memory Library can
// browse, classify, and curate facts. Writes keep the retrieval index in sync so
// a created/edited fact is immediately RAG-retrievable (and a deleted one gone).

/// Resolve the principal whose sensitive-memory consent may be read or changed.
/// A bound node must have a verified user; an unbound node has one local principal.
pub(in crate::server) fn memory_settings_user_id(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> Option<String> {
    if crate::sidecar::node_binding::node_bound_for_tenancy() {
        caller.as_ref().map(|value| value.user_id.clone())
    } else {
        Some(memory::LOCAL_USER.to_owned())
    }
}

pub(in crate::server) async fn require_memory_permission(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &str,
) -> Result<(), axum::response::Response> {
    if enforce_permission(state, caller, permission).await.is_err() {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            format!("insufficient permissions: {permission}"),
        ));
    }
    Ok(())
}

/// Resolve sensitive-memory consent for a request. Missing or unreadable state is
/// deliberately false: this preference grants access to special-category facts.
pub(in crate::server) async fn sensitive_memory_enabled(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> bool {
    let Some(user_id) = memory_settings_user_id(caller) else {
        return false;
    };
    state
        .memory
        .include_sensitive_topics(&user_id)
        .await
        .unwrap_or(false)
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct MemorySettingsBody {
    pub(in crate::server) include_sensitive_topics: bool,
}

#[utoipa::path(
    get,
    path = "/api/memory/settings",
    tag = "Memory",
    summary = "Get memory privacy settings",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_memory_settings(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    if let Err(response) = require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
    )
    .await
    {
        return response;
    }
    let Some(user_id) = memory_settings_user_id(&caller) else {
        return json_error(
            StatusCode::FORBIDDEN,
            "a verified user is required to read sensitive memory settings".to_owned(),
        );
    };
    let enabled = state
        .memory
        .include_sensitive_topics(&user_id)
        .await
        .unwrap_or(false);
    Json(json!({ "include_sensitive_topics": enabled })).into_response()
}

#[utoipa::path(
    put,
    path = "/api/memory/settings",
    tag = "Memory",
    summary = "Update memory privacy settings",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn update_memory_settings(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<MemorySettingsBody>,
) -> axum::response::Response {
    if let Err(response) = require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
    )
    .await
    {
        return response;
    }
    let Some(user_id) = memory_settings_user_id(&caller) else {
        return json_error(
            StatusCode::FORBIDDEN,
            "a verified user is required to change sensitive memory settings".to_owned(),
        );
    };
    match state
        .memory
        .set_include_sensitive_topics(&user_id, body.include_sensitive_topics)
        .await
    {
        Ok(()) => {
            if !body.include_sensitive_topics {
                // Revoke first, then remove every derived row for this principal.
                // The set-based cleanup is not capped by the source-store page
                // size, and every read path also checks consent so a retry after
                // a cleanup failure remains fail-closed.
                let owner = node_org_id().is_some().then_some(user_id.as_str());
                if let Err(error) = state.retrieval.clear_sensitive_memory_chunks(owner).await {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
                }
            }
            Json(json!({
                "include_sensitive_topics": body.include_sensitive_topics
            }))
            .into_response()
        }
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct MemoryGraphQuery {
    #[serde(default)]
    pub(in crate::server) agent_id: Option<String>,
    #[serde(default)]
    pub(in crate::server) project_id: Option<String>,
    #[serde(default)]
    pub(in crate::server) max_nodes: Option<usize>,
    #[serde(default)]
    pub(in crate::server) max_edges: Option<usize>,
}

pub(in crate::server) fn memory_graph_document(
    entry: &memory::LongTermEntry,
) -> retrieval::MemoryGraphDocument {
    retrieval::MemoryGraphDocument {
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

/// Build an access-filtered typed graph from the encrypted memory source. The
/// graph is a bounded derived projection; it is never treated as an ACL or a
/// second source of truth.
#[utoipa::path(
    get,
    path = "/api/memory/graph",
    tag = "Memory",
    summary = "Get the typed memory graph",
    params(("agent_id" = Option<String>, Query), ("project_id" = Option<String>, Query), ("max_nodes" = Option<usize>, Query), ("max_edges" = Option<usize>, Query)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_memory_graph(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Query(query): axum::extract::Query<MemoryGraphQuery>,
) -> axum::response::Response {
    if let Err(response) = require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
    )
    .await
    {
        return response;
    }
    let node_bound = crate::sidecar::node_binding::node_bound_for_tenancy();
    let caller_user_id = caller.as_ref().map(|value| value.user_id.clone());
    let caller_org_id = caller.as_ref().and_then(|value| value.org_id.clone());
    let include_sensitive = sensitive_memory_enabled(&state, &caller).await;
    let facts = match state.memory.all_for_backfill(500).await {
        Ok(facts) => facts,
        Err(error) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let graph = retrieval::MemoryGraph::from_documents(facts.iter().map(memory_graph_document));
    let allowed_scopes = [
        "agent".to_owned(),
        "user".to_owned(),
        "node".to_owned(),
        "project".to_owned(),
        "org".to_owned(),
    ];
    let filter = retrieval::MemoryGraphQuery {
        agent_id: query.agent_id.as_deref(),
        include_all_agents: query.agent_id.is_none(),
        allowed_scopes: Some(&allowed_scopes),
        project_id: query.project_id.as_deref(),
        include_all_projects: query.project_id.is_none(),
        node_bound,
        caller_user_id: caller_user_id.as_deref(),
        caller_org_id: caller_org_id.as_deref(),
        include_sensitive,
    };
    let snapshot = graph.snapshot(
        &filter,
        query.max_nodes.unwrap_or(160).clamp(1, 500),
        query.max_edges.unwrap_or(320).clamp(1, 1_000),
    );
    Json(snapshot).into_response()
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct MemoryListQuery {
    #[serde(default)]
    pub(in crate::server) scope: Option<String>,
    #[serde(default)]
    pub(in crate::server) scope_id: Option<String>,
    #[serde(default)]
    pub(in crate::server) category: Option<String>,
    #[serde(default)]
    pub(in crate::server) limit: Option<usize>,
    /// One lifecycle to list (`active`, `superseded`, `archived`,
    /// `retracted`), or `all`. Wins over `include_history`.
    #[serde(default)]
    pub(in crate::server) lifecycle: Option<String>,
    /// List every lifecycle rather than only active memories.
    #[serde(default)]
    pub(in crate::server) include_history: bool,
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct CreateMemoryBody {
    pub(in crate::server) content: String,
    #[serde(default)]
    pub(in crate::server) scope: Option<String>,
    #[serde(default)]
    pub(in crate::server) scope_id: Option<String>,
    #[serde(default)]
    pub(in crate::server) category: Option<String>,
    #[serde(default)]
    pub(in crate::server) importance: Option<i32>,
    #[serde(default)]
    pub(in crate::server) when_to_use: Option<String>,
    #[serde(default)]
    pub(in crate::server) tags: Option<Vec<String>>,
    #[serde(default)]
    pub(in crate::server) agent_id: Option<String>,
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct UpdateMemoryBody {
    #[serde(default)]
    pub(in crate::server) content: Option<String>,
    #[serde(default)]
    pub(in crate::server) scope: Option<String>,
    /// Present-with-null clears the project/node id; absent leaves it unchanged.
    #[serde(default, deserialize_with = "double_option")]
    pub(in crate::server) scope_id: Option<Option<String>>,
    #[serde(default)]
    pub(in crate::server) category: Option<String>,
    #[serde(default)]
    pub(in crate::server) importance: Option<i32>,
    #[serde(default, deserialize_with = "double_option")]
    pub(in crate::server) when_to_use: Option<Option<String>>,
    #[serde(default)]
    pub(in crate::server) tags: Option<Vec<String>>,
}

/// Distinguish "field absent" from "field present and null" for patch semantics.
pub(in crate::server) fn double_option<'de, T, D>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    serde::Deserialize::deserialize(deserializer).map(Some)
}

/// Best-effort: mirror a memory entry into the retrieval index so it is
/// immediately RAG-retrievable. Logs and continues on failure (fail-open).
pub(crate) async fn index_memory_entry(state: &ServerState, entry: &memory::LongTermEntry) {
    if entry.lifecycle != memory::MemoryLifecycle::Active {
        // Inactive rows remain available for audit/rollback, but must never be
        // reintroduced into the retrieval projection by a stale index request.
        let _ = state.retrieval.remove_chunk(&entry.id).await;
        return;
    }
    // A revoked consent must not leave a plaintext/vector projection behind.
    // Read gating below is still authoritative, but removing the derived row
    // narrows the at-rest exposure as soon as this bridge runs.
    let consent_user = entry.owner_user_id.as_deref().unwrap_or(memory::LOCAL_USER);
    if !entry.sensitive_topics.is_empty()
        && !state
            .memory
            .include_sensitive_topics(consent_user)
            .await
            .unwrap_or(false)
    {
        let _ = state.retrieval.remove_chunk(&entry.id).await;
        return;
    }
    // Denormalize the memory's owner onto its retrieval chunk so the per-caller
    // filter (`memory_tenancy_allows`) runs in-process. On an unbound node, or for a
    // legacy `'local'`-owned row, stamp `shared()` — the retrieval memory filter is a
    // no-op on an unbound node, and the bind-time backfill re-stamps legacy rows.
    let node_org = node_org_id();
    let owner = match (node_org.as_deref(), entry.owner_user_id.as_deref()) {
        (Some(org), Some(uid)) if uid != memory::LOCAL_USER => {
            retrieval::RetrievalOwner::owned(Some(uid), Some(org), None)
        }
        _ => retrieval::RetrievalOwner::shared(),
    };
    if let Err(e) = state
        .retrieval
        .index_memory_chunk_with_metadata(
            &entry.id,
            &entry.content,
            entry.scope.as_str(),
            entry.scope_id.as_deref(),
            entry.category.as_str(),
            entry.importance,
            entry.author_agent_id.as_deref(),
            !entry.sensitive_topics.is_empty(),
            owner,
        )
        .await
    {
        tracing::warn!(
            "memory: indexing entry {} failed (search may lag): {e:#}",
            entry.id
        );
    }
}
