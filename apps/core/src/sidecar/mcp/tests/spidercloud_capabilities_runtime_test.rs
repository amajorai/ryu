//! Canonical Spider Cloud routing using its shipped declarative binding.
//! Only transport origin/grants change. Synthetic credentials must be refused
//! over plaintext with explicit operator approval. Revocation retains authored
//! credential templates; the fixture proves no hosted crawler behavior.
use super::*;
use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};
use std::sync::Arc;

const RAW: &str = include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/spidercloud/manifest.json");
const CHILD: &str = "RYU_SPIDERCLOUD_CANONICAL_CHILD";
const TEST: &str = "sidecar::mcp::tests::spidercloud_capabilities_runtime::shipped_spidercloud_canonical_crawl_maps_defaults_clamps_errors_and_grants";
const PAGE: &str = "https://fixture.invalid/page";
#[derive(Default)]
struct Fixture {
    requests: Vec<Value>,
    status: u16,
}
type Shared = Arc<tokio::sync::Mutex<Fixture>>;

#[tokio::test]
async fn shipped_spidercloud_canonical_crawl_maps_defaults_clamps_errors_and_grants() {
    if std::env::var_os(CHILD).is_none() {
        let dir = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .args(["--exact", TEST, "--nocapture"])
            .env(CHILD, "1")
            .env("RUST_MIN_STACK", "16777216")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env("RYU_ALLOW_GATEWAY_FALLBACK", "1")
            .env("RYU_EXEC_APPROVAL_MODE", "off")
            .env("RYU_SPIDERCLOUD_API_KEY", "synthetic-spidercloud-key")
            .env_remove("RYU_GATEWAY_REMOTE")
            .env_remove("RYU_PLUGIN_ENV_ALLOWLIST");
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            child.env_remove(key);
        }
        assert!(
            child.status().unwrap().success(),
            "isolated Spider Cloud canonical fixture failed"
        );
        return;
    }
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_GATEWAY_TOKEN");
    let state: Shared = Arc::new(tokio::sync::Mutex::new(Fixture::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().fallback(endpoint).with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut manifest = PluginManifest::parse_and_validate_with_code(RAW, |path| {
        Err(format!("unexpected code {path}"))
    })
    .unwrap();
    let config = manifest.runnables[0].config.as_mut().unwrap();
    assert_eq!(config["url"], "https://api.spider.cloud/crawl");
    assert_eq!(
        config["secret_headers"]["Authorization"],
        "Bearer env:RYU_SPIDERCLOUD_API_KEY"
    );
    config["url"] = Value::String(format!("http://{address}/crawl"));
    manifest.permission_grants = vec!["tool:http-egress:127.0.0.1".into()];
    let grants = manifest.permission_grants.clone();
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(&manifest.id, &manifest.version).await.unwrap();
    store.set_enabled(&manifest.id, &grants).await.unwrap();
    let manifests = Arc::new(TokioRwLock::new(vec![manifest]));
    let registry = Arc::new(McpRegistry::empty().with_self_build(manifests.clone(), store.clone()));
    registry.register_app_tool("spidercloud.crawl".into(), "spidercloud.crawl".into(), None);
    set_global_registry(registry.clone());
    crate::plugins::binding::set_active_config(crate::plugins::binding::BindingConfig {
        overrides: [("web.crawl".into(), "@ryu/spidercloud".into())]
            .into_iter()
            .collect(),
    });
    let args = serde_json::json!({"url":PAGE,"depth":0,"limit":100});
    assert!(std::env::var_os("RYU_PLUGIN_ENV_ALLOWLIST").is_none());
    // A changed origin makes this a localized package, without shared-key trust.
    let anonymous = registry
        .call_tool("web.crawl", args.clone(), None)
        .await
        .unwrap();
    assert_eq!(anonymous["provider"], "@ryu/spidercloud");
    assert_eq!(anonymous["results"][0]["url"], PAGE);
    let anonymous_requests = state.lock().await.requests.clone();
    assert_eq!(
        anonymous_requests,
        vec![serde_json::json!({
            "method":"POST","path":"/crawl","authorization":null,
            "body":{"url":PAGE,"limit":25,"depth":3,"return_format":"markdown","request":"smart","metadata":true}
        })]
    );
    assert!(!anonymous.to_string().contains("synthetic-spidercloud-key"));
    // Explicit operator approval reaches the real HTTPS credential guard.
    std::env::set_var("RYU_PLUGIN_ENV_ALLOWLIST", "RYU_SPIDERCLOUD_API_KEY");
    let refusal = registry
        .call_tool("web.crawl", args.clone(), None)
        .await
        .unwrap_err();
    assert!(
        refusal
            .to_string()
            .contains("secret headers require an HTTPS destination"),
        "{refusal}"
    );
    assert!(!refusal.to_string().contains("synthetic-spidercloud-key"));
    assert_eq!(state.lock().await.requests, anonymous_requests);
    assert_eq!(
        std::env::var("RYU_PLUGIN_ENV_ALLOWLIST").unwrap(),
        "RYU_SPIDERCLOUD_API_KEY"
    );
    std::env::remove_var("RYU_PLUGIN_ENV_ALLOWLIST");
    // Keep authored secret_headers; each later canonical dispatch observes revocation.
    let denied = registry
        .call_tool("web.crawl", args.clone(), Some(&["web.extract".into()]))
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("not in this agent's allowlist"));
    assert_eq!(state.lock().await.requests, anonymous_requests);
    for (arguments, limit) in [
        (args.clone(), 25),
        (serde_json::json!({"url":PAGE,"depth":9,"limit":0}), 1),
        (serde_json::json!({"url":PAGE}), 10),
    ] {
        let before = state.lock().await.requests.len();
        let result = registry
            .call_tool("web.crawl", arguments, Some(&["web.crawl".into()]))
            .await
            .unwrap();
        assert_eq!(result["provider"], "@ryu/spidercloud");
        assert_eq!(result["results"][0]["url"], PAGE);
        assert_eq!(result["results"][0]["title"], "Fixture title");
        assert_eq!(result["results"][0]["content"], "Fixture markdown");
        let requests = &state.lock().await.requests;
        assert_eq!(requests.len(), before + 1);
        assert_eq!(
            requests[before],
            serde_json::json!({"method":"POST","path":"/crawl","authorization":null,"body":{"url":PAGE,"limit":limit,"depth":3,"return_format":"markdown","request":"smart","metadata":true}})
        );
    }
    let healthy = registry
        .call_tool("web.crawl", args.clone(), None)
        .await
        .unwrap();
    for status in [401, 403, 429, 503] {
        let before = state.lock().await.requests.len();
        state.lock().await.status = status;
        let failed = registry
            .call_tool("web.crawl", args.clone(), None)
            .await
            .unwrap();
        if status == 401 || status == 403 {
            assert_eq!(
                failed,
                serde_json::json!({
                    "provider":"@ryu/spidercloud",
                    "raw": {
                        "available":false,
                        "reason":format!("endpoint returned HTTP {status}"),
                        "hint":"The endpoint is unreachable or rejected the request; check the key/host and retry."
                    }
                })
            );
        } else {
            // The shipped response mapper locates `body` even on non-2xx.
            // It preserves the error there as an item's raw, without inventing
            // page fields. Native HTTP tests separately assert the status envelope.
            assert_eq!(
                failed,
                serde_json::json!({
                    "provider":"@ryu/spidercloud",
                    "results":[{"raw":{"error":"fixture refusal"}}]
                })
            );
        }
        assert_eq!(
            state.lock().await.requests.len(),
            before + 1,
            "one failed request for HTTP {status}"
        );
        state.lock().await.status = 0;
        assert_eq!(
            registry
                .call_tool("web.crawl", args.clone(), None)
                .await
                .unwrap(),
            healthy
        );
        assert_eq!(
            state.lock().await.requests.len(),
            before + 2,
            "one explicit retry for HTTP {status}"
        );
    }
    manifests.write().await[0].permission_grants.clear();
    store.set_enabled("@ryu/spidercloud", &[]).await.unwrap();
    let before = state.lock().await.requests.len();
    let denied = registry
        .call_tool("web.crawl", args.clone(), None)
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("not granted"));
    assert_eq!(state.lock().await.requests.len(), before);
    manifests.write().await[0].permission_grants = grants.clone();
    store
        .set_enabled("@ryu/spidercloud", &grants)
        .await
        .unwrap();
    assert_eq!(
        registry
            .call_tool("web.crawl", args.clone(), None)
            .await
            .unwrap(),
        healthy
    );
    assert!(state
        .lock()
        .await
        .requests
        .iter()
        .all(|request| request["authorization"].is_null()));
    assert!(!serde_json::to_string(&state.lock().await.requests)
        .unwrap()
        .contains("synthetic-spidercloud-key"));
    assert_eq!(
        manifests.read().await[0].runnables[0]
            .config
            .as_ref()
            .unwrap()["secret_headers"]["Authorization"],
        "Bearer env:RYU_SPIDERCLOUD_API_KEY"
    );
    server.abort();
    let _ = server.await;
    let stopped = registry.call_tool("web.crawl", args, None).await.unwrap();
    assert_eq!(stopped["raw"]["available"], false);
}

async fn endpoint(State(state): State<Shared>, request: Request<Body>) -> Response {
    let (parts, body) = request.into_parts();
    let body: Value =
        serde_json::from_slice(&axum::body::to_bytes(body, 1024 * 1024).await.unwrap()).unwrap();
    let mut fixture = state.lock().await;
    fixture.requests.push(serde_json::json!({"method":parts.method.as_str(),"path":parts.uri.path(),"authorization":parts.headers.get("authorization").and_then(|value| value.to_str().ok()),"body":body}));
    if fixture.status != 0 {
        return (
            StatusCode::from_u16(fixture.status).unwrap(),
            Json(serde_json::json!({"error":"fixture refusal"})),
        )
            .into_response();
    }
    Json(serde_json::json!([{"url":PAGE,"metadata":{"title":"Fixture title"},"content":"Fixture markdown"}])).into_response()
}
