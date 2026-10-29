use super::*;
use std::ffi::OsString;
use std::sync::Mutex;
use tempfile::tempdir;

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn replace_env(name: &str, value: Option<&str>) -> Option<OsString> {
    let previous = std::env::var_os(name);
    match value {
        Some(value) => std::env::set_var(name, value),
        None => std::env::remove_var(name),
    }
    previous
}

fn restore_env(name: &str, previous: Option<OsString>) {
    match previous {
        Some(value) => std::env::set_var(name, value),
        None => std::env::remove_var(name),
    }
}

#[test]
fn config_file_is_optional_and_uses_config_dir_path() {
    assert!(path().ends_with(CONFIG_FILE_NAME));
}

#[test]
fn scalar_and_array_values_convert_to_process_env_strings() {
    assert_eq!(
        value_to_env(&Value::Bool(true)).unwrap(),
        Some("true".into())
    );
    assert_eq!(value_to_env(&Value::from(5)).unwrap(), Some("5".into()));
    assert_eq!(
        value_to_env(&serde_json::json!(["a", 2, true])).unwrap(),
        Some("a,2,true".into())
    );
}

#[test]
fn friendly_settings_map_to_legacy_names() {
    let mut flattened = BTreeMap::new();
    flatten_settings(
        &["models".to_owned()],
        &serde_json::json!({
            "defaultLlm": {"model": "gpt-4o-mini"},
            "embedding": {"model": "nomic-embed"}
        }),
        &mut flattened,
    )
    .unwrap();
    assert_eq!(
        flattened.get("RYU_DEFAULT_LLM_MODEL"),
        Some(&Value::String("gpt-4o-mini".to_owned()))
    );
    assert_eq!(
        flattened.get("RYU_EMBED_MODEL"),
        Some(&Value::String("nomic-embed".to_owned()))
    );
}

