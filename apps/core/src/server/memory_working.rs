//! Working memory: the HTTP surface, the per-turn context block, and the
//! agent-side update helper.
//!
//! The storage, merge, and validation rules live in `ryu_memory::working`; this
//! module is the Core host wiring:
//!
//! - `GET/PUT/DELETE /api/memory/working?scope=thread|resource&id=…` — the
//!   caller's own scratchpad. The owner is derived server-side (verified user on
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

pub(super) fn routes() -> Router<ServerState> {
    Router::new().route(
        "/api/memory/working",
        get(get_working_memory)
            .put(put_working_memory)
            .delete(delete_working_memory),
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
/// principal; the model supplies only the new content / patch.
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
    let mut write = WorkingMemoryWrite {
        mode: Some(mode),
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
    let doc = memory
        .put_working_memory(&key, config.scope, id, write)
        .await?;
    Ok(json!({
        "ok": true,
        "scope": doc.scope.as_str(),
        "mode": doc.mode.as_str(),
        "version": doc.version,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::memory::MemoryStore;

    fn template_config(scope: WorkingMemoryScope) -> WorkingMemoryConfig {
        WorkingMemoryConfig {
            enabled: true,
            scope,
            template: Some("# Task\n- goal:".to_owned()),
            schema: None,
        }
    }

    #[test]
    fn target_id_follows_scope() {
        let thread = template_config(WorkingMemoryScope::Thread);
        assert_eq!(target_id(&thread, Some("conv-1"), "alice"), Some("conv-1"));
        assert_eq!(target_id(&thread, None, "alice"), None);
        assert_eq!(target_id(&thread, Some("  "), "alice"), None);
        let resource = template_config(WorkingMemoryScope::Resource);
        assert_eq!(target_id(&resource, Some("conv-1"), "alice"), Some("alice"));
    }

    #[tokio::test]
    async fn agent_update_writes_template_and_schema_documents() {
        let store = MemoryStore::open_in_memory().unwrap();
        let thread = template_config(WorkingMemoryScope::Thread);
        let result = apply_agent_update(
            &store,
            &thread,
            Some("conv-1"),
            "alice",
            &json!({ "content": "# Task\n- goal: ship" }),
        )
        .await
        .unwrap();
        assert_eq!(result["version"], 1);
        let doc = store
            .get_working_memory(
                &ResourceKey::owned(Some("alice"), None),
                WorkingMemoryScope::Thread,
                "conv-1",
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(doc.content.as_deref(), Some("# Task\n- goal: ship"));
        assert_eq!(doc.template.as_deref(), Some("# Task\n- goal:"));

        let missing = apply_agent_update(&store, &thread, Some("conv-1"), "alice", &json!({}))
            .await
            .unwrap_err();
        assert!(missing.to_string().contains("content"));

        let schema = WorkingMemoryConfig {
            enabled: true,
            scope: WorkingMemoryScope::Resource,
            template: None,
            schema: Some(json!({
                "type": "object",
                "properties": { "name": { "type": "string" }, "city": { "type": "string" } }
            })),
        };
        apply_agent_update(
            &store,
            &schema,
            None,
            "alice",
            &json!({ "data": { "name": "Ada" } }),
        )
        .await
        .unwrap();
        // A model that sends the patch as a JSON string is accepted too.
        apply_agent_update(
            &store,
            &schema,
            None,
            "alice",
            &json!({ "data": "{\"city\":\"London\"}" }),
        )
        .await
        .unwrap();
        let doc = store
            .get_working_memory(
                &ResourceKey::owned(Some("alice"), None),
                WorkingMemoryScope::Resource,
                "alice",
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(doc.data, Some(json!({ "name": "Ada", "city": "London" })));
        let invalid = apply_agent_update(
            &store,
            &schema,
            None,
            "alice",
            &json!({ "data": { "name": 7 } }),
        )
        .await
        .unwrap_err();
        assert!(invalid.to_string().contains("$.name"));
    }

    #[test]
    fn injection_requires_the_tool_to_write_the_reader_partition() {
        use crate::sidecar::mcp::ToolPrincipal;
        assert!(principal_matches_owner(
            &ToolPrincipal::Unrestricted,
            ryu_memory::LOCAL_USER
        ));
        let owned = ToolPrincipal::Owned {
            user_id: "alice".to_owned(),
            org_id: Some("org".to_owned()),
        };
        assert!(principal_matches_owner(&owned, "alice"));
        // Bob chatting in Alice's shared conversation: the tool would write
        // Alice's partition, so Bob's turn gets no working memory.
        assert!(!principal_matches_owner(&owned, "bob"));
        assert!(!principal_matches_owner(
            &ToolPrincipal::Unresolved,
            "alice"
        ));
    }

    async fn call(
        router: &Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        use tower::ServiceExt as _;
        let request = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(match body {
                Some(body) => axum::body::Body::from(body.to_string()),
                None => axum::body::Body::empty(),
            })
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or_default())
    }

    /// The real handlers on an unbound node: read-empty, schema create, merge,
    /// stale-version conflict, schema violation, bad scope, and delete.
    #[tokio::test]
    async fn http_routes_round_trip() {
        let data = tempfile::tempdir().expect("data");
        let state = crate::server::isolated_plugin_hook_test_state(data.path());
        let router = routes()
            .layer(axum::Extension(
                None::<crate::identity_verify::VerifiedCaller>,
            ))
            .with_state(state);
        let uri = "/api/memory/working?scope=resource&id=user-1";

        let (status, body) = call(&router, "GET", uri, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["working_memory"].is_null());
        assert_eq!(body["scope"], "resource");

        let schema = json!({
            "type": "object",
            "properties": { "plan": { "enum": ["free", "pro"] }, "name": { "type": "string" } },
            "additionalProperties": false
        });
        let (status, body) = call(
            &router,
            "PUT",
            uri,
            Some(json!({ "data": { "plan": "pro" }, "schema": schema, "expected_version": 0 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["working_memory"]["mode"], "schema");
        assert_eq!(body["working_memory"]["version"], 1);

        let (status, body) = call(
            &router,
            "PUT",
            uri,
            Some(json!({ "data": { "name": "Ada" } })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["working_memory"]["data"],
            json!({ "plan": "pro", "name": "Ada" })
        );

        let (status, body) = call(
            &router,
            "PUT",
            uri,
            Some(json!({ "data": { "name": "Grace" }, "expected_version": 1 })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["current_version"], 2);

        let (status, body) = call(
            &router,
            "PUT",
            uri,
            Some(json!({ "data": { "plan": "gold" } })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("$.plan"));

        let (status, _) = call(
            &router,
            "GET",
            "/api/memory/working?scope=team&id=user-1",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = call(
            &router,
            "GET",
            "/api/memory/working?scope=thread&id=%20",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (status, body) = call(&router, "DELETE", uri, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["deleted"], true);
        let (_, body) = call(&router, "GET", uri, None).await;
        assert!(body["working_memory"].is_null());
    }

    #[tokio::test]
    async fn thread_update_without_conversation_is_refused() {
        let store = MemoryStore::open_in_memory().unwrap();
        let error = apply_agent_update(
            &store,
            &template_config(WorkingMemoryScope::Thread),
            None,
            "alice",
            &json!({ "content": "x" }),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("host conversation"));
    }
}
