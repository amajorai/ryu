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

/// A plugin backend with no `redact_excerpt` of its own: its sanitize only
/// rewrites one plain ASCII address, its outbound scrub does nothing, and its
/// own `pii` scan only knows the word `CUSTOMERID`.
struct NaivePlugin {
    cfg: FirewallConfig,
    policy: FirewallPolicy,
}
impl FirewallBackend for NaivePlugin {
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
        None
    }
    fn scan_outbound(&self, _text: &str) -> Option<FirewallMatch> {
        None
    }
    fn scan_locked_guardrails(&self, text: &str, guardrails: &[String]) -> Option<FirewallMatch> {
        (guardrails.iter().any(|g| g == "pii") && text.contains("CUSTOMERID")).then(|| {
            FirewallMatch {
                pattern_name: "customer_id".to_string(),
                kind: DetectionKind::Pii,
            }
        })
    }
    fn sanitize(&self, text: &str) -> String {
        text.replace("alice@example.com", "[EMAIL]")
    }
    fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>) {
        (text.to_string(), Vec::new())
    }
}

fn naive_plugin() -> NaivePlugin {
    NaivePlugin {
        cfg: FirewallConfig::default(),
        policy: FirewallPolicy::default(),
    }
}

/// review-plugin-firewall-excerpt: a plugin backend without its own excerpt
/// redactor never stores PII or a secret its sanitize missed. What it
/// redacts is kept; a fullwidth spelling is folded and redacted again; what
/// survives either scan (the plugin's or the built-in's normalized one)
/// drops the excerpt.
#[test]
fn a_plugin_backend_without_redact_excerpt_drops_survivors() {
    let backend: &dyn FirewallBackend = &naive_plugin();
    assert_eq!(backend.redact_excerpt("nothing to hide"), "nothing to hide");
    assert_eq!(
        backend.redact_excerpt("mail alice@example.com"),
        "mail [EMAIL]"
    );
    // The plugin's sanitize misses the fullwidth `@`; the fold makes it ASCII.
    assert_eq!(
        backend.redact_excerpt("mail alice\u{FF20}example.com"),
        "mail [EMAIL]"
    );
    // PII the plugin never redacts survives both passes: dropped.
    assert_eq!(backend.redact_excerpt("ssn 123-45-6789"), "");
    assert_eq!(backend.redact_excerpt("ssn 123\u{200B}-45-6789"), "");
    let secret = "key ghp_abcdefghijklmnopqrstuvwxyz0123456789"; // Test vector, not a credential. gitleaks:allow skipcq
    assert_eq!(backend.redact_excerpt(secret), "");
    // The plugin's own detection also drops what the built-in cannot see.
    assert_eq!(backend.redact_excerpt("CUSTOMERID 42"), "");
}

fn operator_config(kind: crate::config::CustomPatternKind) -> FirewallConfig {
    FirewallConfig {
        custom_patterns: vec![crate::config::CustomPattern {
            name: "employee_id".to_string(),
            regex: r"EMP-\d{6}".to_string(),
            kind,
        }],
        ..FirewallConfig::default()
    }
}

fn registry_with_active_plugin(config: FirewallConfig) -> FirewallRegistry {
    let reg = FirewallRegistry::new(config);
    reg.register("naive", std::sync::Arc::new(naive_plugin()));
    assert!(reg.set_active("naive"));
    reg
}

/// plugin-excerpt-custom-patterns: the survivor check a plugin excerpt
/// passes also uses the operator's custom PII and secret patterns, on the
/// normalized view; what the plugin and the curated sets miss is dropped.
#[test]
fn a_plugin_excerpt_with_a_custom_pii_or_secret_survivor_is_dropped() {
    use crate::config::CustomPatternKind;
    for kind in [CustomPatternKind::Pii, CustomPatternKind::Secret] {
        let reg = registry_with_active_plugin(operator_config(kind));
        assert_eq!(
            reg.with_active(|b| b.redact_excerpt("badge EMP-123456")),
            ""
        );
        assert_eq!(
            reg.with_active(|b| b.redact_excerpt("badge EMP\u{200B}-123456")),
            ""
        );
        assert_eq!(
            reg.with_active(|b| b.redact_excerpt("mail alice@example.com")),
            "mail [EMAIL]"
        );
        assert_eq!(reg.with_active(|b| b.redact_excerpt("nothing")), "nothing");
    }
    // Only PII and secret kinds join the survivor set.
    let reg = registry_with_active_plugin(operator_config(CustomPatternKind::Toxicity));
    assert_eq!(
        reg.with_active(|b| b.redact_excerpt("badge EMP-123456")),
        "badge EMP-123456"
    );
}

