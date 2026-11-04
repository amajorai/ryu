//! Download center handlers (#456).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Download center handlers (#456)─────────────────────────────────────────

/// `GET /api/downloads` — current snapshot of all tracked downloads.
#[utoipa::path(
    get,
    path = "/api/downloads",
    tag = "Downloads",
    summary = "List downloads (download center)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_downloads(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    let tasks = state.downloads.snapshot().await;
    Json(json!({ "downloads": tasks }))
}

/// `GET /api/downloads/history` — the durable log of finished downloads (newest
/// first), which survives restart even though live terminal tasks are dropped
/// from the active snapshot.
#[utoipa::path(
    get,
    path = "/api/downloads/history",
    tag = "Downloads",
    summary = "List previously finished downloads (durable history)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn downloads_history(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    let history = state.downloads.history().await;
    Json(json!({ "history": history }))
}

/// `DELETE /api/downloads/history` — empty the durable finished-downloads log.
///
/// The per-task `DELETE /api/downloads/{id}` only drops a row from the ACTIVE
/// registry; the history copy outlives it. Without this route the downloads
/// page's History section could never be emptied by any UI.
#[utoipa::path(
    delete,
    path = "/api/downloads/history",
    tag = "Downloads",
    summary = "Clear the durable finished-downloads history",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn downloads_history_clear(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    let cleared = state.downloads.clear_history().await;
    Json(json!({ "ok": true, "cleared": cleared }))
}

/// `GET /api/downloads/settings` — how many downloads run at once, and why.
#[utoipa::path(
    get,
    path = "/api/downloads/settings",
    tag = "Downloads",
    summary = "Get download concurrency settings",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn downloads_settings(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    Json(json!(state.downloads.settings().await))
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct DownloadSettingsBody {
    /// `"auto"` or `"manual"`.
    pub(in crate::server) mode: crate::downloads::ConcurrencyMode,
    /// Slot count; only applied in manual mode, and clamped to the allowed range.
    #[serde(default)]
    pub(in crate::server) max_concurrent: Option<usize>,
}

#[derive(Debug, serde::Deserialize)]
pub(in crate::server) struct BrowserModelPreparationBody {
    pub(in crate::server) model_id: String,
}

pub(in crate::server) fn is_valid_browser_model_id(model_id: &str) -> bool {
    let mut parts = model_id.split('/');
    let Some(owner) = parts.next() else {
        return false;
    };
    let Some(name) = parts.next() else {
        return false;
    };
    parts.next().is_none()
        && !owner.is_empty()
        && !name.is_empty()
        && model_id.len() <= 160
        && owner
            .chars()
            .chain(name.chars())
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
}

/// Register a browser-model manifest preparation job with the shared
/// DownloadCenter. The browser still performs inference itself; Core only
/// validates the Hub snapshot and records preparation progress/history through
/// the same center used by every other model artifact.
#[utoipa::path(
    post,
    path = "/api/downloads/browser-model",
    tag = "Downloads",
    summary = "Prepare a browser model manifest",
    request_body = serde_json::Value,
    responses((status = 202, description = "Preparation queued", body = serde_json::Value))
)]
pub(in crate::server) async fn prepare_browser_model(
    State(state): State<ServerState>,
    Json(body): Json<BrowserModelPreparationBody>,
) -> axum::response::Response {
    if !is_valid_browser_model_id(&body.model_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "invalid Hugging Face model id" })),
        )
            .into_response();
    }

    let model_id = body.model_id;
    let response_model_id = model_id.clone();
    let job_id = format!("browser-model:{}", model_id.replace('/', "__"));
    let task_id = job_id.clone();
    let downloads = state.downloads.clone();
    tokio::spawn(async move {
        let label_model_id = model_id.clone();
        let result = downloads
            .register_indeterminate_as(
                task_id,
                crate::downloads::DownloadKind::Model,
                crate::downloads::DownloadRole::ChatModel,
                format!("Browser model manifest: {label_model_id}"),
                async move {
                    let url = format!("https://huggingface.co/api/models/{model_id}");
                    let response = reqwest::Client::new()
                        .get(url)
                        // Without a deadline a stalled Hub request would leave
                        // this indeterminate task spinning forever.
                        .timeout(std::time::Duration::from_secs(30))
                        .send()
                        .await?
                        .error_for_status()?;
                    let manifest: serde_json::Value = response.json().await?;
                    let file_count = manifest
                        .get("siblings")
                        .and_then(serde_json::Value::as_array)
                        .map_or(0, Vec::len);
                    anyhow::ensure!(
                        file_count > 0,
                        "Hugging Face model has no downloadable files"
                    );
                    Ok::<_, anyhow::Error>(file_count)
                },
            )
            .await;
        if let Err(error) = result {
            tracing::warn!(%error, "browser model manifest preparation failed");
        }
    });

    (
        StatusCode::ACCEPTED,
        Json(json!({ "ok": true, "job_id": job_id, "model_id": response_model_id })),
    )
        .into_response()
}

/// `PUT /api/downloads/settings` — pin the parallel-download count, or hand it
/// back to the auto-tuner. Rejected when the value is pinned by
/// `RYU_MAX_CONCURRENT_DOWNLOADS` (an operator's environment wins over the UI).
#[utoipa::path(
    put,
    path = "/api/downloads/settings",
    tag = "Downloads",
    summary = "Set download concurrency settings",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 409, description = "Pinned by the environment")
    )
)]
pub(in crate::server) async fn set_downloads_settings(
    State(state): State<ServerState>,
    Json(body): Json<DownloadSettingsBody>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, Json<serde_json::Value>)> {
    match state
        .downloads
        .set_settings(body.mode, body.max_concurrent)
        .await
    {
        Ok(view) => Ok(Json(json!(view))),
        Err(e) => Err((
            axum::http::StatusCode::CONFLICT,
            Json(json!({ "error": format!("{e:#}") })),
        )),
    }
}

