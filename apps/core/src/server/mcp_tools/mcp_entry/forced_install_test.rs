//! CE-18 part 2: a forced catalog install keeps the keys saved on the entry it
//! replaces only while the entry still points at the same target, and a
//! catalog entry's remote URL must be https.
//!
//! Driven through `write_mcp_entry`, the one writer the install route uses,
//! against a temporary `mcp.json` and local recording servers. No registry, no
//! real config file and no vault are involved. The results are read without
//! using the writer's return value, so this file also compiles against the
//! writer as it was before the fix. There every test fails except the one for
//! the same target, which passes before and after.

use super::*;
use crate::sidecar::mcp::{installed_configs, McpConfigStore, McpRegistry, McpServerConfig};
use std::sync::{Arc, Mutex};

const NAME: &str = "ce18b-probe";
const SAVED_KEY: &str = "Bearer ce18b-saved-key";

/// Points `McpRegistry::config_path()` at a temporary `mcp.json` for one test
/// and restores the previous value, also when the test panics.
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

/// Sets `RYU_AGENT_EGRESS_ALLOW_HOSTS` (or clears it) for one test and restores
/// the previous value, also when the test panics.
struct EgressAllowHosts(Option<std::ffi::OsString>);

impl EgressAllowHosts {
    fn set(value: Option<&str>) -> Self {
        let previous = std::env::var_os("RYU_AGENT_EGRESS_ALLOW_HOSTS");
        match value {
            Some(value) => std::env::set_var("RYU_AGENT_EGRESS_ALLOW_HOSTS", value),
            None => std::env::remove_var("RYU_AGENT_EGRESS_ALLOW_HOSTS"),
        }
        Self(previous)
    }
}

impl Drop for EgressAllowHosts {
    fn drop(&mut self) {
        match self.0.take() {
            Some(previous) => std::env::set_var("RYU_AGENT_EGRESS_ALLOW_HOSTS", previous),
            None => std::env::remove_var("RYU_AGENT_EGRESS_ALLOW_HOSTS"),
        }
    }
}

/// Writes an `mcp.json` that holds one server, as an earlier install left it.
fn seed(config: &std::path::Path, entry: Value) {
    let document = json!({ "mcpServers": { NAME: entry } });
    std::fs::write(config, document.to_string()).unwrap();
}

/// The entry as Core reads it back, with sealed values opened.
fn installed() -> McpServerConfig {
    let servers = installed_configs();
    servers
        .get(NAME)
        .cloned()
        .unwrap_or_else(|| panic!("{NAME} is not in mcp.json: {servers:?}"))
}

/// What the install route hands the writer for a hosted catalog entry.
fn catalog_remote(url: &str) -> McpServerConfig {
    McpServerConfig {
        transport: Some("streamable-http".to_owned()),
        url: Some(url.to_owned()),
        enabled: false,
        version: Some("2.0.0".to_owned()),
        catalog_id: Some(NAME.to_owned()),
        ..Default::default()
    }
}

/// What the install route hands the writer for a catalog package.
fn catalog_local(command: &str, args: &[&str]) -> McpServerConfig {
    McpServerConfig {
        command: Some(command.to_owned()),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        transport: Some("stdio".to_owned()),
        enabled: false,
        version: Some("2.0.0".to_owned()),
        catalog_id: Some(NAME.to_owned()),
        ..Default::default()
    }
}

#[tokio::test]
async fn a_forced_install_to_a_new_origin_drops_the_saved_keys_and_lands_disabled() {
    let _env = crate::sidecar::gateway::lock_gateway_env();
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("mcp.json");
    let _path = McpConfigPath::set(&config);
    seed(
        &config,
        json!({
            "type": "streamable-http",
            "url": "https://mcp.acme.example/weather",
            "headers": { "Authorization": SAVED_KEY, "X-Team": "secret:CE18B_TEAM" },
            "auth": { "type": "oauth", "client_id": "acme-public-client" },
            "env": { "ACME_TOKEN": "ce18b-env-key" },
            "enabled": true,
            "version": "1.0.0",
            "catalog_id": NAME,
            "x-note": "old entry"
        }),
    );

    let written = write_mcp_entry(
        NAME,
        catalog_remote("https://mcp.other.example/weather"),
        true,
    )
    .await
    .expect("the forced install is written");

    let entry = installed();
    assert_eq!(
        entry.url.as_deref(),
        Some("https://mcp.other.example/weather")
    );
    assert!(
        entry.headers.is_empty(),
        "headers saved for the old origin were kept for the new one: {:?}",
        entry.headers.keys().collect::<Vec<_>>()
    );
    assert!(entry.env.is_empty(), "the old env was kept");
    assert!(entry.auth.is_none(), "the old auth declaration was kept");
    assert!(
        !entry.enabled,
        "a server with a new origin must stay off until the user enables it"
    );
    let raw = std::fs::read_to_string(&config).unwrap();
    assert!(
        !raw.contains("x-note") && !raw.contains("CE18B_TEAM"),
        "{raw}"
    );
    // Debug form, so this line compiles against the old writer too (it returned `()`).
    assert_eq!(
        format!("{written:?}"),
        "true",
        "the writer reports the reset"
    );
}

