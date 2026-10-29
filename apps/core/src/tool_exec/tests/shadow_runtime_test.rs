//! Runtime contract proof for Shadow's shipped declarative HTTP tools.
//!
//! Core parses the actual Shadow manifest and sends its `core:` URLs through
//! `run_http_tool`. Only the Core scheme is directed to this test's ephemeral
//! 127.0.0.1 fixture. The Shadow capture sidecar, capture database, and external
//! providers are never started or contacted.

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

const SHADOW_MANIFEST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/shadow/manifest.json");
const TEST_NODE_TOKEN: &str = "7f8f20bc1d034b8798474a0de10ef0bb21aaccff9c11d21e74c3b2d65e9a0871";
const ISOLATED_CHILD_ENV: &str = "RYU_CORE_SHADOW_FIXTURE_CHILD";
const LOCAL_EGRESS_GRANT: &str = "tool:http-egress:127.0.0.1";

#[tokio::test]
async fn shipped_shadow_runnables_reach_core_http_runtime_with_expected_requests() {
    // `node_token::active_token` is process-cached. Run the proof in a fresh
    // process with a synthetic token so parallel Core tests cannot supply any
    // ambient credential, and so no real token can reach the local fixture.
    if std::env::var_os(ISOLATED_CHILD_ENV).is_none() {
        let data_dir = tempfile::tempdir().expect("Shadow fixture data directory");
        let executable = std::env::current_exe().expect("Core test executable path");
        let status = std::process::Command::new(executable)
            .args([
                "--exact",
                "tool_exec::tests::shadow_runtime::shipped_shadow_runnables_reach_core_http_runtime_with_expected_requests",
                "--nocapture",
            ])
            .env(ISOLATED_CHILD_ENV, "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", data_dir.path())
            .env("RYU_TOKEN", TEST_NODE_TOKEN)
            .env("RYU_EXEC_APPROVAL_MODE", "off")
            .status()
            .expect("start isolated Shadow Core test process");
        assert!(status.success(), "isolated Shadow test failed: {status}");
        return;
    }

    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = super::CmdEnvGuard::armed();

    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral Shadow loopback fixture");
    let address = listener.local_addr().expect("fixture address");
    let app = Router::new()
        .fallback(shadow_fixture_request)
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic Shadow fixture");
    });
    let bind = format!("127.0.0.1:{}", address.port());
    let _core_bind = super::EnvOverride::set("RYU_BIND", &bind);
    let _node_token = super::EnvOverride::set("RYU_TOKEN", TEST_NODE_TOKEN);

    let typed_manifest = crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(
        SHADOW_MANIFEST,
        |path| Err(format!("unexpected Shadow code file: {path}")),
    )
    .expect("Core parses and validates the shipped Shadow manifest");
    assert_eq!(typed_manifest.runnables.len(), 5);
    assert_eq!(
        typed_manifest
            .runnables
            .iter()
            .map(|runnable| runnable.id.as_str())
            .collect::<HashSet<_>>(),
        HashSet::from([
            "tool-shadow-search",
            "tool-shadow-semantic-search",
            "tool-shadow-timeline",
            "tool-shadow-recent-context",
            "tool-shadow-computer-use"
        ])
    );

    let manifest: Value = serde_json::from_str(SHADOW_MANIFEST).expect("valid Shadow JSON");
    assert_eq!(manifest["id"], "@ryu/shadow");
    assert_eq!(
        manifest["permission_grants"],
        serde_json::json!([LOCAL_EGRESS_GRANT])
    );
    let grants = manifest["permission_grants"]
        .as_array()
        .expect("Shadow declares permission grants")
        .iter()
        .map(|grant| {
            grant
                .as_str()
                .expect("permission grant is a string")
                .to_owned()
        })
        .collect::<HashSet<_>>();

    let tool_cases = [
        ("shadow.search", "/api/shadow/search"),
        ("shadow.semantic_search", "/api/shadow/search/semantic"),
        ("shadow.timeline", "/api/shadow/timeline"),
        ("shadow.recent_context", "/api/shadow/context/recent"),
    ];
    for (slug, path) in tool_cases {
        let config = runnable_config(&manifest, slug);
        assert_eq!(config["backend"], "http", "{slug} backend");
        assert_eq!(config["method"], "GET", "{slug} method");
        assert_eq!(config["url"], format!("core:{path}"), "{slug} URL");
        assert_eq!(
            config["secret_headers"]["Authorization"], "Bearer env:RYU_TOKEN",
            "{slug} authorization source"
        );
        assert_eq!(config["fail_open"], true, "{slug} fail-open contract");
        assert_eq!(config["unwrap_body"], true, "{slug} success contract");
    }

    let search = runnable_config(&manifest, "shadow.search");
    let denied = call_shadow_tool(
        search,
        serde_json::json!({ "q": "denied" }),
        &HashSet::new(),
    )
    .await
    .expect_err("Core refuses the HTTP request without its declared egress grant");
    assert_eq!(
        denied,
        "http egress to '127.0.0.1' is not granted (needs 'tool:http-egress:127.0.0.1')"
    );
    assert!(
        observed.lock().await.is_empty(),
        "grant denial must happen before the loopback handler receives a request"
    );

    let success_cases = [
        (
            "shadow.search",
            serde_json::json!({ "q": "alpha", "limit": 3 }),
            serde_json::json!({
                "ok": true,
                "path": "/api/shadow/search",
                "query": { "limit": "3", "q": "alpha" }
            }),
        ),
        (
            "shadow.semantic_search",
            serde_json::json!({ "q": "vector recall", "limit": 2 }),
            serde_json::json!({
                "ok": true,
                "path": "/api/shadow/search/semantic",
                "query": { "limit": "2", "q": "vector recall" }
            }),
        ),
        (
            "shadow.timeline",
            serde_json::json!({ "start": 1_700_000_000, "end": 1_700_000_123 }),
            serde_json::json!({
                "ok": true,
                "path": "/api/shadow/timeline",
                "query": { "end": "1700000123", "start": "1700000000" }
            }),
        ),
        (
            "shadow.recent_context",
            serde_json::json!({ "q": 7 }),
            serde_json::json!({
                "ok": true,
                "path": "/api/shadow/context/recent",
                "query": { "q": "7" }
            }),
        ),
        (
            "shadow.recent_context",
            serde_json::json!({}),
            serde_json::json!({
                "ok": true,
                "path": "/api/shadow/context/recent",
                "query": {}
            }),
        ),
    ];
    for (slug, args, expected) in success_cases {
        let config = runnable_config(&manifest, slug);
        let result = call_shadow_tool(config, args, &grants)
            .await
            .unwrap_or_else(|error| panic!("{slug} failed through Core HTTP runtime: {error}"));
        assert_eq!(
            result, expected,
            "{slug} 2xx response is unwrapped verbatim"
        );
    }

    let unauthorized = call_shadow_tool(
        search,
        serde_json::json!({ "q": "fixture-unauthorized" }),
        &grants,
    )
    .await
    .expect("Shadow's fail-open auth rejection remains a soft-unavailable result");
    assert_eq!(
        unauthorized,
        serde_json::json!({
            "available": false,
            "reason": "endpoint returned HTTP 401",
            "hint": "The endpoint is unreachable or rejected the request; check the key/host and retry."
        })
    );

    let unavailable = call_shadow_tool(
        search,
        serde_json::json!({ "q": "fixture-unavailable" }),
        &grants,
    )
    .await
    .expect("non-auth errors retain their status/body envelope");
    assert_eq!(
        unavailable,
        serde_json::json!({
            "status": 503,
            "body": { "error": "fixture service unavailable" }
        })
    );

    let requests = observed.lock().await.clone();
    let local_host = format!("127.0.0.1:{}", address.port());
    assert_eq!(requests.len(), 7, "each allowed call sends exactly once");
    let expected_requests = [
        ("/api/shadow/search", Some("limit=3&q=alpha")),
        (
            "/api/shadow/search/semantic",
            Some("limit=2&q=vector+recall"),
        ),
        (
            "/api/shadow/timeline",
            Some("end=1700000123&start=1700000000"),
        ),
        ("/api/shadow/context/recent", Some("q=7")),
        ("/api/shadow/context/recent", None),
        ("/api/shadow/search", Some("q=fixture-unauthorized")),
        ("/api/shadow/search", Some("q=fixture-unavailable")),
    ];
    for (request, (path, query)) in requests.iter().zip(expected_requests) {
        assert_eq!(request["method"], "GET");
        assert_eq!(request["path"], path);
        assert_eq!(
            request["query"],
            query.map(Value::from).unwrap_or(Value::Null)
        );
        assert_eq!(request["host"], local_host);
        assert_eq!(
            request["authorization"],
            format!("Bearer {TEST_NODE_TOKEN}")
        );
        assert_eq!(request["body"], "", "GET tools send no body");
    }
    assert!(requests
        .iter()
        .all(|request| !request["body"].to_string().contains(TEST_NODE_TOKEN)));

    // The new authored mutation stays fail-closed and is dispatched through
    // the real registry, with grants persisted/re-read by its PluginStore.
    let computer = runnable_config(&manifest, "shadow.computer_use");
    assert_eq!(computer["method"], "POST");
    assert_eq!(computer["url"], "core:/api/shadow/computer-use/run");
    assert_eq!(computer["fail_open"], false);
    assert_eq!(computer["unwrap_body"], true);
    assert_eq!(
        computer["secret_headers"]["Authorization"],
        "Bearer env:RYU_TOKEN"
    );
    assert_eq!(
        computer["input_schema"]["required"],
        serde_json::json!(["goal"])
    );
    assert_eq!(
        computer["input_schema"]["properties"]["goal"]["minLength"],
        1
    );
    assert_eq!(
        computer["input_schema"]["properties"]["goal"]["maxLength"],
        4096
    );
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store
        .insert(&typed_manifest.id, &typed_manifest.version)
        .await
        .unwrap();
    store
        .set_enabled(&typed_manifest.id, &typed_manifest.permission_grants)
        .await
        .unwrap();
    let manifests = Arc::new(tokio::sync::RwLock::new(vec![typed_manifest]));
    let registry =
        crate::sidecar::mcp::McpRegistry::empty().with_self_build(manifests.clone(), store.clone());
    registry.register_app_tool(
        "shadow.computer_use".into(),
        "shadow.computer_use".into(),
        None,
    );
    let goal = serde_json::json!({"goal":"Open the visible \"Settings\" panel\nwithout submitting a form"});
    let expected = serde_json::json!({"planner":"native","status":"completed","steps":[{"action":"click","target":"Settings"}],"message":"Requested visible panel opened"});
    let agent_denial = Box::pin(registry.call_tool(
        "shadow.computer_use",
        goal.clone(),
        Some(&["shadow.search".into()]),
    ))
    .await
    .unwrap_err();
    assert!(agent_denial
        .to_string()
        .contains("not in this agent's allowlist"));
    assert_eq!(observed.lock().await.len(), requests.len());
    let completed = Box::pin(registry.call_tool("shadow.computer_use", goal.clone(), None))
        .await
        .unwrap();
    assert_eq!(completed, expected);
    let post = observed.lock().await.last().unwrap().clone();
    assert_eq!(post["method"], "POST");
    assert_eq!(post["path"], "/api/shadow/computer-use/run");
    assert_eq!(post["query"], Value::Null);
    assert_eq!(post["host"], local_host);
    assert_eq!(post["authorization"], format!("Bearer {TEST_NODE_TOKEN}"));
    assert_eq!(
        serde_json::from_str::<Value>(post["body"].as_str().unwrap()).unwrap(),
        goal
    );
    for (goal, status, error) in [
        ("fixture-unauthorized", 401, "fixture rejected token"),
        ("fixture-unavailable", 503, "fixture service unavailable"),
        ("", 400, "goal required"),
    ] {
        let result = Box::pin(registry.call_tool(
            "shadow.computer_use",
            serde_json::json!({"goal":goal}),
            None,
        ))
        .await
        .unwrap();
        assert_eq!(
            result,
            serde_json::json!({"status":status,"body":{"error":error}})
        );
        assert!(
            result.get("available").is_none(),
            "mutation HTTP refusals must retain status, not claim success/unavailability"
        );
    }
    let before_revoke = observed.lock().await.len();
    manifests.write().await[0].permission_grants.clear();
    store.set_enabled("@ryu/shadow", &[]).await.unwrap();
    let denied = Box::pin(registry.call_tool("shadow.computer_use", goal.clone(), None))
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("not granted"));
    assert_eq!(observed.lock().await.len(), before_revoke);
    manifests.write().await[0].permission_grants = vec![LOCAL_EGRESS_GRANT.into()];
    store
        .set_enabled("@ryu/shadow", &[LOCAL_EGRESS_GRANT.into()])
        .await
        .unwrap();
    let retried = Box::pin(registry.call_tool("shadow.computer_use", goal, None))
        .await
        .unwrap();
    assert_eq!(retried, expected);
    assert_eq!(observed.lock().await.len(), before_revoke + 1);
    assert!(observed
        .lock()
        .await
        .iter()
        .all(|request| !request["body"].to_string().contains(TEST_NODE_TOKEN)));
    server.abort();
    let _ = server.await;
    let mutation_transport = Box::pin(registry.call_tool(
        "shadow.computer_use",
        serde_json::json!({"goal":"after listener close"}),
        None,
    ))
    .await
    .unwrap_err();
    assert!(mutation_transport
        .to_string()
        .contains("http tool request failed:"));
    assert_eq!(observed.lock().await.len(), before_revoke + 1);
    let transport_error = call_shadow_tool(
        search,
        serde_json::json!({ "q": "fixture-transport-error" }),
        &grants,
    )
    .await
    .expect("the manifest keeps transport failures fail-open");
    assert_eq!(transport_error["available"], false);
    assert!(transport_error["reason"]
        .as_str()
        .is_some_and(|reason| reason.starts_with("endpoint not reachable:")));
    assert_eq!(observed.lock().await.len(), before_revoke + 1);
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

