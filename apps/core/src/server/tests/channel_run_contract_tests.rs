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