#[tokio::test]
async fn a_forced_install_over_a_hand_added_server_does_not_inherit_its_keys() {
    let _env = crate::sidecar::gateway::lock_gateway_env();
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("mcp.json");
    let _path = McpConfigPath::set(&config);
    // Added by hand, so it records no catalog id. Same URL as the catalog entry.
    seed(
        &config,
        json!({
            "type": "streamable-http",
            "url": "https://mcp.acme.example/weather",
            "headers": { "Authorization": SAVED_KEY },
            "enabled": true
        }),
    );

    write_mcp_entry(
        NAME,
        catalog_remote("https://mcp.acme.example/weather"),
        true,
    )
    .await
    .expect("the forced install is written");

    let entry = installed();
    assert!(
        entry.headers.is_empty(),
        "a catalog entry inherited the keys of a server the user added by hand"
    );
    assert!(!entry.enabled);
    assert_eq!(entry.catalog_id.as_deref(), Some(NAME));
}

#[tokio::test]
async fn a_forced_install_to_a_new_command_drops_the_saved_env_and_lands_disabled() {
    let _env = crate::sidecar::gateway::lock_gateway_env();
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("mcp.json");
    let _path = McpConfigPath::set(&config);
    seed(
        &config,
        json!({
            "command": "npx",
            "args": ["--ignore-scripts", "-y", "@acme/mcp@1.0.0"],
            "env": { "ACME_TOKEN": "ce18b-env-key" },
            "enabled": true,
            "version": "1.0.0",
            "catalog_id": NAME
        }),
    );

    write_mcp_entry(NAME, catalog_local("uvx", &["acme-mcp==2.0.0"]), true)
        .await
        .expect("the forced install is written");

    let entry = installed();
    assert_eq!(entry.command.as_deref(), Some("uvx"));
    assert!(
        entry.env.is_empty(),
        "env saved for the old command was handed to the new one: {:?}",
        entry.env.keys().collect::<Vec<_>>()
    );
    assert!(!entry.enabled);
}

/// The other half of the rule, and the reason an update exists: the same target
/// keeps its keys and its enabled state. Passes before the fix as well.
#[tokio::test]
async fn a_forced_install_to_the_same_target_keeps_the_keys_and_the_enabled_state() {
    let _env = crate::sidecar::gateway::lock_gateway_env();
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("mcp.json");
    let _path = McpConfigPath::set(&config);
    seed(
        &config,
        json!({
            "type": "streamable-http",
            "url": "https://mcp.acme.example/weather",
            "headers": { "Authorization": SAVED_KEY },
            "auth": { "type": "oauth", "client_id": "acme-public-client" },
            "enabled": true,
            "version": "1.0.0",
            "catalog_id": NAME,
            "x-note": "old entry"
        }),
    );
    // Same origin, new path and version.
    write_mcp_entry(
        NAME,
        catalog_remote("https://mcp.acme.example/v2/weather"),
        true,
    )
    .await
    .expect("the update is written");
    let entry = installed();
    assert_eq!(
        entry.url.as_deref(),
        Some("https://mcp.acme.example/v2/weather")
    );
    assert_eq!(
        entry.headers.get("Authorization").map(String::as_str),
        Some(SAVED_KEY)
    );
    assert!(entry.auth.is_some());
    assert!(entry.enabled);
    assert_eq!(entry.version.as_deref(), Some("2.0.0"));
    let raw = std::fs::read_to_string(&config).unwrap();
    assert!(raw.contains("x-note"), "{raw}");

    // A package update: same command, new pinned version.
    seed(
        &config,
        json!({
            "command": "npx",
            "args": ["--ignore-scripts", "-y", "@acme/mcp@1.0.0"],
            "env": { "ACME_TOKEN": "ce18b-env-key" },
            "enabled": true,
            "catalog_id": NAME
        }),
    );
    let update = catalog_local("npx", &["--ignore-scripts", "-y", "@acme/mcp@2.0.0"]);
    write_mcp_entry(NAME, update, true)
        .await
        .expect("the update is written");
    let entry = installed();
    assert_eq!(
        entry.args.last().map(String::as_str),
        Some("@acme/mcp@2.0.0")
    );
    assert_eq!(
        entry.env.get("ACME_TOKEN").map(String::as_str),
        Some("ce18b-env-key")
    );
    assert!(entry.enabled);
}

