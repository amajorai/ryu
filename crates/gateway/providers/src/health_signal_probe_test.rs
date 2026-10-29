//! Coverage probe for P0-1: an upstream 4xx is classified by its status, never
//! by the shape of its body, so it reaches the gateway as
//! `ProviderError::Rejected { status }` and not as a provider health fault.
//!
//! The shared helpers (`check_response_status`, `check_stream_status`) already
//! classify an unreadable error body by status. These probes push the shapes a
//! real upstream also sends (an HTML error page, an empty body, plain text, a
//! very long message that mentions other statuses) through every adapter that
//! reads error bodies itself, plus the pooled adapters' key rotation. Each case
//! has a control that must still classify as a health fault or rotate.
use crate::test_support::{MockResponse, MockServer};
use crate::{
    anthropic::AnthropicProvider, fal::FalProvider, openai::OpenAiProvider,
    openrouter::OpenRouterOptions, openrouter::OpenRouterProvider, quota::ProviderQuotas,
    replicate::ReplicateProvider, Provider, ProviderError,
};
use serde_json::json;
use std::sync::Arc;

/// A reply with an arbitrary status, content type and body.
fn reply(status: u16, content_type: &str, body: &str) -> MockResponse {
    MockResponse {
        status,
        headers: vec![("content-type".into(), content_type.into())],
        body: body.into(),
        body_bytes: None,
    }
}

/// Error bodies a real upstream sends with a refusal: an HTML error page, an
/// empty body and plain text.
fn unreadable_refusals() -> Vec<(u16, MockResponse)> {
    vec![
        (
            403,
            reply(403, "text/html", "<html><body>Forbidden</body></html>"),
        ),
        (400, reply(400, "text/plain", "")),
        (
            451,
            reply(451, "text/plain", "Unavailable For Legal Reasons"),
        ),
        (422, reply(422, "application/json", "not json at all")),
    ]
}

fn assert_rejected(error: Option<ProviderError>, status: u16, case: &str) {
    match error {
        Some(ProviderError::Rejected {
            status: carried, ..
        }) if carried == status => {}
        other => panic!("{case}: expected Rejected {{ status: {status} }}, got {other:?}"),
    }
}

fn assert_health_fault(error: Option<ProviderError>, case: &str) {
    assert!(
        matches!(error, Some(ProviderError::Provider(_))),
        "{case}: expected a provider health fault, got {error:?}"
    );
}

fn fal(base: &str) -> FalProvider {
    FalProvider::new(
        reqwest::Client::new(),
        "fal-key".into(),
        base.into(),
        250,
        5,
    )
}

fn replicate(base: &str) -> ReplicateProvider {
    ReplicateProvider::new(
        reqwest::Client::new(),
        "replicate-key".into(),
        base.into(),
        250,
        5,
    )
}

// ── media adapters that parse the body before the status ───────────────────

#[tokio::test]
async fn fal_refusal_with_an_unreadable_body_is_a_rejection() {
    for (status, response) in unreadable_refusals() {
        let server = MockServer::always(response.clone()).await;
        let error = fal(server.base_url())
            .generate_image("fal-ai/flux", &json!({"prompt": "ping"}))
            .await
            .err();
        assert_rejected(error, status, "fal image");

        let server = MockServer::always(response).await;
        let error = fal(server.base_url())
            .submit_video_bound("fal-ai/video", &json!({"prompt": "ping"}))
            .await
            .err();
        assert_rejected(error, status, "fal video");
    }
}

#[tokio::test]
async fn replicate_refusal_with_an_unreadable_body_is_a_rejection() {
    for (status, response) in unreadable_refusals() {
        let server = MockServer::always(response.clone()).await;
        let error = replicate(server.base_url())
            .generate_image("owner/name", &json!({"prompt": "ping"}))
            .await
            .err();
        assert_rejected(error, status, "replicate image");

        let server = MockServer::always(response).await;
        let error = replicate(server.base_url())
            .submit_video_bound("owner/name", &json!({"prompt": "ping"}))
            .await
            .err();
        assert_rejected(error, status, "replicate video");
    }
}

