//! Runtime contract proof for Exa's shipped declarative HTTP tools.
//!
//! Core parses the shipped manifest and sends each runnable through its real
//! `run_http_tool` dispatcher. Only the two declared Exa origins are rewritten
//! to an ephemeral loopback fixture; no Exa or external MCP request is made.
//! The fake API key is resolved and projected separately because Core correctly
//! refuses to send secret headers to a plain-HTTP fixture.

use super::*;
use axum::{
    body::Body,
    extract::State,
    http::{header, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use std::{collections::BTreeMap, sync::Arc};

const EXA_MANIFEST: &str = include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/exa/manifest.json");
const TEST_API_KEY: &str = "exa-fixture-key-not-real";

#[tokio::test]
async fn shipped_exa_runnables_reach_core_http_runtime_and_preserve_contracts() {
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = super::CmdEnvGuard::armed();
    let _key = super::EnvOverride::set("RYU_EXA_API_KEY", TEST_API_KEY);

    let typed_manifest = crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(
        EXA_MANIFEST,
        |path| match path {
            "adapters/web.search.js" => Ok(include_str!(
                "../../../../../generated/ryu-runtime/plugins-store/plugins/exa/adapters/web.search.js"
            )
            .to_owned()),
            other => Err(format!("unexpected Exa code file: {other}")),
        },
    )
    .expect("Core parses, hydrates, and validates Exa's shipped manifest");
    assert_eq!(typed_manifest.runnables.len(), 3);
    assert!(typed_manifest.code_file_refs().is_empty());

    let manifest: Value = serde_json::from_str(EXA_MANIFEST).expect("valid Exa manifest JSON");
    assert_eq!(manifest["id"], "@ryu/exa");
    assert_eq!(
        manifest["permission_grants"],
        serde_json::json!([
            "tool:http-egress:api.exa.ai",
            "tool:http-egress:mcp.exa.ai",
            "tool:execute"
        ])
    );
    assert_eq!(manifest["runnables"].as_array().map(Vec::len), Some(3));

    let search = runnable_config(&manifest, "exa.search");
    let find_similar = runnable_config(&manifest, "exa.find_similar");
    let free_search = runnable_config(&manifest, "exa.free_search");
    assert_http_config(search, "https://api.exa.ai/search");
    assert_http_config(find_similar, "https://api.exa.ai/findSimilar");
    assert_http_config(free_search, "https://mcp.exa.ai/mcp");
    assert_eq!(
        search["body_defaults"],
        serde_json::json!({
            "numResults": 10,
            "contents": {"text": true}
        })
    );
    assert_eq!(
        find_similar["body_defaults"],
        serde_json::json!({"numResults": 10})
    );
    assert_eq!(
        search["input_schema"]["required"],
        serde_json::json!(["query"])
    );
    assert_eq!(
        find_similar["input_schema"]["required"],
        serde_json::json!(["url"])
    );
    assert_eq!(
        free_search["input_schema"]["required"],
        serde_json::json!(["Accept", "jsonrpc", "id", "method", "params"])
    );
    assert_eq!(free_search["header_params"], serde_json::json!(["Accept"]));
    assert!(free_search.get("secret_headers").is_none());
    assert_eq!(
        search["input_schema"]["properties"]["query"]["type"],
        "string"
    );
    assert_eq!(
        search["input_schema"]["properties"]["numResults"]["type"],
        "integer"
    );
    assert_eq!(
        search["input_schema"]["properties"]["numResults"]["minimum"],
        1
    );
    assert_eq!(
        search["input_schema"]["properties"]["numResults"]["maximum"],
        100
    );
    // Exa's REST body is camelCase. A snake_case `num_results` is not an Exa
    // field, so the default and every caller-supplied limit were ignored.
    assert!(search["input_schema"]["properties"]
        .get("num_results")
        .is_none());
    assert!(search["input_schema"]["properties"]
        .get("use_autoprompt")
        .is_none());
    assert_eq!(
        find_similar["input_schema"]["properties"]["url"]["type"],
        "string"
    );
    assert_eq!(
        find_similar["input_schema"]["properties"]["numResults"]["type"],
        "integer"
    );
    assert_eq!(
        find_similar["input_schema"]["properties"]["numResults"]["minimum"],
        1
    );
    assert_eq!(
        find_similar["input_schema"]["properties"]["numResults"]["maximum"],
        100
    );
    for (property, expected_type) in [
        ("Accept", "string"),
        ("jsonrpc", "string"),
        ("id", "integer"),
        ("method", "string"),
        ("params", "object"),
    ] {
        assert_eq!(
            free_search["input_schema"]["properties"][property]["type"], expected_type,
            "free-search {property} schema"
        );
    }

    // Resolve only the fake key, then prove Core's REST projection places it in
    // Authorization and nowhere in the model arguments, URL, or body.
    for (slug, args) in [
        (
            "exa.search",
            serde_json::json!({"query": "secret projection"}),
        ),
        (
            "exa.find_similar",
            serde_json::json!({"url": "https://article.example/story"}),
        ),
    ] {
        let config = runnable_config(&manifest, slug);
        let source = config["secret_headers"]["Authorization"]
            .as_str()
            .expect("Exa Authorization source");
        assert_eq!(source, "Bearer env:RYU_EXA_API_KEY");
        let resolved = super::super::resolve_secret_header_source(
            "Authorization",
            source,
            "@ryu/exa",
            &[],
            None,
        )
        .await
        .expect("Core resolves the fake Exa env key")
        .expect("test key is present");
        assert_eq!(resolved, format!("Bearer {TEST_API_KEY}"));

        let tool_config: crate::plugin_manifest::schema::ToolConfig =
            serde_json::from_value(config.clone()).expect("Core parses Exa ToolConfig");
        let crate::plugin_manifest::schema::ToolBackend::Http {
            url,
            method,
            header_params,
            ..
        } = tool_config
            .resolve_backend()
            .expect("Core resolves Exa HTTP backend")
        else {
            panic!("{slug} must resolve to Core's HTTP backend");
        };
        let (projected_url, query, body, headers) = super::super::build_rest_request(
            &url,
            &args,
            method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD"),
            &header_params,
            &[("Authorization".to_owned(), resolved.clone())],
        )
        .expect("Core lowers the fake secret into the declared header");
        assert_eq!(
            headers,
            vec![("Authorization".to_owned(), format!("Bearer {TEST_API_KEY}"))]
        );
        assert!(!projected_url.contains(TEST_API_KEY));
        assert!(query.iter().all(|(_, value)| !value.contains(TEST_API_KEY)));
        assert!(!body.to_string().contains(TEST_API_KEY));
    }

    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral Exa loopback fixture");
    let address = listener.local_addr().expect("fixture address");
    let app = Router::new()
        .route("/search", post(exa_fixture_request))
        .route("/findSimilar", post(exa_fixture_request))
        .route("/mcp", post(exa_fixture_request))
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic Exa fixture");
    });
    let local_grants = super::grants(&["tool:http-egress:127.0.0.1"]);

    // Core rejects the actual manifest secret template before any request can
    // reach the plain-HTTP fixture. The later dispatcher calls carry no key.
    let search_tool: crate::plugin_manifest::schema::ToolConfig =
        serde_json::from_value(search.clone()).expect("Core parses Exa search ToolConfig");
    let crate::plugin_manifest::schema::ToolBackend::Http {
        url,
        method,
        header_params,
        secret_headers,
        fail_open,
        unwrap_body,
        body_defaults,
        ..
    } = search_tool
        .resolve_backend()
        .expect("Core resolves Exa search HTTP backend")
    else {
        unreachable!("Exa search is a declared HTTP tool");
    };
    let local_search_url =
        loopback_url(&url, address.port()).expect("map only the declared Exa search origin");
    let secret_rejection = super::super::run_http_tool(
        &local_search_url,
        &method,
        serde_json::json!({"query": "must not send the fake key to loopback"}),
        &header_params,
        &secret_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &local_grants,
        &[],
        "@ryu/exa",
        None,
    )
    .await
    .expect_err("Core refuses secret headers on the plain-HTTP fixture");
    assert!(secret_rejection.contains("secret headers require an HTTPS destination"));
    assert!(
        observed.lock().await.is_empty(),
        "secret rejection makes no request"
    );

    let default_search = run_exa_manifest_tool(
        &manifest,
        "exa.search",
        serde_json::json!({"query": "fixture defaults"}),
        address.port(),
        &local_grants,
    )
    .await
    .expect("default search reaches only the loopback fixture");
    assert_eq!(
        default_search,
        serde_json::json!({"results": [{"title": "Fixture search result", "url": "https://result.example/search"}]})
    );

    let overridden_search = run_exa_manifest_tool(
        &manifest,
        "exa.search",
        serde_json::json!({
            "query": "fixture overrides",
            "numResults": 4
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("overridden search reaches only the loopback fixture");
    assert_eq!(
        overridden_search["results"][0]["title"],
        "Fixture search result"
    );

    let default_find_similar = run_exa_manifest_tool(
        &manifest,
        "exa.find_similar",
        serde_json::json!({"url": "https://article.example/source"}),
        address.port(),
        &local_grants,
    )
    .await
    .expect("default find-similar reaches only the loopback fixture");
    assert_eq!(
        default_find_similar,
        serde_json::json!({"results": [{"title": "Fixture similar result", "url": "https://result.example/similar"}]})
    );

    let overridden_find_similar = run_exa_manifest_tool(
        &manifest,
        "exa.find_similar",
        serde_json::json!({
            "url": "https://article.example/override",
            "numResults": 3
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("overridden find-similar reaches only the loopback fixture");
    assert_eq!(
        overridden_find_similar["results"][0]["title"],
        "Fixture similar result"
    );

    let free_search = run_exa_manifest_tool(
        &manifest,
        "exa.free_search",
        serde_json::json!({
            "Accept": "application/json, text/event-stream",
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "web_search_exa",
                "arguments": {"query": "fixture free search", "numResults": 6}
            }
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("public MCP search reaches only the loopback fixture");
    assert!(free_search
        .as_str()
        .is_some_and(|body| body.starts_with("event: message\n")));

    let auth_failure = run_exa_manifest_tool(
        &manifest,
        "exa.search",
        serde_json::json!({"query": "fixture-unauthorized"}),
        address.port(),
        &local_grants,
    )
    .await
    .expect("fail-open 401 is returned as an unavailable envelope");
    assert_eq!(
        auth_failure,
        serde_json::json!({
            "available": false,
            "reason": "endpoint returned HTTP 401",
            "hint": "The endpoint is unreachable or rejected the request; check the key/host and retry."
        })
    );

    let service_unavailable = run_exa_manifest_tool(
        &manifest,
        "exa.search",
        serde_json::json!({"query": "fixture-unavailable"}),
        address.port(),
        &local_grants,
    )
    .await
    .expect("503 keeps the status/body envelope with fail-open enabled");
    assert_eq!(
        service_unavailable,
        serde_json::json!({
            "status": 503,
            "body": {"error": "fixture service unavailable"}
        })
    );

    let requests = observed.lock().await.clone();
    let local_host = format!("127.0.0.1:{}", address.port());
    let expected_requests = [
        (
            "/search",
            serde_json::json!({
                "query": "fixture defaults",
                "numResults": 10,
                "contents": {"text": true}
            }),
            serde_json::json!("*/*"),
        ),
        (
            "/search",
            serde_json::json!({
                "query": "fixture overrides",
                "numResults": 4,
                "contents": {"text": true}
            }),
            serde_json::json!("*/*"),
        ),
        (
            "/findSimilar",
            serde_json::json!({
                "url": "https://article.example/source",
                "numResults": 10
            }),
            serde_json::json!("*/*"),
        ),
        (
            "/findSimilar",
            serde_json::json!({
                "url": "https://article.example/override",
                "numResults": 3
            }),
            serde_json::json!("*/*"),
        ),
        (
            "/mcp",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "web_search_exa",
                    "arguments": {"query": "fixture free search", "numResults": 6}
                }
            }),
            serde_json::json!("application/json, text/event-stream"),
        ),
        (
            "/search",
            serde_json::json!({
                "query": "fixture-unauthorized",
                "numResults": 10,
                "contents": {"text": true}
            }),
            serde_json::json!("*/*"),
        ),
        (
            "/search",
            serde_json::json!({
                "query": "fixture-unavailable",
                "numResults": 10,
                "contents": {"text": true}
            }),
            serde_json::json!("*/*"),
        ),
    ];
    assert_eq!(
        requests.len(),
        expected_requests.len(),
        "one request per dispatch"
    );
    for (request, (path, body, accept)) in requests.iter().zip(expected_requests) {
        assert_eq!(request["method"], "POST");
        assert_eq!(request["host"], local_host);
        assert_eq!(request["path"], path, "exact Exa route");
        assert_eq!(request["query"], Value::Null, "POST args stay in JSON body");
        assert_eq!(request["body"], body, "Core defaults and header projection");
        assert_eq!(
            request["accept"], accept,
            "free search's caller Accept replaces the HTTP client's default"
        );
        assert_eq!(request["authorization"], Value::Null);
    }
    assert!(
        !serde_json::to_string(&requests)
            .expect("serialize loopback requests")
            .contains(TEST_API_KEY),
        "the fake Exa key never reaches the HTTP fixture"
    );

    server.abort();
    let _ = server.await;
}

fn assert_http_config(config: &Value, expected_url: &str) {
    assert_eq!(config["backend"], "http");
    assert_eq!(config["url"], expected_url);
    assert_eq!(config["method"], "POST");
    assert_eq!(config["fail_open"], true);
    assert_eq!(config["unwrap_body"], true);
}

fn runnable_config<'a>(manifest: &'a Value, slug: &str) -> &'a Value {
    manifest["runnables"]
        .as_array()
        .and_then(|runnables| {
            runnables
                .iter()
                .find(|runnable| runnable["config"]["slug"] == slug)
        })
        .map(|runnable| &runnable["config"])
        .unwrap_or_else(|| panic!("Exa manifest is missing {slug}"))
}

async fn run_exa_manifest_tool(
    manifest: &Value,
    slug: &str,
    args: Value,
    local_port: u16,
    local_grants: &std::collections::HashSet<String>,
) -> Result<Value, String> {
    let config = runnable_config(manifest, slug);
    let tool_config: crate::plugin_manifest::schema::ToolConfig =
        serde_json::from_value(config.clone()).map_err(|error| error.to_string())?;
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
        .map_err(|error| format!("{slug} HTTP backend: {error}"))?
    else {
        return Err(format!("{slug} did not resolve to an HTTP backend"));
    };
    let local_url = loopback_url(&url, local_port)?;

    super::super::run_http_tool(
        &local_url,
        &method,
        args,
        &header_params,
        &BTreeMap::new(),
        fail_open,
        unwrap_body,
        &body_defaults,
        local_grants,
        &[],
        "@ryu/exa",
        None,
    )
    .await
}

fn loopback_url(manifest_url: &str, local_port: u16) -> Result<String, String> {
    let parsed = reqwest::Url::parse(manifest_url).map_err(|error| error.to_string())?;
    if parsed.scheme() != "https" {
        return Err(format!(
            "Exa endpoint must remain HTTPS in manifest: {manifest_url}"
        ));
    }
    let valid_route = matches!(
        (parsed.host_str(), parsed.path()),
        (Some("api.exa.ai"), "/search")
            | (Some("api.exa.ai"), "/findSimilar")
            | (Some("mcp.exa.ai"), "/mcp")
    );
    if !valid_route {
        return Err(format!("unexpected Exa host or route in {manifest_url}"));
    }
    Ok(format!("http://127.0.0.1:{local_port}{}", parsed.path()))
}

async fn exa_fixture_request(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read fixture request body");
    let body: Value = serde_json::from_slice(&bytes).expect("Core sends JSON request bodies");
    let path = parts.uri.path().to_owned();
    let record = serde_json::json!({
        "method": parts.method.as_str(),
        "path": path,
        "query": parts.uri.query(),
        "host": parts.headers.get(header::HOST).and_then(|value| value.to_str().ok()),
        "accept": parts.headers.get(header::ACCEPT).and_then(|value| value.to_str().ok()),
        "authorization": parts.headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()),
        "body": body,
    });
    observed.lock().await.push(record.clone());

    if path == "/search" && record["body"]["query"] == "fixture-unauthorized" {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "fixture rejected key"})),
        )
            .into_response();
    }
    if path == "/search" && record["body"]["query"] == "fixture-unavailable" {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "fixture service unavailable"})),
        )
            .into_response();
    }

    match path.as_str() {
        "/search" => (
            StatusCode::OK,
            Json(serde_json::json!({
                "results": [{"title": "Fixture search result", "url": "https://result.example/search"}]
            })),
        )
            .into_response(),
        "/findSimilar" => (
            StatusCode::OK,
            Json(serde_json::json!({
                "results": [{"title": "Fixture similar result", "url": "https://result.example/similar"}]
            })),
        )
            .into_response(),
        "/mcp" => {
            let event = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {"content": [{"type": "text", "text": "Fixture MCP results"}]}
            });
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "text/event-stream")],
                format!("event: message\ndata: {event}\n\n"),
            )
                .into_response()
        }
        _ => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "unexpected Exa fixture route"})),
        )
            .into_response(),
    }
}
