#[tokio::test]
async fn edge_tts_requires_explicit_opt_in_and_has_no_credentials_or_region() {
    for opt_in in [None, Some(false), Some(true)] {
        let config = ProvidersConfig {
            edge_tts: opt_in.map(|anonymous_consumer_opt_in| crate::config::EdgeTtsConfig {
                anonymous_consumer_opt_in,
            }),
            ..Default::default()
        };
        let registry = ProviderRegistry::new(&config, quota());
        assert_eq!(registry.get("edge-tts").is_some(), opt_in == Some(true));
        assert!(registry.region_for("edge-tts").is_none());
        assert!(!registry.account_ids.contains_key("edge-tts"));
        if let Some(provider) = registry.get("edge-tts") {
            assert!(provider
                .complete("edge-tts", &serde_json::json!({}))
                .await
                .is_err());
        }
    }
    assert!(serde_json::from_value::<crate::config::EdgeTtsConfig>(
        serde_json::json!({"api_key":"fake"})
    )
    .is_err());
}

#[tokio::test]
async fn google_translate_tts_requires_explicit_opt_in_and_keeps_cloud_separate() {
    for opt_in in [None, Some(false), Some(true)] {
        let config = ProvidersConfig {
            google_translate_tts: opt_in.map(|anonymous_consumer_opt_in| {
                crate::config::GoogleTranslateTtsConfig {
                    anonymous_consumer_opt_in,
                }
            }),
            ..Default::default()
        };
        let registry = ProviderRegistry::new(&config, Arc::new(ProviderQuotas::new()));
        assert_eq!(
            registry.get("google-translate-tts").is_some(),
            opt_in == Some(true)
        );
        assert!(registry.get("google-tts").is_none());
        assert!(registry.region_for("google-translate-tts").is_none());
        assert!(!registry.account_ids.contains_key("google-translate-tts"));
        if let Some(provider) = registry.get("google-translate-tts") {
            assert!(provider
                .complete("google-translate-tts", &serde_json::json!({}))
                .await
                .is_err());
            assert_eq!(
                provider.discover_models().await.unwrap()[0]["id"],
                "google-translate-tts"
            );
        }
    }
    assert!(
        serde_json::from_value::<crate::config::GoogleTranslateTtsConfig>(
            serde_json::json!({"anonymous_consumer_opt_in":true,"api_key":"not-supported"})
        )
        .is_err()
    );
}

#[test]
fn direct_google_and_polly_speech_accounts_register_without_exposing_credentials() {
    let config = ProvidersConfig {
        google_tts: Some(crate::config::GoogleTtsProviderConfig {
            accounts: vec![
                crate::config::GoogleTtsAccountConfig {
                    access_token: "ya29.first-token".to_owned(),
                    quota_project: "ryu-demo-123".to_owned(),
                    expires_at_unix_secs: None,
                },
                crate::config::GoogleTtsAccountConfig {
                    access_token: "ya29.second-token".to_owned(),
                    quota_project: "ryu-demo-123".to_owned(),
                    expires_at_unix_secs: None,
                },
            ],
        }),
        polly: Some(crate::config::PollyProviderConfig {
            region: "us-east-1".to_owned(),
            accounts: vec![crate::config::PollyAccountConfig {
                access_key_id: "ABCDEFGHIJKLMNOPQRST".to_owned(),
                secret_access_key: "abcdefghijklmnopqrstuvwxyz0123456789ABCD".to_owned(),
                session_token: None,
                expires_at_unix_secs: None,
            }],
        }),
        ..Default::default()
    };
    let debug = format!("{config:?}");
    for secret in [
        "ya29.first-token",
        "ya29.second-token",
        "ABCDEFGHIJKLMNOPQRST",
        "abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    ] {
        assert!(!debug.contains(secret));
    }
    let registry = ProviderRegistry::new(&config, quota());
    assert!(registry.get("google-tts").is_some());
    assert!(registry.get("polly").is_some());
    assert_eq!(registry.account_ids["google-tts"].len(), 2);
    assert_eq!(registry.account_ids["polly"].len(), 1);
    assert_eq!(registry.region_for("google-tts").as_deref(), Some("global"));
    assert_eq!(registry.region_for("polly").as_deref(), Some("us-east-1"));
    assert!(registry.activation_error("google-tts").is_none());
    assert!(registry.activation_error("polly").is_none());
}
use super::*;
use crate::config::{
    AnthropicProviderConfig, AssemblyAiProviderConfig, CohereProviderConfig,
    CompatibleProviderConfig, DeepgramProviderConfig, ElevenLabsProviderConfig,
    InworldProviderConfig, LocalProviderConfig, OpenAiProviderConfig, ProvidersConfig,
};
use serde_json::Value;
use std::pin::Pin;

