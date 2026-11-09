//! Conversation history handlers (spec unit U10).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Conversation history handlers (spec unit U10) ─────────────────────────────

#[derive(serde::Deserialize)]
pub(in crate::server) struct ListConversationsQuery {
    /// `1`/`true` also returns the newest message of each conversation
    /// (`last_message`, `last_message_role`, `last_message_at`). Off by default:
    /// it costs a correlated subquery plus a decrypt per row, and only the
    /// messaging-style sidebar rows read it.
    pub(in crate::server) preview: Option<String>,
}

#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct ConversationMessagesQuery {
    /// Page size. Omitted keeps the existing full-detail response for API
    /// callers that need the complete transcript.
    pub(in crate::server) limit: Option<usize>,
    /// Message id at the top of the currently loaded page. The next page is
    /// returned strictly before this message in active chronological order.
    pub(in crate::server) before: Option<String>,
}

pub(in crate::server) const MAX_TEMPORARY_SNAPSHOT_MESSAGES: usize = 200;
pub(in crate::server) const MAX_TEMPORARY_SNAPSHOT_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
pub(in crate::server) const MAX_TEMPORARY_SNAPSHOT_PARTS_BYTES: usize = 4 * 1024 * 1024;

#[derive(serde::Deserialize)]
pub(in crate::server) struct SaveTemporaryConversationMessage {
    pub(in crate::server) content: String,
    #[serde(default)]
    pub(in crate::server) metadata: Option<serde_json::Value>,
    #[serde(default)]
    pub(in crate::server) parts: Vec<serde_json::Value>,
    pub(in crate::server) role: String,
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SaveTemporaryConversationBody {
    #[serde(default)]
    pub(in crate::server) agent_id: Option<String>,
    #[serde(default)]
    pub(in crate::server) folder_path: Option<String>,
    pub(in crate::server) messages: Vec<SaveTemporaryConversationMessage>,
}

#[utoipa::path(
    get,
    path = "/api/conversations",
    tag = "Conversations",
    summary = "List conversations",
    params(("preview" = Option<String>, Query, description = "Set to 1/true to include the newest message of each conversation")),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_conversations(
    State(state): State<ServerState>,
    axum::extract::Query(query): axum::extract::Query<ListConversationsQuery>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> axum::response::Response {
    // Per-resource ACL, pushed into the SQL `WHERE` (it used to be an N+1 in this
    // handler: one `get_access_meta` per row, each taking the store mutex). The
    // store's predicate mirrors `resource_access` exactly, so the list gate and the
    // row gate cannot drift.
    let (user_id, org_id, team_ids_json, node_bound) = tenancy_filter_args(&caller);
    let want_preview = matches!(query.preview.as_deref(), Some("1" | "true"));
    let listed = if want_preview {
        state
            .conversations
            .list_conversations_visible_with_preview_for_teams(
                user_id.as_deref(),
                org_id.as_deref(),
                node_bound,
                team_ids_json.as_deref(),
            )
            .await
    } else {
        state
            .conversations
            .list_conversations_visible_for_teams(
                user_id.as_deref(),
                org_id.as_deref(),
                node_bound,
                team_ids_json.as_deref(),
            )
            .await
    };
    match listed {
        Ok(items) => Json(json!({ "conversations": items })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SearchConversationsQuery {
    /// The natural-language query to match against past messages.
    pub(in crate::server) q: String,
    /// Max number of hits (defaults to 20, clamped to 100).
    pub(in crate::server) limit: Option<usize>,
    /// `exact` uses the lexical index, `semantic` uses embeddings, and `all`
    /// (the default) merges both sources with exact matches first.
    pub(in crate::server) mode: Option<String>,
}

/// `GET /api/conversations/search?q=…&limit=…&mode=…` — exact and semantic search
/// over individual chat messages, the human-facing surface of the
/// `search_conversations` capability. `all` (the default) merges lexical FTS hits
/// with embedding hits and de-duplicates by message id. Returns `{ hits, indexed }`.
#[utoipa::path(
    get,
    path = "/api/conversations/search",
    tag = "Conversations",
    summary = "Semantic search over past chat messages",
	params(
		("q" = String, Query, description = "Natural-language search query"),
		("limit" = Option<usize>, Query, description = "Max hits (default 20, max 100)"),
		("mode" = Option<String>, Query, description = "exact, semantic, or all (default)")
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn search_conversations_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Query(params): axum::extract::Query<SearchConversationsQuery>,
) -> axum::response::Response {
    let query = params.q.trim();
    if query.is_empty() {
        return Json(json!({
            "hits": [],
            "indexed": state.conversations.chat_memory_enabled()
        }))
        .into_response();
    }
    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    let mode = params.mode.as_deref().unwrap_or("all");
    let chat_memory_enabled = state.conversations.chat_memory_enabled();
    let semantic_enabled = mode != "exact" && chat_memory_enabled;
    let exact_enabled = mode != "semantic" && chat_memory_enabled;

    // Per-resource ACL. This is a SEMANTIC SEARCH ACROSS EVERY MESSAGE ON THE NODE
    // and it was completely ungated — on a shared node any caller could type a
    // keyword and get decrypted snippets out of every other user's chats. Scope it
    // to the conversations this caller may read, using the `conversation_ids` filter
    // `search_messages` already accepts. On an unbound node the id list is every
    // conversation (unchanged behaviour); on a bound node an anonymous caller gets
    // an empty set and therefore no hits, never a node-wide dump.
    let visible = match visible_conversation_ids_for_caller(&state.conversations, &caller).await {
        Ok(ids) => ids,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if visible.is_empty() {
        return Json(json!({ "hits": [], "indexed": chat_memory_enabled })).into_response();
    }

    let exact_hits = if exact_enabled {
        match state
            .conversations
            .fts_search_messages(query, limit, Some(&visible))
            .await
        {
            Ok(hits) => hits,
            Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    } else {
        None
    };
    let semantic_hits = if semantic_enabled {
        match state
            .conversations
            .search_messages(query, limit, Some(&visible))
            .await
        {
            Ok(hits) => hits,
            Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    } else {
        None
    };
    let exact_indexed = exact_hits.is_some();
    let semantic_indexed = semantic_hits.is_some();

    // Belt and braces: post-filter against the same id set, so a stale vector/FTS
    // row (e.g. one orphaned by a re-tenanted conversation) can never leak a
    // snippet even if the index-side filter is bypassed. Exact hits lead because a
    // literal message match is the strongest answer to a literal query.
    let allowed: std::collections::HashSet<&str> = visible.iter().map(String::as_str).collect();
    let mut merged = Vec::with_capacity(limit.saturating_mul(2));
    let mut seen = std::collections::HashSet::new();
    for hit in exact_hits
        .into_iter()
        .flatten()
        .chain(semantic_hits.into_iter().flatten())
    {
        if allowed.contains(hit.conversation_id.as_str()) && seen.insert(hit.message_id.clone()) {
            merged.push(hit);
            if merged.len() >= limit {
                break;
            }
        }
    }
    let indexed = exact_indexed || semantic_indexed;
    Json(json!({ "hits": merged, "indexed": indexed })).into_response()
}

#[utoipa::path(
    get,
    path = "/api/conversations/{id}",
    tag = "Conversations",
    summary = "Get a conversation with messages",
    params(
        ("id" = String, Path),
        ("limit" = Option<usize>, Query, description = "Return the newest message page; max 100"),
        ("before" = Option<String>, Query, description = "Return messages before this message id")
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_conversation(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<ConversationMessagesQuery>,
) -> axum::response::Response {
    conversation_history_response(&state.conversations, caller.as_ref(), &id, query).await
}

pub(in crate::server) async fn conversation_history_response(
    conversations: &conversations::ConversationStore,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
    id: &str,
    query: ConversationMessagesQuery,
) -> axum::response::Response {
    // Per-resource ACL: a conversation carries its own tenancy, so holding the
    // node token is NOT enough to read someone else's chat. (There is no coarse
    // RBAC permission for conversations — this gate is the whole check.)
    if let Err(resp) = require_resource_read(
        conversations.get_access_meta(id).await,
        caller,
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    let detail = match query.limit {
        Some(limit) => {
            conversations
                .get_conversation_message_page(id, query.before.as_deref(), limit.clamp(1, 100))
                .await
        }
        None => conversations.get_conversation_detail(id).await,
    };
    match detail {
        Ok(Some(detail)) => Json(detail).into_response(),
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            format!("conversation '{id}' not found"),
        ),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
