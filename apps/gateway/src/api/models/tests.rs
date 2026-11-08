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
