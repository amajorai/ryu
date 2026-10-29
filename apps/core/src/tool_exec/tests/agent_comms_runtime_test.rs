//! Runtime contract proof for Agent Comms' shipped `agents.directory` tool.
//!
//! Core parses the real manifest and dispatches its `core:` GET through
//! `run_http_tool` to an ephemeral 127.0.0.1 fixture. The fixture supplies a
//! deterministic local roster; no other agent, Gateway, user credential, or
//! external provider is contacted. Core's actual `/api/agents` handler and
//! organization-principal policy remain separate boundaries.

use super::*;
use axum::{
    body::Body,
    extract::State,
    http::{header, Request, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};
use std::{collections::HashSet, sync::Arc};

const AGENT_COMMS_MANIFEST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/agent-comms/manifest.json");
const TEST_NODE_TOKEN: &str = "2c89de31a4b049cfbd9e04c80fd8a7a156ea12c0194b4305";
const ISOLATED_CHILD_ENV: &str = "RYU_CORE_AGENT_COMMS_FIXTURE_CHILD";
const LOCAL_EGRESS_GRANT: &str = "tool:http-egress:127.0.0.1";

#[tokio::test]
async fn shipped_agent_directory_runs_through_core_http_runtime() {
    // The node token is process-cached. A fresh headless child receives only this
    // synthetic token, so parallel Core tests and ambient credentials cannot enter
    // the fixture request.
    if std::env::var_os(ISOLATED_CHILD_ENV).is_none() {
        let data_dir = tempfile::tempdir().expect("Agent Comms fixture data directory");
        let executable = std::env::current_exe().expect("Core test executable path");
        let status = std::process::Command::new(executable)
            .args([
                "--exact",
                "tool_exec::tests::agent_comms_runtime::shipped_agent_directory_runs_through_core_http_runtime",
                "--nocapture",
            ])
            .env(ISOLATED_CHILD_ENV, "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", data_dir.path())
            .env("RYU_TOKEN", TEST_NODE_TOKEN)
            .status()
            .expect("start isolated Agent Comms Core test process");
        assert!(
            status.success(),
            "isolated Agent Comms test failed: {status}"
        );
        return;
    }

    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = super::CmdEnvGuard::armed();

    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral Agent Comms loopback fixture");
    let address = listener.local_addr().expect("fixture address");
    let app = Router::new()
        .fallback(directory_fixture_request)
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic Agent Comms fixture");
    });
    let bind = format!("127.0.0.1:{}", address.port());
    let _core_bind = super::EnvOverride::set("RYU_BIND", &bind);
    let _node_token = super::EnvOverride::set("RYU_TOKEN", TEST_NODE_TOKEN);

    let typed_manifest = crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(
        AGENT_COMMS_MANIFEST,
        |path| match path {
            "hooks/deliver.js" => Ok(include_str!(
                "../../../../../generated/ryu-runtime/plugins-store/plugins/agent-comms/hooks/deliver.js"
            )
            .to_owned()),
            "hooks/directory.js" => Ok(include_str!(
                "../../../../../generated/ryu-runtime/plugins-store/plugins/agent-comms/hooks/directory.js"
            )
            .to_owned()),
            other => Err(format!("unexpected Agent Comms code file: {other}")),
        },
    )
    .expect("Core parses and validates the shipped Agent Comms manifest");
    // `agents.react` moved to the pre-installed Message Reactions plugin, so
    // Switchboard ships only directory, send, and thread.
    let mut slugs = manifest_slugs(AGENT_COMMS_MANIFEST);
    slugs.sort();
    assert_eq!(
        slugs,
        ["agents.directory", "agents.send", "agents.thread"],
        "Switchboard ships exactly its three agent-to-agent tools"
    );
    assert_eq!(typed_manifest.runnables.len(), slugs.len());

    let manifest: Value =
        serde_json::from_str(AGENT_COMMS_MANIFEST).expect("valid Agent Comms JSON");
    assert_eq!(manifest["id"], "@ryu/agent-comms");
    assert_eq!(
        manifest["permission_grants"],
        serde_json::json!(["tool:execute", "storage:kv", LOCAL_EGRESS_GRANT])
    );
    let grants = manifest["permission_grants"]
        .as_array()
        .expect("Agent Comms declares permission grants")
        .iter()
        .map(|grant| {
            grant
                .as_str()
                .expect("permission grant is a string")
                .to_owned()
        })
        .collect::<HashSet<_>>();

    let config = runnable_config(&manifest, "agents.directory");
    assert_eq!(config["backend"], "http");
    assert_eq!(config["method"], "GET");
    assert_eq!(config["url"], "core:/api/agents");
    assert_eq!(
        config["secret_headers"]["Authorization"],
        "Bearer env:RYU_TOKEN"
    );
    assert_eq!(config["fail_open"], true);
    assert_eq!(config["unwrap_body"], true);
    assert_eq!(config["input_schema"]["properties"], serde_json::json!({}));

    let denied = call_agent_directory(config, &HashSet::new())
        .await
        .expect_err("Core refuses the call without its declared local egress grant");
    assert_eq!(
        denied,
        "http egress to '127.0.0.1' is not granted (needs 'tool:http-egress:127.0.0.1')"
    );
    assert!(
        observed.lock().await.is_empty(),
        "egress denial happens before Core makes a loopback request"
    );

    let roster = call_agent_directory(config, &grants)
        .await
        .expect("the shipped manifest reaches only the loopback roster fixture");
    assert_eq!(
        roster,
        serde_json::json!({
            "ok": true,
            "agents": [{
                "id": "scout",
                "name": "Scout",
                "description": "Reads the selected workspace.",
                "model": "fixture-model",
                "engine": "fixture-engine"
            }],
            "count": 1
        })
    );

    let unauthorized = call_agent_directory(config, &grants)
        .await
        .expect("manifest fail-open converts auth rejection to soft unavailable");
    assert_eq!(
        unauthorized,
        serde_json::json!({
            "available": false,
            "reason": "endpoint returned HTTP 401",
            "hint": "The endpoint is unreachable or rejected the request; check the key/host and retry."
        })
    );

    let unavailable = call_agent_directory(config, &grants)
        .await
        .expect("non-auth server errors preserve the response envelope");
    assert_eq!(
        unavailable,
        serde_json::json!({
            "status": 503,
            "body": { "error": "fixture roster unavailable" }
        })
    );

    let requests = observed.lock().await.clone();
    assert_eq!(
        requests.len(),
        3,
        "each allowed call issues exactly one request"
    );
    let local_host = format!("127.0.0.1:{}", address.port());
    for request in &requests {
        assert_eq!(request["method"], "GET");
        assert_eq!(request["path"], "/api/agents");
        assert_eq!(request["query"], Value::Null);
        assert_eq!(request["host"], local_host);
        assert_eq!(
            request["authorization"],
            format!("Bearer {TEST_NODE_TOKEN}")
        );
        assert_eq!(request["body"], "", "directory is a bodyless GET");
    }

    server.abort();
    let _ = server.await;
    let transport_error = call_agent_directory(config, &grants)
        .await
        .expect("the fail-open manifest preserves transport-failure availability");
    assert_eq!(transport_error["available"], false);
    assert!(transport_error["reason"]
        .as_str()
        .is_some_and(|reason| reason.starts_with("endpoint not reachable:")));
    assert_eq!(observed.lock().await.len(), requests.len());
}

