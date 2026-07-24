//! End-to-end tests for the gateway-mandatory `ModelClient`, driven against a
//! one-shot mock HTTP server (see `common`). These exercise the real request
//! shaping and response parsing that the crate's inline unit tests cannot reach
//! (the wire types are private).

mod common;

use futures_util::StreamExt;
use ryu_sdk::model::{ChatMessage, ModelClient, ModelClientOptions, ModelError};

fn client_for(base_url: &str, token: Option<&str>) -> ModelClient {
    ModelClient::new(
        "gemma4",
        ModelClientOptions {
            base_url: Some(base_url.to_string()),
            token: token.map(str::to_string),
        },
    )
    .expect("client")
}

#[test]
fn chat_message_constructors_set_role_and_content() {
    assert_eq!(ChatMessage::system("s").role, "system");
    assert_eq!(ChatMessage::user("u").role, "user");
    assert_eq!(ChatMessage::assistant("a").role, "assistant");
    assert_eq!(ChatMessage::user("hello").content, "hello");
}

#[test]
fn chat_message_serializes_to_openai_shape() {
    let msg = ChatMessage::user("hi");
    let v = serde_json::to_value(&msg).expect("serialize");
    assert_eq!(v["role"], "user");
    assert_eq!(v["content"], "hi");
}

#[tokio::test]
async fn chat_posts_to_completions_path_with_model_and_messages() {
    let server = common::spawn(
        200,
        "application/json",
        r#"{"choices":[{"message":{"content":"hello there"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}"#,
    );
    let client = client_for(&server.base_url, Some("secret-token"));
    let result = client
        .chat(&[ChatMessage::user("hi")])
        .await
        .expect("chat ok");

    assert_eq!(result.content, "hello there");
    assert_eq!(result.finish_reason.as_deref(), Some("stop"));
    let usage = result.usage.expect("usage");
    assert_eq!(usage.prompt_tokens, 3);
    assert_eq!(usage.completion_tokens, 2);
    assert_eq!(usage.total_tokens, 5);

    // Verify what the client actually sent over the wire.
    let req = server.captured.await.expect("captured");
    assert_eq!(req.request_line(), "POST /v1/chat/completions HTTP/1.1");
    assert_eq!(
        req.header("authorization").as_deref(),
        Some("Bearer secret-token")
    );
    let body: serde_json::Value = serde_json::from_str(&req.body).expect("json body");
    assert_eq!(body["model"], "gemma4");
    assert_eq!(body["stream"], false);
    assert_eq!(body["messages"][0]["role"], "user");
    assert_eq!(body["messages"][0]["content"], "hi");
}

#[tokio::test]
async fn chat_without_token_sends_no_authorization_header() {
    let server = common::spawn(
        200,
        "application/json",
        r#"{"choices":[{"message":{"content":"ok"}}]}"#,
    );
    let client = client_for(&server.base_url, None);
    let result = client.chat(&[ChatMessage::user("hi")]).await.expect("ok");
    // No usage / finish_reason present → both None, content parsed.
    assert_eq!(result.content, "ok");
    assert!(result.finish_reason.is_none());
    assert!(result.usage.is_none());

    let req = server.captured.await.expect("captured");
    assert!(req.header("authorization").is_none());
}

#[tokio::test]
async fn chat_with_empty_choices_yields_empty_content() {
    let server = common::spawn(200, "application/json", r#"{"choices":[]}"#);
    let client = client_for(&server.base_url, None);
    let result = client.chat(&[ChatMessage::user("hi")]).await.expect("ok");
    assert_eq!(result.content, "");
    assert!(result.finish_reason.is_none());
}

#[tokio::test]
async fn chat_maps_non_2xx_to_http_error_with_status_and_body() {
    let server = common::spawn(429, "text/plain", "slow down");
    let client = client_for(&server.base_url, None);
    let err = client.chat(&[ChatMessage::user("hi")]).await.unwrap_err();
    match err {
        ModelError::Http { status, body, url } => {
            assert_eq!(status, 429);
            assert_eq!(body, "slow down");
            assert!(url.ends_with("/v1/chat/completions"), "url was {url}");
        }
        other => panic!("expected Http error, got {other:?}"),
    }
}

#[tokio::test]
async fn stream_yields_deltas_in_order_and_stops_at_done() {
    let sse = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":null}]}\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n",
        "data: [DONE]\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"AFTER-DONE\"}}]}\n",
    );
    let server = common::spawn(200, "text/event-stream", sse);
    let client = client_for(&server.base_url, None);

    let messages = [ChatMessage::user("hi")];
    let mut stream = Box::pin(client.stream(&messages));
    let mut contents = Vec::new();
    let mut final_reason = None;
    while let Some(item) = stream.next().await {
        let delta = item.expect("delta ok");
        contents.push(delta.content.clone());
        if delta.finish_reason.is_some() {
            final_reason = delta.finish_reason.clone();
        }
    }
    // Content after `[DONE]` must be dropped — the stream terminates on [DONE].
    assert_eq!(contents, vec!["Hel", "lo", ""]);
    assert_eq!(final_reason.as_deref(), Some("stop"));
}

#[tokio::test]
async fn stream_surfaces_http_error_before_yielding() {
    let server = common::spawn(500, "text/plain", "boom");
    let client = client_for(&server.base_url, None);
    let messages = [ChatMessage::user("hi")];
    let mut stream = Box::pin(client.stream(&messages));

    let first = stream.next().await.expect("one item");
    match first.unwrap_err() {
        ModelError::Http { status, body, .. } => {
            assert_eq!(status, 500);
            assert_eq!(body, "boom");
        }
        other => panic!("expected Http error, got {other:?}"),
    }
    // No further items after the error.
    assert!(stream.next().await.is_none());
}