/// `GET /api/downloads/stream` — SSE: a full snapshot on connect, then deltas.
/// The snapshot-first contract lets a late/lagged client self-heal (a missed
/// broadcast delta is corrected by the next event), so terminal states are never
/// silently lost.
#[utoipa::path(
    get,
    path = "/api/downloads/stream",
    tag = "Downloads",
    summary = "Download center SSE stream",
    responses((status = 200, description = "Server-Sent Events stream"))
)]
pub(in crate::server) async fn downloads_stream(
    State(state): State<ServerState>,
) -> axum::response::sse::Sse<
    impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use futures_util::StreamExt;

    let stream = download_event_frames(state.downloads.clone())
        .map(|data| Ok::<_, std::convert::Infallible>(Event::default().data(data)));
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// The downloads event stream as serialized frames: a snapshot first, then live
/// deltas, and a fresh snapshot whenever this subscriber lagged behind the
/// broadcast buffer.
///
/// Snapshot-first means a late client self-heals; the resync on lag means a slow
/// one does too. Skipping lagged events (as this used to) could drop a task's
/// terminal `Update`/`Removed`, leaving it shown as downloading forever.
///
/// Every snapshot comes from [`crate::downloads::DownloadCenter::snapshot_and_subscribe`],
/// which takes the snapshot and a fresh subscription atomically, so the deltas
/// that follow are exactly the commits after it: none missed, none replayed (a
/// replayed delta would step a row back to an older state for one event).
pub(in crate::server) fn download_event_frames(
    downloads: crate::downloads::DownloadCenter,
) -> impl futures_util::Stream<Item = String> + Send + 'static {
    resyncing_download_frames(move || {
        let downloads = downloads.clone();
        async move { downloads.snapshot_and_subscribe().await }
    })
}

/// [`download_event_frames`] over any atomic snapshot-and-subscribe source, so
/// the snapshot-first and resync-on-lag rules are testable without a live
/// download. `open` is called for the first frame and again after a lag; each
/// call replaces the receiver, so the deltas after a snapshot start exactly at
/// that snapshot.
pub(in crate::server) fn resyncing_download_frames<Open, OpenFuture>(
    open: Open,
) -> impl futures_util::Stream<Item = String> + Send + 'static
where
    Open: Fn() -> OpenFuture + Send + 'static,
    OpenFuture: std::future::Future<
            Output = (
                Vec<crate::downloads::DownloadTask>,
                tokio::sync::broadcast::Receiver<crate::downloads::DownloadEvent>,
            ),
        > + Send
        + 'static,
{
    use tokio::sync::broadcast::error::RecvError;

    // State carries the live receiver once a snapshot has been emitted; `None`
    // means the next frame is a (re)snapshot.
    futures_util::stream::unfold(
        (
            open,
            None::<tokio::sync::broadcast::Receiver<crate::downloads::DownloadEvent>>,
        ),
        |(open, rx)| async move {
            let mut rx = match rx {
                Some(rx) => rx,
                None => {
                    let (tasks, rx) = open().await;
                    let event = crate::downloads::DownloadEvent::Snapshot { tasks };
                    let data = serde_json::to_string(&event).unwrap_or_default();
                    return Some((data, (open, Some(rx))));
                }
            };
            match rx.recv().await {
                Ok(ev) => {
                    let data = serde_json::to_string(&ev).unwrap_or_default();
                    Some((data, (open, Some(rx))))
                }
                Err(RecvError::Lagged(_)) => {
                    // Resync atomically: a fresh snapshot plus a fresh receiver
                    // that starts exactly after it.
                    let (tasks, rx) = open().await;
                    let event = crate::downloads::DownloadEvent::Snapshot { tasks };
                    let data = serde_json::to_string(&event).unwrap_or_default();
                    Some((data, (open, Some(rx))))
                }
                Err(RecvError::Closed) => None,
            }
        },
    )
}

/// Shared body for the control endpoints — `{ ok }` or 404 when the id is unknown.
pub(in crate::server) fn download_control_result(
    ok: bool,
) -> (StatusCode, Json<serde_json::Value>) {
    if ok {
        (StatusCode::OK, Json(json!({ "ok": true })))
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "ok": false, "error": "unknown download id" })),
        )
    }
}

#[utoipa::path(
    post,
    path = "/api/downloads/{id}/pause",
    tag = "Downloads",
    summary = "Pause a download",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn download_pause(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    download_control_result(state.downloads.pause(&id).await)
}

#[utoipa::path(
    post,
    path = "/api/downloads/{id}/resume",
    tag = "Downloads",
    summary = "Resume a download",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn download_resume(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    download_control_result(state.downloads.resume(&id).await)
}

#[utoipa::path(
    post,
    path = "/api/downloads/{id}/retry",
    tag = "Downloads",
    summary = "Retry a download",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn download_retry(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    download_control_result(state.downloads.retry(&id).await)
}

#[utoipa::path(
    post,
    path = "/api/downloads/{id}/cancel",
    tag = "Downloads",
    summary = "Cancel a download",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn download_cancel(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    download_control_result(state.downloads.cancel(&id).await)
}

#[utoipa::path(
    delete,
    path = "/api/downloads/{id}",
    tag = "Downloads",
    summary = "Clear a download entry",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn download_clear(
    State(state): State<ServerState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    download_control_result(state.downloads.clear(&id).await)
}
