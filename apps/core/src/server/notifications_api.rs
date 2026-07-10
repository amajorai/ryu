//! HTTP API for the app-inbox notification feed (`/api/notifications/*`).
//!
//! User-scoped notifications a workflow (or any Core subsystem) pushes to a
//! specific member: list, mark read, acknowledge, and an SSE live stream. A
//! notification carrying `ack_required` + a `workflow_run_id` is a HITL gate — its
//! acknowledgement resumes the suspended run via
//! [`crate::workflow::notify_user::ack_gate`].
//!
//! The viewer identifies itself with a `user_id` query param (the surface knows
//! its logged-in member, the same way it registers push tokens). This mirrors the
//! local-first, single-node trust model of the monitors push-token API; a shared
//! team node still keeps each member's feed separate by that id.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::json;

use super::ServerState;
use crate::identity_verify::VerifiedCaller;

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

/// Query for `GET /api/notifications` and the SSE stream.
#[derive(Debug, Deserialize)]
pub struct ListQuery {
    /// The member whose feed to read. Trusted only on an unbound local (single-
    /// user) node; on an org-bound node it must equal the verified caller.
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

/// Resolve the effective viewer for a member-scoped read.
///
/// Fail-closed authorization for the app inbox: the viewer is the JWT-verified
/// caller ([`attach_verified_caller`] inserts `Option<VerifiedCaller>` on every
/// request), and a `requested` id that differs is rejected (403). When there is no
/// verified identity we branch on node binding:
///   - **org-bound node** (managed / shared team node) → 401: a member feed is
///     never readable unauthenticated, so one teammate cannot read another's.
///   - **unbound local node** (single-user, local-first) → trust `requested`.
///
/// [`attach_verified_caller`]: super::attach_verified_caller
fn resolve_viewer(
    caller: Option<VerifiedCaller>,
    requested: Option<&str>,
) -> Result<String, StatusCode> {
    match caller {
        Some(c) => {
            if let Some(req) = requested.filter(|s| !s.is_empty()) {
                if req != c.user_id {
                    return Err(StatusCode::FORBIDDEN);
                }
            }
            Ok(c.user_id)
        }
        None => {
            if crate::sidecar::control_plane::registered_org().is_some() {
                Err(StatusCode::UNAUTHORIZED)
            } else {
                requested
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .ok_or(StatusCode::BAD_REQUEST)
            }
        }
    }
}

/// `GET /api/notifications?user_id=..&limit=..` — a member's inbox, newest first.
/// The feed served is always the verified caller's own (an org-bound node rejects
/// an unauthenticated or mismatched request).
pub async fn list_notifications(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Query(q): Query<ListQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    let viewer = match resolve_viewer(caller, q.user_id.as_deref()) {
        Ok(v) => v,
        Err(code) => return (code, Json(json!({ "error": "unauthorized" }))),
    };
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    match state
        .monitors
        .store
        .list_notifications_for_user(&viewer, limit)
        .await
    {
        Ok(items) => (StatusCode::OK, Json(json!({ "notifications": items }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `POST /api/notifications/:id/read` — mark a notification read.
///
/// Only the notification's own recipient may mark it read: the row is fetched and
/// the verified caller is authorized against `row.user_id` BEFORE any mutation
/// (mirrors [`ack_notification`]), so a cross-member id cannot flip another
/// recipient's inbox row.
pub async fn read_notification(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Ok(Some(row)) = state.monitors.store.get_notification(&id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "notification not found" })),
        );
    };

    // Authorize the caller against the notification's recipient BEFORE mutating.
    if let Err(code) = resolve_viewer(caller, row.user_id.as_deref()) {
        return (code, Json(json!({ "error": "unauthorized" })));
    }

    match state.monitors.store.mark_notification_read(&id).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `POST /api/notifications/:id/ack` — acknowledge a notification. When it is a
/// workflow HITL gate, this records the member's ack and resumes the run once the
/// gate's policy (first / all / quorum) is met.
///
/// Only the notification's own recipient may ack it: the actor is the verified
/// caller and must equal `row.user_id` (an org-bound node rejects an
/// unauthenticated or cross-member ack, so a gate cannot be resumed by a
/// non-target). The verified actor — not the stored row id — is what
/// [`crate::workflow::notify_user::ack_gate`] records.
pub async fn ack_notification(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Ok(Some(row)) = state.monitors.store.get_notification(&id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "notification not found" })),
        );
    };

    // Authorize the actor against the notification's recipient BEFORE any mutation.
    let actor = match resolve_viewer(caller, row.user_id.as_deref()) {
        Ok(a) => a,
        Err(code) => return (code, Json(json!({ "error": "unauthorized" }))),
    };

    // Mark the inbox row acked (best-effort) now that the actor is authorized.
    let _ = state.monitors.store.mark_notification_acked(&id).await;

    // Not a workflow gate → a plain read-style ack is all there is to do.
    let Some(run_id) = row.workflow_run_id.as_deref() else {
        return (StatusCode::OK, Json(json!({ "ok": true, "resumed": false })));
    };
    if !row.ack_required {
        return (StatusCode::OK, Json(json!({ "ok": true, "resumed": false })));
    }

    match crate::workflow::notify_user::ack_gate(run_id, &actor).await {
        Ok(outcome) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "resumed": outcome.satisfied })),
        ),
        // The run may already have been resumed/failed by another member's ack —
        // surface it without failing the inbox action.
        Err(e) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "resumed": false, "note": e })),
        ),
    }
}

/// `GET /api/notifications/stream?user_id=..` — SSE feed of live notifications for
/// one member. The filter key is the verified caller (an org-bound node rejects an
/// unauthenticated or mismatched subscribe); events addressed to a different
/// member are dropped, broadcasts are forwarded.
pub async fn notifications_stream(
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Query(q): Query<ListQuery>,
) -> Result<
    axum::response::sse::Sse<
        impl futures_util::Stream<
            Item = Result<axum::response::sse::Event, std::convert::Infallible>,
        >,
    >,
    StatusCode,
> {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use tokio::sync::broadcast::error::RecvError;

    let viewer = resolve_viewer(caller, q.user_id.as_deref())?;
    let rx = crate::events::subscribe();
    let stream = futures_util::stream::unfold((rx, viewer), |(mut rx, user_id)| async move {
        loop {
            match rx.recv().await {
                Ok(n) => {
                    // Drop events addressed to a different member.
                    if let Some(target) = &n.target_user_id {
                        if target != &user_id {
                            continue;
                        }
                    }
                    let data = serde_json::to_string(&n).unwrap_or_default();
                    return Some((Ok(Event::default().data(data)), (rx, user_id)));
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}
