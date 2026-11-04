use crate::server::parse_fts_recall_enabled;

#[test]
fn default_off_when_unset() {
    assert!(!parse_fts_recall_enabled(None));
}

#[test]
fn explicit_enable_tokens_turn_it_on() {
    for v in ["true", "1", "on", "yes", "TRUE", "On", " yes "] {
        assert!(
            parse_fts_recall_enabled(Some(v)),
            "{v:?} should enable fts recall"
        );
    }
}

#[test]
fn disable_tokens_and_garbage_stay_off() {
    for v in ["false", "0", "off", "no", "", "anything"] {
        assert!(
            !parse_fts_recall_enabled(Some(v)),
            "{v:?} should keep fts recall off"
        );
    }
}
