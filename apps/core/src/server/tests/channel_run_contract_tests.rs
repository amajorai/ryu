use crate::server::ChannelRunRequest;

#[test]
fn channel_run_accepts_the_camel_case_idempotency_key() {
    let request: ChannelRunRequest = serde_json::from_value(serde_json::json!({
        "conversation_id": "channel-chat",
        "text": "hello",
        "idempotencyKey": "telegram:bot-a:update-42",
    }))
    .expect("channel request should parse");
    assert_eq!(
        request.idempotency_key.as_deref(),
        Some("telegram:bot-a:update-42")
    );

    let legacy: ChannelRunRequest = serde_json::from_value(serde_json::json!({
        "conversation_id": "channel-chat",
        "text": "hello",
        "idempotency_key": "legacy-key",
    }))
    .expect("legacy spelling should remain compatible");
    assert_eq!(legacy.idempotency_key.as_deref(), Some("legacy-key"));
}

/// The handler must turn a refused channel attach into a 403 rather than a
/// generic 500 (and never run the turn on the refused conversation).
#[test]
fn channel_run_maps_a_refused_channel_attach_to_forbidden() {
    let source = include_str!("../channel_runs/channel_run.rs");
    let needle = [
        "downcast_ref::<crate::server::conversations::",
        "ChannelAttachRefused>",
    ]
    .concat();
    let at = source
        .find(&needle)
        .expect("channel_run no longer recognizes ChannelAttachRefused");
    assert!(source[at..].contains("StatusCode::FORBIDDEN"));
    let run_at = source
        .find("run_reply_text_with_channel_action(")
        .expect("channel_run no longer runs the reply");
    assert!(
        at < run_at,
        "the refusal must be handled before the turn runs"
    );
}