#[test]
fn config_applies_non_secret_values_but_preserves_explicit_env() {
    let _guard = ENV_LOCK.lock().unwrap();
    let dir = tempdir().unwrap();
    let file = dir.path().join(CONFIG_FILE_NAME);
    std::fs::write(
        &file,
        serde_json::to_vec(&serde_json::json!({
            "version": CONFIG_VERSION,
            "settings": {
                "models": {"defaultLlm": {"model": "from-settings"}}
            },
            "overrides": {
                "RYU_NODE_NAME": "from-file",
                "RYU_CORS_ORIGINS": ["http://one", "http://two"],
                "RYU_DEFAULT_LLM_API_KEY": "must-not-load"
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let previous_name = replace_env("RYU_NODE_NAME", Some("from-env"));
    let previous_origins = replace_env("RYU_CORS_ORIGINS", None);
    let previous_model = replace_env("RYU_DEFAULT_LLM_MODEL", None);
    let previous_key = replace_env("RYU_DEFAULT_LLM_API_KEY", None);
    let report = load_from_path(&file).unwrap();
    assert_eq!(std::env::var("RYU_NODE_NAME").unwrap(), "from-env");
    assert_eq!(
        std::env::var("RYU_DEFAULT_LLM_MODEL").unwrap(),
        "from-settings"
    );
    assert_eq!(
        std::env::var("RYU_CORS_ORIGINS").unwrap(),
        "http://one,http://two"
    );
    assert!(std::env::var_os("RYU_DEFAULT_LLM_API_KEY").is_none());
    assert_eq!(report.applied, 2);
    assert_eq!(report.ignored_environment, 1);
    assert_eq!(report.ignored_reserved, 1);
    restore_env("RYU_NODE_NAME", previous_name);
    restore_env("RYU_DEFAULT_LLM_MODEL", previous_model);
    restore_env("RYU_CORS_ORIGINS", previous_origins);
    restore_env("RYU_DEFAULT_LLM_API_KEY", previous_key);
}

#[test]
fn config_rejects_non_ryu_overrides() {
    let _guard = ENV_LOCK.lock().unwrap();
    let dir = tempdir().unwrap();
    let file = dir.path().join(CONFIG_FILE_NAME);
    std::fs::write(
        &file,
        serde_json::to_vec(&serde_json::json!({
            "version": CONFIG_VERSION,
            "overrides": {"OPENAI_BASE_URL": "https://example.test"}
        }))
        .unwrap(),
    )
    .unwrap();

    let error = load_from_path(&file).unwrap_err().to_string();
    assert!(error.contains("only non-secret RYU_* settings are allowed"));
}
#[test]
fn lifecycle_discovery_uses_the_same_pi_override_normalization() {
    let _guard = ENV_LOCK.lock().unwrap();
    let dir = tempdir().unwrap();
    let file = dir.path().join(CONFIG_FILE_NAME);
    std::fs::write(&file, r#"{"version":1,"settings":{"pi":{"agentDir":"friendly"}},"overrides":{"RYU_PI_AGENT_DIR":"selected"}}"#).unwrap();
    let overrides = read_overrides(&file).unwrap();
    assert_eq!(
        value_to_env(overrides.get("RYU_PI_AGENT_DIR").unwrap()).unwrap(),
        Some("selected".into())
    );
    let previous = replace_env("RYU_PI_AGENT_DIR", None);
    assert_eq!(
        pi_agent_override_at(dir.path()).unwrap(),
        Some("selected".into())
    );
    std::env::set_var("RYU_PI_AGENT_DIR", "operator-selected");
    assert_eq!(
        pi_agent_override_at(dir.path()).unwrap(),
        Some("operator-selected".into())
    );
    restore_env("RYU_PI_AGENT_DIR", previous);
    std::fs::write(&file, "invalid").unwrap();
    assert!(read_overrides(&file).is_err());
}

#[test]
fn invalid_later_override_does_not_partially_apply_valid_settings() {
    let _guard = ENV_LOCK.lock().unwrap();
    let directory = tempdir().unwrap();
    let file = directory.path().join(CONFIG_FILE_NAME);
    let previous = replace_env("RYU_A_CONFIG_ATOMIC_TEST", None);
    for invalid in [
        serde_json::json!({"RYU_Z_CONFIG_ATOMIC_TEST": {"nested": "invalid"}}),
        serde_json::json!({"RYU_Z_CONFIG_ATOMIC_TEST": [["nested"]]}),
        serde_json::json!({"ZZ_INVALID_SETTING": "invalid"}),
    ] {
        let mut overrides = invalid.as_object().unwrap().clone();
        overrides.insert(
            "RYU_A_CONFIG_ATOMIC_TEST".to_owned(),
            Value::String("must-not-apply".to_owned()),
        );
        std::fs::write(
            &file,
            serde_json::to_vec(&serde_json::json!({"overrides": overrides})).unwrap(),
        )
        .unwrap();
        let result = load_from_path(&file);
        let changed = std::env::var_os("RYU_A_CONFIG_ATOMIC_TEST");
        std::env::remove_var("RYU_A_CONFIG_ATOMIC_TEST");
        assert!(result.is_err());
        assert!(
            changed.is_none(),
            "a rejected document partially changed process state"
        );
    }
    restore_env("RYU_A_CONFIG_ATOMIC_TEST", previous);
}

#[test]
fn exact_overrides_and_explicit_empty_environment_have_documented_precedence() {
    let _guard = ENV_LOCK.lock().unwrap();
    let directory = tempdir().unwrap();
    let file = directory.path().join(CONFIG_FILE_NAME);
    std::fs::write(
        &file,
        r#"{"settings":{"node":{"name":"friendly"}},"overrides":{"RYU_NODE_NAME":"exact"}}"#,
    )
    .unwrap();
    let previous = replace_env("RYU_NODE_NAME", None);
    let first = load_from_path(&file).unwrap();
    assert_eq!(std::env::var("RYU_NODE_NAME").unwrap(), "exact");
    assert_eq!(first.applied, 1);
    std::env::set_var("RYU_NODE_NAME", "");
    let second = load_from_path(&file).unwrap();
    assert_eq!(std::env::var("RYU_NODE_NAME").unwrap(), "");
    assert_eq!(second.applied, 0);
    assert_eq!(second.ignored_environment, 1);
    restore_env("RYU_NODE_NAME", previous);
}

#[test]
fn unsupported_version_and_oversize_configuration_are_rejected_before_loading() {
    let directory = tempdir().unwrap();
    let file = directory.path().join(CONFIG_FILE_NAME);
    std::fs::write(
        &file,
        r#"{"version":2,"overrides":{"RYU_NODE_NAME":"wrong-version"}}"#,
    )
    .unwrap();
    assert!(read_overrides(&file)
        .unwrap_err()
        .to_string()
        .contains("config version 2"));
    std::fs::write(&file, vec![b' '; MAX_CONFIG_BYTES as usize + 1]).unwrap();
    assert!(read_overrides(&file)
        .unwrap_err()
        .to_string()
        .contains("256 KiB limit"));
}

/// Every tunable that moved out of `apps/core/.env.example` into the node
/// config keeps working only while its documented grouped path flattens to the
/// exact name its reader uses. `docs/env-audit/core.md` lists the rows.
#[test]
fn documented_node_config_paths_reach_their_readers() {
    let cases: &[(&[&str], &str)] = &[
        (&["acp", "gatewayInject"], "RYU_ACP_GATEWAY_INJECT"),
        (
            &["agent", "egressAllowHosts"],
            "RYU_AGENT_EGRESS_ALLOW_HOSTS",
        ),
        (&["agent", "egressSsrfGuard"], "RYU_AGENT_EGRESS_SSRF_GUARD"),
        (&["audiocpp", "backend"], "RYU_AUDIOCPP_BACKEND"),
        (&["audiocpp", "device"], "RYU_AUDIOCPP_DEVICE"),
        (
            &["audiocpp", "maxLoadedModels"],
            "RYU_AUDIOCPP_MAX_LOADED_MODELS",
        ),
        (&["audiocpp", "sttModel"], "RYU_AUDIOCPP_STT_MODEL"),
        (&["audiocpp", "sttModelId"], "RYU_AUDIOCPP_STT_MODEL_ID"),
        (&["audiocpp", "threads"], "RYU_AUDIOCPP_THREADS"),
        (&["audiocpp", "ttsModel"], "RYU_AUDIOCPP_TTS_MODEL"),
        (&["audiocpp", "ttsModelId"], "RYU_AUDIOCPP_TTS_MODEL_ID"),
        (&["audiocpp", "ttsVoice"], "RYU_AUDIOCPP_TTS_VOICE"),
        (&["audiocpp", "ttsVoiceFile"], "RYU_AUDIOCPP_TTS_VOICE_FILE"),
        (&["rag", "autoRecall", "enabled"], "RYU_AUTO_RECALL_ENABLED"),
        (&["rag", "autoRecall", "topK"], "RYU_AUTO_RECALL_TOP_K"),
        (&["rag", "contextMaxTokens"], "RYU_CONTEXT_MAX_TOKENS"),
        (&["rag", "strategy"], "RYU_RAG_STRATEGY"),
        (
            &["rag", "vectorStore", "provider"],
            "RYU_RAG_VECTOR_STORE_PROVIDER",
        ),
        (&["btw", "model"], "RYU_BTW_MODEL"),
        (&["btw", "effort"], "RYU_BTW_EFFORT"),
        (
            &["chat", "checkpointMaxAgeDays"],
            "RYU_CHAT_CHECKPOINT_MAX_AGE_DAYS",
        ),
        (
            &["codex", "transcriptMaxAgeDays"],
            "RYU_CODEX_TRANSCRIPT_MAX_AGE_DAYS",
        ),
        (&["models", "defaultAgent"], "RYU_DEFAULT_AGENT"),
        (&["models", "defaultLlm", "model"], "RYU_DEFAULT_LLM_MODEL"),
        (
            &["diagnostics", "contentMode"],
            "RYU_DIAGNOSTICS_CONTENT_MODE",
        ),
        (
            &["diagnostics", "exportEnabled"],
            "RYU_DIAGNOSTICS_EXPORT_ENABLED",
        ),
        (
            &["diagnostics", "maxContentBytes"],
            "RYU_DIAGNOSTICS_MAX_CONTENT_BYTES",
        ),
        (&["downloads", "autoresume"], "RYU_DOWNLOADS_AUTORESUME"),
        (&["models", "embedding", "dims"], "RYU_EMBED_DIMS"),
        (&["models", "embedding", "model"], "RYU_EMBED_MODEL"),
        (&["models", "embedding", "provider"], "RYU_EMBED_PROVIDER"),
    ];
    for (path, expected) in cases {
        let path: Vec<String> = path.iter().map(|segment| (*segment).to_owned()).collect();
        assert_eq!(&friendly_path_to_env_name(&path), expected, "path {path:?}");
    }
}

/// The shipped example must only contain settings that reach a reader, so a
/// copied file never silently does nothing.
#[test]
fn shipped_example_flattens_without_reserved_names() {
    let example = include_str!("../../../../config/node-config.example.json");
    let config: NodeConfigFile = serde_json::from_str(example).unwrap();
    assert_eq!(config.version, CONFIG_VERSION);
    let mut flattened = BTreeMap::new();
    for (section, value) in config.settings {
        flatten_settings(&[section], &value, &mut flattened).unwrap();
    }
    for name in flattened.keys() {
        assert!(is_valid_override_name(name), "{name}");
        assert!(!is_reserved_or_secret(name), "{name}");
    }
    assert!(flattened.contains_key("RYU_AUTO_RECALL_ENABLED"));
    // The context cap is off by default, so the copyable example must not turn
    // trimming on.
    assert!(!flattened.contains_key("RYU_CONTEXT_MAX_TOKENS"));
}

/// The CONFIG rows of `docs/env-audit/core-2.md`: each documented grouped path
/// must flatten to the exact name its reader uses, or the file setting would
/// silently do nothing.
#[test]
fn core_2_node_config_paths_reach_their_readers() {
    let cases: &[(&str, &str)] = &[
        ("models.fallbackLlm.baseUrl", "RYU_FALLBACK_LLM_BASE_URL"),
        ("models.fallbackLlm.model", "RYU_FALLBACK_LLM_MODEL"),
        ("fts.recallEnabled", "RYU_FTS_RECALL_ENABLED"),
        ("ghost.releaseUrl", "RYU_GHOST_RELEASE_URL"),
        ("gif.provider", "RYU_GIF_PROVIDER"),
        ("github.topicApp", "RYU_GITHUB_TOPIC_APP"),
        (
            "github.topicCacheTtlSecs",
            "RYU_GITHUB_TOPIC_CACHE_TTL_SECS",
        ),
        ("github.topicMarketplace", "RYU_GITHUB_TOPIC_MARKETPLACE"),
        ("github.topicPlugin", "RYU_GITHUB_TOPIC_PLUGIN"),
        ("graph.extractionModel", "RYU_GRAPH_EXTRACTION_MODEL"),
        ("headroom.managed", "RYU_HEADROOM_MANAGED"),
        ("headroom.url", "RYU_HEADROOM_URL"),
        ("hosted.mcpIndexUrl", "RYU_HOSTED_MCP_INDEX_URL"),
        ("identity.defaultSource", "RYU_IDENTITY_DEFAULT_SOURCE"),
        ("identity.healthInterval", "RYU_IDENTITY_HEALTH_INTERVAL"),
        ("image.tier", "RYU_IMAGE_TIER"),
        (
            "features.integrationsShApiUrl",
            "RYU_INTEGRATIONS_SH_API_URL",
        ),
        (
            "features.integrationsShCacheTtlSecs",
            "RYU_INTEGRATIONS_SH_CACHE_TTL_SECS",
        ),
        (
            "features.integrationsShRawOpenapiUrl",
            "RYU_INTEGRATIONS_SH_RAW_OPENAPI_URL",
        ),
        ("island.releaseUrl", "RYU_ISLAND_RELEASE_URL"),
        ("kokoro.modelUrl", "RYU_KOKORO_MODEL_URL"),
        ("kokoro.voicesUrl", "RYU_KOKORO_VOICES_URL"),
        ("learning.interval", "RYU_LEARNING_INTERVAL"),
        ("learning.synthModel", "RYU_LEARNING_SYNTH_MODEL"),
        ("local.chatModelId", "RYU_LOCAL_CHAT_MODEL_ID"),
        ("local.chatModelSha256", "RYU_LOCAL_CHAT_MODEL_SHA256"),
        ("local.chatModelUrl", "RYU_LOCAL_CHAT_MODEL_URL"),
        ("local.classifierModelId", "RYU_LOCAL_CLASSIFIER_MODEL_ID"),
        (
            "local.classifierModelSha256",
            "RYU_LOCAL_CLASSIFIER_MODEL_SHA256",
        ),
        ("local.classifierModelUrl", "RYU_LOCAL_CLASSIFIER_MODEL_URL"),
        ("models.localEmbedding.modelId", "RYU_LOCAL_EMBED_MODEL_ID"),
        (
            "models.localEmbedding.modelSha256",
            "RYU_LOCAL_EMBED_MODEL_SHA256",
        ),
        (
            "models.localEmbedding.modelUrl",
            "RYU_LOCAL_EMBED_MODEL_URL",
        ),
        ("local.guardModelId", "RYU_LOCAL_GUARD_MODEL_ID"),
        ("local.guardModelSha256", "RYU_LOCAL_GUARD_MODEL_SHA256"),
        ("local.guardModelUrl", "RYU_LOCAL_GUARD_MODEL_URL"),
        ("local.rerankerModelId", "RYU_LOCAL_RERANKER_MODEL_ID"),
        (
            "local.rerankerModelSha256",
            "RYU_LOCAL_RERANKER_MODEL_SHA256",
        ),
        ("local.rerankerModelUrl", "RYU_LOCAL_RERANKER_MODEL_URL"),
        ("local.speechModelId", "RYU_LOCAL_SPEECH_MODEL_ID"),
        ("local.speechModelSha256", "RYU_LOCAL_SPEECH_MODEL_SHA256"),
        ("local.speechModelUrl", "RYU_LOCAL_SPEECH_MODEL_URL"),
        ("marketplace.repo", "RYU_MARKETPLACE_REPO"),
        ("mcp.allowlist", "RYU_MCP_ALLOWLIST"),
        ("mcp.registryUrl", "RYU_MCP_REGISTRY_URL"),
        ("mesh.backend", "RYU_MESH_BACKEND"),
        ("mesh.enabled", "RYU_MESH_ENABLED"),
        ("mlx.model", "RYU_MLX_MODEL"),
        ("mlx.vlmModel", "RYU_MLX_VLM_MODEL"),
        ("mmproj.quant", "RYU_MMPROJ_QUANT"),
        ("needle2.libPath", "RYU_NEEDLE2_LIB_PATH"),
        ("needle3.libPath", "RYU_NEEDLE3_LIB_PATH"),
        ("needle3.weightsPath", "RYU_NEEDLE3_WEIGHTS_PATH"),
        ("node.screener", "RYU_NODE_SCREENER"),
        ("outetts.model", "RYU_OUTETTS_MODEL"),
        ("outetts.vocoder", "RYU_OUTETTS_VOCODER"),
        ("parakeet.modelUrl", "RYU_PARAKEET_MODEL_URL"),
        (
            "persistent.sandboxBackend",
            "RYU_PERSISTENT_SANDBOX_BACKEND",
        ),
        ("pi.autoUpdate", "RYU_PI_AUTO_UPDATE"),
        ("pi.transcriptMaxAgeDays", "RYU_PI_TRANSCRIPT_MAX_AGE_DAYS"),
        ("predict.model", "RYU_PREDICT_MODEL"),
        ("product.analyticsEnabled", "RYU_PRODUCT_ANALYTICS_ENABLED"),
        ("profile.activityEnabled", "RYU_PROFILE_ACTIVITY_ENABLED"),
        ("rag.provider", "RYU_RAG_PROVIDER"),
        ("rag.vectorStore.metric", "RYU_RAG_VECTOR_STORE_METRIC"),
        (
            "rag.vectorStore.textField",
            "RYU_RAG_VECTOR_STORE_TEXT_FIELD",
        ),
        ("reranker.model", "RYU_RERANKER_MODEL"),
        ("reranker.provider", "RYU_RERANKER_PROVIDER"),
        ("restate.adminUrl", "RYU_RESTATE_ADMIN_URL"),
        ("sandbox.backend", "RYU_SANDBOX_BACKEND"),
        ("sandbox.boxSize", "RYU_SANDBOX_BOX_SIZE"),
        ("sandbox.boxTimeoutSecs", "RYU_SANDBOX_BOX_TIMEOUT_SECS"),
        ("sandbox.daytonaGpu", "RYU_SANDBOX_DAYTONA_GPU"),
        ("sandbox.daytonaGpuCount", "RYU_SANDBOX_DAYTONA_GPU_COUNT"),
        ("sandbox.daytonaMemGib", "RYU_SANDBOX_DAYTONA_MEM_GIB"),
        ("sandbox.daytonaOs", "RYU_SANDBOX_DAYTONA_OS"),
        (
            "sandbox.daytonaStorageGib",
            "RYU_SANDBOX_DAYTONA_STORAGE_GIB",
        ),
    ];
    for (path, expected) in cases {
        let path: Vec<String> = path.split('.').map(str::to_owned).collect();
        assert_eq!(&friendly_path_to_env_name(&path), expected, "path {path:?}");
        assert!(!is_reserved_or_secret(expected), "{expected} is reserved");
    }
}

mod core_3;

mod core_4;

mod core_5;