fn manifest_slugs(manifest: &str) -> Vec<String> {
    let manifest: Value = serde_json::from_str(manifest).expect("valid Agent Comms JSON");
    manifest["runnables"]
        .as_array()
        .expect("manifest has a runnables array")
        .iter()
        .map(|runnable| {
            runnable["config"]["slug"]
                .as_str()
                .expect("every Agent Comms runnable declares a slug")
                .to_owned()
        })
        .collect()
}

fn runnable_config<'a>(manifest: &'a Value, slug: &str) -> &'a Value {
    manifest["runnables"]
        .as_array()
        .expect("manifest has a runnables array")
        .iter()
        .find(|runnable| runnable["config"]["slug"] == slug)
        .map(|runnable| &runnable["config"])
        .unwrap_or_else(|| panic!("manifest does not declare {slug}"))
}

async fn call_agent_directory(config: &Value, grants: &HashSet<String>) -> Result<Value, String> {
    use crate::plugin_manifest::schema::{ToolBackend, ToolConfig};

    let tool_config: ToolConfig = serde_json::from_value(config.clone())
        .expect("Core parses the shipped Agent Comms HTTP config");
    let ToolBackend::Http {
        url,
        method,
        header_params,
        secret_headers,
        fail_open,
        unwrap_body,
        body_defaults,
        ..
    } = tool_config
        .resolve_backend()
        .expect("Core resolves the shipped Agent Comms HTTP backend")
    else {
        panic!("agents.directory must resolve to Core's HTTP backend");
    };
    assert!(header_params.is_empty());
    assert!(body_defaults.is_null());

    super::super::run_http_tool(
        &url,
        &method,
        serde_json::json!({}),
        &header_params,
        &secret_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        grants,
        &[],
        "@ryu/agent-comms",
        None,
    )
    .await
}

async fn directory_fixture_request(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read Agent Comms fixture request body");
    let body = String::from_utf8(bytes.to_vec()).expect("GET body is UTF-8");
    let index = observed.lock().await.len();
    observed.lock().await.push(serde_json::json!({
        "method": parts.method.as_str(),
        "path": parts.uri.path(),
        "query": parts.uri.query(),
        "host": parts.headers.get(header::HOST).and_then(|value| value.to_str().ok()),
        "authorization": parts.headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()),
        "body": body,
    }));

    match index {
        0 => Json(serde_json::json!({
            "ok": true,
            "agents": [{
                "id": "scout",
                "name": "Scout",
                "description": "Reads the selected workspace.",
                "model": "fixture-model",
                "engine": "fixture-engine"
            }],
            "count": 1
        }))
        .into_response(),
        1 => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "fixture rejected token" })),
        )
            .into_response(),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "fixture roster unavailable" })),
        )
            .into_response(),
    }
}