#[tokio::test]
async fn media_adapter_controls_classify_by_status() {
    // A refusal with a readable JSON body is already a rejection.
    let server = MockServer::always(MockResponse::json(403, r#"{"detail":"refused"}"#)).await;
    let error = fal(server.base_url())
        .generate_image("fal-ai/flux", &json!({"prompt": "ping"}))
        .await
        .err();
    assert_rejected(error, 403, "fal json control");
    let server = MockServer::always(MockResponse::json(403, r#"{"detail":"refused"}"#)).await;
    let error = replicate(server.base_url())
        .generate_image("owner/name", &json!({"prompt": "ping"}))
        .await
        .err();
    assert_rejected(error, 403, "replicate json control");

    // A 5xx error page is a genuine health fault.
    let server = MockServer::always(reply(503, "text/html", "<html>busy</html>")).await;
    let error = fal(server.base_url())
        .generate_image("fal-ai/flux", &json!({"prompt": "ping"}))
        .await
        .err();
    assert_health_fault(error, "fal 503 control");
}

// ── chat adapters: body shapes, streaming and key rotation ─────────────────

fn openai(base: &str, keys: &[&str]) -> OpenAiProvider {
    OpenAiProvider::new(
        reqwest::Client::new(),
        keys.iter().map(|key| (*key).to_owned()).collect(),
        base.into(),
        Arc::new(ProviderQuotas::new()),
    )
}

fn anthropic(base: &str, keys: &[&str]) -> AnthropicProvider {
    AnthropicProvider::new(
        reqwest::Client::new(),
        keys.iter().map(|key| (*key).to_owned()).collect(),
        base.into(),
        Arc::new(ProviderQuotas::new()),
    )
}

fn openrouter(base: &str, keys: &[&str]) -> OpenRouterProvider {
    OpenRouterProvider::new(
        reqwest::Client::new(),
        keys.iter().map(|key| (*key).to_owned()).collect(),
        base.into(),
        "https://ryu.example".to_owned(),
        "Ryu".to_owned(),
        OpenRouterOptions::default(),
        Arc::new(ProviderQuotas::new()),
    )
}

fn chat_body() -> serde_json::Value {
    json!({"messages": [{"role": "user", "content": "ping"}], "max_tokens": 8})
}

/// Every pooled chat adapter, two keys each, against `server`.
fn pooled_chat(server: &MockServer) -> Vec<(&'static str, Box<dyn Provider>)> {
    let base = server.base_url();
    vec![
        (
            "openai",
            Box::new(openai(base, &["k1", "k2"])) as Box<dyn Provider>,
        ),
        ("anthropic", Box::new(anthropic(base, &["k1", "k2"]))),
        ("openrouter", Box::new(openrouter(base, &["k1", "k2"]))),
    ]
}

#[tokio::test]
async fn pooled_chat_refusals_with_any_body_hit_once_and_never_rotate() {
    let mut shapes = unreadable_refusals();
    shapes.push((
        409,
        MockResponse::json(409, r#"{"error":{"message":"conflict"}}"#),
    ));
    for (status, response) in shapes {
        for streaming in [false, true] {
            // One server per adapter so each request count is its own.
            for index in 0..3 {
                let server = MockServer::always(response.clone()).await;
                let (name, provider) = pooled_chat(&server).swap_remove(index);
                let case = format!("{name} {status} streaming={streaming}");
                let error = if streaming {
                    provider
                        .complete_stream_for_session("m", &chat_body(), Some("s1"))
                        .await
                        .err()
                } else {
                    provider
                        .complete_for_session("m", &chat_body(), Some("s1"))
                        .await
                        .err()
                };
                assert_rejected(error, status, &case);
                assert_eq!(
                    server.request_count(),
                    1,
                    "{case}: a refusal is neither retried nor moved to the next key"
                );
            }
        }
    }
}

#[tokio::test]
async fn pooled_chat_controls_rotate_on_capacity() {
    for index in 0..3 {
        let server = MockServer::start(vec![
            MockResponse::json(429, r#"{"error":{"message":"slow down"}}"#),
            MockResponse::json(503, r#"{"error":{"message":"busy"}}"#),
        ])
        .await;
        let (name, provider) = pooled_chat(&server).swap_remove(index);
        let _ = provider
            .complete_for_session("m", &chat_body(), Some("s1"))
            .await;
        assert!(
            server.request_count() >= 2,
            "{name}: a 429 moves the request to the next key"
        );
    }
}

#[tokio::test]
async fn a_long_message_never_changes_the_status_classification() {
    // A refusal whose message is long benign padding that mentions health
    // statuses is still the refusal its status says.
    let padding = "service unavailable 503 gateway timeout 504 overloaded ".repeat(2_000);
    let body = json!({"error": {"message": padding}}).to_string();
    let server = MockServer::always(MockResponse::json(403, body.clone())).await;
    let error = openai(server.base_url(), &["k1"])
        .complete_for_session("m", &chat_body(), Some("s1"))
        .await
        .err();
    assert_rejected(error, 403, "padded 403");

    // Control: a 5xx whose message talks about a 403 is a health fault.
    let mention = json!({"error": {"message": "403 forbidden not found ".repeat(2_000)}});
    let server = MockServer::always(MockResponse::json(500, mention.to_string())).await;
    let error = openai(server.base_url(), &["k1"])
        .complete_for_session("m", &chat_body(), Some("s1"))
        .await
        .err();
    assert_health_fault(error, "500 mentioning 403");
}
