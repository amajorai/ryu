//! Shipped Agentbrowser bindings/adapters via Core registry and actual MCP HTTP.
//! Only the stdio transport is replaced by a local protocol fixture. No pinned
//! npx process, browser/device effects or upstream payload acceptance is claimed.
use super::*;
use axum::{extract::State, routing::post, Json, Router};
use std::sync::Arc;
const MANIFEST: &str =
    include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/agentbrowser/manifest.json");
const CHILD: &str = "RYU_AGENTBROWSER_CANONICAL_RPC_CHILD";
const TEST_NAME: &str = "sidecar::mcp::tests::agentbrowser_capabilities_runtime::agentbrowser_canonical_routes_sequence_real_mcp_calls";
#[derive(Default)]
struct BrowserRpc {
    calls: Vec<Value>,
    fail: bool,
}
type Shared = Arc<tokio::sync::Mutex<BrowserRpc>>;

#[tokio::test]
async fn agentbrowser_canonical_routes_sequence_real_mcp_calls() {
    if std::env::var_os(CHILD).is_none() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(CHILD, "1")
            .env("RUST_MIN_STACK", "16777216")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env("RYU_ALLOW_GATEWAY_FALLBACK", "1")
            .env("RYU_EXEC_APPROVAL_MODE", "off")
            .env_remove("RYU_GATEWAY_REMOTE")
            .status()
            .unwrap();
        assert!(status.success(), "isolated Agentbrowser RPC matrix failed");
        return;
    }
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_GATEWAY_TOKEN");
    let state: Shared = Arc::new(tokio::sync::Mutex::new(BrowserRpc::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let _allowed_fixture = allow_discovery_test_host(address);
    let app = Router::new()
        .route("/mcp", post(rpc_fixture))
        .with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut raw: Value = serde_json::from_str(MANIFEST).unwrap();
    assert_eq!(raw["mcp_servers"]["agentbrowser"]["command"], "npx");
    assert_eq!(
        raw["mcp_servers"]["agentbrowser"]["args"],
        serde_json::json!(["-y", "agent-browser@0.34.0", "mcp", "--tools", "all"])
    );
    raw["mcp_servers"]["agentbrowser"] =
        serde_json::json!({"type":"streamable-http","url":format!("http://{address}/mcp")});
    let manifest = PluginManifest::parse_and_validate_with_code(&raw.to_string(), |path| {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../generated/ryu-runtime/plugins-store/plugins/agentbrowser")
                .join(path),
        )
        .map_err(|error| error.to_string())
    })
    .unwrap();
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(&manifest.id, &manifest.version).await.unwrap();
    store
        .set_enabled(&manifest.id, &manifest.permission_grants)
        .await
        .unwrap();
    let manifests = Arc::new(TokioRwLock::new(vec![manifest.clone()]));
    let registry = Arc::new(McpRegistry::empty().with_self_build(manifests.clone(), store.clone()));
    // Replacing a compiled transport removes its exact-byte Core provenance.
    // The local protocol fixture must receive explicit Community MCP approval.
    let tier = crate::plugins::builtins::tier_for_manifest(&manifest);
    assert_eq!(tier, crate::plugin_manifest::PluginTier::Community);
    assert!(
        register_manifest_mcp_servers(&registry, &manifest, tier, &manifest.permission_grants,)
            .is_empty()
    );
    let mut approved = manifest.permission_grants.clone();
    approved.push(GRANT_MCP_SERVER.to_owned());
    store.set_enabled(&manifest.id, &approved).await.unwrap();
    assert_eq!(
        register_manifest_mcp_servers(&registry, &manifest, tier, &approved),
        ["agentbrowser"]
    );
    // Persisted approval and registration alone do not publish active runtime
    // authority. Use the same coordinator/activation protocol as Core startup.
    let unavailable = registry.tools_for_server("agentbrowser").await.unwrap_err();
    assert!(unavailable
        .to_string()
        .contains("MCP plugin lifecycle is unavailable"));
    assert!(state.lock().await.calls.is_empty());
    let runtime = crate::plugins::runtime::PluginRuntime::new();
    registry.set_plugin_runtime(runtime.clone());
    let inactive = registry.tools_for_server("agentbrowser").await.unwrap_err();
    assert!(inactive.to_string().contains("owning plugin is inactive"));
    assert!(state.lock().await.calls.is_empty());
    runtime.begin_activation(&manifest.id).await.commit();
    set_global_registry(registry.clone());
    crate::plugins::binding::set_active_config(crate::plugins::binding::BindingConfig {
        overrides: [("browser.control".into(), "@ryu/agentbrowser".into())]
            .into_iter()
            .collect(),
    });
    assert_eq!(
        registry
            .capability_verbs()
            .await
            .iter()
            .filter(|entry| entry.provider_id == "@ryu/agentbrowser")
            .count(),
        7
    );
    for (verb, arguments, mut calls) in cases() {
        for call in &mut calls {
            call["_meta"] = serde_json::json!({
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                    "name": "ryu-core", "version": env!("CARGO_PKG_VERSION")
                },
                "io.modelcontextprotocol/clientCapabilities": {}
            });
        }
        let before = state.lock().await.calls.len();
        let denied = registry
            .call_tool(verb, arguments.clone(), Some(&["web.search".into()]))
            .await
            .unwrap_err();
        assert!(denied.to_string().contains("not in this agent's allowlist"));
        assert_eq!(state.lock().await.calls.len(), before);
        let result = registry
            .call_tool(verb, arguments.clone(), Some(&[verb.into()]))
            .await
            .unwrap();
        assert_eq!(result["provider"], "@ryu/agentbrowser");
        assert_eq!(&state.lock().await.calls[before..], calls.as_slice());
        if verb == "browser.type" {
            assert_eq!(result["ok"], true);
            assert_eq!(result["submitted"], true);
            assert_eq!(result["ref"], "@e1");
            assert_eq!(
                result["raw"],
                serde_json::json!({"typed":tool_result(false),"pressed":tool_result(false)})
            );
        } else if verb == "browser.snapshot" {
            assert_eq!(result["content"], tool_result(false)["content"]);
        } else {
            assert_eq!(result["raw"], tool_result(false));
        }
        state.lock().await.fail = true;
        let failure_before = state.lock().await.calls.len();
        let failed = registry
            .call_tool(verb, arguments.clone(), None)
            .await
            .unwrap();
        assert_eq!(failed["provider"], "@ryu/agentbrowser");
        let raw = if verb == "browser.type" || verb == "browser.snapshot" {
            &failed
        } else {
            &failed["raw"]
        };
        assert_eq!(raw["isError"], true);
        assert_eq!(raw["content"], tool_result(true)["content"]);
        assert_eq!(
            state.lock().await.calls.len(),
            failure_before + 1,
            "failed tab switch must stop later operations"
        );
        state.lock().await.fail = false;
        assert_eq!(
            registry.call_tool(verb, arguments, None).await.unwrap(),
            result
        );
    }
    // Remove code authority from BOTH trust sources; adapter refusal precedes RPC.
    manifests.write().await[0]
        .permission_grants
        .retain(|grant| grant != "tool:execute");
    let grants = manifests.read().await[0].permission_grants.clone();
    store
        .set_enabled("@ryu/agentbrowser", &grants)
        .await
        .unwrap();
    let before = state.lock().await.calls.len();
    let denied = registry
        .call_tool(
            "browser.snapshot",
            serde_json::json!({"tab_id":"fixture-tab"}),
            None,
        )
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("tool:execute"));
    assert_eq!(state.lock().await.calls.len(), before);
    assert!(registry.deregister_server("@ryu/agentbrowser", "agentbrowser"));
    server.abort();
}

