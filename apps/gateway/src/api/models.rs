use axum::{extract::State, Json};
use serde_json::{json, Value};

use crate::{router::builtin_model_list, state::SharedState};

pub async fn list_models(State(_state): State<SharedState>) -> Json<Value> {
    let models = builtin_model_list();
    Json(json!({
        "object": "list",
        "data": models,
    }))
}
