//! Tests for the Stability adapter.
use super::*;
use crate::test_support::{MockResponse, MockServer};
fn png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh2sAAAAASUVORK5CYII=").unwrap()
}
fn provider(server: &MockServer, keys: Vec<String>) -> StabilityProvider {
    StabilityProvider::new(
        reqwest::Client::new(),
        None,
        keys,
        format!("{}/v2beta", server.base_url()),
        Arc::new(ProviderQuotas::new()),
    )
}
#[tokio::test]
async fn multipart_sd35_maps_options_and_normalizes_real_png_bytes() {
    let server = MockServer::always(MockResponse::ok_bytes("image/png", png())).await;
    let p = provider(&server, vec!["key".into()]);
    let result = p.generate_image("sd3.5-large",&json!({"prompt":"A tree","size":"1536x1024","negative_prompt":"blur","seed":42,"cfg_scale":4,"style_preset":"photographic","response_format":"b64_json"})).await.unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(result["data"][0]["b64_json"].as_str().unwrap())
            .unwrap(),
        png()
    );
    let req = &server.requests()[0];
    assert_eq!(req.path, "/v2beta/stable-image/generate/sd3");
    assert_eq!(req.header("authorization").as_deref(), Some("Bearer key"));
    assert_eq!(req.header("accept").as_deref(), Some("image/*"));
    assert!(req
        .header("content-type")
        .unwrap()
        .starts_with("multipart/form-data; boundary="));
    let wire = String::from_utf8_lossy(&req.body);
    for value in [
        "sd3.5-large",
        "text-to-image",
        "3:2",
        "photographic",
        "blur",
        "42",
    ] {
        assert!(wire.contains(value), "{value}");
    }
}
#[tokio::test]
async fn quota_and_credit_rejections_rotate_before_acceptance() {
    let server = MockServer::start(vec![
        MockResponse::json(429, "{}"),
        MockResponse::json(402, "{}"),
        MockResponse::ok_bytes("image/png", png()),
    ])
    .await;
    let p = provider(
        &server,
        vec!["limited".into(), "empty".into(), "healthy".into()],
    );
    p.generate_image("stable-image-ultra", &json!({"prompt":"A tree"}))
        .await
        .unwrap();
    assert_eq!(
        server
            .requests()
            .iter()
            .map(|r| r.header("authorization").unwrap())
            .collect::<Vec<_>>(),
        vec!["Bearer limited", "Bearer empty", "Bearer healthy"]
    );
    assert_ne!(p.quota.snapshot()["stability"]["rate_limited"], json!(true));
}
#[tokio::test]
async fn invalid_accepted_image_never_replays_to_another_account() {
    let server = MockServer::always(MockResponse::ok_bytes(
        "image/png",
        b"not an image".to_vec(),
    ))
    .await;
    let p = provider(&server, vec!["first".into(), "second".into()]);
    assert!(matches!(
        p.generate_image("stable-image-core", &json!({"prompt":"A tree"}))
            .await,
        Err(ProviderError::DeliveryUncertain(_))
    ));
    assert_eq!(server.requests().len(), 1);
}
#[tokio::test]
async fn selected_account_uses_assigned_proxy() {
    let proxy = MockServer::always(MockResponse::ok_bytes("image/png", png())).await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::all(proxy.base_url()).unwrap())
        .build()
        .unwrap();
    let pool = Arc::new(EgressClientPool::new(vec![client]).unwrap());
    let p = StabilityProvider::new(
        reqwest::Client::new(),
        Some(pool),
        vec!["off".into(), "selected".into()],
        "http://unreachable.invalid/v2beta".into(),
        Arc::new(ProviderQuotas::new()),
    );
    p.configure_account_policies(&[
        crate::ProviderAccountPolicy {
            enabled: false,
            ..Default::default()
        },
        crate::ProviderAccountPolicy::default(),
    ]);
    p.generate_image("stable-image-core", &json!({"prompt":"A tree"}))
        .await
        .unwrap();
    assert_eq!(proxy.requests().len(), 1);
    assert_eq!(
        proxy.requests()[0].header("authorization").as_deref(),
        Some("Bearer selected")
    );
}
#[test]
fn invalid_requests_are_rejected_before_generation() {
    for body in [
        json!({"prompt":"tree","n":2}),
        json!({"prompt":"tree","response_format":"url"}),
        json!({"prompt":"tree","seed":4294967295u64}),
        json!({"prompt":"tree","size":"1024x1024","aspect_ratio":"16:9"}),
        json!({"prompt":"tree","image_url":"http://private.invalid"}),
        json!({"prompt":"x".repeat(10001)}),
    ] {
        assert!(StabilityProvider::request_fields("sd3.5-large", &body).is_err());
    }
    assert!(StabilityProvider::request_fields(
        "stable-image-ultra",
        &json!({"prompt":"tree","style_preset":"anime"})
    )
    .is_err());
}
#[tokio::test]
async fn a_single_key_refused_for_credit_serves_again_once_refilled() {
    let server = MockServer::start(vec![
        MockResponse::json(402, "{}"),
        MockResponse::ok_bytes("image/png", png()),
    ])
    .await;
    let p = provider(&server, vec!["only".into()]);
    let body = json!({"prompt":"A tree"});
    let refused = p.generate_image("stable-image-ultra", &body).await;
    assert!(matches!(
        refused,
        Err(ProviderError::PaymentRequired { .. })
    ));
    p.generate_image("stable-image-ultra", &body).await.unwrap();
    assert_eq!(server.requests().len(), 2);
}
