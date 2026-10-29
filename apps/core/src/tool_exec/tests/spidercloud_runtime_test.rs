//! Runtime contract proof for Spider Cloud's shipped crawl tool.
//!
//! Core parses the actual manifest and runs its method, schema, and body defaults
//! through `run_http_tool`. Only the transport origin and authorization source are
//! replaced for this test, directing the request to an ephemeral 127.0.0.1 fixture
//! with a synthetic node token. No Spider Cloud host or real API key is contacted.
//! The remote crawler's crawl semantics and provider response remain outside this
//! local dispatcher proof.

use super::*;
use axum::{
    body::Body,
    extract::State,
    http::{header, Request, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};

const SPIDERCLOUD_MANIFEST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/spidercloud/manifest.json");
const TEST_NODE_TOKEN: &str = "a7218d743b2140ab90e75bd4f2fc0b31a62d5d2b";
const ISOLATED_CHILD_ENV: &str = "RYU_CORE_SPIDERCLOUD_FIXTURE_CHILD";
const LOCAL_URL: &str = "core:/crawl";
const LOCAL_EGRESS_GRANT: &str = "tool:http-egress:127.0.0.1";

#[tokio::test]
async fn shipped_spidercloud_crawl_runs_with_exact_core_payload_defaults_and_errors() {
    // The Core node token is process-cached. A fresh headless process supplies
    // only this synthetic token so parallel tests and ambient credentials cannot
    // leak into the fixture request.
    if std::env::var_os(ISOLATED_CHILD_ENV).is_none() {
        let data_dir = tempfile::tempdir().expect("Spider Cloud fixture data directory");
        let executable = std::env::current_exe().expect("Core test executable path");
        let status = std::process::Command::new(executable)
            .args([
                "--exact",
                "tool_exec::tests::spidercloud_runtime::shipped_spidercloud_crawl_runs_with_exact_core_payload_defaults_and_errors",
                "--nocapture",
            ])
            .env(ISOLATED_CHILD_ENV, "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", data_dir.path())
            .env("RYU_TOKEN", TEST_NODE_TOKEN)
            .env_remove("RYU_SPIDERCLOUD_API_KEY")
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("ALL_PROXY")
            .env_remove("http_proxy")
            .env_remove("https_proxy")
            .env_remove("all_proxy")
            .status()
            .expect("start isolated Spider Cloud Core test process");
        assert!(
            status.success(),
            "isolated Spider Cloud test failed: {status}"
        );
        return;
    }

    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = super::CmdEnvGuard::armed();

    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral Spider Cloud loopback fixture");
    let address = listener.local_addr().expect("fixture address");
    let app = Router::new()
        .fallback(spidercloud_fixture_request)
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic Spider Cloud fixture");
    });
    let bind = format!("127.0.0.1:{}", address.port());
    let _core_bind = super::EnvOverride::set("RYU_BIND", &bind);
    let _node_token = super::EnvOverride::set("RYU_TOKEN", TEST_NODE_TOKEN);

    let typed_manifest = crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(
        SPIDERCLOUD_MANIFEST,
        |path| Err(format!("unexpected Spider Cloud code file: {path}")),
    )
    .expect("Core parses and validates the shipped Spider Cloud manifest");
    assert_eq!(typed_manifest.runnables.len(), 1);
    let manifest: Value =
        serde_json::from_str(SPIDERCLOUD_MANIFEST).expect("valid Spider Cloud JSON");
    assert_eq!(manifest["id"], "@ryu/spidercloud");
    assert_eq!(
        manifest["permission_grants"],
        serde_json::json!(["tool:http-egress:api.spider.cloud"])
    );

    let config = runnable_config(&manifest, "spidercloud.crawl");
    assert_eq!(config["backend"], "http");
    assert_eq!(config["method"], "POST");
    assert_eq!(config["url"], "https://api.spider.cloud/crawl");
    assert_eq!(
        reqwest::Url::parse(config["url"].as_str().unwrap())
            .unwrap()
            .path(),
        "/crawl"
    );
    assert_eq!(
        config["secret_headers"]["Authorization"],
        "Bearer env:RYU_SPIDERCLOUD_API_KEY"
    );
    assert_eq!(config["fail_open"], true);
    assert_eq!(
        config["body_defaults"],
        serde_json::json!({
            "limit": 10,
            "return_format": "markdown",
            "request": "smart",
            "metadata": true,
            "depth": 3
        })
    );
    assert_eq!(
        config["input_schema"]["required"],
        serde_json::json!(["url"])
    );
    assert_eq!(config["input_schema"]["properties"]["limit"]["default"], 10);

    let tool_config: crate::plugin_manifest::schema::ToolConfig =
        serde_json::from_value(config.clone()).expect("Core parses the shipped HTTP tool config");
    let crate::plugin_manifest::schema::ToolBackend::Http {
        url,
        method,
        header_params,
        fail_open,
        unwrap_body,
        body_defaults,
        ..
    } = tool_config
        .resolve_backend()
        .expect("Core resolves the shipped Spider Cloud HTTP backend")
    else {
        panic!("spidercloud.crawl must resolve to Core's HTTP backend");
    };
    assert_eq!(url, "https://api.spider.cloud/crawl");
    assert_eq!(method, "POST");
    assert!(header_params.is_empty());
    assert!(fail_open);
    assert!(
        !unwrap_body,
        "the shipped config keeps Core's status/body envelope"
    );

    // The manifest's external egress grant must not authorize the fixture's
    // loopback destination. A test-only local grant is required after origin
    // rewriting, and all request bytes stay on this process's listener.
    let manifest_grants = manifest["permission_grants"]
        .as_array()
        .expect("Spider Cloud declares permission grants")
        .iter()
        .map(|grant| {
            grant
                .as_str()
                .expect("permission grant is a string")
                .to_owned()
        })
        .collect::<HashSet<_>>();
    let local_url = crate::tool_exec::resolve_core_url(LOCAL_URL);
    let fixture_headers = BTreeMap::from([(
        "Authorization".to_owned(),
        "Bearer env:RYU_TOKEN".to_owned(),
    )]);
    let denied = call_spidercloud_fixture(
        &local_url,
        &method,
        &fixture_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &manifest_grants,
        serde_json::json!({ "url": "https://fixture.invalid/docs" }),
    )
    .await
    .expect_err("the external manifest grant does not authorize loopback");
    assert_eq!(
        denied,
        "http egress to '127.0.0.1' is not granted (needs 'tool:http-egress:127.0.0.1')"
    );
    assert!(observed.lock().await.is_empty());

    let local_grants = grants(&[LOCAL_EGRESS_GRANT]);
    let overridden_limit = call_spidercloud_fixture(
        &local_url,
        &method,
        &fixture_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &local_grants,
        serde_json::json!({
            "url": "https://fixture.invalid/docs",
            "limit": 4
        }),
    )
    .await
    .expect("the shipped config reaches only the loopback fixture");
    assert_eq!(
        overridden_limit,
        serde_json::json!({
            "status": 200,
            "body": { "ok": true, "url": "https://fixture.invalid/docs", "limit": 4 }
        })
    );

    let default_limit = call_spidercloud_fixture(
        &local_url,
        &method,
        &fixture_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &local_grants,
        serde_json::json!({ "url": "https://fixture.invalid/start" }),
    )
    .await
    .expect("the manifest body default supplies limit when omitted");
    assert_eq!(
        default_limit,
        serde_json::json!({
            "status": 200,
            "body": { "ok": true, "url": "https://fixture.invalid/start", "limit": 10 }
        })
    );

    let unauthorized = call_spidercloud_fixture(
        &local_url,
        &method,
        &fixture_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &local_grants,
        serde_json::json!({ "url": "https://fixture.invalid/unauthorized" }),
    )
    .await
    .expect("the fail-open config converts the fixture auth error");
    assert_eq!(
        unauthorized,
        serde_json::json!({
            "available": false,
            "reason": "endpoint returned HTTP 401",
            "hint": "The endpoint is unreachable or rejected the request; check the key/host and retry."
        })
    );

    let unavailable = call_spidercloud_fixture(
        &local_url,
        &method,
        &fixture_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &local_grants,
        serde_json::json!({ "url": "https://fixture.invalid/unavailable" }),
    )
    .await
    .expect("a non-auth error preserves Core's response envelope");
    assert_eq!(
        unavailable,
        serde_json::json!({
            "status": 503,
            "body": { "error": "fixture crawl unavailable" }
        })
    );

    let requests = observed.lock().await.clone();
    assert_eq!(requests.len(), 4, "each permitted call sends exactly once");
    let local_host = format!("127.0.0.1:{}", bind.rsplit(':').next().unwrap());
    let expected_bodies = [
        serde_json::json!({
            "url": "https://fixture.invalid/docs",
            "limit": 4,
            "return_format": "markdown",
            "request": "smart",
            "metadata": true,
            "depth": 3
        }),
        serde_json::json!({
            "url": "https://fixture.invalid/start",
            "limit": 10,
            "return_format": "markdown",
            "request": "smart",
            "metadata": true,
            "depth": 3
        }),
        serde_json::json!({
            "url": "https://fixture.invalid/unauthorized",
            "limit": 10,
            "return_format": "markdown",
            "request": "smart",
            "metadata": true,
            "depth": 3
        }),
        serde_json::json!({
            "url": "https://fixture.invalid/unavailable",
            "limit": 10,
            "return_format": "markdown",
            "request": "smart",
            "metadata": true,
            "depth": 3
        }),
    ];
    for (request, expected_body) in requests.iter().zip(expected_bodies) {
        assert_eq!(request["method"], "POST");
        assert_eq!(request["path"], "/crawl");
        assert_eq!(request["query"], Value::Null);
        assert_eq!(request["host"], local_host);
        assert_eq!(request["content_type"], "application/json");
        assert_eq!(
            request["authorization"],
            format!("Bearer {TEST_NODE_TOKEN}")
        );
        assert_eq!(request["body"], expected_body);
    }

    server.abort();
    let _ = server.await;
    let transport_error = call_spidercloud_fixture(
        &local_url,
        &method,
        &fixture_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &local_grants,
        serde_json::json!({ "url": "https://fixture.invalid/transport" }),
    )
    .await
    .expect("the fail-open config preserves transport unavailability");
    assert_eq!(transport_error["available"], false);
    assert!(transport_error["reason"]
        .as_str()
        .is_some_and(|reason| reason.starts_with("endpoint not reachable:")));
    assert_eq!(observed.lock().await.len(), requests.len());
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

