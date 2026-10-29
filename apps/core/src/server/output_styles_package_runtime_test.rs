//! Shipped style hydration and Core registry/HTTP behavior. No model is contacted.
use super::*;
use axum::{body::Body, http::Request};
use tower::ServiceExt;

const TEST: &str =
    "server::output_styles_package_runtime::shipped_profiles_sync_read_fork_disable_and_recover";

async fn request(method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = output_styles_routes::<()>()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(if body.is_null() {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn shipped_profiles_sync_read_fork_disable_and_recover() {
    if std::env::var_os("RYU_STYLES_PACKAGE_TEST_CHILD").is_none() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env("RYU_STYLES_PACKAGE_TEST_CHILD", "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env(
                ryu_output_styles::ENV_OUTPUT_STYLES_DIR,
                dir.path().join("profiles"),
            )
            .env(
                ryu_output_styles::ENV_SELECTION_FILE,
                dir.path().join("selection.json"),
            )
            .status()
            .unwrap();
        assert!(status.success(), "isolated shipped profile proof failed");
        return;
    }
    let _guard = ryu_output_styles::OUTPUT_STYLES_ENV_LOCK.lock().unwrap();
    let mut manifest = crate::plugin_manifest::PluginManifest::parse_and_validate(include_str!(
        "../../../../generated/ryu-runtime/plugins-store/plugins/output-styles/manifest.json"
    ))
    .unwrap();
    crate::plugin_manifest::hydrate_manifest_code_files(&mut manifest, None).unwrap();
    let styles = &manifest.contributes.as_ref().unwrap().output_styles;
    assert_eq!(styles.len(), 12);
    let registry = output_style_registry();
    sync_plugin_output_styles(&manifest, true);
    let (status, listed) = request("GET", "/api/output-styles", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["styles"].as_array().unwrap().len(), 12);
    for style in styles {
        let source = style.source.as_deref().unwrap();
        let parsed = ryu_output_styles::parse_output_style_md(&style.id, source).unwrap();
        let (_, detail) = request(
            "GET",
            &format!("/api/output-styles/{}/source", style.id),
            Value::Null,
        )
        .await;
        assert_eq!(detail["raw"], source);
        assert_eq!(registry.get(&style.id).unwrap().body, parsed.body);
        let (status, selected) = request(
            "POST",
            "/api/output-styles/select",
            json!({"style_id": style.id}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(selected["selected"], style.id);
        let persisted: Value = serde_json::from_slice(
            &std::fs::read(std::env::var_os(ryu_output_styles::ENV_SELECTION_FILE).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(persisted["style_id"], style.id);
    }
    let (status, _) = request(
        "POST",
        "/api/output-styles/select",
        json!({"style_id": "missing"}),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, selected) = request("GET", "/api/output-styles", Value::Null).await;
    assert_eq!(selected["selected"], styles.last().unwrap().id);
    let original = registry.source_of("eli5").unwrap();
    let (status, fork) = request(
        "PUT",
        "/api/output-styles/eli5",
        json!({"name":"My voice","body":"Use my own phrasing.","keep_coding_instructions":true}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fork["forked"], true);
    assert!(std::fs::read_to_string(
        std::path::PathBuf::from(
            std::env::var_os(ryu_output_styles::ENV_OUTPUT_STYLES_DIR).unwrap()
        )
        .join("eli5.md")
    )
    .unwrap()
    .contains("Use my own phrasing."));
    registry.reload();
    assert_eq!(
        registry.get("eli5").unwrap().source,
        ryu_output_styles::OutputStyleSource::User
    );
    sync_plugin_output_styles(&manifest, false);
    assert_eq!(
        registry.all().len(),
        1,
        "only the user's fork survives disable"
    );
    assert!(
        collect_plugin_output_styles(&[manifest.clone()], &Default::default(), None).is_empty()
    );
    let (status, _) = request("DELETE", "/api/output-styles/eli5", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert!(registry.get("eli5").is_none());
    sync_plugin_output_styles(&manifest, true);
    assert_eq!(registry.all().len(), 12);
    assert_eq!(registry.source_of("eli5").unwrap(), original);
    let enabled = std::collections::HashSet::from([manifest.id.clone()]);
    assert_eq!(
        collect_plugin_output_styles(&[manifest], &enabled, None).len(),
        12
    );
}
