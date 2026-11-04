//! A refused, filtered or cut-off reply to one of Core's side-model calls
//! comes back as a 502, never as partial text; other traffic is unchanged.
//! The router tests run the real chat handler and pipeline against a fixture
//! provider that answers with a chosen finish reason.
use std::{future::Future, pin::Pin, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    extract::ConnectInfo,
    http::{Method, Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::incomplete_side_answer;
use crate::{
    api,
    audit::AuditLogger,
    config::{AuditConfig, GatewayConfig, ProviderId},
    evals::EvalsRunner,
    providers::Provider,
    state::AppState,
};

const FIXTURE: &str = "side-call-fixture";
const PARTIAL: &str = "PARTIAL-ANSWER-TEXT";

type ProviderFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, ryu_gw_providers::ProviderError>> + Send + 'a>>;

/// Answers every completion with `message` and `finish_reason`.
struct FixtureProvider {
    message: Value,
    finish_reason: &'static str,
}

impl Provider for FixtureProvider {
    fn name(&self) -> &'static str {
        FIXTURE
    }

    fn complete<'a>(&'a self, _model: &'a str, _body: &'a Value) -> ProviderFuture<'a, Value> {
        let response = json!({
            "id": "chatcmpl-side-call",
            "object": "chat.completion",
            "model": "fixture-model",
            "choices": [{
                "index": 0,
                "message": self.message,
                "finish_reason": self.finish_reason,
            }],
            "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }
        });
        Box::pin(async move { Ok(response) })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> ProviderFuture<'a, Body> {
        Box::pin(async { Ok(Body::from("data: [DONE]\n\n")) })
    }
}

fn answer(content: &str) -> Value {
    json!({ "role": "assistant", "content": content })
}

fn app(message: Value, finish_reason: &'static str) -> Router {
    let mut config = GatewayConfig::default();
    config.auth.require_auth = false;
    config.cache.enabled = false;
    config.routing.default_provider = ProviderId::from(FIXTURE);
    config.routing.fallback_chain = vec![];
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let mut state = AppState::new_for_test(config, audit, EvalsRunner::new(Default::default()));
    state
        .provider_runtime
        .register_for_test(Arc::new(FixtureProvider {
            message,
            finish_reason,
        }));
    api::router(Arc::new(state))
}

async fn complete(app: Router, purpose: Option<&str>) -> (StatusCode, String) {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri("/v1/chat/completions")
        .header("content-type", "application/json")
        .extension(ConnectInfo(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            40_000,
        ))));
    if let Some(purpose) = purpose {
        request = request.header("x-ryu-purpose", purpose);
    }
    let body = json!({
        "model": "fixture-model",
        "stream": false,
        "messages": [
            { "role": "system", "content": "Answer briefly." },
            { "role": "user", "content": "hello" }
        ]
    });
    let response = app
        .oneshot(
            request
                .body(Body::from(body.to_string()))
                .expect("request builds"),
        )
        .await
        .expect("router responds");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body reads");
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn a_cut_off_or_filtered_side_answer_is_a_502_without_its_text() {
    for (purpose, finish_reason) in [
        ("btw", "length"),
        ("advisor", "content_filter"),
        ("learning_judge", "max_tokens"),
        ("memory_dream", "refusal"),
        ("plugin:@acme/notes", "length"),
    ] {
        let (status, body) = complete(app(answer(PARTIAL), finish_reason), Some(purpose)).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{purpose}/{finish_reason}");
        let error: Value = serde_json::from_str(&body).expect("error body is JSON");
        assert_eq!(error["error"]["type"], "incomplete_side_answer");
        assert_eq!(error["error"]["reason"], finish_reason);
        assert!(!body.contains(PARTIAL), "{purpose}: partial text leaked");
    }
}

#[tokio::test]
async fn a_refusal_message_to_a_side_call_is_a_502() {
    let message =
        json!({ "role": "assistant", "content": PARTIAL, "refusal": "I can't help with that." });
    let (status, body) = complete(app(message, "stop"), Some("recommendations")).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(body.contains("\"reason\":\"refusal\""), "{body}");
    assert!(!body.contains(PARTIAL));
    assert!(
        !body.contains("can't help"),
        "the refusal text is not echoed"
    );
}

#[tokio::test]
async fn complete_side_answers_and_other_traffic_pass_through() {
    let (status, body) = complete(app(answer(PARTIAL), "stop"), Some("btw")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains(PARTIAL));
    // Ordinary chat, and tagged work that reads the reply itself, keep a
    // length stop as a normal response.
    for purpose in [None, Some("workflow_prompt"), Some("compaction")] {
        let (status, body) = complete(app(answer(PARTIAL), "length"), purpose).await;
        assert_eq!(status, StatusCode::OK, "{purpose:?}");
        assert!(body.contains(PARTIAL), "{purpose:?}");
    }
}

#[tokio::test]
async fn an_empty_side_answer_is_a_502() {
    for message in [
        answer(""),
        answer("  \n "),
        json!({ "role": "assistant", "content": null }),
        json!({ "role": "assistant" }),
    ] {
        let (status, body) = complete(app(message.clone(), "stop"), Some("learning_judge")).await;
        assert_eq!(status, StatusCode::BAD_GATEWAY, "{message}");
        assert!(body.contains("\"reason\":\"empty\""), "{body}");
    }
    // Ordinary chat keeps an empty reply as a normal response.
    let (status, _) = complete(app(answer(""), "stop"), None).await;
    assert_eq!(status, StatusCode::OK);
}

#[test]
fn only_side_model_purposes_and_incomplete_replies_are_replaced() {
    let cut = json!({ "choices": [{ "message": answer("x"), "finish_reason": "LENGTH" }] });
    assert!(incomplete_side_answer(Some("predict"), &cut).is_some());
    assert!(incomplete_side_answer(Some("retrieval_expansion"), &cut).is_some());
    assert!(incomplete_side_answer(Some("auto_title"), &cut).is_none());
    assert!(incomplete_side_answer(Some("pluginx"), &cut).is_none());
    assert!(incomplete_side_answer(None, &cut).is_none());
    let done = json!({ "choices": [{ "message": answer("x"), "finish_reason": "stop" }] });
    assert!(incomplete_side_answer(Some("btw"), &done).is_none());
    let blank_refusal = json!({ "choices": [{ "message": { "content": "x", "refusal": "  " }, "finish_reason": "stop" }] });
    assert!(incomplete_side_answer(Some("btw"), &blank_refusal).is_none());
    for no_text in [json!({}), json!({ "choices": [] })] {
        assert!(incomplete_side_answer(Some("btw"), &no_text).is_some());
    }
}