fn quota() -> Arc<ProviderQuotas> {
    Arc::new(ProviderQuotas::new())
}

/// A no-op provider used to exercise registry mechanics (register / replace /
/// order) without any network.
struct StubProvider(&'static str);
impl Provider for StubProvider {
    fn name(&self) -> &'static str {
        self.0
    }
    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move { Err(ryu_gw_providers::ProviderError::Provider("stub".into())) })
    }
    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move { Err(ryu_gw_providers::ProviderError::Provider("stub".into())) })
    }

    fn embed<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<
        Box<
            dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async { Ok(serde_json::json!({ "data": [] })) })
    }
}

#[tokio::test]
async fn aliased_provider_keeps_embedding_capability() {
    let mut registry = ProviderRegistry::new(&ProvidersConfig::default(), quota());
    registry.register_as("embed-alias", Arc::new(StubProvider("stub")));
    let provider = registry.get("embed-alias").expect("alias registered");
    let result = provider
        .embed("test", &serde_json::json!({ "input": "hello" }))
        .await;
    assert_eq!(
        result.expect("inner embedding forwarded"),
        serde_json::json!({ "data": [] })
    );
}

#[tokio::test]
async fn named_account_policies_control_real_upstream_dispatch_after_config_roundtrip() {
    use axum::{http::HeaderMap, routing::post, Json, Router};
    let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
    let upstream_capture = captured.clone();
    let app = Router::new().route("/v1/chat/completions", post(move |headers: HeaderMap| {
        let captured = upstream_capture.clone();
        async move {
            captured.lock().unwrap().push(headers["authorization"].to_str().unwrap().to_owned());
            Json(serde_json::json!({"choices":[{"message":{"role":"assistant","content":"proof"}}]}))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut config: ProvidersConfig = serde_json::from_value(serde_json::json!({"modal":{"api_key":"disabled", "api_keys":["backup", "preferred"], "base_url":base}})).unwrap();
    let policies = HashMap::from([
        (
            ryu_gw_credentials::provider_account_id("modal", "disabled"),
            ryu_gw_providers::ProviderAccountPolicy {
                enabled: false,
                ..Default::default()
            },
        ),
        (
            ryu_gw_credentials::provider_account_id("modal", "backup"),
            ryu_gw_providers::ProviderAccountPolicy {
                priority: 10,
                ..Default::default()
            },
        ),
    ]);
    config.account_policies.insert("modal".to_owned(), policies);
    let restored: ProvidersConfig = toml::from_str(&toml::to_string(&config).unwrap()).unwrap();
    let registry = ProviderRegistry::new(&restored, quota());
    let provider = registry.get("modal").unwrap();
    assert!(provider.has_rotating_accounts());
    provider
        .complete_for_session(
            "test",
            &serde_json::json!({"messages":[]}),
            Some("same-session"),
        )
        .await
        .unwrap();
    provider
        .complete_for_session(
            "test",
            &serde_json::json!({"messages":[]}),
            Some("same-session"),
        )
        .await
        .unwrap();
    assert_eq!(
        *captured.lock().unwrap(),
        vec!["Bearer preferred", "Bearer preferred"]
    );
    let mut disabled = restored;
    for key in disabled.account_keys("modal") {
        disabled.account_policies.get_mut("modal").unwrap().insert(
            ryu_gw_credentials::provider_account_id("modal", &key),
            ryu_gw_providers::ProviderAccountPolicy {
                enabled: false,
                ..Default::default()
            },
        );
    }
    let registry = ProviderRegistry::new(&disabled, quota());
    assert!(registry
        .get("modal")
        .unwrap()
        .complete("test", &serde_json::json!({"messages":[]}))
        .await
        .is_err());
    assert_eq!(captured.lock().unwrap().len(), 2);
    server.abort();
}

#[tokio::test]
async fn quota_first_strategy_survives_config_roundtrip_and_ranks_known_domains() {
    use axum::{http::HeaderMap, routing::post, Json, Router};
    let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
    let upstream_capture = captured.clone();
    let app = Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap| {
            let captured = upstream_capture.clone();
            async move {
                let key = headers["authorization"].to_str().unwrap();
                captured.lock().unwrap().push(key.to_owned());
                let (organization, remaining) = if key == "Bearer key-a" {
                    ("org-a", "20")
                } else {
                    ("org-b", "90")
                };
                (
                    [
                        ("openai-organization", organization),
                        ("x-ratelimit-remaining-requests", remaining),
                        ("x-ratelimit-limit-requests", "100"),
                    ],
                    Json(serde_json::json!({"choices":[]})),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
        "openai": {"api_key":"key-a", "api_keys":["key-b"], "base_url":base},
        "accountStrategies": {"openai":"quota_first"}
    }))
    .unwrap();
    let restored: ProvidersConfig = toml::from_str(&toml::to_string(&config).unwrap()).unwrap();
    assert_eq!(
        restored.account_strategies["openai"],
        ryu_gw_providers::AccountSelectionStrategy::QuotaFirst
    );
    let registry = ProviderRegistry::new(&restored, quota());
    let provider = registry.get("openai").unwrap();
    let body = serde_json::json!({"messages":[]});
    for session in ["first", "second", "third"] {
        provider
            .complete_for_session("test", &body, Some(session))
            .await
            .unwrap();
    }
    assert_eq!(
        *captured.lock().unwrap(),
        vec!["Bearer key-a", "Bearer key-b", "Bearer key-b"]
    );
    server.abort();
}

#[test]
fn empty_config_registers_no_providers() {
    let reg = ProviderRegistry::new(&ProvidersConfig::default(), quota());
    assert!(reg.available_providers().is_empty());
    assert!(reg.get("openai").is_none());
}

#[test]
fn sdk_routes_coexist_and_resolve_legacy_owner_before_governance() {
    let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
        "openai":{"api_key":"native"},
        "openai_credits":{"api_key":"donated"},
        "genai":{"accounts":{"openai":{"api_key":"sdk"},"groq":{"api_key":"groq"},"gemini":{"api_key":"gemini"}}}
    })).unwrap();
    let registry = ProviderRegistry::new(&config, quota());
    for id in [
        "openai",
        "openai-credits",
        "genai-openai",
        "genai-groq",
        "genai",
    ] {
        assert_eq!(registry.get(id).unwrap().name(), id);
    }
    assert_eq!(
        registry.canonicalize_sdk_route("genai", "groq::llama-3.3-70b-versatile"),
        Some("genai-groq")
    );
    assert_eq!(
        registry.canonicalize_sdk_route("genai", "gemini-2.5-pro"),
        Some("genai")
    );
    assert_eq!(
        registry.canonicalize_sdk_route("genai-openai", "groq::llama-3.3-70b-versatile"),
        None
    );
    assert_eq!(
        registry.canonicalize_sdk_route("genai", "xai::grok-3"),
        None
    );
    let sdk_id = ryu_gw_credentials::provider_account_id("genai-groq", "groq");
    assert!(registry
        .validate_account_policy_updates(&HashMap::from([(
            "genai-groq".to_owned(),
            HashMap::from([(
                sdk_id,
                ryu_gw_credentials::ProviderAccountPolicy {
                    name: "SDK account".to_owned(),
                    ..Default::default()
                }
            )])
        )]))
        .is_ok());
}

#[test]
fn sdk_endpoint_regions_are_context_bound_and_remote_ollama_is_unknown() {
    let config: ProvidersConfig = serde_json::from_value(serde_json::json!({"genai":{"accounts":{
        "vertex":{"api_key":"token","context":{"kind":"vertex","project":"project","location":"europe-west4"}},
        "bedrock_api":{"api_key":"token","context":{"kind":"bedrock_api","region":"eu-west-1"}},
        "ollama":{"context":{"kind":"ollama","base_url":"https://remote.example/v1"}}
    }}})).unwrap();
    let registry = ProviderRegistry::new(&config, quota());
    assert_eq!(
        registry.region_for("genai-vertex").as_deref(),
        Some("europe-west4")
    );
    assert_eq!(
        registry.region_for("genai-bedrock-api").as_deref(),
        Some("eu-west-1")
    );
    assert_eq!(registry.region_for("genai-ollama"), None);
    assert!(registry.get("genai-ollama").is_some());
}

mod credit_pools;
mod registry;
