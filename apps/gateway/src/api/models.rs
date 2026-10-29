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
    // Ryu's own-supply slots are never listed: their ids name the supplier
    // (`owned_by: "bedrock"`) and their models are reached as Ryu Router ids,
    // which own-supply routing serves from these slots when free credit pays.
    if crate::credit_pools::pool_for_gateway_provider(id)
        .is_some_and(crate::credit_pools::is_own_supply_pool)
    {
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
mod tests {
    use super::*;

    #[test]
    fn sdk_catalog_keeps_executable_qualified_owners_and_implemented_modalities() {
        let models = merge_models(
            Vec::new(),
            builtin_model_list(),
            &[
                "openai".to_owned(),
                "genai-openai".to_owned(),
                "genai-openai-resp".to_owned(),
            ],
        );
        for (id, owner) in [
            ("gpt-4o", "openai"),
            ("openai::gpt-4o", "genai-openai"),
            ("openai_resp::gpt-4o", "genai-openai-resp"),
        ] {
            let row = models.iter().find(|row| row["id"] == id).unwrap();
            assert_eq!(row["owned_by"], owner);
        }
        assert!(!models
            .iter()
            .any(|row| row["owned_by"] == "genai-openai" && row["modality"] != "chat"));
        let sdk_only = merge_models(
            Vec::new(),
            builtin_model_list(),
            &["genai-openai".to_owned()],
        );
        assert!(sdk_only
            .iter()
            .all(|row| row["id"].as_str().unwrap().starts_with("openai::")
                && row["owned_by"] == "genai-openai"));
    }

    #[test]
    fn pool_model_aliases_are_discoverable_after_restart() {
        let mut routing = crate::config::RoutingConfig::default();
        routing.model_map.insert(
            "balanced-chat".to_owned(),
            crate::config::ModelMapping {
                provider: crate::config::ProviderId::from("pool:balanced"),
                provider_model: None,
            },
        );
        let models = append_pool_alias_models(Vec::new(), &routing);
        assert_eq!(models[0]["id"], "balanced-chat");
        assert_eq!(models[0]["owned_by"], "pool:balanced");
        assert_eq!(append_pool_alias_models(models.clone(), &routing), models);
        let collided = append_pool_alias_models(
            vec![json!({"id":"balanced-chat","object":"model","owned_by":"openai"})],
            &routing,
        );
        assert_eq!(collided.len(), 1);
        assert_eq!(collided[0]["owned_by"], "pool:balanced");
    }

    #[test]
    fn topaz_catalog_uses_discovery_without_a_static_fallback() {
        let available = vec!["topaz".to_owned()];
        let missing = merge_models(Vec::new(), builtin_model_list(), &available);
        assert!(missing.is_empty());
        let discovered = merge_models(
            vec![vec![json!({
                "id": "apo-8",
                "object": "model",
                "owned_by": "topaz",
                "modality": "video"
            })]],
            builtin_model_list(),
            &available,
        );
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0]["id"], "apo-8");
        assert_eq!(discovered[0]["modality"], "video");
    }

    #[tokio::test]
    async fn concurrent_cold_and_expired_calls_share_discovery() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let cache = ModelCache::default();
        let calls = AtomicUsize::new(0);
        for expected_calls in 1..=2 {
            let results = futures_util::future::join_all((0..24).map(|_| {
                cache.get_or_discover(async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                    vec![json!({ "id": "local-model" })]
                })
            }))
            .await;
            assert_eq!(calls.load(Ordering::SeqCst), expected_calls);
            assert!(results.iter().all(|models| models == &results[0]));
            cache.0.lock().await.as_mut().unwrap().0 = Instant::now() - CACHE_TTL;
        }
    }

    #[tokio::test]
    async fn model_cache_does_not_cross_gateway_states() {
        let first = ModelCache::default();
        let second = ModelCache::default();
        assert_eq!(
            first.get_or_discover(async { vec![json!("first")] }).await,
            vec![json!("first")]
        );
        assert_eq!(
            second
                .get_or_discover(async { vec![json!("second")] })
                .await,
            vec![json!("second")]
        );
    }

    #[tokio::test]
    async fn cancelled_discovery_leaves_cache_available_for_retry() {
        let cache = ModelCache::default();
        assert!(tokio::time::timeout(
            Duration::from_millis(5),
            cache.get_or_discover(std::future::pending()),
        )
        .await
        .is_err());
        assert_eq!(
            cache.get_or_discover(async { vec![json!("retry")] }).await,
            vec![json!("retry")]
        );
    }

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
        let mut available = [
            "openai",
            "anthropic",
            "local",
            "openrouter",
            "core",
            "genai",
            "assemblyai",
            "inworld",
            "qwen",
            "edge-tts",
            "google-tts",
            "polly",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
        let translate_index = builtin
            .iter()
            .position(|model| model["id"] == "google-translate-tts")
            .expect("anonymous Translate model exists in the static catalog");
        let mut expected_disabled = builtin.clone();
        expected_disabled.remove(translate_index);
        let merged = merge_models(Vec::new(), builtin.clone(), &available);
        assert_eq!(merged, expected_disabled);
        available.push("google-translate-tts".to_owned());
        let enabled = merge_models(Vec::new(), builtin.clone(), &available);
        assert_eq!(enabled, builtin);
    }

    #[test]
    fn static_models_only_include_registered_providers() {
        let available = vec!["local".to_owned()];
        let merged = merge_models(Vec::new(), builtin_model_list(), &available);
        let ids = ids(&merged);
        assert!(ids.iter().all(|id| {
            matches!(
                id.as_str(),
                "llama3.2:latest" | "mistral:latest" | "phi4:latest" | "deepseek-r1:latest"
            )
        }));
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn configured_genai_exposes_only_its_supported_static_image_models() {
        let models = merge_models(Vec::new(), builtin_model_list(), &["genai".to_owned()]);
        assert_eq!(
            ids(&models),
            vec!["gemini-2.5-flash-image", "gemini-3.1-flash-image"]
        );
        assert!(models.iter().all(|model| model["modality"] == "image"));
    }

    #[test]
    fn configured_assemblyai_exposes_its_stt_models() {
        let models = merge_models(Vec::new(), builtin_model_list(), &["assemblyai".to_owned()]);
        assert_eq!(ids(&models), vec!["universal-3-pro", "universal-2"]);
        assert!(models.iter().all(|model| model["modality"] == "stt"));
    }

    #[test]
    fn opted_in_edge_exposes_only_tts_and_disabled_edge_is_absent() {
        let models = merge_models(Vec::new(), builtin_model_list(), &["edge-tts".to_owned()]);
        assert_eq!(ids(&models), vec!["edge-tts"]);
        assert_eq!(models[0]["modality"], "tts");
        assert!(merge_models(Vec::new(), builtin_model_list(), &[]).is_empty());
    }

    #[test]
    fn configured_inworld_exposes_only_its_tts_models() {
        let models = merge_models(Vec::new(), builtin_model_list(), &["inworld".to_owned()]);
        assert_eq!(ids(&models), vec!["inworld-tts-2", "inworld-tts-2-flash"]);
        assert!(models.iter().all(|model| model["modality"] == "tts"));
    }

    #[test]
    fn classify_is_not_published_as_a_public_model_provider() {
        assert!(!is_public_discovery_provider("classify"));
        assert!(is_public_discovery_provider("local"));
        assert!(is_public_discovery_provider("openrouter"));
        // Own-supply slots name their supplier: never listed.
        for slot in [
            "cloudflare",
            "bedrock",
            "vertex",
            "openai-credits",
            "anthropic-credits",
        ] {
            assert!(!is_public_discovery_provider(slot), "{slot}");
        }
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
        let available = ["openai", "upstream"]
            .into_iter()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let merged = merge_models(discovered, builtin, &available);
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
