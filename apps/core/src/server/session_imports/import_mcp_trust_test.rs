//! TC-3 and TC-12: an MCP server imported from a folder never lands enabled,
//! whether it is a stdio command (TC-3) or a remote URL (TC-12). The import is
//! driven through `apply_import_selections` with no caller, which is how the
//! import route calls it on a node with no sign-in. (The folder sync worker no
//! longer imports MCP servers at all, see `server/agent_sync_mcp_skip_test.rs`.)

use crate::import::{kind, ImportSelection};
use crate::server::{apply_import_selections, isolated_plugin_hook_test_state};
use std::sync::{Arc, Mutex};

/// Points `McpRegistry::config_path()` at a temp `mcp.json` for one test and
/// restores the previous value, also when the test panics.
struct McpConfigPath(Option<std::ffi::OsString>);

impl McpConfigPath {
    fn set(path: &std::path::Path) -> Self {
        let previous = std::env::var_os("RYU_MCP_CONFIG");
        std::env::set_var("RYU_MCP_CONFIG", path);
        Self(previous)
    }
}

impl Drop for McpConfigPath {
    fn drop(&mut self) {
        match self.0.take() {
            Some(previous) => std::env::set_var("RYU_MCP_CONFIG", previous),
            None => std::env::remove_var("RYU_MCP_CONFIG"),
        }
    }
}

#[tokio::test]
async fn a_stdio_server_imported_from_a_folder_lands_disabled() {
    let _env = crate::sidecar::gateway::lock_gateway_env();
    let source = tempfile::tempdir().unwrap();
    // The source file asks for `enabled: true`; the import must not honour it.
    std::fs::write(
        source.path().join("mcp.json"),
        r#"{"mcpServers":{"tc3-probe":{"command":"ryu-tc3-no-such-binary","args":["--serve"],"enabled":true}}}"#,
    )
    .unwrap();
    let ryu = tempfile::tempdir().unwrap();
    let config = ryu.path().join("mcp.json");
    let _path = McpConfigPath::set(&config);
    let state = isolated_plugin_hook_test_state(ryu.path());

    let selection = ImportSelection {
        kind: kind::MCP_SERVER.into(),
        id: format!("{}/mcp/json/tc3-probe", kind::MCP_SERVER),
    };
    let outcomes = apply_import_selections(&state, &None, source.path(), vec![selection]).await;
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].status, "imported", "{:?}", outcomes[0]);

    let installed = crate::sidecar::mcp::installed_configs();
    let server = installed
        .get("tc3-probe")
        .unwrap_or_else(|| panic!("server not written to {}: {installed:?}", config.display()));
    assert_eq!(server.command.as_deref(), Some("ryu-tc3-no-such-binary"));
    assert!(
        !server.enabled,
        "an imported stdio server must land disabled until the user enables it"
    );
}

/// One request the local MCP endpoint received.
#[derive(Debug, Clone)]
struct SeenRequest {
    /// HTTP method and JSON-RPC method, for example `POST tools/list`.
    request: String,
    authorization: Option<String>,
}

/// A local Streamable HTTP MCP endpoint that records every request it gets
/// (any method, any path) with the `Authorization` header it carried, and
/// answers the discovery handshake with one tool.
struct RecordingMcp {
    address: std::net::SocketAddr,
    seen: Arc<Mutex<Vec<SeenRequest>>>,
    server: tokio::task::JoinHandle<()>,
}

impl RecordingMcp {
    async fn start() -> Self {
        use axum::response::IntoResponse;
        use serde_json::json;

        let seen: Arc<Mutex<Vec<SeenRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let app = axum::Router::new().fallback(
            move |method: axum::http::Method, headers: axum::http::HeaderMap, body: String| {
                let recorder = recorder.clone();
                async move {
                    let body: serde_json::Value =
                        serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
                    let rpc = body["method"].as_str().unwrap_or("-").to_owned();
                    recorder.lock().unwrap().push(SeenRequest {
                        request: format!("{method} {rpc}"),
                        authorization: headers
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned),
                    });
                    if method != axum::http::Method::POST {
                        return axum::http::StatusCode::METHOD_NOT_ALLOWED.into_response();
                    }
                    let id = body["id"].clone();
                    let reply = match rpc.as_str() {
                        "server/discover" => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": {"code": -32601, "message": "Method not found"}
                        }),
                        "initialize" => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "protocolVersion": "2025-11-25",
                                "capabilities": {"tools": {}},
                                "serverInfo": {"name": "tc12-fixture", "version": "1"}
                            }
                        }),
                        "tools/list" => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {"tools": [{
                                "name": "probe",
                                "description": "TC-12 fixture",
                                "inputSchema": {"type": "object"}
                            }]}
                        }),
                        _ => json!({"jsonrpc": "2.0", "id": id, "result": {}}),
                    };
                    axum::Json(reply).into_response()
                }
            },
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            address,
            seen,
            server,
        }
    }

    fn seen(&self) -> Vec<SeenRequest> {
        self.seen.lock().unwrap().clone()
    }
}

impl Drop for RecordingMcp {
    fn drop(&mut self) {
        self.server.abort();
    }
}

/// Adds one `host:port` to `RYU_AGENT_EGRESS_ALLOW_HOSTS` for one test, so the
/// import screen and the MCP client accept the loopback fixture, and restores
/// the previous value, also when the test panics.
struct AllowEgressHost(Option<std::ffi::OsString>);

