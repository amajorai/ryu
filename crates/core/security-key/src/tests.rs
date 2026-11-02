use crate::*;

#[test]
fn key_errors_display_their_stable_code() {
    assert_eq!(
        KeyError::PinInvalid { retries: Some(1) }.to_string(),
        "pin_required: wrong PIN (1 attempt left)"
    );
    assert_eq!(
        KeyError::PinInvalid { retries: Some(3) }.to_string(),
        "pin_required: wrong PIN (3 attempts left)"
    );
    assert_eq!(
        KeyError::PinInvalid { retries: None }.to_string(),
        "pin_required: wrong PIN"
    );
    assert!(!KeyError::PinBlocked("x".into())
        .to_string()
        .starts_with("pin_required"));
    assert_eq!(
        KeyError::Unavailable("off".into()).to_string(),
        "unavailable: off"
    );
    assert!(KeyError::Expired.to_string().starts_with("expired"));
}

#[test]
fn availability_omits_a_missing_reason() {
    let value = serde_json::to_value(Availability {
        available: true,
        platform: "macos".to_owned(),
        reason: None,
    })
    .unwrap();
    assert_eq!(
        value,
        serde_json::json!({ "available": true, "platform": "macos" })
    );
}
