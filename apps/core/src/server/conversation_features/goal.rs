//! Goal handlers (`/goal`).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Goal handlers (`/goal`) ───────────────────────────────────────────────────
//
// A goal is a persistent completion condition attached to a conversation. The
// goal state lives in Core ("what runs"); the judge model call routes through the
// Gateway ("what is measured"), so the firewall/budget/audit pipeline applies. The
// continuation loop is driven by the plugin turn hook. Core exposes the durable
// state contract so the desktop can pause/resume it without creating a chat turn.

// Goal + double-check preference keys moved to their plugins (goal /
// double-check); the model/effort prefs (`goal-judge-model`,
// `double-check-model`, …) are still read by the plugin host's side-model
// capability, just not by hardcoded judge handlers.

pub(in crate::server) const GOAL_PLUGIN_ID: &str = "@ryu/goal";
pub(in crate::server) const GOAL_STORAGE_NAMESPACE: &str = "default";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub(in crate::server) struct GoalRecord {
    #[serde(alias = "goal")]
    pub(in crate::server) condition: Option<String>,
    #[serde(default)]
    pub(in crate::server) status: Option<String>,
    #[serde(default)]
    pub(in crate::server) started_at: Option<i64>,
    #[serde(default)]
    pub(in crate::server) achieved_at: Option<i64>,
    #[serde(default)]
    pub(in crate::server) last_reason: Option<String>,
    #[serde(default)]
    pub(in crate::server) turns: i64,
}

#[derive(Debug, Clone, serde::Serialize, Default)]
pub(in crate::server) struct GoalState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) goal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) last_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) started_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) achieved_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::server) status: Option<String>,
    pub(in crate::server) turns: i64,
}

pub(in crate::server) fn goal_state_from_record(record: Option<GoalRecord>) -> GoalState {
    let Some(record) = record else {
        return GoalState::default();
    };
    let Some(condition) = record
        .condition
        .map(|condition| condition.trim().to_owned())
        .filter(|condition| !condition.is_empty())
    else {
        return GoalState::default();
    };
    let status = match record.status.as_deref() {
        Some("paused") => "paused",
        Some("achieved") => "achieved",
        _ => "active",
    };
    GoalState {
        goal: Some(condition),
        last_reason: record.last_reason,
        started_at: record.started_at,
        achieved_at: record.achieved_at,
        status: Some(status.to_owned()),
        turns: record.turns.max(0),
    }
}

pub(in crate::server) fn goal_storage_namespace(
    caller: Option<&crate::identity_verify::VerifiedCaller>,
) -> String {
    crate::plugin_host::storage_namespace_for_tenant(
        caller.map(|value| value.user_id.as_str()),
        GOAL_STORAGE_NAMESPACE,
    )
}

pub(in crate::server) async fn read_goal_record(
    id: &str,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
) -> anyhow::Result<Option<GoalRecord>> {
    let Some(storage) = crate::plugin_storage::global() else {
        return Err(anyhow::anyhow!("plugin storage is unavailable"));
    };
    let raw = storage
        .get(GOAL_PLUGIN_ID, &goal_storage_namespace(caller), id)
        .await?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    Ok(serde_json::from_str(&raw).ok())
}

pub(in crate::server) async fn write_goal_record(
    id: &str,
    record: &GoalRecord,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
) -> anyhow::Result<()> {
    let Some(storage) = crate::plugin_storage::global() else {
        return Err(anyhow::anyhow!("plugin storage is unavailable"));
    };
    let raw = serde_json::to_string(record)?;
    storage
        .set(GOAL_PLUGIN_ID, &goal_storage_namespace(caller), id, &raw)
        .await?;
    Ok(())
}

