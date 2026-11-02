use super::*;

#[test]
fn s1_payload_matches_the_published_input_contract() {
    let request = SpeechProcessingRequest {
        text: "so um send the report by uh friday".to_owned(),
        engine: None,
        styling: Some("semi-formal".to_owned()),
        structure: Some("prose".to_owned()),
        context: Some("general".to_owned()),
    };
    let payload = s1_payload("s1-mini-q4_k_m", &request).expect("valid S1 request");
    assert_eq!(payload["model"], "s1-mini-q4_k_m");
    assert_eq!(payload["temperature"], 0);
    assert_eq!(payload["stream"], false);
    assert_eq!(payload["chat_template_kwargs"]["enable_thinking"], false);
    assert_eq!(payload["messages"][0]["content"], S1_MINI_SYSTEM_PROMPT);
    assert_eq!(
        payload["messages"][1]["content"],
        "[Styling: semi-formal] [Structure: prose] [Context: general]\nso um send the report by uh friday"
    );
}

#[test]
fn s1_payload_applies_defaults_and_rejects_unknown_controls() {
    let defaults = SpeechProcessingRequest {
        text: "hello".to_owned(),
        engine: Some("s1-mini".to_owned()),
        styling: None,
        structure: None,
        context: None,
    };
    let payload = s1_payload("s1-mini-q4_k_m", &defaults).expect("defaults are valid");
    assert_eq!(
        payload["messages"][1]["content"],
        "[Styling: semi-formal] [Structure: prose] [Context: general]\nhello"
    );

    let mut invalid = defaults;
    invalid.styling = Some("creative".to_owned());
    assert!(s1_payload("s1-mini-q4_k_m", &invalid)
        .unwrap_err()
        .contains("unsupported S1-mini styling"));

    let mut unknown_engine = invalid;
    unknown_engine.styling = None;
    unknown_engine.engine = Some("chat".to_owned());
    assert!(s1_payload("s1-mini-q4_k_m", &unknown_engine)
        .unwrap_err()
        .contains("unknown Speech Processing engine"));
}

#[test]
fn s1_payload_rejects_empty_transcripts() {
    let request = SpeechProcessingRequest {
        text: "   ".to_owned(),
        engine: None,
        styling: None,
        structure: None,
        context: None,
    };
    assert_eq!(
        s1_payload("s1-mini-q4_k_m", &request).unwrap_err(),
        "missing `text` (the raw transcript to clean)"
    );
}
