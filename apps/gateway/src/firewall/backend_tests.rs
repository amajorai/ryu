//! Dispatch tests for [`super::FirewallRegistry`] and [`super::FirewallBackend`].

use super::*;
use crate::config::FirewallConfig;

/// A stub backend answering every scan with a fixed sentinel — proof the
/// registry dispatches to a swapped-in impl.
struct StubFirewall {
    cfg: FirewallConfig,
    policy: FirewallPolicy,
}
impl FirewallBackend for StubFirewall {
    fn config(&self) -> &FirewallConfig {
        &self.cfg
    }
    fn policy(&self) -> &FirewallPolicy {
        &self.policy
    }
    fn outbound_enabled(&self) -> bool {
        true
    }
    fn scan_inbound(&self, _text: &str) -> Option<FirewallMatch> {
        Some(FirewallMatch {
            pattern_name: "stub".to_string(),
            kind: DetectionKind::Secret,
        })
    }
    fn scan_outbound(&self, _text: &str) -> Option<FirewallMatch> {
        None
    }
    fn scan_locked_guardrails(&self, _text: &str, _guardrails: &[String]) -> Option<FirewallMatch> {
        None
    }
    fn sanitize(&self, _text: &str) -> String {
        "REDACTED".to_string()
    }
    fn redact_outbound(&self, _text: &str) -> (String, Vec<&'static str>) {
        ("REDACTED".to_string(), vec!["stub"])
    }
}

#[test]
fn builtin_is_the_default_active_backend() {
    let reg = FirewallRegistry::new(FirewallConfig::default());
    assert_eq!(reg.active_id(), FirewallRegistry::BUILTIN);
    assert_eq!(reg.available(), vec![FirewallRegistry::BUILTIN.to_string()]);
    // The built-in reports its config through the trait.
    reg.with_active(|b| {
        let _ = b.config();
    });
}

#[test]
fn update_config_hot_swaps_the_builtin_live() {
    // Start explicitly disabled (independent of the default's enabled state).
    let reg = FirewallRegistry::new(FirewallConfig {
        enabled: false,
        ..FirewallConfig::default()
    });
    assert!(!reg.with_active(|b| b.config().enabled));
    // Push an enabled config → the live built-in reflects it with no restart.
    reg.update_config(FirewallConfig {
        enabled: true,
        ..FirewallConfig::default()
    });
    assert!(reg.with_active(|b| b.config().enabled));
}

#[test]
fn register_then_set_active_swaps_the_live_backend() {
    let reg = FirewallRegistry::new(FirewallConfig::default());
    let stub = std::sync::Arc::new(StubFirewall {
        cfg: FirewallConfig::default(),
        policy: FirewallPolicy::default(),
    });
    reg.register("stub", stub as std::sync::Arc<dyn FirewallBackend>);
    // Registered but not active: the built-in (disabled default) answers None.
    assert!(reg.with_active(|b| b.scan_inbound("hi")).is_none());

    assert!(reg.set_active("stub"));
    assert_eq!(reg.active_id(), "stub");
    // The stub's sentinel now answers — the swap is live.
    assert!(reg.with_active(|b| b.scan_inbound("hi")).is_some());
    assert_eq!(reg.with_active(|b| b.sanitize("x")), "REDACTED");

    // Unknown id is a no-op keeping the current active backend.
    assert!(!reg.set_active("nope"));
    assert_eq!(reg.active_id(), "stub");
}
