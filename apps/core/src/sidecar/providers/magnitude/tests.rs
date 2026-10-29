use super::*;
use crate::sidecar::{HealthStatus, Sidecar};
use axum::{http::StatusCode, routing::get, Router};
use serde_json::json;

async fn server(
    health: StatusCode,
    models: serde_json::Value,
    status: StatusCode,
) -> (MagnitudeManager, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route("/health", get(move || async move { health }))
        .route(
            "/inference/v1/models",
            get(move || async move { (status, axum::Json(models)) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut manager = MagnitudeManager::new();
    // Close every fixture connection so aborting the listener models a fully
    // stopped service, rather than leaving Axum's keep-alive tasks reachable.
    manager.client = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap();
    manager.base_url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (manager, task)
}

#[tokio::test]
async fn magnitude_adopts_and_detaches_without_stopping_external_server() {
    let (manager, task) = server(StatusCode::OK, json!({"data":[]}), StatusCode::OK).await;
    assert_eq!(manager.name(), "magnitude");
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
async fn magnitude_rejects_unhealthy_auth_required_and_unrelated_servers() {
    for (health, status, models) in [
        (
            StatusCode::SERVICE_UNAVAILABLE,
            StatusCode::OK,
            json!({"data":[]}),
        ),
        (
            StatusCode::OK,
            StatusCode::UNAUTHORIZED,
            json!({"error":"unauthorized"}),
        ),
        (StatusCode::OK, StatusCode::OK, json!({"unexpected":true})),
    ] {
        let (manager, task) = server(health, models, status).await;
        let error = format!("{:#}", manager.start().await.unwrap_err());
        assert!(error.contains("Install Magnitude"));
        assert!(!manager.is_running());
        task.abort();
    }
}

#[tokio::test]
async fn magnitude_discovers_unique_model_ids() {
    let (manager, task) = server(
        StatusCode::OK,
        json!({"data":[
            {"id":"qwen3.6-35b-a3b", "object":"model"},
            {"id":" qwen3.6-35b-a3b "},
            {"id":"gemma-4-12b"},
            {"id":" "}
        ]}),
        StatusCode::OK,
    )
    .await;
    let models = manager.chat_models().await.unwrap();
    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["qwen3.6-35b-a3b", "gemma-4-12b"]
    );
    task.abort();
}

#[test]
fn magnitude_engine_registration_and_urls_agree() {
    use crate::sidecar::active_engine::*;
    assert!(is_local_engine(ENGINE_NAME));
    assert_eq!(
        local_engine_base_url(ENGINE_NAME).as_deref(),
        Some(BASE_URL)
    );
    assert_eq!(
        local_engine_url(ENGINE_NAME).as_deref(),
        Some("http://127.0.0.1:10100/inference/v1")
    );
    let entry = crate::catalog::registry::static_registry()
        .into_iter()
        .find(|entry| entry.name == ENGINE_NAME)
        .unwrap();
    assert_eq!(entry.display_name, "Magnitude");
    assert!(!entry.recommended);
}
