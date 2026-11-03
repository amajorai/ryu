//! Resolver tests: alert tiers, custom patterns and locked policies across scopes.

use super::tests::{base, unlocked_base};
use super::*;
use crate::config::{CustomPattern, CustomPatternKind, FirewallPolicy};

/// `alert` is the trigger for the ENTIRE alert fan-out (`pipeline/mod.rs`
/// ::`firewall_policy_alert` gates on `cfg.alert >= AlertTier::Warn`), and the node
/// base defaults it to `Silent`. So overlay resolution for this field is what makes
/// org/agent-scoped delivery possible at all.
#[test]
fn alert_tier_resolves_through_the_cascade() {
    let r = FirewallResolver::new(unlocked_base());
    assert_eq!(
        r.resolve(None, None, None).alert,
        AlertTier::Silent,
        "the node base default is Silent — nothing is delivered until a scope raises it"
    );

    // Org raises it; the agent leaf leaves it None and therefore inherits.
    let mut agent_overlays = HashMap::new();
    agent_overlays.insert("a1".to_string(), FirewallOverlay::default());
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            alert: Some(AlertTier::Fanout),
            ..Default::default()
        }),
        agent_overlays,
    };
    assert_eq!(
        r.resolve(Some("o1"), Some("a1"), Some(&bundle)).alert,
        AlertTier::Fanout,
        "None at the leaf inherits the org tier"
    );

    // An UNLOCKED tier is a plain override in both directions: the leaf may go
    // louder…
    let mut agent_overlays = HashMap::new();
    agent_overlays.insert(
        "a1".to_string(),
        FirewallOverlay {
            alert: Some(AlertTier::Email),
            ..Default::default()
        },
    );
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            alert: Some(AlertTier::Warn),
            ..Default::default()
        }),
        agent_overlays,
    };
    assert_eq!(
        r.resolve(Some("o1"), Some("a1"), Some(&bundle)).alert,
        AlertTier::Email
    );

    // …and quieter, including all the way back to Silent. `alert` is deliberately
    // NOT in `default_firewall_locked_fields` (it is a notification dial, not one of
    // the protection dials whose loosening disables the firewall), so this is the
    // default posture and a scope CAN opt out of noise.
    let mut agent_overlays = HashMap::new();
    agent_overlays.insert(
        "a1".to_string(),
        FirewallOverlay {
            alert: Some(AlertTier::Silent),
            ..Default::default()
        },
    );
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            alert: Some(AlertTier::Email),
            ..Default::default()
        }),
        agent_overlays,
    };
    assert_eq!(
        r.resolve(Some("o1"), Some("a1"), Some(&bundle)).alert,
        AlertTier::Silent
    );
}

/// A LOCKED broader scope: once locked, a narrower scope may only raise the tier.
/// Same rule as every other locked field, expressed in `AlertTier`'s ascending-
/// severity `Ord` (`louder_alert` = `max`, mirroring `apply_bool`'s `||`).
#[test]
fn locked_alert_tier_can_only_be_raised() {
    // Locked at the NODE base, so both narrower scopes are constrained.
    let node = FirewallConfig {
        alert: AlertTier::Fanout,
        locked_fields: vec!["alert".into()],
        ..FirewallConfig::default()
    };
    let r = FirewallResolver::new(node);

    // Going quieter is refused at the org level…
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            alert: Some(AlertTier::Silent),
            ..Default::default()
        }),
        agent_overlays: HashMap::new(),
    };
    assert_eq!(
        r.resolve(Some("o1"), None, Some(&bundle)).alert,
        AlertTier::Fanout,
        "a locked tier cannot be silenced by a narrower scope"
    );

    // …and at the agent leaf, even when the org already tried.
    let mut agent_overlays = HashMap::new();
    agent_overlays.insert(
        "a1".to_string(),
        FirewallOverlay {
            alert: Some(AlertTier::Warn),
            ..Default::default()
        },
    );
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            alert: Some(AlertTier::Silent),
            ..Default::default()
        }),
        agent_overlays,
    };
    assert_eq!(
        r.resolve(Some("o1"), Some("a1"), Some(&bundle)).alert,
        AlertTier::Fanout,
        "Warn < Fanout is still a loosening"
    );

    // Raising it is allowed — a lock is a floor, not a pin.
    let mut agent_overlays = HashMap::new();
    agent_overlays.insert(
        "a1".to_string(),
        FirewallOverlay {
            alert: Some(AlertTier::Email),
            ..Default::default()
        },
    );
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            alert: Some(AlertTier::Silent),
            ..Default::default()
        }),
        agent_overlays,
    };
    assert_eq!(
        r.resolve(Some("o1"), Some("a1"), Some(&bundle)).alert,
        AlertTier::Email
    );

    // A lock authored by the ORG binds the agent leaf too (locks union upward).
    let r = FirewallResolver::new(unlocked_base());
    let mut agent_overlays = HashMap::new();
    agent_overlays.insert(
        "a1".to_string(),
        FirewallOverlay {
            alert: Some(AlertTier::Warn),
            ..Default::default()
        },
    );
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            alert: Some(AlertTier::Email),
            locked_fields: vec!["alert".into()],
            ..Default::default()
        }),
        agent_overlays,
    };
    let cfg = r.resolve(Some("o1"), Some("a1"), Some(&bundle));
    assert_eq!(
        cfg.alert,
        AlertTier::Email,
        "the org's lock survives into the leaf's resolution"
    );
    assert!(cfg.locked_fields.iter().any(|f| f == "alert"));
}

