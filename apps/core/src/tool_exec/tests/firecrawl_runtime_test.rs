//! Runtime contract proof for Firecrawl's shipped declarative HTTP tools.
//!
//! Core parses each manifest runnable as a `ToolConfig` and sends the resulting
//! REST request through `run_http_tool`. Only the manifest origin is rewritten to
//! an ephemeral loopback fixture; no Firecrawl request or credential is sent.

use super::*;
use axum::{
    body::Body,
    extract::State,
    http::{header::AUTHORIZATION, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use std::{collections::BTreeMap, sync::Arc};

const FIRECRAWL_MANIFEST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/firecrawl/manifest.json");
const TEST_API_KEY: &str = "fixture-secret-not-a-firecrawl-key";

#[tokio::test]
async fn shipped_firecrawl_runnables_reach_core_http_runtime_and_preserve_contracts() {
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = super::CmdEnvGuard::armed();
    let _key = super::EnvOverride::set("RYU_FIRECRAWL_API_KEY", TEST_API_KEY);

    let typed_manifest = crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(
        FIRECRAWL_MANIFEST,
        |path| match path {
            "adapters/web.crawl.js" => Ok(include_str!(
                "../../../../../generated/ryu-runtime/plugins-store/plugins/firecrawl/adapters/web.crawl.js"
            )
            .to_owned()),
            "adapters/web.extract.js" => Ok(include_str!(
                "../../../../../generated/ryu-runtime/plugins-store/plugins/firecrawl/adapters/web.extract.js"
            )
            .to_owned()),
            other => Err(format!("unexpected Firecrawl code file: {other}")),
        },
    )
    .expect("Core parses, hydrates, and validates Firecrawl's shipped manifest");
    assert_eq!(typed_manifest.runnables.len(), 4);
    assert!(typed_manifest.code_file_refs().is_empty());

    let manifest: Value = serde_json::from_str(FIRECRAWL_MANIFEST).expect("valid Firecrawl JSON");
    assert_eq!(manifest["id"], "@ryu/firecrawl");
    assert_eq!(
        manifest["permission_grants"],
        serde_json::json!(["tool:http-egress:api.firecrawl.dev", "tool:execute"])
    );
    assert_eq!(manifest["runnables"].as_array().map(Vec::len), Some(4));

    let search = runnable_config(&manifest, "firecrawl.search");
    let scrape = runnable_config(&manifest, "firecrawl.scrape");
    let crawl_start = runnable_config(&manifest, "firecrawl.crawl_start");
    let crawl_status = runnable_config(&manifest, "firecrawl.crawl_status");

    assert_http_schema(search, "https://api.firecrawl.dev/v2/search", "POST");
    assert_eq!(
        search["input_schema"]["required"],
        serde_json::json!(["query"])
    );
    assert_eq!(
        search["input_schema"]["properties"]["query"]["type"],
        "string"
    );
    assert_eq!(
        search["input_schema"]["properties"]["limit"]["type"],
        "integer"
    );
    assert_eq!(search["input_schema"]["properties"]["limit"]["minimum"], 1);
    assert_eq!(
        search["input_schema"]["properties"]["limit"]["maximum"],
        100
    );

    assert_http_schema(scrape, "https://api.firecrawl.dev/v2/scrape", "POST");
    assert_eq!(
        scrape["input_schema"]["required"],
        serde_json::json!(["url"])
    );
    assert_eq!(
        scrape["input_schema"]["properties"]["url"]["type"],
        "string"
    );

    assert_http_schema(crawl_start, "https://api.firecrawl.dev/v2/crawl", "POST");
    assert_eq!(
        crawl_start["input_schema"]["required"],
        serde_json::json!(["url"])
    );
    assert_eq!(
        crawl_start["input_schema"]["properties"]["url"]["type"],
        "string"
    );
    assert_eq!(
        crawl_start["input_schema"]["properties"]["limit"]["type"],
        "integer"
    );
    assert_eq!(
        crawl_start["input_schema"]["properties"]["limit"]["minimum"],
        1
    );
    assert_eq!(
        crawl_start["input_schema"]["properties"]["limit"]["maximum"],
        10000
    );
    assert_eq!(
        crawl_start["input_schema"]["properties"]["maxDiscoveryDepth"]["type"],
        "integer"
    );

    assert_http_schema(
        crawl_status,
        "https://api.firecrawl.dev/v2/crawl/{id}",
        "GET",
    );
    assert_eq!(
        crawl_status["input_schema"]["required"],
        serde_json::json!(["id"])
    );
    assert_eq!(
        crawl_status["input_schema"]["properties"]["id"]["type"],
        "string"
    );

    // Core's typed backend resolver keeps the server-side credential template out
    // of the input schema. Resolve only a deterministic fake value and prove the
    // REST projection puts it in Authorization, never in a URL or body.
    for slug in [
        "firecrawl.search",
        "firecrawl.scrape",
        "firecrawl.crawl_start",
        "firecrawl.crawl_status",
    ] {
        let config = runnable_config(&manifest, slug);
        let tool_config: crate::plugin_manifest::schema::ToolConfig =
            serde_json::from_value(config.clone()).expect("Core parses Firecrawl ToolConfig");
        let crate::plugin_manifest::schema::ToolBackend::Http {
            url,
            method,
            header_params,
            secret_headers,
            ..
        } = tool_config
            .resolve_backend()
            .expect("Core resolves HTTP backend")
        else {
            panic!("{slug} must resolve to Core's HTTP backend");
        };
        assert_eq!(
            secret_headers.get("Authorization").map(String::as_str),
            Some("Bearer env:RYU_FIRECRAWL_API_KEY")
        );
        let resolved = super::super::resolve_secret_header_source(
            "Authorization",
            secret_headers.get("Authorization").unwrap(),
            "@ryu/firecrawl",
            &[],
            None,
        )
        .await
        .expect("Core resolves only the fake Firecrawl env key")
        .expect("test key is present");
        assert_eq!(resolved, format!("Bearer {TEST_API_KEY}"));

        let args = match slug {
            "firecrawl.search" => serde_json::json!({"query":"secret projection", "limit":4}),
            "firecrawl.scrape" => serde_json::json!({"url":"https://article.example/story"}),
            "firecrawl.crawl_start" => serde_json::json!({"url":"https://site.example", "limit":9}),
            "firecrawl.crawl_status" => serde_json::json!({"id":"crawl-job-7"}),
            _ => unreachable!("only declared Firecrawl slugs are covered"),
        };
        let bodyless = method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD");
        let (projected_url, projected_query, projected_body, projected_headers) =
            super::super::build_rest_request(
                &url,
                &args,
                bodyless,
                &header_params,
                &[("Authorization".to_owned(), resolved)],
            )
            .expect("Core lowers fake secret to the declared header");
        assert_eq!(projected_headers[0].0, "Authorization");
        assert_eq!(projected_headers[0].1, format!("Bearer {TEST_API_KEY}"));
        assert!(!projected_url.contains(TEST_API_KEY));
        assert!(!projected_query
            .iter()
            .any(|(_, value)| value.contains(TEST_API_KEY)));
        assert!(!projected_body.to_string().contains(TEST_API_KEY));
    }

    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind deterministic local Firecrawl fixture");
    let address = listener.local_addr().expect("fixture address");
    let app = Router::new()
        .route("/v2/search", any(firecrawl_fixture_request))
        .route("/v2/scrape", any(firecrawl_fixture_request))
        .route("/v2/crawl", any(firecrawl_fixture_request))
        .route("/v2/crawl/:id", any(firecrawl_fixture_request))
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic local Firecrawl fixture");
    });
    let local_grants = super::grants(&["tool:http-egress:127.0.0.1"]);

    // Passing the manifest's real secret-header template to Core with a plain
    // HTTP loopback URL is rejected before secret resolution or network I/O.
    let secret_config: crate::plugin_manifest::schema::ToolConfig =
        serde_json::from_value(search.clone()).expect("search ToolConfig");
    let crate::plugin_manifest::schema::ToolBackend::Http {
        url,
        method,
        header_params,
        secret_headers,
        fail_open,
        unwrap_body,
        body_defaults,
        ..
    } = secret_config
        .resolve_backend()
        .expect("search HTTP backend")
    else {
        unreachable!("Firecrawl search is an HTTP tool")
    };
    let local_url = loopback_url(&url, address.port()).expect("map only Firecrawl origin");
    let secret_rejection = super::super::run_http_tool(
        &local_url,
        &method,
        serde_json::json!({"query":"must not send a secret over loopback"}),
        &header_params,
        &secret_headers,
        fail_open,
        unwrap_body,
        &body_defaults,
        &local_grants,
        &[],
        "@ryu/firecrawl",
        None,
    )
    .await
    .expect_err("Core refuses secret headers on the plain-HTTP local fixture");
    assert!(secret_rejection.contains("secret headers require an HTTPS destination"));
    assert!(
        observed.lock().await.is_empty(),
        "secret rejection makes no request"
    );

    let default_search = run_firecrawl_manifest_tool(
        &manifest,
        "firecrawl.search",
        serde_json::json!({"query":"fixture default search"}),
        address.port(),
        &local_grants,
    )
    .await
    .expect("default search reaches the local fixture");
    assert_eq!(
        default_search,
        serde_json::json!({
            "success": true,
            "data": {
                "web": [{
                    "title": "Fixture result",
                    "url": "https://result.example/article",
                    "description": "Deterministic Firecrawl result"
                }]
            }
        })
    );

    let overridden_search = run_firecrawl_manifest_tool(
        &manifest,
        "firecrawl.search",
        serde_json::json!({"query":"fixture override search", "limit":7}),
        address.port(),
        &local_grants,
    )
    .await
    .expect("overridden search reaches the local fixture");
    assert_eq!(
        overridden_search["data"]["web"][0]["title"],
        "Fixture result"
    );

    let scraped = run_firecrawl_manifest_tool(
        &manifest,
        "firecrawl.scrape",
        serde_json::json!({"url":"https://article.example/story"}),
        address.port(),
        &local_grants,
    )
    .await
    .expect("scrape reaches the local fixture");
    assert_eq!(
        scraped,
        serde_json::json!({
            "success": true,
            "data": {
                "markdown": "# Fixture article",
                "metadata": {
                    "sourceURL": "https://article.example/final",
                    "title": "Fixture article"
                }
            }
        })
    );

    let default_crawl = run_firecrawl_manifest_tool(
        &manifest,
        "firecrawl.crawl_start",
        serde_json::json!({"url":"https://site.example/start"}),
        address.port(),
        &local_grants,
    )
    .await
    .expect("default crawl start reaches the local fixture");
    assert_eq!(
        default_crawl,
        serde_json::json!({"success":true, "id":"crawl-job-7", "url":"https://site.example/start"})
    );

    let overridden_crawl = run_firecrawl_manifest_tool(
        &manifest,
        "firecrawl.crawl_start",
        serde_json::json!({
            "url":"https://site.example/override",
            "limit":23,
            "maxDiscoveryDepth":4
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("overridden crawl options reach the local fixture");
    assert_eq!(overridden_crawl["id"], "crawl-job-7");

    let crawl_status = run_firecrawl_manifest_tool(
        &manifest,
        "firecrawl.crawl_status",
        serde_json::json!({"id":"crawl-job-7"}),
        address.port(),
        &local_grants,
    )
    .await
    .expect("crawl status reaches the local fixture");
    assert_eq!(
        crawl_status,
        serde_json::json!({
            "success": true,
            "status": "completed",
            "data": [{"url":"https://site.example/start", "markdown":"# Crawled page"}]
        })
    );

    // The declared `{id}` path parameter is consumed by Core and a missing value
    // is refused before a request reaches the local fixture.
    let missing_id = run_firecrawl_manifest_tool(
        &manifest,
        "firecrawl.crawl_status",
        serde_json::json!({}),
        address.port(),
        &local_grants,
    )
    .await
    .expect_err("Core requires the status path parameter");
    assert!(missing_id.contains("missing path parameter(s): id"));

    let auth_failure = run_firecrawl_manifest_tool(
        &manifest,
        "firecrawl.search",
        serde_json::json!({"query":"fixture-auth-failure"}),
        address.port(),
        &local_grants,
    )
    .await
    .expect("fail-open auth response is returned to the caller");
    assert_eq!(
        auth_failure,
        serde_json::json!({
            "available": false,
            "reason": "endpoint returned HTTP 401",
            "hint": "The endpoint is unreachable or rejected the request; check the key/host and retry."
        })
    );

    let upstream_failure = run_firecrawl_manifest_tool(
        &manifest,
        "firecrawl.search",
        serde_json::json!({"query":"fixture-upstream-failure"}),
        address.port(),
        &local_grants,
    )
    .await
    .expect("503 remains a status/body envelope");
    assert_eq!(
        upstream_failure,
        serde_json::json!({
            "status": 503,
            "body": {"error":"fixture temporarily unavailable"}
        })
    );

    let requests = observed.lock().await.clone();
    let local_host = format!("127.0.0.1:{}", address.port());
    assert_eq!(
        requests,
        vec![
            expected_request(
                "POST",
                "/v2/search",
                &local_host,
                None,
                serde_json::json!({"query":"fixture default search"})
            ),
            expected_request(
                "POST",
                "/v2/search",
                &local_host,
                None,
                serde_json::json!({"query":"fixture override search", "limit":7})
            ),
            expected_request(
                "POST",
                "/v2/scrape",
                &local_host,
                None,
                serde_json::json!({"url":"https://article.example/story"})
            ),
            expected_request(
                "POST",
                "/v2/crawl",
                &local_host,
                None,
                serde_json::json!({"url":"https://site.example/start"})
            ),
            expected_request(
                "POST",
                "/v2/crawl",
                &local_host,
                None,
                serde_json::json!({"url":"https://site.example/override", "limit":23, "maxDiscoveryDepth":4})
            ),
            expected_request(
                "GET",
                "/v2/crawl/crawl-job-7",
                &local_host,
                None,
                Value::Null
            ),
            expected_request(
                "POST",
                "/v2/search",
                &local_host,
                None,
                serde_json::json!({"query":"fixture-auth-failure"})
            ),
            expected_request(
                "POST",
                "/v2/search",
                &local_host,
                None,
                serde_json::json!({"query":"fixture-upstream-failure"})
            ),
        ],
        "Core sends each exact method, route, and projected parameter body only to loopback"
    );
    assert!(
        requests
            .iter()
            .all(|request| request["authorization"].is_null()),
        "no Authorization secret reaches the loopback fixture"
    );
    assert!(
        !serde_json::to_string(&requests)
            .expect("serialize fixture requests")
            .contains(TEST_API_KEY),
        "the fake Firecrawl key never reaches the loopback fixture"
    );

    server.abort();
    let _ = server.await;
}

fn assert_http_schema(config: &Value, expected_url: &str, expected_method: &str) {
    assert_eq!(config["backend"], "http");
    assert_eq!(config["url"], expected_url);
    assert_eq!(config["method"], expected_method);
    assert_eq!(config["fail_open"], true);
    assert_eq!(config["unwrap_body"], true);
    assert!(config.get("body_defaults").is_none());
    assert_eq!(
        config["secret_headers"]["Authorization"],
        "Bearer env:RYU_FIRECRAWL_API_KEY"
    );
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
        .unwrap_or_else(|| panic!("Firecrawl manifest is missing {slug}"))
}

async fn run_firecrawl_manifest_tool(
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
        "@ryu/firecrawl",
        None,
    )
    .await
}

fn loopback_url(manifest_url: &str, local_port: u16) -> Result<String, String> {
    let path = manifest_url
        .strip_prefix("https://api.firecrawl.dev")
        .filter(|path| path.starts_with("/v2/"))
        .ok_or_else(|| "Firecrawl URL no longer targets api.firecrawl.dev/v2".to_owned())?;
    Ok(format!("http://127.0.0.1:{local_port}{path}"))
}

fn expected_request(
    method: &str,
    path: &str,
    host: &str,
    query: Option<&str>,
    body: Value,
) -> Value {
    serde_json::json!({
        "method": method,
        "path": path,
        "query": query,
        "host": host,
        "authorization": Value::Null,
        "body": body,
    })
}

async fn firecrawl_fixture_request(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read fixture request body");
    let body: Value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("Firecrawl sends a JSON body")
    };
    let path = parts.uri.path().to_owned();
    let method = parts.method.as_str().to_owned();
    let query = parts.uri.query().map(str::to_owned);
    let host = parts
        .headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let authorization = parts
        .headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    observed.lock().await.push(serde_json::json!({
        "method": method,
        "path": path,
        "query": query,
        "host": host,
        "authorization": authorization,
        "body": body,
    }));

    let (status, response) = match (method.as_str(), path.as_str(), body["query"].as_str()) {
        ("POST", "/v2/search", Some("fixture-auth-failure")) => (
            StatusCode::UNAUTHORIZED,
            serde_json::json!({"error":"fixture unauthorized"}),
        ),
        ("POST", "/v2/search", Some("fixture-upstream-failure")) => (
            StatusCode::SERVICE_UNAVAILABLE,
            serde_json::json!({"error":"fixture temporarily unavailable"}),
        ),
        ("POST", "/v2/search", _) => (
            StatusCode::OK,
            serde_json::json!({
                "success": true,
                "data": {
                    "web": [{
                        "title": "Fixture result",
                        "url": "https://result.example/article",
                        "description": "Deterministic Firecrawl result"
                    }]
                }
            }),
        ),
        ("POST", "/v2/scrape", _) => (
            StatusCode::OK,
            serde_json::json!({
                "success": true,
                "data": {
                    "markdown": "# Fixture article",
                    "metadata": {
                        "sourceURL": "https://article.example/final",
                        "title": "Fixture article"
                    }
                }
            }),
        ),
        ("POST", "/v2/crawl", _) => (
            StatusCode::OK,
            serde_json::json!({
                "success": true,
                "id": "crawl-job-7",
                "url": body["url"]
            }),
        ),
        ("GET", "/v2/crawl/crawl-job-7", _) => (
            StatusCode::OK,
            serde_json::json!({
                "success": true,
                "status": "completed",
                "data": [{"url":"https://site.example/start", "markdown":"# Crawled page"}]
            }),
        ),
        _ => (
            StatusCode::NOT_FOUND,
            serde_json::json!({"error":"unexpected fixture route"}),
        ),
    };
    (status, Json(response)).into_response()
}
