//! Working memory: the HTTP surface, the per-turn context block, and the
//! agent-side update helper.
//!
//! The storage, merge, and validation rules live in `ryu_memory::working`; this
//! module is the Core host wiring:
//!
//! - `GET/PUT/DELETE /api/memory/working?scope=thread|resource&id=…` — the
//!   caller's own scratchpad; `GET /api/memory/working/history` lists its
//!   recent versions ([`history`]). The owner is derived server-side (verified user on
//!   a bound node, the local principal on an unbound one), so a guessed id can
//!   never reach another user's partition. A `thread` id that names an existing
//!   conversation is additionally gated by that conversation's ACL.
//! - [`turn_context_block`] — the block `route_chat_stream` appends to the turn
//!   context when the active agent's `MemorySlot.working_memory` is enabled.
//! - [`apply_agent_update`] — the write behind the built-in
//!   `working_memory.update_working_memory` tool.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::memory::{
    render_working_memory_block, WorkingMemory, WorkingMemoryConfig, WorkingMemoryError,
    WorkingMemoryMode, WorkingMemoryScope, WorkingMemoryWrite,
};
use super::{json_error, ServerState};
use crate::agents::AgentStore;
use ryu_kernel_contracts::ResourceKey;

/// The model-facing name of the update tool. Also the bare tool name inside the
/// `working_memory` built-in server.
pub const UPDATE_TOOL_NAME: &str = "update_working_memory";

#[path = "memory_working_history.rs"]
pub mod history;

pub(super) fn routes() -> Router<ServerState> {
    Router::new()
        .route(
            "/api/memory/working",
            get(get_working_memory)
                .put(put_working_memory)
                .delete(delete_working_memory),
        )
        .route(
            "/api/memory/working/history",
            get(history::get_working_memory_history),
        )
}

#[derive(Debug, Deserialize)]
pub struct WorkingMemoryQuery {
    scope: String,
    id: String,
}

/// Resolve `(scope, id, owner key)` for an HTTP caller, enforcing the memory
/// permission and, for a known thread, the conversation ACL.
async fn authorize(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    query: &WorkingMemoryQuery,
    write: bool,
) -> Result<(WorkingMemoryScope, ResourceKey), axum::response::Response> {
    let permission = if write {
        crate::identity_verify::permissions::SPACE_WRITE
    } else {
        crate::identity_verify::permissions::SPACE_READ
    };
    super::require_memory_permission(state, caller, permission).await?;
    let Some(scope) = WorkingMemoryScope::parse(&query.scope) else {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "scope must be `thread` or `resource`".to_owned(),
        ));
    };
    let Some(user_id) = super::memory_settings_user_id(caller) else {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "a verified user is required for working memory on an organization node".to_owned(),
        ));
    };
    if scope == WorkingMemoryScope::Thread && !query.id.trim().is_empty() {
        super::require_conversation_access_if_known(state, caller, query.id.trim(), write).await?;
    }
    let org = caller.as_ref().and_then(|c| c.org_id.as_deref());
    Ok((scope, ResourceKey::owned(Some(&user_id), org)))
}

fn store_error(error: &anyhow::Error) -> axum::response::Response {
    match error.downcast_ref::<WorkingMemoryError>() {
        Some(WorkingMemoryError::Invalid(message)) => {
            json_error(StatusCode::BAD_REQUEST, message.clone())
        }
        Some(conflict @ WorkingMemoryError::Conflict { current }) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": conflict.to_string(), "current_version": current })),
        )
            .into_response(),
        None => json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("{error:#}")),
    }
}

fn envelope(scope: WorkingMemoryScope, id: &str, doc: Option<&WorkingMemory>) -> Value {
    json!({
        "scope": scope.as_str(),
        "id": id.trim(),
        "working_memory": doc,
    })
}

/// `GET /api/memory/working?scope=thread|resource&id=…`
#[utoipa::path(
    get,
    path = "/api/memory/working",
    tag = "Memory",
    summary = "Get working memory",
    params(
        ("scope" = String, Query, description = "thread | resource"),
        ("id" = String, Query, description = "Thread (conversation) id or resource id")
    ),
    responses(
        (status = 200, description = "The caller's working memory, or null when none is stored", body = serde_json::Value),
        (status = 400, description = "Invalid scope or id", body = serde_json::Value),
        (status = 403, description = "Not permitted", body = serde_json::Value),
        (status = 404, description = "Thread not visible to the caller", body = serde_json::Value)
    )
)]
pub async fn get_working_memory(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(query): Query<WorkingMemoryQuery>,
) -> axum::response::Response {
    let (scope, key) = match authorize(&state, &caller, &query, false).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    match state
        .memory
        .get_working_memory(&key, scope, &query.id)
        .await
    {
        Ok(doc) => Json(envelope(scope, &query.id, doc.as_ref())).into_response(),
        Err(error) => store_error(&error),
    }
}