/// `alert` must NOT be treated like `wrap_untrusted_tool_results`: it is a real
/// per-scope value (the resolved config reaches `firewall_policy_alert` via
/// `FirewallScanner::config()`), so `normalize_overlay` must leave it — and its
/// lock — alone.
#[test]
fn normalize_overlay_keeps_alert_and_its_lock() {
    let ov = FirewallOverlay {
        alert: Some(AlertTier::Email),
        locked_fields: vec!["alert".into(), NODE_ONLY_WRAP_FIELD.into()],
        wrap_untrusted_tool_results: Some(false),
        ..Default::default()
    };
    let cleaned = normalize_overlay(&ov);
    assert_eq!(cleaned.alert, Some(AlertTier::Email));
    assert_eq!(cleaned.locked_fields, vec!["alert".to_string()]);
    assert!(cleaned.wrap_untrusted_tool_results.is_none());
}

#[test]
fn custom_patterns_union_across_scopes() {
    let mut node = base();
    node.custom_patterns.push(CustomPattern {
        name: "node_pat".into(),
        regex: r"NODE-\d+".into(),
        kind: CustomPatternKind::Pii,
    });
    let r = FirewallResolver::new(node);

    let mut agent_overlays = HashMap::new();
    agent_overlays.insert(
        "a1".to_string(),
        FirewallOverlay {
            custom_patterns: vec![CustomPattern {
                name: "agent_pat".into(),
                regex: r"AGT-\d+".into(),
                kind: CustomPatternKind::Secret,
            }],
            ..Default::default()
        },
    );
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            custom_patterns: vec![CustomPattern {
                name: "org_pat".into(),
                regex: r"ORG-\d+".into(),
                kind: CustomPatternKind::Pii,
            }],
            ..Default::default()
        }),
        agent_overlays,
    };
    let cfg = r.resolve(Some("o1"), Some("a1"), Some(&bundle));
    let names: Vec<&str> = cfg
        .custom_patterns
        .iter()
        .map(|p| p.name.as_str())
        .collect();
    assert_eq!(
        names,
        vec!["node_pat", "org_pat", "agent_pat"],
        "union/append"
    );
}

#[test]
fn locked_field_cannot_be_loosened_stricter_wins() {
    // Node locks `enabled` = true. A narrower scope trying to disable it must
    // be ignored (stricter/ON wins).
    let mut node = base();
    node.enabled = true;
    node.locked_fields = vec!["enabled".into()];
    let r = FirewallResolver::new(node);

    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            enabled: Some(false), // attempt to loosen
            ..Default::default()
        }),
        agent_overlays: HashMap::new(),
    };
    let cfg = r.resolve(Some("o1"), None, Some(&bundle));
    assert!(cfg.enabled, "locked enabled=true cannot be disabled");
    assert!(cfg.locked_fields.contains(&"enabled".to_string()));
}

#[test]
fn locked_policy_cannot_be_downgraded_but_can_tighten() {
    // Node locks `policy` at Sanitize. A narrower Warn must NOT loosen it,
    // but a narrower Block MUST tighten it.
    let mut node = base();
    node.policy = FirewallPolicy::Sanitize;
    node.locked_fields = vec!["policy".into()];
    let r = FirewallResolver::new(node);

    let loosen = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            policy: Some(FirewallPolicy::WarnAndContinue),
            ..Default::default()
        }),
        agent_overlays: HashMap::new(),
    };
    assert_eq!(
        r.resolve(Some("o"), None, Some(&loosen)).policy,
        FirewallPolicy::Sanitize,
        "cannot downgrade a locked Sanitize to Warn"
    );

    let tighten = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            policy: Some(FirewallPolicy::Block),
            ..Default::default()
        }),
        agent_overlays: HashMap::new(),
    };
    assert_eq!(
        r.resolve(Some("o"), None, Some(&tighten)).policy,
        FirewallPolicy::Block,
        "can tighten a locked Sanitize to Block"
    );
}
