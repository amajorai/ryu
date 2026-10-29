//! Tests for the MiniMax adapter.
use super::*;
use crate::test_support::{MockResponse, MockServer};
fn provider(server: &MockServer) -> MiniMaxProvider {
    MiniMaxProvider::new(
        reqwest::Client::new(),
        None,
        vec!["first".into(), "second".into()],
        server.base_url().into(),
        Arc::new(ProviderQuotas::new()),
    )
}
#[tokio::test]
async fn body_quota_errors_rotate_and_native_base64_is_normalized() {
    let server = MockServer::start(vec![
        MockResponse::ok_json(r#"{"base_resp":{"status_code":1002}}"#),
        MockResponse::ok_json(
            r#"{"base_resp":{"status_code":0},"data":{"image_base64":["aW1hZ2U="]}}"#,
        ),
    ])
    .await;
    let p = provider(&server);
    let result = p.generate_image("image-01", &json!({"prompt":"Tree", "response_format":"b64_json", "size":"1024x768", "seed":42, "prompt_optimizer":true})).await.unwrap();
    assert_eq!(result["data"][0]["b64_json"], "aW1hZ2U=");
    assert!(result["created"].is_u64());
    assert_ne!(p.quota.snapshot()["minimax"]["rate_limited"], json!(true));
    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].header("authorization").as_deref(),
        Some("Bearer first")
    );
    assert_eq!(
        requests[1].header("authorization").as_deref(),
        Some("Bearer second")
    );
    assert_eq!(requests[1].path, "/image_generation");
    let wire: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(wire["response_format"], "base64");
    assert_eq!(wire["width"], 1024);
    assert_eq!(wire["height"], 768);
    assert_eq!(wire["seed"], 42);
    assert_eq!(wire["prompt_optimizer"], true);
    assert!(wire.get("size").is_none());
}
#[tokio::test]
async fn balance_errors_rotate_and_urls_support_multiple_images() {
    let server = MockServer::start(vec![
        MockResponse::ok_json(r#"{"base_resp":{"status_code":1008}}"#),
        MockResponse::ok_json(r#"{"base_resp":{"status_code":0},"data":{"image_urls":["https://assets.example/1.jpg","https://assets.example/2.jpg"]}}"#),
    ]).await;
    let p = provider(&server);
    let result = p
        .generate_image(
            "image-01",
            &json!({"prompt":"Tree", "n":2, "aspect_ratio":"16:9"}),
        )
        .await
        .unwrap();
    assert_eq!(result["data"].as_array().unwrap().len(), 2);
    assert_eq!(server.requests().len(), 2);
}
#[tokio::test]
async fn ambiguous_execution_and_moderation_never_rotate() {
    for response in [
        r#"{"base_resp":{"status_code":1001}}"#,
        r#"{"base_resp":{"status_code":0},"data":{"image_urls":[]}}"#,
        r#"{"data":{"image_urls":["https://assets.example/1.jpg"]}}"#,
    ] {
        let server = MockServer::always(MockResponse::ok_json(response)).await;
        assert!(matches!(
            provider(&server)
                .generate_image("image-01", &json!({"prompt":"Tree"}))
                .await,
            Err(ProviderError::DeliveryUncertain(_))
        ));
        assert_eq!(server.requests().len(), 1);
    }
    let server = MockServer::always(MockResponse::ok_json(
        r#"{"base_resp":{"status_code":1026,"status_msg":"private echoed input"}}"#,
    ))
    .await;
    let error = provider(&server)
        .generate_image("image-01", &json!({"prompt":"Tree"}))
        .await
        .unwrap_err();
    assert!(!error.to_string().contains("private echoed input"));
    assert_eq!(server.requests().len(), 1);
}
#[tokio::test]
async fn validates_inputs_and_honors_account_policy_on_assigned_proxy() {
    let server = MockServer::always(MockResponse::ok_json("{}")).await;
    let p = provider(&server);
    for body in [
        json!({"prompt":""}),
        json!({"prompt":"x".repeat(1501)}),
        json!({"prompt":"Tree","n":10}),
        json!({"prompt":"Tree","width":1024}),
        json!({"prompt":"Tree","size":"513x1024"}),
        json!({"prompt":"Tree","aspect_ratio":"5:7"}),
        json!({"prompt":"Tree","seed":1.5}),
        json!({"prompt":"Tree","prompt_optimizer":"yes"}),
    ] {
        assert!(p.generate_image("image-01", &body).await.is_err());
    }
    assert!(server.requests().is_empty());
    let proxy = MockServer::always(MockResponse::ok_json(
        r#"{"base_resp":{"status_code":0},"data":{"image_urls":["https://assets.example/1.jpg"]}}"#,
    ))
    .await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::all(proxy.base_url()).unwrap())
        .build()
        .unwrap();
    let p = MiniMaxProvider::new(
        reqwest::Client::new(),
        Some(Arc::new(EgressClientPool::new(vec![client]).unwrap())),
        vec!["disabled".into(), "preferred".into()],
        "http://unreachable.invalid/v1".into(),
        Arc::new(ProviderQuotas::new()),
    );
    p.configure_account_policies(&[
        crate::ProviderAccountPolicy {
            enabled: false,
            ..Default::default()
        },
        crate::ProviderAccountPolicy::default(),
    ]);
    p.generate_image("image-01", &json!({"prompt":"Tree"}))
        .await
        .unwrap();
    assert_eq!(proxy.requests().len(), 1);
    assert_eq!(
        proxy.requests()[0].header("authorization").as_deref(),
        Some("Bearer preferred")
    );
    assert_eq!(p.discover_models().await.unwrap()[0]["modality"], "image");
}
#[tokio::test]
async fn a_single_key_refused_for_balance_serves_again_once_refilled() {
    for refusal in [
        MockResponse::json(402, "{}"),
        MockResponse::ok_json(r#"{"base_resp":{"status_code":1008}}"#),
    ] {
        let server = MockServer::start(vec![
            refusal,
            MockResponse::ok_json(r#"{"base_resp":{"status_code":0},"data":{"image_urls":["https://assets.example/1.jpg"]}}"#),
        ])
        .await;
        let p = MiniMaxProvider::new(
            reqwest::Client::new(),
            None,
            vec!["only".into()],
            server.base_url().into(),
            Arc::new(ProviderQuotas::new()),
        );
        let body = json!({"prompt":"Tree"});
        let refused = p.generate_image("image-01", &body).await;
        assert!(matches!(
            refused,
            Err(ProviderError::PaymentRequired { .. })
        ));
        p.generate_image("image-01", &body).await.unwrap();
        assert_eq!(server.requests().len(), 2);
    }
}
