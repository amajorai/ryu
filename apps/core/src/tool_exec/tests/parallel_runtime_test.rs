//! Runtime contract proof for Parallel's shipped declarative HTTP tools.
//!
//! Core parses the actual package manifest and dispatches its three runnables
//! through `run_http_tool`. Their provider origins are rewritten, after exact
//! host/path checks, to an ephemeral loopback fixture. The manifest's synthetic
//! API key is resolved and projected separately because Core correctly refuses
//! to send secret headers over the fixture's plain HTTP connection.

use super::*;
use axum::{
    body::Body,
    extract::State,
    http::{header, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use std::{
    collections::{BTreeMap, HashSet},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::io::AsyncReadExt;

const PARALLEL_MANIFEST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/parallel/manifest.json");
const TEST_API_KEY: &str = "parallel-fixture-key-not-real";
const LOCAL_EGRESS_GRANT: &str = "tool:http-egress:127.0.0.1";

#[tokio::test]
async fn shipped_parallel_runnables_use_core_dispatcher_for_exact_contracts_and_errors() {
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = super::CmdEnvGuard::armed();
    let _parallel_key = super::EnvOverride::set("RYU_PARALLEL_API_KEY", TEST_API_KEY);
    let _no_proxy = super::EnvOverride::set("NO_PROXY", "127.0.0.1,localhost");
    let _no_proxy_lower = super::EnvOverride::set("no_proxy", "127.0.0.1,localhost");

    let typed_manifest = crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(
        PARALLEL_MANIFEST,
        |path| match path {
            "adapters/web.search.js" => Ok(include_str!(
                "../../../../../generated/ryu-runtime/plugins-store/plugins/parallel/adapters/web.search.js"
            )
            .to_owned()),
            other => Err(format!("unexpected Parallel code file: {other}")),
        },
    )
    .expect("Core parses, hydrates, and validates the shipped Parallel manifest");
    assert_eq!(typed_manifest.runnables.len(), 3);
    assert!(typed_manifest.code_file_refs().is_empty());

    let manifest: Value = serde_json::from_str(PARALLEL_MANIFEST).expect("valid Parallel JSON");
    assert_eq!(manifest["id"], "@ryu/parallel");
    assert_eq!(manifest["runnables"].as_array().map(Vec::len), Some(3));

    let search = runnable_config(&manifest, "parallel.search");
    let free_search = runnable_config(&manifest, "parallel.free_search");
    let extract = runnable_config(&manifest, "parallel.extract");
    assert_http_tool(search, "https://api.parallel.ai/v1/search");
    assert_http_tool(free_search, "https://search.parallel.ai/mcp");
    assert_http_tool(extract, "https://api.parallel.ai/v1/extract");
    assert_eq!(search["body_defaults"], serde_json::json!({"mode":"basic"}));
    assert_eq!(
        extract["body_defaults"]["advanced_settings"]["full_content"],
        true
    );
    assert_eq!(
        search["input_schema"]["required"],
        serde_json::json!(["search_queries"])
    );
    assert_eq!(
        free_search["input_schema"]["required"],
        serde_json::json!(["jsonrpc", "id", "method", "params"])
    );
    assert_eq!(
        extract["input_schema"]["required"],
        serde_json::json!(["urls"])
    );

    // Resolve the package's real env reference with an isolated synthetic key.
    // Core forbids transmitting it to this HTTP fixture, so only its header
    // projection is asserted here; successful HTTP dispatches below carry no key.
    let search_tool: crate::plugin_manifest::schema::ToolConfig =
        serde_json::from_value(search.clone()).expect("Core parses Parallel search config");
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
        .expect("Core resolves Parallel search HTTP backend")
    else {
        unreachable!("Parallel search is a declared HTTP runnable");
    };
    let key_source = secret_headers
        .get("x-api-key")
        .expect("search runnable declares its x-api-key secret");
    let resolved_key = super::super::resolve_secret_header_source(
        "x-api-key",
        key_source,
        "@ryu/parallel",
        &[],
        None,
    )
    .await
    .expect("Core resolves the synthetic node-side Parallel key");
    assert_eq!(resolved_key.as_deref(), Some(TEST_API_KEY));
    let search_args = serde_json::json!({
        "objective": "key remains out of the request body",
        "search_queries": ["Parallel Core fixture"]
    });
    let (projected_url, query, projected_body, headers) = super::super::build_rest_request(
        &url,
        &search_args,
        false,
        &header_params,
        &[("x-api-key".to_owned(), resolved_key.unwrap())],
    )
    .expect("Core lowers the key into a server-side header");
    assert_eq!(projected_url, "https://api.parallel.ai/v1/search");
    assert!(query.is_empty());
    assert_eq!(projected_body, search_args);
    assert!(!projected_body.to_string().contains(TEST_API_KEY));
    assert_eq!(
        headers,
        vec![("x-api-key".to_owned(), TEST_API_KEY.to_owned())]
    );

    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral Parallel loopback fixture");
    let address = listener.local_addr().expect("fixture address");
    let app = Router::new()
        .route("/v1/search", post(parallel_fixture_request))
        .route("/mcp", post(parallel_fixture_request))
        .route("/v1/extract", post(parallel_fixture_request))
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic Parallel fixture");
    });
    let local_grants = super::grants(&[LOCAL_EGRESS_GRANT]);

    // Core checks grants before DNS, Gateway access, or socket I/O.
    let denied = run_parallel_manifest_tool(
        &manifest,
        "parallel.search",
        serde_json::json!({
            "objective": "must be denied before I/O",
            "search_queries": ["grant check"]
        }),
        address.port(),
        &HashSet::new(),
    )
    .await
    .expect_err("missing host grant must be refused");
    assert!(denied.contains("http egress to '127.0.0.1' is not granted"));
    assert!(
        observed.lock().await.is_empty(),
        "grant denial performs no I/O"
    );

    // The real secret template cannot be sent over the HTTP fixture transport.
    // Core must reject it before it opens a connection.
    let local_search_url = loopback_url(
        url.as_str(),
        "api.parallel.ai",
        "/v1/search",
        address.port(),
    )
    .expect("map only the manifest-declared search origin");
    let secret_rejection = super::super::run_http_tool(
        &local_search_url,
        &method,
        search_args,
        &header_params,
        &secret_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &local_grants,
        &[],
        "@ryu/parallel",
        None,
    )
    .await
    .expect_err("Core refuses the secret header on plain HTTP");
    assert!(secret_rejection.contains("secret headers require an HTTPS destination"));
    assert!(
        observed.lock().await.is_empty(),
        "secret guard performs no I/O"
    );

    let search_default = run_parallel_manifest_tool(
        &manifest,
        "parallel.search",
        serde_json::json!({
            "objective": "fixture default search",
            "search_queries": ["runtime defaults", "loopback dispatch"]
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("default search uses Core HTTP dispatch to loopback");
    assert_eq!(
        search_default,
        serde_json::json!({"results":[{"title":"Fixture search result","url":"https://result.example/search"}]})
    );

    let search_override = run_parallel_manifest_tool(
        &manifest,
        "parallel.search",
        serde_json::json!({
            "objective": "fixture override search",
            "search_queries": ["exact body fields"],
            "mode": "fast",
            "max_chars_total": 2300
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("search options reach Core's dispatcher");
    assert_eq!(
        search_override,
        serde_json::json!({"results":[{"title":"Fixture search result","url":"https://result.example/search"}]})
    );

    let free_search_call = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 23,
        "method": "tools/call",
        "params": {
            "name": "web_search",
            "arguments": {
                "objective": "fixture public search",
                "search_queries": ["stateless MCP fixture"]
            }
        }
    });
    let free_search = run_parallel_manifest_tool(
        &manifest,
        "parallel.free_search",
        free_search_call.clone(),
        address.port(),
        &local_grants,
    )
    .await
    .expect("keyless JSON-RPC runnable reaches only the loopback fixture");
    assert_eq!(
        free_search,
        serde_json::json!({
            "jsonrpc":"2.0",
            "id":23,
            "result":{"structuredContent":{"results":[{"title":"Fixture MCP result","url":"https://result.example/mcp"}]}}
        })
    );

    let extract_args = serde_json::json!({
        "urls": ["https://article.example/one", "https://article.example/two"],
        "objective": "fixture full page extraction",
        "search_queries": ["article excerpt context"],
        "max_chars_total": 3100
    });
    let extracted = run_parallel_manifest_tool(
        &manifest,
        "parallel.extract",
        extract_args.clone(),
        address.port(),
        &local_grants,
    )
    .await
    .expect("extract parameters reach Core's dispatcher");
    assert_eq!(
        extracted,
        serde_json::json!({
            "results":[
                {"url":"https://article.example/one","full_content":"Fixture full article"},
                {"url":"https://article.example/two","full_content":"Fixture full article"}
            ]
        })
    );

    // The keyed API's fail-open authentication signal is distinct from service
    // failures: it can drive the adapter's keyless fallback, while 429/503 bodies
    // remain visible. Every call must remain exactly one HTTP request.
    let unauthorized = run_parallel_manifest_tool(
        &manifest,
        "parallel.search",
        serde_json::json!({
            "objective": "fixture-auth-failure",
            "search_queries": ["one rejected call"]
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("fail-open authentication response is returned as an envelope");
    assert_eq!(
        unauthorized,
        serde_json::json!({
            "available": false,
            "reason": "endpoint returned HTTP 401",
            "hint": "The endpoint is unreachable or rejected the request; check the key/host and retry."
        })
    );

    let rate_limited = run_parallel_manifest_tool(
        &manifest,
        "parallel.search",
        serde_json::json!({
            "objective": "fixture-rate-limit",
            "search_queries": ["one rate limited call"]
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("rate-limit response stays visible");
    assert_eq!(
        rate_limited,
        serde_json::json!({"status":429,"body":{"error":"fixture rate limit"}})
    );

    let upstream_failure = run_parallel_manifest_tool(
        &manifest,
        "parallel.extract",
        serde_json::json!({
            "urls": ["https://article.example/one"],
            "objective": "fixture-upstream-failure"
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("5xx response stays visible");
    assert_eq!(
        upstream_failure,
        serde_json::json!({"status":503,"body":{"error":"fixture upstream unavailable"}})
    );

    let requests = observed.lock().await.clone();
    assert_eq!(requests.len(), 7, "no runnable call is retried");
    assert_eq!(requests[0]["method"], "POST");
    assert_eq!(requests[0]["path"], "/v1/search");
    assert_eq!(
        requests[0]["body"],
        serde_json::json!({
            "objective":"fixture default search",
            "search_queries":["runtime defaults","loopback dispatch"],
            "mode":"basic"
        })
    );
    assert_eq!(requests[1]["path"], "/v1/search");
    assert_eq!(
        requests[1]["body"],
        serde_json::json!({
            "objective":"fixture override search",
            "search_queries":["exact body fields"],
            "mode":"fast",
            "max_chars_total":2300
        })
    );
    assert_eq!(requests[2]["method"], "POST");
    assert_eq!(requests[2]["path"], "/mcp");
    assert_eq!(requests[2]["body"], free_search_call);
    assert_eq!(requests[3]["path"], "/v1/extract");
    assert_eq!(
        requests[3]["body"],
        serde_json::json!({
            "urls":["https://article.example/one","https://article.example/two"],
            "objective":"fixture full page extraction",
            "search_queries":["article excerpt context"],
            "max_chars_total":3100,
            "advanced_settings":{"full_content":true}
        })
    );
    assert_eq!(requests[4]["body"]["objective"], "fixture-auth-failure");
    assert_eq!(requests[5]["body"]["objective"], "fixture-rate-limit");
    assert_eq!(requests[6]["path"], "/v1/extract");
    assert_eq!(requests[6]["body"]["objective"], "fixture-upstream-failure");
    assert!(requests.iter().all(|request| request["query"].is_null()));
    assert!(requests
        .iter()
        .all(|request| request["x_api_key"].is_null()));
    assert!(requests
        .iter()
        .all(|request| request["authorization"].is_null()));
    assert!(requests.iter().all(|request| {
        request["host"]
            .as_str()
            .is_some_and(|host| host.starts_with("127.0.0.1:"))
    }));

    server.abort();

    // A fixture that accepts exactly one POST then closes its socket models a
    // transport failure. `fail_open` must return one unavailable envelope, not
    // retry the POST or contact the provider.
    let drop_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral transport-failure fixture");
    let drop_address = drop_listener.local_addr().expect("drop fixture address");
    let accepted = Arc::new(AtomicUsize::new(0));
    let accepted_server = accepted.clone();
    let drop_server = tokio::spawn(async move {
        let (mut stream, _) = drop_listener
            .accept()
            .await
            .expect("accept one transport-failure request");
        accepted_server.fetch_add(1, Ordering::SeqCst);
        let mut request = [0_u8; 4096];
        let _ = stream.read(&mut request).await;
        drop(stream);
    });
    let transport_url = loopback_url(
        search["url"].as_str().expect("search URL"),
        "api.parallel.ai",
        "/v1/search",
        drop_address.port(),
    )
    .expect("transport test maps only the search manifest URL");
    let transport = super::super::run_http_tool(
        &transport_url,
        "POST",
        serde_json::json!({
            "objective": "fixture transport failure",
            "search_queries": ["one dropped request"]
        }),
        &[],
        &BTreeMap::new(),
        true,
        true,
        &search["body_defaults"],
        &local_grants,
        &[],
        "@ryu/parallel",
        None,
    )
    .await
    .expect("fail-open transport failure remains a result envelope");
    assert_eq!(transport["available"], false);
    assert!(transport["reason"]
        .as_str()
        .is_some_and(|reason| reason.starts_with("endpoint not reachable:")));
    tokio::time::timeout(std::time::Duration::from_secs(3), drop_server)
        .await
        .expect("drop fixture accepted the request")
        .expect("drop fixture task completed");
    assert_eq!(
        accepted.load(Ordering::SeqCst),
        1,
        "transport is not retried"
    );
}

fn assert_http_tool(config: &Value, expected_url: &str) {
    assert_eq!(config["backend"], "http");
    assert_eq!(config["method"], "POST");
    assert_eq!(config["url"], expected_url);
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
        .unwrap_or_else(|| panic!("Parallel manifest is missing {slug}"))
}

fn loopback_url(
    manifest_url: &str,
    expected_host: &str,
    expected_path: &str,
    local_port: u16,
) -> Result<String, String> {
    let mut url = reqwest::Url::parse(manifest_url).map_err(|error| error.to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some(expected_host)
        || url.path() != expected_path
    {
        return Err(format!("unexpected Parallel URL {manifest_url}"));
    }
    url.set_scheme("http")
        .map_err(|_| "could not map the Parallel fixture scheme".to_owned())?;
    url.set_host(Some("127.0.0.1"))
        .map_err(|_| "could not map the Parallel fixture host".to_owned())?;
    url.set_port(Some(local_port))
        .map_err(|_| "could not map the Parallel fixture port".to_owned())?;
    if url.host_str() != Some("127.0.0.1") || url.path() != expected_path || url.query().is_some() {
        return Err("Parallel fixture URL did not preserve the expected path".to_owned());
    }
    Ok(url.to_string())
}

async fn run_parallel_manifest_tool(
    manifest: &Value,
    slug: &str,
    args: Value,
    local_port: u16,
    local_grants: &HashSet<String>,
) -> Result<Value, String> {
    let config = runnable_config(manifest, slug);
    let (expected_host, expected_path) = match slug {
        "parallel.search" => ("api.parallel.ai", "/v1/search"),
        "parallel.free_search" => ("search.parallel.ai", "/mcp"),
        "parallel.extract" => ("api.parallel.ai", "/v1/extract"),
        _ => return Err(format!("unexpected Parallel runnable {slug}")),
    };
    let local_url = loopback_url(
        config["url"]
            .as_str()
            .ok_or_else(|| format!("{slug} has no manifest URL"))?,
        expected_host,
        expected_path,
        local_port,
    )?;
    let body_defaults = config.get("body_defaults").unwrap_or(&Value::Null);
    let no_secret_headers = BTreeMap::new();

    super::super::run_http_tool(
        &local_url,
        config["method"]
            .as_str()
            .ok_or_else(|| format!("{slug} has no HTTP method"))?,
        args,
        &[],
        &no_secret_headers,
        config["fail_open"]
            .as_bool()
            .ok_or_else(|| format!("{slug} has no boolean fail_open"))?,
        config["unwrap_body"]
            .as_bool()
            .ok_or_else(|| format!("{slug} has no boolean unwrap_body"))?,
        body_defaults,
        local_grants,
        &[],
        "@ryu/parallel",
        None,
    )
    .await
}

async fn parallel_fixture_request(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read local Parallel request body");
    let body: Value = serde_json::from_slice(&bytes).expect("Core sends JSON bodies");
    let path = parts.uri.path().to_owned();
    let record = serde_json::json!({
        "method": parts.method.as_str(),
        "path": path,
        "query": parts.uri.query(),
        "host": parts.headers.get(header::HOST).and_then(|value| value.to_str().ok()),
        "x_api_key": parts.headers.get("x-api-key").and_then(|value| value.to_str().ok()),
        "authorization": parts.headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()),
        "body": body,
    });
    observed.lock().await.push(record.clone());

    match record["path"].as_str() {
        Some("/v1/search") if record["body"]["objective"] == "fixture-auth-failure" => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error":"fixture rejected synthetic auth"})),
        )
            .into_response(),
        Some("/v1/search") if record["body"]["objective"] == "fixture-rate-limit" => (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error":"fixture rate limit"})),
        )
            .into_response(),
        Some("/v1/extract") if record["body"]["objective"] == "fixture-upstream-failure" => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error":"fixture upstream unavailable"})),
        )
            .into_response(),
        Some("/v1/search") => Json(serde_json::json!({
            "results": [{
                "title": "Fixture search result",
                "url": "https://result.example/search"
            }]
        }))
        .into_response(),
        Some("/mcp") => Json(serde_json::json!({
            "jsonrpc": "2.0",
            "id": record["body"]["id"],
            "result": {
                "structuredContent": {
                    "results": [{
                        "title": "Fixture MCP result",
                        "url": "https://result.example/mcp"
                    }]
                }
            }
        }))
        .into_response(),
        Some("/v1/extract") => {
            let results = record["body"]["urls"]
                .as_array()
                .expect("Parallel extract sends urls")
                .iter()
                .map(|url| {
                    serde_json::json!({
                        "url": url,
                        "full_content": "Fixture full article"
                    })
                })
                .collect::<Vec<_>>();
            Json(serde_json::json!({"results": results})).into_response()
        }
        _ => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error":"unexpected Parallel fixture route"})),
        )
            .into_response(),
    }
}
