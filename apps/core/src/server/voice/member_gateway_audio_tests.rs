use super::*;

#[test]
fn an_explicit_gateway_selector_is_detected_whatever_the_default() {
    for requested in ["gateway", " gateway ", "Gateway", "GATEWAY"] {
        assert!(
            selects_gateway_engine(Some(requested), || "kokoro".to_owned()),
            "{requested}"
        );
    }
}

#[test]
fn an_unset_or_blank_selector_follows_the_node_default() {
    for requested in [None, Some(""), Some("   ")] {
        assert!(selects_gateway_engine(requested, || "gateway".to_owned()));
        assert!(selects_gateway_engine(requested, || " Gateway ".to_owned()));
        assert!(!selects_gateway_engine(requested, || "parakeet".to_owned()));
    }
}

#[test]
fn a_named_local_engine_ignores_a_gateway_default() {
    for requested in ["parakeet", "whisper", "audiocpp", "kokoro", "outetts"] {
        assert!(
            !selects_gateway_engine(Some(requested), || "gateway".to_owned()),
            "{requested}"
        );
    }
}

#[test]
fn the_public_helpers_detect_an_explicit_gateway_engine() {
    assert!(stt_engine_uses_gateway(Some("gateway")));
    assert!(tts_engine_uses_gateway(Some("gateway")));
    assert!(!stt_engine_uses_gateway(Some("whisper")));
    assert!(!tts_engine_uses_gateway(Some("outetts")));
}
