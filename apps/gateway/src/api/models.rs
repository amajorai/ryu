use std::{
    collections::{HashMap, HashSet},
    future::Future,
    time::{Duration, Instant},
};

use axum::{extract::State, http::HeaderMap, Json};
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::{error::GatewayError, router::builtin_model_list, state::SharedState};

/// How long a discovered `/v1/models` result is served from memory before the
/// next call re-probes upstream providers. Short enough that a newly-pulled
/// local model shows up quickly; long enough that a burst of client calls does
/// not hammer every upstream `/models` endpoint.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// One cache per immutable provider snapshot. Late discoveries remain isolated.
#[derive(Default)]
pub(crate) struct ModelCache(Mutex<Option<(Instant, Vec<Value>)>>);

impl ModelCache {
    pub(crate) async fn get_or_discover(
        &self,
        discover: impl Future<Output = Vec<Value>>,
    ) -> Vec<Value> {
        let mut guard = self.0.lock().await;
        if let Some((cached_at, models)) = guard.as_ref() {
            if cached_at.elapsed() < CACHE_TTL {
                return models.clone();
            }
        }
        // The async mutex covers discovery so cold/expired bursts do not probe
        // every upstream once per caller. Cancellation releases it for a retry.
        let merged = discover.await;
        *guard = Some((Instant::now(), merged.clone()));
        merged
    }
}

/// `GET /v1/models` â€” discovery-first with static fallback.
///
/// Concurrently probes every configured public OpenAI-compatible upstream's
/// `GET {base}/models`, merges the discovered ids with the static
/// [`builtin_model_list`] (discovered entries win on id collisions), and caches
/// the result for [`CACHE_TTL`]. Any provider whose discovery errors, times out,
/// or has no discovery endpoint simply contributes nothing, so its static
/// entries remain only when that provider is configured; if *all* discovery
/// fails the response is the configured-provider subset of the builtin list.
/// The internal `classify` tier is never published.
///
/// Authenticated like inference when `require_auth` is on: the list can include
/// private fine-tune ids, and a cold cache makes the Gateway call every upstream
/// `/models` endpoint with the operator's provider keys. In no-auth (local dev)
/// mode an anonymous caller still matches, so that behavior is unchanged.
/// Discovery itself never fails the request.
pub async fn list_models(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Result<Json<Value>, GatewayError> {
    let raw_key = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    crate::pipeline::authenticate(&state, crate::pipeline::AuthInputs::with_key(raw_key)).await?;
    let models = cached_or_discover(&state).await;
    Ok(Json(json!({
        "object": "list",
        "data": models,
    })))
}

async fn cached_or_discover(state: &SharedState) -> Vec<Value> {
    let snapshot = state.provider_runtime.snapshot();
    snapshot
        .models_cache
        .get_or_discover(discover_and_merge(&snapshot))
        .await
}

/// Probe every configured provider concurrently and merge the discovered models
/// with the static fallback list, deduped by `id` (discovery-first).
async fn discover_and_merge(snapshot: &crate::providers::ProviderSnapshot) -> Vec<Value> {
    let ids = snapshot.providers.available_providers();
    let owners: Vec<_> = ids
        .iter()
        .filter(|id| is_public_discovery_provider(id))
        .filter(|id| snapshot.providers.get(id).is_some())
        .collect();
    let probes = owners
        .iter()
        .filter_map(|id| snapshot.providers.get(id))
        .map(|provider| provider.discover_models());
    let results = futures_util::future::join_all(probes).await;
    let discovered: Vec<Vec<Value>> = results
        .into_iter()
        .zip(owners)
        .filter_map(|(models, owner)| models.map(|models| (models, owner)))
        .map(|(models, owner)| {
            models
                .into_iter()
                .filter_map(|mut model| {
                    if let Some(descriptor) = ryu_gw_credentials::sdk_provider_by_id(owner) {
                        let id = model.get("id").and_then(Value::as_str)?;
                        if ryu_gw_providers::sdk_descriptor_for_model(id)
                            .is_some_and(|resolved| resolved.kind != descriptor.kind)
                            && id.contains("::")
                        {
                            return None;
                        }
                        if !id.contains("::") && descriptor.kind != "gemini" {
                            model["id"] = Value::String(format!("{}::{id}", descriptor.kind));
                        }
                        model["modality"] = Value::String("chat".to_owned());
                    }
                    model["owned_by"] = Value::String(owner.clone());
                    Some(model)
                })
                .collect()
        })
        .collect();
    append_pool_alias_models(
        merge_models(discovered, builtin_model_list(), &ids),
        &snapshot.routing,
    )
}

fn append_pool_alias_models(
    mut models: Vec<Value>,
    routing: &crate::config::RoutingConfig,
) -> Vec<Value> {
    let mut positions: HashMap<String, usize> = models
        .iter()
        .enumerate()
        .filter_map(|(index, model)| {
            model
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_owned(), index))
        })
        .collect();
    let mut aliases: Vec<_> = routing
        .model_map
        .iter()
        .filter(|(_, mapping)| mapping.provider.as_str().starts_with("pool:"))
        .collect();
    aliases.sort_by_key(|(alias, _)| *alias);
    for (alias, mapping) in aliases {
        let entry = json!({
            "id": alias,
            "object": "model",
            "owned_by": mapping.provider.as_str(),
        });
        if let Some(index) = positions.get(alias) {
            models[*index] = entry;
        } else {
            positions.insert(alias.clone(), models.len());
            models.push(entry);
        }
    }
    models
}

