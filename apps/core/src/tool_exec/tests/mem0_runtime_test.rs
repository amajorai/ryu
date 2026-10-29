//! Shipped Mem0 capability bindings through the production Core registry.
//! Provider authentication is projected locally; plaintext fixtures never receive it.
use super::*;
use axum::{
    body::Bytes,
    extract::{OriginalUri, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, post},
    Json, Router,
};
use std::sync::Arc;

const MANIFEST: &str = include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/mem0/manifest.json");
const KEY: &str = "mem0-runtime-synthetic-key";
const CHILD: &str = "RYU_MEM0_REGISTRY_RUNTIME_CHILD";
const TEST_NAME: &str = "tool_exec::tests::mem0_runtime::mem0_canonical_registry_preserves_scope_state_permissions_and_recovery";

#[derive(Clone, Default)]
struct FixtureState {
    requests: Vec<Value>,
    memories: Vec<Value>,
}
type Shared = Arc<tokio::sync::Mutex<FixtureState>>;

#[test]
fn mem0_canonical_registry_preserves_scope_state_permissions_and_recovery() {
    if std::env::var_os(CHILD).is_none() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(CHILD, "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env("RYU_MEM0_API_KEY", KEY)
            .env("RYU_ALLOW_GATEWAY_FALLBACK", "1")
            .env("RYU_EXEC_APPROVAL_MODE", "off")
            .env_remove("RYU_GATEWAY_REMOTE")
            .env_remove("RYU_PLUGIN_ENV_ALLOWLIST")
            .status()
            .unwrap();
        assert!(status.success(), "isolated Mem0 registry proof failed");
        return;
    }
    // This debug-build integration fixture polls the large real registry stack.
    // The 8 MiB diagnostic passed all strict behavior assertions; heap-pinning
    // its dispatch futures alone still exceeded the normal 2 MiB test thread.
    // Allocate one explicit, owned test worker instead of changing global or
    // production stack settings. The current-thread runtime polls only here.
    let worker = std::thread::Builder::new()
        .name("mem0-registry-fixture".into())
        .stack_size(8 * 1024 * 1024)
        .spawn(|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("create owned Mem0 fixture runtime");
            runtime.block_on(Box::pin(run_mem0_registry_fixture()));
        })
        .expect("start bounded Mem0 fixture worker");
    if let Err(panic) = worker.join() {
        std::panic::resume_unwind(panic);
    }
}

