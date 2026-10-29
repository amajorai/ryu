//! HTTP-level tests for the streamed `/v1/responses` terminal states:
//! incomplete finishes, refusal content parts and token logprobs.

use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::{
    api,
    audit::AuditLogger,
    config::{AuditConfig, GatewayConfig, ProviderId},
    evals::EvalsRunner,
    providers::Provider,
    state::AppState,
};

struct StreamFixtureProvider {
    stream: String,
    calls: Arc<Mutex<Vec<Value>>>,
}

impl Provider for StreamFixtureProvider {
    fn name(&self) -> &'static str {
        "responses-stream-test"
    }

    fn complete<'a>(
        &'a self,
        _model: &'a str,
        _body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ryu_gw_providers::ProviderError>> + Send + 'a>>
    {
        Box::pin(async move {
            Err(ryu_gw_providers::ProviderError::Provider(
                "streaming fixture only".to_owned(),
            ))
        })
    }

    fn complete_stream<'a>(
        &'a self,
        _model: &'a str,
        body: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<Body, ryu_gw_providers::ProviderError>> + Send + 'a>>
    {
        self.calls.lock().expect("calls lock").push(body.clone());
        let stream = self.stream.clone();
        Box::pin(async move { Ok(Body::from(stream)) })
    }
}

fn stream_app(stream: String) -> (Router, Arc<Mutex<Vec<Value>>>) {
    let mut config = GatewayConfig::default();
    config.auth.require_auth = false;
    config.cache.enabled = false;
    config.firewall.enabled = false;
    config.routing.default_provider = ProviderId::from("responses-stream-test");
    config.routing.fallback_chain = vec![ProviderId::from("responses-stream-test")];
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = EvalsRunner::new(crate::config::EvalsConfig::default());
    let mut state = AppState::new_for_test(config, audit, evals);
    let calls = Arc::new(Mutex::new(Vec::new()));
    state
        .provider_runtime
        .register_for_test(Arc::new(StreamFixtureProvider {
            stream,
            calls: Arc::clone(&calls),
        }));
    (api::router(Arc::new(state)), calls)
}

fn sse(chunks: &[Value]) -> String {
    let mut out = String::new();
    for chunk in chunks {
        out.push_str(&format!("data: {chunk}\n\n"));
    }
    out.push_str("data: [DONE]\n\n");
    out
}

fn chunk(delta: Value, finish_reason: Option<&str>) -> Value {
    json!({
        "id": "chatcmpl-stream",
        "choices": [{ "index": 0, "delta": delta, "finish_reason": finish_reason }]
    })
}

/// POST a streamed request and return the parsed `(event, data)` pairs.
async fn stream_events(app: Router, mut body: Value) -> Vec<(String, Value)> {
    body["stream"] = json!(true);
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v1/responses")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .expect("request builds"),
        )
        .await
        .expect("router responds");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("stream body reads");
    let text = String::from_utf8(bytes.to_vec()).expect("SSE is UTF-8");
    text.split("\n\n")
        .filter(|frame| !frame.trim().is_empty())
        .map(|frame| {
            let event = frame
                .lines()
                .find_map(|line| line.strip_prefix("event: "))
                .expect("frame has an event line")
                .to_owned();
            let data = frame
                .lines()
                .find_map(|line| line.strip_prefix("data: "))
                .expect("frame has a data line");
            (event, serde_json::from_str(data).expect("data is JSON"))
        })
        .collect()
}

fn event_types(events: &[(String, Value)]) -> Vec<&str> {
    events.iter().map(|(event, _)| event.as_str()).collect()
}

fn find<'a>(events: &'a [(String, Value)], name: &str) -> &'a Value {
    &events
        .iter()
        .find(|(event, _)| event == name)
        .unwrap_or_else(|| panic!("missing {name} in {:?}", event_types(events)))
        .1
}

#[tokio::test]
async fn length_finish_ends_with_response_incomplete_and_reason() {
    let fixture = sse(&[
        chunk(json!({ "content": "Partial ans" }), None),
        chunk(json!({}), Some("length")),
    ]);
    let (app, _) = stream_app(fixture);
    let events = stream_events(app, json!({ "model": "m", "input": "hello" })).await;
    let types = event_types(&events);
    assert!(!types.contains(&"response.completed"), "{types:?}");
    assert_eq!(types.last(), Some(&"response.incomplete"));
    let terminal = find(&events, "response.incomplete");
    assert_eq!(terminal["response"]["status"], "incomplete");
    assert_eq!(
        terminal["response"]["incomplete_details"]["reason"],
        "max_output_tokens"
    );
    assert_eq!(
        terminal["response"]["output"][0]["content"][0]["text"],
        "Partial ans"
    );
}

#[tokio::test]
async fn content_filter_finish_reports_content_filter_reason() {
    let fixture = sse(&[
        chunk(json!({ "content": "x" }), None),
        chunk(json!({}), Some("content_filter")),
    ]);
    let (app, _) = stream_app(fixture);
    let events = stream_events(app, json!({ "model": "m", "input": "hello" })).await;
    let terminal = find(&events, "response.incomplete");
    assert_eq!(
        terminal["response"]["incomplete_details"]["reason"],
        "content_filter"
    );
}

