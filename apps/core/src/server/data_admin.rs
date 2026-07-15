//! "Danger zone" bulk data administration (`/api/data/*`).
//!
//! One auditable place for the destructive, irreversible "delete all X" actions
//! the desktop's Settings → Danger Zone tab exposes: wipe all chats, all spaces,
//! all long-term memory, all website monitors, or all meetings. Each category is
//! cleared by either a flat truncate (chats/memory/spaces, where the store owns a
//! transactional `clear_all`) or by looping the existing per-item delete (monitors
//! and meetings) so the side effects a single delete handles — tearing down a
//! monitor's backing scheduler job, broadcasting SSE — are preserved.
//!
//! Deliberately scoped to unambiguous *user data*. Config/built-in stores
//! (agents, teams, workflows, scheduler jobs) are out of scope: wiping them would
//! nuke the flagship `ryu` agent or orphan the jobs that monitors/workflows
//! created. Per the Core-vs-Gateway rule this is all "what runs" data → Core; no
//! policy decision, so no Gateway involvement.

use axum::{extract::State, http::StatusCode, Extension, Json};
use serde::Deserialize;
use serde_json::json;

use super::ServerState;

/// The scheduler job a monitor mirrors. Kept in sync with
/// `monitors_api::job_id_for` (a monitor auto-creates `monitor-<id>`); clearing
/// all monitors must also remove these or they tick forever.
fn monitor_job_id(monitor_id: &str) -> String {
    format!("monitor-{monitor_id}")
}

/// The data categories a danger-zone clear can target.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataCategory {
    /// All conversations + their messages and sessions.
    Chats,
    /// All Spaces + their documents, chunks, and vectors.
    Spaces,
    /// All long-term memory entries.
    Memory,
    /// All website monitors (+ their backing scheduler jobs).
    Monitors,
    /// All meeting records.
    Meetings,
}

#[derive(Debug, Deserialize)]
pub struct ClearRequest {
    pub category: DataCategory,
}

/// `GET /api/data/counts`
///
/// How many items each danger-zone category currently holds, so the desktop can
/// render "Delete all 42 chats?" before the user commits. Best-effort per field:
/// a store error surfaces as `0` for that category rather than failing the whole
/// response (the worst case is an under-count in the confirm dialog).
#[utoipa::path(
    get,
    path = "/api/data/counts",
    tag = "Data",
    summary = "Counts of deletable user-data categories",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn data_counts(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let chats = state.conversations.count_conversations().await.unwrap_or(0);
    let spaces = state.spaces.count_spaces().await.unwrap_or(0);
    let memory = state.memory.count().await.unwrap_or(0);
    let monitors = state
        .monitors
        .store
        .list_monitors()
        .await
        .map(|m| m.len() as u64)
        .unwrap_or(0);
    let meetings = state
        .meetings
        .list()
        .await
        .map(|m| m.len() as u64)
        .unwrap_or(0);
    Json(json!({
        "chats": chats,
        "spaces": spaces,
        "memory": memory,
        "monitors": monitors,
        "meetings": meetings,
    }))
}

/// `POST /api/data/clear`  body: `{ "category": "chats" }`
///
/// Irreversibly delete every item in one category. Returns `{ removed: N }` with
/// the number of top-level items deleted. Monitors and meetings are cleared by
/// looping the existing per-item delete so their side effects (scheduler-job
/// teardown, SSE) fire; the rest use the store's transactional `clear_all`.
#[utoipa::path(
    post,
    path = "/api/data/clear",
    tag = "Data",
    summary = "Delete all items in a data category",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn data_clear(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(req): Json<ClearRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    // ── ACL ──────────────────────────────────────────────────────────────────
    // This handler took NO caller: on an org-bound node any holder of the shared node
    // token could truncate EVERY user's chats, spaces, memory, monitors and meetings.
    //
    //   - Node UNBOUND (personal): one principal, `RYU_TOKEN` is the boundary. The
    //     danger zone behaves EXACTLY as before — an unscoped truncate of the user's
    //     own machine, which is the whole point of the feature.
    //   - Node ORG-BOUND: an unscoped truncate is never acceptable. `Chats` is scoped
    //     to the caller's OWN conversations. Every other category has no per-user
    //     tenancy in the store yet (spaces/documents carry no owner columns — see the
    //     Spaces deferral), so there is nothing to scope by and a truncate would
    //     destroy other users' data: REFUSE rather than half-scope it.
    let bound_owner: Option<String> = match super::node_org_id() {
        None => None,
        Some(_) => match caller.as_ref() {
            Some(c) => Some(c.user_id.clone()),
            None => {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({
                        "error": "forbidden: a signed-in user is required to clear data on a shared node"
                    })),
                );
            }
        },
    };

    let result: Result<u64, String> = match (req.category, bound_owner.as_deref()) {
        // ── Unbound personal node: unchanged behaviour ───────────────────────
        (DataCategory::Chats, None) => state
            .conversations
            .clear_all_conversations()
            .await
            .map_err(|e| e.to_string()),
        (DataCategory::Spaces, None) => state
            .spaces
            .clear_all_spaces()
            .await
            .map_err(|e| e.to_string()),
        (DataCategory::Memory, None) => state.memory.clear_all().await.map_err(|e| e.to_string()),
        (DataCategory::Monitors, None) => clear_all_monitors(&state).await,
        (DataCategory::Meetings, None) => clear_all_meetings(&state).await,

        // ── Org-bound node: scope, or refuse ─────────────────────────────────
        (DataCategory::Chats, Some(owner)) => state
            .conversations
            .clear_conversations_owned_by(owner)
            .await
            .map_err(|e| e.to_string()),
        (DataCategory::Spaces | DataCategory::Memory | DataCategory::Monitors | DataCategory::Meetings, Some(_)) => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "error": "forbidden: this category cannot be cleared on a shared (org-bound) node —                               it carries no per-user ownership, so clearing it would destroy other users' data"
                })),
            );
        }
    };

    match result {
        Ok(removed) => (StatusCode::OK, Json(json!({ "removed": removed }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        ),
    }
}

/// Loop the per-monitor delete so each monitor's backing scheduler job is torn
/// down (a flat SQL truncate would leave `monitor-<id>` jobs ticking forever).
async fn clear_all_monitors(state: &ServerState) -> Result<u64, String> {
    let monitors = state
        .monitors
        .store
        .list_monitors()
        .await
        .map_err(|e| e.to_string())?;
    let mut removed = 0u64;
    for monitor in monitors {
        // Tear down the backing scheduler job first (best-effort), then the row.
        let _ = crate::scheduler::store::delete_job(&monitor_job_id(&monitor.id));
        if state
            .monitors
            .store
            .delete_monitor(&monitor.id)
            .await
            .map_err(|e| e.to_string())?
        {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Loop the per-meeting delete so each delete broadcasts on the meetings SSE
/// stream the desktop/island listen to.
async fn clear_all_meetings(state: &ServerState) -> Result<u64, String> {
    let meetings = state.meetings.list().await?;
    let mut removed = 0u64;
    for meeting in meetings {
        if state.meetings.delete(&meeting.id).await? {
            removed += 1;
        }
    }
    Ok(removed)
}
