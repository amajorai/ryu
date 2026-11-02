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
use crate::notify::{NotificationRow, NotifyStore};

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

fn is_connect_suggestion(source_app_id: Option<&str>) -> bool {
    source_app_id == Some(crate::notify::ISLAND_CONNECT_SUGGESTION_SOURCE)
}

/// Replace a connected-app suggestion's text with the Streaming placeholder in `locale`.
fn redact_connect_suggestion_fields(title: &mut String, body: &mut Option<String>, locale: &str) {
    let (placeholder_title, placeholder_body) = crate::notify::privacy_placeholder(locale);
    *title = placeholder_title;
    *body = Some(placeholder_body);
}

/// Mask connected-app suggestions while Streaming is on. Rows persisted with the
/// English placeholder are shown in `locale` either way.
fn project_streaming_private_notifications(
    mut notifications: Vec<crate::notify::store::NotificationRow>,
    streaming_active: bool,
    locale: &str,
) -> Vec<crate::notify::store::NotificationRow> {
    for notification in &mut notifications {
        if !is_connect_suggestion(notification.source_app_id.as_deref()) {
            continue;
        }
        if streaming_active {
            redact_connect_suggestion_fields(
                &mut notification.title,
                &mut notification.body,
                locale,
            );
            notification.workflow_run_id = None;
            notification.node_id = None;
        } else {
            crate::notify::localize_privacy_placeholder(
                &mut notification.title,
                &mut notification.body,
                locale,
            );
        }
    }
    notifications
}

/// Project the node-scoped notification roster into the compact shape the chat
/// composer needs. The user id is the only durable identity; the other fields
/// are display data and may be absent on partially mirrored accounts.
fn mention_targets_payload(
    users: Vec<crate::sidecar::control_plane::NotifyTargetUser>,
) -> serde_json::Value {
    json!({
        "users": users
            .into_iter()
            .map(|user| {
                json!({
                    "email": user.email,
                    "image": user.image,
                    "name": user.name.unwrap_or_else(|| user.user_id.clone()),
                    "role": user.role,
                    "userId": user.user_id,
                })
            })
            .collect::<Vec<_>>(),
    })
}

