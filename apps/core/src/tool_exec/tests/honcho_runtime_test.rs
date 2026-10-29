//! Runtime contract proof for Honcho's shipped Dialectic runnable.
//!
//! The actual marketplace manifest is sent through Core's HTTP tool dispatcher.
//! Only its HTTPS origin is rewritten to an ephemeral loopback fixture. The
//! fake secret is resolved and projected separately because Core correctly
//! refuses secret headers on the fixture's plain-HTTP connection.

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

const HONCHO_MANIFEST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/honcho/manifest.json");
const TEST_API_KEY: &str = "honcho-test-key-not-real";

#[tokio::test]
async fn shipped_honcho_dialectic_runnable_uses_core_http_dispatch() {
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = super::CmdEnvGuard::armed();
    let _key = super::EnvOverride::set("RYU_HONCHO_API_KEY", TEST_API_KEY);

    let manifest: Value = serde_json::from_str(HONCHO_MANIFEST).expect("valid Honcho manifest");
    assert_eq!(manifest["id"], "@ryu/honcho");
    assert_eq!(
        manifest["permission_grants"],
        serde_json::json!(["tool:http-egress:api.honcho.dev", "tool:execute"])
    );

    let config = runnable_config(&manifest, "honcho.chat");
    assert_eq!(config["backend"], "http");
    assert_eq!(config["method"], "POST");
    assert_eq!(
        config["url"],
        "https://api.honcho.dev/v3/workspaces/{workspace_id}/peers/{peer_id}/chat"
    );
    assert_eq!(config["fail_open"], true);
    assert_eq!(config["unwrap_body"], true);
    assert_eq!(config["body_defaults"]["reasoning_level"], "minimal");
    assert_eq!(
        config["secret_headers"]["Authorization"],
        "Bearer env:RYU_HONCHO_API_KEY"
    );
    assert_eq!(
        config["input_schema"]["required"],
        serde_json::json!(["workspace_id", "peer_id", "query"])
    );

    // Resolve the shipped secret template using only a fake value. The Core REST
    // lowering keeps it in the outgoing header, outside the URL and JSON body.
    let secret_source = config["secret_headers"]["Authorization"]
        .as_str()
        .expect("Honcho Authorization source");
    let resolved_secret = super::super::resolve_secret_header_source(
        "Authorization",
        secret_source,
        "@ryu/honcho",
        &[],
        None,
    )
    .await
    .expect("Core resolves the declared fake env secret")
    .expect("fake test secret is present");
    let expected_authorization = format!("Bearer {TEST_API_KEY}");
    assert_eq!(resolved_secret, expected_authorization);

    let secret_probe_args = serde_json::json!({
        "workspace_id": "workspace-a",
        "peer_id": "user-7",
        "query": "What matters?",
        "session_id": "conversation-42",
        "target": "team-peer"
    });
    let (secret_probe_url, secret_probe_query, secret_probe_body, secret_probe_headers) =
        super::super::build_rest_request(
            config["url"].as_str().expect("Honcho chat URL"),
            &secret_probe_args,
            false,
            &[],
            &[("Authorization".to_owned(), resolved_secret)],
        )
        .expect("Core lowers the secret into a header");
    assert_eq!(
        secret_probe_url,
        "https://api.honcho.dev/v3/workspaces/workspace-a/peers/user-7/chat"
    );
    assert!(secret_probe_query.is_empty());
    assert_eq!(
        secret_probe_body,
        serde_json::json!({
            "query": "What matters?",
            "session_id": "conversation-42",
            "target": "team-peer"
        })
    );
    assert_eq!(
        secret_probe_headers,
        vec![("Authorization".to_owned(), expected_authorization)]
    );
    assert!(!secret_probe_body.to_string().contains(TEST_API_KEY));

    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind deterministic local Honcho fixture");
    let address = listener.local_addr().expect("fixture address");
    let app = Router::new()
        .route(
            "/v3/workspaces/workspace-a/peers/user-7/chat",
            post(honcho_fixture_request),
        )
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic local Honcho fixture");
    });
    let local_grants = grants(&["tool:http-egress:127.0.0.1"]);

    let synthesized = run_honcho_manifest_tool(
        &manifest,
        serde_json::json!({
            "workspace_id": "workspace-a",
            "peer_id": "user-7",
            "query": "What matters?",
            "session_id": "conversation-42",
            "target": "team-peer"
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("Dialectic call reaches the local fixture");
    assert_eq!(
        synthesized,
        serde_json::json!({ "content": "Fixture synthesis" })
    );

    let overridden = run_honcho_manifest_tool(
        &manifest,
        serde_json::json!({
            "workspace_id": "workspace-a",
            "peer_id": "user-7",
            "query": "Use the explicit reasoning setting",
            "reasoning_level": "high"
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("explicit reasoning setting reaches the local fixture");
    assert_eq!(
        overridden,
        serde_json::json!({ "content": "Fixture synthesis with override" })
    );

    let auth_failure = run_honcho_manifest_tool(
        &manifest,
        serde_json::json!({
            "workspace_id": "workspace-a",
            "peer_id": "user-7",
            "query": "fixture-auth-failure"
        }),
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

    let upstream_failure = run_honcho_manifest_tool(
        &manifest,
        serde_json::json!({
            "workspace_id": "workspace-a",
            "peer_id": "user-7",
            "query": "fixture-upstream-failure"
        }),
        address.port(),
        &local_grants,
    )
    .await
    .expect("upstream status envelope is returned to the caller");
    assert_eq!(
        upstream_failure,
        serde_json::json!({
            "status": 503,
            "body": { "error": "fixture unavailable" }
        })
    );

    let requests = observed.lock().await.clone();
    let host = format!("127.0.0.1:{}", address.port());
    assert_eq!(
        requests,
        vec![
            serde_json::json!({
                "method": "POST",
                "uri": "/v3/workspaces/workspace-a/peers/user-7/chat",
                "path": "/v3/workspaces/workspace-a/peers/user-7/chat",
                "query": Value::Null,
                "host": host,
                "authorization": Value::Null,
                "body": {
                    "query": "What matters?",
                    "session_id": "conversation-42",
                    "target": "team-peer",
                    "reasoning_level": "minimal"
                }
            }),
            serde_json::json!({
                "method": "POST",
                "uri": "/v3/workspaces/workspace-a/peers/user-7/chat",
                "path": "/v3/workspaces/workspace-a/peers/user-7/chat",
                "query": Value::Null,
                "host": host,
                "authorization": Value::Null,
                "body": {
                    "query": "Use the explicit reasoning setting",
                    "reasoning_level": "high"
                }
            }),
            serde_json::json!({
                "method": "POST",
                "uri": "/v3/workspaces/workspace-a/peers/user-7/chat",
                "path": "/v3/workspaces/workspace-a/peers/user-7/chat",
                "query": Value::Null,
                "host": host,
                "authorization": Value::Null,
                "body": {
                    "query": "fixture-auth-failure",
                    "reasoning_level": "minimal"
                }
            }),
            serde_json::json!({
                "method": "POST",
                "uri": "/v3/workspaces/workspace-a/peers/user-7/chat",
                "path": "/v3/workspaces/workspace-a/peers/user-7/chat",
                "query": Value::Null,
                "host": host,
                "authorization": Value::Null,
                "body": {
                    "query": "fixture-upstream-failure",
                    "reasoning_level": "minimal"
                }
            })
        ],
        "one exact loopback request per call; the fake credential never reaches HTTP"
    );

    server.abort();
}

#[tokio::test]
async fn shipped_honcho_memory_search_binding_reaches_core_http_runtime() {
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = super::CmdEnvGuard::armed();
    let _key = super::EnvOverride::set("RYU_HONCHO_API_KEY", TEST_API_KEY);

    let manifest: Value = serde_json::from_str(HONCHO_MANIFEST).expect("valid Honcho manifest");
    let typed_manifest: crate::plugin_manifest::PluginManifest =
        serde_json::from_str(HONCHO_MANIFEST).expect("Core parses the shipped Honcho manifest");
    let resolved_verbs = crate::sidecar::mcp::capability_tools::resolve_verbs(
        &[typed_manifest],
        &crate::plugins::binding::BindingConfig::default(),
    );
    let memory_search = resolved_verbs
        .iter()
        .find(|resolved| resolved.verb.id == "memory.search")
        .expect("Honcho provides the canonical memory.search verb");
    assert_eq!(memory_search.provider_id, "@ryu/honcho");
    assert_eq!(memory_search.binding.tool, "honcho.search");
    assert_eq!(
        memory_search.binding.args.get("scope").map(String::as_str),
        Some("")
    );
    assert_eq!(
        memory_search.binding.arg_defaults["workspace_id"],
        "pref:honcho.workspace-id"
    );
    assert_eq!(
        memory_search.binding.arg_defaults["peer_id"],
        "pref:honcho.peer-id"
    );

    let config = runnable_config(&manifest, "honcho.search");
    assert_eq!(config["backend"], "http");
    assert_eq!(config["method"], "POST");
    assert_eq!(
        config["url"],
        "https://api.honcho.dev/v3/workspaces/{workspace_id}/peers/{peer_id}/search"
    );
    assert_eq!(config["fail_open"], true);
    assert_eq!(config["unwrap_body"], true);
    assert!(config.get("body_defaults").is_none());
    assert_eq!(
        config["input_schema"]["required"],
        serde_json::json!(["workspace_id", "peer_id", "query"])
    );
    assert_eq!(config["input_schema"]["properties"]["limit"]["minimum"], 1);
    assert_eq!(
        config["input_schema"]["properties"]["limit"]["maximum"],
        100
    );

    let secret_source = config["secret_headers"]["Authorization"]
        .as_str()
        .expect("Honcho search Authorization source");
    let resolved_secret = super::super::resolve_secret_header_source(
        "Authorization",
        secret_source,
        "@ryu/honcho",
        &[],
        None,
    )
    .await
    .expect("Core resolves the fake Honcho env secret")
    .expect("fake test secret is present");
    let expected_authorization = format!("Bearer {TEST_API_KEY}");
    assert_eq!(resolved_secret, expected_authorization);

    let observed = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind deterministic local Honcho search fixture");
    let address = listener.local_addr().expect("fixture address");
    let app = Router::new()
        .route(
            "/v3/workspaces/workspace-a/peers/user-7/search",
            post(honcho_search_fixture_request),
        )
        .route(
            "/v3/workspaces/workspace-b/peers/user-8/search",
            post(honcho_search_fixture_request),
        )
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve deterministic local Honcho search fixture");
    });
    let local_grants = grants(&["tool:http-egress:127.0.0.1"]);

    // The search capability gets workspace and peer from this install's settings.
    // Honcho's documented default limit is 10, so Core leaves limit absent when
    // the caller omits it instead of writing an invented provider default.
    let prefs_a = std::collections::BTreeMap::from([
        ("honcho.workspace-id".to_owned(), "workspace-a".to_owned()),
        ("honcho.peer-id".to_owned(), "user-7".to_owned()),
    ]);
    let defaults_a = crate::sidecar::mcp::capability_tools::resolve_arg_defaults(
        &memory_search.binding,
        &prefs_a,
    );
    let canonical_a = serde_json::json!({
        "query": "release notes",
        "scope": "user"
    });
    let mapped_a = crate::sidecar::mcp::capability_tools::map_args_with_defaults(
        &memory_search.binding,
        defaults_a,
        canonical_a,
    );
    assert_eq!(
        mapped_a,
        serde_json::json!({
            "workspace_id": "workspace-a",
            "peer_id": "user-7",
            "query": "release notes"
        })
    );

    // Check the resolved fake secret's projection without sending it over the
    // fixture's HTTP connection. Core rejects secret headers on non-HTTPS URLs.
    let (secret_probe_url, secret_probe_query, secret_probe_body, secret_probe_headers) =
        super::super::build_rest_request(
            config["url"].as_str().expect("Honcho search URL"),
            &mapped_a,
            false,
            &[],
            &[("Authorization".to_owned(), resolved_secret)],
        )
        .expect("Core lowers the provider secret into a header");
    assert_eq!(
        secret_probe_url,
        "https://api.honcho.dev/v3/workspaces/workspace-a/peers/user-7/search"
    );
    assert!(secret_probe_query.is_empty());
    assert_eq!(
        secret_probe_body,
        serde_json::json!({ "query": "release notes" })
    );
    assert_eq!(
        secret_probe_headers,
        vec![("Authorization".to_owned(), expected_authorization)]
    );
    assert!(!secret_probe_body.to_string().contains(TEST_API_KEY));

    let raw_a = run_honcho_search_manifest_tool(&manifest, mapped_a, address.port(), &local_grants)
        .await
        .expect("default-limit memory search reaches the local fixture");
    let result_a = crate::sidecar::mcp::capability_tools::map_response(
        &memory_search.binding,
        &memory_search.provider_id,
        raw_a,
    );
    assert_eq!(
        result_a,
        serde_json::json!({
            "provider": "@ryu/honcho",
            "results": [{
                "id": "message-1",
                "content": "Release notes stay concise.",
                "raw": {
                    "id": "message-1",
                    "content": "Release notes stay concise.",
                    "peer_id": "user-7"
                }
            }]
        })
    );

    // A different configured workspace/peer and explicit canonical query/limit
    // replace the defaults for a second call; scope remains unrepresentable.
    let prefs_b = std::collections::BTreeMap::from([
        ("honcho.workspace-id".to_owned(), "workspace-b".to_owned()),
        ("honcho.peer-id".to_owned(), "user-8".to_owned()),
    ]);
    let defaults_b = crate::sidecar::mcp::capability_tools::resolve_arg_defaults(
        &memory_search.binding,
        &prefs_b,
    );
    let canonical_b = serde_json::json!({
        "query": "limit override",
        "limit": 2,
        "scope": "project"
    });
    let mapped_b = crate::sidecar::mcp::capability_tools::map_args_with_defaults(
        &memory_search.binding,
        defaults_b,
        canonical_b,
    );
    assert_eq!(
        mapped_b,
        serde_json::json!({
            "workspace_id": "workspace-b",
            "peer_id": "user-8",
            "query": "limit override",
            "limit": 2
        })
    );
    let raw_b = run_honcho_search_manifest_tool(&manifest, mapped_b, address.port(), &local_grants)
        .await
        .expect("explicit limit reaches the local fixture");
    let result_b = crate::sidecar::mcp::capability_tools::map_response(
        &memory_search.binding,
        &memory_search.provider_id,
        raw_b,
    );
    assert_eq!(
        result_b,
        serde_json::json!({
            "provider": "@ryu/honcho",
            "results": [
                {
                    "id": "message-2",
                    "content": "First matching message.",
                    "raw": {
                        "id": "message-2",
                        "content": "First matching message.",
                        "peer_id": "user-8"
                    }
                },
                {
                    "id": "message-3",
                    "content": "Second matching message.",
                    "raw": {
                        "id": "message-3",
                        "content": "Second matching message.",
                        "peer_id": "user-8"
                    }
                }
            ]
        })
    );

    let defaults_error = crate::sidecar::mcp::capability_tools::resolve_arg_defaults(
        &memory_search.binding,
        &prefs_b,
    );
    let mapped_error = crate::sidecar::mcp::capability_tools::map_args_with_defaults(
        &memory_search.binding,
        defaults_error,
        serde_json::json!({
            "query": "fixture-auth-failure",
            "limit": 4
        }),
    );
    let raw_error =
        run_honcho_search_manifest_tool(&manifest, mapped_error, address.port(), &local_grants)
            .await
            .expect("fail-open auth response is returned by Core's HTTP runtime");
    assert_eq!(
        raw_error,
        serde_json::json!({
            "available": false,
            "reason": "endpoint returned HTTP 401",
            "hint": "The endpoint is unreachable or rejected the request; check the key/host and retry."
        })
    );
    let result_error = crate::sidecar::mcp::capability_tools::map_response(
        &memory_search.binding,
        &memory_search.provider_id,
        raw_error,
    );
    assert_eq!(
        result_error,
        serde_json::json!({
            "provider": "@ryu/honcho",
            "raw": {
                "available": false,
                "reason": "endpoint returned HTTP 401",
                "hint": "The endpoint is unreachable or rejected the request; check the key/host and retry."
            }
        })
    );

    let requests = observed.lock().await.clone();
    let host = format!("127.0.0.1:{}", address.port());
    assert_eq!(
        requests,
        vec![
            serde_json::json!({
                "method": "POST",
                "uri": "/v3/workspaces/workspace-a/peers/user-7/search",
                "path": "/v3/workspaces/workspace-a/peers/user-7/search",
                "query": Value::Null,
                "host": host,
                "authorization": Value::Null,
                "body": { "query": "release notes" }
            }),
            serde_json::json!({
                "method": "POST",
                "uri": "/v3/workspaces/workspace-b/peers/user-8/search",
                "path": "/v3/workspaces/workspace-b/peers/user-8/search",
                "query": Value::Null,
                "host": host,
                "authorization": Value::Null,
                "body": { "query": "limit override", "limit": 2 }
            }),
            serde_json::json!({
                "method": "POST",
                "uri": "/v3/workspaces/workspace-b/peers/user-8/search",
                "path": "/v3/workspaces/workspace-b/peers/user-8/search",
                "query": Value::Null,
                "host": host,
                "authorization": Value::Null,
                "body": { "query": "fixture-auth-failure", "limit": 4 }
            })
        ],
        "exact POST requests use only local fixture routing and never carry the fake key"
    );
    assert!(requests
        .iter()
        .all(|request| !request["body"].to_string().contains(TEST_API_KEY)));

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
        .unwrap_or_else(|| panic!("Honcho manifest is missing {slug}"))
}

async fn run_honcho_manifest_tool(
    manifest: &Value,
    args: Value,
    local_port: u16,
    local_grants: &std::collections::HashSet<String>,
) -> Result<Value, String> {
    let config = runnable_config(manifest, "honcho.chat");
    let remote_url = config["url"]
        .as_str()
        .ok_or_else(|| "honcho.chat has no URL".to_owned())?;
    let path = remote_url
        .strip_prefix("https://api.honcho.dev")
        .filter(|path| path.starts_with("/v3/workspaces/{workspace_id}/peers/{peer_id}/chat"))
        .ok_or_else(|| {
            "honcho.chat no longer targets the declared Honcho HTTPS endpoint".to_owned()
        })?;
    let local_url = format!("http://127.0.0.1:{local_port}{path}");

    run_http_tool(
        &local_url,
        config["method"]
            .as_str()
            .ok_or_else(|| "honcho.chat has no HTTP method".to_owned())?,
        args,
        &[],
        &BTreeMap::new(),
        config["fail_open"]
            .as_bool()
            .ok_or_else(|| "honcho.chat has no boolean fail_open setting".to_owned())?,
        config["unwrap_body"]
            .as_bool()
            .ok_or_else(|| "honcho.chat has no boolean unwrap_body setting".to_owned())?,
        config.get("body_defaults").unwrap_or(&Value::Null),
        local_grants,
        &[],
        "@ryu/honcho",
        None,
    )
    .await
}

async fn run_honcho_search_manifest_tool(
    manifest: &Value,
    args: Value,
    local_port: u16,
    local_grants: &std::collections::HashSet<String>,
) -> Result<Value, String> {
    let config = runnable_config(manifest, "honcho.search");
    let remote_url = config["url"]
        .as_str()
        .ok_or_else(|| "honcho.search has no URL".to_owned())?;
    let path = remote_url
        .strip_prefix("https://api.honcho.dev")
        .filter(|path| path.starts_with("/v3/workspaces/{workspace_id}/peers/{peer_id}/search"))
        .ok_or_else(|| {
            "honcho.search no longer targets the declared Honcho HTTPS endpoint".to_owned()
        })?;
    let local_url = format!("http://127.0.0.1:{local_port}{path}");

    run_http_tool(
        &local_url,
        config["method"]
            .as_str()
            .ok_or_else(|| "honcho.search has no HTTP method".to_owned())?,
        args,
        &[],
        &BTreeMap::new(),
        config["fail_open"]
            .as_bool()
            .ok_or_else(|| "honcho.search has no boolean fail_open setting".to_owned())?,
        config["unwrap_body"]
            .as_bool()
            .ok_or_else(|| "honcho.search has no boolean unwrap_body setting".to_owned())?,
        config.get("body_defaults").unwrap_or(&Value::Null),
        local_grants,
        &[],
        "@ryu/honcho",
        None,
    )
    .await
}

async fn honcho_fixture_request(
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

    match record["body"]["query"].as_str() {
        Some("fixture-auth-failure") => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "fixture rejected the fake key" })),
        )
            .into_response(),
        Some("fixture-upstream-failure") => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "fixture unavailable" })),
        )
            .into_response(),
        Some("Use the explicit reasoning setting") => {
            Json(serde_json::json!({ "content": "Fixture synthesis with override" }))
                .into_response()
        }
        _ => Json(serde_json::json!({ "content": "Fixture synthesis" })).into_response(),
    }
}

async fn honcho_search_fixture_request(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read fixture search request body");
    let body: Value = serde_json::from_slice(&bytes).expect("Core sends JSON search bodies");
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

    match record["body"]["query"].as_str() {
        Some("fixture-auth-failure") => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "fixture rejected the fake key" })),
        )
            .into_response(),
        Some("release notes") => Json(serde_json::json!([{
            "id": "message-1",
            "content": "Release notes stay concise.",
            "peer_id": "user-7"
        }]))
        .into_response(),
        Some("limit override") => Json(serde_json::json!([
            {
                "id": "message-2",
                "content": "First matching message.",
                "peer_id": "user-8"
            },
            {
                "id": "message-3",
                "content": "Second matching message.",
                "peer_id": "user-8"
            }
        ]))
        .into_response(),
        _ => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "unexpected fixture query" })),
        )
            .into_response(),
    }
}
