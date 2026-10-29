use super::*;
use axum::body::Body;
use axum::http::Request;
use tower::ServiceExt;

async fn request(
    router: &Router,
    method: &str,
    path: &str,
    body: serde_json::Value,
) -> (StatusCode, serde_json::Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
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
async fn workflow_version_revision_guard_preserves_acknowledged_definition_and_denies_managed_anonymous(
) {
    assert_eq!(std::env::var("RYU_KEYCHAIN").as_deref(), Ok("off"));
    let configured =
        std::path::PathBuf::from(std::env::var_os("RYU_DIR").expect("isolated RYU_DIR"));
    assert!(configured.starts_with(std::env::temp_dir()) || configured.starts_with("/private/tmp"));
    assert_eq!(crate::paths::ryu_dir(), configured);
    let _managed_lock = crate::sidecar::gateway::lock_managed_node_env();
    assert!(!crate::sidecar::control_plane::is_managed_node());
    assert!(crate::sidecar::control_plane::registered_org().is_none());
    let directory = tempfile::tempdir().unwrap();
    // The real production handlers and durable workflow/Git stores. Identity is
    // inserted at the post-verification seam; no auth/JWT network is simulated.
    let router = Router::new()
        .route("/workflows", post(create_workflow))
        .route("/workflows/:id", get(get_workflow))
        .route(
            "/workflows/:id/versions",
            get(list_workflow_versions).post(create_workflow_version),
        )
        .route(
            "/workflows/:id/versions/:version_id",
            get(get_workflow_version),
        )
        .layer(Extension(None::<crate::identity_verify::VerifiedCaller>))
        .with_state(handler_state(directory.path()));
    let id = format!("revision-proof-{}", uuid::Uuid::new_v4());
    let path = format!("/workflows/{id}");
    let (status, saved) = request(
        &router,
        "POST",
        "/workflows",
        json!({"id": id, "name":"A", "nodes":[], "edges":[]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let revision_a = saved["workflow"]["updated_at"].as_str().unwrap().to_owned();
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    let mut next = saved["workflow"].clone();
    next["name"] = json!("B");
    let (status, saved) = request(&router, "POST", "/workflows", next).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let draft_b = saved["workflow"].clone();
    let revision_b = draft_b["updated_at"].as_str().unwrap();
    assert_ne!(revision_a, revision_b);
    let versions_path = format!("{path}/versions");
    let (status, before) = request(&router, "GET", &versions_path, json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    let (status, conflict) = request(
        &router,
        "POST",
        &versions_path,
        json!({"label":"stale A", "expectedRevision":revision_a}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        conflict,
        json!({"success":false, "code":"workflow_revision_conflict", "error":"workflow revision conflict: it was changed since it was saved", "current_updated_at":revision_b})
    );
    assert_eq!(
        request(&router, "GET", &versions_path, json!(null)).await,
        (StatusCode::OK, before)
    );
    assert_eq!(
        request(&router, "GET", &path, json!(null)).await,
        (StatusCode::OK, json!({"workflow":draft_b}))
    );
    for body in [
        json!({"label":"expected B", "expectedRevision":revision_b}),
        json!({"label":"legacy omission"}),
    ] {
        let (status, result) = request(&router, "POST", &versions_path, body.clone()).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        let version_path = format!(
            "{versions_path}/{}",
            result["version"]["id"].as_str().unwrap()
        );
        let (status, snapshot) = request(&router, "GET", &version_path, json!(null)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(snapshot["version"]["workflow"], draft_b);
        assert_eq!(snapshot["version"]["label"], body["label"]);
    }
    let (_, before_denial) = request(&router, "GET", &versions_path, json!(null)).await;
    struct RestoreManagedNode(Option<std::ffi::OsString>);
    impl Drop for RestoreManagedNode {
        fn drop(&mut self) {
            match &self.0 {
                Some(value) => std::env::set_var("RYU_MANAGED_NODE", value),
                None => std::env::remove_var("RYU_MANAGED_NODE"),
            }
        }
    }
    let restore_managed_node = RestoreManagedNode(std::env::var_os("RYU_MANAGED_NODE"));
    std::env::set_var("RYU_MANAGED_NODE", "1");
    let denied = request(
        &router,
        "POST",
        &versions_path,
        json!({"label":"forbidden", "expectedRevision":revision_b}),
    )
    .await;
    drop(restore_managed_node);
    assert_eq!(
        denied,
        (
            StatusCode::FORBIDDEN,
            json!({"error":"insufficient permissions: workflow.edit"})
        )
    );
    assert_eq!(
        request(&router, "GET", &versions_path, json!(null)).await,
        (StatusCode::OK, before_denial)
    );
}

pub(super) fn handler_state(directory: &std::path::Path) -> ServerState {
    use std::sync::Arc;
    use tokio::sync::{Mutex, RwLock};

    let manager = crate::sidecar::SidecarManager::new_noop();
    let agents = Arc::new(crate::sidecar::adapters::AcpAgentRegistry::new());
    let client = reqwest::Client::new();
    ServerState {
        setup: Arc::new(crate::sidecar::onboarding::SetupManager::new()),
        manager,
        install_status: Arc::new(crate::sidecar::install_state::InstallStatusStore::new()),
        catalog: Arc::new(crate::catalog::CatalogManager::new()),
        client: client.clone(),
        auth: Arc::new(Mutex::new(crate::auth::AuthState::new())),
        agent_store: crate::agents::AgentStore::open(&agents).expect("durable agent store"),
        agents,
        safe_actions: crate::safe_actions::SafeActionsService::new(
            crate::safe_actions::SafeActionsStore::open_in_memory().unwrap(),
        ),
        conversations: super::conversations::ConversationStore::open_in_memory().unwrap(),
        memory: ryu_memory::MemoryStore::open_in_memory().unwrap(),
        mcp: Arc::new(crate::sidecar::mcp::McpRegistry::empty()),
        spaces: ryu_spaces::SpaceStore::open_in_memory().unwrap(),
        media: super::media::MediaStore::open(directory.join("media")).unwrap(),
        gateway: Arc::new(crate::sidecar::gateway::GatewayManager::new()),
        headroom: Arc::new(crate::sidecar::headroom::HeadroomManager::new()),
        retrieval: ryu_rag::RetrievalStore::open_in_memory(8, "fixture".into()).unwrap(),
        worktree_diffs: Arc::new(Mutex::new(std::collections::HashMap::new())),
        app_manifests: Arc::new(RwLock::new(Vec::new())),
        incompatible_manifests: Arc::new(RwLock::new(Vec::new())),
        app_store: crate::plugins::PluginStore::open_in_memory().unwrap(),
        catalog_client: Arc::new(crate::plugins::catalog::PluginCatalogClient::new()),
        skills: ryu_skills::SkillRegistry::empty(),
        app_contrib: crate::plugins::app_contrib::AppContribRegistry::new(),
        plugin_runtime: crate::plugins::runtime::PluginRuntime::new(),
        traces: ryu_tracing::TraceStore::open_in_memory().unwrap(),
        preferences: super::preferences::PreferencesStore::open(directory.join("preferences.db"))
            .unwrap(),
        subscription_costs: None,
        support_audit: crate::support_access::SupportAccessStore::open_in_memory().unwrap(),
        catalog_sources: Arc::new(crate::catalog_source::CatalogSourceRegistry::new()),
        downloads: crate::downloads::DownloadCenter::with_default_client(),
        approvals: crate::approvals::ApprovalEngine::new(
            crate::approvals::store::ApprovalStore::open_in_memory().unwrap(),
            client,
        ),
        activity: ryu_activity::ActivityStore::open(directory.join("activity.db")).unwrap(),
        mesh: ryu_mesh::MeshHandle::new(),
        connections: crate::connections::ConnectionRegistry::new(),
        hardware: ryu_hardware::DeviceStore::open(directory.join("hardware.db")).unwrap(),
        realtime: ryu_realtime::RoomRegistry::new(),
        collab: ryu_collab::DocRegistry::new(Arc::new(
            ryu_collab::CollabStore::open_in_memory().unwrap(),
        )),
        experience: ryu_learning::ExperienceStore::open(directory.join("experience.db")).unwrap(),
        improvements: ryu_improvement::ImprovementStore::open_in_memory().unwrap(),
        agent_ui_templates: super::agent_ui_templates::AgentUiTemplateStore::open_in_memory()
            .unwrap(),
        node_token: None,
    }
}