/// Query for `GET /api/notifications` and the SSE stream.
#[derive(Debug, Deserialize)]
pub struct ListQuery {
    /// The member whose feed to read. Trusted only on an unbound local (single-
    /// user) node; on an org-bound node it must equal the verified caller.
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    /// Filter by archive state: `true` = archived rows only, `false` (default) =
    /// the live inbox, absent = every row.
    #[serde(default)]
    pub archived: Option<bool>,
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

type Reply = (StatusCode, Json<serde_json::Value>);

fn error_reply(status: StatusCode, error: &str) -> Reply {
    (status, Json(json!({ "error": error })))
}

fn store_not_ready() -> Reply {
    error_reply(StatusCode::SERVICE_UNAVAILABLE, "notify store not ready")
}

/// Fetch notification `id` and authorize the caller against its recipient
/// (`row.user_id`) BEFORE any mutation, so a cross-member id can never touch
/// another recipient's inbox row. Yields the store, the row, and the
/// authorized actor.
async fn authorize_recipient(
    caller: Option<VerifiedCaller>,
    id: &str,
) -> Result<(NotifyStore, NotificationRow, String), Reply> {
    let Some(store) = crate::notify::global_store() else {
        return Err(store_not_ready());
    };
    let Ok(Some(row)) = store.get_notification(id).await else {
        return Err(error_reply(StatusCode::NOT_FOUND, "notification not found"));
    };
    let actor = resolve_viewer(caller, row.user_id.as_deref())
        .map_err(|code| error_reply(code, "unauthorized"))?;
    Ok((store, row, actor))
}

/// `{ ok: true }` once a recipient-gated mutation succeeds; a 500 otherwise.
fn mutation_reply(result: anyhow::Result<bool>) -> Reply {
    match result {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => error_reply(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// `GET /api/notifications?user_id=..&limit=..` — a member's inbox, newest first.
/// The feed served is always the verified caller's own (an org-bound node rejects
/// an unauthenticated or mismatched request).
#[utoipa::path(
    get,
    path = "/api/notifications",
    tag = "Notifications",
    summary = "a member's inbox, newest first.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_notifications(
    State(_state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Query(q): Query<ListQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    let viewer = match resolve_viewer(caller, q.user_id.as_deref()) {
        Ok(v) => v,
        Err(code) => return error_reply(code, "unauthorized"),
    };
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let Some(store) = crate::notify::global_store() else {
        return store_not_ready();
    };
    match store
        .list_notifications_for_user(&viewer, limit, q.archived)
        .await
    {
        Ok(items) => {
            // Reading the preference costs a store read; only connected-app rows need it.
            let locale = if items
                .iter()
                .any(|item| is_connect_suggestion(item.source_app_id.as_deref()))
            {
                crate::i18n::locale::node_locale().await
            } else {
                "en"
            };
            let items = project_streaming_private_notifications(
                items,
                crate::presence::streaming_privacy_active(),
                locale,
            );
            (StatusCode::OK, Json(json!({ "notifications": items })))
        }
        Err(e) => error_reply(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

#[cfg(test)]
mod streaming_privacy_tests;

/// `GET /api/notifications/mention-targets` — the human rows the active Inbox
/// app may expose in the chat `@` picker. Core resolves the organization/team
/// scope from the node's gateway credential; the verified caller requirement
/// prevents an anonymous node-token holder from enumerating that roster.
#[utoipa::path(
    get,
    path = "/api/notifications/mention-targets",
    tag = "Notifications",
    summary = "list scoped human mention targets.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn mention_targets(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(caller) = caller else {
        return error_reply(StatusCode::UNAUTHORIZED, "verified caller required");
    };
    if caller.org_id.is_none() || crate::sidecar::control_plane::registered_org().is_none() {
        return error_reply(StatusCode::FORBIDDEN, "organization roster unavailable");
    }
    match crate::sidecar::control_plane::resolve_notify_targets(&state.client, None).await {
        Ok(users) => (StatusCode::OK, Json(mention_targets_payload(users))),
        Err(_) => error_reply(
            StatusCode::SERVICE_UNAVAILABLE,
            "organization roster unavailable",
        ),
    }
}

/// `POST /api/notifications/:id/read` — mark a notification read.
///
/// Only the notification's own recipient may mark it read: the row is fetched and
/// the verified caller is authorized against `row.user_id` BEFORE any mutation
/// (mirrors [`ack_notification`]), so a cross-member id cannot flip another
/// recipient's inbox row.
#[utoipa::path(
    post,
    path = "/api/notifications/{id}/read",
    tag = "Notifications",
    summary = "mark a notification read.",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn read_notification(
    State(_state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match authorize_recipient(caller, &id).await {
        Ok((store, _, _)) => mutation_reply(store.mark_notification_read(&id).await),
        Err(reply) => reply,
    }
}

/// `POST /api/notifications/:id/archive` — move a notification into the archive.
///
/// Only the notification's own recipient may archive it (same recipient check as
/// [`read_notification`]): the row is fetched and the verified caller is
/// authorized against `row.user_id` BEFORE any mutation. Archiving also marks the
/// row read.
#[utoipa::path(
    post,
    path = "/api/notifications/{id}/archive",
    tag = "Notifications",
    summary = "archive a notification.",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn archive_notification(
    State(_state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match authorize_recipient(caller, &id).await {
        Ok((store, _, _)) => mutation_reply(store.mark_notification_archived(&id).await),
        Err(reply) => reply,
    }
}

/// `POST /api/notifications/:id/unarchive` — restore an archived notification to
/// the live inbox. Recipient-gated exactly like [`archive_notification`].
#[utoipa::path(
    post,
    path = "/api/notifications/{id}/unarchive",
    tag = "Notifications",
    summary = "unarchive a notification.",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn unarchive_notification(
    State(_state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match authorize_recipient(caller, &id).await {
        Ok((store, _, _)) => mutation_reply(store.mark_notification_unarchived(&id).await),
        Err(reply) => reply,
    }
}

/// `POST /api/notifications/:id/ack` — acknowledge a notification. When it is a
/// workflow HITL gate, this records the member's ack and resumes the run once the
/// gate's policy (first / all / quorum / percentage) is met.
///
/// Only the notification's own recipient may ack it: the actor is the verified
/// caller and must equal `row.user_id` (an org-bound node rejects an
/// unauthenticated or cross-member ack, so a gate cannot be resumed by a
/// non-target). The verified actor — not the stored row id — is what
/// [`crate::workflow::notify_user::ack_gate`] records.
#[utoipa::path(
    post,
    path = "/api/notifications/{id}/ack",
    tag = "Notifications",
    summary = "acknowledge a notification. When it is a",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn ack_notification(
    State(_state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let (store, row, actor) = match authorize_recipient(caller, &id).await {
        Ok(authorized) => authorized,
        Err(reply) => return reply,
    };

    let gate = row.workflow_run_id.as_deref().filter(|_| row.ack_required);
    // A run with concurrent gates routes one at a time. An ack for a gate that is
    // not the routed one is refused before the row is marked acked, so the member
    // can acknowledge it once its own gate is waiting.
    if let Some(run_id) = gate {
        if let Err(note) =
            crate::workflow::notify_user::check_gate(run_id, row.node_id.as_deref()).await
        {
            return (
                StatusCode::OK,
                Json(json!({ "ok": true, "resumed": false, "note": note })),
            );
        }
    }

    // Mark the inbox row acked (best-effort) now that the actor is authorized.
    let _ = store.mark_notification_acked(&id).await;

    // Not an ack-required workflow gate → a plain read-style ack is all there is
    // to do.
    let Some(run_id) = gate else {
        return (
            StatusCode::OK,
            Json(json!({ "ok": true, "resumed": false })),
        );
    };

    match crate::workflow::notify_user::ack_gate(run_id, &actor, row.node_id.as_deref()).await {
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
#[utoipa::path(
    get,
    path = "/api/notifications/stream",
    tag = "Notifications",
    summary = "SSE feed of live notifications for",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn notifications_stream(
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Query(q): Query<ListQuery>,
) -> Result<
    axum::response::sse::Sse<
        impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
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
                Ok(mut n) => {
                    // Drop events addressed to a different member.
                    if let Some(target) = &n.target_user_id {
                        if target != &user_id {
                            continue;
                        }
                    }
                    if is_connect_suggestion(n.source_app_id.as_deref()) {
                        let locale = crate::i18n::locale::node_locale().await;
                        if crate::presence::streaming_privacy_active() {
                            redact_connect_suggestion_fields(&mut n.title, &mut n.body, locale);
                        } else {
                            // A row saved with the placeholder after Streaming ended.
                            crate::notify::localize_privacy_placeholder(
                                &mut n.title,
                                &mut n.body,
                                locale,
                            );
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

mod push_tokens;

pub use push_tokens::{
    __path_register_push_token, __path_remove_push_token, register_push_token, remove_push_token,
};

#[cfg(test)]
mod tests;
