//! HTTP API for quests (`/api/quests/*`): the auto-detecting todo list.
//!
//! CRUD over quest definitions, manual complete/dismiss, accept/dismiss of a
//! pending detection suggestion, an immediate "run detection now" pass, an SSE
//! event stream (suggested / completed), and the detection-config knobs (how
//! aggressive auto-detection is + the judge model).
//!
//! Each *open* quest is mirrored by a scheduled job (`quest-<id>`, target
//! [`crate::scheduler::store::JobTarget::Quest`]) so it rides the same tick loop
//! as monitors and workflows. Creating/updating a quest (re)writes that job
//! (enabled only while the quest is open); deleting or completing one removes it.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::json;

use super::ServerState;
use crate::quests::{
    DetectionMode, Quest, QuestStatus, DETECTION_MODE_PREF, JUDGE_EFFORT_PREF, JUDGE_MODEL_PREF,
};
use crate::scheduler::store::{self as job_store, JobTarget, Schedule, ScheduledJob};

/// Preference key for the detection interval (how often each quest is judged).
const DETECTION_INTERVAL_PREF: &str = "quest-detection-interval";
/// Default detection interval when nothing is configured.
const DEFAULT_INTERVAL: &str = "2m";

fn job_id_for(quest_id: &str) -> String {
    format!("quest-{quest_id}")
}

/// Resolve the detection interval: pref → env `RYU_QUEST_INTERVAL` → default.
async fn resolve_interval(state: &ServerState) -> String {
    if let Ok(Some(v)) = state.preferences.get(DETECTION_INTERVAL_PREF).await {
        let t = v.trim();
        if !t.is_empty() && humantime::parse_duration(t).is_ok() {
            return t.to_string();
        }
    }
    std::env::var("RYU_QUEST_INTERVAL")
        .ok()
        .filter(|v| humantime::parse_duration(v).is_ok())
        .unwrap_or_else(|| DEFAULT_INTERVAL.to_string())
}

/// Create or replace the scheduled job backing a quest. Enabled only while the
/// quest is open (a done/dismissed quest keeps no live detection job).
fn sync_backing_job(quest: &Quest, interval: &str) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let id = job_id_for(&quest.id);
    let existing = job_store::load_job(&id).ok();
    let job = ScheduledJob {
        id: id.clone(),
        name: format!("quest: {}", quest.title),
        schedule: Schedule::Every {
            interval: interval.to_string(),
        },
        target: JobTarget::Quest {
            quest_id: quest.id.clone(),
        },
        enabled: quest.status == QuestStatus::Open,
        require_approval: false,
        created_at: existing
            .as_ref()
            .map(|j| j.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        last_run_at: existing.as_ref().and_then(|j| j.last_run_at.clone()),
        last_outcome: existing.as_ref().and_then(|j| j.last_outcome),
        history: existing.map(|j| j.history).unwrap_or_default(),
    };
    job_store::save_job(&job).map_err(|e| format!("failed to persist backing job: {e}"))
}

/// Request body for creating/updating a quest.
#[derive(Debug, Deserialize)]
pub struct QuestBody {
    pub title: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub completion_condition: String,
}

/// `GET /api/quests` — list all quests.
pub async fn list_quests(State(state): State<ServerState>) -> Json<serde_json::Value> {
    match state.quests.store.list_quests().await {
        Ok(quests) => Json(json!({ "quests": quests })),
        Err(e) => Json(json!({ "quests": [], "error": e.to_string() })),
    }
}

/// `POST /api/quests` — create a quest (and its backing detection job).
pub async fn create_quest(
    State(state): State<ServerState>,
    Json(body): Json<QuestBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if body.title.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "title is required" })),
        );
    }
    let now = chrono::Utc::now().to_rfc3339();
    let quest = Quest {
        id: format!("quest_{}", uuid::Uuid::new_v4().simple()),
        title: body.title.trim().to_string(),
        detail: body.detail.filter(|d| !d.trim().is_empty()),
        completion_condition: body.completion_condition.trim().to_string(),
        status: QuestStatus::Open,
        created_at: now.clone(),
        updated_at: now,
        completed_at: None,
        completion_source: None,
        last_judged_at: None,
        snoozed_until: None,
        suggestion: None,
    };
    if let Err(e) = state.quests.store.upsert_quest(&quest).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        );
    }
    let interval = resolve_interval(&state).await;
    if let Err(e) = sync_backing_job(&quest, &interval) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        );
    }
    (StatusCode::OK, Json(json!({ "quest": quest })))
}

/// `GET /api/quests/:id` — one quest.
pub async fn get_quest(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.quests.store.get_quest(&id).await {
        Ok(Some(q)) => (StatusCode::OK, Json(json!({ "quest": q }))),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `PUT /api/quests/:id` — edit a quest's title / detail / completion condition.
pub async fn update_quest(
    State(state): State<ServerState>,
    Path(id): Path<String>,
    Json(body): Json<QuestBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if body.title.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "title is required" })),
        );
    }
    let mut quest = match state.quests.store.get_quest(&id).await {
        Ok(Some(q)) => q,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    };
    quest.title = body.title.trim().to_string();
    quest.detail = body.detail.filter(|d| !d.trim().is_empty());
    quest.completion_condition = body.completion_condition.trim().to_string();
    quest.updated_at = chrono::Utc::now().to_rfc3339();
    if let Err(e) = state.quests.store.upsert_quest(&quest).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        );
    }
    let interval = resolve_interval(&state).await;
    let _ = sync_backing_job(&quest, &interval);
    (StatusCode::OK, Json(json!({ "quest": quest })))
}