/// `PUT /v1/config` rebuilds the survivor set under an active plugin, and a
/// plugin registered after the config change is guarded with it too.
#[test]
fn update_config_rebuilds_the_plugin_excerpt_survivor_set() {
    let reg = registry_with_active_plugin(FirewallConfig::default());
    let excerpt = "badge EMP-123456";
    assert_eq!(reg.with_active(|b| b.redact_excerpt(excerpt)), excerpt);
    reg.update_config(operator_config(crate::config::CustomPatternKind::Pii));
    assert_eq!(reg.active_id(), "naive");
    assert_eq!(reg.with_active(|b| b.redact_excerpt(excerpt)), "");
    reg.register("naive", std::sync::Arc::new(naive_plugin()));
    assert_eq!(reg.with_active(|b| b.redact_excerpt(excerpt)), "");
    // Every other call is still the plugin's own.
    assert_eq!(
        reg.with_active(|b| b.sanitize("alice@example.com")),
        "[EMAIL]"
    );
    // Back on the built-in, its own custom pattern redacts in place.
    assert!(reg.set_active(FirewallRegistry::BUILTIN));
    assert_eq!(
        reg.with_active(|b| b.redact_excerpt(excerpt)),
        "badge [REDACTED:EMPLOYEE_ID]"
    );
}

/// A plugin with its own `redact_excerpt` that keeps everything: the
/// operator survivor check still runs after it.
struct KeepAllExcerpts(NaivePlugin);
impl FirewallBackend for KeepAllExcerpts {
    fn config(&self) -> &FirewallConfig {
        self.0.config()
    }
    fn policy(&self) -> &FirewallPolicy {
        self.0.policy()
    }
    fn outbound_enabled(&self) -> bool {
        true
    }
    fn scan_inbound(&self, text: &str) -> Option<FirewallMatch> {
        self.0.scan_inbound(text)
    }
    fn scan_outbound(&self, text: &str) -> Option<FirewallMatch> {
        self.0.scan_outbound(text)
    }
    fn scan_locked_guardrails(&self, text: &str, guardrails: &[String]) -> Option<FirewallMatch> {
        self.0.scan_locked_guardrails(text, guardrails)
    }
    fn sanitize(&self, text: &str) -> String {
        self.0.sanitize(text)
    }
    fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>) {
        self.0.redact_outbound(text)
    }
    fn redact_excerpt(&self, text: &str) -> String {
        text.to_string()
    }
}

/// The survivor check also covers a plugin with its own excerpt redactor,
/// and a plugin registered under the built-in's id cannot pass for the
/// built-in and skip it.
#[test]
fn a_plugin_with_its_own_excerpt_redactor_or_the_builtin_id_is_still_guarded() {
    let excerpt = "badge EMP-123456";
    let reg = FirewallRegistry::new(operator_config(crate::config::CustomPatternKind::Pii));
    reg.register("keep", std::sync::Arc::new(KeepAllExcerpts(naive_plugin())));
    assert!(reg.set_active("keep"));
    assert_eq!(reg.with_active(|b| b.redact_excerpt(excerpt)), "");
    assert_eq!(reg.with_active(|b| b.redact_excerpt("ssn 123-45-6789")), "");
    assert_eq!(reg.with_active(|b| b.redact_excerpt("nothing")), "nothing");

    let reg = FirewallRegistry::new(operator_config(crate::config::CustomPatternKind::Pii));
    reg.register(
        FirewallRegistry::BUILTIN,
        std::sync::Arc::new(KeepAllExcerpts(naive_plugin())),
    );
    assert_eq!(reg.active_id(), FirewallRegistry::BUILTIN);
    assert_eq!(reg.with_active(|b| b.redact_excerpt(excerpt)), "");
    assert_eq!(reg.with_active(|b| b.redact_excerpt("nothing")), "nothing");
}
