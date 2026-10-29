//! Shipped Bytebot manifest through the native registry and canonical facade.
//! Only the authored daemon port is redirected to an ephemeral loopback fixture.
//! No real desktop input, external accounts, or Bytebot daemon is contacted.
use super::*;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use std::sync::Arc;

const MANIFEST: &str =
    include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/bytebot/manifest.json");
const SCROLL_ADAPTER: &str =
    include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/bytebot/adapters/computer.scroll.js");
const CHILD: &str = "RYU_BYTEBOT_REGISTRY_FIXTURE_CHILD";
const TEST_NAME: &str = "sidecar::mcp::tests::bytebot_registry_runtime::bytebot_canonical_verbs_dispatch_with_grants_and_failures";
type Observed = Arc<tokio::sync::Mutex<Vec<Value>>>;

#[tokio::test]
async fn bytebot_canonical_verbs_dispatch_with_grants_and_failures() {
    if std::env::var_os(CHILD).is_none() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(CHILD, "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env("RYU_ALLOW_GATEWAY_FALLBACK", "1")
            .env("RYU_EXEC_APPROVAL_MODE", "off")
            .env_remove("RYU_GATEWAY_REMOTE")
            .status()
            .unwrap();
        assert!(status.success(), "isolated Bytebot fixture failed");
        return;
    }
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_GATEWAY_TOKEN");
    let mut manifest = PluginManifest::parse_and_validate_with_code(MANIFEST, |path| match path {
        "adapters/computer.scroll.js" => Ok(SCROLL_ADAPTER.to_string()),
        _ => Err(format!("unexpected Bytebot fragment {path}")),
    })
    .unwrap();
    let observed: Observed = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/computer-use", post(fixture))
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    for runnable in &mut manifest.runnables {
        let config = runnable.config.as_mut().unwrap();
        let mut url = reqwest::Url::parse(config["url"].as_str().unwrap()).unwrap();
        assert_eq!(url.as_str(), "http://127.0.0.1:9990/computer-use");
        url.set_port(Some(address.port())).unwrap();
        config["url"] = Value::String(url.to_string());
    }
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(&manifest.id, &manifest.version).await.unwrap();
    store
        .set_enabled(&manifest.id, &manifest.permission_grants)
        .await
        .unwrap();
    let manifests = Arc::new(TokioRwLock::new(vec![manifest]));
    let registry = Arc::new(McpRegistry::empty().with_self_build(manifests.clone(), store.clone()));
    // The computer.scroll adapter re-enters dispatch through the published registry.
    crate::sidecar::mcp::set_global_registry(registry.clone());
    for slug in [
        "bytebot.screenshot",
        "bytebot.click",
        "bytebot.type_text",
        "bytebot.type_keys",
        "bytebot.scroll",
        "bytebot.application",
    ] {
        registry.register_app_tool(slug.into(), slug.into(), None);
    }
    crate::plugins::binding::set_active_config(crate::plugins::binding::BindingConfig {
        overrides: [("computer.control".into(), "@ryu/bytebot".into())]
            .into_iter()
            .collect(),
    });
    let cases = [
        (
            "computer.capture",
            serde_json::json!({}),
            serde_json::json!({"action":"screenshot"}),
        ),
        (
            "computer.click",
            serde_json::json!({"x":41,"y":73}),
            serde_json::json!({"action":"click_mouse","coordinates":{"x":41,"y":73},"button":"left","clickCount":1}),
        ),
        (
            "computer.click",
            serde_json::json!({"x":21,"y":32,"button":"right","count":2}),
            serde_json::json!({"action":"click_mouse","coordinates":{"x":21,"y":32},"button":"right","clickCount":2}),
        ),
        (
            "computer.type",
            serde_json::json!({"text":"fixture text"}),
            serde_json::json!({"action":"type_text","text":"fixture text"}),
        ),
        (
            "computer.key",
            serde_json::json!({"keys":["ctrl","s"]}),
            serde_json::json!({"action":"type_keys","keys":["ctrl","s"]}),
        ),
        (
            "computer.scroll",
            serde_json::json!({"direction":"down","amount":500,"x":41,"y":73}),
            serde_json::json!({"action":"scroll","direction":"down","scrollCount":10,"coordinates":{"x":41,"y":73}}),
        ),
        (
            "computer.scroll",
            serde_json::json!({"direction":"right","x":12}),
            serde_json::json!({"action":"scroll","direction":"right","scrollCount":3}),
        ),
        (
            "computer.scroll",
            serde_json::json!({"direction":"up","amount":0}),
            serde_json::json!({"action":"scroll","direction":"up","scrollCount":1}),
        ),
        (
            "computer.scroll",
            serde_json::json!({"direction":"left"}),
            serde_json::json!({"action":"scroll","direction":"left","scrollCount":3}),
        ),
    ];
    for (verb, args, expected) in cases {
        let before = observed.lock().await.len();
        let result = registry
            .call_tool(verb, args, Some(&[verb.into()]))
            .await
            .unwrap();
        assert_eq!(result["provider"], "@ryu/bytebot");
        let raw = if verb == "computer.capture" {
            serde_json::json!({"image":"fixture-png"})
        } else {
            serde_json::json!({"status":201,"body":""})
        };
        assert_eq!(result["raw"], raw);
        let events = observed.lock().await;
        assert_eq!(events.len(), before + 1);
        assert_eq!(events.last().unwrap()["body"], expected);
        assert_eq!(events.last().unwrap()["authorization"], Value::Null);
    }
    let result = registry
        .call_tool(
            "bytebot.application",
            serde_json::json!({"application":"terminal"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(result, serde_json::json!({"status":201,"body":""}));
    assert_eq!(
        observed.lock().await.last().unwrap()["body"],
        serde_json::json!({"action":"application","application":"terminal"})
    );
    let before = observed.lock().await.len();
    let failure = registry
        .call_tool(
            "bytebot.type_text",
            serde_json::json!({"text":"fixture-unavailable"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        failure,
        serde_json::json!({"status":503,"body":{"error":"fixture unavailable"}})
    );
    assert_eq!(observed.lock().await.len(), before + 1, "no hidden retry");
    registry
        .call_tool(
            "bytebot.type_text",
            serde_json::json!({"text":"recovered"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        observed.lock().await.last().unwrap()["body"],
        serde_json::json!({"action":"type_text","text":"recovered"})
    );
    manifests.write().await[0].permission_grants.clear();
    store.set_enabled("@ryu/bytebot", &[]).await.unwrap();
    let before = observed.lock().await.len();
    let error = registry
        .call_tool("bytebot.screenshot", serde_json::json!({}), None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not granted"));
    assert_eq!(
        observed.lock().await.len(),
        before,
        "grant denial precedes HTTP"
    );
    let grants = vec![
        "tool:http-egress:127.0.0.1".into(),
        crate::tool_exec::GRANT_TOOL_EXECUTE.into(),
    ];
    manifests.write().await[0].permission_grants = grants.clone();
    store.set_enabled("@ryu/bytebot", &grants).await.unwrap();
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
    let error = registry
        .call_tool("bytebot.screenshot", serde_json::json!({}), None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("http tool request failed:"));
}

async fn fixture(
    State(observed): State<Observed>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    observed.lock().await.push(serde_json::json!({"body":body,"authorization":headers.get("authorization").and_then(|v|v.to_str().ok())}));
    if body["text"] == "fixture-unavailable" {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error":"fixture unavailable"})),
        )
            .into_response();
    }
    if body["action"] == "screenshot" {
        (
            StatusCode::CREATED,
            Json(serde_json::json!({"image":"fixture-png"})),
        )
            .into_response()
    } else {
        StatusCode::CREATED.into_response()
    }
}
