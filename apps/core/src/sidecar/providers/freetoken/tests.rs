use super::*;
use crate::sidecar::{HealthStatus, Sidecar};
use axum::{http::StatusCode, routing::get, Json, Router};
use serde_json::json;

async fn server(
    health: serde_json::Value,
    models: serde_json::Value,
    status: StatusCode,
) -> (FreeTokenManager, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route("/health", get(move || async move { Json(health) }))
        .route(
            "/v1/models",
            get(move || async move { (status, Json(models)) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut manager = FreeTokenManager::new();
    manager.base_url = format!("http://{}", listener.local_addr().unwrap());
    // Protocol fixture simulates a supported node; it does not claim CUDA inference.
    manager.supported = true;
    manager.client = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (manager, task)
}
fn models() -> serde_json::Value {
    json!({"object":"list","data":[{"id":"Qwen3.6-35B-A3B","object":"model","owned_by":"FreeToken","root":"/private/models/qwen","context_length":32768}]})
}

#[tokio::test]
async fn freetoken_adopts_only_ready_server_and_detaches_without_stopping_it() {
    let (manager, task) = server(
        json!({"status":"ok","maintenance":"serving","version":"1.0"}),
        models(),
        StatusCode::OK,
    )
    .await;
    assert!(!manager.is_required());
    assert!(!manager.is_running());
    manager.start().await.unwrap();
    assert!(manager.is_running());
    assert!(matches!(
        manager.health_check().await,
        HealthStatus::Healthy
    ));
    manager.stop().await.unwrap();
    assert!(!manager.is_running());
    assert!(matches!(
        manager.health_check().await,
        HealthStatus::Unhealthy(_)
    ));
    manager.ensure_available().await.unwrap();
    assert!(!manager.is_running());
    manager.start().await.unwrap();
    task.abort();
    let _ = task.await;
    assert!(matches!(
        manager.health_check().await,
        HealthStatus::Unhealthy(_)
    ));
    assert!(!manager.is_running());
}

#[tokio::test]
async fn freetoken_rejects_loading_failed_and_maintenance_states() {
    for health in [
        json!({"status":"loading","progress":{"done_bytes":1,"total_bytes":100}}),
        json!({"status":"error","message":"worker exited"}),
        json!({"status":"ok","maintenance":"rebuilding"}),
        json!({"status":"ok","maintenance":"failed"}),
    ] {
        let (manager, task) = server(health, models(), StatusCode::OK).await;
        assert!(manager.start().await.is_err());
        assert!(!manager.is_running());
        task.abort();
    }
}

#[tokio::test]
async fn freetoken_rejects_auth_errors_redirects_and_unrelated_model_servers() {
    for (body, status) in [
        (models(), StatusCode::UNAUTHORIZED),
        (models(), StatusCode::TEMPORARY_REDIRECT),
        (json!({"data":[]}), StatusCode::OK),
        (
            json!({"data":[{"id":"other","owned_by":"another-server"}]}),
            StatusCode::OK,
        ),
        (json!({"unexpected":true}), StatusCode::OK),
    ] {
        let (manager, task) = server(json!({"status":"ok"}), body, status).await;
        assert!(manager.start().await.is_err());
        task.abort();
    }
}

#[tokio::test]
async fn freetoken_projects_only_unique_served_ids_without_local_paths() {
    let (manager, task) = server(json!({"status":"ok"}), json!({"data":[{"id":"qwen","owned_by":"FreeToken","root":"/private/models/qwen"},{"id":"qwen","owned_by":"freetoken"},{"id":"","owned_by":"FreeToken"},{"id":"other","owned_by":"different"}]}), StatusCode::OK).await;
    let models = manager.chat_models().await.unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].id, "qwen");
    assert_eq!(models[0].name, "qwen");
    assert!(!serde_json::to_string(&models).unwrap().contains("/private"));
    task.abort();
}

#[tokio::test]
async fn freetoken_platform_gate_precedes_network_access() {
    let mut manager = FreeTokenManager::new();
    manager.supported = false;
    assert!(manager
        .start()
        .await
        .unwrap_err()
        .to_string()
        .contains("no native macOS"));
    assert!(manager.install().await.is_err());
    assert!(manager.chat_models().await.is_err());
}

#[test]
fn freetoken_catalog_platforms_and_urls_agree() {
    use crate::sidecar::active_engine::*;
    assert!(is_local_engine(ENGINE_NAME));
    assert_eq!(
        local_engine_base_url(ENGINE_NAME).as_deref(),
        Some(BASE_URL)
    );
    assert_eq!(
        local_engine_url(ENGINE_NAME).as_deref(),
        Some("http://127.0.0.1:1919/v1")
    );
    assert_eq!(
        crate::catalog::registry::required_platforms(ENGINE_NAME),
        &["linux", "windows"]
    );
    let expected =
        cfg!(target_arch = "x86_64") && (cfg!(target_os = "linux") || cfg!(target_os = "windows"));
    assert_eq!(
        crate::catalog::registry::supported_on_node(ENGINE_NAME),
        expected
    );
    assert_eq!(FreeTokenManager::new().supported, expected);
}
