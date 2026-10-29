//! Explicit outbound proxy pools for direct OpenAI-compatible providers.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use ryu_gw_providers::EgressClientPool;
use sha2::{Digest, Sha256};

use crate::config::{EgressConfig, EgressProxyEndpointConfig};

/// Total for non-streaming calls on the reqwest clients; streamed completions
/// lift it per request and rely on `STREAM_READ_TIMEOUT` to fail a stalled
/// upstream.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
/// The GenAI SDK cannot lift a client's total per request, so its clients carry
/// the stream total and the SDK adapter bounds non-streaming calls itself.
const SDK_REQUEST_TIMEOUT: Duration = ryu_gw_providers::STREAM_TOTAL_TIMEOUT;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = ryu_gw_providers::STREAM_READ_TIMEOUT;

pub struct EgressPools {
    pools: HashMap<String, Arc<EgressClientPool>>,
    assignments: HashMap<String, String>,
    fingerprints: HashMap<String, [u8; 32]>,
}

impl EgressPools {
    pub fn new(config: &EgressConfig) -> Result<Self, String> {
        Self::new_reusing(config, None)
    }

    /// Retain named-pool health when endpoint configuration and proxy custody agree.
    pub(crate) fn new_reusing(
        config: &EgressConfig,
        previous: Option<&Self>,
    ) -> Result<Self, String> {
        let environment = crate::config::ProviderEnvironment::capture(config);
        Self::new_reusing_with_environment(config, previous, environment.values())
    }

    pub(crate) fn new_reusing_with_environment(
        config: &EgressConfig,
        previous: Option<&Self>,
        environment: &std::collections::BTreeMap<String, String>,
    ) -> Result<Self, String> {
        if config.pools.len() > 128 {
            return Err("Gateway supports at most 128 egress proxy pools".to_owned());
        }
        let mut pools = HashMap::new();
        let mut fingerprints = HashMap::new();
        for (name, pool) in &config.pools {
            validate_id(name, "proxy pool")?;
            let mut hash = Sha256::new();
            hash.update(serde_json::to_vec(pool).map_err(|_| "proxy pool configuration failed")?);
            for endpoint in &pool.endpoints {
                for variable in [&endpoint.username_env, &endpoint.password_env]
                    .into_iter()
                    .flatten()
                {
                    let value = environment
                        .get(variable)
                        .map(String::as_str)
                        .unwrap_or_default();
                    hash.update(value.len().to_be_bytes());
                    hash.update(value.as_bytes());
                }
            }
            let fingerprint: [u8; 32] = hash.finalize().into();
            fingerprints.insert(name.clone(), fingerprint);
            if let Some(existing) = previous
                .filter(|previous| previous.fingerprints.get(name) == Some(&fingerprint))
                .and_then(|previous| previous.pools.get(name))
            {
                pools.insert(name.clone(), Arc::clone(existing));
                continue;
            }
            let mut clients = Vec::new();
            let mut sdk_clients = Vec::new();
            let mut priorities = Vec::new();
            if pool.direct_fallback_only && !pool.include_direct {
                return Err(format!(
                    "proxy pool {name} enables direct fallback without a direct member"
                ));
            }
            let mut ids = HashSet::new();
            if pool.include_direct {
                priorities.push(if pool.direct_fallback_only {
                    u32::MAX
                } else {
                    0
                });
                sdk_clients.push(
                    reqwest_sdk::Client::builder()
                        .redirect(reqwest_sdk::redirect::Policy::none())
                        .no_proxy()
                        .connect_timeout(CONNECT_TIMEOUT)
                        .read_timeout(READ_TIMEOUT)
                        .timeout(SDK_REQUEST_TIMEOUT)
                        .build()
                        .map_err(|_| "direct SDK egress client failed".to_owned())?,
                );
                clients.push(
                    reqwest::Client::builder()
                        .redirect(reqwest::redirect::Policy::none())
                        .no_proxy()
                        .connect_timeout(CONNECT_TIMEOUT)
                        .read_timeout(READ_TIMEOUT)
                        .timeout(REQUEST_TIMEOUT)
                        .build()
                        .map_err(|error| format!("direct egress client failed: {error}"))?,
                );
            }
            for endpoint in pool.endpoints.iter().filter(|endpoint| endpoint.enabled) {
                validate_id(&endpoint.id, "proxy endpoint")?;
                if !ids.insert(endpoint.id.as_str()) {
                    return Err(format!("duplicate proxy endpoint ID in pool {name}"));
                }
                let (client, sdk) = build_proxy_client_with_environment(endpoint, environment)?;
                clients.push(client);
                sdk_clients.push(sdk);
                priorities.push(u32::from(endpoint.priority));
            }
            let selected = EgressClientPool::new(clients)
                .and_then(|pool| pool.with_sdk_clients(sdk_clients))
                .and_then(|pool| pool.with_priorities(priorities))
                .map_err(str::to_owned)?;
            pools.insert(name.clone(), Arc::new(selected));
        }
        for (provider, pool_name) in &config.assignments {
            if !supports_explicit_egress(provider) {
                return Err(format!(
                    "provider {provider} does not yet support explicit egress proxy pools"
                ));
            }
            if !pools.contains_key(pool_name) {
                return Err(format!(
                    "provider {provider} references unknown egress pool {pool_name}"
                ));
            }
        }
        Ok(Self {
            pools,
            assignments: config.assignments.clone(),
            fingerprints,
        })
    }

    pub fn assigned(&self, provider: &str) -> Option<Arc<EgressClientPool>> {
        self.assignments
            .get(provider)
            .and_then(|name| self.pools.get(name))
            .map(Arc::clone)
    }

    pub(crate) fn assignment_identity(&self, provider: &str) -> Option<(&str, &[u8; 32])> {
        let name = self.assignments.get(provider)?;
        Some((name.as_str(), self.fingerprints.get(name)?))
    }
}

