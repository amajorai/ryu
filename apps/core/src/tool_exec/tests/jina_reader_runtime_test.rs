//! Hydrated Jina adapter through actual registry activation, grants and HTTP dispatch.
//! No hosted provider is contacted. A plain-HTTP fixture deliberately remains
//! unreachable with the authored secret header intact: Core's HTTPS-only policy
//! must refuse it. This proves refusal/recovery, not Reader response success.
use super::*;
use axum::{http::StatusCode, routing::post, Router};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

const MANIFEST: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/jina-reader/manifest.json");
const ADAPTER: &str =
    include_str!("../../../../../generated/ryu-runtime/plugins-store/plugins/jina-reader/adapters/web.extract.js");
const KEY_ENV: &str = "RYU_PLUGIN__X40_RYU_X2F_JINA_X2D_READER_API_KEY";
const KEY: &str = "jina-synthetic-runtime-key-not-real";
const CHILD: &str = "RYU_JINA_READER_REGISTRY_RUNTIME_CHILD";
const TEST_NAME: &str = "tool_exec::tests::jina_reader_runtime::jina_reader_hydrated_registry_preserves_authorization_transport_refusal_and_retry";

#[tokio::test]
async fn jina_reader_hydrated_registry_preserves_authorization_transport_refusal_and_retry() {
    if std::env::var_os(CHILD).is_none() {
        let data = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(CHILD, "1")
            .env(KEY_ENV, KEY)
            .env("RUST_MIN_STACK", "16777216")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", data.path())
            .env("RYU_ALLOW_GATEWAY_FALLBACK", "0")
            .env("RYU_EXEC_APPROVAL_MODE", "off")
            .env_remove("RYU_GATEWAY_REMOTE")
            .status()
            .unwrap();
        assert!(
            status.success(),
            "isolated Jina registry refusal proof failed"
        );
        return;
    }
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let mut manifest =
        crate::plugin_manifest::PluginManifest::parse_and_validate_with_code(MANIFEST, |path| {
            match path {
                "adapters/web.extract.js" => Ok(ADAPTER.to_string()),
                _ => Err(format!("unexpected Jina body {path}")),
            }
        })
        .unwrap();
    assert_eq!(manifest.id, "@ryu/jina-reader");
    assert_eq!(
        manifest.permission_grants,
        ["tool:http-egress:r.jina.ai", "tool:execute"]
    );
    let hydrated = serde_json::to_value(&manifest).unwrap();
    assert_eq!(
        hydrated["provides"][0]["tools"]["web.extract"]["adapter"]["code"],
        ADAPTER
    );
    let authored: Value = serde_json::from_str(MANIFEST).unwrap();
    let config = &authored["runnables"][0]["config"];
    assert_eq!(config["slug"], "jina_reader.fetch");
    assert_eq!(config["url"], "https://r.jina.ai/");
    assert_eq!(config["method"], "POST");
    assert_eq!(
        config["header_params"],
        serde_json::json!(["Accept", "X-Respond-With"])
    );
    assert_eq!(config["fail_open"], true);
    assert_eq!(config["unwrap_body"], true);
    let template = config["secret_headers"]["Authorization"].as_str().unwrap();
    assert_eq!(template, format!("Bearer env:{KEY_ENV}"));
    let resolved = resolve_secret_header_source("Authorization", template, &manifest.id, &[], None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(resolved, format!("Bearer {KEY}"));
    let input =
        serde_json::json!({"url":"https://example.com/article", "Accept":"application/json"});
    let (url, query, body, headers) = build_rest_request(
        config["url"].as_str().unwrap(),
        &input,
        false,
        &["Accept".into()],
        &[("Authorization".into(), resolved)],
    )
    .unwrap();
    assert_eq!(url, "https://r.jina.ai/");
    assert!(query.is_empty());
    assert_eq!(
        body,
        serde_json::json!({"url":"https://example.com/article"})
    );
    assert_eq!(
        headers,
        vec![
            ("Accept".to_string(), "application/json".to_string()),
            ("Authorization".to_string(), format!("Bearer {KEY}")),
        ]
    );
    assert!(!body.to_string().contains(KEY));

    let requests = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/",
        post({
            let requests = requests.clone();
            move || {
                let requests = requests.clone();
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::FORBIDDEN,
                        "unexpected request: HTTPS policy was bypassed",
                    )
                }
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    // This explicitly configured Community fixture changes only the transport
    // origin/version and grants local egress. It retains the actual header and
    // adapter, so even an approved loopback call must be refused before I/O.
    manifest.version.push_str("-fixture");
    manifest.runnables[0].config.as_mut().unwrap()["url"] =
        Value::String(format!("http://{address}/"));
    manifest
        .permission_grants
        .push("tool:http-egress:127.0.0.1".into());
    assert_eq!(
        crate::plugins::builtins::tier_for_manifest(&manifest),
        crate::plugin_manifest::PluginTier::Community
    );
    let approved = manifest.permission_grants.clone();
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(&manifest.id, &manifest.version).await.unwrap();
    store.set_enabled(&manifest.id, &approved).await.unwrap();
    let manifests = Arc::new(tokio::sync::RwLock::new(vec![manifest]));
    let registry = Arc::new(
        crate::sidecar::mcp::McpRegistry::empty().with_self_build(manifests.clone(), store.clone()),
    );
    let runtime = crate::plugins::runtime::PluginRuntime::new();
    registry.set_plugin_runtime(runtime.clone());
    runtime.begin_activation("@ryu/jina-reader").await.commit();
    registry.register_app_tool("jina_reader.fetch".into(), "jina_reader.fetch".into(), None);
    crate::sidecar::mcp::set_global_registry(registry.clone());
    crate::plugins::binding::set_active_config(crate::plugins::binding::BindingConfig {
        overrides: [("web.extract".into(), "@ryu/jina-reader".into())]
            .into_iter()
            .collect(),
    });
    let verbs = registry.capability_verbs().await;
    assert_eq!(verbs.len(), 1);
    assert_eq!(verbs[0].provider_id, "@ryu/jina-reader");
    let denied = registry
        .call_tool("web.extract", input.clone(), Some(&["web.search".into()]))
        .await
        .unwrap_err()
        .to_string();
    assert!(denied.contains("not in this agent's allowlist"), "{denied}");
    for (url, expected) in [
        ("file:///etc/passwd", "HTTP or HTTPS URL"),
        ("http://127.0.0.1/private", "local or private URL"),
        ("http://[::1]/private", "local or private URL"),
        (
            "https://user:password@example.com/private",
            "without credentials",
        ),
    ] {
        let error = registry
            .call_tool("web.extract", serde_json::json!({"url":url}), None)
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains(expected), "{url}: {error}");
        assert_eq!(requests.load(Ordering::SeqCst), 0);
    }
    let refusal = registry
        .call_tool("web.extract", input.clone(), None)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        refusal.contains("secret headers require an HTTPS destination"),
        "{refusal}"
    );
    assert!(!refusal.contains(KEY));
    store
        .set_approved_grants("@ryu/jina-reader", &[])
        .await
        .unwrap();
    let revoked = registry
        .call_tool("web.extract", input.clone(), None)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        revoked.contains("does not hold") && revoked.contains("tool:execute"),
        "{revoked}"
    );
    assert!(store
        .get("@ryu/jina-reader")
        .await
        .unwrap()
        .unwrap()
        .approved_grants
        .is_empty());
    store
        .set_approved_grants("@ryu/jina-reader", &approved)
        .await
        .unwrap();
    let restored = registry
        .call_tool("web.extract", input.clone(), None)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        restored.contains("secret headers require an HTTPS destination"),
        "{restored}"
    );
    // Absence of the optional API key must never disable the transport guard.
    std::env::remove_var(KEY_ENV);
    assert!(
        resolve_secret_header_source("Authorization", template, "@ryu/jina-reader", &[], None)
            .await
            .unwrap()
            .is_none()
    );
    // Direct provider calls cannot evade the canonical layer's adapter checks.
    let direct = registry
        .call_tool("jina_reader.fetch", input.clone(), None)
        .await
        .unwrap_err()
        .to_string();
    assert_eq!(
        direct,
        "call web or browser providers through their canonical layer tools"
    );
    assert_eq!(requests.load(Ordering::SeqCst), 0);
    let anonymous = registry
        .call_tool("web.extract", input.clone(), None)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        anonymous.contains("secret headers require an HTTPS destination"),
        "{anonymous}"
    );
    assert!(!anonymous.contains(KEY));
    let inactive = runtime.begin_deactivation("@ryu/jina-reader").await;
    registry.unregister_app_tool("jina_reader.fetch");
    store.set_disabled("@ryu/jina-reader").await.unwrap();
    drop(inactive);
    let unavailable = registry
        .call_tool("web.extract", input.clone(), None)
        .await
        .unwrap();
    assert_eq!(unavailable["available"], false);
    assert_eq!(unavailable["capability"], "web.extract");
    assert!(store
        .get("@ryu/jina-reader")
        .await
        .unwrap()
        .unwrap()
        .approved_grants
        .is_empty());
    store
        .set_enabled("@ryu/jina-reader", &approved)
        .await
        .unwrap();
    runtime.begin_activation("@ryu/jina-reader").await.commit();
    registry.register_app_tool("jina_reader.fetch".into(), "jina_reader.fetch".into(), None);
    let retry = registry
        .call_tool("web.extract", input, None)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        retry.contains("secret headers require an HTTPS destination"),
        "{retry}"
    );
    assert_eq!(
        requests.load(Ordering::SeqCst),
        0,
        "no provider or loopback request is authorized by these refusals"
    );
    server.abort();
}
