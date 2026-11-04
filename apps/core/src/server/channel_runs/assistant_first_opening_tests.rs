//! The proactive-opening request carries an optional locale.

use super::ProactiveOpeningRequest;

#[test]
fn request_without_a_locale_still_deserialises() {
    let req: ProactiveOpeningRequest =
        serde_json::from_value(serde_json::json!({ "conversation_id": "c1" }))
            .expect("older callers send no locale");
    assert_eq!(req.conversation_id, "c1");
    assert_eq!(req.locale, None);
}

#[test]
fn request_carries_the_channel_owner_locale() {
    let req: ProactiveOpeningRequest = serde_json::from_value(serde_json::json!({
        "conversation_id": "telegram-42",
        "agent_id": "ryu",
        "idempotency_key": "ryu-opening:v1:telegram:42",
        "locale": "ja",
    }))
    .expect("locale is accepted");
    assert_eq!(req.locale.as_deref(), Some("ja"));
}