fn supports_explicit_egress(id: &str) -> bool {
    if ryu_gw_credentials::web::web_provider_by_id(id).is_some() {
        return true;
    }
    matches!(
        id,
        "openai"
            | "edge-tts"
            | "google-tts"
            | "polly"
            | "anthropic"
            | "openrouter"
            | "litellm"
            | "cohere"
            | "deepgram"
            | "assemblyai"
            | "elevenlabs"
            | "inworld"
            | "modal"
            | "replicate"
            | "fal"
            | "recraft"
            | "stability"
            | "bfl"
            | "genai"
            | "cloudflare"
            | "bedrock"
            | "vertex"
            | "openai-credits"
            | "anthropic-credits"
    ) || ryu_gw_credentials::direct_compatible_provider_url(id).is_some()
        || ryu_gw_credentials::sdk_provider_by_id(id).is_some()
}

#[cfg(test)]
mod sdk_assignment_tests {
    use super::*;

    #[test]
    fn canonical_sdk_routes_accept_kind_specific_egress_assignments() {
        for descriptor in ryu_gw_credentials::SDK_PROVIDERS {
            assert!(supports_explicit_egress(descriptor.provider_id));
            assert!(validate_id(descriptor.provider_id, "provider").is_ok());
        }
        assert!(!supports_explicit_egress("genai-not-a-provider"));
        assert!(!supports_explicit_egress("genai-openai_resp"));
    }
}

fn validate_id(id: &str, kind: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("invalid {kind} ID"));
    }
    Ok(())
}

/// Variables a `PUT /v1/config` caller may newly name as proxy Basic credentials.
const WRITABLE_PROXY_CREDENTIAL_ENV_PREFIX: &str = "RYU_PROXY_";

fn proxy_credential_env_names(config: &EgressConfig) -> impl Iterator<Item = &str> {
    config
        .pools
        .values()
        .flat_map(|pool| &pool.endpoints)
        .flat_map(|endpoint| [&endpoint.username_env, &endpoint.password_env])
        .flatten()
        .map(String::as_str)
}

/// The config writer also chooses the proxy URL, so a credential name it adds
/// must be reserved for proxy credentials; otherwise any Gateway secret (admin
/// key, Core relay key, provider keys) could be sent to that proxy. Names the
/// persisted `gateway.toml` already uses stay accepted so read-modify-write
/// clients keep working. Disabled endpoints are checked too, and the
/// environment is never read, so the refusal never reveals whether a variable exists.
/// Malformed names are left to `EgressPools::new`, which never uses them as credentials.
pub(crate) fn validate_written_proxy_credential_env_names(
    next: &EgressConfig,
    persisted: &EgressConfig,
) -> Result<(), String> {
    let persisted: HashSet<&str> = proxy_credential_env_names(persisted).collect();
    let refused = |name: &str| {
        validate_env_name(name).is_ok()
            && !name.starts_with(WRITABLE_PROXY_CREDENTIAL_ENV_PREFIX)
            && !persisted.contains(name)
    };
    if !proxy_credential_env_names(next).any(refused) {
        return Ok(());
    }
    Err(format!(
        "proxy credential environment names must start with {WRITABLE_PROXY_CREDENTIAL_ENV_PREFIX} unless gateway.toml already uses them"
    ))
}

fn validate_env_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 128
        || !name.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_uppercase() || byte == b'_' || (index > 0 && byte.is_ascii_digit())
        })
    {
        return Err("proxy credential environment name is invalid".to_owned());
    }
    Ok(())
}

fn build_proxy_client(
    endpoint: &EgressProxyEndpointConfig,
) -> Result<(reqwest::Client, reqwest_sdk::Client), String> {
    let environment = [&endpoint.username_env, &endpoint.password_env]
        .into_iter()
        .flatten()
        .filter_map(|name| std::env::var(name).ok().map(|value| (name.clone(), value)))
        .collect();
    build_proxy_client_with_environment(endpoint, &environment)
}

