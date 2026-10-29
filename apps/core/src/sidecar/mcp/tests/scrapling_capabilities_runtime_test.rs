//! The shipped Scrapling adapter through Core's JS sandbox and MCP HTTP transports.
//! The BYO stdio server is replaced only by a local protocol endpoint. No pip
//! package, scraper network request or browser install is claimed by this proof.
use super::*;
use axum::{extract::State, routing::post, Json, Router};
use std::sync::Arc;
const RAW: &str = include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/scrapling/manifest.json");
const CHILD: &str = "RYU_SCRAPLING_CANONICAL_CHILD";
const TEST: &str = "sidecar::mcp::tests::scrapling_capabilities_runtime::shipped_scrapling_adapter_routes_formats_chunks_failures_and_grants";
const PAGE: &str = "https://fixture.invalid/page";
#[derive(Default)]
struct Fixture {
    calls: Vec<Value>,
    discovery_refusals: usize,
    legacy_initializations: usize,
    mode: u8,
}
type Shared = Arc<tokio::sync::Mutex<Fixture>>;

#[tokio::test]
async fn shipped_scrapling_adapter_routes_formats_chunks_failures_and_grants() {
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
            .env_remove("RYU_GATEWAY_REMOTE");
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
            "isolated Scrapling fixture failed"
        );
        return;
    }
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_GATEWAY_TOKEN");
    let state: Shared = Arc::new(tokio::sync::Mutex::new(Fixture::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let _allowed = allow_discovery_test_host(address);
    let app = Router::new()
        .route("/mcp", post(endpoint))
        .with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut raw: Value = serde_json::from_str(RAW).unwrap();
    assert_eq!(raw["mcp_servers"]["scrapling"]["command"], "scrapling");
    assert_eq!(
        raw["mcp_servers"]["scrapling"]["args"],
        serde_json::json!(["mcp"])
    );
    raw["mcp_servers"]["scrapling"] =
        serde_json::json!({"type":"streamable-http","url":format!("http://{address}/mcp")});
    let manifest = PluginManifest::parse_and_validate_with_code(&raw.to_string(), |path| {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../generated/ryu-runtime/plugins-store/plugins/scrapling")
                .join(path),
        )
        .map_err(|error| error.to_string())
    })
    .unwrap();
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(&manifest.id, &manifest.version).await.unwrap();
    let mut approved = manifest.permission_grants.clone();
    approved.push(GRANT_MCP_SERVER.to_owned());
    store.set_enabled(&manifest.id, &approved).await.unwrap();
    let manifests = Arc::new(TokioRwLock::new(vec![manifest.clone()]));
    let registry = Arc::new(McpRegistry::empty().with_self_build(manifests.clone(), store.clone()));
    let tier = crate::plugins::builtins::tier_for_manifest(&manifest);
    assert_eq!(tier, crate::plugin_manifest::PluginTier::Community);
    assert!(
        register_manifest_mcp_servers(&registry, &manifest, tier, &manifest.permission_grants)
            .is_empty()
    );
    assert_eq!(
        register_manifest_mcp_servers(&registry, &manifest, tier, &approved),
        ["scrapling"]
    );
    // Registration approval does not substitute for an active owner generation.
    let runtime = crate::plugins::runtime::PluginRuntime::new();
    registry.set_plugin_runtime(runtime.clone());
    let before_inactive = {
        let fixture = state.lock().await;
        (
            fixture.discovery_refusals,
            fixture.legacy_initializations,
            fixture.calls.len(),
        )
    };
    let inactive = registry.tools_for_server("scrapling").await.unwrap_err();
    assert!(inactive.to_string().contains("owning plugin is inactive"));
    {
        let fixture = state.lock().await;
        assert_eq!(
            (
                fixture.discovery_refusals,
                fixture.legacy_initializations,
                fixture.calls.len()
            ),
            before_inactive
        );
    }
    runtime.begin_activation(&manifest.id).await.commit();
    set_global_registry(registry.clone());
    crate::plugins::binding::set_active_config(crate::plugins::binding::BindingConfig {
        overrides: [("web.extract".into(), "@ryu/scrapling".into())]
            .into_iter()
            .collect(),
    });
    let args = serde_json::json!({"url":PAGE});
    let denied = registry
        .call_tool("web.extract", args.clone(), Some(&["web.crawl".into()]))
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("not in this agent's allowlist"));
    assert!(state.lock().await.calls.is_empty());
    for format in [None, Some("text"), Some("html")] {
        let mut args = args.clone();
        if let Some(format) = format {
            args["format"] = Value::String(format.into());
        }
        let before = state.lock().await.calls.len();
        let result = registry.call_tool("web.extract", args, None).await.unwrap();
        assert_eq!(result["provider"], "@ryu/scrapling");
        assert_eq!(
            result["results"][0]["url"],
            "https://fixture.invalid/resolved"
        );
        assert_eq!(result["results"][0]["content"], "First\n\nSecond");
        assert_eq!(
            result["results"][0]["raw"],
            tool_result(0)["structuredContent"]
        );
        let calls = &state.lock().await.calls;
        assert_eq!(calls.len(), before + 1);
        assert_eq!(calls[before]["name"], "get");
        assert_eq!(
            calls[before]["arguments"],
            serde_json::json!({"url":PAGE,"extraction_type":format.unwrap_or("markdown")})
        );
    }
    let healthy = registry
        .call_tool("web.extract", args.clone(), None)
        .await
        .unwrap();
    for mode in [1, 2] {
        state.lock().await.mode = mode;
        let failed = registry
            .call_tool("web.extract", args.clone(), None)
            .await
            .unwrap();
        assert_eq!(failed["provider"], "@ryu/scrapling");
        assert_eq!(failed["raw"], tool_result(mode));
        assert!(
            failed.get("results").is_none(),
            "no fabricated empty page: {failed}"
        );
        state.lock().await.mode = 0;
        assert_eq!(
            registry
                .call_tool("web.extract", args.clone(), None)
                .await
                .unwrap(),
            healthy
        );
    }
    manifests.write().await[0]
        .permission_grants
        .retain(|grant| grant != "tool:execute");
    approved.retain(|grant| grant != "tool:execute");
    store
        .set_enabled("@ryu/scrapling", &approved)
        .await
        .unwrap();
    let before = state.lock().await.calls.len();
    let denied = registry
        .call_tool("web.extract", args.clone(), None)
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("tool:execute"));
    assert_eq!(state.lock().await.calls.len(), before);
    manifests.write().await[0]
        .permission_grants
        .push("tool:execute".into());
    approved.push("tool:execute".into());
    store
        .set_enabled("@ryu/scrapling", &approved)
        .await
        .unwrap();
    assert_eq!(
        registry.call_tool("web.extract", args, None).await.unwrap(),
        healthy
    );
    assert!(registry.deregister_server("@ryu/scrapling", "scrapling"));
    let fixture = state.lock().await;
    assert!(
        fixture.discovery_refusals > 0,
        "legacy compatibility must reject modern discovery explicitly"
    );
    assert!(
        fixture.legacy_initializations > 0,
        "client must actually complete legacy negotiation"
    );
    drop(fixture);
    server.abort();
}
fn tool_result(mode: u8) -> Value {
    match mode {
        1 => {
            serde_json::json!({"content":[{"type":"text","text":"fixture scraper unavailable"}],"isError":true})
        }
        2 => {
            serde_json::json!({"content":[{"type":"text","text":"untyped fixture response"}],"isError":false})
        }
        _ => {
            serde_json::json!({"content":[],"structuredContent":{"url":"https://fixture.invalid/resolved","content":["First","",null,"Second"],"status":200},"isError":false})
        }
    }
}
async fn endpoint(State(state): State<Shared>, Json(rpc): Json<Value>) -> Json<Value> {
    let result = match rpc["method"].as_str().unwrap() {
        // This fixture intentionally implements legacy MCP. Method-not-found
        // is the protocol evidence required for a safe modern-to-legacy fallback.
        "server/discover" => {
            state.lock().await.discovery_refusals += 1;
            return Json(
                serde_json::json!({"jsonrpc":"2.0","id":rpc["id"],"error":{"code":-32601,"message":"Legacy fixture does not implement server/discover"}}),
            );
        }
        "initialize" => {
            state.lock().await.legacy_initializations += 1;
            serde_json::json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"local-scrapling-protocol-fixture","version":"1"}})
        }
        "tools/list" => serde_json::json!({"tools":[]}),
        "tools/call" => {
            let mut fixture = state.lock().await;
            fixture.calls.push(rpc["params"].clone());
            tool_result(fixture.mode)
        }
        "notifications/initialized" => serde_json::json!({}),
        _ => {
            return Json(
                serde_json::json!({"jsonrpc":"2.0","id":rpc["id"],"error":{"code":-32601,"message":"Unknown fixture method"}}),
            )
        }
    };
    Json(serde_json::json!({"jsonrpc":"2.0","id":rpc["id"],"result":result}))
}
