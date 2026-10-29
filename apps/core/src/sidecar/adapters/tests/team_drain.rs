use super::*;

// ── Team orchestration linchpin: the SSE drain parser ──────────────────────

#[tokio::test]
async fn drain_collects_text_and_stops_at_done() {
    // A well-formed UI message stream with two text deltas, then [DONE], then
    // a stray delta that must be ignored (parser stops at the sentinel).
    let mut p = ui_start();
    p.extend(ui_text_start("a"));
    p.extend(ui_text_delta("a", "Hello "));
    p.extend(ui_text_delta("a", "world"));
    p.extend(ui_text_end("a"));
    p.extend(ui_finish());
    p.extend_from_slice(DONE_SSE_LINE.as_bytes());
    p.extend(ui_text_delta("a", "AFTER-DONE"));
    let resp = sse_response(Body::from(p));
    let text = drain_text_reply(resp).await.unwrap();
    assert_eq!(text, "Hello world");
}

#[tokio::test]
async fn drain_carries_the_exact_persisted_assistant_message_id() {
    let mut payload = ui_start();
    payload.extend(ui_text_start("a"));
    payload.extend(ui_text_delta("a", "reply"));
    payload.extend(ui_text_end("a"));
    payload.extend(ui_assistant_message_id("assistant-from-this-turn"));
    payload.extend(ui_finish());
    payload.extend_from_slice(DONE_SSE_LINE.as_bytes());

    let result = drain_text_reply_with_metadata(sse_response(Body::from(payload)))
        .await
        .unwrap();
    assert_eq!(result.reply, "reply");
    assert_eq!(
        result.assistant_message_id.as_deref(),
        Some("assistant-from-this-turn")
    );
}

#[tokio::test]
async fn drain_propagates_error_frame_not_empty_string() {
    // A member that errors must surface as Err, never silently collect to "".
    let mut p = ui_start();
    for line in error_ui_lines("boom") {
        p.extend_from_slice(&line);
    }
    let resp = sse_response(Body::from(p));
    let err = drain_text_reply(resp).await.unwrap_err();
    assert!(err.to_string().contains("boom"), "got: {err}");
}

#[test]
fn preamble_folds_into_last_user_message() {
    let original = vec![
        UiMessage {
            metadata: None,
            role: "user".to_owned(),
            content: UiContent::Text("first".to_owned()),
            parts: vec![],
        },
        UiMessage {
            metadata: None,
            role: "assistant".to_owned(),
            content: UiContent::Text("reply".to_owned()),
            parts: vec![],
        },
        UiMessage {
            metadata: None,
            role: "user".to_owned(),
            content: UiContent::Text("latest question".to_owned()),
            parts: vec![],
        },
    ];
    let out = messages_with_preamble(&original, "CONTEXT");
    // Only the last user message is rewritten; earlier turns are untouched.
    assert_eq!(out[0].content.as_text(), "first");
    assert_eq!(out[1].content.as_text(), "reply");
    assert_eq!(out[2].content.as_text(), "CONTEXT\n\nlatest question");
}