fn build_proxy_client_with_environment(
    endpoint: &EgressProxyEndpointConfig,
    environment: &std::collections::BTreeMap<String, String>,
) -> Result<(reqwest::Client, reqwest_sdk::Client), String> {
    let parsed = reqwest::Url::parse(&endpoint.url)
        .map_err(|_| format!("invalid proxy URL for endpoint {}", endpoint.id))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(format!("unsafe proxy URL for endpoint {}", endpoint.id));
    }
    let mut proxy = reqwest::Proxy::all(parsed.as_str())
        .map_err(|_| format!("invalid proxy endpoint {}", endpoint.id))?;
    let mut sdk_proxy = reqwest_sdk::Proxy::all(parsed.as_str())
        .map_err(|_| format!("invalid SDK proxy endpoint {}", endpoint.id))?;
    match (&endpoint.username_env, &endpoint.password_env) {
        (Some(username_env), Some(password_env)) => {
            validate_env_name(username_env)?;
            validate_env_name(password_env)?;
            let username = environment.get(username_env).ok_or_else(|| {
                format!("proxy username variable is unavailable for {}", endpoint.id)
            })?;
            let password = environment.get(password_env).ok_or_else(|| {
                format!("proxy password variable is unavailable for {}", endpoint.id)
            })?;
            if username.is_empty() || password.is_empty() {
                return Err(format!("proxy credentials are empty for {}", endpoint.id));
            }
            proxy = proxy.basic_auth(&username, &password);
            sdk_proxy = sdk_proxy.basic_auth(&username, &password);
        }
        (None, None) => {}
        _ => {
            return Err(format!(
                "proxy endpoint {} needs both username and password variables",
                endpoint.id
            ));
        }
    }
    let sdk = reqwest_sdk::Client::builder()
        .redirect(reqwest_sdk::redirect::Policy::none())
        .no_proxy()
        .proxy(sdk_proxy)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .timeout(SDK_REQUEST_TIMEOUT)
        .build()
        .map_err(|_| format!("SDK proxy client failed for {}", endpoint.id))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .proxy(proxy)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|_| format!("failed to build proxy client for {}", endpoint.id))?;
    Ok((client, sdk))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn proxy_clients_and_reuse_fingerprint_use_one_captured_map_through_aba() {
        use axum::{http::HeaderMap, routing::any, Json, Router};
        use base64::Engine;
        use std::collections::BTreeMap;
        let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = Arc::clone(&observed);
        let app = Router::new().fallback(any(move |headers: HeaderMap| {
            let recorded = Arc::clone(&recorded);
            async move {
                recorded.lock().unwrap().push(
                    headers
                        .get("proxy-authorization")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or_default()
                        .to_owned(),
                );
                Json(serde_json::json!({"ok":true}))
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut endpoint = endpoint(&url);
        endpoint.username_env = Some("RYU_PROXY_CAPTURED_USER_TEST".to_owned());
        endpoint.password_env = Some("RYU_PROXY_CAPTURED_PASS_TEST".to_owned());
        let mut config = EgressConfig::default();
        config.pools.insert(
            "captured".to_owned(),
            EgressProxyPoolConfig {
                include_direct: false,
                direct_fallback_only: false,
                endpoints: vec![endpoint],
            },
        );
        config
            .assignments
            .insert("openai".to_owned(), "captured".to_owned());
        let captured = BTreeMap::from([
            (
                "RYU_PROXY_CAPTURED_USER_TEST".to_owned(),
                "captured-user".to_owned(),
            ),
            (
                "RYU_PROXY_CAPTURED_PASS_TEST".to_owned(),
                "captured-pass".to_owned(),
            ),
        ]);
        let first = EgressPools::new_reusing_with_environment(&config, None, &captured).unwrap();
        let intermediate = BTreeMap::from([
            (
                "RYU_PROXY_CAPTURED_USER_TEST".to_owned(),
                "intermediate-user".to_owned(),
            ),
            (
                "RYU_PROXY_CAPTURED_PASS_TEST".to_owned(),
                "intermediate-pass".to_owned(),
            ),
        ]);
        let changed =
            EgressPools::new_reusing_with_environment(&config, Some(&first), &intermediate)
                .unwrap();
        assert!(!Arc::ptr_eq(
            &first.assigned("openai").unwrap(),
            &changed.assigned("openai").unwrap()
        ));
        // B was only a competing candidate; the authoritative input returns A.
        let again =
            EgressPools::new_reusing_with_environment(&config, Some(&first), &captured).unwrap();
        assert!(Arc::ptr_eq(
            &first.assigned("openai").unwrap(),
            &again.assigned("openai").unwrap()
        ));
        let pool = again.assigned("openai").unwrap();
        let candidates = pool.candidates(None);
        candidates[0]
            .1
            .get("http://upstream.invalid/native")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        pool.sdk_client(candidates[0].0)
            .unwrap()
            .get("http://upstream.invalid/sdk")
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let expected = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode("captured-user:captured-pass")
        );
        assert_eq!(*observed.lock().unwrap(), vec![expected.clone(), expected]);
        server.abort();
    }

    #[tokio::test]
    async fn configured_native_and_sdk_clients_do_not_forward_credentials_through_redirects() {
        use axum::{
            http::{HeaderValue, StatusCode},
            response::IntoResponse,
            routing::any,
            Router,
        };
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let recorded = calls.clone();
        let app = Router::new().fallback(any(move || {
            let recorded = recorded.clone();
            async move {
                recorded.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let mut response = StatusCode::FOUND.into_response();
                response.headers_mut().insert(
                    "location",
                    HeaderValue::from_static("http://unchecked.invalid/redirected"),
                );
                response
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (native, sdk) = super::build_proxy_client(&endpoint(&url)).unwrap();
        assert_eq!(
            native
                .post("http://api.example/submit")
                .header("x-key", "test-key")
                .send()
                .await
                .unwrap()
                .status(),
            302
        );
        assert_eq!(
            sdk.post("http://api.example/submit")
                .header("x-key", "test-key")
                .send()
                .await
                .unwrap()
                .status(),
            302
        );
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        server.abort();
    }

    #[test]
    fn direct_fallback_stays_behind_proxy_priority_groups() {
        let config:crate::config::EgressConfig=toml::from_str("[pools.preferred]\ninclude_direct=true\ndirect_fallback_only=true\n[[pools.preferred.endpoints]]\nid='proxy'\nurl='http://127.0.0.1:9999'\npriority=10\n[assignments]\nopenai='preferred'").unwrap();
        let pools = super::EgressPools::new(&config).unwrap();
        let pool = pools.assigned("openai").unwrap();
        assert_eq!(pool.candidates(Some("fresh-session"))[0].0, 1);
        pool.record_failure(1, Some(60));
        assert_eq!(pool.candidates(Some("fresh-session"))[0].0, 0);
        let invalid: crate::config::EgressConfig = toml::from_str(
            "[pools.invalid]\ninclude_direct=false\ndirect_fallback_only=true\nendpoints=[]",
        )
        .unwrap();
        assert!(super::EgressPools::new(&invalid).is_err());
    }
    #[test]
    fn genai_registry_receives_its_dual_stack_proxy_pool() {
        use std::sync::Arc;
        let mut egress = crate::config::EgressConfig::default();
        egress.pools.insert(
            "sdk".to_owned(),
            crate::config::EgressProxyPoolConfig {
                include_direct: true,
                direct_fallback_only: false,
                endpoints: vec![endpoint("http://127.0.0.1:9999")],
            },
        );
        egress
            .assignments
            .insert("genai".to_owned(), "sdk".to_owned());
        let pools = super::EgressPools::new(&egress).unwrap();
        let config: crate::config::ProvidersConfig =
            toml::from_str("[genai.keys]\ngemini = 'synthetic-key'").unwrap();
        let registry = crate::providers::ProviderRegistry::new_with_egress(
            &config,
            &pools,
            Arc::new(crate::quota::ProviderQuotas::new()),
        );
        let provider = registry.get("genai").unwrap();
        assert_eq!(provider.name(), "genai");
        assert!(provider.has_rotating_accounts());
    }
    #[tokio::test]
    async fn sdk_and_native_clients_traverse_the_same_configured_endpoint() {
        use axum::{routing::any, Json, Router};
        use serde_json::json;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().fallback(any(|| async { Json(json!({"proxy":true})) })),
            )
            .await
            .unwrap();
        });
        let (native, sdk) = super::build_proxy_client(&endpoint(&url)).unwrap();
        for status in [
            native
                .get("http://unreachable.invalid/native")
                .send()
                .await
                .unwrap()
                .status()
                .as_u16(),
            sdk.get("http://unreachable.invalid/sdk")
                .send()
                .await
                .unwrap()
                .status()
                .as_u16(),
        ] {
            assert_eq!(status, 200);
        }
        server.abort();
    }
    #[tokio::test]
    async fn fal_registry_uses_its_assigned_proxy_for_submit_and_result() {
        use axum::{http::Method, routing::any, Json, Router};
        use serde_json::json;
        use std::sync::Arc;
        async fn proxy(method: Method) -> Json<serde_json::Value> {
            if method == Method::POST {
                Json(
                    json!({"status":"COMPLETED","response_url":"http://unreachable.invalid/req/fal-job"}),
                )
            } else {
                Json(json!({"images":[{"url":"https://example.com/fal.png"}]}))
            }
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().fallback(any(proxy)))
                .await
                .unwrap();
        });
        let mut egress = crate::config::EgressConfig::default();
        egress.pools.insert(
            "media".to_owned(),
            crate::config::EgressProxyPoolConfig {
                include_direct: false,
                direct_fallback_only: false,
                endpoints: vec![endpoint(&url)],
            },
        );
        egress
            .assignments
            .insert("fal".to_owned(), "media".to_owned());
        let pools = super::EgressPools::new(&egress).unwrap();
        let mut config = crate::config::ProvidersConfig::default();
        config.fal=Some(toml::from_str("api_key = 'synthetic-key'\nbase_url = 'http://unreachable.invalid'\npoll_interval_ms = 250\npoll_timeout_secs = 5").unwrap());
        let providers = crate::providers::ProviderRegistry::new_with_egress(
            &config,
            &pools,
            Arc::new(crate::quota::ProviderQuotas::new()),
        );
        let result = providers
            .get("fal")
            .unwrap()
            .generate_image("fal-ai/model", &json!({"prompt":"cat"}))
            .await
            .unwrap();
        assert_eq!(result["data"][0]["url"], "https://example.com/fal.png");
        server.abort();
    }
    #[tokio::test]
    async fn replicate_registry_uses_its_assigned_proxy_for_creation_and_polling() {
        use axum::{
            extract::State,
            http::{Method, Uri},
            routing::any,
            Json, Router,
        };
        use serde_json::json;
        use std::sync::{Arc, Mutex};
        async fn proxy(
            State(seen): State<Arc<Mutex<Vec<String>>>>,
            method: Method,
            uri: Uri,
        ) -> Json<serde_json::Value> {
            seen.lock().unwrap().push(format!("{method} {uri}"));
            if method == Method::POST {
                Json(json!({"id":"test-job","status":"processing"}))
            } else {
                Json(
                    json!({"id":"test-job","status":"succeeded","output":"https://example.com/result.png"}),
                )
            }
        }
        let seen = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .fallback(any(proxy))
            .with_state(Arc::clone(&seen));
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut egress = crate::config::EgressConfig::default();
        egress.pools.insert(
            "media".to_owned(),
            crate::config::EgressProxyPoolConfig {
                include_direct: false,
                direct_fallback_only: false,
                endpoints: vec![endpoint(&url)],
            },
        );
        egress
            .assignments
            .insert("replicate".to_owned(), "media".to_owned());
        let pools = super::EgressPools::new(&egress).unwrap();
        let mut config = crate::config::ProvidersConfig::default();
        config.replicate=Some(toml::from_str("api_key = 'synthetic-key'\nbase_url = 'http://unreachable.invalid/v1'\npoll_interval_ms = 250\npoll_timeout_secs = 5").unwrap());
        let providers = crate::providers::ProviderRegistry::new_with_egress(
            &config,
            &pools,
            Arc::new(crate::quota::ProviderQuotas::new()),
        );
        let result = providers
            .get("replicate")
            .unwrap()
            .generate_image("owner/model", &json!({"prompt":"cat"}))
            .await
            .unwrap();
        assert_eq!(result["data"][0]["url"], "https://example.com/result.png");
        let calls = seen.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls[0].starts_with("POST "));
        assert!(calls[1].contains("/predictions/test-job"));
        server.abort();
    }
    use super::*;
    use crate::config::EgressProxyPoolConfig;

    #[tokio::test]
    async fn assigned_openai_request_traverses_the_selected_proxy() {
        use axum::{extract::State, routing::post, Json, Router};
        use serde_json::{json, Value};
        use std::sync::{Arc, Mutex};

        async fn proxy(
            State(calls): State<Arc<Mutex<Vec<Value>>>>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            calls.lock().unwrap().push(body);
            Json(json!({
                "id":"chatcmpl-proxy",
                "object":"chat.completion",
                "choices":[{"index":0,"message":{"role":"assistant","content":"via proxy"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
            }))
        }

        let calls = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .fallback(post(proxy))
            .with_state(Arc::clone(&calls));
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        let mut egress = EgressConfig::default();
        egress.pools.insert(
            "local".to_owned(),
            EgressProxyPoolConfig {
                include_direct: false,
                direct_fallback_only: false,
                endpoints: vec![endpoint(&proxy_url)],
            },
        );
        egress
            .assignments
            .insert("openai".to_owned(), "local".to_owned());
        let pools = EgressPools::new(&egress).unwrap();
        let providers = crate::providers::ProviderRegistry::new_with_egress(
            &crate::config::ProvidersConfig {
                openai: Some(crate::config::OpenAiProviderConfig {
                    api_key: "test-upstream-key".to_owned(),
                    api_keys: Vec::new(),
                    base_url: "http://unreachable.invalid/v1".to_owned(),
                }),
                ..crate::config::ProvidersConfig::default()
            },
            &pools,
            std::sync::Arc::new(crate::quota::ProviderQuotas::new()),
        );
        let result = providers
            .get("openai")
            .unwrap()
            .complete(
                "gpt-4o-mini",
                &json!({"messages":[{"role":"user","content":"hi"}]}),
            )
            .await
            .unwrap();
        assert_eq!(result["choices"][0]["message"]["content"], "via proxy");
        assert_eq!(calls.lock().unwrap()[0]["model"], "gpt-4o-mini");
        server.abort();
    }

    #[tokio::test]
    async fn native_anthropic_request_uses_the_assigned_proxy() {
        use axum::{extract::State, routing::post, Json, Router};
        use serde_json::{json, Value};
        use std::sync::{Arc, Mutex};

        async fn proxy(
            State(calls): State<Arc<Mutex<Vec<Value>>>>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            calls.lock().unwrap().push(body);
            Json(json!({
                "id":"msg_proxy",
                "content":[{"type":"text","text":"via anthropic proxy"}],
                "stop_reason":"end_turn",
                "usage":{"input_tokens":1,"output_tokens":1}
            }))
        }
        let calls = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .fallback(post(proxy))
            .with_state(Arc::clone(&calls));
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let mut egress = EgressConfig::default();
        egress.pools.insert(
            "local".to_owned(),
            EgressProxyPoolConfig {
                include_direct: false,
                direct_fallback_only: false,
                endpoints: vec![endpoint(&proxy_url)],
            },
        );
        egress
            .assignments
            .insert("anthropic".to_owned(), "local".to_owned());
        let pools = EgressPools::new(&egress).unwrap();
        let providers = crate::providers::ProviderRegistry::new_with_egress(
            &crate::config::ProvidersConfig {
                anthropic: Some(crate::config::AnthropicProviderConfig {
                    api_key: "test-upstream-key".to_owned(),
                    api_keys: Vec::new(),
                    base_url: "http://unreachable.invalid".to_owned(),
                }),
                ..crate::config::ProvidersConfig::default()
            },
            &pools,
            Arc::new(crate::quota::ProviderQuotas::new()),
        );
        let result = providers
            .get("anthropic")
            .unwrap()
            .complete_for_session(
                "claude-haiku-4-5",
                &json!({"messages":[{"role":"user","content":"hi"}]}),
                Some("session"),
            )
            .await
            .unwrap();
        assert_eq!(
            result["choices"][0]["message"]["content"],
            "via anthropic proxy"
        );
        assert_eq!(calls.lock().unwrap()[0]["model"], "claude-haiku-4-5");
        server.abort();
    }

    #[tokio::test]
    async fn openrouter_request_preserves_attribution_through_the_proxy() {
        use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
        use serde_json::{json, Value};
        use std::sync::{Arc, Mutex};

        async fn proxy(
            State(calls): State<Arc<Mutex<Vec<(Value, HeaderMap)>>>>,
            headers: HeaderMap,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            calls.lock().unwrap().push((body, headers));
            Json(json!({
                "id":"chatcmpl-router",
                "object":"chat.completion",
                "choices":[{"index":0,"message":{"role":"assistant","content":"via router proxy"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
            }))
        }
        let calls = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .fallback(post(proxy))
            .with_state(Arc::clone(&calls));
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let mut egress = EgressConfig::default();
        egress.pools.insert(
            "local".to_owned(),
            EgressProxyPoolConfig {
                include_direct: false,
                direct_fallback_only: false,
                endpoints: vec![endpoint(&proxy_url)],
            },
        );
        egress
            .assignments
            .insert("openrouter".to_owned(), "local".to_owned());
        let pools = EgressPools::new(&egress).unwrap();
        let router: crate::config::OpenRouterProviderConfig = toml::from_str(
            "api_key = 'test-upstream-key'\nbase_url = 'http://unreachable.invalid/v1'",
        )
        .unwrap();
        let providers = crate::providers::ProviderRegistry::new_with_egress(
            &crate::config::ProvidersConfig {
                openrouter: Some(router),
                ..crate::config::ProvidersConfig::default()
            },
            &pools,
            Arc::new(crate::quota::ProviderQuotas::new()),
        );
        let result = providers
            .get("openrouter")
            .unwrap()
            .complete_for_session(
                "openrouter/auto",
                &json!({"messages":[{"role":"user","content":"hi"}]}),
                Some("session"),
            )
            .await
            .unwrap();
        assert_eq!(
            result["choices"][0]["message"]["content"],
            "via router proxy"
        );
        let requests = calls.lock().unwrap();
        assert_eq!(requests[0].0["model"], "openrouter/auto");
        assert!(requests[0].1.contains_key("http-referer"));
        server.abort();
    }

    #[tokio::test]
    async fn native_embedding_and_speech_adapters_use_the_assigned_proxy() {
        use axum::{body::Body, extract::State, http::Uri, routing::post, Router};
        use serde_json::json;
        use std::sync::{Arc, Mutex};

        async fn proxy(
            State(paths): State<Arc<Mutex<Vec<String>>>>,
            uri: Uri,
        ) -> axum::response::Response {
            let path = uri.to_string();
            paths.lock().unwrap().push(path.clone());
            let (content_type, body) = if path.contains("/v2/embed") {
                (
                    "application/json",
                    r#"{"embeddings":{"float":[[0.1,0.2]]}}"#.as_bytes().to_vec(),
                )
            } else if path.contains("/v1/listen") {
                (
                    "application/json",
                    r#"{"results":{"channels":[{"alternatives":[{"transcript":"heard"}]}]}}"#
                        .as_bytes()
                        .to_vec(),
                )
            } else if path.contains("/v1/speak") {
                ("audio/wav", vec![82, 73, 70, 70])
            } else if path.contains("/tts/v1/voice") {
                ("application/json", br#"{"audioContent":"AQID"}"#.to_vec())
            } else {
                ("audio/mpeg", vec![1, 2, 3])
            };
            axum::http::Response::builder()
                .header("content-type", content_type)
                .body(Body::from(body))
                .unwrap()
        }

        let paths = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .fallback(post(proxy))
            .with_state(Arc::clone(&paths));
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let mut egress = EgressConfig::default();
        egress.pools.insert(
            "local".to_owned(),
            EgressProxyPoolConfig {
                include_direct: false,
                direct_fallback_only: false,
                endpoints: vec![endpoint(&proxy_url)],
            },
        );
        for id in ["cohere", "deepgram", "elevenlabs", "inworld"] {
            egress.assignments.insert(id.to_owned(), "local".to_owned());
        }
        let pools = EgressPools::new(&egress).unwrap();
        let providers = crate::providers::ProviderRegistry::new_with_egress(
            &crate::config::ProvidersConfig {
                cohere: Some(crate::config::CohereProviderConfig {
                    api_key: "cohere-test".to_owned(),
                    api_keys: Vec::new(),
                    base_url: "http://unreachable.invalid".to_owned(),
                }),
                deepgram: Some(crate::config::DeepgramProviderConfig {
                    api_key: "deepgram-test".to_owned(),
                    api_keys: Vec::new(),
                    base_url: "http://unreachable.invalid".to_owned(),
                }),
                elevenlabs: Some(crate::config::ElevenLabsProviderConfig {
                    api_key: "elevenlabs-test".to_owned(),
                    api_keys: Vec::new(),
                    base_url: "http://unreachable.invalid".to_owned(),
                }),
                inworld: Some(crate::config::InworldProviderConfig {
                    api_key: "inworld-test".to_owned(),
                    api_keys: Vec::new(),
                    base_url: "http://unreachable.invalid".to_owned(),
                }),
                ..crate::config::ProvidersConfig::default()
            },
            &pools,
            Arc::new(crate::quota::ProviderQuotas::new()),
        );
        let embedded = providers
            .get("cohere")
            .unwrap()
            .embed("embed-v4.0", &json!({"input":["hello"]}))
            .await
            .unwrap();
        assert_eq!(embedded["data"][0]["embedding"], json!([0.1, 0.2]));
        let spoken = providers
            .get("deepgram")
            .unwrap()
            .synthesize_speech("aura-2-thalia-en", &json!({"input":"hello"}))
            .await
            .unwrap();
        assert_eq!(spoken["data"][0]["b64_json"], "UklGRg==");
        let heard = providers
            .get("deepgram")
            .unwrap()
            .transcribe_audio("nova-3", &json!({"file":"AQID","filename":"sample.wav"}))
            .await
            .unwrap();
        assert_eq!(heard["text"], "heard");
        let eleven = providers
            .get("elevenlabs")
            .unwrap()
            .synthesize_speech(
                "eleven_multilingual_v2",
                &json!({"input":"hello","voice":"JBFqnCBsd6RMkjVDRZzb"}),
            )
            .await
            .unwrap();
        assert_eq!(eleven["data"][0]["b64_json"], "AQID");
        let inworld = providers
            .get("inworld")
            .unwrap()
            .synthesize_speech("inworld-tts-2", &json!({"input":"hello","voice":"Ashley"}))
            .await
            .unwrap();
        assert_eq!(inworld["data"][0]["b64_json"], "AQID");
        let seen = paths.lock().unwrap();
        for path in [
            "/v2/embed",
            "/v1/speak",
            "/v1/listen",
            "/v1/text-to-speech/",
            "/tts/v1/voice",
        ] {
            assert!(
                seen.iter().any(|actual| actual.contains(path)),
                "missing {path}: {seen:?}"
            );
        }
        server.abort();
    }

    #[tokio::test]
    async fn modal_model_rewrite_is_preserved_through_the_proxy() {
        use axum::{extract::State, routing::post, Json, Router};
        use serde_json::{json, Value};
        use std::sync::{Arc, Mutex};

        async fn proxy(
            State(calls): State<Arc<Mutex<Vec<Value>>>>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            calls.lock().unwrap().push(body);
            Json(json!({
                "id":"chatcmpl-modal",
                "object":"chat.completion",
                "choices":[{"index":0,"message":{"role":"assistant","content":"modal via proxy"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
            }))
        }
        let calls = Arc::new(Mutex::new(Vec::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .fallback(post(proxy))
            .with_state(Arc::clone(&calls));
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let mut egress = EgressConfig::default();
        egress.pools.insert(
            "local".to_owned(),
            EgressProxyPoolConfig {
                include_direct: false,
                direct_fallback_only: false,
                endpoints: vec![endpoint(&proxy_url)],
            },
        );
        egress
            .assignments
            .insert("modal".to_owned(), "local".to_owned());
        let pools = EgressPools::new(&egress).unwrap();
        let providers = crate::providers::ProviderRegistry::new_with_egress(
            &crate::config::ProvidersConfig {
                modal: Some(crate::config::ModalProviderConfig {
                    api_key: "test-upstream-key".to_owned(),
                    api_keys: Vec::new(),
                    base_url: "http://unreachable.invalid/v1".to_owned(),
                }),
                ..crate::config::ProvidersConfig::default()
            },
            &pools,
            Arc::new(crate::quota::ProviderQuotas::new()),
        );
        let result = providers
            .get("modal")
            .unwrap()
            .complete_for_session(
                "modal/llama-3",
                &json!({"messages":[{"role":"user","content":"hi"}]}),
                Some("session"),
            )
            .await
            .unwrap();
        assert_eq!(
            result["choices"][0]["message"]["content"],
            "modal via proxy"
        );
        assert_eq!(calls.lock().unwrap()[0]["model"], "llama-3");
        server.abort();
    }

    #[tokio::test]
    async fn proxy_auth_failure_recovers_in_the_same_request_and_keeps_affinity() {
        use axum::{routing::post, Json, Router};
        use serde_json::{json, Value};
        use std::sync::Arc;

        async fn denied() -> (axum::http::StatusCode, Json<Value>) {
            (
                axum::http::StatusCode::PROXY_AUTHENTICATION_REQUIRED,
                Json(json!({"error":"proxy credentials rejected"})),
            )
        }
        async fn accepted() -> Json<Value> {
            Json(json!({
                "id":"chatcmpl-backup",
                "object":"chat.completion",
                "choices":[{"index":0,"message":{"role":"assistant","content":"backup"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
            }))
        }

        let first = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let first_url = format!("http://{}", first.local_addr().unwrap());
        let first_server = tokio::spawn(async move {
            let _ = axum::serve(first, Router::new().fallback(post(denied))).await;
        });
        let second = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let second_url = format!("http://{}", second.local_addr().unwrap());
        let second_server = tokio::spawn(async move {
            let _ = axum::serve(second, Router::new().fallback(post(accepted))).await;
        });
        let mut backup = endpoint(&second_url);
        backup.id = "backup".to_owned();
        let mut egress = EgressConfig::default();
        egress.pools.insert(
            "pair".to_owned(),
            EgressProxyPoolConfig {
                include_direct: false,
                direct_fallback_only: false,
                endpoints: vec![endpoint(&first_url), backup],
            },
        );
        egress
            .assignments
            .insert("openai".to_owned(), "pair".to_owned());
        let pools = EgressPools::new(&egress).unwrap();
        let providers = crate::providers::ProviderRegistry::new_with_egress(
            &crate::config::ProvidersConfig {
                openai: Some(crate::config::OpenAiProviderConfig {
                    api_key: "test-upstream-key".to_owned(),
                    api_keys: Vec::new(),
                    base_url: "http://unreachable.invalid/v1".to_owned(),
                }),
                ..crate::config::ProvidersConfig::default()
            },
            &pools,
            Arc::new(crate::quota::ProviderQuotas::new()),
        );
        let provider = providers.get("openai").unwrap();
        let body = json!({"messages":[{"role":"user","content":"hi"}]});
        let recovered = provider
            .complete_for_session("gpt-4o-mini", &body, Some("session"))
            .await
            .unwrap();
        assert_eq!(recovered["choices"][0]["message"]["content"], "backup");
        let recovered = provider
            .complete_for_session("gpt-4o-mini", &body, Some("session"))
            .await
            .unwrap();
        assert_eq!(recovered["choices"][0]["message"]["content"], "backup");
        first_server.abort();
        second_server.abort();
    }

    fn endpoint(url: &str) -> EgressProxyEndpointConfig {
        EgressProxyEndpointConfig {
            id: "local".to_owned(),
            url: url.to_owned(),
            enabled: true,
            priority: 0,
            username_env: None,
            password_env: None,
        }
    }

    #[test]
    fn builds_an_assigned_proxy_pool_without_credentials_in_the_url() {
        let mut config = EgressConfig::default();
        config.pools.insert(
            "private".to_owned(),
            EgressProxyPoolConfig {
                include_direct: false,
                direct_fallback_only: false,
                endpoints: vec![endpoint("http://127.0.0.1:8080")],
            },
        );
        config
            .assignments
            .insert("openai".to_owned(), "private".to_owned());
        let pools = EgressPools::new(&config).unwrap();
        assert_eq!(pools.assigned("openai").unwrap().candidates(None).len(), 1);
        assert!(pools.assigned("anthropic").is_none());
    }

    #[test]
    fn documented_toml_shape_builds_an_assigned_pool() {
        let config: crate::config::GatewayConfig = toml::from_str(
            r#"
            [egress.assignments]
            openai = "private"

            [egress.pools.private]
            include_direct = false

            [[egress.pools.private.endpoints]]
            id = "proxy-a"
            url = "http://127.0.0.1:8080"
            "#,
        )
        .unwrap();
        let pools = EgressPools::new(&config.egress).unwrap();
        assert_eq!(pools.assigned("openai").unwrap().len(), 1);
    }

    #[test]
    fn aliased_credit_provider_retains_its_id_and_rotating_egress() {
        let mut egress = EgressConfig::default();
        egress.pools.insert(
            "two-paths".to_owned(),
            EgressProxyPoolConfig {
                include_direct: true,
                direct_fallback_only: false,
                endpoints: vec![endpoint("http://127.0.0.1:8080")],
            },
        );
        egress
            .assignments
            .insert("openai-credits".to_owned(), "two-paths".to_owned());
        let pools = EgressPools::new(&egress).unwrap();
        let providers = crate::providers::ProviderRegistry::new_with_egress(
            &crate::config::ProvidersConfig {
                openai_credits: Some(crate::config::OpenAiProviderConfig {
                    api_key: "donor-test-key".to_owned(),
                    api_keys: Vec::new(),
                    base_url: "https://api.openai.com/v1".to_owned(),
                }),
                ..crate::config::ProvidersConfig::default()
            },
            &pools,
            std::sync::Arc::new(crate::quota::ProviderQuotas::new()),
        );
        let provider = providers.get("openai-credits").unwrap();
        assert_eq!(provider.name(), "openai-credits");
        assert!(provider.has_rotating_accounts());
    }

    #[test]
    fn rejects_proxy_urls_with_embedded_credentials_or_paths() {
        for url in [
            "http://user:password@127.0.0.1:8080",
            "http://127.0.0.1:8080/private",
            "file:///tmp/proxy",
        ] {
            let error = build_proxy_client(&endpoint(url)).unwrap_err();
            assert!(!error.contains("password"));
        }
    }

    #[test]
    fn rejects_partial_or_invalid_proxy_credential_references() {
        let mut partial = endpoint("http://127.0.0.1:8080");
        partial.username_env = Some("RYU_PROXY_USER".to_owned());
        assert!(build_proxy_client(&partial).is_err());

        let mut invalid = endpoint("http://127.0.0.1:8080");
        invalid.username_env = Some("RYU-PROXY-USER".to_owned());
        invalid.password_env = Some("RYU_PROXY_PASSWORD".to_owned());
        assert!(build_proxy_client(&invalid).is_err());
    }

    fn credentialed_pool(username_env: &str, password_env: &str, enabled: bool) -> EgressConfig {
        let mut endpoint = endpoint("http://127.0.0.1:8080");
        endpoint.enabled = enabled;
        endpoint.username_env = Some(username_env.to_owned());
        endpoint.password_env = Some(password_env.to_owned());
        let mut config = EgressConfig::default();
        config.pools.insert(
            "chosen".to_owned(),
            EgressProxyPoolConfig {
                include_direct: true,
                direct_fallback_only: false,
                endpoints: vec![endpoint],
            },
        );
        config
            .assignments
            .insert("openai".to_owned(), "chosen".to_owned());
        config
    }

    #[test]
    fn written_proxy_credentials_cannot_name_unrelated_gateway_secrets() {
        let persisted = EgressConfig::default();
        let mut refusals = Vec::new();
        for (username_env, password_env) in [
            ("CORE_TOKEN", "GATEWAY_CORE_RELAY_KEY"),
            ("GATEWAY_ADMIN_KEY", "OPENAI_API_KEY"),
            ("RYU_VAULT_INTERNAL_SECRET", "RYU_PROXY_PASSWORD"),
            ("proxy_user", "CORE_TOKEN"),
        ] {
            for enabled in [true, false] {
                let next = credentialed_pool(username_env, password_env, enabled);
                let Err(error) = validate_written_proxy_credential_env_names(&next, &persisted)
                else {
                    panic!("{username_env}/{password_env} must not become proxy credentials");
                };
                refusals.push(error);
            }
        }
        // One fixed refusal that never depends on the environment.
        assert!(refusals.windows(2).all(|pair| pair[0] == pair[1]));
        for enabled in [true, false] {
            let documented = credentialed_pool("RYU_PROXY_USER", "RYU_PROXY_PASSWORD", enabled);
            assert!(validate_written_proxy_credential_env_names(&documented, &persisted).is_ok());
        }
    }

    #[test]
    fn written_credential_check_leaves_malformed_names_to_endpoint_validation() {
        let persisted = EgressConfig::default();
        let environment = std::collections::BTreeMap::from([
            ("RYU_PROXY_USER".to_owned(), "user".to_owned()),
            ("RYU_PROXY_".to_owned(), "password".to_owned()),
        ]);
        for enabled in [true, false] {
            let bare_prefix = credentialed_pool("RYU_PROXY_USER", "RYU_PROXY_", enabled);
            assert!(validate_written_proxy_credential_env_names(&bare_prefix, &persisted).is_ok());
            assert!(
                EgressPools::new_reusing_with_environment(&bare_prefix, None, &environment).is_ok()
            );
        }
        for (username_env, password_env) in [
            ("RYU_PROXY_USER", "RYU_PROXY_lower"),
            ("proxy_user", "RYU_PROXY_PASSWORD"),
            ("", "RYU_PROXY_PASSWORD"),
        ] {
            for enabled in [true, false] {
                let next = credentialed_pool(username_env, password_env, enabled);
                assert!(validate_written_proxy_credential_env_names(&next, &persisted).is_ok());
                let built = EgressPools::new_reusing_with_environment(&next, None, &environment);
                if enabled {
                    assert_eq!(
                        built.err().as_deref(),
                        Some("proxy credential environment name is invalid")
                    );
                } else {
                    assert!(built.is_ok(), "{username_env}/{password_env} disabled");
                }
            }
        }
    }

    #[test]
    fn persisted_proxy_credential_names_stay_writable_but_cannot_seed_new_ones() {
        let authored = credentialed_pool("CORP_PROXY_USER", "CORP_PROXY_PASSWORD", true);
        assert!(validate_written_proxy_credential_env_names(&authored, &authored).is_ok());
        let mut extended = authored.clone();
        let mut added = endpoint("http://127.0.0.1:9090");
        added.id = "later".to_owned();
        added.enabled = false;
        added.username_env = Some("CORE_TOKEN".to_owned());
        added.password_env = Some("CORP_PROXY_PASSWORD".to_owned());
        extended
            .pools
            .get_mut("chosen")
            .unwrap()
            .endpoints
            .push(added);
        assert!(validate_written_proxy_credential_env_names(&extended, &authored).is_err());
    }

    #[test]
    fn accepts_wired_types_and_refuses_unknown_provider_assignments() {
        let mut config = EgressConfig::default();
        config.pools.insert(
            "private".to_owned(),
            EgressProxyPoolConfig {
                include_direct: true,
                direct_fallback_only: false,
                endpoints: Vec::new(),
            },
        );
        for provider in ["fal", "replicate", "genai"] {
            config.assignments.clear();
            config
                .assignments
                .insert(provider.to_owned(), "private".to_owned());
            assert!(EgressPools::new(&config).is_ok());
        }
        config.assignments.clear();
        config
            .assignments
            .insert("unknown-provider".to_owned(), "private".to_owned());
        assert!(EgressPools::new(&config).is_err());
    }
    #[test]
    fn unchanged_named_pool_retains_shared_health_but_changed_endpoint_replaces_it() {
        let mut config = EgressConfig::default();
        config.pools.insert(
            "shared".to_owned(),
            EgressProxyPoolConfig {
                include_direct: true,
                direct_fallback_only: false,
                endpoints: vec![endpoint("http://127.0.0.1:8080")],
            },
        );
        config
            .assignments
            .insert("openai".to_owned(), "shared".to_owned());
        let original = EgressPools::new(&config).unwrap();
        config
            .assignments
            .insert("anthropic".to_owned(), "shared".to_owned());
        let reused = EgressPools::new_reusing(&config, Some(&original)).unwrap();
        assert!(Arc::ptr_eq(
            &original.assigned("openai").unwrap(),
            &reused.assigned("anthropic").unwrap()
        ));
        config.pools.get_mut("shared").unwrap().endpoints[0].url =
            "http://127.0.0.1:8081".to_owned();
        let changed = EgressPools::new_reusing(&config, Some(&reused)).unwrap();
        assert!(!Arc::ptr_eq(
            &original.assigned("openai").unwrap(),
            &changed.assigned("openai").unwrap()
        ));
    }
}