/// `PUT /api/memory/working?scope=thread|resource&id=…`
///
/// Body: `{ content?, data?, template?, schema?, mode?, replace?, expected_version? }`.
/// Template mode replaces `content`; schema mode merge-patches `data` (RFC 7386)
/// unless `replace` is true, then validates against the schema.
#[utoipa::path(
    put,
    path = "/api/memory/working",
    tag = "Memory",
    summary = "Create or update working memory",
    params(
        ("scope" = String, Query, description = "thread | resource"),
        ("id" = String, Query, description = "Thread (conversation) id or resource id")
    ),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "The stored working memory", body = serde_json::Value),
        (status = 400, description = "Invalid request or schema violation", body = serde_json::Value),
        (status = 403, description = "Not permitted", body = serde_json::Value),
        (status = 409, description = "expected_version did not match", body = serde_json::Value)
    )
)]
pub async fn put_working_memory(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(query): Query<WorkingMemoryQuery>,
    Json(write): Json<WorkingMemoryWrite>,
) -> axum::response::Response {
    let (scope, key) = match authorize(&state, &caller, &query, true).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    match state
        .memory
        .put_working_memory(&key, scope, &query.id, write)
        .await
    {
        Ok(doc) => Json(envelope(scope, &query.id, Some(&doc))).into_response(),
        Err(error) => store_error(&error),
    }
}

/// `DELETE /api/memory/working?scope=thread|resource&id=…`
#[utoipa::path(
    delete,
    path = "/api/memory/working",
    tag = "Memory",
    summary = "Delete working memory",
    params(
        ("scope" = String, Query, description = "thread | resource"),
        ("id" = String, Query, description = "Thread (conversation) id or resource id")
    ),
    responses(
        (status = 200, description = "Whether a document was removed", body = serde_json::Value),
        (status = 403, description = "Not permitted", body = serde_json::Value)
    )
)]
pub async fn delete_working_memory(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(query): Query<WorkingMemoryQuery>,
) -> axum::response::Response {
    let (scope, key) = match authorize(&state, &caller, &query, true).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    match state
        .memory
        .delete_working_memory(&key, scope, &query.id)
        .await
    {
        Ok(deleted) => Json(json!({ "deleted": deleted })).into_response(),
        Err(error) => store_error(&error),
    }
}

/// The enabled working-memory configuration of `agent_id`, if any.
pub(crate) async fn agent_config(
    agent_store: &AgentStore,
    agent_id: Option<&str>,
) -> Option<WorkingMemoryConfig> {
    let id = agent_id.filter(|id| !id.is_empty())?;
    match agent_store.get(id).await {
        Ok(Some(record)) => record
            .memory
            .and_then(|slot| slot.working_memory)
            .filter(|config| config.enabled),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!("working memory: agent lookup failed for {id}: {error:#}");
            None
        }
    }
}

/// The document id a turn addresses: the conversation for `thread` scope, the
/// owning user for `resource` scope (the Core chat "resource" is the person).
pub(crate) fn target_id<'a>(
    config: &WorkingMemoryConfig,
    conversation_id: Option<&'a str>,
    owner: &'a str,
) -> Option<&'a str> {
    match config.scope {
        WorkingMemoryScope::Thread => conversation_id.filter(|id| !id.trim().is_empty()),
        WorkingMemoryScope::Resource => Some(owner).filter(|id| !id.trim().is_empty()),
    }
}

/// Build the per-turn working-memory block for the active agent, or `None` when
/// the agent has no working memory enabled or the turn has no addressable id.
/// Fail-open: a storage error logs and yields `None` rather than failing a turn.
pub(crate) async fn turn_context_block(
    memory: &super::memory::MemoryStore,
    agent_store: &AgentStore,
    agent_id: Option<&str>,
    conversation_id: Option<&str>,
    owner: &str,
) -> Option<String> {
    let config = agent_config(agent_store, agent_id).await?;
    let id = target_id(&config, conversation_id, owner)?;
    let key = ResourceKey::owned(Some(owner), None);
    let doc = match memory.get_working_memory(&key, config.scope, id).await {
        Ok(doc) => doc,
        Err(error) => {
            tracing::warn!("working memory: read failed: {error:#}");
            return None;
        }
    };
    Some(render_working_memory_block(
        doc.as_ref(),
        &config,
        UPDATE_TOOL_NAME,
    ))
}

/// Whether the `update_working_memory` tool, dispatched for this turn, would
/// write the same owner partition the turn reads as `owner`.
///
/// The turn reads the scratchpad of the person chatting, but tool dispatch
/// derives its principal from the host conversation (its owner on an
/// organization node). In a shared conversation where another member is
/// chatting the two differ, and injecting the block would let the agent copy
/// that member's notes into the conversation owner's scratchpad. Such turns get
/// no working memory.
pub(crate) async fn tool_writes_owner(
    conversations: &crate::server::conversations::ConversationStore,
    conversation_id: Option<&str>,
    owner: &str,
) -> bool {
    let principal =
        crate::sidecar::mcp::ToolPrincipal::resolve_optional(Some(conversations), conversation_id)
            .await;
    principal_matches_owner(&principal, owner)
}

