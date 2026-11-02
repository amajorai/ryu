//! Mobile push-token registration (`/api/notifications/push-tokens`).
//!
//! Expo push tokens are kernel notification-delivery state (used by the app-inbox
//! deliver, monitor alerts, and approval pings), so registration is served here on
//! the notify surface — NOT on the monitors router (which is moving out-of-process).
//! Relocated from `/api/monitors/push-tokens`.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Extension, Json,
};
use serde::Deserialize;
use serde_json::json;

use super::{error_reply, resolve_viewer, store_not_ready};
use crate::identity_verify::VerifiedCaller;
use crate::server::ServerState;

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
    /// Whether this device wants an "agent finished" push when one of its
    /// owner's conversations completes. Omitted by older app builds, which
    /// leaves the stored choice unchanged (new rows default to off).
    #[serde(default)]
    pub run_finished: Option<bool>,
    /// The app's UI language (a BCP 47 tag such as `de` or `pt-BR`), so pushes
    /// to this device are rendered in it. Omitted by older app builds, which
    /// leaves the stored locale unchanged (those devices get the node's
    /// language); a blank or malformed tag clears it.
    #[serde(default)]
    pub locale: Option<String>,
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
        return store_not_ready();
    };
    let user_id = match resolve_push_token_owner(caller, body.user_id.as_deref()) {
        Ok(user_id) => user_id,
        Err(code) => return error_reply(code, "unauthorized"),
    };
    match store
        .register_push_token(&body.token, body.platform.as_deref(), user_id.as_deref())
        .await
    {
        Ok(true) => {}
        Ok(false) => {
            return error_reply(StatusCode::CONFLICT, "push token belongs to another member")
        }
        Err(e) => return error_reply(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
    if let Some(locale) = body.locale.as_deref() {
        if let Err(e) = store
            .set_push_token_locale(&body.token, user_id.as_deref(), Some(locale))
            .await
        {
            return error_reply(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
    }
    let Some(enabled) = body.run_finished else {
        return (StatusCode::OK, Json(json!({ "ok": true })));
    };
    match store
        .set_push_token_run_finished(&body.token, user_id.as_deref(), enabled)
        .await
    {
        // Echoing the stored choice tells the app this node sends
        // "agent finished" pushes, so it can skip its own local alert.
        Ok(_) => (
            StatusCode::OK,
            Json(json!({ "ok": true, "run_finished": enabled })),
        ),
        Err(e) => error_reply(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
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
        return store_not_ready();
    };
    let result = if let Some(caller) = caller {
        match resolve_viewer(Some(caller), None) {
            Ok(user_id) => store.remove_push_token_for_user(&token, &user_id).await,
            Err(code) => return error_reply(code, "unauthorized"),
        }
    } else if crate::sidecar::control_plane::registered_org().is_some() {
        return error_reply(StatusCode::UNAUTHORIZED, "verified caller required");
    } else {
        // An unbound node is the legacy single-user/local flow. There is no
        // second member whose token could be deleted there, so retain the
        // node-level operation for anonymous local clients.
        store.remove_push_token(&token).await
    };
    match result {
        Ok(true) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Ok(false) => error_reply(StatusCode::NOT_FOUND, "token not found"),
        Err(e) => error_reply(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// Resolve the owner stamped on a push-token row. On an org-bound node this
/// always uses the verified caller and rejects a body-supplied other member;
/// on an unbound local node, anonymous registration may retain its legacy
/// node-wide (`NULL`) owner.
pub(super) fn resolve_push_token_owner(
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
