//! Tests for the BFL adapter.
#[tokio::test]
async fn captured_origin_reports_blockage_without_terminating_or_replaying() {
    let server = MockServer::start(vec![
        MockResponse::ok_json(
            r#"{"id":"job1","polling_url":"http://origin.invalid/v1/get_result?id=job1"}"#,
        ),
        MockResponse::json(401, r#"{"error":"origin-key raw upstream secret"}"#),
        MockResponse::json(407, "{}"),
        MockResponse::json(429, "{}").with_header("retry-after", "7"),
        MockResponse::json(503, "{}"),
        MockResponse::ok_json(r#"{"status":"unknown"}"#),
        MockResponse::ok_json(r#"{"status":"Failed","error":"origin-key raw upstream secret"}"#),
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
    let provider = BflProvider::new(
        reqwest::Client::new(),
        Some(pool),
        vec!["origin-key".into()],
        "http://origin.invalid/v1".into(),
        Arc::new(crate::ProviderQuotas::new()),
        1,
        5,
    );
    let accepted = provider
        .submit_video_bound("flux-3-video", &json!({"prompt":"video"}))
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
    let original = MockServer::start(vec![
        MockResponse::ok_json(
            r#"{"id":"job1","polling_url":"http://origin.invalid/v1/get_result?id=job1"}"#,
        ),
        ready(),
    ])
    .await;
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
    let mut provider = BflProvider::new(
        reqwest::Client::new(),
        Some(pool.clone()),
        vec!["origin-key".into()],
        "http://origin.invalid/v1".into(),
        Arc::new(crate::ProviderQuotas::new()),
        1,
        5,
    );
    let accepted = provider
        .submit_video_bound("flux-3-video", &json!({"prompt":"video"}))
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
        assert_eq!(request.header("x-key").as_deref(), Some("origin-key"));
    }
}

use super::*;
use crate::test_support::{MockResponse, MockServer};
fn provider(server: &MockServer, keys: Vec<String>) -> BflProvider {
    BflProvider::new(
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        None,
        keys,
        format!("{}/v1", server.base_url()),
        Arc::new(ProviderQuotas::new()),
        1,
        3,
    )
}
fn accepted() -> MockResponse {
    MockResponse::ok_json(r#"{"id":"job1","polling_url":"{{BASE}}/v1/get_result?id=job1"}"#)
}
fn ready() -> MockResponse {
    MockResponse::ok_json(
        r#"{"status":"Ready","result":{"sample":"https://delivery.example/image.png"}}"#,
    )
}
#[tokio::test]
async fn inline_image_submission_and_polling_keep_the_account() {
    let server = MockServer::start(vec![
        accepted(),
        MockResponse::ok_json(r#"{"status":"Generating"}"#),
        ready(),
    ])
    .await;
    let p = provider(&server, vec!["first".into(), "second".into()]);
    assert_eq!(
        p.generate_image("flux-2-pro", &json!({"prompt":"tree","size":"1024x1024"}))
            .await
            .unwrap()["data"][0]["url"],
        "https://delivery.example/image.png"
    );
    let requests = server.requests();
    assert_eq!(requests.len(), 3);
    assert!(requests
        .iter()
        .all(|r| r.header("x-key").as_deref() == Some("first")));
    assert_eq!(requests[0].path, "/v1/flux-2-pro");
    assert_eq!(requests[0].json()["width"], 1024);
}
#[tokio::test]
async fn video_job_reference_survives_account_reordering_and_removed_accounts_fail_closed() {
    let server = MockServer::start(vec![MockResponse::json(429, "{}"), accepted(), ready()]).await;
    let p = provider(&server, vec!["limited".into(), "selected".into()]);
    let job = p
        .submit_fixture("flux-3-video", &json!({"prompt":"tree"}))
        .await
        .unwrap();
    assert!(!job.provider_ref.contains("selected"));
    let reordered = provider(&server, vec!["selected".into(), "limited".into()]);
    assert_eq!(
        reordered
            .poll_reference_fixture(&job.provider_ref)
            .await
            .unwrap()
            .status,
        JobStatus::Succeeded
    );
    assert_eq!(
        server.requests()[2].header("x-key").as_deref(),
        Some("selected")
    );
    let removed = provider(&server, vec!["limited".into()]);
    assert!(removed
        .poll_reference_fixture(&job.provider_ref)
        .await
        .is_err());
    assert_eq!(server.requests().len(), 3);
}
#[tokio::test]
async fn accepted_invalid_references_and_poll_failures_are_not_replayed() {
    let server = MockServer::always(MockResponse::ok_json(
        r#"{"id":"job1","polling_url":"https://attacker.example/v1/get_result?id=job1"}"#,
    ))
    .await;
    let p = provider(&server, vec!["first".into(), "second".into()]);
    assert!(matches!(
        p.generate_image("flux-2-pro", &json!({"prompt":"tree"}))
            .await,
        Err(ProviderError::DeliveryUncertain(_))
    ));
    assert_eq!(server.requests().len(), 1);
    let server = MockServer::start(vec![accepted(), MockResponse::json(500, "{}")]).await;
    let p = provider(&server, vec!["first".into(), "second".into()]);
    assert!(matches!(
        p.generate_image("flux-2-pro", &json!({"prompt":"tree"}))
            .await,
        Err(ProviderError::DeliveryUncertain(_))
    ));
    assert_eq!(server.requests().len(), 2);
}
#[tokio::test]
async fn accepted_job_keeps_its_proxy_binding_and_original_account() {
    let proxy = MockServer::start(vec![
        MockResponse::ok_json(
            r#"{"id":"job1","polling_url":"http://unreachable.invalid/v1/get_result?id=job1"}"#,
        ),
        ready(),
    ])
    .await;
    let unused = MockServer::always(ready()).await;
    let clients = [proxy.base_url(), unused.base_url()]
        .into_iter()
        .map(|url| {
            reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .proxy(reqwest::Proxy::all(url).unwrap())
                .build()
                .unwrap()
        })
        .collect();
    let pool = Arc::new(EgressClientPool::new(clients).unwrap());
    let p = BflProvider::new(
        reqwest::Client::new(),
        Some(pool),
        vec!["account".into()],
        "http://unreachable.invalid/v1".into(),
        Arc::new(ProviderQuotas::new()),
        1,
        3,
    );
    let job = p
        .submit_fixture("flux-3-video", &json!({"prompt":"tree"}))
        .await
        .unwrap();
    assert_eq!(
        p.poll_reference_fixture(&job.provider_ref)
            .await
            .unwrap()
            .status,
        JobStatus::Succeeded
    );
    assert_eq!(proxy.requests().len(), 2);
    assert!(unused.requests().is_empty());
    assert!(proxy
        .requests()
        .iter()
        .all(|r| r.header("x-key").as_deref() == Some("account")));
}
#[test]
fn poll_urls_and_inputs_are_checked_before_credentials_are_sent() {
    let p = BflProvider::new(
        reqwest::Client::new(),
        None,
        vec!["key".into()],
        "https://api.bfl.ai/v1".into(),
        Arc::new(ProviderQuotas::new()),
        500,
        180,
    );
    assert!(p
        .valid_poll_url("https://api.eu1.bfl.ai/v1/get_result?id=job", Some("job"))
        .is_ok());
    for url in [
        "https://api.bfl.ai.attacker.example/v1/get_result?id=job",
        "http://api.bfl.ai/v1/get_result?id=job",
        "https://api.bfl.ai/v1/get_result?id=other",
        "https://user:password@api.bfl.ai/v1/get_result?id=job",
    ] {
        assert!(p.valid_poll_url(url, Some("job")).is_err());
    }
    assert!(BflProvider::payload("flux-2-pro", &json!({"prompt":"tree","n":2}), false).is_err());
    assert!(
        BflProvider::payload("flux-3-video", &json!({"prompt":"tree","mode":"v2v"}), true).is_err()
    );
}

impl BflProvider {
    fn submit_fixture<'a>(
        &'a self,
        model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<VideoJob, ProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            let (reference, _, _) = self.submit(model, body, true).await?;
            Ok(VideoJob {
                provider_ref: reference,
                status: JobStatus::Queued,
                output: None,
                error: None,
            })
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
    let server = MockServer::start(vec![MockResponse::json(402, "{}"), accepted(), ready()]).await;
    let p = provider(&server, vec!["only".into()]);
    let body = json!({"prompt":"tree","size":"1024x1024"});
    let refused = p.generate_image("flux-2-pro", &body).await;
    assert!(matches!(
        refused,
        Err(ProviderError::PaymentRequired { .. })
    ));
    p.generate_image("flux-2-pro", &body).await.unwrap();
    assert_eq!(server.requests().len(), 3);
}
