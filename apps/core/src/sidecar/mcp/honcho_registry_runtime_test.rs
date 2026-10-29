//! End-to-end registry proof for the shipped Honcho memory capability.
//!
//! The test starts from the actual Marketplace manifest, then localizes only
//! the search origin and its corresponding egress grant. Core requires HTTPS
//! for secret headers, so the fixture copy removes that header; the separate
//! tool-exec tests cover the fake-secret resolver/projection contract.

use super::McpRegistry;
use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::Value;
use std::sync::Arc;

const HONCHO_MANIFEST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/honcho/manifest.json");
const HONCHO_PLUGIN_ID: &str = "@ryu/honcho";
const LOCAL_EGRESS_GRANT: &str = "tool:http-egress:127.0.0.1";
const TEST_API_KEY: &str = "honcho-test-key-not-real";

#[test]
fn memory_search_dispatches_through_registry_with_manifest_defaults_and_grants() {
    std::thread::Builder::new()
        .name("honcho-registry-stack-proof".into())
        .stack_size(2 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(memory_search_registry_proof())
        })
        .unwrap()
        .join()
        .expect("full governed memory search must finish on an ordinary worker stack");
}

async fn memory_search_registry_proof() {
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = GatewayEnvGuard::armed();
    let _fake_key = EnvOverride::set("RYU_HONCHO_API_KEY", TEST_API_KEY);
    let _binding_config = ActiveBindingConfigGuard::select_honcho();

    let source_manifest: crate::plugin_manifest::PluginManifest =
        serde_json::from_str(HONCHO_MANIFEST).expect("valid shipped Honcho manifest");
    assert_eq!(source_manifest.id, HONCHO_PLUGIN_ID);
    assert_eq!(
        source_manifest.permission_grants,
        vec!["tool:http-egress:api.honcho.dev", "tool:execute"]
    );
    let source_search = source_manifest
        .runnables
        .iter()
        .find(|runnable| runnable.id == "tool-honcho-search")
        .and_then(|runnable| runnable.config.as_ref())
        .expect("shipped Honcho search runnable");
    assert_eq!(
        source_search["secret_headers"]["Authorization"],
        "Bearer env:RYU_HONCHO_API_KEY"
    );

    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind local Honcho registry fixture");
    let address = listener.local_addr().expect("fixture address");
    let app = Router::new()
        .route(
            "/v3/workspaces/workspace-a/peers/user-7/search",
            post(honcho_registry_fixture_request),
        )
        .route(
            "/v3/workspaces/workspace-b/peers/user-8/search",
            post(honcho_registry_fixture_request),
        )
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve local Honcho registry fixture");
    });

    let localized_manifest = localize_search_manifest(source_manifest, address.port());
    assert_eq!(
        crate::plugins::builtins::tier_for_manifest(&localized_manifest),
        crate::plugin_manifest::PluginTier::Community
    );
    assert_eq!(
        localized_manifest.permission_grants,
        vec![LOCAL_EGRESS_GRANT.to_owned()]
    );

    let preferences_dir = tempfile::tempdir().expect("isolated preferences directory");
    let preferences = crate::server::preferences::PreferencesStore::open(
        preferences_dir.path().join("preferences.sqlite"),
    )
    .expect("open isolated preferences store");
    preferences
        .set("honcho.workspace-id", "workspace-a")
        .await
        .expect("set workspace preference");
    preferences
        .set("honcho.peer-id", "user-7")
        .await
        .expect("set peer preference");

    let approved_grants = vec![LOCAL_EGRESS_GRANT.to_owned()];
    let registry = registry_with_honcho(
        localized_manifest.clone(),
        approved_grants,
        preferences.clone(),
    )
    .await;
    let resolved = registry
        .capability_verbs()
        .await
        .into_iter()
        .find(|resolved| resolved.verb.id == "memory.search")
        .expect("enabled registry resolves memory.search");
    assert_eq!(resolved.provider_id, HONCHO_PLUGIN_ID);
    assert_eq!(resolved.binding.tool, "honcho.search");

    // The canonical tool allowlist is enforced before the provider call.
    let wrong_allowlist = ["memory.context".to_owned()];
    let allowlist_error = call_memory_search(
        &registry,
        &wrong_allowlist,
        serde_json::json!({ "query": "release notes" }),
    )
    .await
    .expect_err("a caller without memory.search permission is refused");
    assert!(
        allowlist_error
            .to_string()
            .contains("not in this agent's allowlist"),
        "unexpected allowlist refusal: {allowlist_error}"
    );
    assert!(
        observed.lock().await.is_empty(),
        "denied call never reaches HTTP"
    );

    let allowed = ["memory.search".to_owned()];
    let default_limit = call_memory_search(
        &registry,
        &allowed,
        serde_json::json!({
            "query": "release notes",
            "scope": "user"
        }),
    )
    .await
    .expect("memory.search reaches the selected Honcho provider");
    assert_eq!(
        default_limit,
        serde_json::json!({
            "provider": "@ryu/honcho",
            "results": [{
                "id": "message-1",
                "content": "Release notes stay concise.",
                "raw": {
                    "id": "message-1",
                    "content": "Release notes stay concise.",
                    "peer_id": "user-7"
                }
            }]
        })
    );

    // Preference-backed provider defaults are read on every dispatch, while
    // canonical caller query/limit values pass through the same registry mapper.
    preferences
        .set("honcho.workspace-id", "workspace-b")
        .await
        .expect("change workspace preference");
    preferences
        .set("honcho.peer-id", "user-8")
        .await
        .expect("change peer preference");
    let override_result = call_memory_search(
        &registry,
        &allowed,
        serde_json::json!({
            "query": "explicit limit",
            "limit": 2,
            "scope": "project"
        }),
    )
    .await
    .expect("explicit query and limit reach the selected provider");
    assert_eq!(
        override_result,
        serde_json::json!({
            "provider": "@ryu/honcho",
            "results": [
                {
                    "id": "message-2",
                    "content": "First matching message.",
                    "raw": {
                        "id": "message-2",
                        "content": "First matching message.",
                        "peer_id": "user-8"
                    }
                },
                {
                    "id": "message-3",
                    "content": "Second matching message.",
                    "raw": {
                        "id": "message-3",
                        "content": "Second matching message.",
                        "peer_id": "user-8"
                    }
                }
            ]
        })
    );

    let auth_failure = call_memory_search(
        &registry,
        &allowed,
        serde_json::json!({
            "query": "fixture-auth-failure",
            "limit": 4
        }),
    )
    .await
    .expect("Honcho 401 remains a fail-open capability result");
    assert_eq!(
        auth_failure,
        serde_json::json!({
            "provider": "@ryu/honcho",
            "raw": {
                "available": false,
                "reason": "endpoint returned HTTP 401",
                "hint": "The endpoint is unreachable or rejected the request; check the key/host and retry."
            }
        })
    );

    // The enabled Community plugin runs with the record's approved grants. A
    // registry with the same shipped tool but no approved loopback grant refuses
    // before the fixture sees the request.
    let no_grant_registry = registry_with_honcho(localized_manifest, Vec::new(), preferences).await;
    let no_grant_error = call_memory_search(
        &no_grant_registry,
        &allowed,
        serde_json::json!({
            "query": "must not reach fixture",
            "limit": 1
        }),
    )
    .await
    .expect_err("the provider's approved egress grant is required");
    assert!(
        no_grant_error.to_string().contains("not granted")
            && no_grant_error.to_string().contains("127.0.0.1"),
        "unexpected egress refusal: {no_grant_error}"
    );

    let requests = observed.lock().await.clone();
    let host = format!("127.0.0.1:{}", address.port());
    assert_eq!(
        requests,
        vec![
            serde_json::json!({
                "method": "POST",
                "uri": "/v3/workspaces/workspace-a/peers/user-7/search",
                "path": "/v3/workspaces/workspace-a/peers/user-7/search",
                "query": Value::Null,
                "host": host,
                "authorization": Value::Null,
                "body": { "query": "release notes" }
            }),
            serde_json::json!({
                "method": "POST",
                "uri": "/v3/workspaces/workspace-b/peers/user-8/search",
                "path": "/v3/workspaces/workspace-b/peers/user-8/search",
                "query": Value::Null,
                "host": host,
                "authorization": Value::Null,
                "body": { "query": "explicit limit", "limit": 2 }
            }),
            serde_json::json!({
                "method": "POST",
                "uri": "/v3/workspaces/workspace-b/peers/user-8/search",
                "path": "/v3/workspaces/workspace-b/peers/user-8/search",
                "query": Value::Null,
                "host": host,
                "authorization": Value::Null,
                "body": { "query": "fixture-auth-failure", "limit": 4 }
            })
        ],
        "only approved registry calls reach the local endpoint with mapped args"
    );
    assert!(requests
        .iter()
        .all(|request| !request["body"].to_string().contains(TEST_API_KEY)));
    assert!(requests.iter().all(|request| {
        !request["body"].to_string().contains("caller-user-sentinel")
            && !request["body"]
                .to_string()
                .contains("host-conversation-sentinel")
            && !request["body"].to_string().contains("profile-sentinel")
    }));

    server.abort();
}