/// `GET /api/conversations/:id/goal` — read the goal plugin's persisted state.
#[utoipa::path(
    get,
    path = "/api/conversations/{id}/goal",
    tag = "Conversations",
    summary = "Get the conversation goal state",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_goal_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_read(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    match read_goal_record(&id, caller.as_ref()).await {
        Ok(record) => Json(goal_state_from_record(record)).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetGoalBody {
    pub(in crate::server) goal: String,
}

/// `PUT /api/conversations/:id/goal` — set or replace the persisted goal.
#[utoipa::path(
    put,
    path = "/api/conversations/{id}/goal",
    tag = "Conversations",
    summary = "Set the conversation goal",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_goal_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
    Json(body): Json<SetGoalBody>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    let goal = body.goal.trim();
    if goal.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "goal must not be empty".to_owned());
    }
    if goal.len() > 4000 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "goal must be 4000 characters or fewer".to_owned(),
        );
    }
    let started_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default();
    let record = GoalRecord {
        condition: Some(goal.to_owned()),
        status: Some("active".to_owned()),
        started_at: Some(started_at),
        ..GoalRecord::default()
    };
    match write_goal_record(&id, &record, caller.as_ref()).await {
        Ok(()) => Json(goal_state_from_record(Some(record))).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `DELETE /api/conversations/:id/goal` — clear the persisted goal.
#[utoipa::path(
    delete,
    path = "/api/conversations/{id}/goal",
    tag = "Conversations",
    summary = "Clear the conversation goal",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn clear_goal_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    let Some(storage) = crate::plugin_storage::global() else {
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "plugin storage is unavailable".to_owned(),
        );
    };
    match storage
        .delete(
            GOAL_PLUGIN_ID,
            &goal_storage_namespace(caller.as_ref()),
            &id,
        )
        .await
    {
        Ok(()) => Json(json!({ "success": true })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub(in crate::server) async fn set_goal_status_handler(
    state: ServerState,
    caller: Option<crate::identity_verify::VerifiedCaller>,
    id: String,
    status: &'static str,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    let record = match read_goal_record(&id, caller.as_ref()).await {
        Ok(Some(record))
            if record
                .condition
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()) =>
        {
            record
        }
        Ok(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "no goal set on this conversation".to_owned(),
            );
        }
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let mut record = record;
    if record.status.as_deref() != Some("achieved") {
        record.status = Some(status.to_owned());
        if let Err(e) = write_goal_record(&id, &record, caller.as_ref()).await {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }
    Json(goal_state_from_record(Some(record))).into_response()
}

/// `POST /api/conversations/:id/goal/pause` — persist a paused goal.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/goal/pause",
    tag = "Conversations",
    summary = "Pause the conversation goal",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn pause_goal_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    set_goal_status_handler(state, caller, id, "paused").await
}

/// `POST /api/conversations/:id/goal/resume` — persist an active goal.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/goal/resume",
    tag = "Conversations",
    summary = "Resume the conversation goal",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn resume_goal_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    set_goal_status_handler(state, caller, id, "active").await
}

/// Preference keys for the `/btw` side-question feature's model + effort. Like
/// double-check, the desktop may store a `btw-provider` pref purely for UI state;
/// Core ignores it (the gateway routes by model id alone).
pub(in crate::server) const BTW_MODEL_PREF: &str = "btw-model";
pub(in crate::server) const BTW_EFFORT_PREF: &str = "btw-effort";

/// Preference key for auto-recall (U17): before each chat turn, automatically
/// retrieve relevant prior knowledge (long-term memory + past chat messages) and
/// inject it into the prompt. DEFAULT ON — an unset pref means enabled; only an
/// explicit `false`/`0`/`off`/`no` disables it. Env fallback
/// `RYU_AUTO_RECALL_ENABLED`.
pub(in crate::server) const AUTO_RECALL_ENABLED_PREF: &str = "auto-recall-enabled";

/// Preference key for the number of recalled snippets injected per turn (across
/// memory + past chats combined). DEFAULT 5. Env fallback `RYU_AUTO_RECALL_TOP_K`.
pub(in crate::server) const AUTO_RECALL_TOP_K_PREF: &str = "auto-recall-top-k";

/// Fallback top-k when neither the pref nor the env var is set.
pub(in crate::server) const AUTO_RECALL_DEFAULT_TOP_K: usize = 5;

/// Parse the auto-recall enabled flag from a raw pref/env string. PURE so it is
/// unit-testable without a store. Default ON: `None` or any unrecognised value is
/// enabled; only an explicit disable token (`false`/`0`/`off`/`no`, any case)
/// turns it off.
pub(in crate::server) fn parse_auto_recall_enabled(raw: Option<&str>) -> bool {
    match raw {
        None => true,
        Some(v) => !matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "false" | "0" | "off" | "no"
        ),
    }
}

/// Resolve whether auto-recall is enabled: pref → env (`RYU_AUTO_RECALL_ENABLED`)
/// → default ON.
pub(in crate::server) async fn resolve_auto_recall_enabled(state: &ServerState) -> bool {
    if let Ok(Some(pref)) = state.preferences.get(AUTO_RECALL_ENABLED_PREF).await {
        return parse_auto_recall_enabled(Some(&pref));
    }
    match std::env::var("RYU_AUTO_RECALL_ENABLED") {
        Ok(v) => parse_auto_recall_enabled(Some(&v)),
        Err(_) => true,
    }
}
