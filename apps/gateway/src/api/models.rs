use std::{
    collections::HashSet,
    sync::OnceLock,
    time::{Duration, Instant},
};

use axum::{extract::State, Json};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::{router::builtin_model_list, state::SharedState};

/// How long a discovered `/v1/models` result is served from memory before the
/// next call re-probes upstream providers. Short enough that a newly-pulled
/// local model shows up quickly; long enough that a burst of client calls does
/// not hammer every upstream `/models` endpoint.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// Process-wide cache of the merged model list. `None` until the first call.
/// A `tokio::sync::Mutex` so the short critical section can be held across the
/// (fast) clone without blocking the async runtime.
static MODELS_CACHE: OnceLock<Mutex<Option<(Instant, Vec<Value>)>>> = OnceLock::new();

/// `GET /v1/models` — discovery-first with static fallback.
///
/// Concurrently probes every configured OpenAI-compatible upstream's
/// `GET {base}/models`, merges the discovered ids with the static
/// [`builtin_model_list`] (discovered entries win on id collisions), and caches
/// the result for [`CACHE_TTL`]. Any provider whose discovery errors, times out,
/// or has no discovery endpoint simply contributes nothing, so its static
/// entries remain; if *all* discovery fails the response is the builtin list
/// unchanged. Never returns an error to the caller.
pub async fn list_models(State(state): State<SharedState>) -> Json<Value> {
    let models = cached_or_discover(&state).await;
    Json(json!({
        "object": "list",
        "data": models,
    }))
}

async fn cached_or_discover(state: &SharedState) -> Vec<Value> {
    let cell = MODELS_CACHE.get_or_init(|| Mutex::new(None));

    {
        let guard = cell.lock().await;
        if let Some((cached_at, models)) = guard.as_ref() {
            if cached_at.elapsed() < CACHE_TTL {
                return models.clone();
            }
        }
    }

    let merged = discover_and_merge(state).await;

    let mut guard = cell.lock().await;
    *guard = Some((Instant::now(), merged.clone()));
    merged
}

/// Probe every configured provider concurrently and merge the discovered models
/// with the static fallback list, deduped by `id` (discovery-first).
async fn discover_and_merge(state: &SharedState) -> Vec<Value> {
    let ids = state.providers.available_providers();
    let probes = ids
        .iter()
        .filter_map(|id| state.providers.get(id))
        .map(|provider| provider.discover_models());
    let results = futures_util::future::join_all(probes).await;
    let discovered: Vec<Vec<Value>> = results.into_iter().flatten().collect();
    merge_models(discovered, builtin_model_list())
}

/// Merge per-provider discovered model lists with the static fallback, deduped
/// by `id`. Discovery-first: discovered entries win on id collisions, and the
/// builtin list only fills ids discovery did not surface. When `discovered` is
/// empty (all discovery failed / no discovery endpoints) the result is `builtin`
/// unchanged.
fn merge_models(discovered: Vec<Vec<Value>>, builtin: Vec<Value>) -> Vec<Value> {
    let mut merged: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for models in discovered {
        for model in models {
            if let Some(id) = model.get("id").and_then(Value::as_str) {
                if seen.insert(id.to_string()) {
                    merged.push(normalize_model(model));
                }
            }
        }
    }

    for model in builtin {
        if let Some(id) = model.get("id").and_then(Value::as_str) {
            if seen.insert(id.to_string()) {
                merged.push(model);
            }
        }
    }

    merged
}

/// Ensure a discovered model entry carries `object: "model"`, which some
/// OpenAI-compatible upstreams omit. Leaves all other fields untouched.
fn normalize_model(mut model: Value) -> Value {
    if let Some(obj) = model.as_object_mut() {
        obj.entry("object")
            .or_insert_with(|| Value::String("model".to_string()));
    }
    model
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_adds_missing_object_field() {
        let out = normalize_model(json!({ "id": "gpt-x" }));
        assert_eq!(out["object"], json!("model"));
        assert_eq!(out["id"], json!("gpt-x"));
    }

    #[test]
    fn normalize_preserves_existing_object_field() {
        let out = normalize_model(json!({ "id": "m", "object": "model", "owned_by": "x" }));
        assert_eq!(out["object"], json!("model"));
        assert_eq!(out["owned_by"], json!("x"));
    }

    fn ids(models: &[Value]) -> Vec<String> {
        models
            .iter()
            .map(|m| m["id"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    #[test]
    fn all_discovery_failed_returns_builtin_unchanged() {
        let builtin = builtin_model_list();
        let merged = merge_models(Vec::new(), builtin.clone());
        assert_eq!(merged, builtin);
    }

    #[test]
    fn discovered_models_are_merged_and_deduped_discovery_first() {
        let discovered = vec![
            vec![
                json!({ "id": "live-model-a", "owned_by": "upstream" }),
                json!({ "id": "gpt-4o", "object": "model", "owned_by": "upstream" }),
            ],
            vec![json!({ "id": "live-model-b" })],
        ];
        let builtin = vec![
            json!({ "id": "gpt-4o", "object": "model", "owned_by": "openai" }),
            json!({ "id": "static-only", "object": "model", "owned_by": "openai" }),
        ];
        let merged = merge_models(discovered, builtin);
        let merged_ids = ids(&merged);

        // Live-only ids present, static-only id retained, no duplicate gpt-4o.
        assert!(merged_ids.contains(&"live-model-a".to_string()));
        assert!(merged_ids.contains(&"live-model-b".to_string()));
        assert!(merged_ids.contains(&"static-only".to_string()));
        assert_eq!(merged_ids.iter().filter(|id| *id == "gpt-4o").count(), 1);

        // Discovery-first: the gpt-4o entry is the discovered one.
        let gpt = merged
            .iter()
            .find(|m| m["id"] == json!("gpt-4o"))
            .expect("gpt-4o present");
        assert_eq!(gpt["owned_by"], json!("upstream"));
        // Discovered entry missing `object` got normalized.
        let a = merged
            .iter()
            .find(|m| m["id"] == json!("live-model-a"))
            .expect("live-model-a present");
        assert_eq!(a["object"], json!("model"));
    }
}