fn localize_search_manifest(
    mut manifest: crate::plugin_manifest::PluginManifest,
    port: u16,
) -> crate::plugin_manifest::PluginManifest {
    let search = manifest
        .runnables
        .iter_mut()
        .find(|runnable| runnable.id == "tool-honcho-search")
        .and_then(|runnable| runnable.config.as_mut())
        .and_then(Value::as_object_mut)
        .expect("search tool config");
    let remote_url = search
        .get("url")
        .and_then(Value::as_str)
        .expect("search URL");
    let path = remote_url
        .strip_prefix("https://api.honcho.dev")
        .filter(|path| path.starts_with("/v3/workspaces/{workspace_id}/peers/{peer_id}/search"))
        .expect("shipped Honcho search endpoint path");
    search.insert(
        "url".to_owned(),
        Value::String(format!("http://127.0.0.1:{port}{path}")),
    );
    // Core refuses all secret headers on plain HTTP. The package's source secret
    // template was asserted above; remove it only from this fixture copy.
    search.remove("secret_headers");
    manifest.permission_grants = vec![LOCAL_EGRESS_GRANT.to_owned()];
    manifest
}

async fn registry_with_honcho(
    manifest: crate::plugin_manifest::PluginManifest,
    approved_grants: Vec<String>,
    preferences: crate::server::preferences::PreferencesStore,
) -> McpRegistry {
    let store =
        Arc::new(crate::plugins::PluginStore::open_in_memory().expect("in-memory plugin store"));
    store
        .insert(&manifest.id, &manifest.version)
        .await
        .expect("install Honcho in the registry fixture");
    store
        .set_enabled(&manifest.id, &approved_grants)
        .await
        .expect("enable Honcho fixture")
        .expect("Honcho record exists");

    let manifests = Arc::new(tokio::sync::RwLock::new(vec![manifest]));
    let mut registry = McpRegistry::empty().with_self_build(manifests, store);
    registry.preferences = Some(preferences);
    registry.register_app_tool("honcho.search".to_owned(), "Honcho Search".to_owned(), None);
    registry
}

