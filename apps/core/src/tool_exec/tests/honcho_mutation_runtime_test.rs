//! Honcho's shipped peer/session/message tools through Core registry dispatch.
//! The real HTTPS header projection is tested separately from a keyless local
//! fixture; localized packages cannot inherit backend secrets without explicit
//! operator approval, and approved secrets must still refuse plaintext transport.
use super::*;
use axum::{
    body::Bytes,
    extract::{OriginalUri, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use std::{collections::HashSet, sync::Arc};

const MANIFEST: &str = include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/honcho/manifest.json");
const KEY: &str = "honcho-mutation-synthetic-key-not-real";
const TEST_NAME: &str = "tool_exec::tests::honcho_mutation_runtime::honcho_native_mutations_preserve_routes_bodies_state_and_errors";
const CHILD: &str = "RYU_HONCHO_MUTATION_RUNTIME_CHILD";

#[derive(Default, Clone)]
struct FixtureState {
    requests: Vec<Value>,
    peers: HashSet<String>,
    sessions: HashSet<String>,
    messages: Vec<Value>,
}
type Shared = Arc<tokio::sync::Mutex<FixtureState>>;

#[tokio::test]
async fn honcho_native_mutations_preserve_routes_bodies_state_and_errors() {
    if std::env::var_os(CHILD).is_none() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(CHILD, "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env("RYU_HONCHO_API_KEY", KEY)
            .env("RYU_ALLOW_GATEWAY_FALLBACK", "1")
            .env("RYU_EXEC_APPROVAL_MODE", "off")
            .env_remove("RYU_GATEWAY_REMOTE")
            .env_remove("RYU_PLUGIN_ENV_ALLOWLIST")
            .status()
            .unwrap();
        assert!(status.success(), "isolated Honcho mutation proof failed");
        return;
    }
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_GATEWAY_TOKEN");
    let mut manifest =
        crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(MANIFEST, |path| {
            match path {
                "adapters/memory.store.js" => Ok(include_str!(
                    "../../../../../generated/ryu-runtime/plugins-store/plugins/honcho/adapters/memory.store.js"
                )
                .into()),
                "adapters/memory.sync.js" => Ok(include_str!(
                    "../../../../../generated/ryu-runtime/plugins-store/plugins/honcho/adapters/memory.sync.js"
                )
                .into()),
                _ => Err(format!("unexpected Honcho code fragment: {path}")),
            }
        })
        .unwrap();
    let authored: Value = serde_json::from_str(MANIFEST).unwrap();
    let state: Shared = Arc::new(tokio::sync::Mutex::new(FixtureState::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v3/workspaces/workspace-a/peers", post(fixture))
        .route("/v3/workspaces/workspace-a/sessions", post(fixture))
        .route(
            "/v3/workspaces/workspace-a/sessions/session-a/messages",
            post(fixture),
        )
        .with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(&manifest.id, &manifest.version).await.unwrap();
    let grant = "tool:http-egress:127.0.0.1".to_owned();
    manifest.permission_grants.push(grant.clone());
    store
        .set_enabled(&manifest.id, &manifest.permission_grants)
        .await
        .unwrap();
    let slugs = [
        "honcho.peer_upsert",
        "honcho.session_upsert",
        "honcho.messages",
    ];
    for entry in &mut manifest.runnables {
        let Some(config) = entry.config.as_mut() else {
            continue;
        };
        if !slugs.contains(&config["slug"].as_str().unwrap_or_default()) {
            continue;
        }
        let url = config["url"].as_str().unwrap();
        assert!(url.starts_with("https://api.honcho.dev/v3/workspaces/{workspace_id}/"));
        assert_eq!(config["method"], "POST");
        assert_eq!(
            config["secret_headers"],
            serde_json::json!({"Authorization":"Bearer env:RYU_HONCHO_API_KEY"})
        );
        assert_eq!(config["fail_open"], true);
        assert_eq!(config["unwrap_body"], true);
        config["url"] =
            Value::String(url.replace("https://api.honcho.dev", &format!("http://{address}")));
    }
    let manifests = Arc::new(tokio::sync::RwLock::new(vec![manifest]));
    let registry =
        crate::sidecar::mcp::McpRegistry::empty().with_self_build(manifests.clone(), store.clone());
    for slug in slugs {
        registry.register_app_tool(slug.into(), slug.into(), None);
    }
    assert!(std::env::var_os("RYU_PLUGIN_ENV_ALLOWLIST").is_none());
    let args = serde_json::json!({"workspace_id":"workspace-a","id":"user-a"});
    // Changing the destination makes this a localized package. Its authored
    // backend credential source cannot inherit the shipped package's trust.
    let anonymous = registry
        .call_tool("honcho.peer_upsert", args.clone(), None)
        .await
        .unwrap();
    assert_eq!(anonymous, serde_json::json!({"id":"user-a"}));
    assert!(!anonymous.to_string().contains(KEY));
    let anonymous_state = state.lock().await.clone();
    assert_eq!(anonymous_state.requests.len(), 1);
    assert_eq!(
        anonymous_state.requests[0],
        serde_json::json!({
            "method": "POST", "path": "/v3/workspaces/workspace-a/peers",
            "query": null, "authorization": null, "body": {"id":"user-a"}
        })
    );
    assert!(!anonymous_state.requests[0].to_string().contains(KEY));
    // The operator approves only this isolated child's synthetic variable.
    // Production dispatch must then enforce HTTPS before any mutation reaches
    // the listener. No real provider credential is used or printed.
    std::env::set_var("RYU_PLUGIN_ENV_ALLOWLIST", "RYU_HONCHO_API_KEY");
    for (slug, args) in [
        ("honcho.peer_upsert", args),
        (
            "honcho.session_upsert",
            serde_json::json!({"workspace_id":"workspace-a","id":"session-a"}),
        ),
        (
            "honcho.messages",
            serde_json::json!({"workspace_id":"workspace-a","session_id":"session-a","messages":[{"content":"blocked-secret","peer_id":"user-a"}]}),
        ),
    ] {
        let refusal = registry.call_tool(slug, args, None).await.unwrap_err();
        assert!(refusal
            .to_string()
            .contains("secret headers require an HTTPS destination"));
        assert!(!refusal.to_string().contains(KEY));
    }
    let after_refusals = state.lock().await.clone();
    assert_eq!(after_refusals.requests, anonymous_state.requests);
    assert_eq!(after_refusals.peers, anonymous_state.peers);
    assert_eq!(after_refusals.sessions, anonymous_state.sessions);
    assert_eq!(after_refusals.messages, anonymous_state.messages);
    assert_eq!(
        std::env::var("RYU_PLUGIN_ENV_ALLOWLIST").unwrap(),
        "RYU_HONCHO_API_KEY"
    );
    std::env::remove_var("RYU_PLUGIN_ENV_ALLOWLIST");
    // Retain authored secret_headers: revoking operator approval must be
    // observed by the actual registry on every subsequent dispatch.
    for (slug, args, expected_path, expected_body) in [
        (
            "honcho.peer_upsert",
            serde_json::json!({"workspace_id":"workspace-a","id":"user-a"}),
            "/v3/workspaces/workspace-a/peers",
            serde_json::json!({"id":"user-a"}),
        ),
        (
            "honcho.peer_upsert",
            serde_json::json!({"workspace_id":"workspace-a","id":"assistant-a"}),
            "/v3/workspaces/workspace-a/peers",
            serde_json::json!({"id":"assistant-a"}),
        ),
        (
            "honcho.session_upsert",
            serde_json::json!({"workspace_id":"workspace-a","id":"session-a"}),
            "/v3/workspaces/workspace-a/sessions",
            serde_json::json!({"id":"session-a"}),
        ),
        (
            "honcho.session_upsert",
            serde_json::json!({"workspace_id":"workspace-a","id":"session-a"}),
            "/v3/workspaces/workspace-a/sessions",
            serde_json::json!({"id":"session-a"}),
        ),
        (
            "honcho.messages",
            serde_json::json!({"workspace_id":"workspace-a","session_id":"session-a","messages":[{"content":"User turn","peer_id":"user-a","metadata":{"role":"user"}},{"content":"Assistant turn","peer_id":"assistant-a","metadata":{"role":"assistant"}}]}),
            "/v3/workspaces/workspace-a/sessions/session-a/messages",
            serde_json::json!({"messages":[{"content":"User turn","peer_id":"user-a","metadata":{"role":"user"}},{"content":"Assistant turn","peer_id":"assistant-a","metadata":{"role":"assistant"}}]}),
        ),
    ] {
        let config = authored["runnables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["config"]["slug"] == slug)
            .unwrap()["config"]
            .clone();
        let header = super::super::resolve_secret_header_source(
            "Authorization",
            config["secret_headers"]["Authorization"].as_str().unwrap(),
            "@ryu/honcho",
            &[],
            None,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(header, format!("Bearer {KEY}"));
        let (url, query, body, headers) = super::super::build_rest_request(
            config["url"].as_str().unwrap(),
            &args,
            false,
            &[],
            &[("Authorization".into(), header)],
        )
        .unwrap();
        assert_eq!(url, format!("https://api.honcho.dev{expected_path}"));
        assert!(query.is_empty());
        assert_eq!(body, expected_body);
        assert_eq!(
            headers,
            vec![("Authorization".into(), format!("Bearer {KEY}"))]
        );
        assert!(!body.to_string().contains(KEY));
        let before = state.lock().await.requests.len();
        let result = registry.call_tool(slug, args, None).await.unwrap();
        if slug == "honcho.messages" {
            assert_eq!(result.as_array().unwrap().len(), 2);
        } else {
            assert!(result["id"].is_string());
        }
        let snapshot = state.lock().await.clone();
        assert_eq!(snapshot.requests.len(), before + 1);
        let request = snapshot.requests.last().unwrap();
        assert_eq!(request["path"], expected_path);
        assert_eq!(request["method"], "POST");
        assert_eq!(request["query"], Value::Null);
        assert_eq!(request["authorization"], Value::Null);
        assert_eq!(request["body"], expected_body);
    }
    let successful = state.lock().await.clone();
    assert_eq!(successful.peers.len(), 2);
    assert_eq!(successful.sessions.len(), 1);
    assert_eq!(successful.messages.len(), 2);
    assert_eq!(successful.messages[0]["peer_id"], "user-a");
    assert_eq!(successful.messages[1]["peer_id"], "assistant-a");
    for (slug, args) in [
        (
            "honcho.peer_upsert",
            serde_json::json!({"workspace_id":"workspace-a","id":"fixture-unavailable"}),
        ),
        (
            "honcho.session_upsert",
            serde_json::json!({"workspace_id":"workspace-a","id":"fixture-unavailable"}),
        ),
        (
            "honcho.messages",
            serde_json::json!({"workspace_id":"workspace-a","session_id":"session-a","messages":[{"content":"fixture-unavailable","peer_id":"user-a"}]}),
        ),
    ] {
        let before = state.lock().await.requests.len();
        let result = registry.call_tool(slug, args, None).await.unwrap();
        assert_eq!(
            result,
            serde_json::json!({"status":503,"body":{"error":"fixture unavailable"}})
        );
        assert_eq!(state.lock().await.requests.len(), before + 1);
    }
    let after_errors = state.lock().await.clone();
    assert_eq!(after_errors.peers, successful.peers);
    assert_eq!(after_errors.sessions, successful.sessions);
    assert_eq!(after_errors.messages, successful.messages);
    let before = state.lock().await.requests.len();
    let missing = registry
        .call_tool(
            "honcho.messages",
            serde_json::json!({"session_id":"session-a","messages":[]}),
            None,
        )
        .await
        .unwrap_err();
    assert!(missing.to_string().contains("workspace_id"));
    assert_eq!(state.lock().await.requests.len(), before);
    manifests.write().await[0]
        .permission_grants
        .retain(|value| value != &grant);
    store.set_enabled("@ryu/honcho", &[]).await.unwrap();
    let denied = registry
        .call_tool(
            "honcho.peer_upsert",
            serde_json::json!({"workspace_id":"workspace-a","id":"ungranted"}),
            None,
        )
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("not granted"));
    assert_eq!(state.lock().await.requests.len(), before);
    manifests.write().await[0]
        .permission_grants
        .push(grant.clone());
    store
        .set_enabled("@ryu/honcho", &manifests.read().await[0].permission_grants)
        .await
        .unwrap();
    let retried = registry
        .call_tool(
            "honcho.peer_upsert",
            serde_json::json!({"workspace_id":"workspace-a","id":"ungranted"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(retried, serde_json::json!({"id":"ungranted"}));
    let recovered = state.lock().await.clone();
    assert_eq!(recovered.requests.len(), before + 1);
    assert!(recovered.peers.contains("ungranted"));
    assert_eq!(
        recovered.requests.last().unwrap()["authorization"],
        Value::Null
    );
    assert_eq!(
        recovered.requests.last().unwrap()["body"],
        serde_json::json!({"id":"ungranted"})
    );
    assert_eq!(recovered.sessions, successful.sessions);
    assert_eq!(recovered.messages, successful.messages);
    server.abort();
}

async fn fixture(
    State(state): State<Shared>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body: Value = serde_json::from_slice(&body).unwrap();
    let mut state = state.lock().await;
    state.requests.push(serde_json::json!({"method":method.as_str(),"path":uri.path(),"query":uri.query(),"authorization":headers.get("authorization").and_then(|v|v.to_str().ok()),"body":body}));
    if body["id"] == "fixture-unavailable"
        || body["messages"][0]["content"] == "fixture-unavailable"
    {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error":"fixture unavailable"})),
        )
            .into_response();
    }
    if uri.path().ends_with("/peers") {
        let id = body["id"].as_str().unwrap().to_owned();
        state.peers.insert(id.clone());
        return Json(serde_json::json!({"id":id})).into_response();
    }
    if uri.path().ends_with("/sessions") {
        let id = body["id"].as_str().unwrap().to_owned();
        state.sessions.insert(id.clone());
        return Json(serde_json::json!({"id":id})).into_response();
    }
    let messages = body["messages"].as_array().unwrap();
    if !state.sessions.contains("session-a")
        || messages
            .iter()
            .any(|message| !state.peers.contains(message["peer_id"].as_str().unwrap()))
    {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error":"fixture prerequisites missing"})),
        )
            .into_response();
    }
    let created = messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
            let mut result = message.clone();
            result["id"] = serde_json::json!(format!("message-{index}"));
            result
        })
        .collect::<Vec<_>>();
    state.messages.extend(created.clone());
    (StatusCode::CREATED, Json(serde_json::json!(created))).into_response()
}