async fn run_mem0_registry_fixture() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_GATEWAY_TOKEN");
    let mut manifest =
        crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(MANIFEST, |path| {
            Err(format!("Mem0 has no code fragment: {path}"))
        })
        .unwrap();
    assert_eq!(manifest.id, "@ryu/mem0");
    assert_eq!(manifest.permission_grants, ["tool:http-egress:api.mem0.ai"]);
    let state: Shared = Arc::new(tokio::sync::Mutex::new(FixtureState::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v3/memories/add/", post(fixture))
        .route("/v3/memories/search/", post(fixture))
        .route("/v1/memories/:id/", delete(fixture))
        .with_state(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let authored: Value = serde_json::from_str(MANIFEST).unwrap();
    for runnable in &mut manifest.runnables {
        let config = runnable.config.as_mut().unwrap();
        let remote = config["url"].as_str().unwrap();
        assert!(remote.starts_with("https://api.mem0.ai/"));
        let secret = resolve_secret_header_source(
            "Authorization",
            config["secret_headers"]["Authorization"].as_str().unwrap(),
            "@ryu/mem0",
            &[],
            None,
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(secret, format!("Token {KEY}"));
        let args = serde_json::json!({"memory_id":"memory-1","query":"test"});
        let (url, query, body, headers) = build_rest_request(
            remote,
            &args,
            false,
            &[],
            &[("Authorization".into(), secret)],
        )
        .unwrap();
        assert!(url.starts_with("https://api.mem0.ai/"));
        assert!(query.is_empty());
        assert!(!body.to_string().contains(KEY));
        assert_eq!(
            headers,
            vec![("Authorization".into(), format!("Token {KEY}"))]
        );
        config["url"] =
            Value::String(remote.replace("https://api.mem0.ai", &format!("http://{address}")));
    }
    let grant = "tool:http-egress:127.0.0.1".to_owned();
    manifest.permission_grants = vec![grant.clone()];
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(&manifest.id, &manifest.version).await.unwrap();
    store
        .set_enabled(&manifest.id, &[grant.clone()])
        .await
        .unwrap();
    let prefs_dir = tempfile::tempdir().unwrap();
    let prefs_path = prefs_dir.path().join("preferences.sqlite");
    let prefs = crate::server::preferences::PreferencesStore::open(prefs_path.clone()).unwrap();
    prefs.set("mem0.user-id", "bucket-a").await.unwrap();
    let prefs = crate::server::preferences::PreferencesStore::open(prefs_path).unwrap();
    let manifests = Arc::new(tokio::sync::RwLock::new(vec![manifest]));
    let registry = crate::sidecar::mcp::McpRegistry::empty()
        .with_self_build(manifests.clone(), store.clone())
        .with_preferences(prefs.clone());
    for runnable in authored["runnables"].as_array().unwrap() {
        let slug = runnable["config"]["slug"].as_str().unwrap();
        registry.register_app_tool(slug.into(), slug.into(), None);
    }
    let mut binding = crate::plugins::binding::BindingConfig::default();
    binding
        .overrides
        .insert("memory".into(), "@ryu/mem0".into());
    crate::plugins::binding::set_active_config(binding);
    let verbs = registry.capability_verbs().await;
    assert_eq!(verbs.len(), 4);
    assert!(verbs.iter().all(|verb| verb.provider_id == "@ryu/mem0"));
    assert!(!verbs.iter().any(|verb| verb.verb.id == "memory.context"));
    assert!(std::env::var_os("RYU_PLUGIN_ENV_ALLOWLIST").is_none());
    // Localized bytes cannot inherit the compiled package's shared-key trust.
    let anonymous_args = serde_json::json!({"query":"quiet","limit":7});
    // Every real registry dispatch future is heap-pinned so sequential protocol
    // stages do not embed their large frames in the default-stack test future.
    let anonymous = Box::pin(registry.call_tool("memory.search", anonymous_args.clone(), None))
        .await
        .unwrap();
    assert_eq!(anonymous["results"], serde_json::json!([]));
    assert!(!anonymous.to_string().contains(KEY));
    let anonymous_state = state.lock().await.clone();
    assert_eq!(
        anonymous_state.requests,
        vec![serde_json::json!({
            "method":"POST", "path":"/v3/memories/search/", "authorization":null,
            "body":{"filters":{"user_id":"bucket-a"},"query":"quiet","top_k":7}
        })]
    );
    assert!(anonymous_state.memories.is_empty());
    // Approve only this isolated child's synthetic variable. The actual
    // registry must now enforce HTTPS before sending any provider credential.
    std::env::set_var("RYU_PLUGIN_ENV_ALLOWLIST", "RYU_MEM0_API_KEY");
    let refusal = Box::pin(registry.call_tool("memory.search", anonymous_args, None))
        .await
        .unwrap_err();
    assert!(refusal
        .to_string()
        .contains("secret headers require an HTTPS destination"));
    assert!(!refusal.to_string().contains(KEY));
    let after_refusal = state.lock().await.clone();
    assert_eq!(after_refusal.requests, anonymous_state.requests);
    assert_eq!(after_refusal.memories, anonymous_state.memories);
    assert_eq!(
        std::env::var("RYU_PLUGIN_ENV_ALLOWLIST").unwrap(),
        "RYU_MEM0_API_KEY"
    );
    std::env::remove_var("RYU_PLUGIN_ENV_ALLOWLIST");
    // Retain authored secret_headers; revocation is observed on each dispatch.
    let denied = Box::pin(registry.call_tool(
        "memory.store",
        serde_json::json!({"content":"denied"}),
        Some(&["memory.search".into()]),
    ))
    .await
    .unwrap_err();
    assert!(denied.to_string().contains("not in this agent's allowlist"));
    assert_eq!(state.lock().await.requests, anonymous_state.requests);
    let accepted = Box::pin(registry.call_tool("memory.store", serde_json::json!({"content":"Quiet workspace","scope":"user","category":"preference","importance":4,"when_to_use":"work"}), None)).await.unwrap();
    assert_eq!(
        accepted,
        serde_json::json!({"provider":"@ryu/mem0","raw":{"status":"PENDING","event_id":"event-1"}})
    );
    assert!(accepted.get("id").is_none());
    assert_eq!(
        state.lock().await.requests[1]["body"],
        serde_json::json!({"messages":[{"role":"user","content":"Quiet workspace"}],"user_id":"bucket-a","infer":false})
    );
    let sync = Box::pin(registry.call_tool(
        "memory.sync",
        serde_json::json!({"role":"assistant","content":"Raw turn"}),
        None,
    ))
    .await
    .unwrap();
    assert_eq!(sync["raw"]["status"], "PENDING");
    assert_eq!(
        state.lock().await.requests[2]["body"],
        serde_json::json!({"messages":[{"role":"assistant","content":"Raw turn"}],"user_id":"bucket-a"})
    );
    let found = Box::pin(registry.call_tool(
        "memory.search",
        serde_json::json!({"query":"Quiet","limit":7,"scope":"user"}),
        None,
    ))
    .await
    .unwrap();
    assert_eq!(found["results"][0]["id"], "memory-1");
    assert_eq!(found["results"][0]["content"], "Quiet workspace");
    assert_eq!(found["results"][0]["score"], 0.9);
    assert_eq!(
        state.lock().await.requests[3]["body"],
        serde_json::json!({"filters":{"user_id":"bucket-a"},"query":"Quiet","top_k":7})
    );
    prefs.set("mem0.user-id", "bucket-b").await.unwrap();
    let empty =
        Box::pin(registry.call_tool("memory.search", serde_json::json!({"query":"Quiet"}), None))
            .await
            .unwrap();
    assert_eq!(empty["results"], serde_json::json!([]));
    assert_eq!(
        state.lock().await.requests[4]["body"]["filters"]["user_id"],
        "bucket-b"
    );
    prefs.set("mem0.user-id", "bucket-a").await.unwrap();
    let stable = state.lock().await.memories.clone();
    for code in [401, 403, 429, 503] {
        let before = state.lock().await.requests.len();
        let result = Box::pin(registry.call_tool("mem0.add", serde_json::json!({"messages":[{"role":"user","content":format!("error-{code}")}],"user_id":"bucket-a"}), None)).await.unwrap();
        if code == 401 || code == 403 {
            assert_eq!(result["available"], false);
            assert!(result["reason"]
                .as_str()
                .unwrap()
                .contains(&code.to_string()));
        } else {
            assert_eq!(
                result,
                serde_json::json!({"status":code,"body":{"error":"fixture refused"}})
            );
        }
        assert_eq!(state.lock().await.requests.len(), before + 1);
        assert_eq!(state.lock().await.memories, stable);
    }
    let retried =
        Box::pin(registry.call_tool("memory.search", serde_json::json!({"query":"Quiet"}), None))
            .await
            .unwrap();
    assert_eq!(retried["results"][0]["id"], "memory-1");
    let removed =
        Box::pin(registry.call_tool("memory.forget", serde_json::json!({"id":"memory-1"}), None))
            .await
            .unwrap();
    assert_eq!(
        removed,
        serde_json::json!({"provider":"@ryu/mem0","raw":{"status":204,"body":""}})
    );
    let after_delete =
        Box::pin(registry.call_tool("memory.search", serde_json::json!({"query":"Quiet"}), None))
            .await
            .unwrap();
    assert_eq!(after_delete["results"], serde_json::json!([]));
    let snapshot = state.lock().await.clone();
    assert!(snapshot
        .requests
        .iter()
        .all(|request| request["authorization"].is_null()));
    let deletion = snapshot
        .requests
        .iter()
        .find(|request| request["method"] == "DELETE")
        .unwrap();
    assert_eq!(deletion["path"], "/v1/memories/memory-1/");
    assert_eq!(deletion["body"], serde_json::json!({}));
    manifests.write().await[0].permission_grants.clear();
    store.set_enabled("@ryu/mem0", &[]).await.unwrap();
    let denied = Box::pin(registry.call_tool(
        "mem0.search",
        serde_json::json!({"query":"Quiet","filters":{"user_id":"bucket-a"}}),
        None,
    ))
    .await
    .unwrap_err();
    assert!(denied.to_string().contains("not granted"));
    assert_eq!(state.lock().await.requests.len(), snapshot.requests.len());
    manifests.write().await[0].permission_grants = vec![grant.clone()];
    store.set_enabled("@ryu/mem0", &[grant]).await.unwrap();
    let restored =
        Box::pin(registry.call_tool("memory.search", serde_json::json!({"query":"Quiet"}), None))
            .await
            .unwrap();
    assert_eq!(restored["results"], serde_json::json!([]));
    let restored_state = state.lock().await.clone();
    assert_eq!(restored_state.requests.len(), snapshot.requests.len() + 1);
    assert!(restored_state
        .requests
        .iter()
        .all(|request| request["authorization"].is_null()));
    assert!(!serde_json::to_string(&restored_state.requests)
        .unwrap()
        .contains(KEY));
    for runnable in &manifests.read().await[0].runnables {
        assert_eq!(
            runnable.config.as_ref().unwrap()["secret_headers"]["Authorization"],
            "Token env:RYU_MEM0_API_KEY"
        );
    }
    server.abort();
}

async fn fixture(
    State(state): State<Shared>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    let mut state = state.lock().await;
    state.requests.push(serde_json::json!({"method":method.as_str(),"path":uri.path(),"authorization":headers.get("authorization").and_then(|value|value.to_str().ok()),"body":body}));
    if let Some(code) = body["messages"][0]["content"]
        .as_str()
        .and_then(|s| s.strip_prefix("error-"))
        .and_then(|s| s.parse::<u16>().ok())
    {
        return (
            StatusCode::from_u16(code).unwrap(),
            Json(serde_json::json!({"error":"fixture refused"})),
        )
            .into_response();
    }
    if method == Method::DELETE {
        let id = uri.path().trim_end_matches('/').rsplit('/').next().unwrap();
        state.memories.retain(|memory| memory["id"] != id);
        return StatusCode::NO_CONTENT.into_response();
    }
    if uri.path() == "/v3/memories/add/" {
        let id = format!("memory-{}", state.memories.len() + 1);
        state.memories.push(serde_json::json!({"id":id,"memory":body["messages"][0]["content"],"user_id":body["user_id"],"score":0.9}));
        return (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({"status":"PENDING","event_id":"event-1"})),
        )
            .into_response();
    }
    let query = body["query"].as_str().unwrap_or_default();
    let results: Vec<_> = state
        .memories
        .iter()
        .filter(|memory| {
            memory["user_id"] == body["filters"]["user_id"]
                && memory["memory"].as_str().unwrap().contains(query)
        })
        .cloned()
        .collect();
    Json(serde_json::json!({"results":results})).into_response()
}
