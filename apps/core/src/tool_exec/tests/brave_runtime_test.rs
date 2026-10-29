//! Runtime contract proof for Brave's shipped declarative HTTP tool.
//!
//! The test reads the marketplace manifest and runs its GET request through
//! Core's real `run_http_tool` dispatcher. It rewrites only the declared Brave
//! origin to an ephemeral loopback server; the fixture receives every request,
//! so this test never contacts Brave. Core intentionally forbids secret headers
//! over plain HTTP, therefore the real env-template resolver and header
//! projection are asserted separately from the loopback request.

use super::*;
use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use std::{collections::BTreeMap, sync::Arc};

const BRAVE_MANIFEST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/brave/manifest.json");
const BRAVE_API_KEY: &str = "brave-test-key-not-real";

#[tokio::test]
async fn shipped_brave_search_reaches_core_http_runtime_and_preserves_contracts() {
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = super::CmdEnvGuard::armed();
    let _key = super::EnvOverride::set("RYU_BRAVE_API_KEY", BRAVE_API_KEY);

    let manifest: Value = serde_json::from_str(BRAVE_MANIFEST).expect("valid Brave manifest");
    assert_eq!(manifest["id"], "@ryu/brave");
    assert_eq!(
        manifest["permission_grants"],
        serde_json::json!(["tool:http-egress:api.search.brave.com"])
    );
    assert_eq!(manifest["runnables"].as_array().map(Vec::len), Some(1));

    let config = runnable_config(&manifest, "brave.search");
    let remote_url = reqwest::Url::parse(
        config["url"]
            .as_str()
            .expect("Brave search URL in manifest"),
    )
    .expect("valid Brave search URL");
    assert_eq!(remote_url.scheme(), "https");
    assert_eq!(remote_url.host_str(), Some("api.search.brave.com"));
    assert_eq!(remote_url.path(), "/res/v1/web/search");
    assert!(
        remote_url.query().is_none(),
        "base URL has no query options"
    );
    assert_eq!(config["backend"], "http");
    assert_eq!(config["method"], "GET");
    assert_eq!(config["fail_open"], true);
    assert_eq!(config["unwrap_body"], true);
    assert!(config.get("body_defaults").is_none());
    assert_eq!(config["input_schema"]["required"], serde_json::json!(["q"]));

    // Resolve the exact shipped env template through Core, then prove its bare
    // value becomes only the declared request header and never a query/body arg.
    let secret_template = config["secret_headers"]["X-Subscription-Token"]
        .as_str()
        .expect("Brave subscription-token template");
    assert_eq!(secret_template, "env:RYU_BRAVE_API_KEY");
    let resolved = super::super::resolve_secret_header_source(
        "X-Subscription-Token",
        secret_template,
        "@ryu/brave",
        &[],
        None,
    )
    .await
    .expect("Core resolves the declared env secret");
    assert_eq!(resolved.as_deref(), Some(BRAVE_API_KEY));

    let sample_args = serde_json::json!({ "q": "key stays out of query" });
    let (projected_url, projected_query, projected_body, projected_headers) =
        super::super::build_rest_request(
            config["url"].as_str().unwrap(),
            &sample_args,
            true,
            &[],
            &[(
                "X-Subscription-Token".to_owned(),
                resolved.expect("resolved dummy key"),
            )],
        )
        .expect("Core lowers the secret into the outgoing header");
    assert_eq!(projected_url, config["url"].as_str().unwrap());
    assert_eq!(
        projected_query,
        vec![("q".to_owned(), "key stays out of query".to_owned())]
    );
    assert!(projected_body.is_null(), "GET requests have no body");
    assert_eq!(
        projected_headers,
        vec![("X-Subscription-Token".to_owned(), BRAVE_API_KEY.to_owned())]
    );
    assert!(!projected_query
        .iter()
        .any(|(_, value)| value.contains(BRAVE_API_KEY)));
    assert!(!projected_body.to_string().contains(BRAVE_API_KEY));

    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind deterministic local Brave fixture");
    let address = listener.local_addr().expect("fixture address");
    let app = Router::new()
        .route("/res/v1/web/search", get(brave_fixture_request))
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic local Brave fixture");
    });
    let local_grants = super::grants(&["tool:http-egress:127.0.0.1"]);

    // Brave has no manifest defaults: omitting optional parameters leaves those
    // options to Brave's documented defaults. The runtime must send only `q`.
    let default_result = run_brave_manifest_tool(
        &manifest,
        serde_json::json!({ "q": "fixture default search" }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("default search reaches the local fixture");
    assert_eq!(
        default_result,
        serde_json::json!({
            "type": "search",
            "web": {
                "results": [{
                    "title": "Fixture result",
                    "url": "https://result.example/item",
                    "description": "Deterministic Brave result"
                }]
            }
        }),
        "2xx response returns the upstream JSON body verbatim"
    );

    let overridden_result = run_brave_manifest_tool(
        &manifest,
        serde_json::json!({
            "q": "fixture override search",
            "count": 7,
            "offset": 2,
            "country": "CA",
            "search_lang": "fr",
            "safesearch": "strict",
            "freshness": "pw"
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("search options reach the local fixture");
    assert_eq!(
        overridden_result["web"]["results"][0]["title"],
        "Fixture result"
    );

    // fail_open turns auth rejection into the soft-unavailable shape. Other
    // non-2xx status codes preserve both status and upstream response body.
    let auth_failure = run_brave_manifest_tool(
        &manifest,
        serde_json::json!({ "q": "fixture-auth-failure" }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("fail-open auth response is returned to the caller");
    assert_eq!(auth_failure["available"], false);
    assert_eq!(auth_failure["reason"], "endpoint returned HTTP 403");

    let rate_limit = run_brave_manifest_tool(
        &manifest,
        serde_json::json!({ "q": "fixture-rate-limit" }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("rate-limit response is returned to the caller");
    assert_eq!(
        rate_limit,
        serde_json::json!({
            "status": 429,
            "body": { "error": "fixture rate limit" }
        })
    );

    let requests = observed.lock().await.clone();
    assert_eq!(
        requests.len(),
        4,
        "one local fixture request per runtime call"
    );
    let local_host = format!("127.0.0.1:{}", address.port());
    let default_query = query_pairs(&requests[0]);
    assert_eq!(
        default_query,
        BTreeMap::from([("q".to_owned(), "fixture default search".to_owned())]),
        "omitted optional parameters remain omitted"
    );
    let overridden_query = query_pairs(&requests[1]);
    assert_eq!(
        overridden_query,
        BTreeMap::from([
            ("q".to_owned(), "fixture override search".to_owned()),
            ("count".to_owned(), "7".to_owned()),
            ("offset".to_owned(), "2".to_owned()),
            ("country".to_owned(), "CA".to_owned()),
            ("search_lang".to_owned(), "fr".to_owned()),
            ("safesearch".to_owned(), "strict".to_owned()),
            ("freshness".to_owned(), "pw".to_owned()),
        ]),
        "explicit query options reach Brave under their declared names"
    );

    for request in &requests {
        assert_eq!(request["method"], "GET");
        assert_eq!(request["path"], "/res/v1/web/search");
        assert_eq!(request["host"], local_host);
        assert_eq!(
            request["body"],
            Value::Null,
            "GET arguments never become a body"
        );
        assert_eq!(request["subscription_token"], Value::Null);
    }
    assert_eq!(requests[2]["query"], "q=fixture-auth-failure");
    assert_eq!(requests[3]["query"], "q=fixture-rate-limit");

    // The only URL passed to Core was the rewritten loopback URL. The recorded
    // Host header and request count prove every dispatched call terminated at the
    // fixture; no request was sent to api.search.brave.com.
    assert!(requests.iter().all(|request| request["host"] == local_host));
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
        .unwrap_or_else(|| panic!("Brave manifest is missing {slug}"))
}

async fn run_brave_manifest_tool(
    manifest: &Value,
    args: Value,
    local_port: u16,
    local_grants: &std::collections::HashSet<String>,
) -> Result<Value, String> {
    let config = runnable_config(manifest, "brave.search");
    let remote_url = config["url"]
        .as_str()
        .ok_or_else(|| "brave.search has no URL".to_owned())?;
    let mut local_url = reqwest::Url::parse(remote_url).map_err(|error| error.to_string())?;
    if local_url.host_str() != Some("api.search.brave.com")
        || local_url.path() != "/res/v1/web/search"
    {
        return Err("brave.search no longer targets the declared Brave API path".to_owned());
    }
    local_url
        .set_scheme("http")
        .map_err(|_| "could not map Brave URL to the local fixture scheme".to_owned())?;
    local_url
        .set_host(Some("127.0.0.1"))
        .map_err(|_| "could not map Brave URL to the local fixture host".to_owned())?;
    local_url
        .set_port(Some(local_port))
        .map_err(|_| "could not map Brave URL to the local fixture port".to_owned())?;
    if local_url.host_str() != Some("127.0.0.1")
        || local_url.path() != "/res/v1/web/search"
        || local_url.query().is_some()
    {
        return Err("brave.search URL did not map safely to the local fixture".to_owned());
    }

    run_http_tool(
        local_url.as_str(),
        config["method"]
            .as_str()
            .ok_or_else(|| "brave.search has no HTTP method".to_owned())?,
        args,
        &[],
        &BTreeMap::new(),
        config["fail_open"]
            .as_bool()
            .ok_or_else(|| "brave.search has no boolean fail_open setting".to_owned())?,
        config["unwrap_body"]
            .as_bool()
            .ok_or_else(|| "brave.search has no boolean unwrap_body setting".to_owned())?,
        config.get("body_defaults").unwrap_or(&Value::Null),
        local_grants,
        &[],
        "@ryu/brave",
        None,
    )
    .await
}

fn query_pairs(request: &Value) -> BTreeMap<String, String> {
    let query = request["query"]
        .as_str()
        .expect("fixture request query string");
    url::form_urlencoded::parse(query.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

async fn brave_fixture_request(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let body = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read fixture request body");
    let query = parts.uri.query().unwrap_or_default().to_owned();
    let query_args: BTreeMap<String, String> = url::form_urlencoded::parse(query.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let record = serde_json::json!({
        "method": parts.method.as_str(),
        "path": parts.uri.path(),
        "query": query,
        "host": parts.headers.get("host").and_then(|value| value.to_str().ok()),
        "subscription_token": parts.headers.get("x-subscription-token").and_then(|value| value.to_str().ok()),
        "body": if body.is_empty() { Value::Null } else { serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null) },
    });
    observed.lock().await.push(record);

    match query_args.get("q").map(String::as_str) {
        Some("fixture-auth-failure") => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "fixture rejected dummy key" })),
        )
            .into_response(),
        Some("fixture-rate-limit") => (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "fixture rate limit" })),
        )
            .into_response(),
        _ => Json(serde_json::json!({
            "type": "search",
            "web": {
                "results": [{
                    "title": "Fixture result",
                    "url": "https://result.example/item",
                    "description": "Deterministic Brave result"
                }]
            }
        }))
        .into_response(),
    }
}
