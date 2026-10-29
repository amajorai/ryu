use super::*;
use crate::sidecar::{HealthStatus, Sidecar};
use axum::{http::StatusCode, routing::get, Json, Router};
use serde_json::json;

async fn server(
    health: &'static str,
    models: serde_json::Value,
    status: StatusCode,
) -> (LlamaSwapManager, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route("/health", get(move || async move { health }))
        .route(
            "/v1/models",
            get(move || async move { (status, Json(models)) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut manager = LlamaSwapManager::new();
    manager.base_url = format!("http://{}", listener.local_addr().unwrap());
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

#[tokio::test]
async fn llama_swap_adopts_detaches_and_detects_server_exit() {
    let (manager, task) = server("OK", json!({"data": []}), StatusCode::OK).await;
    assert_eq!(manager.name(), "llama-swap");
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
async fn llama_swap_rejects_unhealthy_or_inaccessible_api() {
    for (health, models, status) in [
        ("not ready", json!({"data":[]}), StatusCode::OK),
        (
            "OK",
            json!({"error":"unauthorized"}),
            StatusCode::UNAUTHORIZED,
        ),
        ("OK", json!({"unexpected":true}), StatusCode::OK),
    ] {
        let (manager, task) = server(health, models, status).await;
        assert!(manager
            .start()
            .await
            .unwrap_err()
            .to_string()
            .contains("--listen 127.0.0.1:9292"));
        assert!(!manager.is_running());
        task.abort();
    }
}

#[tokio::test]
async fn llama_swap_discovers_configured_ids_names_and_modalities() {
    let (manager, task) = server("OK", json!({"data":[
        {"id":"small","name":"Small chat"},
        {"id":"small","name":"Duplicate"},
        {"id":" large ","name":" ","architecture":{"input_modalities":["text","image"],"output_modalities":["text"]}},
        {"id":"image","architecture":{"output_modalities":["image"]}},
        {"id":"tts","architecture":{"output_modalities":["audio"]}},
        {"id":"stt","architecture":{"input_modalities":["audio"],"output_modalities":["text"]}},
        {"id":"rank","capabilities":{"reranker":true}},
        {"id":" ","name":"Empty ID"}
    ]}), StatusCode::OK).await;
    let models = manager.chat_models().await.unwrap();
    assert_eq!(
        models
            .iter()
            .map(|m| (m.id.as_str(), m.name.as_str()))
            .collect::<Vec<_>>(),
        vec![("small", "Small chat"), ("large", "large")]
    );
    task.abort();
}

#[test]
fn llama_swap_catalog_and_route_urls_agree() {
    use crate::sidecar::active_engine::*;
    assert!(is_local_engine(ENGINE_NAME));
    assert_eq!(
        local_engine_base_url(ENGINE_NAME).as_deref(),
        Some(BASE_URL)
    );
    assert_eq!(
        local_engine_url(ENGINE_NAME).as_deref(),
        Some("http://127.0.0.1:9292/v1")
    );
    assert_ne!(
        local_engine_base_url(ENGINE_NAME),
        local_engine_base_url("llamacpp")
    );
    let entry = crate::catalog::registry::static_registry()
        .into_iter()
        .find(|e| e.name == ENGINE_NAME)
        .unwrap();
    assert!(!entry.recommended);
    assert_eq!(entry.display_name, "llama-swap");
}