fn is_public_discovery_provider(id: &str) -> bool {
    if ryu_gw_credentials::web::web_provider_by_id(id).is_some() {
        return false;
    }
    // Ryu-held slots (own supply, and retired Bedrock) are never listed: their
    // ids name the supplier (`owned_by: "bedrock"`) and their models are reached
    // as Ryu Router ids, which own-supply routing serves when free credit pays.
    if crate::credit_pools::is_ryu_held_slot(id) {
        return false;
    }
    id != "classify"
}

/// Merge per-provider discovered model lists with the static fallback, deduped
/// by `id` (discovery-first). Discovery-first: discovered entries win on id
/// collisions, and the builtin list only fills ids discovery did not surface for
/// providers that are actually registered. When `discovered` is empty (all
/// discovery failed / no discovery endpoints) the result is the configured-
/// provider subset of `builtin`.
fn merge_models(
    discovered: Vec<Vec<Value>>,
    builtin: Vec<Value>,
    available_providers: &[String],
) -> Vec<Value> {
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
        // Publish SDK chat aliases with executable namespaces and separate owners.
        // Native service rows cannot imply unimplemented SDK speech/embedding support.
        let source_owner = model.get("owned_by").and_then(Value::as_str);
        let is_chat = model
            .get("modality")
            .and_then(Value::as_str)
            .is_none_or(|modality| modality == "chat");
        if is_chat {
            for descriptor in ryu_gw_credentials::SDK_PROVIDERS
                .iter()
                .filter(|descriptor| {
                    source_owner == Some(descriptor.brand)
                        && matches!(descriptor.kind, "openai" | "openai_resp" | "anthropic")
                })
            {
                if available_providers
                    .iter()
                    .any(|id| id == descriptor.provider_id)
                {
                    if let Some(id) = model.get("id").and_then(Value::as_str) {
                        let qualified = format!("{}::{id}", descriptor.kind);
                        if seen.insert(qualified.clone()) {
                            let mut sdk_model = model.clone();
                            sdk_model["id"] = Value::String(qualified);
                            sdk_model["owned_by"] =
                                Value::String(descriptor.provider_id.to_owned());
                            sdk_model["modality"] = Value::String("chat".to_owned());
                            merged.push(sdk_model);
                        }
                    }
                }
            }
        }
        if let Some(id) = model.get("id").and_then(Value::as_str) {
            let provider = model.get("owned_by").and_then(Value::as_str);
            if provider.is_some_and(|provider| {
                available_providers
                    .iter()
                    .any(|available| available == provider)
            }) && seen.insert(id.to_string())
            {
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
mod tests;
