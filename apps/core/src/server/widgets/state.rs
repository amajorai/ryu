//! `POST /api/widgets/state`: the server-side `widgetState` snapshot.

use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{err_reply, store};
use crate::server::ServerState;

/// Maximum serialized size retained for a client-supplied widget state.
pub(super) const WIDGET_STATE_MAX_BYTES: usize = 64 * 1024;
/// Maximum number of nested JSON containers retained for a widget state.
pub(super) const WIDGET_STATE_MAX_DEPTH: usize = 32;

pub(crate) fn validate_widget_state(state: &Value) -> Result<(), &'static str> {
    let serialized = serde_json::to_vec(state).map_err(|_| "widget state is not valid JSON")?;
    if serialized.len() > WIDGET_STATE_MAX_BYTES {
        return Err("widget state exceeds the maximum serialized size");
    }

    let mut pending = vec![(state, 0usize)];
    while let Some((value, depth)) = pending.pop() {
        if depth > WIDGET_STATE_MAX_DEPTH {
            return Err("widget state exceeds the maximum nesting depth");
        }
        match value {
            Value::Array(values) => pending.extend(values.iter().map(|value| (value, depth + 1))),
            Value::Object(values) => {
                pending.extend(values.values().map(|value| (value, depth + 1)))
            }
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
        }
    }

    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct WidgetStateBody {
    #[serde(rename = "instanceId", alias = "instance_id")]
    instance_id: String,
    state: Value,
}

/// `POST /api/widgets/state` — persist a `widgetState` snapshot server-side (D4)
/// so it survives reload. Best-effort; unknown/expired instances are a no-op.
#[utoipa::path(
    post,
    path = "/api/widgets/state",
    tag = "Widgets",
    summary = "persist a `widgetState` snapshot server-side (D4)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn widget_state(
    State(_state): State<ServerState>,
    Json(body): Json<WidgetStateBody>,
) -> axum::response::Response {
    if store().get(&body.instance_id).is_none() {
        return err_reply(
            StatusCode::NOT_FOUND,
            "not_found",
            "unknown or expired widget instance",
        );
    }
    if let Err(message) = validate_widget_state(&body.state) {
        return err_reply(StatusCode::BAD_REQUEST, "invalid_args", message);
    }
    store().set_state(&body.instance_id, body.state);
    Json(json!({ "ok": true })).into_response()
}
