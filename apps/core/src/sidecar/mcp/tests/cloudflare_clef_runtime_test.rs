//! Shipped Clef manifest registry dispatch against a local HTTP contract fixture.
//! The fixture is not the ext proxy or Cloudflare; their boundaries remain separate.
use super::*;
use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
use std::sync::Arc;
const MANIFEST: &str =
    include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/cloudflare-clef/manifest.json");
const TEST_NAME: &str = "sidecar::mcp::tests::cloudflare_clef_runtime::shipped_clef_runs_through_registry_without_provider_headers";

#[tokio::test]
async fn shipped_clef_runs_through_registry_without_provider_headers() {
    if std::env::var_os("RYU_CLEF_TEST_CHILD").is_none() {
        let dir = tempfile::tempdir().unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env("RYU_CLEF_TEST_CHILD", "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env(
                "RYU_TOKEN",
                "2c89de31a4b049cfbd9e04c80fd8a7a156ea12c0194b4305",
            )
            .env("RYU_ALLOW_GATEWAY_FALLBACK", "1")
            .env("RYU_GATEWAY_EXEC_SCAN", "off")
            .env_remove("RYU_GATEWAY_REMOTE")
            .status()
            .unwrap();
        assert!(result.success());
        return;
    }
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_GATEWAY_TOKEN");
    let manifest =
        PluginManifest::parse_and_validate_with_code(MANIFEST, |_| Err("no code".into())).unwrap();
    let config: Value =
        serde_json::from_str::<Value>(MANIFEST).unwrap()["runnables"][0]["config"].clone();
    assert_eq!(
        config["secret_headers"],
        serde_json::json!({"Authorization":"Bearer env:RYU_TOKEN"})
    );
    let observed = Arc::new(TokioRwLock::new(Vec::<Value>::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let bind = listener.local_addr().unwrap().to_string();
    std::env::set_var("RYU_BIND", &bind);
    let app = Router::new()
        .route("/api/ext/@ryu/cloudflare-clef/predict", post(fixture))
        .with_state(observed.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(&manifest.id, &manifest.version).await.unwrap();
    store
        .set_enabled(&manifest.id, &manifest.permission_grants)
        .await
        .unwrap();
    let manifests = Arc::new(TokioRwLock::new(vec![manifest]));
    let registry = McpRegistry::empty().with_self_build(manifests.clone(), store.clone());
    registry.register_app_tool(
        "cloudflare-clef.predict".into(),
        "Cloudflare Clef Predict".into(),
        None,
    );
    for (args, expected_model) in [
        (
            serde_json::json!({"state":{"ticket":"billing"},"questions":{"urgent":{"type":"noul"}}}),
            "clef",
        ),
        (
            serde_json::json!({"state":"image", "questions":{"label":{"type":"choice"}},"model":"clef-flash","images":["data:image/png;base64,aGVsbG8="]}),
            "clef-flash",
        ),
    ] {
        let result = registry
            .call_tool("cloudflare-clef.predict", args.clone(), None)
            .await
            .unwrap();
        assert_eq!(result, serde_json::json!({"answers":{"fixture":true}}));
        let requests = observed.read().await;
        let request = requests.last().unwrap();
        assert_eq!(request["body"]["model"], expected_model);
        assert_eq!(request["body"]["state"], args["state"]);
        assert_eq!(request["body"]["questions"], args["questions"]);
        assert_eq!(request["body"]["images"], args["images"]);
        assert_eq!(
            request["authorization"],
            "Bearer 2c89de31a4b049cfbd9e04c80fd8a7a156ea12c0194b4305"
        );
        assert_eq!(request["provider_token"], Value::Null);
        assert_eq!(request["account"], Value::Null);
    }
    // Removing a shipped grant changes manifest provenance. Remove the approved
    // record grant as well, so neither trust tier authorizes fixture egress.
    manifests.write().await[0]
        .permission_grants
        .retain(|grant| grant != "tool:http-egress:127.0.0.1");
    store
        .set_enabled("@ryu/cloudflare-clef", &[])
        .await
        .unwrap();
    let denied = registry
        .call_tool("cloudflare-clef.predict", serde_json::json!({}), None)
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("not granted"));
    assert_eq!(observed.read().await.len(), 2);
    server.abort();
}

async fn fixture(
    State(observed): State<Arc<TokioRwLock<Vec<Value>>>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    observed.write().await.push(serde_json::json!({
        "body":body,
        "authorization":headers.get("authorization").and_then(|v|v.to_str().ok()),
        "provider_token":headers.get("x-cloudflare-api-token").and_then(|v|v.to_str().ok()),
        "account":headers.get("x-cloudflare-account-id").and_then(|v|v.to_str().ok()),
    }));
    Json(serde_json::json!({"answers":{"fixture":true}}))
}

#[tokio::test]
async fn sidecar_secrets_are_explicit_scoped_and_missing_values_are_omitted() {
    let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
    let key = "RYU_PLUGIN_CLEFSCOPEPROOF_KEY";
    store
        .set("clefscopeproof", key, "synthetic-secret")
        .await
        .unwrap();
    let source = format!("env:{key}");
    assert_eq!(
        crate::tool_exec::resolve_sidecar_env_source("clefscopeproof", &source, Some(&store), None)
            .await,
        Some("synthetic-secret".into())
    );
    assert_eq!(
        crate::tool_exec::resolve_sidecar_env_source("com.test.other", &source, Some(&store), None)
            .await,
        None
    );
    assert_eq!(
        crate::tool_exec::resolve_sidecar_env_source(
            "clefscopeproof",
            "env:RYU_PLUGIN_CLEFSCOPEPROOF_MISSING",
            Some(&store),
            None
        )
        .await,
        None
    );
    let mut env = std::collections::BTreeMap::from([
        ("LITERAL".into(), "kept".into()),
        (
            "MISSING".into(),
            "env:RYU_PLUGIN_CLEFSCOPEPROOF_MISSING".into(),
        ),
    ]);
    crate::sidecar::manifest_sidecar::resolve_declared_env(&mut env, "clefscopeproof", None).await;
    assert_eq!(
        env,
        std::collections::BTreeMap::from([("LITERAL".into(), "kept".into())])
    );
    assert!(!env.contains_key("HOME"));
    assert!(!env.contains_key("RYU_TOKEN"));
}
