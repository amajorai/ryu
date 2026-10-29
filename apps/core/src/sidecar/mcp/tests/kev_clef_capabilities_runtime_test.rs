//! Shipped Kev/Clef canonical selection and HTTP contracts through Core registry.
//! Clef's ext-proxy URL resolves to a local fixture with a synthetic node token;
//! Kev retains its loopback scheme/path and only its port changes. Neither model
//! service, managed sidecar nor external account is started.
use super::*;
use axum::{
    body::Bytes,
    extract::{OriginalUri, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use std::sync::Arc;

const KEV: &str = include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/kev/manifest.json");
const CLEF: &str =
    include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/cloudflare-clef/manifest.json");
const CHILD: &str = "RYU_KEV_CLEF_CAPABILITIES_CHILD";
const TOKEN: &str = "2c89de31a4b049cfbd9e04c80fd8a7a156ea12c0194b4305";
const TEST_NAME: &str = "sidecar::mcp::tests::kev_clef_capabilities_runtime::kev_clef_canonical_selection_preserves_requests_grants_and_errors";

#[derive(Default)]
struct DecisionsFixture {
    requests: Vec<Value>,
    unavailable: bool,
}
type Shared = Arc<tokio::sync::Mutex<DecisionsFixture>>;

#[tokio::test]
async fn kev_clef_canonical_selection_preserves_requests_grants_and_errors() {
    if std::env::var_os(CHILD).is_none() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(CHILD, "1")
            .env("RUST_MIN_STACK", "16777216")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env("RYU_TOKEN", TOKEN)
            .env("RYU_ALLOW_GATEWAY_FALLBACK", "1")
            .env("RYU_EXEC_APPROVAL_MODE", "off")
            .env_remove("RYU_GATEWAY_REMOTE")
            .env_remove("RYU_CLOUDFLARE_API_TOKEN")
            .env_remove("RYU_CLOUDFLARE_ACCOUNT_ID")
            .env_remove("RYU_KEV_API_KEY")
            .status()
            .unwrap();
        assert!(
            status.success(),
            "isolated Kev/Clef canonical fixture failed"
        );
        return;
    }
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_GATEWAY_TOKEN");
    let state: Shared = Arc::new(tokio::sync::Mutex::new(DecisionsFixture::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    std::env::set_var("RYU_BIND", address.to_string());
    let app = Router::new()
        .route("/v1/systemone", post(fixture))
        .route("/api/ext/@ryu/cloudflare-clef/predict", post(fixture))
        .with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut hydrated = [KEV, CLEF]
        .into_iter()
        .map(|raw| {
            PluginManifest::parse_and_validate_with_code(raw, |_| Err("no code fragments".into()))
                .unwrap()
        })
        .collect::<Vec<_>>();
    for runnable in &mut hydrated[0].runnables {
        let config = runnable.config.as_mut().unwrap();
        let mut url = reqwest::Url::parse(config["url"].as_str().unwrap()).unwrap();
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert_eq!(url.port(), Some(8009));
        url.set_port(Some(address.port())).unwrap();
        config["url"] = Value::String(url.to_string());
    }
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    for manifest in &hydrated {
        store.insert(&manifest.id, &manifest.version).await.unwrap();
        store
            .set_enabled(&manifest.id, &manifest.permission_grants)
            .await
            .unwrap();
    }
    let manifests = Arc::new(TokioRwLock::new(hydrated));
    let registry = McpRegistry::empty().with_self_build(manifests.clone(), store.clone());
    for slug in ["kev.predict", "kev.models", "cloudflare-clef.predict"] {
        registry.register_app_tool(slug.into(), slug.into(), None);
    }
    let questions = serde_json::json!({"ready":{"type":"noul","question":"Ready?"}});
    for (provider, verb, path, model, arguments) in [
        (
            "@ryu/kev",
            "decision.predict",
            "/v1/systemone",
            "kev-latest",
            serde_json::json!({"state":{"ready":true},"questions":questions}),
        ),
        (
            "@ryu/cloudflare-clef",
            "decision.predict",
            "/api/ext/@ryu/cloudflare-clef/predict",
            "clef",
            serde_json::json!({"state":"fixture state","questions":questions}),
        ),
        (
            "@ryu/cloudflare-clef",
            "decision.predict_multimodal",
            "/api/ext/@ryu/cloudflare-clef/predict",
            "clef-flash",
            serde_json::json!({"state":["fixture"],"questions":questions,"model":"clef-flash","images":[{"content_type":"image/png","base64":"iVBORw0KGgo="}]}),
        ),
    ] {
        crate::plugins::binding::set_active_config(crate::plugins::binding::BindingConfig {
            overrides: [("decision.typed".into(), provider.into())]
                .into_iter()
                .collect(),
        });
        let verbs = registry.capability_verbs().await;
        assert!(verbs
            .iter()
            .any(|entry| entry.verb.id == verb && entry.provider_id == provider));
        if provider == "@ryu/kev" {
            assert!(!verbs
                .iter()
                .any(|entry| entry.verb.id == "decision.predict_multimodal"));
        }
        let before = state.lock().await.requests.len();
        let denied = registry
            .call_tool(verb, arguments.clone(), Some(&["web.search".into()]))
            .await
            .unwrap_err();
        assert!(denied.to_string().contains("not in this agent's allowlist"));
        assert_eq!(state.lock().await.requests.len(), before);
        let result = registry
            .call_tool(verb, arguments.clone(), Some(&[verb.into()]))
            .await
            .unwrap();
        assert_eq!(
            result,
            serde_json::json!({"provider":provider,"raw":{"answers":{"ready":{"probability":0.75}},"model":model}})
        );
        let request = state.lock().await.requests[before].clone();
        let mut expected_body = arguments.clone();
        expected_body["model"] = Value::String(model.into());
        assert_eq!(request["path"], path);
        assert_eq!(request["body"], expected_body);
        assert_eq!(
            request["authorization"],
            if provider == "@ryu/kev" {
                Value::Null
            } else {
                Value::String(format!("Bearer {TOKEN}"))
            }
        );
        assert_eq!(request["provider_token"], Value::Null);
        assert_eq!(request["account"], Value::Null);
        assert_eq!(state.lock().await.requests.len(), before + 1);
        state.lock().await.unavailable = true;
        let failed = registry
            .call_tool(verb, arguments.clone(), None)
            .await
            .unwrap();
        assert_eq!(
            failed,
            serde_json::json!({"provider":provider,"raw":{"status":503,"body":{"error":"fixture model unavailable"}}})
        );
        state.lock().await.unavailable = false;
        assert_eq!(
            registry
                .call_tool(verb, arguments.clone(), None)
                .await
                .unwrap(),
            result
        );
        let index = manifests
            .read()
            .await
            .iter()
            .position(|entry| entry.id == provider)
            .unwrap();
        let grants = manifests.read().await[index].permission_grants.clone();
        let remaining: Vec<_> = grants
            .iter()
            .filter(|grant| grant.as_str() != "tool:http-egress:127.0.0.1")
            .cloned()
            .collect();
        manifests.write().await[index].permission_grants = remaining.clone();
        store.set_enabled(provider, &remaining).await.unwrap();
        let before_denial = state.lock().await.requests.len();
        let refusal = registry.call_tool(verb, arguments, None).await.unwrap_err();
        assert!(refusal.to_string().contains("not granted"));
        assert_eq!(state.lock().await.requests.len(), before_denial);
        manifests.write().await[index].permission_grants = grants.clone();
        store.set_enabled(provider, &grants).await.unwrap();
    }
    server.abort();
}

async fn fixture(
    State(state): State<Shared>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    let mut guard = state.lock().await;
    guard.requests.push(serde_json::json!({"path":uri.path(),"body":body,"authorization":headers.get("authorization").and_then(|value| value.to_str().ok()),"provider_token":headers.get("x-api-key").and_then(|value| value.to_str().ok()),"account":headers.get("x-cloudflare-account-id").and_then(|value| value.to_str().ok())}));
    if guard.unavailable {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error":"fixture model unavailable"})),
        )
            .into_response();
    }
    Json(serde_json::json!({"answers":{"ready":{"probability":0.75}},"model":body["model"]}))
        .into_response()
}