async fn call_memory_search(
    registry: &McpRegistry,
    allowlist: &[String],
    arguments: Value,
) -> anyhow::Result<Value> {
    let profile_ids = vec!["profile-sentinel".to_owned()];
    let future = registry.call_tool_with_identity(
        None,
        "memory.search",
        arguments,
        Some(allowlist),
        Some("caller-user-sentinel"),
        &profile_ids,
        Some("session-sentinel".to_owned()),
        Some("host-conversation-sentinel"),
    );
    // Prevent a new unboxed dispatch branch from silently inflating every
    // production caller again. The actual HTTP flow above is still the oracle.
    assert!(
        std::mem::size_of_val(&future) <= 32 * 1024,
        "governed dispatch future is {} bytes",
        std::mem::size_of_val(&future)
    );
    future.await
}

async fn honcho_registry_fixture_request(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read registry request body");
    let body: Value = serde_json::from_slice(&bytes).expect("registry sends JSON body");
    let record = serde_json::json!({
        "method": parts.method.as_str(),
        "uri": parts.uri.to_string(),
        "path": parts.uri.path(),
        "query": parts.uri.query(),
        "host": parts.headers.get("host").and_then(|value| value.to_str().ok()),
        "authorization": parts.headers.get("authorization").and_then(|value| value.to_str().ok()),
        "body": body,
    });
    observed.lock().await.push(record.clone());

    match record["body"]["query"].as_str() {
        Some("fixture-auth-failure") => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "fixture rejects auth" })),
        )
            .into_response(),
        Some("release notes") => Json(serde_json::json!([{
            "id": "message-1",
            "content": "Release notes stay concise.",
            "peer_id": "user-7"
        }]))
        .into_response(),
        Some("explicit limit") => Json(serde_json::json!([
            {
                "id": "message-2",
                "content": "First matching message.",
                "peer_id": "user-8"
            },
            {
                "id": "message-3",
                "content": "Second matching message.",
                "peer_id": "user-8"
            }
        ]))
        .into_response(),
        _ => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "unexpected query" })),
        )
            .into_response(),
    }
}

