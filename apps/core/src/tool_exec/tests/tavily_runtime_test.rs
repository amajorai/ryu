//! Runtime contract proof for Tavily's shipped declarative HTTP tools.
//!
//! This consumes the marketplace manifest and sends both runnable configs
//! through Core's real `run_http_tool` dispatcher. The only URL mutation is the
//! upstream origin, rewritten to an ephemeral loopback fixture. The manifest's
//! secret source is resolved and lowered separately because Core correctly
//! refuses to send secret headers over the fixture's plain HTTP connection.

use super::*;
use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use std::{collections::BTreeMap, sync::Arc};

const TAVILY_MANIFEST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/tavily/manifest.json");
const TEST_API_KEY: &str = "tavily-test-key-not-real";

#[tokio::test]
async fn shipped_tavily_runnables_reach_core_http_runtime_and_preserve_contracts() {
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = super::CmdEnvGuard::armed();
    let _key = super::EnvOverride::set("RYU_TAVILY_API_KEY", TEST_API_KEY);

    let manifest: Value = serde_json::from_str(TAVILY_MANIFEST).expect("valid Tavily manifest");
    assert_eq!(manifest["id"], "@ryu/tavily");
    assert_eq!(
        manifest["permission_grants"],
        serde_json::json!(["tool:http-egress:api.tavily.com", "tool:execute"])
    );

    let search = runnable_config(&manifest, "tavily.search");
    let extract = runnable_config(&manifest, "tavily.extract");
    for config in [&search, &extract] {
        assert_eq!(config["backend"], "http");
        assert_eq!(config["method"], "POST");
        assert_eq!(config["fail_open"], true);
        assert_eq!(config["unwrap_body"], true);
        assert_eq!(
            config["secret_headers"]["Authorization"],
            "Bearer env:RYU_TAVILY_API_KEY"
        );
    }
    assert_eq!(search["url"], "https://api.tavily.com/search");
    assert_eq!(extract["url"], "https://api.tavily.com/extract");
    assert_eq!(
        search["body_defaults"],
        serde_json::json!({
            "max_results": 10,
            "search_depth": "basic"
        })
    );
    assert!(extract.get("body_defaults").is_none());
    assert_eq!(
        search["input_schema"]["required"],
        serde_json::json!(["query"])
    );
    assert_eq!(
        extract["input_schema"]["required"],
        serde_json::json!(["urls"])
    );

    // Resolve the actual manifest template with a deterministic test value, then
    // prove Core projects it only into the outgoing header—not model arguments.
    for config in [&search, &extract] {
        let source = config["secret_headers"]["Authorization"]
            .as_str()
            .expect("Tavily Authorization source");
        let resolved = super::super::resolve_secret_header_source(
            "Authorization",
            source,
            "@ryu/tavily",
            &[],
            None,
        )
        .await
        .expect("Core resolves the declared env secret");
        let header_value = format!("Bearer {TEST_API_KEY}");
        assert_eq!(resolved.as_deref(), Some(header_value.as_str()));

        let args = if config["slug"] == "tavily.search" {
            serde_json::json!({ "query": "secret stays out of args" })
        } else {
            serde_json::json!({ "urls": ["https://article.example/story"] })
        };
        let (_, query, body, headers) = super::super::build_rest_request(
            config["url"].as_str().unwrap(),
            &args,
            false,
            &[],
            &[("Authorization".to_owned(), resolved.unwrap())],
        )
        .expect("Core lowers the resolved secret to a header");
        assert!(query.is_empty());
        assert_eq!(body, args, "the credential must not enter the JSON body");
        assert!(!body.to_string().contains(TEST_API_KEY));
        assert_eq!(headers, vec![("Authorization".to_owned(), header_value)]);
    }

    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind deterministic local Tavily fixture");
    let address = listener.local_addr().expect("fixture address");
    let app = Router::new()
        .route("/search", any(tavily_fixture_request))
        .route("/extract", any(tavily_fixture_request))
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic local Tavily fixture");
    });
    let local_grants = super::grants(&["tool:http-egress:127.0.0.1"]);

    let default_search = run_tavily_manifest_tool(
        &manifest,
        "tavily.search",
        serde_json::json!({ "query": "fixture default search" }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("default search reaches the local fixture");
    assert_eq!(
        default_search,
        serde_json::json!({
            "query": "fixture default search",
            "results": [{
                "title": "Fixture result",
                "url": "https://result.example/item",
                "content": "Deterministic search result",
                "score": 0.95
            }]
        }),
        "2xx search unwraps the upstream JSON body verbatim"
    );

    let overridden_search = run_tavily_manifest_tool(
        &manifest,
        "tavily.search",
        serde_json::json!({
            "query": "fixture override search",
            "max_results": 3,
            "search_depth": "advanced"
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("overridden search reaches the local fixture");
    assert_eq!(overridden_search["query"], "fixture override search");

    let extracted = run_tavily_manifest_tool(
        &manifest,
        "tavily.extract",
        serde_json::json!({
            "urls": [
                "https://article.example/first",
                "https://article.example/second"
            ]
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("extract reaches the local fixture");
    assert_eq!(
        extracted,
        serde_json::json!({
            "results": [
                {
                    "url": "https://article.example/first",
                    "raw_content": "Fixture article one"
                },
                {
                    "url": "https://article.example/second",
                    "raw_content": "Fixture article two"
                }
            ]
        }),
        "2xx extract unwraps the upstream JSON body verbatim"
    );

    let auth_failure = run_tavily_manifest_tool(
        &manifest,
        "tavily.search",
        serde_json::json!({ "query": "fixture-auth-failure" }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("fail-open auth response is returned to the caller");
    assert_eq!(auth_failure["available"], false);
    assert_eq!(auth_failure["reason"], "endpoint returned HTTP 401");

    let upstream_failure = run_tavily_manifest_tool(
        &manifest,
        "tavily.search",
        serde_json::json!({ "query": "fixture-upstream-failure" }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("non-auth HTTP errors remain a useful fail-open envelope");
    assert_eq!(
        upstream_failure,
        serde_json::json!({
            "status": 503,
            "body": { "error": "fixture upstream unavailable" }
        })
    );

    let empty_extract = run_tavily_manifest_tool(
        &manifest,
        "tavily.extract",
        serde_json::json!({ "urls": ["https://empty.example/"] }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("empty extract response reaches the caller");
    assert_eq!(empty_extract, "");

    let requests = observed.lock().await.clone();
    let local_origin = format!("http://127.0.0.1:{}", address.port());
    let expected = [
        (
            "/search",
            serde_json::json!({
                "max_results": 10,
                "search_depth": "basic",
                "query": "fixture default search"
            }),
        ),
        (
            "/search",
            serde_json::json!({
                "max_results": 3,
                "search_depth": "advanced",
                "query": "fixture override search"
            }),
        ),
        (
            "/extract",
            serde_json::json!({
                "urls": [
                    "https://article.example/first",
                    "https://article.example/second"
                ]
            }),
        ),
        (
            "/search",
            serde_json::json!({
                "max_results": 10,
                "search_depth": "basic",
                "query": "fixture-auth-failure"
            }),
        ),
        (
            "/search",
            serde_json::json!({
                "max_results": 10,
                "search_depth": "basic",
                "query": "fixture-upstream-failure"
            }),
        ),
        (
            "/extract",
            serde_json::json!({ "urls": ["https://empty.example/"] }),
        ),
    ];
    assert_eq!(
        requests.len(),
        expected.len(),
        "one request per runtime call"
    );
    for (request, (path, body)) in requests.iter().zip(expected) {
        assert_eq!(request["method"], "POST", "exact HTTP method");
        assert_eq!(request["path"], path, "exact manifest path");
        assert_eq!(request["uri"], path, "no undeclared query parameters");
        assert_eq!(request["host"], format!("127.0.0.1:{}", address.port()));
        assert_eq!(
            format!(
                "http://{}{}",
                request["host"].as_str().unwrap(),
                request["uri"].as_str().unwrap()
            ),
            format!("{local_origin}{path}"),
            "only the upstream origin is redirected to the fixture"
        );
        assert_eq!(request["body"], body, "exact POST body");
        assert_eq!(request["authorization"], Value::Null);
    }

    server.abort();
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
        .unwrap_or_else(|| panic!("Tavily manifest is missing {slug}"))
}

async fn run_tavily_manifest_tool(
    manifest: &Value,
    slug: &str,
    args: Value,
    local_port: u16,
    local_grants: &std::collections::HashSet<String>,
) -> Result<Value, String> {
    let config = runnable_config(manifest, slug);
    let remote_url = config["url"]
        .as_str()
        .ok_or_else(|| format!("{slug} has no URL"))?;
    let mut local_url = reqwest::Url::parse(remote_url).map_err(|error| error.to_string())?;
    if local_url.host_str() != Some("api.tavily.com") || local_url.scheme() != "https" {
        return Err(format!(
            "{slug} no longer targets the expected HTTPS Tavily origin"
        ));
    }
    let original_path = local_url.path().to_owned();
    local_url
        .set_scheme("http")
        .map_err(|_| format!("{slug} could not map to the local fixture scheme"))?;
    local_url
        .set_host(Some("127.0.0.1"))
        .map_err(|_| format!("{slug} could not map to the local fixture host"))?;
    local_url
        .set_port(Some(local_port))
        .map_err(|_| format!("{slug} could not map to the local fixture port"))?;
    if local_url.path() != original_path {
        return Err(format!("{slug} path changed while mapping its origin"));
    }

    run_http_tool(
        local_url.as_str(),
        config["method"]
            .as_str()
            .ok_or_else(|| format!("{slug} has no HTTP method"))?,
        args,
        &[],
        &BTreeMap::new(),
        config["fail_open"]
            .as_bool()
            .ok_or_else(|| format!("{slug} has no boolean fail_open setting"))?,
        config["unwrap_body"]
            .as_bool()
            .ok_or_else(|| format!("{slug} has no boolean unwrap_body setting"))?,
        config.get("body_defaults").unwrap_or(&Value::Null),
        local_grants,
        &[],
        "@ryu/tavily",
        None,
    )
    .await
}

async fn tavily_fixture_request(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read fixture request body");
    let body: Value = serde_json::from_slice(&bytes).expect("Core sends JSON request bodies");
    let record = serde_json::json!({
        "method": parts.method.as_str(),
        "uri": parts.uri.to_string(),
        "path": parts.uri.path(),
        "query": parts.uri.query(),
        "host": parts.headers.get("host").and_then(|value| value.to_str().ok()),
        "authorization": parts.headers.get("authorization").and_then(|value| value.to_str().ok()),
        "body": body,
    });
    observed.lock().await.push(record.clone());

    if record["path"] == "/search" && record["body"]["query"] == "fixture-auth-failure" {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "fixture rejected test key" })),
        )
            .into_response();
    }
    if record["path"] == "/search" && record["body"]["query"] == "fixture-upstream-failure" {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "fixture upstream unavailable" })),
        )
            .into_response();
    }
    if record["path"] == "/extract" && record["body"]["urls"][0] == "https://empty.example/" {
        return StatusCode::NO_CONTENT.into_response();
    }
    if record["path"] == "/search" {
        return Json(serde_json::json!({
            "query": record["body"]["query"],
            "results": [{
                "title": "Fixture result",
                "url": "https://result.example/item",
                "content": "Deterministic search result",
                "score": 0.95
            }]
        }))
        .into_response();
    }
    if record["path"] == "/extract" {
        return Json(serde_json::json!({
            "results": [
                {
                    "url": record["body"]["urls"][0],
                    "raw_content": "Fixture article one"
                },
                {
                    "url": record["body"]["urls"][1],
                    "raw_content": "Fixture article two"
                }
            ]
        }))
        .into_response();
    }

    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({ "error": "unexpected path" })),
    )
        .into_response()
}