fn cases() -> Vec<(&'static str, Value, Vec<Value>)> {
    vec![
        (
            "browser.navigate",
            serde_json::json!({"url":"https://fixture.invalid/page"}),
            vec![
                serde_json::json!({"name":"agent_browser_open","arguments":{"url":"https://fixture.invalid/page"}}),
            ],
        ),
        (
            "browser.tabs",
            serde_json::json!({}),
            vec![serde_json::json!({"name":"agent_browser_tab_list","arguments":{}})],
        ),
        (
            "browser.snapshot",
            serde_json::json!({"tab_id":"fixture-tab"}),
            vec![
                serde_json::json!({"name":"agent_browser_tab_switch","arguments":{"tab":"fixture-tab"}}),
                serde_json::json!({"name":"agent_browser_snapshot","arguments":{}}),
            ],
        ),
        (
            "browser.type",
            serde_json::json!({"tab_id":"fixture-tab","ref":"@e1","text":"fixture text","replace":true,"submit":true}),
            vec![
                serde_json::json!({"name":"agent_browser_tab_switch","arguments":{"tab":"fixture-tab"}}),
                serde_json::json!({"name":"agent_browser_type","arguments":{"selector":"@e1","text":"fixture text","clear":true}}),
                serde_json::json!({"name":"agent_browser_press","arguments":{"key":"Enter"}}),
            ],
        ),
    ]
}
fn tool_result(fail: bool) -> Value {
    serde_json::json!({"resultType":"complete","content":[{"type":"text","text":if fail {"fixture browser unavailable"} else {"fixture browser response"}}],"isError":fail})
}
async fn rpc_fixture(State(state): State<Shared>, Json(rpc): Json<Value>) -> Json<Value> {
    let result = match rpc["method"].as_str().unwrap() {
        "server/discover" => {
            assert_eq!(
                rpc["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"],
                "2026-07-28"
            );
            serde_json::json!({"resultType":"complete","supportedVersions":["2026-07-28","2024-11-05"],"capabilities":{"tools":{}},"serverInfo":{"name":"local-browser-protocol-fixture","version":"1"}})
        }
        "initialize" => {
            serde_json::json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"local-browser-protocol-fixture","version":"1"}})
        }
        "tools/list" => {
            if rpc["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] == "2026-07-28" {
                serde_json::json!({"resultType":"complete","tools":[],"ttlMs":0,"cacheScope":"private"})
            } else {
                serde_json::json!({"tools":[]})
            }
        }
        "tools/call" => {
            assert!(
                matches!(
                    rpc["params"]["name"].as_str(),
                    Some(
                        "agent_browser_open"
                            | "agent_browser_tab_list"
                            | "agent_browser_tab_switch"
                            | "agent_browser_snapshot"
                            | "agent_browser_type"
                            | "agent_browser_press"
                    )
                ),
                "unexpected Agentbrowser tool: {}",
                rpc["params"]
            );
            let mut guard = state.lock().await;
            guard.calls.push(rpc["params"].clone());
            let mut result = tool_result(guard.fail);
            if rpc["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] != "2026-07-28" {
                result.as_object_mut().unwrap().remove("resultType");
            }
            result
        }
        "notifications/initialized" => serde_json::json!({}),
        _ => {
            return Json(
                serde_json::json!({"jsonrpc":"2.0","id":rpc["id"],"error":{"code":-32601,"message":"Unknown Agentbrowser fixture method"}}),
            )
        }
    };
    Json(serde_json::json!({"jsonrpc":"2.0","id":rpc["id"],"result":result}))
}