/// `DELETE /api/quests/:id` — remove a quest, its history, and its job.
pub async fn delete_quest(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let _ = job_store::delete_job(&job_id_for(&id));
    match state.quests.store.delete_quest(&id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(false) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `POST /api/quests/:id/judge` — run one detection pass immediately.
pub async fn judge_quest(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.quests.judge_quest(&id).await {
        Ok(Some(v)) => (
            StatusCode::OK,
            Json(json!({ "met": v.met, "confidence": v.confidence, "reason": v.reason })),
        ),
        Ok(None) => (
            StatusCode::OK,
            Json(
                json!({ "skipped": true, "reason": "not open, snoozed, detection off, or no context available" }),
            ),
        ),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))),
    }
}

/// `POST /api/quests/:id/complete` — mark a quest done (manual check-off). The
/// backing job is disabled by re-syncing the now-done quest.
pub async fn complete_quest(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    finish(&state, &id, state.quests.complete_quest(&id, false).await).await
}

/// `POST /api/quests/:id/suggestion/accept` — confirm a pending detection.
pub async fn accept_suggestion(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    finish(&state, &id, state.quests.complete_quest(&id, true).await).await
}

/// `POST /api/quests/:id/dismiss` — abandon a quest entirely.
pub async fn dismiss_quest(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    finish(&state, &id, state.quests.dismiss_quest(&id).await).await
}

/// `POST /api/quests/:id/suggestion/dismiss` — reject the pending suggestion but
/// keep the quest open (snoozes further detection for a while).
pub async fn dismiss_suggestion(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match state.quests.dismiss_suggestion(&id).await {
        Ok(Some(q)) => (StatusCode::OK, Json(json!({ "quest": q }))),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))),
    }
}

/// Shared tail for the status-changing ops that also re-sync the backing job
/// (so a completed/dismissed quest stops being judged).
async fn finish(
    state: &ServerState,
    _id: &str,
    result: Result<Option<Quest>, String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match result {
        Ok(Some(q)) => {
            let interval = resolve_interval(state).await;
            let _ = sync_backing_job(&q, &interval);
            (StatusCode::OK, Json(json!({ "quest": q })))
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "error": e }))),
    }
}

/// `GET /api/quests/events` — SSE feed of quest events (suggested / completed).
pub async fn quest_events(
    State(state): State<ServerState>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    let rx = state.quests.store.subscribe();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let data = serde_json::to_string(&event).unwrap_or_default();
                    return Some((Ok(Event::default().data(data)), rx));
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// `GET /api/quests/detection-config` — the current detection knobs.
pub async fn get_detection_config(State(state): State<ServerState>) -> Json<serde_json::Value> {
    let mode = state.quests.detection_mode().await;
    let model = state
        .preferences
        .get(JUDGE_MODEL_PREF)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let effort = state
        .preferences
        .get(JUDGE_EFFORT_PREF)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let interval = resolve_interval(&state).await;
    Json(json!({
        "mode": mode.as_str(),
        "model": model,
        "effort": effort,
        "interval": interval,
    }))
}

/// Request body for `PUT /api/quests/detection-config`.
#[derive(Debug, Deserialize)]
pub struct DetectionConfigBody {
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub interval: Option<String>,
}

/// `PUT /api/quests/detection-config` — set the detection mode + judge model.
pub async fn set_detection_config(
    State(state): State<ServerState>,
    Json(body): Json<DetectionConfigBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Some(mode) = body.mode.as_ref() {
        // Normalize through the enum so only valid modes persist.
        let normalized = DetectionMode::from_pref(mode).as_str();
        if let Err(e) = state.preferences.set(DETECTION_MODE_PREF, normalized).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            );
        }
    }
    if let Some(model) = body.model.as_ref() {
        let _ = state.preferences.set(JUDGE_MODEL_PREF, model.trim()).await;
    }
    if let Some(effort) = body.effort.as_ref() {
        let _ = state
            .preferences
            .set(JUDGE_EFFORT_PREF, effort.trim())
            .await;
    }
    if let Some(interval) = body.interval.as_ref() {
        let t = interval.trim();
        if !t.is_empty() && humantime::parse_duration(t).is_err() {
            return (
                StatusCode::BAD_REQUEST,
                Json(
                    json!({ "error": format!("interval '{t}' is not a valid duration (e.g. 2m)") }),
                ),
            );
        }
        let _ = state.preferences.set(DETECTION_INTERVAL_PREF, t).await;
    }
    (StatusCode::OK, Json(json!({ "ok": true })))
}
