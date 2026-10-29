use super::*;
use axum::body::Body;
use axum::http::Request;
use tower::ServiceExt;

#[tokio::test]
async fn companion_response_respects_shipped_workflows_and_bookmarks_surface_support() {
    assert_eq!(std::env::var("RYU_KEYCHAIN").as_deref(), Ok("off"));
    let configured =
        std::path::PathBuf::from(std::env::var_os("RYU_DIR").expect("isolated RYU_DIR"));
    assert!(configured.starts_with(std::env::temp_dir()) || configured.starts_with("/private/tmp"));
    let directory = tempfile::tempdir().unwrap();
    let state = super::workflow_version_revision_tests::handler_state(directory.path());
    let manifests: Vec<_> = crate::plugin_manifest::PluginManifestLoader::load_builtins()
        .into_iter()
        .filter(|manifest| matches!(manifest.id.as_str(), "@ryu/workflows" | "@ryu/bookmarks"))
        .collect();
    assert_eq!(manifests.len(), 2);
    for manifest in &manifests {
        state
            .app_store
            .insert(&manifest.id, &manifest.version)
            .await
            .unwrap();
        state
            .app_store
            .set_enabled(&manifest.id, &manifest.permission_grants)
            .await
            .unwrap()
            .unwrap();
        state
            .app_store
            .set_ui_code(&manifest.id, Some("<main>Installed companion</main>"))
            .await
            .unwrap();
    }
    *state.app_manifests.write().await = manifests;
    let router = Router::new()
        .route("/api/plugins/contributions", get(plugin_contributions))
        .with_state(state);
    for (surface, expected) in [
        (Some("extension"), vec!["@ryu/bookmarks"]),
        (Some("desktop"), vec!["@ryu/bookmarks", "@ryu/workflows"]),
        (Some("web"), vec!["@ryu/workflows"]),
        (Some("mobile"), vec!["@ryu/workflows"]),
        (Some("island"), vec!["@ryu/workflows"]),
        (Some("cli"), vec!["@ryu/workflows"]),
        (Some("core"), vec!["@ryu/workflows"]),
        (Some("gateway"), vec![]),
        (Some("  EXTENSION  "), vec!["@ryu/bookmarks"]),
        (Some(" DeSkToP "), vec!["@ryu/bookmarks", "@ryu/workflows"]),
        (Some(" MOBILE "), vec!["@ryu/workflows"]),
        (Some(" GATEWAY "), vec![]),
        (None, vec!["@ryu/bookmarks", "@ryu/workflows"]),
        (
            Some("unknown-client"),
            vec!["@ryu/bookmarks", "@ryu/workflows"],
        ),
    ] {
        let mut request = Request::builder().uri("/api/plugins/contributions");
        if let Some(surface) = surface {
            request = request.header("X-Ryu-Surface", surface);
        }
        let response = router
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let companions = body["companions"].as_array().unwrap();
        let mut owners: Vec<_> = companions
            .iter()
            .map(|companion| {
                assert_eq!(companion["has_ui"], json!(true));
                assert!(!companion["approved_grants"].as_array().unwrap().is_empty());
                companion["plugin_id"].as_str().unwrap()
            })
            .collect();
        owners.sort_unstable();
        assert_eq!(owners, expected, "calling surface: {surface:?}");
    }
}