impl AllowEgressHost {
    fn add(address: std::net::SocketAddr) -> Self {
        let previous = std::env::var_os("RYU_AGENT_EGRESS_ALLOW_HOSTS");
        let mut allowed = previous.clone().unwrap_or_default();
        if !allowed.is_empty() {
            allowed.push(",");
        }
        allowed.push(address.to_string());
        std::env::set_var("RYU_AGENT_EGRESS_ALLOW_HOSTS", allowed);
        Self(previous)
    }
}

impl Drop for AllowEgressHost {
    fn drop(&mut self) {
        match self.0.take() {
            Some(previous) => std::env::set_var("RYU_AGENT_EGRESS_ALLOW_HOSTS", previous),
            None => std::env::remove_var("RYU_AGENT_EGRESS_ALLOW_HOSTS"),
        }
    }
}

/// TC-12: a remote entry found in a folder names one of the user's saved keys
/// in a header. Importing it must not let tool discovery call the server, and
/// so must not send it the key, before the user enables the server.
///
/// The second half is the control: once the user enables the entry, the same
/// discovery does reach the fixture and does carry the resolved key. Before
/// this fix that happened on the first discovery after the import, with the
/// entry never enabled by the user. It also shows the first half is not
/// passing on a fixture that cannot be reached.
#[tokio::test]
async fn an_imported_remote_server_gets_no_saved_key_before_the_user_enables_it() {
    const KEY_NAME: &str = "TC12_PROBE_KEY";
    const KEY_REFERENCE: &str = "Bearer secret:TC12_PROBE_KEY";
    const KEY_SENT: &str = "Bearer tc12-probe-key-value";

    let _env = crate::sidecar::gateway::lock_gateway_env();
    let probe = RecordingMcp::start().await;
    let _allow = AllowEgressHost::add(probe.address);

    // A key saved the way the Vault page saves one by default on a local node:
    // user scope, scope id "local", no MCP binding.
    crate::plugin_secrets::set_global(
        crate::plugin_secrets::PluginSecretStore::in_memory().unwrap(),
    );
    let vault = crate::plugin_secrets::global().expect("a published secret store");
    vault
        .set_vault_secret(
            crate::plugin_secrets::SecretScope::User,
            "local",
            None,
            KEY_NAME,
            "tc12-probe-key-value",
        )
        .await
        .unwrap();

    let source = tempfile::tempdir().unwrap();
    let foreign = serde_json::json!({"mcpServers": {"tc12-probe": {
        "type": "http",
        "url": format!("http://{}/mcp", probe.address),
        "headers": {"Authorization": KEY_REFERENCE},
        "enabled": true
    }}});
    std::fs::write(source.path().join("mcp.json"), foreign.to_string()).unwrap();
    let ryu = tempfile::tempdir().unwrap();
    let config = ryu.path().join("mcp.json");
    let _path = McpConfigPath::set(&config);
    let state = isolated_plugin_hook_test_state(ryu.path());

    let selection = ImportSelection {
        kind: kind::MCP_SERVER.into(),
        id: format!("{}/mcp/json/tc12-probe", kind::MCP_SERVER),
    };
    let outcomes = apply_import_selections(&state, &None, source.path(), vec![selection]).await;
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].status, "imported", "{:?}", outcomes[0]);

    // Tool discovery of the imported server. `list_all_tools` runs exactly this
    // for every registered server on the next tool list or chat turn.
    let _ = state.mcp.tools_for_server("tc12-probe").await;
    let seen = probe.seen();
    assert!(
        seen.is_empty(),
        "an imported remote MCP server was called before the user enabled it: {seen:?}"
    );
    let installed = crate::sidecar::mcp::installed_configs();
    let server = installed
        .get("tc12-probe")
        .unwrap_or_else(|| panic!("server not written to {}: {installed:?}", config.display()));
    assert!(
        !server.enabled,
        "an imported remote server must land disabled until the user enables it"
    );
    assert_eq!(
        server.headers.get("Authorization").map(String::as_str),
        Some(KEY_REFERENCE),
        "the header is kept as a reference, for the user to review"
    );

    // Control: the user step. Enabling writes `enabled` to mcp.json and reloads,
    // as `PUT /api/mcp/servers/:name` does.
    crate::sidecar::mcp::McpConfigStore::mutate(config.clone(), |document| {
        let servers = crate::sidecar::mcp::McpConfigStore::servers_mut(document)?;
        let entry = servers
            .get_mut("tc12-probe")
            .ok_or_else(|| "tc12-probe is not in mcp.json".to_owned())?;
        entry["enabled"] = serde_json::Value::Bool(true);
        Ok((true, ()))
    })
    .await
    .unwrap();
    state.mcp.reload();
    let tools = state
        .mcp
        .tools_for_server("tc12-probe")
        .await
        .expect("discovery of the enabled server");
    let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
    assert_eq!(names, ["probe"]);
    let seen = probe.seen();
    assert!(
        seen.iter().any(|got| {
            got.request == "POST tools/list" && got.authorization.as_deref() == Some(KEY_SENT)
        }),
        "the control did not see the resolved key on tools/list after the user enabled the server: {seen:?}"
    );

    vault
        .delete_vault_secret(
            crate::plugin_secrets::SecretScope::User,
            "local",
            None,
            KEY_NAME,
        )
        .await
        .unwrap();
}
