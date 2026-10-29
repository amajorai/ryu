//! All shipped Ghost canonical bindings through real registry/MCP transport.
//! A local protocol endpoint replaces stdio; no Ghost process or OS effect runs.
use super::*;
use axum::{extract::State, routing::post, Json, Router};
use std::sync::Arc;
const RAW: &str = include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/ghost/manifest.json");
const CHILD: &str = "RYU_GHOST_CANONICAL_CHILD";
const TEST: &str = "sidecar::mcp::tests::ghost_capabilities_runtime::shipped_ghost_bindings_route_all_native_calls_and_refuse_unapproved_servers";
#[derive(Default)]
struct Fixture {
    calls: Vec<Value>,
    discovery_refusals: usize,
    legacy_initializations: usize,
    fail: bool,
}
type Shared = Arc<tokio::sync::Mutex<Fixture>>;

#[tokio::test]
async fn shipped_ghost_bindings_route_all_native_calls_and_refuse_unapproved_servers() {
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
            "isolated Ghost protocol fixture failed"
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
    assert_eq!(raw["mcp_servers"]["ghost"]["command"], "ghost");
    assert_eq!(raw["mcp_servers"]["ghost"]["command_env"], "RYU_GHOST_BIN");
    assert_eq!(
        raw["mcp_servers"]["ghost"]["args"],
        serde_json::json!(["mcp"])
    );
    raw["mcp_servers"]["ghost"] =
        serde_json::json!({"type":"streamable-http","url":format!("http://{address}/mcp")});
    let manifest = PluginManifest::parse_and_validate_with_code(&raw.to_string(), |path| {
        Err(format!("unexpected code {path}"))
    })
    .unwrap();
    assert!(manifest.runnables.is_empty());
    // Ghost is declarative: no adapter code exists, so tool:execute is neither
    // required nor manufactured. The substituted MCP server requires approval.
    assert_eq!(manifest.permission_grants, vec!["mcp:ghost"]);
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(&manifest.id, &manifest.version).await.unwrap();
    store
        .set_enabled(&manifest.id, &manifest.permission_grants)
        .await
        .unwrap();
    let manifests = Arc::new(TokioRwLock::new(vec![manifest.clone()]));
    let registry = Arc::new(McpRegistry::empty().with_self_build(manifests, store.clone()));
    let tier = crate::plugins::builtins::tier_for_manifest(&manifest);
    assert_eq!(tier, crate::plugin_manifest::PluginTier::Community);
    assert!(
        register_manifest_mcp_servers(&registry, &manifest, tier, &manifest.permission_grants)
            .is_empty()
    );
    let mut approved = manifest.permission_grants.clone();
    approved.push(GRANT_MCP_SERVER.to_owned());
    store.set_enabled(&manifest.id, &approved).await.unwrap();
    assert_eq!(
        register_manifest_mcp_servers(&registry, &manifest, tier, &approved),
        ["ghost"]
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
    let inactive = registry.tools_for_server("ghost").await.unwrap_err();
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
        overrides: [("computer.control".into(), "@ryu/ghost".into())]
            .into_iter()
            .collect(),
    });
    assert_eq!(
        registry
            .capability_verbs()
            .await
            .iter()
            .filter(|entry| entry.provider_id == "@ryu/ghost")
            .count(),
        6
    );
    for (verb, native, args) in cases() {
        let before = state.lock().await.calls.len();
        let denied = registry
            .call_tool(verb, args.clone(), Some(&["web.extract".into()]))
            .await
            .unwrap_err();
        assert!(denied.to_string().contains("not in this agent's allowlist"));
        assert_eq!(state.lock().await.calls.len(), before);
        let result = registry
            .call_tool(verb, args.clone(), Some(&[verb.into()]))
            .await
            .unwrap();
        assert_eq!(
            result,
            serde_json::json!({"provider":"@ryu/ghost","raw":tool_result(false)})
        );
        {
            let fixture = state.lock().await;
            assert_eq!(fixture.calls.len(), before + 1);
            assert_eq!(fixture.calls[before]["name"], native);
            assert_eq!(fixture.calls[before]["arguments"], args);
        }
        state.lock().await.fail = true;
        let failed = registry.call_tool(verb, args.clone(), None).await.unwrap();
        assert_eq!(
            failed,
            serde_json::json!({"provider":"@ryu/ghost","raw":tool_result(true)})
        );
        assert_eq!(state.lock().await.calls.len(), before + 2);
        state.lock().await.fail = false;
        assert_eq!(registry.call_tool(verb, args, None).await.unwrap(), result);
        assert_eq!(state.lock().await.calls.len(), before + 3);
    }
    let before = state.lock().await.calls.len();
    assert!(registry.deregister_server("@ryu/ghost", "ghost"));
    store
        .set_enabled("@ryu/ghost", &manifest.permission_grants)
        .await
        .unwrap();
    assert!(
        register_manifest_mcp_servers(&registry, &manifest, tier, &manifest.permission_grants)
            .is_empty()
    );
    let denied = registry
        .call_tool("computer.capture", serde_json::json!({}), None)
        .await
        .unwrap_err();
    assert_eq!(denied.to_string(), "unknown MCP server: ghost");
    assert_eq!(state.lock().await.calls.len(), before);
    store.set_enabled("@ryu/ghost", &approved).await.unwrap();
    assert_eq!(
        register_manifest_mcp_servers(&registry, &manifest, tier, &approved),
        ["ghost"]
    );
    assert_eq!(
        registry
            .call_tool("computer.capture", serde_json::json!({}), None)
            .await
            .unwrap(),
        serde_json::json!({"provider":"@ryu/ghost","raw":tool_result(false)})
    );
    assert_eq!(state.lock().await.calls.len(), before + 1);
    assert!(registry.deregister_server("@ryu/ghost", "ghost"));
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
fn cases() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        ("computer.capture", "ghost_annotate", serde_json::json!({})),
        (
            "computer.click",
            "ghost_click",
            serde_json::json!({"x":12,"y":34,"button":"left","clicks":2}),
        ),
        (
            "computer.type",
            "ghost_type",
            serde_json::json!({"text":"fixture text","replace":true}),
        ),
        (
            "computer.key",
            "ghost_hotkey",
            serde_json::json!({"keys":["Control","Enter"]}),
        ),
        (
            "computer.scroll",
            "ghost_scroll",
            serde_json::json!({"direction":"down","amount":200,"x":12,"y":34}),
        ),
        (
            "computer.focus_app",
            "ghost_focus",
            serde_json::json!({"app":"Fixture App"}),
        ),
    ]
}
fn tool_result(fail: bool) -> Value {
    serde_json::json!({"content":[{"type":"text","text":if fail {"fixture ghost error"}else{"fixture ghost response"}}],"isError":fail})
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
            serde_json::json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"local-ghost-protocol-fixture","version":"1"}})
        }
        "tools/list" => serde_json::json!({"tools":[]}),
        "tools/call" => {
            let mut fixture = state.lock().await;
            fixture.calls.push(rpc["params"].clone());
            tool_result(fixture.fail)
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
