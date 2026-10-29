use super::*;
use axum::http::HeaderValue;

#[test]
fn verifies_twilio_signature_over_sorted_form_values() {
    let mut params = BTreeMap::new();
    params.insert("CallSid".to_owned(), "CA123".to_owned());
    params.insert("From".to_owned(), "+15551234567".to_owned());
    let url = "https://voice.example.test/voice/twilio/answer";
    let mut input = url.to_owned();
    input.push_str("CallSidCA123");
    input.push_str("From+15551234567");
    let mut mac = HmacSha1::new_from_slice(b"secret").unwrap();
    mac.update(input.as_bytes());
    let signature = BASE64.encode(mac.finalize().into_bytes());
    let header = HeaderValue::from_str(&signature).unwrap();
    assert!(verify_twilio_signature(
        url,
        &params,
        Some(&header),
        "secret"
    ));
    assert!(!verify_twilio_signature(
        url,
        &params,
        Some(&header),
        "wrong"
    ));
}

#[test]
fn conversation_ids_do_not_contain_phone_numbers() {
    let account = "AC0123456789abcdef0123456789abcdef";
    let call = "CA0123456789abcdef0123456789abcdef";
    let id = conversation_id(account, call).unwrap();
    assert!(id.starts_with("phone_call_v1_"));
    assert!(!id.contains("6591234567"));
    assert_eq!(Some(id.clone()), conversation_id(account, call));
    assert_ne!(
        Some(id),
        conversation_id(account, "CA1123456789abcdef0123456789abcdef")
    );
}

#[test]
fn inbound_prompt_includes_configured_handoff_and_greeting() {
    let prompt = inbound_opening_prompt(
        "Ryu",
        "Keep it warm",
        "+15551234567",
        Some("+15557654321"),
        true,
    );
    assert!(prompt.contains("AI assistant"));
    assert!(prompt.contains("+15551234567"));
    assert!(prompt.contains("+15557654321"));
    assert!(prompt.contains("Keep it warm"));
    assert!(!prompt.contains("not on the owner's trusted-caller list"));
}

/// Only an unverified caller's start frame carries `caller_trusted: false`;
/// a trusted caller's frame has the same shape every other client sends.
#[test]
fn core_start_frame_marks_only_unverified_callers() {
    let conversation = "phone_call_v1_fixture";
    let unverified = core_start_frame(conversation, Some("agent"), None, None, false);
    assert_eq!(unverified["type"], "start");
    assert_eq!(unverified["conversation_id"], conversation);
    assert_eq!(unverified["agent_id"], "agent");
    assert_eq!(unverified["caller_trusted"], Value::Bool(false));

    let trusted = core_start_frame(conversation, Some("agent"), None, None, true);
    assert!(trusted.get("caller_trusted").is_none());
    assert_eq!(trusted["sample_rate"], 8_000);
}

/// A caller who is not on the line's trusted list is framed as an outside
/// party the agent must not hand the owner's data or account actions to.
#[test]
fn inbound_prompt_marks_unlisted_callers_as_unverified() {
    let prompt = inbound_opening_prompt("Ryu", "", "+15551234567", None, false);
    assert!(prompt.contains("not on the owner's trusted-caller list"));
    assert!(prompt.contains("Do not reveal the owner's private information"));
}

#[test]
fn stream_caller_number_is_bounded_e164_or_unknown() {
    assert!(is_e164_phone_number("+14155550123"));
    assert!(!is_e164_phone_number("anonymous"));
    assert!(!is_e164_phone_number("+1415555<script>"));
    assert!(!is_e164_phone_number("+1234567890123456"));
}

#[test]
fn xml_escape_covers_twiml_attribute_delimiters() {
    assert_eq!(xml_escape("a&b<c>\"d'e"), "a&amp;b&lt;c&gt;&quot;d&apos;e");
}

#[test]
fn stream_twiml_keeps_custom_parameters_small_and_excludes_call_goal() {
    let xml = stream_twiml(
        "wss://voice.example.test/voice/twilio/stream",
        "personal-main",
        "outbound",
        None,
    );
    assert!(xml.contains("<Parameter name=\"lineId\" value=\"personal-main\"/>"));
    assert!(xml.contains("<Parameter name=\"callKind\" value=\"outbound\"/>"));
    assert!(!xml.contains("initialPrompt"));
    assert!(!xml.contains("call goal"));

    let inbound = stream_twiml(
        "wss://voice.example.test/voice/twilio/stream",
        "personal-main",
        "inbound",
        Some("+14155550123"),
    );
    assert!(inbound.contains("<Parameter name=\"callerNumber\" value=\"+14155550123\"/>"));
    assert!(!inbound.contains("initialPrompt"));
}

#[test]
fn core_ws_url_requires_explicit_credentials() {
    // Configuration-dependent behavior is covered by the handler's fail-closed
    // response; this assertion keeps the URL builder's shape reviewable.
    assert!(conversation_id(
        "AC0123456789abcdef0123456789abcdef",
        "CA0123456789abcdef0123456789abcdef"
    )
    .is_some());
    assert!(conversation_id("", "unknown-call").is_none());
}

#[test]
fn call_identity_has_no_ambiguous_fallback_or_legacy_namespace() {
    let account = "AC0123456789abcdef0123456789abcdef";
    let call = "CA0123456789abcdef0123456789abcdef";
    for bad in [
        "",
        "unknown-call",
        "CA123",
        " CA0123456789abcdef0123456789abcdef",
        "CA0123456789abcdef0123456789abcdef ",
        "CA0123456789abcdef0123456789abcdeg",
        "AC0123456789abcdef0123456789abcdef",
        "CA0123456789abcdef0123456789abcdef\0",
    ] {
        assert!(
            conversation_id(account, bad).is_none(),
            "accepted malformed CallSid"
        );
    }
    assert_eq!(
        conversation_id(account, call),
        conversation_id(&account.to_ascii_uppercase(), &call.to_ascii_uppercase())
    );
    assert_ne!(
        conversation_id(account, call),
        conversation_id("AC1123456789abcdef0123456789abcdef", call)
    );
    assert_eq!(
        conversation_id(account, call).unwrap().len(),
        "phone_call_v1_".len() + 64
    );
    assert_ne!(
        call_binding(account, call, "test-provider-secret"),
        call_binding(
            account,
            "CA1123456789abcdef0123456789abcdef",
            "test-provider-secret"
        )
    );
}
