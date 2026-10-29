use super::{AlertTier, BudgetRule, FirewallConfig, SessionBudgetConfig};

/// An old gateway.toml with no `alert` field must still parse, defaulting the
/// tier to `Silent` (so no policy alert fires until an operator opts in).
#[test]
fn budget_rule_without_alert_parses_to_silent() {
    let rule: BudgetRule =
        toml::from_str("limit = 1000\naction = \"stop\"\n").expect("legacy rule must parse");
    assert_eq!(rule.alert, AlertTier::Silent);
}

#[test]
fn session_budget_without_alert_parses_to_silent() {
    let cfg: SessionBudgetConfig =
        toml::from_str("limit = 500\n").expect("legacy session budget must parse");
    assert_eq!(cfg.alert, AlertTier::Silent);
}

#[test]
fn firewall_without_alert_parses_to_silent() {
    let cfg: FirewallConfig =
        toml::from_str("enabled = true\npolicy = \"block\"\n").expect("legacy firewall must parse");
    assert_eq!(cfg.alert, AlertTier::Silent);
}

/// The tier ordering is load-bearing (Core takes the max), so pin it.
#[test]
fn alert_tier_orders_ascending() {
    assert!(AlertTier::Silent < AlertTier::Warn);
    assert!(AlertTier::Warn < AlertTier::Fanout);
    assert!(AlertTier::Fanout < AlertTier::Email);
}

/// The tier serde renames to lowercase (the wire value on the debit payload
/// and the PolicyAlert JSON).
#[test]
fn alert_tier_serializes_lowercase() {
    assert_eq!(
        serde_json::to_string(&AlertTier::Fanout).unwrap(),
        "\"fanout\""
    );
}