fn principal_matches_owner(principal: &crate::sidecar::mcp::ToolPrincipal, owner: &str) -> bool {
    crate::sidecar::mcp::working_memory_tool::owner_for(principal)
        .is_ok_and(|tool_owner| tool_owner == owner)
}

/// Apply an agent's `update_working_memory` call. `owner` is the server-derived
/// principal; the model supplies only the new content / patch and, optionally,
/// the `expected_version` it read. Without one the write is unconditional, as
/// before; with a stale one the call fails with [`conflict_error`].
pub(crate) async fn apply_agent_update(
    memory: &super::memory::MemoryStore,
    config: &WorkingMemoryConfig,
    conversation_id: Option<&str>,
    owner: &str,
    arguments: &Value,
) -> anyhow::Result<Value> {
    let id = target_id(config, conversation_id, owner)
        .ok_or_else(|| anyhow::anyhow!("thread working memory needs a host conversation"))?;
    let key = ResourceKey::owned(Some(owner), None);
    let mode = config.mode();
    let expected_version = parse_expected_version(arguments)?;
    let mut write = WorkingMemoryWrite {
        mode: Some(mode),
        expected_version,
        ..Default::default()
    };
    match mode {
        WorkingMemoryMode::Template => {
            let content = arguments
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow::anyhow!("`content` (the complete updated Markdown) is required")
                })?;
            write.content = Some(content.to_owned());
            write.template = config.template.clone();
        }
        WorkingMemoryMode::Schema => {
            let data = match arguments.get("data") {
                Some(Value::String(raw)) => serde_json::from_str::<Value>(raw)
                    .map_err(|_| anyhow::anyhow!("`data` must be a JSON object"))?,
                Some(value) => value.clone(),
                None => anyhow::bail!("`data` (a JSON merge patch) is required"),
            };
            write.data = Some(data);
            write.schema = config.schema.clone();
        }
    }
    let doc = match memory
        .put_working_memory(&key, config.scope, id, write)
        .await
    {
        Ok(doc) => doc,
        Err(error) => {
            if let Some(WorkingMemoryError::Conflict { current }) =
                error.downcast_ref::<WorkingMemoryError>()
            {
                let latest = memory
                    .get_working_memory(&key, config.scope, id)
                    .await
                    .ok()
                    .flatten();
                return Err(conflict_error(
                    expected_version.unwrap_or_default(),
                    *current,
                    latest.as_ref(),
                ));
            }
            return Err(error);
        }
    };
    Ok(json!({
        "ok": true,
        "scope": doc.scope.as_str(),
        "mode": doc.mode.as_str(),
        "version": doc.version,
    }))
}

/// Read the optional `expected_version` argument: a non-negative integer (a
/// numeric string is accepted, since some models quote numbers). Absent or
/// `null` means an unconditional write.
fn parse_expected_version(arguments: &Value) -> anyhow::Result<Option<i64>> {
    let parsed = match arguments.get("expected_version") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Number(number)) => number.as_i64(),
        Some(Value::String(raw)) => raw.trim().parse::<i64>().ok(),
        Some(_) => None,
    };
    match parsed {
        Some(version) if version >= 0 => Ok(Some(version)),
        _ => anyhow::bail!(
            "`expected_version` must be a non-negative integer: the version shown in your \
             working memory, or the one your last update returned"
        ),
    }
}

/// The error an agent gets when its `expected_version` is stale: what happened,
/// what to do, and the current document to merge into, so it can recover in
/// the same turn without a separate read tool.
fn conflict_error(expected: i64, current: i64, latest: Option<&WorkingMemory>) -> anyhow::Error {
    let mut message = format!(
        "working memory version conflict: you sent expected_version {expected}, but the document \
         is now at version {current} because it changed after you read it. Your update was NOT \
         saved. Re-read the current document below, merge your change into it, and call \
         `{UPDATE_TOOL_NAME}` again with expected_version: {current}."
    );
    let body = latest.map(|doc| match doc.mode {
        WorkingMemoryMode::Template => doc.content.clone().unwrap_or_default(),
        WorkingMemoryMode::Schema => doc
            .data
            .as_ref()
            .and_then(|data| serde_json::to_string_pretty(data).ok())
            .unwrap_or_else(|| "{}".to_owned()),
    });
    match body {
        Some(body) if !body.trim().is_empty() => {
            message.push_str(&format!(
                "\n\nCurrent document (version {current}):\n{}",
                body.trim_end()
            ));
        }
        Some(_) => message.push_str("\n\nThe current document is empty."),
        None => {}
    }
    anyhow::anyhow!(message)
}

#[cfg(test)]
#[path = "memory_working_tests.rs"]
mod tests;
