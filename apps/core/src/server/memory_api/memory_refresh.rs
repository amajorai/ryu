//! Retrieval handlers and the memory management API: `refresh_memory_retrieval_metadata` through `delete_memory`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Refresh metadata for already-indexed memory rows without making a provider
/// call. This closes the migration window for old retrieval rows that predate
/// agent and sensitivity fields, so direct search cannot treat an old sensitive
/// fact as ordinary merely because its projection is stale.
pub(in crate::server) async fn refresh_memory_retrieval_metadata(
    state: &ServerState,
    entries: &[memory::LongTermEntry],
) {
    let node_org = node_org_id();
    for entry in entries {
        let owner = match (node_org.as_deref(), entry.owner_user_id.as_deref()) {
            (Some(org), Some(uid)) if uid != memory::LOCAL_USER => {
                retrieval::RetrievalOwner::owned(Some(uid), Some(org), None)
            }
            _ => retrieval::RetrievalOwner::shared(),
        };
        if let Err(error) = state
            .retrieval
            .update_memory_metadata(
                &entry.id,
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
                "memory: refreshing retrieval metadata for {} failed: {error:#}",
                entry.id
            );
        }
    }
}

#[utoipa::path(
    get,
    path = "/api/memory",
    tag = "Memory",
    summary = "List memory entries",
    params(("scope" = Option<String>, Query, description = "user | node | project | org"), ("scope_id" = Option<String>, Query), ("category" = Option<String>, Query), ("limit" = Option<usize>, Query)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_memory(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Query(q): axum::extract::Query<MemoryListQuery>,
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
    let filter = memory::MemoryFilter {
        scope: q.scope.as_deref().map(memory::MemoryScope::from_str),
        scope_id: q.scope_id,
        category: q.category.as_deref().map(memory::MemoryCategory::from_str),
        limit: q.limit,
        lifecycle: None,
    };
    // Per-caller tenancy: a bound-node member sees the shared node/project brain plus
    // only their OWN user-scope facts. Unbound → unrestricted (byte-identical).
    let vis = memory::MemoryVisibility::for_caller_in_org(
        caller.as_ref().map(|c| c.user_id.as_str()),
        caller.as_ref().and_then(|c| c.org_id.as_deref()),
        node_org_id().is_some(),
    );
    let include_sensitive = sensitive_memory_enabled(&state, &caller).await;
    match state
        .memory
        .list_visible_with_sensitive(&filter, vis, include_sensitive)
        .await
    {
        Ok(entries) => Json(json!({ "memories": entries })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub(in crate::server) async fn create_memory(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<CreateMemoryBody>,
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
    let scope = body
        .scope
        .as_deref()
        .map(memory::MemoryScope::from_str)
        .unwrap_or_default();
    let agent = body
        .agent_id
        .clone()
        .unwrap_or_else(|| "default".to_owned());
    let sensitive_topics = memory::detect_sensitive_topics(&body.content);
    if !sensitive_topics.is_empty() && !sensitive_memory_enabled(&state, &caller).await {
        return json_error(
            StatusCode::BAD_REQUEST,
            "sensitive topics are disabled in Settings → Memory".to_owned(),
        );
    }
    if !sensitive_topics.is_empty() && scope != memory::MemoryScope::User {
        return json_error(
            StatusCode::BAD_REQUEST,
            "sensitive memory must use user scope; shared and agent scopes are not supported"
                .to_owned(),
        );
    }
    // An org-scope fact's owning org is SERVER-derived, never client-supplied:
    // accepting a caller's `scope_id` here would let anyone publish a memory into an
    // org they do not belong to. The caller's verified org wins, and with no
    // resolvable org the write is refused rather than silently downgraded to a
    // narrower scope the user did not ask for.
    let scope_id = if scope == memory::MemoryScope::Agent {
        Some(agent.clone())
    } else if scope == memory::MemoryScope::Org {
        match caller.as_ref().and_then(|c| c.org_id.clone()) {
            Some(org) => Some(org),
            None => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "org-scope memory requires a caller with a verified organization".to_string(),
                );
            }
        }
    } else {
        body.scope_id
    };
    if scope == memory::MemoryScope::Project
        && scope_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "project-scope memory requires a non-empty scope_id".to_owned(),
        );
    }
    let new = memory::NewMemory {
        content: body.content,
        scope,
        scope_id,
        category: body
            .category
            .as_deref()
            .map(memory::MemoryCategory::from_str)
            .unwrap_or_default(),
        importance: body.importance.unwrap_or(memory::DEFAULT_IMPORTANCE),
        when_to_use: body.when_to_use,
        tags: body.tags.unwrap_or_default(),
        author_agent_id: if scope == memory::MemoryScope::Agent {
            Some(agent.clone())
        } else {
            body.agent_id.clone()
        },
    };
    // Stamp the verified caller as the fact's owner on a bound node (the per-user
    // tenancy key); unbound → LOCAL_USER, byte-identical to the pre-ACL build.
    let owner = memory_owner_user_id(&caller);
    match state.memory.record_full(&owner, &agent, new).await {
        Ok(Some(id)) => match state.memory.get(&id).await {
            Ok(Some(entry)) => {
                index_memory_entry(&state, &entry).await;
                (StatusCode::CREATED, Json(json!({ "memory": entry }))).into_response()
            }
            _ => Json(json!({ "id": id })).into_response(),
        },
        Ok(None) => json_error(StatusCode::BAD_REQUEST, "content is empty".to_string()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    get,
    path = "/api/memory/{id}",
    tag = "Memory",
    summary = "Get one memory entry",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_memory(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
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
    match state.memory.get(&id).await {
        Ok(Some(entry)) => {
            // Per-caller tenancy: another member cannot read a private (user-scope)
            // fact by id. A 404 (not 403) so the id's existence is not confirmed.
            if !memory_access_ok(&caller, &entry)
                || (!sensitive_memory_enabled(&state, &caller).await
                    && !entry.sensitive_topics.is_empty())
            {
                return json_error(StatusCode::NOT_FOUND, "memory not found".to_string());
            }
            Json(json!({ "memory": entry })).into_response()
        }
        Ok(None) => json_error(StatusCode::NOT_FOUND, "memory not found".to_string()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    put,
    path = "/api/memory/{id}",
    tag = "Memory",
    summary = "Update a memory entry",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn update_memory(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateMemoryBody>,
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
    // Per-caller tenancy: a member cannot mutate another's private fact. Load first
    // so the gate reads the row's owner + scope (404 hides existence on denial).
    let existing = match state.memory.get(&id).await {
        Ok(Some(entry))
            if !memory_access_ok(&caller, &entry)
                || (!sensitive_memory_enabled(&state, &caller).await
                    && !entry.sensitive_topics.is_empty()) =>
        {
            return json_error(StatusCode::NOT_FOUND, "memory not found".to_string());
        }
        Ok(Some(entry)) => entry,
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "memory not found".to_string()),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if let Some(content) = body.content.as_deref() {
        if !memory::detect_sensitive_topics(content).is_empty()
            && !sensitive_memory_enabled(&state, &caller).await
        {
            return json_error(
                StatusCode::BAD_REQUEST,
                "sensitive topics are disabled in Settings → Memory".to_owned(),
            );
        }
    }
    // The gate above checks the row's CURRENT scope, but a patch may CHANGE it —
    // so re-scoping needs its own gate, or any member could promote a personal fact
    // to organization-wide (or pull an org fact down into their own private set).
    // Server-derive the org id on a re-scope to `org` for the same reason
    // `create_memory` does, and refuse when no org is resolvable.
    let new_scope = body.scope.as_deref().map(memory::MemoryScope::from_str);
    let resulting_scope = new_scope.unwrap_or(existing.scope);
    let resulting_sensitive = body
        .content
        .as_deref()
        .map(|content| !memory::detect_sensitive_topics(content).is_empty())
        .unwrap_or(!existing.sensitive_topics.is_empty());
    if resulting_sensitive && resulting_scope != memory::MemoryScope::User {
        return json_error(
            StatusCode::BAD_REQUEST,
            "sensitive memory must use user scope; shared and agent scopes are not supported"
                .to_owned(),
        );
    }
    // `MemoryPatch::scope_id` is doubly-optional: `None` leaves it alone, `Some(None)`
    // clears it. A re-scope to org must SET it, hence `Some(Some(org))`.
    let scope_id = if new_scope == Some(memory::MemoryScope::Agent) {
        match existing.author_agent_id.clone() {
            Some(agent_id) if !agent_id.trim().is_empty() => Some(Some(agent_id)),
            _ => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "an agent-scope memory requires an authored agent".to_owned(),
                );
            }
        }
    } else if new_scope == Some(memory::MemoryScope::Org) {
        match caller.as_ref().and_then(|c| c.org_id.clone()) {
            Some(org) => Some(Some(org)),
            None => {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    "re-scoping a memory to org requires a caller with a verified organization"
                        .to_string(),
                );
            }
        }
    } else {
        body.scope_id
    };
    let effective_project_scope_id = match scope_id.as_ref() {
        Some(Some(value)) => Some(value.as_str()),
        Some(None) => None,
        None if new_scope.is_none() => existing.scope_id.as_deref(),
        None => None,
    };
    if resulting_scope == memory::MemoryScope::Project
        && effective_project_scope_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "project-scope memory requires a non-empty scope_id".to_owned(),
        );
    }
    let patch = memory::MemoryPatch {
        content: body.content,
        scope: new_scope,
        scope_id,
        category: body
            .category
            .as_deref()
            .map(memory::MemoryCategory::from_str),
        importance: body.importance,
        when_to_use: body.when_to_use,
        tags: body.tags,
    };
    match state.memory.update(&id, patch).await {
        Ok(Some(entry)) => {
            index_memory_entry(&state, &entry).await;
            Json(json!({ "memory": entry })).into_response()
        }
        Ok(None) => json_error(StatusCode::NOT_FOUND, "memory not found".to_string()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub(in crate::server) async fn delete_memory(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
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
    // Per-caller tenancy: a member cannot delete another's private fact.
    match state.memory.get(&id).await {
        Ok(Some(entry))
            if !memory_access_ok(&caller, &entry)
                || (!sensitive_memory_enabled(&state, &caller).await
                    && !entry.sensitive_topics.is_empty()) =>
        {
            return json_error(StatusCode::NOT_FOUND, "memory not found".to_string());
        }
        Ok(None) => return json_error(StatusCode::NOT_FOUND, "memory not found".to_string()),
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Ok(Some(_)) => {}
    }
    match state.memory.delete(&id).await {
        Ok(removed) => {
            let _ = state.retrieval.remove_chunk(&id).await;
            Json(json!({ "success": true, "removed": removed })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
