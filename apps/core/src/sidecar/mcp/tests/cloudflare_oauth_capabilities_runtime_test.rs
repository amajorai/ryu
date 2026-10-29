//! Real OAuth manager, sealed fixture identity state and unchanged Cloudflare
//! adapters. OAuth remains enabled; no discovery, token issuance or refresh runs.
use super::*;
use axum::{body::Body, extract::State, http::Request, routing::post, Json, Router};
use std::sync::Arc;
const RAW: &str = include_str!(
    "../../../../../../generated/ryu-runtime/plugins-store/external_plugins/cloudflare-browser-run/manifest.json"
);
const CHILD: &str = "RYU_CLOUDFLARE_OAUTH_CANONICAL_CHILD";
const TEST:&str="sidecar::mcp::tests::cloudflare_oauth_capabilities_runtime::cloudflare_oauth_sealed_binding_projects_only_to_bound_canonical_fixture";
const PLUGIN: &str = "@ryu/cloudflare-browser-run";
const TOKEN: &str = "synthetic-cloudflare-bearer";
const PAGE: &str = "https://fixture.invalid/page";
#[derive(Default)]
struct Fixture {
    calls: Vec<Value>,
    discovery_refusals: usize,
    legacy_initializations: usize,
    fail: bool,
    requests: usize,
}
type Shared = Arc<tokio::sync::Mutex<Fixture>>;

