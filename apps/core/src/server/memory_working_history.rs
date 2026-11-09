//! `GET /api/memory/working/history?scope=thread|resource&id=…[&limit=N]` — the
//! caller's own recent versions of one working-memory document.
//!
//! Every write snapshots the stored document, capped at
//! [`WORKING_MEMORY_HISTORY_LIMIT`] versions. This route is the read path: the
//! same owner derivation and conversation ACL as the document routes
//! (`authorize`), newest first, never more than the cap.

use axum::{
    extract::{Query, State},
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{authorize, store_error, WorkingMemoryQuery};
use crate::server::memory::{WorkingMemory, WorkingMemoryMode, WORKING_MEMORY_HISTORY_LIMIT};
use crate::server::ServerState;

#[derive(Debug, Deserialize)]
pub struct WorkingMemoryHistoryQuery {
    scope: String,
    id: String,
    /// At most this many versions; clamped to `1..=WORKING_MEMORY_HISTORY_LIMIT`.
    limit: Option<i64>,
}

/// One stored version, as the history route returns it.
#[derive(Debug, Serialize)]
pub(crate) struct WorkingMemoryVersion {
    version: i64,
    mode: WorkingMemoryMode,
    updated_at: i64,
    /// The Markdown document (template mode).
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    /// The structured object (schema mode).
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
}

impl From<WorkingMemory> for WorkingMemoryVersion {
    fn from(doc: WorkingMemory) -> Self {
        Self {
            version: doc.version,
            mode: doc.mode,
            updated_at: doc.updated_at,
            content: doc.content,
            data: doc.data,
        }
    }
}

/// How many versions to return for a requested `limit`.
fn clamp_limit(limit: Option<i64>) -> usize {
    let cap = WORKING_MEMORY_HISTORY_LIMIT;
    usize::try_from(limit.unwrap_or(cap).clamp(1, cap)).unwrap_or(1)
}

/// `GET /api/memory/working/history?scope=thread|resource&id=…`
#[utoipa::path(
    get,
    path = "/api/memory/working/history",
    tag = "Memory",
    summary = "List working memory versions",
    params(
        ("scope" = String, Query, description = "thread | resource"),
        ("id" = String, Query, description = "Thread (conversation) id or resource id"),
        ("limit" = Option<i64>, Query, description = "Maximum versions to return (1-20, default 20)")
    ),
    responses(
        (status = 200, description = "The caller's stored versions of the document, newest first; empty when none are stored", body = serde_json::Value),
        (status = 400, description = "Invalid scope or id", body = serde_json::Value),
        (status = 403, description = "Not permitted", body = serde_json::Value),
        (status = 404, description = "Thread not visible to the caller", body = serde_json::Value)
    )
)]
pub async fn get_working_memory_history(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(query): Query<WorkingMemoryHistoryQuery>,
) -> axum::response::Response {
    let document = WorkingMemoryQuery {
        scope: query.scope,
        id: query.id,
    };
    let (scope, key) = match authorize(&state, &caller, &document, false).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let versions = match state
        .memory
        .working_memory_history(&key, scope, &document.id)
        .await
    {
        Ok(versions) => versions,
        Err(error) => return store_error(&error),
    };
    let versions: Vec<WorkingMemoryVersion> = versions
        .into_iter()
        .take(clamp_limit(query.limit))
        .map(WorkingMemoryVersion::from)
        .collect();
    Json(json!({
        "scope": scope.as_str(),
        "id": document.id.trim(),
        "versions": versions,
    }))
    .into_response()
}

#[cfg(test)]
#[path = "memory_working_history_tests.rs"]
mod tests;
