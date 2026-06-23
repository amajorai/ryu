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
