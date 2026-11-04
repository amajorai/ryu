use crate::server::parse_auto_recall_enabled;

#[test]
fn default_on_when_unset() {
    assert!(parse_auto_recall_enabled(None));
}

#[test]
fn explicit_disable_tokens_turn_it_off() {
    for v in ["false", "0", "off", "no", "FALSE", "Off", " no "] {
        assert!(
            !parse_auto_recall_enabled(Some(v)),
            "{v:?} should disable auto-recall"
        );
    }
}

#[test]
fn enabled_tokens_and_garbage_stay_on() {
    for v in ["true", "1", "on", "yes", "", "anything"] {
        assert!(
            parse_auto_recall_enabled(Some(v)),
            "{v:?} should keep auto-recall on"
        );
    }
}
