//! Actual Laya/Ollaya manifests through the native registry and canonical facade.
//! Only an ephemeral loopback fixture is contacted. Laya's ext-proxy route is
//! simulated and Ollaya's service port is rewritten; no model runtime is started.
use super::*;
use axum::{
    body::Bytes,
    extract::{OriginalUri, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;

const LAYA: &str = include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/laya/manifest.json");
const OLLAYA: &str = include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/ollaya/manifest.json");
const CHILD: &str = "RYU_LOCAL_DECISIONS_RUNTIME_CHILD";
const TOKEN: &str = "2c89de31a4b049cfbd9e04c80fd8a7a156ea12c0194b4305";
const TEST_NAME: &str = "sidecar::mcp::tests::local_decision_models_runtime::local_decision_models_dispatch_and_switch_through_canonical_facade";
type Observed = Arc<tokio::sync::Mutex<Vec<Value>>>;

#[tokio::test]
async fn local_decision_models_dispatch_and_switch_through_canonical_facade() {
    if std::env::var_os(CHILD).is_none() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(CHILD, "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env("RYU_TOKEN", TOKEN)
            .env("RYU_ALLOW_GATEWAY_FALLBACK", "1")
            .env("RYU_EXEC_APPROVAL_MODE", "off")
            .env_remove("RYU_GATEWAY_REMOTE")
            .status()
            .unwrap();
        assert!(status.success(), "isolated local decision fixture failed");
        return;
    }
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_GATEWAY_TOKEN");
    let mut manifests = [LAYA, OLLAYA]
        .into_iter()
        .map(|text| {
            PluginManifest::parse_and_validate_with_code(text, |_| Err("no code fragments".into()))
                .unwrap()
        })
        .collect::<Vec<_>>();
    let ollaya_json: Value = serde_json::from_str(OLLAYA).unwrap();
    assert!(ollaya_json.get("contributes").is_none());
    for runnable in ollaya_json["runnables"].as_array().unwrap() {
        assert!(runnable["config"].get("secret_headers").is_none());
    }

    let observed: Observed = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    std::env::set_var("RYU_BIND", address.to_string());
    let app = Router::new()
        .route("/api/ext/@ryu/laya/predict", post(fixture))
        .route("/api/ext/@ryu/laya/capability", get(fixture))
        .route("/v1/systemone", post(fixture))
        .route("/v1/models", get(fixture))
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    // The external service port is the sole authored setting rewritten for the
    // fixture. Scheme, loopback host, methods, paths and bodies remain shipped.
    for entry in &mut manifests[1].runnables {
        let config = entry.config.as_mut().unwrap();
        let mut url = reqwest::Url::parse(config["url"].as_str().unwrap()).unwrap();
        assert_eq!(url.scheme(), "http");
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        assert_eq!(url.port(), Some(11435));
        url.set_port(Some(address.port())).unwrap();
        config["url"] = Value::String(url.to_string());
    }
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    for manifest in &manifests {
        store.insert(&manifest.id, &manifest.version).await.unwrap();
        store
            .set_enabled(&manifest.id, &manifest.permission_grants)
            .await
            .unwrap();
    }
    let manifests = Arc::new(TokioRwLock::new(manifests));
    let registry = McpRegistry::empty().with_self_build(manifests.clone(), store.clone());
    for slug in [
        "laya.predict",
        "laya.status",
        "ollaya.predict",
        "ollaya.models",
    ] {
        registry.register_app_tool(slug.into(), slug.into(), None);
    }
    for (slug, path, authorization) in [
        (
            "laya.status",
            "/api/ext/@ryu/laya/capability",
            Some(format!("Bearer {TOKEN}")),
        ),
        ("ollaya.models", "/v1/models", None),
    ] {
        let result = registry
            .call_tool(slug, serde_json::json!({}), None)
            .await
            .unwrap();
        assert_eq!(result["available"], true);
        let events = observed.lock().await;
        let event = events.last().unwrap();
        assert_eq!(event["path"], path);
        assert_eq!(event["method"], "GET");
        assert_eq!(event["query"], Value::Null);
        assert_eq!(event["body"], Value::Null);
        assert_eq!(event["authorization"], serde_json::json!(authorization));
    }

    let args = serde_json::json!({
        "state": {"ticket":"billing"},
        "questions": {"urgent":{"type":"noul","instructions":"Urgent?"}}
    });
    crate::plugins::binding::set_active_config(Default::default());
    let mut first_provider = true;
    for (provider, path, expected_model) in [
        ("@ryu/laya", "/api/ext/@ryu/laya/predict", Value::Null),
        ("@ryu/ollaya", "/v1/systemone", Value::String("laya".into())),
        ("@ryu/laya", "/api/ext/@ryu/laya/predict", Value::Null),
    ] {
        if first_provider {
            // The first dispatch uses the shipped default Laya provider.
            first_provider = false;
        } else {
            crate::plugins::binding::set_active_config(crate::plugins::binding::BindingConfig {
                overrides: [("decision.typed".into(), provider.into())]
                    .into_iter()
                    .collect(),
            });
        }
        let result = registry
            .call_tool(
                "decision.predict",
                args.clone(),
                Some(&["decision.predict".into()]),
            )
            .await
            .unwrap();
        assert_eq!(result["provider"], provider);
        assert_eq!(result["raw"]["answers"]["urgent"]["probability"], 0.9);
        let events = observed.lock().await;
        let event = events.last().unwrap();
        assert_eq!(event["path"], path);
        assert_eq!(event["body"]["state"], args["state"]);
        assert_eq!(event["body"]["questions"], args["questions"]);
        assert_eq!(event["body"]["model"], expected_model);
        assert_eq!(event["method"], "POST");
        if provider == "@ryu/ollaya" {
            assert_eq!(event["authorization"], Value::Null);
        } else {
            assert_eq!(event["authorization"], format!("Bearer {TOKEN}"));
        }
    }
    for (slug, extra) in [
        (
            "laya.predict",
            serde_json::json!({"model":"typed-decisions","task":"typed-decisions","lang":"hi"}),
        ),
        (
            "ollaya.predict",
            serde_json::json!({"model":"installed-alias"}),
        ),
    ] {
        let mut explicit = args.clone();
        explicit
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        registry
            .call_tool(slug, explicit.clone(), None)
            .await
            .unwrap();
        assert_eq!(observed.lock().await.last().unwrap()["body"], explicit);
    }

    // Non-2xx failures stay visible and never retry or switch providers.
    for slug in ["laya.predict", "ollaya.predict"] {
        let before = observed.lock().await.len();
        let result = registry
            .call_tool(
                slug,
                serde_json::json!({"state":"fixture-unavailable","questions":{"urgent":{"type":"noul"}}}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            result,
            serde_json::json!({"status":503,"body":{"error":"fixture unavailable"}})
        );
        assert_eq!(observed.lock().await.len(), before + 1);
    }
    for (index, slug) in [(0, "laya.status"), (1, "ollaya.models")] {
        let id = manifests.read().await[index].id.clone();
        manifests.write().await[index]
            .permission_grants
            .retain(|grant| grant != "tool:http-egress:127.0.0.1");
        store.set_enabled(&id, &[]).await.unwrap();
        let before = observed.lock().await.len();
        let error = registry
            .call_tool(slug, serde_json::json!({}), None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("not granted"));
        assert_eq!(observed.lock().await.len(), before);
    }
    // Restore egress so a stopped service reaches transport, not the grant gate.
    for manifest in manifests.write().await.iter_mut() {
        manifest
            .permission_grants
            .push("tool:http-egress:127.0.0.1".into());
        store
            .set_enabled(&manifest.id, &manifest.permission_grants)
            .await
            .unwrap();
    }
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
    let unavailable = registry
        .call_tool("laya.predict", args.clone(), None)
        .await
        .unwrap();
    assert_eq!(unavailable["available"], false);
    let failure = registry
        .call_tool("ollaya.predict", args, None)
        .await
        .unwrap_err();
    assert!(failure.to_string().contains("http tool request failed:"));
    assert!(!failure.to_string().contains(TOKEN));
}

async fn fixture(
    State(observed): State<Observed>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice::<Value>(&body).unwrap()
    };
    observed.lock().await.push(serde_json::json!({
        "path":uri.path(),"query":uri.query(),"method":method.as_str(),"body":value,
        "authorization":headers.get("authorization").and_then(|v|v.to_str().ok()),
    }));
    if value["state"] == "fixture-unavailable" {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error":"fixture unavailable"})),
        )
            .into_response();
    }
    if method == Method::GET {
        return Json(serde_json::json!({"available":true,"models":["fixture-local-model"]}))
            .into_response();
    }
    Json(serde_json::json!({"answers":{"urgent":{"value":true,"probability":0.9}}})).into_response()
}
