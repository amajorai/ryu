//! `/api/operations`: list, read, cancel, retry and the live stream.
//!
//! A feature keeps its own start route (imports use `POST /api/import/run`
//! with `"async": true`); these routes are the same for every kind. An
//! operation is served to the user who started it and to callers with
//! `nodes.manage`; anyone else gets 404, the same answer as for an id that
//! does not exist.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Extension, Json, Router,
};
use futures_util::StreamExt as _;
use serde::Serialize;
use serde_json::json;
use utoipa::ToSchema;

use super::access::{OperationError, OperationEvent, Viewer};
use super::record::{OperationProgress, OperationRecord, OperationStatus};
use super::service::{global, OperationService};
use crate::identity_verify::{permissions::NODES_MANAGE, VerifiedCaller};
use crate::server::{enforce_permission, ServerState};

type Caller = Extension<Option<VerifiedCaller>>;

/// The body of `GET /api/operations`.
#[derive(Debug, Serialize, ToSchema)]
pub struct OperationList {
    /// Running and recent operations, newest first, without `input`, `cursor`
    /// and `result`.
    pub operations: Vec<OperationRecord>,
}

pub fn router() -> Router<ServerState> {
    Router::new()
        .route("/api/operations", get(list_operations))
        .route("/api/operations/stream", get(operations_stream))
        .route("/api/operations/:id", get(get_operation))
        .route("/api/operations/:id/cancel", post(cancel_operation))
        .route("/api/operations/:id/retry", post(retry_operation))
}

#[derive(utoipa::OpenApi)]
#[openapi(
    paths(
        list_operations,
        operations_stream,
        get_operation,
        cancel_operation,
        retry_operation
    ),
    components(schemas(OperationList, OperationRecord, OperationProgress, OperationStatus)),
    tags((name = "Operations", description = "Long-running operations that keep going after the request ends: list, follow, cancel and retry."))
)]
struct OperationsApiDoc;

/// The OpenAPI paths of this module, merged into the Core spec.
pub(crate) fn openapi() -> utoipa::openapi::OpenApi {
    use utoipa::OpenApi;
    OperationsApiDoc::openapi()
}

/// Who is asking: the caller's user id, and whether they manage the node.
async fn viewer(state: &ServerState, caller: &Option<VerifiedCaller>) -> Viewer {
    Viewer {
        user_id: caller.as_ref().map(|verified| verified.user_id.clone()),
        manager: enforce_permission(state, caller, NODES_MANAGE)
            .await
            .is_ok(),
    }
}

/// An error as the API answers it. A store message can name a local path, so
/// only its code and a fixed sentence are sent.
pub(crate) fn failure(error: &OperationError) -> Response {
    let status = match error {
        OperationError::NotFound => StatusCode::NOT_FOUND,
        OperationError::NotRetryable | OperationError::IdempotencyConflict => StatusCode::CONFLICT,
        OperationError::UnknownKind(_) | OperationError::InvalidIdempotencyKey => {
            StatusCode::BAD_REQUEST
        }
        OperationError::Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let message = match error {
        OperationError::Store(_) => "The operation could not be saved".to_owned(),
        other => other.to_string(),
    };
    (
        status,
        Json(json!({ "code": error.code(), "error": message })),
    )
        .into_response()
}

fn answer(result: Result<OperationRecord, OperationError>) -> Response {
    match result {
        Ok(record) => Json(record).into_response(),
        Err(error) => failure(&error),
    }
}

/// The node's service, or the response to send when it cannot open.
fn service() -> Result<OperationService, Response> {
    global().map_err(|error| failure(&error))
}

pub(super) async fn list_for(service: &OperationService, viewer: &Viewer) -> OperationList {
    OperationList {
        operations: service.list(viewer).await,
    }
}

pub(super) async fn read_for(service: &OperationService, id: &str, viewer: &Viewer) -> Response {
    answer(service.get(id, viewer).await.map(|record| record.detail()))
}

pub(super) async fn cancel_for(service: &OperationService, id: &str, viewer: &Viewer) -> Response {
    answer(
        service
            .cancel(id, viewer)
            .await
            .map(|record| record.summary()),
    )
}

pub(super) async fn retry_for(service: &OperationService, id: &str, viewer: &Viewer) -> Response {
    answer(
        service
            .retry(id, viewer)
            .await
            .map(|record| record.summary()),
    )
}

#[utoipa::path(
    get,
    path = "/api/operations",
    tag = "Operations",
    summary = "List running and recent operations",
    description = "The caller's own operations, or every operation for a caller with nodes.manage. Newest first. Finished operations are kept for 30 days, at most 500.",
    responses((status = 200, description = "OK", body = OperationList))
)]
pub async fn list_operations(
    State(state): State<ServerState>,
    Extension(caller): Caller,
) -> Response {
    let service = match service() {
        Ok(service) => service,
        Err(response) => return response,
    };
    Json(list_for(&service, &viewer(&state, &caller).await).await).into_response()
}