#[tokio::test]
async fn stop_finish_completes_without_incomplete_details() {
    let fixture = sse(&[
        chunk(json!({ "content": "done" }), None),
        chunk(json!({}), Some("stop")),
    ]);
    let (app, _) = stream_app(fixture);
    let events = stream_events(app, json!({ "model": "m", "input": "hello" })).await;
    let types = event_types(&events);
    assert!(!types.contains(&"response.incomplete"), "{types:?}");
    let terminal = find(&events, "response.completed");
    assert_eq!(terminal["response"]["status"], "completed");
    assert!(terminal["response"]
        .get("incomplete_details")
        .is_none_or(Value::is_null));
}

#[tokio::test]
async fn refusal_delta_stream_yields_a_refusal_content_part() {
    let fixture = sse(&[
        chunk(json!({ "role": "assistant", "refusal": "I can't " }), None),
        chunk(json!({ "refusal": "help with that." }), None),
        chunk(json!({}), Some("stop")),
    ]);
    let (app, _) = stream_app(fixture);
    let events = stream_events(app, json!({ "model": "m", "input": "bad" })).await;
    let types = event_types(&events);
    assert_eq!(
        types
            .iter()
            .filter(|event| **event == "response.refusal.delta")
            .count(),
        2
    );
    assert!(!types.contains(&"response.output_text.delta"), "{types:?}");
    let added = find(&events, "response.content_part.added");
    assert_eq!(added["part"]["type"], "refusal");
    assert_eq!(
        find(&events, "response.refusal.done")["refusal"],
        "I can't help with that."
    );
    let terminal = find(&events, "response.completed");
    let content = terminal["response"]["output"][0]["content"]
        .as_array()
        .expect("message content");
    assert_eq!(
        content,
        &vec![json!({ "type": "refusal", "refusal": "I can't help with that." })]
    );
}

#[tokio::test]
async fn requested_logprobs_are_forwarded_and_land_on_output_text_done() {
    let first = json!({ "token": "Hi", "logprob": -0.1, "bytes": [72, 105], "top_logprobs": [] });
    let second = json!({ "token": "!", "logprob": -0.5, "bytes": [33], "top_logprobs": [] });
    let fixture = sse(&[
        json!({ "choices": [{ "index": 0, "delta": { "content": "Hi" },
            "logprobs": { "content": [first.clone()] }, "finish_reason": null }] }),
        json!({ "choices": [{ "index": 0, "delta": { "content": "!" },
            "logprobs": { "content": [second.clone()] }, "finish_reason": "stop" }] }),
    ]);
    let (app, calls) = stream_app(fixture);
    let events = stream_events(
        app,
        json!({
            "model": "m",
            "input": "hello",
            "include": ["message.output_text.logprobs"]
        }),
    )
    .await;
    assert_eq!(calls.lock().expect("calls lock")[0]["logprobs"], true);
    let done = find(&events, "response.output_text.done");
    assert_eq!(done["text"], "Hi!");
    assert_eq!(done["logprobs"], json!([first.clone(), second.clone()]));
    let deltas = events
        .iter()
        .filter(|(event, _)| event == "response.output_text.delta")
        .map(|(_, data)| data["logprobs"].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        deltas,
        vec![json!([first.clone()]), json!([second.clone()])]
    );
    let terminal = find(&events, "response.completed");
    assert_eq!(
        terminal["response"]["output"][0]["content"][0]["logprobs"],
        json!([first, second])
    );
}

#[tokio::test]
async fn unrequested_logprobs_are_not_projected() {
    let fixture = sse(&[
        json!({ "choices": [{ "index": 0, "delta": { "content": "Hi" },
        "logprobs": { "content": [{ "token": "Hi", "logprob": -0.1 }] },
        "finish_reason": "stop" }] }),
    ]);
    let (app, _) = stream_app(fixture);
    let events = stream_events(app, json!({ "model": "m", "input": "hello" })).await;
    assert!(find(&events, "response.output_text.done")
        .get("logprobs")
        .is_none());
    assert!(find(&events, "response.output_text.delta")
        .get("logprobs")
        .is_none());
}

#[tokio::test]
async fn requested_logprobs_missing_from_upstream_fail_the_stream() {
    let fixture = sse(&[
        chunk(json!({ "content": "Hi" }), None),
        chunk(json!({}), Some("stop")),
    ]);
    let (app, _) = stream_app(fixture);
    let events = stream_events(
        app,
        json!({ "model": "m", "input": "hello", "top_logprobs": 2 }),
    )
    .await;
    let types = event_types(&events);
    assert!(!types.contains(&"response.completed"), "{types:?}");
    assert!(!types.contains(&"response.output_text.done"), "{types:?}");
    assert_eq!(types.last(), Some(&"response.failed"));
    let failed = find(&events, "response.failed");
    assert_eq!(failed["response"]["status"], "failed");
    assert!(failed["response"]["error"]["message"]
        .as_str()
        .expect("error message")
        .contains("did not return token logprobs"));
}
