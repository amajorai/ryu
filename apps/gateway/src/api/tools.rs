use axum::{extract::State, http::StatusCode, Json};
use serde_json::{json, Value};

use crate::state::SharedState;

/// GET /v1/tools/composio
///
/// Returns the list of Composio action names configured in the gateway
/// allowlist. This endpoint passes through standard auth (master-key or
/// API-key) so callers can discover which actions are available before
/// constructing a chat request.
///
/// When Composio is disabled or no actions are configured the response is
/// an empty list (not a 404) so the caller can distinguish "no actions
/// allowed" from "endpoint missing."
pub async fn list_composio_tools(State(state): State<SharedState>) -> (StatusCode, Json<Value>) {
    let actions: Vec<Value> = match &state.composio {
        Some(composio) => composio
            .actions()
            .iter()
            .map(|name| {
                json!({
                    "name": name,
                    "type": "composio",
                    "description": format!(
                        "Composio action '{}'. Invoked automatically when the model \
                         emits a tool_call with this name.",
                        name
                    )
                })
            })
            .collect(),
        None => vec![],
    };

    let body = json!({
        "object": "list",
        "data": actions,
        "composio_enabled": state.composio.is_some(),
    });

    (StatusCode::OK, Json(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;

    #[tokio::test]
    async fn empty_list_when_composio_disabled_not_a_404() {
        let state = Arc::new(AppState::new_for_test_default());
        let (status, Json(body)) = list_composio_tools(State(state)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["object"], "list");
        assert_eq!(body["composio_enabled"], false);
        assert_eq!(body["data"].as_array().unwrap().len(), 0);
    }
}