#[utoipa::path(
    get,
    path = "/api/operations/{id}",
    tag = "Operations",
    summary = "Read one operation with its input, checkpoint and result",
    params(("id" = String, Path)),
    responses(
        (status = 200, description = "OK", body = OperationRecord),
        (status = 404, description = "No such operation, or it belongs to another user")
    )
)]
pub async fn get_operation(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(id): Path<String>,
) -> Response {
    let service = match service() {
        Ok(service) => service,
        Err(response) => return response,
    };
    read_for(&service, &id, &viewer(&state, &caller).await).await
}

#[utoipa::path(
    post,
    path = "/api/operations/{id}/cancel",
    tag = "Operations",
    summary = "Ask an operation to stop",
    description = "The operation stops between steps and keeps what it has done. Cancelling a finished operation changes nothing.",
    params(("id" = String, Path)),
    responses(
        (status = 200, description = "OK", body = OperationRecord),
        (status = 404, description = "No such operation, or it belongs to another user")
    )
)]
pub async fn cancel_operation(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(id): Path<String>,
) -> Response {
    let service = match service() {
        Ok(service) => service,
        Err(response) => return response,
    };
    cancel_for(&service, &id, &viewer(&state, &caller).await).await
}

#[utoipa::path(
    post,
    path = "/api/operations/{id}/retry",
    tag = "Operations",
    summary = "Start a failed, cancelled or interrupted operation again",
    description = "A kind that can resume continues from its checkpoint; any other starts over.",
    params(("id" = String, Path)),
    responses(
        (status = 200, description = "OK", body = OperationRecord),
        (status = 404, description = "No such operation, or it belongs to another user"),
        (status = 409, description = "The operation is running or succeeded")
    )
)]
pub async fn retry_operation(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(id): Path<String>,
) -> Response {
    let service = match service() {
        Ok(service) => service,
        Err(response) => return response,
    };
    retry_for(&service, &id, &viewer(&state, &caller).await).await
}

#[utoipa::path(
    get,
    path = "/api/operations/stream",
    tag = "Operations",
    summary = "Operations SSE stream",
    description = "A `snapshot` frame on connect, then `update` and `removed` frames. A listener that falls behind is sent a new snapshot.",
    responses((status = 200, description = "Server-Sent Events stream"))
)]
pub async fn operations_stream(
    State(state): State<ServerState>,
    Extension(caller): Caller,
) -> Response {
    let service = match service() {
        Ok(service) => service,
        Err(response) => return response,
    };
    let frames = operation_event_frames(service, viewer(&state, &caller).await)
        .map(|data| Ok::<_, std::convert::Infallible>(Event::default().data(data)));
    Sse::new(frames)
        .keep_alive(KeepAlive::default())
        .into_response()
}

/// The stream as serialized frames: a snapshot first, then the changes the
/// viewer may see, and a fresh snapshot whenever this listener fell behind
/// the event buffer (a skipped change could otherwise leave an operation
/// shown as running for good).
pub(super) fn operation_event_frames(
    service: OperationService,
    viewer: Viewer,
) -> impl futures_util::Stream<Item = String> + Send + 'static {
    use tokio::sync::broadcast::error::RecvError;

    futures_util::stream::unfold(
        (
            service,
            viewer,
            None::<tokio::sync::broadcast::Receiver<OperationEvent>>,
        ),
        |(service, viewer, receiver)| async move {
            let Some(mut receiver) = receiver else {
                let (operations, receiver) = service.snapshot_and_subscribe(&viewer).await;
                let frame = frame_of(&OperationEvent::Snapshot { operations });
                return Some((frame, (service, viewer, Some(receiver))));
            };
            loop {
                match receiver.recv().await {
                    Ok(event) => {
                        // Changes to other users' operations are skipped.
                        if let Some(event) = event.visible_to(&viewer) {
                            return Some((frame_of(&event), (service, viewer, Some(receiver))));
                        }
                    }
                    // Resync: the next frame is a snapshot with a new receiver.
                    Err(RecvError::Lagged(_)) => {
                        let (operations, receiver) = service.snapshot_and_subscribe(&viewer).await;
                        let frame = frame_of(&OperationEvent::Snapshot { operations });
                        return Some((frame, (service, viewer, Some(receiver))));
                    }
                    Err(RecvError::Closed) => return None,
                }
            }
        },
    )
}

fn frame_of(event: &OperationEvent) -> String {
    serde_json::to_string(event).unwrap_or_default()
}

#[cfg(test)]
#[path = "routes_tests.rs"]
mod tests;
