//! Tests for the Runway adapter.
#[tokio::test]
async fn captured_origin_reports_blockage_without_terminating_or_replaying() {
    let server = MockServer::start(vec![
        accepted(),
        MockResponse::json(401, r#"{"error":"origin-key raw upstream secret"}"#),
        MockResponse::json(407, "{}"),
        MockResponse::json(429, "{}").with_header("retry-after", "7"),
        MockResponse::json(503, "{}"),
        MockResponse::ok_json(r#"{"status":"unknown"}"#),
        MockResponse::ok_json(&format!(
            r#"{{"id":"{ID}","status":"FAILED","error":"origin-key raw upstream secret"}}"#
        )),
    ])
    .await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::all(server.base_url()).unwrap())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap();
    let pool = Arc::new(EgressClientPool::new(vec![client]).unwrap());
    let provider = RunwayProvider::new(
        reqwest::Client::new(),
        Some(pool),
        vec!["origin-key".into()],
        "http://origin.invalid/v1".into(),
        Arc::new(crate::ProviderQuotas::new()),
    );
    let accepted = provider
        .submit_video_bound(
            "gen4.5",
            &json!({"prompt":"video","ratio":"1280:720","duration":5}),
        )
        .await
        .unwrap();
    for expected in [
        crate::VideoPollError::CredentialRejected,
        crate::VideoPollError::TransportUnavailable,
        crate::VideoPollError::RateLimited {
            retry_after: Some(7),
        },
        crate::VideoPollError::UpstreamUnavailable,
        crate::VideoPollError::InvalidResponse,
    ] {
        let error = accepted.origin.poll().await.unwrap_err();
        assert_eq!(error, expected);
        assert!(!error.to_string().contains("origin-key"));
        assert!(!format!("{error:?}").contains("raw upstream"));
    }
    let terminal = accepted.origin.poll().await.unwrap();
    assert_eq!(terminal.status, JobStatus::Failed);
    assert!(!terminal.error.unwrap().contains("origin-key"));
    let requests = server.requests();
    assert_eq!(requests.len(), 7);
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.method == "POST")
            .count(),
        1
    );
}

#[tokio::test]
async fn captured_origin_survives_removal_endpoint_change_and_proxy_eviction() {
    let original = MockServer::start(vec![accepted(), ready()]).await;
    let replacement = MockServer::always(MockResponse::json(500, "{}")).await;
    let clients = [original.base_url(), replacement.base_url()]
        .into_iter()
        .map(|url| {
            reqwest::Client::builder()
                .no_proxy()
                .proxy(reqwest::Proxy::all(url).unwrap())
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .unwrap()
        })
        .collect();
    let pool = Arc::new(EgressClientPool::new(clients).unwrap());
    let mut provider = RunwayProvider::new(
        reqwest::Client::new(),
        Some(pool.clone()),
        vec!["origin-key".into()],
        "http://origin.invalid/v1".into(),
        Arc::new(crate::ProviderQuotas::new()),
    );
    let accepted = provider
        .submit_video_bound(
            "gen4.5",
            &json!({"prompt":"video","ratio":"1280:720","duration":5}),
        )
        .await
        .unwrap();
    assert_eq!(accepted.initial.status, JobStatus::Queued);
    provider.keys.clear();
    provider.base_url = "http://replacement.invalid/v1".into();
    for index in 0..10_010 {
        pool.candidates(Some(&format!("eviction-{index}")));
    }
    pool.record_failure(0, Some(300));
    drop(provider);
    let observed = accepted.origin.poll().await.unwrap();
    assert_eq!(observed.status, JobStatus::Succeeded);
    assert!(observed.output.is_some());
    assert!(replacement.requests().is_empty());
    let requests = original.requests();
    assert_eq!(requests.len(), 2);
    for request in requests {
        assert_eq!(
            request.header("authorization").as_deref(),
            Some("Bearer origin-key")
        );
    }
}

