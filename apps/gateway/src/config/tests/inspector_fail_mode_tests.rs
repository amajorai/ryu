//! `inspector.fail_mode`: its default follows the action, an explicit value
//! wins, and the wire form is lowercase.
use super::{FirewallPolicy, InspectorConfig, InspectorFailMode};

fn with(action: FirewallPolicy, fail_mode: Option<InspectorFailMode>) -> InspectorConfig {
    InspectorConfig {
        action,
        fail_mode,
        ..InspectorConfig::default()
    }
}

#[test]
fn unset_fail_mode_is_closed_under_block_and_open_otherwise() {
    let default = InspectorConfig::default();
    assert_eq!(default.fail_mode, None);
    assert_eq!(default.action, FirewallPolicy::Block);
    assert_eq!(default.effective_fail_mode(), InspectorFailMode::Closed);
    assert_eq!(
        with(FirewallPolicy::Sanitize, None).effective_fail_mode(),
        InspectorFailMode::Open
    );
    assert_eq!(
        with(FirewallPolicy::WarnAndContinue, None).effective_fail_mode(),
        InspectorFailMode::Open
    );
}

#[test]
fn explicit_open_wins_under_block() {
    let cfg = with(FirewallPolicy::Block, Some(InspectorFailMode::Open));
    assert_eq!(cfg.effective_fail_mode(), InspectorFailMode::Open);
}

#[test]
fn explicit_closed_wins_under_sanitize_and_warn() {
    for action in [FirewallPolicy::Sanitize, FirewallPolicy::WarnAndContinue] {
        let cfg = with(action.clone(), Some(InspectorFailMode::Closed));
        assert_eq!(
            cfg.effective_fail_mode(),
            InspectorFailMode::Closed,
            "{action:?}"
        );
    }
}

#[test]
fn fail_mode_parses_lowercase_and_defaults_from_the_action() {
    let open: InspectorConfig =
        toml::from_str("action = \"block\"\nfail_mode = \"open\"\n").unwrap();
    assert_eq!(open.fail_mode, Some(InspectorFailMode::Open));
    assert_eq!(open.effective_fail_mode(), InspectorFailMode::Open);

    let closed: InspectorConfig = serde_json::from_value(
        serde_json::json!({"action": "warn_and_continue", "fail_mode": "closed"}),
    )
    .unwrap();
    assert_eq!(closed.effective_fail_mode(), InspectorFailMode::Closed);

    let unset: InspectorConfig = toml::from_str("action = \"sanitize\"\n").unwrap();
    assert_eq!(unset.fail_mode, None);
    assert_eq!(unset.effective_fail_mode(), InspectorFailMode::Open);

    assert!(toml::from_str::<InspectorConfig>("fail_mode = \"Closed\"\n").is_err());
    assert!(toml::from_str::<InspectorConfig>("fail_mode = \"degraded\"\n").is_err());
}

#[test]
fn fail_mode_round_trips_and_an_unset_value_stays_unset() {
    for fail_mode in [
        None,
        Some(InspectorFailMode::Open),
        Some(InspectorFailMode::Closed),
    ] {
        let cfg = with(FirewallPolicy::Block, fail_mode);
        let text = toml::to_string(&cfg).unwrap();
        assert_eq!(text.contains("fail_mode"), fail_mode.is_some(), "{text}");
        let back: InspectorConfig = toml::from_str(&text).unwrap();
        assert_eq!(back, cfg);
        let json = serde_json::to_value(&cfg).unwrap();
        let back: InspectorConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back, cfg);
    }
    let json =
        serde_json::to_value(with(FirewallPolicy::Block, Some(InspectorFailMode::Closed))).unwrap();
    assert_eq!(json["fail_mode"], "closed");
}

#[test]
fn a_locked_merge_keeps_closed_from_either_side() {
    let closed = with(FirewallPolicy::Block, None);
    let open = with(FirewallPolicy::Block, Some(InspectorFailMode::Open));
    let warn = with(FirewallPolicy::WarnAndContinue, None);
    let warn_closed = with(
        FirewallPolicy::WarnAndContinue,
        Some(InspectorFailMode::Closed),
    );
    assert_eq!(
        closed.stricter_fail_mode(&open),
        Some(InspectorFailMode::Closed)
    );
    assert_eq!(
        warn.stricter_fail_mode(&warn_closed),
        Some(InspectorFailMode::Closed)
    );
    assert_eq!(
        open.stricter_fail_mode(&warn),
        Some(InspectorFailMode::Open)
    );
    assert_eq!(warn.stricter_fail_mode(&warn), None);
}
