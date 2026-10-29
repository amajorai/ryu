//! Runtime contract proof for Serper's shipped declarative HTTP tools.
//!
//! This deliberately consumes `plugins-store/plugins/serper/manifest.json` and
//! sends its runnable configs through Core's real `run_http_tool` dispatcher. The
//! endpoint origins are rewritten to an ephemeral loopback fixture, so the test
//! never contacts Serper and never uses a production key. Secret resolution is
//! checked through Core separately because `run_http_tool` correctly refuses to
//! send secret headers to a plain-HTTP fixture.

use super::*;
use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use std::{collections::BTreeMap, sync::Arc};

const SERPER_MANIFEST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/serper/manifest.json");

#[tokio::test]
async fn shipped_serper_runnables_reach_core_http_runtime_and_preserve_contracts() {
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = super::CmdEnvGuard::armed();
    let _key = super::EnvOverride::set("RYU_SERPER_API_KEY", "serper-test-key-not-real");

    let manifest: Value = serde_json::from_str(SERPER_MANIFEST).expect("valid Serper manifest");
    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind deterministic local Serper fixture");
    let address = listener.local_addr().expect("fixture address");
    let app = Router::new()
        .route("/search", post(serper_fixture_request))
        .route("/", post(serper_fixture_request))
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic local Serper fixture");
    });

    let search = runnable_config(&manifest, "serper.search");
    let scrape = runnable_config(&manifest, "serper.scrape");
    assert_eq!(search["url"], "https://google.serper.dev/search");
    assert_eq!(scrape["url"], "https://scrape.serper.dev");
    assert_eq!(search["method"], "POST");
    assert_eq!(scrape["method"], "POST");
    assert_eq!(search["input_schema"]["required"], serde_json::json!(["q"]));
    assert_eq!(
        scrape["input_schema"]["required"],
        serde_json::json!(["url"])
    );
    assert_eq!(search["input_schema"]["properties"]["num"]["minimum"], 1);
    assert_eq!(search["input_schema"]["properties"]["num"]["maximum"], 100);
    assert_eq!(search["body_defaults"]["num"], 10);
    assert_eq!(scrape["body_defaults"]["includeMarkdown"], true);

    // The auth field is a bare Serper key, resolved by Core's real env-secret
    // resolver for both tools. It is then kept out of the local HTTP fixture call
    // because Core forbids secret_headers on non-HTTPS URLs.
    for config in [&search, &scrape] {
        let source = config["secret_headers"]["X-API-KEY"]
            .as_str()
            .expect("Serper API key source");
        let resolved = super::super::resolve_secret_header_source(
            "X-API-KEY",
            source,
            "@ryu/serper",
            &[],
            None,
        )
        .await
        .expect("Core resolves the declared env secret");
        assert_eq!(resolved.as_deref(), Some("serper-test-key-not-real"));

        let args = serde_json::json!({ "q": "secret stays out of args" });
        let (_, query, body, headers) = super::super::build_rest_request(
            config["url"].as_str().unwrap(),
            &args,
            false,
            &[],
            &[("X-API-KEY".to_owned(), resolved.unwrap())],
        )
        .expect("Core lowers the secret to a header");
        assert!(query.is_empty());
        assert_eq!(body["q"], "secret stays out of args");
        assert!(body.get("X-API-KEY").is_none());
        assert_eq!(
            headers,
            vec![(
                "X-API-KEY".to_owned(),
                "serper-test-key-not-real".to_owned()
            )]
        );
    }

    let local_grants = super::grants(&["tool:http-egress:127.0.0.1"]);

    // Only `num` has a tool-layer default for search. The default must reach the
    // HTTP body when omitted, and model-provided fields must override/augment it.
    let default_search = run_serper_manifest_tool(
        &manifest,
        "serper.search",
        serde_json::json!({ "q": "runtime defaults" }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("default search reaches the local fixture");
    assert_eq!(
        default_search,
        serde_json::json!({
            "organic": [{
                "title": "Fixture result",
                "link": "https://result.example/item",
                "snippet": "Deterministic search result",
                "position": 1
            }]
        }),
        "2xx search unwraps the upstream JSON body verbatim"
    );

    let overridden_search = run_serper_manifest_tool(
        &manifest,
        "serper.search",
        serde_json::json!({
            "q": "runtime argument override",
            "num": 4,
            "page": 2,
            "gl": "ca",
            "hl": "fr",
            "autocorrect": false
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("overridden search reaches the local fixture");
    assert_eq!(overridden_search["organic"][0]["position"], 1);

    // Scrape has a direct-tool default too; an explicit false must win.
    let default_scrape = run_serper_manifest_tool(
        &manifest,
        "serper.scrape",
        serde_json::json!({ "url": "https://article.example/story" }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("default scrape reaches the local fixture");
    assert_eq!(
        default_scrape,
        serde_json::json!({
            "text": "Fixture article body",
            "markdown": "# Fixture article"
        })
    );

    let overridden_scrape = run_serper_manifest_tool(
        &manifest,
        "serper.scrape",
        serde_json::json!({
            "url": "https://article.example/plain-text",
            "includeMarkdown": false
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("overridden scrape reaches the local fixture");
    assert_eq!(overridden_scrape["text"], "Fixture article body");

    // Serper's 401/403 soft-fail is user-visible as unavailable; other HTTP
    // failures retain a status/body envelope even though the tool is fail-open.
    let auth_failure = run_serper_manifest_tool(
        &manifest,
        "serper.search",
        serde_json::json!({ "q": "fixture-auth-failure" }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("fail-open auth response is returned to the caller");
    assert_eq!(auth_failure["available"], false);
    assert_eq!(auth_failure["reason"], "endpoint returned HTTP 403");

    let rate_limit = run_serper_manifest_tool(
        &manifest,
        "serper.search",
        serde_json::json!({ "q": "fixture-rate-limit" }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("rate limit response is returned to the caller");
    assert_eq!(rate_limit["status"], 429);
    assert_eq!(rate_limit["body"]["error"], "fixture rate limit");

    // Empty 204 responses are valid for this generic runtime and remain the empty
    // body value rather than becoming a fabricated scrape record.
    let empty_scrape = run_serper_manifest_tool(
        &manifest,
        "serper.scrape",
        serde_json::json!({ "url": "https://empty.example/" }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("empty scrape response reaches the caller");
    assert_eq!(empty_scrape, "");

    let requests = observed.lock().await.clone();
    let local_origin = format!("http://127.0.0.1:{}", address.port());
    let expected = [
        (
            format!("{local_origin}/search"),
            serde_json::json!({ "num": 10, "q": "runtime defaults" }),
        ),
        (
            format!("{local_origin}/search"),
            serde_json::json!({
                "q": "runtime argument override",
                "num": 4,
                "page": 2,
                "gl": "ca",
                "hl": "fr",
                "autocorrect": false
            }),
        ),
        (
            format!("{local_origin}/"),
            serde_json::json!({
                "url": "https://article.example/story",
                "includeMarkdown": true
            }),
        ),
        (
            format!("{local_origin}/"),
            serde_json::json!({
                "url": "https://article.example/plain-text",
                "includeMarkdown": false
            }),
        ),
        (
            format!("{local_origin}/search"),
            serde_json::json!({ "num": 10, "q": "fixture-auth-failure" }),
        ),
        (
            format!("{local_origin}/search"),
            serde_json::json!({ "num": 10, "q": "fixture-rate-limit" }),
        ),
        (
            format!("{local_origin}/"),
            serde_json::json!({
                "url": "https://empty.example/",
                "includeMarkdown": true
            }),
        ),
    ];
    assert_eq!(
        requests.len(),
        expected.len(),
        "one request per runtime call"
    );
    for (request, (expected_uri, expected_body)) in requests.iter().zip(expected) {
        assert_eq!(request["method"], "POST");
        let observed_url = format!(
            "http://{}{}",
            request["host"].as_str().expect("fixture Host header"),
            request["uri"].as_str().expect("fixture request target")
        );
        assert_eq!(observed_url, expected_uri, "exact request URL");
        assert_eq!(request["query"], Value::Null, "POST args stay in JSON body");
        assert_eq!(request["body"], expected_body);
        assert_eq!(request["x_api_key"], Value::Null);
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
        .unwrap_or_else(|| panic!("Serper manifest is missing {slug}"))
}

async fn run_serper_manifest_tool(
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
    let parsed_remote = reqwest::Url::parse(remote_url).map_err(|error| error.to_string())?;
    let expected_host = match slug {
        "serper.search" => "google.serper.dev",
        "serper.scrape" => "scrape.serper.dev",
        _ => return Err(format!("unexpected Serper tool {slug}")),
    };
    if parsed_remote.host_str() != Some(expected_host) {
        return Err(format!("{slug} no longer targets {expected_host}"));
    }
    let local_origin = format!("http://127.0.0.1:{local_port}");
    let local_url = remote_url.replacen(&format!("https://{expected_host}"), &local_origin, 1);
    if local_url == remote_url || !local_url.starts_with(&local_origin) {
        return Err(format!("{slug} URL did not map to the local fixture"));
    }
    let body_defaults = config.get("body_defaults").unwrap_or(&Value::Null);
    let secret_headers = BTreeMap::new();

    run_http_tool(
        &local_url,
        config["method"]
            .as_str()
            .ok_or_else(|| format!("{slug} has no HTTP method"))?,
        args,
        &[],
        &secret_headers,
        config["fail_open"]
            .as_bool()
            .ok_or_else(|| format!("{slug} has no boolean fail_open setting"))?,
        config["unwrap_body"]
            .as_bool()
            .ok_or_else(|| format!("{slug} has no boolean unwrap_body setting"))?,
        body_defaults,
        local_grants,
        &[],
        "@ryu/serper",
        None,
    )
    .await
}

async fn serper_fixture_request(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read fixture request body");
    let body: Value = serde_json::from_slice(&bytes).expect("Core sends JSON request bodies");
    let uri = parts.uri.to_string();
    let path = parts.uri.path().to_owned();
    let method = parts.method.as_str().to_owned();
    let record = serde_json::json!({
        "method": method,
        "uri": uri,
        "path": path,
        "query": parts.uri.query(),
        "host": parts.headers.get("host").and_then(|value| value.to_str().ok()),
        "x_api_key": parts.headers.get("x-api-key").and_then(|value| value.to_str().ok()),
        "authorization": parts.headers.get("authorization").and_then(|value| value.to_str().ok()),
        "body": body,
    });
    observed.lock().await.push(record.clone());

    if record["body"]["q"] == "fixture-auth-failure" {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "fixture rejects unauthenticated request" })),
        )
            .into_response();
    }
    if record["body"]["q"] == "fixture-rate-limit" {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "fixture rate limit" })),
        )
            .into_response();
    }
    if record["body"]["url"] == "https://empty.example/" {
        return StatusCode::NO_CONTENT.into_response();
    }
    if path == "/search" {
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "organic": [{
                    "title": "Fixture result",
                    "link": "https://result.example/item",
                    "snippet": "Deterministic search result",
                    "position": 1
                }]
            })),
        )
            .into_response()
    } else if path == "/" {
        (
            StatusCode::OK,
            Json(serde_json::json!({
                "text": "Fixture article body",
                "markdown": "# Fixture article"
            })),
        )
            .into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "unexpected fixture route" })),
        )
            .into_response()
    }
}