#[tokio::test]
async fn cloudflare_oauth_sealed_binding_projects_only_to_bound_canonical_fixture() {
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
            .env_remove("RYU_GATEWAY_REMOTE")
            .env_remove("RYU_PASSPORT_URL");
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
            "isolated Cloudflare OAuth fixture failed"
        );
        return;
    }
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_GATEWAY_TOKEN");
    let identity = crate::identity::IdentityStore::open_in_memory().unwrap();
    crate::identity::set_global(identity.clone());
    let state: Shared = Arc::new(tokio::sync::Mutex::new(Fixture::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let resource = format!("http://{address}/mcp");
    let _allowed = allow_discovery_test_host(address);
    let app = Router::new()
        .route("/mcp", post(endpoint))
        .with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut raw: Value = serde_json::from_str(RAW).unwrap();
    assert_eq!(raw["mcp_servers"]["cloudflare"]["auth"]["type"], "oauth");
    assert_eq!(
        raw["mcp_servers"]["cloudflare"]["url"],
        "https://browser.mcp.cloudflare.com/mcp"
    );
    raw["mcp_servers"]["cloudflare"]["url"] = Value::String(resource.clone());
    let manifest = PluginManifest::parse_and_validate_with_code(&raw.to_string(), |path| {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../generated/ryu-runtime/plugins-store/external_plugins/cloudflare-browser-run")
                .join(path),
        )
        .map_err(|error| error.to_string())
    })
    .unwrap();
    let mut cfg = mcp_server_config_from_decl(&manifest.mcp_servers["cloudflare"]);
    cfg.owner_plugin_id = Some(PLUGIN.into());
    cfg.owner_server_name = Some("cloudflare".into());
    assert!(cfg.auth.is_some());
    for (owner, profile) in [
        ("local", "personal"),
        ("wrong-owner", "personal"),
        ("local", "wrong-profile"),
    ] {
        let denied = oauth_target(
            &cfg,
            owner,
            profile,
            crate::identity::ConnectionAction::Read,
            false,
            false,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(denied.to_string(), "MCP authentication required");
        assert_eq!(state.lock().await.requests, 0);
    }
    seed(&identity, &resource).await;
    let record = identity
        .find_mcp_oauth_connection("local", "personal", PLUGIN, "cloudflare")
        .await
        .unwrap()
        .unwrap();
    assert!(record.encrypted_state.is_some());
    assert!(!serde_json::to_string(&record).unwrap().contains(TOKEN));
    for (owner, profile) in [("wrong-owner", "personal"), ("local", "wrong-profile")] {
        let denied = oauth_target(
            &cfg,
            owner,
            profile,
            crate::identity::ConnectionAction::Read,
            false,
            false,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(denied.to_string(), "MCP authentication required");
        assert_eq!(state.lock().await.requests, 0);
    }
    let mut wrong = cfg.clone();
    wrong.url = Some(format!("http://{address}/wrong-resource"));
    let denied = oauth_target(
        &wrong,
        "local",
        "personal",
        crate::identity::ConnectionAction::Read,
        false,
        false,
        None,
        None,
    )
    .await
    .unwrap_err();
    assert_eq!(
        denied.to_string(),
        "the MCP OAuth binding changed; reconnect required"
    );
    assert_eq!(state.lock().await.requests, 0);
    seed(&identity, &resource).await;
    let target = oauth_target(
        &cfg,
        "local",
        "personal",
        crate::identity::ConnectionAction::Read,
        false,
        false,
        None,
        None,
    )
    .await
    .unwrap();
    let result = client::call_tool(&target, "get_url_snapshot", serde_json::json!({"url":PAGE}))
        .await
        .unwrap();
    assert_eq!(result, tool_result("get_url_snapshot", false));
    assert!(!result.to_string().contains(TOKEN));
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(&manifest.id, &manifest.version).await.unwrap();
    // Endpoint substitution removes provenance. Approval is granted explicitly
    // through the store; it is not inferred from the authored declaration.
    let tier = crate::plugins::builtins::tier_for_manifest(&manifest);
    assert_eq!(tier, crate::plugin_manifest::PluginTier::Community);
    let manifests = Arc::new(TokioRwLock::new(vec![manifest.clone()]));
    let registry = Arc::new(McpRegistry::empty().with_self_build(manifests.clone(), store.clone()));
    let mut unapproved = manifest.permission_grants.clone();
    unapproved.retain(|grant| grant != GRANT_MCP_SERVER);
    store.set_enabled(PLUGIN, &unapproved).await.unwrap();
    assert!(register_manifest_mcp_servers(&registry, &manifest, tier, &unapproved).is_empty());
    store
        .set_enabled(PLUGIN, &manifest.permission_grants)
        .await
        .unwrap();
    assert_eq!(
        register_manifest_mcp_servers(&registry, &manifest, tier, &manifest.permission_grants),
        ["cloudflare"]
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
    let inactive = registry.tools_for_server("cloudflare").await.unwrap_err();
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
        overrides: [("browser.control".into(), PLUGIN.into())]
            .into_iter()
            .collect(),
    });
    for (verb, native, args) in [
        (
            "browser.navigate",
            "get_url_snapshot",
            serde_json::json!({"url":format!("  {PAGE}  ")}),
        ),
        (
            "browser.snapshot",
            "get_url_snapshot",
            serde_json::json!({"tab_id":format!("  {PAGE}  ")}),
        ),
        (
            "browser.screenshot",
            "get_url_screenshot",
            serde_json::json!({"tab_id":format!("  {PAGE}  ")}),
        ),
    ] {
        let before = state.lock().await.calls.len();
        let denied = registry
            .call_tool(verb, args.clone(), Some(&["web.extract".into()]))
            .await
            .unwrap_err();
        assert!(denied.to_string().contains("not in this agent's allowlist"));
        assert_eq!(state.lock().await.calls.len(), before);
        let result = registry.call_tool(verb, args.clone(), None).await.unwrap();
        assert_eq!(result["provider"], PLUGIN);
        assert_eq!(result["url"], PAGE);
        assert_eq!(result["tab_id"], PAGE);
        assert_eq!(result["raw"], tool_result(native, false));
        if verb == "browser.screenshot" {
            assert_eq!(
                result["image"],
                serde_json::json!({"data":"fixture-image","mimeType":"image/png"})
            );
        } else {
            assert_eq!(result["content"], "fixture snapshot");
        }
        assert!(!result.to_string().contains(TOKEN));
        {
            let fixture = state.lock().await;
            assert_eq!(fixture.calls.len(), before + 1);
            assert_eq!(fixture.calls[before]["name"], native);
            assert_eq!(
                fixture.calls[before]["arguments"],
                serde_json::json!({"url":PAGE})
            );
        }
        state.lock().await.fail = true;
        let failed = registry.call_tool(verb, args.clone(), None).await.unwrap();
        assert_eq!(
            failed,
            serde_json::json!({"provider":PLUGIN,"raw":tool_result(native,true)})
        );
        state.lock().await.fail = false;
        assert_eq!(registry.call_tool(verb, args, None).await.unwrap(), result);
        assert_eq!(state.lock().await.calls.len(), before + 3);
    }
    manifests.write().await[0]
        .permission_grants
        .retain(|grant| grant != "tool:execute");
    let grants = manifests.read().await[0].permission_grants.clone();
    store.set_enabled(PLUGIN, &grants).await.unwrap();
    let before = state.lock().await.requests;
    let denied = registry
        .call_tool("browser.snapshot", serde_json::json!({"tab_id":PAGE}), None)
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("tool:execute"));
    assert_eq!(state.lock().await.requests, before);
    assert!(registry.deregister_server(PLUGIN, "cloudflare"));
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
async fn seed(store: &crate::identity::IdentityStore, resource: &str) {
    let bundle = serde_json::json!({"access_token":TOKEN,"refresh_token":null,"id_token":null,"token_type":"Bearer","client_id":"fixture-client","client_secret":null,"token_endpoint":"https://fixture.invalid/token","revocation_endpoint":null,"issuer":"https://fixture.invalid","resource":resource,"mcp_server_url":resource,"declared_client_id":null});
    store
        .upsert_mcp_oauth_connection(
            "local",
            "personal",
            PLUGIN,
            "cloudflare",
            resource,
            "https://fixture.invalid",
            None,
            &[],
            Some(i64::MAX),
            &crate::identity::SecretState::new(bundle.to_string()),
        )
        .await
        .unwrap();
    store
        .set_connection_access_level(
            "local",
            "mcp",
            &ryu_vault::mcp_oauth::connection_key("personal", PLUGIN, "cloudflare"),
            crate::identity::ConnectionAccessLevel::Full,
        )
        .await
        .unwrap();
}
fn tool_result(native: &str, fail: bool) -> Value {
    if fail {
        return serde_json::json!({"content":[{"type":"text","text":"fixture cloudflare unavailable"}],"isError":true});
    }
    if native == "get_url_screenshot" {
        serde_json::json!({"content":[{"type":"image","data":"fixture-image","mimeType":"image/png"}],"isError":false})
    } else {
        serde_json::json!({"content":[{"type":"text","text":"fixture snapshot"}],"structuredContent":{"content":"fixture snapshot"},"isError":false})
    }
}
async fn endpoint(State(state): State<Shared>, request: Request<Body>) -> Json<Value> {
    let (parts, body) = request.into_parts();
    assert_eq!(
        parts
            .headers
            .get("authorization")
            .unwrap()
            .to_str()
            .unwrap(),
        format!("Bearer {TOKEN}")
    );
    let rpc: Value =
        serde_json::from_slice(&axum::body::to_bytes(body, 1024 * 1024).await.unwrap()).unwrap();
    let mut fixture = state.lock().await;
    fixture.requests += 1;
    let result = match rpc["method"].as_str().unwrap() {
        // This fixture intentionally implements legacy MCP. Method-not-found
        // is the protocol evidence required for a safe modern-to-legacy fallback.
        "server/discover" => {
            fixture.discovery_refusals += 1;
            return Json(
                serde_json::json!({"jsonrpc":"2.0","id":rpc["id"],"error":{"code":-32601,"message":"Legacy fixture does not implement server/discover"}}),
            );
        }
        "initialize" => {
            fixture.legacy_initializations += 1;
            serde_json::json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"local-cloudflare-oauth-fixture","version":"1"}})
        }
        "tools/list" => serde_json::json!({"tools":[
            {"name":"get_url_snapshot","description":"Local read-only snapshot fixture","inputSchema":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]},"annotations":{"readOnlyHint":true,"destructiveHint":false}},
            {"name":"get_url_screenshot","description":"Local read-only screenshot fixture","inputSchema":{"type":"object","properties":{"url":{"type":"string"}},"required":["url"]},"annotations":{"readOnlyHint":true,"destructiveHint":false}}
        ]}),
        "tools/call" => {
            fixture.calls.push(rpc["params"].clone());
            tool_result(rpc["params"]["name"].as_str().unwrap(), fixture.fail)
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
