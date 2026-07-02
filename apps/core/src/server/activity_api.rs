//! HTTP API for the unified activity feed (`/api/activity*`).
//!
//! A read (`GET /api/activity`) with cursor paging, a manual write
//! (`POST /api/activity`), and a snapshot-first SSE stream
//! (`GET /api/activity/stream`) that mirrors `GET /api/runs/stream`.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

use super::ServerState;
use crate::activity::{default_metadata, default_source, ActivityItem, ActivityLevel};

const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 500;

/// `GET /api/activity?limit=N&before=EPOCH` — recent feed items, newest first.
pub async fn list_activity(
    State(state): State<ServerState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let limit = params
        .get("limit")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT);
    let before = params.get("before").and_then(|v| v.parse::<i64>().ok());
    match state.activity.list(limit, before).await {
        Ok(items) => Json(json!({ "items": items })),
        Err(e) => Json(json!({ "items": [], "error": e.to_string() })),
    }
}

/// Request body for `POST /api/activity`. `source` defaults to `manual`; `level`
/// to `info`; `metadata` to `{}`.
#[derive(Debug, Deserialize)]
pub struct CreateActivityBody {
    pub kind: String,
    #[serde(default = "default_source")]
    pub source: String,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub level: ActivityLevel,
    #[serde(default = "default_metadata")]
    pub metadata: serde_json::Value,
}

/// `POST /api/activity` — record a manual feed item.
pub async fn create_activity(
    State(state): State<ServerState>,
    Json(body): Json<CreateActivityBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if body.kind.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "kind is required" })),
        );
    }
    if body.title.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "title is required" })),
        );
    }
    let item = ActivityItem::new(body.kind, body.source, body.title)
        .with_body(body.body)
        .with_agent(body.agent_id)
        .with_session(body.session_id)
        .with_level(body.level)
        .with_metadata(body.metadata);
    match state.activity.record(item).await {
        Ok(stored) => (StatusCode::CREATED, Json(json!({ "item": stored }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// SSE frame: a full snapshot on connect, then one frame per newly-recorded item.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ActivityStreamFrame {
    Snapshot { items: Vec<ActivityItem> },
    Item { item: ActivityItem },
}

/// `GET /api/activity/stream` — SSE: a full snapshot on connect, then a frame per
/// newly-recorded item. Snapshot-first (mirrors `GET /api/runs/stream`) so a
/// late/lagged client self-heals.
pub async fn activity_stream(
    State(state): State<ServerState>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    // Subscribe BEFORE snapshotting so an item recorded in the gap between the two
    // is still delivered as a delta.
    let rx = state.activity.subscribe();
    let snapshot = ActivityStreamFrame::Snapshot {
        items: state
            .activity
            .list(DEFAULT_LIMIT, None)
            .await
            .unwrap_or_default(),
    };

    let stream = futures_util::stream::unfold(
        (rx, Some(snapshot)),
        |(mut rx, pending_snapshot)| async move {
            if let Some(snap) = pending_snapshot {
                let data = serde_json::to_string(&snap).unwrap_or_default();
                return Some((Ok(Event::default().data(data)), (rx, None)));
            }
            loop {
                match rx.recv().await {
                    Ok(item) => {
                        let frame = ActivityStreamFrame::Item { item };
                        let data = serde_json::to_string(&frame).unwrap_or_default();
                        return Some((Ok(Event::default().data(data)), (rx, None)));
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return None,
                }
            }
        },
    );
    Sse::new(stream).keep_alive(KeepAlive::default())
}
