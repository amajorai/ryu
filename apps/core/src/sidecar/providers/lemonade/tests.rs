use super::*;
use crate::sidecar::{HealthStatus, Sidecar};
use axum::{http::StatusCode, routing::get, Json, Router};
use serde_json::json;

async fn server(
    health: serde_json::Value,
    models: serde_json::Value,
    status: StatusCode,
) -> (LemonadeManager, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route("/v1/health", get(move || async move { Json(health) }))
        .route(
            "/v1/models",
            get(move || async move { (status, Json(models)) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut manager = LemonadeManager::new();
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
async fn lemonade_adopts_and_detaches_without_stopping_external_server() {
    let (manager, task) = server(
        json!({"status":"ok", "version":"11.9.0"}),
        json!({"data":[]}),
        StatusCode::OK,
    )
    .await;
    assert_eq!(manager.name(), "lemonade");
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
async fn lemonade_rejects_unrelated_unhealthy_and_auth_required_servers() {
    for (health, status, models) in [
        (json!({"status":"ok"}), StatusCode::OK, json!({"data":[]})),
        (
            json!({"status":"error", "version":"11"}),
            StatusCode::OK,
            json!({"data":[]}),
        ),
        (
            json!({"status":"ok", "version":"11"}),
            StatusCode::UNAUTHORIZED,
            json!({"error":"unauthorized"}),
        ),
        (
            json!({"status":"ok", "version":"11"}),
            StatusCode::OK,
            json!({"unexpected":true}),
        ),
    ] {
        let (manager, task) = server(health, models, status).await;
        let error = manager.start().await.unwrap_err().to_string();
        assert!(error.contains("Install and start Lemonade"));
        assert!(!manager.is_running());
        task.abort();
    }
}

#[tokio::test]
async fn lemonade_discovers_unique_downloaded_chat_models_only() {
    let (manager, task) = server(json!({"status":"ok", "version":"11"}), json!({"data":[
        {"id":"Qwen3-0.6B-GGUF", "recipe":"llamacpp", "labels":["reasoning"], "downloaded":true},
        {"id":" Qwen3-0.6B-GGUF ", "labels":["chat"]},
        {"id":"Hybrid", "recipe":"oga", "labels":["vision"]},
        {"id":"FutureBackend", "recipe":"new", "labels":["chat"]},
        {"id":"NotDownloaded", "labels":["chat"], "downloaded":false},
        {"id":"Embed", "recipe":"llamacpp", "labels":["embeddings"]},
        {"id":"LegacyEmbed", "recipe":"llamacpp", "embedding":true},
        {"id":"Rank", "recipe":"llamacpp", "reranking":true},
        {"id":"Image", "recipe":"sd-cpp"},
        {"id":"Voice", "recipe":"kokoro", "labels":["tts"]},
        {"id":" ", "labels":["chat"]}
    ]}), StatusCode::OK).await;
    let models = manager.chat_models().await.unwrap();
    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        vec!["Qwen3-0.6B-GGUF", "Hybrid", "FutureBackend"]
    );
    task.abort();
}

#[test]
fn lemonade_engine_registration_and_urls_agree() {
    use crate::sidecar::active_engine::*;
    assert!(is_local_engine(ENGINE_NAME));
    assert_eq!(
        local_engine_base_url(ENGINE_NAME).as_deref(),
        Some(BASE_URL)
    );
    assert_eq!(
        local_engine_url(ENGINE_NAME).as_deref(),
        Some("http://127.0.0.1:13305/v1")
    );
    let entry = crate::catalog::registry::static_registry()
        .into_iter()
        .find(|entry| entry.name == ENGINE_NAME)
        .unwrap();
    assert_eq!(entry.display_name, "Lemonade Server");
    assert!(!entry.recommended);
}