#[tokio::test]
async fn a_plain_http_catalog_url_is_refused_and_nothing_is_written() {
    let _env = crate::sidecar::gateway::lock_gateway_env();
    let _no_exception = EgressAllowHosts::set(None);
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("mcp.json");
    let _path = McpConfigPath::set(&config);

    // A first install.
    let (status, message) = write_mcp_entry(
        NAME,
        catalog_remote("http://mcp.acme.example/weather"),
        false,
    )
    .await
    .expect_err("a plain http catalog URL was written");
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(message.contains("plain http"), "{message}");
    assert!(!config.exists(), "a refused install wrote mcp.json");

    // A forced install over a server that is in use: the server stays as it was.
    seed(
        &config,
        json!({
            "type": "streamable-http",
            "url": "https://mcp.acme.example/weather",
            "headers": { "Authorization": SAVED_KEY },
            "enabled": true,
            "catalog_id": NAME
        }),
    );
    let before = std::fs::read_to_string(&config).unwrap();
    write_mcp_entry(
        NAME,
        catalog_remote("http://mcp.acme.example/weather"),
        true,
    )
    .await
    .expect_err("a plain http catalog URL replaced an installed server");
    assert_eq!(std::fs::read_to_string(&config).unwrap(), before);
}

/// One request a local MCP endpoint received.
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
        let seen: Arc<Mutex<Vec<SeenRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let app = axum::Router::new().fallback(
            move |method: axum::http::Method, headers: axum::http::HeaderMap, body: String| {
                let recorder = recorder.clone();
                async move {
                    let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                    let rpc = body["method"].as_str().unwrap_or("-").to_owned();
                    recorder.lock().unwrap().push(SeenRequest {
                        request: format!("{method} {rpc}"),
                        authorization: headers
                            .get(axum::http::header::AUTHORIZATION)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned),
                    });
                    let id = body["id"].clone();
                    axum::Json(match rpc.as_str() {
                        "server/discover" => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": -32601, "message": "Method not found" }
                        }),
                        "initialize" => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "protocolVersion": "2025-11-25",
                                "capabilities": { "tools": {} },
                                "serverInfo": { "name": "ce18b-fixture", "version": "1" }
                            }
                        }),
                        "tools/list" => json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": { "tools": [{
                                "name": "probe",
                                "description": "CE-18 fixture",
                                "inputSchema": { "type": "object" }
                            }] }
                        }),
                        _ => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
                    })
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

/// The proof on the wire. A key saved for one server must not reach another
/// origin that a forced install put under the same name: not on the next tool
/// discovery, and not after the user switches the server on again either.
///
/// The first step is the control. It shows that discovery does reach a local
/// fixture and does send the configured header, so the later "saw nothing" is
/// not a fixture that cannot be reached.
#[tokio::test]
async fn a_new_origin_never_receives_the_key_saved_for_the_old_one() {
    let _env = crate::sidecar::gateway::lock_gateway_env();
    let old = RecordingMcp::start().await;
    let new = RecordingMcp::start().await;
    // The existing exception for a local development server, for both fixtures.
    let allowed = format!("{},{}", old.address, new.address);
    let _allow = EgressAllowHosts::set(Some(allowed.as_str()));
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("mcp.json");
    let _path = McpConfigPath::set(&config);
    seed(
        &config,
        json!({
            "type": "streamable-http",
            "url": format!("http://{}/mcp", old.address),
            "headers": { "Authorization": SAVED_KEY },
            "enabled": true,
            "catalog_id": NAME
        }),
    );
    let registry = McpRegistry::load();

    let tools = registry
        .tools_for_server(NAME)
        .await
        .expect("discovery of the old server");
    let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
    assert_eq!(names, ["probe"]);
    let seen = old.seen();
    assert!(
        seen.iter().any(|got| {
            got.request == "POST tools/list" && got.authorization.as_deref() == Some(SAVED_KEY)
        }),
        "the control did not see the saved key on tools/list: {seen:?}"
    );

    // The forced install: same name and catalog id, another origin.
    write_mcp_entry(
        NAME,
        catalog_remote(&format!("http://{}/mcp", new.address)),
        true,
    )
    .await
    .expect("the forced install is written");
    registry.reload();
    let _ = registry.tools_for_server(NAME).await;
    let seen = new.seen();
    assert!(
        seen.is_empty(),
        "the new origin was called before the user enabled the server: {seen:?}"
    );

    // The user step: switching the server on again, as Settings does.
    McpConfigStore::mutate(config.clone(), |document| {
        let servers = McpConfigStore::servers_mut(document)?;
        let entry = servers
            .get_mut(NAME)
            .ok_or_else(|| format!("{NAME} is not in mcp.json"))?;
        entry["enabled"] = Value::Bool(true);
        Ok((true, ()))
    })
    .await
    .unwrap();
    registry.reload();
    registry
        .tools_for_server(NAME)
        .await
        .expect("discovery of the enabled server");
    let seen = new.seen();
    assert!(!seen.is_empty(), "the enabled server was not called at all");
    assert!(
        seen.iter().all(|got| got.authorization.is_none()),
        "the new origin received the key saved for the old one: {seen:?}"
    );
}