#[allow(clippy::too_many_arguments)]
async fn call_spidercloud_fixture(
    url: &str,
    method: &str,
    secret_headers: &BTreeMap<String, String>,
    fail_open: bool,
    unwrap_body: bool,
    body_defaults: &Value,
    grants: &HashSet<String>,
    args: Value,
) -> Result<Value, String> {
    super::super::run_http_tool(
        url,
        method,
        args,
        &[],
        secret_headers,
        fail_open,
        unwrap_body,
        body_defaults,
        grants,
        &[],
        "@ryu/spidercloud",
        None,
    )
    .await
}

async fn spidercloud_fixture_request(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read Spider Cloud fixture request body");
    let body: Value = serde_json::from_slice(&bytes).expect("Core sends JSON POST requests");
    let record = serde_json::json!({
        "method": parts.method.as_str(),
        "path": parts.uri.path(),
        "query": parts.uri.query(),
        "host": parts.headers.get(header::HOST).and_then(|value| value.to_str().ok()),
        "content_type": parts.headers.get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()),
        "authorization": parts.headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()),
        "body": body.clone(),
    });
    let input_url = body["url"].as_str().unwrap_or_default().to_owned();
    observed.lock().await.push(record);

    match input_url.rsplit('/').next().unwrap_or_default() {
        "unauthorized" => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "fixture rejected auth" })),
        )
            .into_response(),
        "unavailable" => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "fixture crawl unavailable" })),
        )
            .into_response(),
        _ => (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "url": input_url,
                "limit": body["limit"].clone(),
            })),
        )
            .into_response(),
    }
}
