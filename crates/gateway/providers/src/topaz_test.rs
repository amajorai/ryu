//! Tests for the Topaz adapter.
use super::*;
use crate::test_support::{MockResponse, MockServer};

const ID: &str = "17f20503-6c24-4c16-946b-35dbbce2af2f";

fn body() -> Value {
    json!({
        "source": {
            "container": "mp4",
            "external": {
                "provider": "s3",
                "presignedUrl": "https://media.example.com/source.mp4?signature=opaque"
            }
        },
        "filters": [{"model": "apo-8", "slowmo": 1}],
        "output": {"resolution": {"width": 1920, "height": 1080}}
    })
}

fn provider(server: &MockServer, keys: Vec<String>) -> TopazProvider {
    TopazProvider::new(
        reqwest::Client::new(),
        None,
        keys,
        server.base_url().to_owned(),
        Arc::new(ProviderQuotas::new()),
    )
}

#[test]
fn express_request_requires_a_presigned_external_source_and_exact_model() {
    let payload = express_payload("apo-8", &body()).unwrap();
    assert_eq!(payload["source"]["external"]["provider"], "s3");
    assert_eq!(payload["filters"][0]["model"], "apo-8");
    let mut alternate_container = body();
    alternate_container["source"]["container"] = "avi".into();
    assert!(express_payload("apo-8", &alternate_container).is_ok());
    assert!(express_payload("other", &body()).is_err());
    let mut missing = body();
    missing["source"]
        .as_object_mut()
        .unwrap()
        .remove("external");
    assert!(express_payload("apo-8", &missing).is_err());
    let mut http = body();
    http["source"]["external"]["presignedUrl"] = "http://localhost/private".into();
    assert!(express_payload("apo-8", &http).is_err());
    let mut webhook = body();
    webhook["notifications"] = json!({"webhookUrl":"https://example.com/hook"});
    assert!(express_payload("apo-8", &webhook).is_err());
}

#[tokio::test]
async fn express_submission_and_status_poll_keep_the_accepted_account() {
    let server = MockServer::start(vec![
        MockResponse::json(429, "{}").with_header("retry-after", "60"),
        MockResponse::ok_json(&format!(r#"{{"requestId":"{ID}"}}"#)),
        MockResponse::ok_json(r#"{"status":"processing","progress":40}"#),
        MockResponse::ok_json(r#"{"status":"complete","download":{"url":"https://media.example.com/output.mp4?signature=opaque"}}"#),
    ])
    .await;
    let provider = provider(&server, vec!["first-key".into(), "second-key".into()]);
    let accepted = provider.submit_video_bound("apo-8", &body()).await.unwrap();
    assert_eq!(accepted.initial.status, JobStatus::Queued);
    assert_eq!(
        accepted.origin.poll().await.unwrap().status,
        JobStatus::Running
    );
    let complete = accepted.origin.poll().await.unwrap();
    assert_eq!(complete.status, JobStatus::Succeeded);
    assert_eq!(
        complete.output.unwrap()["data"][0]["url"],
        "https://media.example.com/output.mp4?signature=opaque"
    );
    let requests = server.requests();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0].path, "/video/express");
    assert_eq!(requests[1].path, "/video/express");
    assert_eq!(requests[2].path, format!("/video/{ID}/status"));
    assert_eq!(
        requests[0].header("x-api-key").as_deref(),
        Some("first-key")
    );
    assert!(requests[1..]
        .iter()
        .all(|request| request.header("x-api-key").as_deref() == Some("second-key")));
    let sent: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(sent["source"]["container"], "mp4");
    assert!(sent.get("model").is_none());
}

#[test]
fn terminal_status_requires_a_signed_download_and_hides_upstream_errors() {
    assert!(job_from_status(&json!({"status":"complete"}), "ref").is_err());
    let failure = job_from_status(
        &json!({"status":"failed","message":"secret source URL","errorCode":"PROCESSING_FAILURE"}),
        "ref",
    )
    .unwrap();
    assert_eq!(failure.status, JobStatus::Failed);
    assert!(!failure.error.unwrap().contains("secret source URL"));
}

#[tokio::test]
async fn model_discovery_uses_the_public_system_status_catalog() {
    let server = MockServer::start(vec![MockResponse::ok_json(
        r#"{"isAvailable":true,"supportedModels":["apo-8","prob-4","apo-8"]}"#,
    )])
    .await;
    let topaz = provider(&server, vec!["first-key".into()]);
    let models = topaz.discover_models().await.unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[0]["id"], "apo-8");
    assert_eq!(models[1]["id"], "prob-4");
    let requests = server.requests();
    assert_eq!(requests[0].path, "/video/status");
    assert!(requests[0].header("x-api-key").is_none());
    assert!(system_models(&json!({"supportedModels":["bad/model"]})).is_none());
    let unavailable = MockServer::always(MockResponse::json(503, "{}")).await;
    assert!(provider(&unavailable, vec!["first-key".into()])
        .discover_models()
        .await
        .is_none());
}

#[tokio::test]
async fn a_single_key_refused_for_credit_serves_again_once_refilled() {
    let server = MockServer::start(vec![
        MockResponse::json(402, "{}"),
        MockResponse::ok_json(&format!(r#"{{"requestId":"{ID}"}}"#)),
    ])
    .await;
    let provider = provider(&server, vec!["only".into()]);
    let refused = provider.submit_video_bound("apo-8", &body()).await;
    assert!(matches!(
        refused,
        Err(ProviderError::PaymentRequired { .. })
    ));
    provider.submit_video_bound("apo-8", &body()).await.unwrap();
    assert_eq!(server.requests().len(), 2);
}