use super::*;
use crate::test_support::{MockResponse, MockServer};
const ID: &str = "17f20503-6c24-4c16-946b-35dbbce2af2f";
fn accepted() -> MockResponse {
    MockResponse::ok_json(&format!(r#"{{"id":"{ID}"}}"#))
}
fn ready() -> MockResponse {
    MockResponse::ok_json(&format!(
        r#"{{"id":"{ID}","status":"SUCCEEDED","output":["https://assets.example/video.mp4"]}}"#
    ))
}
fn provider(server: &MockServer, keys: Vec<String>) -> RunwayProvider {
    RunwayProvider::new(
        reqwest::Client::new(),
        None,
        keys,
        format!("{}/v1", server.base_url()),
        Arc::new(ProviderQuotas::new()),
    )
}
fn body() -> Value {
    json!({"prompt":"A tree in the wind","duration":5,"size":"1280x720"})
}
#[tokio::test]
async fn quota_rotation_and_polling_keep_the_original_account_after_reorder() {
    let server = MockServer::start(vec![
        MockResponse::json(429, "{}").with_header("retry-after", "60"),
        accepted(),
        ready(),
    ])
    .await;
    let p = provider(&server, vec!["first".into(), "second".into()]);
    let job = p.submit_fixture("gen4.5", &body()).await.unwrap();
    assert_eq!(job.status, JobStatus::Queued);
    assert_ne!(p.quota.snapshot()["runway"]["rate_limited"], json!(true));
    let reordered = provider(&server, vec!["second".into(), "first".into()]);
    reordered.configure_account_policies(&[
        crate::ProviderAccountPolicy {
            enabled: false,
            ..Default::default()
        },
        crate::ProviderAccountPolicy::default(),
    ]);
    let result = reordered
        .poll_reference_fixture(&job.provider_ref)
        .await
        .unwrap();
    assert_eq!(result.status, JobStatus::Succeeded);
    assert_eq!(
        result.output.unwrap()["data"][0]["url"],
        "https://assets.example/video.mp4"
    );
    let requests = server.requests();
    assert_eq!(requests.len(), 3);
    assert_eq!(
        requests[0].header("authorization").as_deref(),
        Some("Bearer first")
    );
    assert!(requests[1..]
        .iter()
        .all(|r| r.header("authorization").as_deref() == Some("Bearer second")));
    assert!(requests
        .iter()
        .all(|r| r.header("x-runway-version").as_deref() == Some("2024-11-06")));
    assert_eq!(requests[1].path, "/v1/text_to_video");
    assert_eq!(requests[2].path, format!("/v1/tasks/{ID}"));
    let wire: Value = serde_json::from_slice(&requests[1].body).unwrap();
    assert_eq!(wire["promptText"], body()["prompt"]);
    assert_eq!(wire["ratio"], "1280:720");
    assert!(wire.get("prompt").is_none());
    assert!(provider(&server, vec!["first".into()])
        .poll_reference_fixture(&job.provider_ref)
        .await
        .is_err());
    assert_eq!(server.requests().len(), 3);
}
#[tokio::test]
async fn image_video_and_statuses_preserve_job_identity() {
    let server = MockServer::start(vec![
        accepted(),
        MockResponse::ok_json(&format!(r#"{{"id":"{ID}","status":"THROTTLED"}}"#)),
        MockResponse::ok_json(&format!(
            r#"{{"id":"{ID}","status":"FAILED","failure":"private prompt"}}"#
        )),
    ])
    .await;
    let p = provider(&server, vec!["first".into()]);
    let job=p.submit_fixture("gen4_turbo",&json!({"promptImage":[{"uri":"https://assets.example/frame.png","position":"first"}],"ratio":"960:960"})).await.unwrap();
    assert_eq!(server.requests()[0].path, "/v1/image_to_video");
    assert_eq!(
        p.poll_reference_fixture(&job.provider_ref)
            .await
            .unwrap()
            .status,
        JobStatus::Queued
    );
    let failed = p.poll_reference_fixture(&job.provider_ref).await.unwrap();
    assert_eq!(failed.status, JobStatus::Failed);
    assert!(!failed.error.unwrap().contains("private prompt"));
}
#[tokio::test]
async fn invalid_input_and_ambiguous_submission_never_replay() {
    let server = MockServer::always(MockResponse::ok_json("{}")).await;
    let p = provider(&server, vec!["first".into(), "second".into()]);
    for invalid in [
        json!({"prompt":"x".repeat(1001),"ratio":"1280:720","duration":5}),
        json!({"prompt":"😀".repeat(501),"ratio":"1280:720","duration":5}),
        json!({"prompt":"Tree","duration":1,"ratio":"1280:720"}),
        json!({"prompt":"Tree","duration":5,"ratio":"1:1"}),
        json!({"prompt":"Tree","duration":5,"ratio":"1280:720","promptImage":"http://assets.example/frame.png"}),
    ] {
        assert!(p.submit_fixture("gen4.5", &invalid).await.is_err());
    }
    assert!(p.submit_fixture("gen4_turbo", &body()).await.is_err());
    assert!(server.requests().is_empty());
    assert!(matches!(
        p.submit_fixture("gen4.5", &body()).await,
        Err(ProviderError::DeliveryUncertain(_))
    ));
    assert_eq!(server.requests().len(), 1);
    assert!(p
        .poll_reference_fixture("rw1:key:../../credentials")
        .await
        .is_err());
    assert_eq!(server.requests().len(), 1);
}
#[tokio::test]
async fn submission_and_polling_use_the_assigned_proxy() {
    let proxy = MockServer::start(vec![accepted(), ready()]).await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::all(proxy.base_url()).unwrap())
        .build()
        .unwrap();
    let pool = Arc::new(EgressClientPool::new(vec![client]).unwrap());
    let p = RunwayProvider::new(
        reqwest::Client::new(),
        Some(pool),
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
    let job = p.submit_fixture("gen4.5", &body()).await.unwrap();
    p.poll_reference_fixture(&job.provider_ref).await.unwrap();
    let requests = proxy.requests();
    assert_eq!(requests.len(), 2);
    assert!(requests
        .iter()
        .all(|r| r.header("authorization").as_deref() == Some("Bearer preferred")));
}

impl RunwayProvider {
    fn submit_fixture<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<VideoJob, ProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            self.submit(model, body)
                .await
                .map(|accepted| accepted.initial)
        })
    }
    fn poll_reference_fixture<'a>(
        &'a self,
        reference: &'a str,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<VideoJob, ProviderError>> + Send + 'a>>
    {
        Box::pin(self.poll(reference))
    }
}
#[tokio::test]
async fn a_single_key_refused_for_credit_serves_again_once_refilled() {
    let server = MockServer::start(vec![MockResponse::json(402, "{}"), accepted()]).await;
    let p = provider(&server, vec!["only".into()]);
    let refused = p.submit_fixture("gen4.5", &body()).await;
    assert!(matches!(
        refused,
        Err(ProviderError::PaymentRequired { .. })
    ));
    p.submit_fixture("gen4.5", &body()).await.unwrap();
    assert_eq!(server.requests().len(), 2);
}
