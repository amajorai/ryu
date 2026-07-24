use axum::{extract::State, Json};
use serde_json::{json, Value};

use crate::state::SharedState;

pub async fn health(State(state): State<SharedState>) -> Json<Value> {
    let providers = state.providers.available_providers();
    let provider_names: Vec<&str> = providers.iter().map(|p| p.as_str()).collect();

    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "providers": provider_names,
        "auth_required": state.config.auth.require_auth,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;

    #[tokio::test]
    async fn health_reports_ok_version_and_auth_flag() {
        let state = Arc::new(AppState::new_for_test_default());
        let Json(body) = health(State(state)).await;
        assert_eq!(body["status"], "ok");
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        // Default test config requires no auth and registers no providers.
        assert_eq!(body["auth_required"], false);
        assert_eq!(body["providers"].as_array().unwrap().len(), 0);
    }
}