async fn call_shadow_tool(
    config: &Value,
    args: Value,
    grants: &HashSet<String>,
) -> Result<Value, String> {
    use crate::plugin_manifest::schema::{ToolBackend, ToolConfig};

    let tool_config: ToolConfig = serde_json::from_value(config.clone())
        .expect("Core parses the shipped Shadow HTTP tool config");
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
        .expect("Core resolves the shipped Shadow HTTP backend")
    else {
        panic!("Shadow tool must resolve to Core's HTTP backend");
    };
    assert!(
        header_params.is_empty(),
        "Shadow has no ordinary header params"
    );
    assert!(body_defaults.is_null(), "Shadow declares no body defaults");

    super::super::run_http_tool(
        &url,
        &method,
        args,
        &header_params,
        &secret_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        grants,
        &[],
        "@ryu/shadow",
        None,
    )
    .await
}

async fn shadow_fixture_request(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read Shadow fixture request body");
    let body = String::from_utf8(bytes.to_vec()).expect("HTTP request body is UTF-8");
    let query = parts.uri.query().map(str::to_owned);
    let query_map = query
        .as_deref()
        .map(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .into_owned()
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let query_value = query_map.get("q").map(String::as_str).unwrap_or_default();
    let record = serde_json::json!({
        "method": parts.method.as_str(),
        "path": parts.uri.path(),
        "query": query,
        "host": parts.headers.get(header::HOST).and_then(|value| value.to_str().ok()),
        "authorization": parts.headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()),
        "body": body,
    });
    observed.lock().await.push(record);

    let known_get = [
        "/api/shadow/search",
        "/api/shadow/search/semantic",
        "/api/shadow/timeline",
        "/api/shadow/context/recent",
    ];
    let computer_use = parts.method == axum::http::Method::POST
        && parts.uri.path() == "/api/shadow/computer-use/run";
    if !(computer_use
        || (parts.method == axum::http::Method::GET && known_get.contains(&parts.uri.path())))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some(format!("Bearer {TEST_NODE_TOKEN}").as_str())
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if computer_use {
        assert!(query.is_none());
        let input: Value = serde_json::from_str(&body).expect("real computer-use POST JSON");
        let goal = input["goal"].as_str().expect("goal is a string");
        assert_eq!(
            input.as_object().unwrap().len(),
            1,
            "no credential or model-only fields forwarded"
        );
        return match goal {
            "fixture-unauthorized" => (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error":"fixture rejected token"}))).into_response(),
            "fixture-unavailable" => (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({"error":"fixture service unavailable"}))).into_response(),
            "" => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error":"goal required"}))).into_response(),
            "Open the visible \"Settings\" panel\nwithout submitting a form" => Json(serde_json::json!({"planner":"native","status":"completed","steps":[{"action":"click","target":"Settings"}],"message":"Requested visible panel opened"})).into_response(),
            _ => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error":"unknown fixture goal"}))).into_response(),
        };
    }
    match query_value {
        "fixture-unauthorized" => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "fixture rejected token" })),
        )
            .into_response(),
        "fixture-unavailable" => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "fixture service unavailable" })),
        )
            .into_response(),
        _ => (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "path": parts.uri.path(),
                "query": query_map,
            })),
        )
            .into_response(),
    }
}
