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
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Query(q): Query<ListQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    let viewer = match resolve_viewer(caller, q.user_id.as_deref()) {
        Ok(v) => v,
        Err(code) => return (code, Json(json!({ "error": "unauthorized" }))),
    };
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let Some(store) = crate::notify::global_store() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "notify store not ready" })),
        );
    };
    let _ = &state;
    match store
        .list_notifications_for_user(&viewer, limit, q.archived)
        .await
    {
        Ok(items) => (StatusCode::OK, Json(json!({ "notifications": items }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

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
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "verified caller required" })),
        );
    };
    if caller.org_id.is_none() || crate::sidecar::control_plane::registered_org().is_none() {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "organization roster unavailable" })),
        );
    }
    match crate::sidecar::control_plane::resolve_notify_targets(&state.client, None).await {
        Ok(users) => (StatusCode::OK, Json(mention_targets_payload(users))),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "organization roster unavailable" })),
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
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(store) = crate::notify::global_store() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "notify store not ready" })),
        );
    };
    let _ = &state;
    let Ok(Some(row)) = store.get_notification(&id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "notification not found" })),
        );
    };

    // Authorize the caller against the notification's recipient BEFORE mutating.
    if let Err(code) = resolve_viewer(caller, row.user_id.as_deref()) {
        return (code, Json(json!({ "error": "unauthorized" })));
    }

    match store.mark_notification_read(&id).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
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
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(store) = crate::notify::global_store() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "notify store not ready" })),
        );
    };
    let _ = &state;
    let Ok(Some(row)) = store.get_notification(&id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "notification not found" })),
        );
    };

    if let Err(code) = resolve_viewer(caller, row.user_id.as_deref()) {
        return (code, Json(json!({ "error": "unauthorized" })));
    }

    match store.mark_notification_archived(&id).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
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
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(store) = crate::notify::global_store() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "notify store not ready" })),
        );
    };
    let _ = &state;
    let Ok(Some(row)) = store.get_notification(&id).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "notification not found" })),
        );
    };

    if let Err(code) = resolve_viewer(caller, row.user_id.as_deref()) {
        return (code, Json(json!({ "error": "unauthorized" })));
    }

    match store.mark_notification_unarchived(&id).await {
        Ok(_) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
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
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(store) = crate::notify::global_store() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "notify store not ready" })),
        );
    };
    let _ = &state;
    let Ok(Some(row)) = store.get_notification(&id).await else {
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
    let _ = store.mark_notification_acked(&id).await;

    // Not a workflow gate → a plain read-style ack is all there is to do.
    let Some(run_id) = row.workflow_run_id.as_deref() else {
        return (
            StatusCode::OK,
            Json(json!({ "ok": true, "resumed": false })),
        );
    };
    if !row.ack_required {
        return (
            StatusCode::OK,
            Json(json!({ "ok": true, "resumed": false })),
        );
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

// -- Mobile push-token registration ------------------------------------------
//
// Expo push tokens are kernel notification-delivery state (used by the app-inbox
// deliver, monitor alerts, and approval pings), so registration is served here on
// the notify surface — NOT on the monitors router (which is moving out-of-process).
// Relocated from `/api/monitors/push-tokens`.

/// Request body for `POST /api/notifications/push-tokens`.
#[derive(Debug, Deserialize)]
pub struct PushTokenBody {
    pub token: String,
    #[serde(default)]
    pub platform: Option<String>,
    /// The member registering this device, so notifications can be pushed to a
    /// specific person's phones. Omitted by anonymous / single-user nodes.
    #[serde(default)]
    pub user_id: Option<String>,
}

/// `POST /api/notifications/push-tokens` — register a mobile Expo push token.
#[utoipa::path(
    post,
    path = "/api/notifications/push-tokens",
    tag = "Notifications",
    summary = "register a mobile Expo push token.",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn register_push_token(
    State(_state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(body): Json<PushTokenBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(store) = crate::notify::global_store() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "notify store not ready" })),
        );
    };
    let user_id = match resolve_push_token_owner(caller, body.user_id.as_deref()) {
        Ok(user_id) => user_id,
        Err(code) => return (code, Json(json!({ "error": "unauthorized" }))),
    };
    match store
        .register_push_token(&body.token, body.platform.as_deref(), user_id.as_deref())
        .await
    {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(false) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": "push token belongs to another member" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// `DELETE /api/notifications/push-tokens/:token` — unregister a push token.
#[utoipa::path(
    delete,
    path = "/api/notifications/push-tokens/{token}",
    tag = "Notifications",
    summary = "unregister a push token.",
    params(("token" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn remove_push_token(
    State(_state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(token): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(store) = crate::notify::global_store() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "notify store not ready" })),
        );
    };
    let result = if let Some(caller) = caller {
        match resolve_viewer(Some(caller), None) {
            Ok(user_id) => store.remove_push_token_for_user(&token, &user_id).await,
            Err(code) => return (code, Json(json!({ "error": "unauthorized" }))),
        }
    } else if crate::sidecar::control_plane::registered_org().is_some() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "verified caller required" })),
        );
    } else {
        // An unbound node is the legacy single-user/local flow. There is no
        // second member whose token could be deleted there, so retain the
        // node-level operation for anonymous local clients.
        store.remove_push_token(&token).await
    };
    match result {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "token not found" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Resolve the owner stamped on a push-token row. On an org-bound node this
/// always uses the verified caller and rejects a body-supplied other member;
/// on an unbound local node, anonymous registration may retain its legacy
/// node-wide (`NULL`) owner.
fn resolve_push_token_owner(
    caller: Option<VerifiedCaller>,
    requested: Option<&str>,
) -> Result<Option<String>, StatusCode> {
    match resolve_viewer(caller, requested) {
        Ok(user_id) => Ok(Some(user_id)),
        Err(StatusCode::BAD_REQUEST)
            if crate::sidecar::control_plane::registered_org().is_none()
                && requested.map(str::trim).unwrap_or("").is_empty() =>
        {
            Ok(None)
        }
        Err(code) => Err(code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_verify::OrgRole;

    fn caller(user_id: &str) -> VerifiedCaller {
        VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            org_id: None,
            role: OrgRole::Member,
            teams: Vec::new(),
        }
    }

    /// The deterministic security core (independent of node binding): with a verified
    /// caller, the effective viewer is ALWAYS the caller's own id, and a `requested`
    /// id that names a DIFFERENT member is a 403 — one teammate can never read
    /// another's inbox by passing their user_id.
    #[test]
    fn verified_caller_is_pinned_to_own_id() {
        // Matching requested id → OK, resolves to the caller.
        assert_eq!(
            resolve_viewer(Some(caller("alice")), Some("alice")),
            Ok("alice".to_owned())
        );
        // No requested id → still the caller's own id (never anonymous).
        assert_eq!(
            resolve_viewer(Some(caller("alice")), None),
            Ok("alice".to_owned())
        );
        // Empty requested id is ignored (filtered) → the caller's own id.
        assert_eq!(
            resolve_viewer(Some(caller("alice")), Some("")),
            Ok("alice".to_owned())
        );
    }

    #[test]
    fn verified_caller_reading_another_member_is_forbidden() {
        // Bob presents a valid JWT but asks for Alice's feed → 403, no data leak.
        assert_eq!(
            resolve_viewer(Some(caller("bob")), Some("alice")),
            Err(StatusCode::FORBIDDEN)
        );
    }

    #[test]
    fn push_token_owner_uses_verified_caller_not_requested_member() {
        assert_eq!(
            resolve_push_token_owner(Some(caller("alice")), Some("alice")),
            Ok(Some("alice".to_owned()))
        );
        assert_eq!(
            resolve_push_token_owner(Some(caller("alice")), Some("bob")),
            Err(StatusCode::FORBIDDEN)
        );
    }

    /// The anonymous branch depends on the node's org-binding — a process-global read
    /// that a sibling test (`control_plane`) mutates. Assert only against the binding
    /// state observed at call time so this stays deterministic under parallel runs.
    #[test]
    fn anonymous_viewer_matches_node_binding() {
        let bound = crate::sidecar::control_plane::registered_org().is_some();
        let with_id = resolve_viewer(None, Some("alice"));
        let without_id = resolve_viewer(None, None);
        if bound {
            // Org-bound node: a member feed is never readable unauthenticated.
            assert_eq!(with_id, Err(StatusCode::UNAUTHORIZED));
            assert_eq!(without_id, Err(StatusCode::UNAUTHORIZED));
        } else {
            // Unbound local (single-user) node: trust the requested id, but an absent
            // id is a 400 (the surface must name whose feed it wants).
            assert_eq!(with_id, Ok("alice".to_owned()));
            assert_eq!(without_id, Err(StatusCode::BAD_REQUEST));
        }
    }

    /// The list query defaults an absent `limit`/`user_id` and the handler clamps
    /// `limit` into `[1, MAX_LIMIT]` — a caller cannot request an unbounded page.
    #[test]
    fn list_query_defaults_and_limit_clamps() {
        let q: ListQuery = serde_json::from_value(json!({})).unwrap();
        assert!(q.user_id.is_none());
        assert!(q.limit.is_none());

        // The handler's clamp: `q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)`.
        assert_eq!(0i64.clamp(1, MAX_LIMIT), 1);
        assert_eq!(10_000i64.clamp(1, MAX_LIMIT), MAX_LIMIT);
        assert_eq!((-5i64).clamp(1, MAX_LIMIT), 1);
        assert_eq!(DEFAULT_LIMIT.clamp(1, MAX_LIMIT), DEFAULT_LIMIT);
    }

    #[test]
    fn mention_targets_payload_preserves_member_avatar_data() {
        let payload =
            mention_targets_payload(vec![crate::sidecar::control_plane::NotifyTargetUser {
                email: Some("ada@example.test".to_owned()),
                image: Some("https://cdn.example.test/ada.webp".to_owned()),
                name: Some("Ada Lovelace".to_owned()),
                role: Some("member".to_owned()),
                user_id: "user-ada".to_owned(),
            }]);
        assert_eq!(
            payload,
            json!({
                "users": [{
                    "email": "ada@example.test",
                    "image": "https://cdn.example.test/ada.webp",
                    "name": "Ada Lovelace",
                    "role": "member",
                    "userId": "user-ada",
                }]
            })
        );
    }
}
