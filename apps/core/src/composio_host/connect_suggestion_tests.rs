use super::streaming_privacy_output;
use super::suggestion::{
    bounded_connect_event_json, build_connect_suggestion_prompt, connect_suggestion_payload,
    parse_connect_suggestion, redact_sensitive_text, sanitize_connect_event, sensitive_event_key,
    MAX_CONNECT_EVENT_PROMPT_BYTES,
};
use serde_json::json;

#[test]
fn event_payload_redacts_secret_fields_and_code_like_values() {
    let payload = json!({
        "data": {
            "verification_code": "683474",
            "body": "Your reset code is 683474 and it expires in 30 minutes.",
            "message": "session=eyJhbGciOiJIUzI1NiJ9",
            "authorization": "Bearer header.payload.signature",
            "details": "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
            "api_key": "ghp_0123456789abcdefghijkl",
            "notes": "Forwarded Bearer header.payload.signature and ghp_0123456789abcdefghijkl https://example.com/password-reset?token=opaque-reset-value",
            "raw_jwt": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"
        }
    });

    let sanitized = sanitize_connect_event(&payload);
    let serialized = serde_json::to_string(&sanitized).unwrap();
    assert!(!serialized.contains("683474"));
    assert!(!serialized.contains("eyJhbGciOiJIUzI1NiJ9"));
    assert!(!serialized.contains("header.payload.signature"));
    assert!(!serialized.contains("ghp_0123456789abcdefghijkl"));
    assert!(!serialized.contains("eyJzdWIiOiIxIn0"));
    assert!(!serialized.contains("example.com/password-reset"));
    assert!(!serialized.contains("opaque-reset-value"));
    assert!(serialized.contains("30 minutes"));
    assert!(sensitive_event_key("verificationCode"));
    assert!(sensitive_event_key("password_reset_code"));
}

#[test]
fn model_can_suppress_irrelevant_events() {
    assert!(parse_connect_suggestion("NO_SUGGESTION").is_none());
    assert!(parse_connect_suggestion(r#"{"suggest":false}"#).is_none());
    assert!(parse_connect_suggestion("not json").is_none());
}

#[test]
fn model_suggestion_is_bounded_and_secret_values_are_removed() {
    let output = r#"{"suggest":true,"title":"Reset request","body":"A verification code 683474 is valid for 30 minutes; open the source app to view it."}"#;
    let suggestion = parse_connect_suggestion(output).unwrap();
    assert_eq!(suggestion.title, "Reset request");
    assert!(!suggestion.body.contains("683474"));
    assert!(suggestion.body.contains("30 minutes"));
    assert!(suggestion.body.contains("[redacted]"));
    assert!(redact_sensitive_text("token=secret-value").contains("[redacted]"));
}

#[test]
fn streaming_withholds_event_data_and_uses_a_generic_alert() {
    let payload = json!({
        "subject": "Password reset for private@example.com",
        "code": "683474"
    });
    assert_eq!(connect_suggestion_payload(&payload, true).unwrap(), None);

    let suggestion = parse_connect_suggestion(&streaming_privacy_output()).unwrap();
    assert_eq!(suggestion.title, "Private connected-app activity");
    assert!(suggestion.body.contains("Review it in the source app"));
    assert!(!suggestion.body.contains("private@example.com"));
    assert!(!suggestion.body.contains("683474"));
}

#[test]
fn event_prompt_is_bounded_and_keeps_agent_guidance_out_of_event_data() {
    let payload = serde_json::json!({"message": "x".repeat(40_000)});
    let event = bounded_connect_event_json(&payload).unwrap();
    assert!(event.len() <= MAX_CONNECT_EVENT_PROMPT_BYTES);
    assert!(event.contains("\"truncated\":true"));

    let prompt = build_connect_suggestion_prompt(
        Some("Write in a calm, direct tone."),
        "{\"message\":\"reset requested\"}",
        "en",
    );
    assert!(prompt.contains("calm, direct tone"));
    assert!(prompt.contains("<<<EXTERNAL_UNTRUSTED_CONTENT>>>"));
    assert!(prompt.contains("No tools or external actions are available"));
    assert!(!prompt.contains("Write the title and body in"));
}

#[test]
fn suggestion_prompt_names_the_ui_language_and_keeps_keys_english() {
    let prompt = build_connect_suggestion_prompt(None, "{\"message\":\"hi\"}", "ja");
    assert!(prompt.contains(
        "Write the title and body in Japanese; keep the JSON keys and NO_SUGGESTION in English."
    ));
    assert!(prompt.contains("NO_SUGGESTION"));
    assert!(prompt.contains("\"suggest\":true,\"title\""));
    // The language line sits in the instructions, before the untrusted event.
    let language_at = prompt.find("Japanese").unwrap();
    let event_at = prompt.find("Redacted event payload").unwrap();
    assert!(language_at < event_at);
}