struct GatewayEnvGuard {
    previous_gateway_url: Option<String>,
    previous_fallback: Option<String>,
    previous_exec_mode: Option<String>,
}

impl GatewayEnvGuard {
    fn armed() -> Self {
        let previous_gateway_url = std::env::var("RYU_GATEWAY_URL").ok();
        let previous_fallback = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
        let previous_exec_mode = std::env::var("RYU_EXEC_APPROVAL_MODE").ok();
        std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
        std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", "1");
        std::env::set_var("RYU_EXEC_APPROVAL_MODE", "off");
        Self {
            previous_gateway_url,
            previous_fallback,
            previous_exec_mode,
        }
    }
}

impl Drop for GatewayEnvGuard {
    fn drop(&mut self) {
        restore_env("RYU_GATEWAY_URL", self.previous_gateway_url.take());
        restore_env("RYU_ALLOW_GATEWAY_FALLBACK", self.previous_fallback.take());
        restore_env("RYU_EXEC_APPROVAL_MODE", self.previous_exec_mode.take());
    }
}

struct EnvOverride {
    name: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvOverride {
    fn set(name: &'static str, value: &str) -> Self {
        let previous = std::env::var_os(name);
        std::env::set_var(name, value);
        Self { name, previous }
    }
}

impl Drop for EnvOverride {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var(self.name, value),
            None => std::env::remove_var(self.name),
        }
    }
}

struct ActiveBindingConfigGuard(crate::plugins::binding::BindingConfig);

impl ActiveBindingConfigGuard {
    fn select_honcho() -> Self {
        let previous = crate::plugins::binding::active_config();
        let mut active = crate::plugins::binding::BindingConfig::default();
        active
            .overrides
            .insert("memory".to_owned(), HONCHO_PLUGIN_ID.to_owned());
        crate::plugins::binding::set_active_config(active);
        Self(previous)
    }
}

impl Drop for ActiveBindingConfigGuard {
    fn drop(&mut self) {
        crate::plugins::binding::set_active_config(self.0.clone());
    }
}

fn restore_env(name: &str, value: Option<String>) {
    match value {
        Some(value) => std::env::set_var(name, value),
        None => std::env::remove_var(name),
    }
}
