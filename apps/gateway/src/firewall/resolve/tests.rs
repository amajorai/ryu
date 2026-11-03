//! Resolver tests: the additive request scope and the basic cascade.

use super::*;
use crate::config::{CustomPattern, CustomPatternKind, FirewallPolicy};

pub(super) fn base() -> FirewallConfig {
    FirewallConfig::default()
}

/// A node base with the default lock set removed, for tests exercising
/// unlocked-field precedence (default inbound and egress protection locks
/// otherwise prevent narrower scopes from disabling these fields).
pub(super) fn unlocked_base() -> FirewallConfig {
    FirewallConfig {
        locked_fields: Vec::new(),
        ..FirewallConfig::default()
    }
}

// ── request scope (`x-ryu-node-routing`): additive only ──────────────────
//
// The request scope is the one scope fed by an untrusted bearer, so these
// assert the mechanism (locked = every field), not just the outcome. An
// `unlocked_base` is used deliberately: it strips the DEFAULT locks, so a
// pass here proves the request-scope lock set is doing the work rather than
// the node's own default locks masking a loosening bug.

#[test]
fn a_request_overlay_cannot_disable_a_node_enabled_firewall() {
    let r = FirewallResolver::new(unlocked_base());
    let ov = FirewallOverlay {
        enabled: Some(false),
        scan_inbound: Some(false),
        redact_pii: Some(false),
        ..Default::default()
    };
    let cfg = r.resolve_with_request(None, None, None, Some(&ov));
    assert!(cfg.enabled, "a request must not switch the firewall off");
    assert!(cfg.scan_inbound, "nor stop inbound scanning");
    assert!(cfg.redact_pii, "nor turn redaction off");
}

#[test]
fn a_request_overlay_cannot_downgrade_block_to_warn() {
    let r = FirewallResolver::new(unlocked_base());
    let ov = FirewallOverlay {
        policy: Some(FirewallPolicy::WarnAndContinue),
        alert: Some(crate::config::AlertTier::Silent),
        ..Default::default()
    };
    let cfg = r.resolve_with_request(None, None, None, Some(&ov));
    assert_eq!(cfg.policy, FirewallPolicy::Block);
    assert_eq!(cfg.alert, unlocked_base().alert, "nor quiet the alert tier");
}

#[test]
fn a_request_overlay_may_still_tighten() {
    // Additive-only is not read-only: narrowing is the point of the knob.
    let mut node = unlocked_base();
    node.policy = FirewallPolicy::WarnAndContinue;
    node.redact_secrets = false;
    let r = FirewallResolver::new(node);
    let ov = FirewallOverlay {
        policy: Some(FirewallPolicy::Block),
        redact_secrets: Some(true),
        ..Default::default()
    };
    let cfg = r.resolve_with_request(None, None, None, Some(&ov));
    assert_eq!(cfg.policy, FirewallPolicy::Block);
    assert!(cfg.redact_secrets);
}

#[test]
fn a_request_overlay_appends_custom_patterns() {
    let r = FirewallResolver::new(unlocked_base());
    let ov = FirewallOverlay {
        custom_patterns: vec![CustomPattern {
            name: "acme_internal_id".into(),
            regex: r"ACME-\d{6}".into(),
            kind: CustomPatternKind::Pii,
        }],
        ..Default::default()
    };
    let cfg = r.resolve_with_request(None, None, None, Some(&ov));
    assert_eq!(cfg.custom_patterns.len(), 1);
    assert_eq!(cfg.custom_patterns[0].name, "acme_internal_id");
}

#[test]
fn a_request_overlay_contributes_no_locks_to_the_resolved_config() {
    // Request scope is the leaf: a lock there binds nothing, and would only
    // perturb the cache key. (The clamp clears `locked_fields` upstream; this
    // asserts the resolver does not re-introduce them either.)
    let r = FirewallResolver::new(unlocked_base());
    let ov = FirewallOverlay {
        redact_pii: Some(true),
        locked_fields: vec!["redact_pii".into()],
        ..Default::default()
    };
    let cfg = r.resolve_with_request(None, None, None, Some(&ov));
    assert!(cfg.locked_fields.is_empty());
}

#[test]
fn overlay_bearing_resolutions_never_enter_the_scanner_cache() {
    // The growth bound. `scanner_cache` is keyed by resolved-config hash and
    // invalidated only wholesale, so caching client-supplied patterns would
    // let one bearer grow it without limit by rotating them per request.
    let r = FirewallResolver::new(unlocked_base());
    let cached_before = r.scanner_cache.read().expect("cache lock").len();

    for i in 0..64 {
        let ov = FirewallOverlay {
            custom_patterns: vec![CustomPattern {
                name: format!("p{i}"),
                regex: format!("token-{i}"),
                kind: CustomPatternKind::Secret,
            }],
            ..Default::default()
        };
        let _ = r.scanner_for_request(None, None, None, Some(&ov));
    }

    assert_eq!(
        r.scanner_cache.read().expect("cache lock").len(),
        cached_before,
        "64 distinct request overlays must not add 64 cache entries"
    );
}

#[test]
fn no_request_overlay_still_shares_the_cached_scanner() {
    // The uncached branch must not cost the common path its dedup.
    let r = FirewallResolver::new(base());
    let s1 = r.scanner_for_request(None, None, None, None);
    let s2 = r.scanner_for_request(None, None, None, None);
    assert!(Arc::ptr_eq(&s1, &s2));
}

#[test]
fn node_only_resolves_to_base() {
    let r = FirewallResolver::new(base());
    let cfg = r.resolve(None, None, None);
    assert!(cfg.enabled);
    assert_eq!(cfg.policy, FirewallPolicy::Block);
    assert!(cfg.custom_patterns.is_empty());
    // The default lock set survives resolution (already sorted).
    assert_eq!(
        cfg.locked_fields,
        vec![
            "enabled",
            "policy",
            "redact_pii",
            "redact_secrets",
            "scan_inbound",
            "scan_outbound"
        ]
    );
}

#[test]
fn team_overlay_can_only_tighten_the_node_and_org() {
    let mut base = unlocked_base();
    base.enabled = true;
    base.redact_pii = false;
    let r = FirewallResolver::new(base);
    let bundle = PolicyBundle {
        platform_floor: None,
        firewall: Some(FirewallOverlay {
            policy: Some(FirewallPolicy::Sanitize),
            ..Default::default()
        }),
        team_firewall: Some(FirewallOverlay {
            // Attempted loosening: ignored.
            enabled: Some(false),
            policy: Some(FirewallPolicy::WarnAndContinue),
            redact_pii: Some(true),
            locked_fields: vec!["redact_pii".into()],
            ..Default::default()
        }),
        agent_overlays: HashMap::from([(
            "agent".to_owned(),
            FirewallOverlay {
                redact_pii: Some(false),
                ..Default::default()
            },
        )]),
    };
    let resolved = r.resolve(Some("o"), Some("agent"), Some(&bundle));
    assert!(resolved.enabled, "a team cannot disable the firewall");
    assert_eq!(resolved.policy, FirewallPolicy::Sanitize);
    assert!(resolved.redact_pii, "the team lock binds the agent leaf");

    let stricter = PolicyBundle {
        platform_floor: None,
        firewall: None,
        team_firewall: Some(FirewallOverlay {
            policy: Some(FirewallPolicy::Block),
            ..Default::default()
        }),
        agent_overlays: HashMap::new(),
    };
    assert_eq!(
        r.resolve(Some("o"), None, Some(&stricter)).policy,
        FirewallPolicy::Block
    );
}

#[test]
fn org_some_overrides_none_inherits() {
    let r = FirewallResolver::new(unlocked_base());
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            policy: Some(FirewallPolicy::Block),
            redact_pii: Some(false),
            // scan_inbound left None ⇒ inherits node's `true`.
            ..Default::default()
        }),
        agent_overlays: HashMap::new(),
    };
    let cfg = r.resolve(Some("o1"), None, Some(&bundle));
    assert_eq!(cfg.policy, FirewallPolicy::Block, "Some overrides");
    assert!(!cfg.redact_pii, "Some(false) overrides");
    assert!(cfg.scan_inbound, "None inherits node base");
}

#[test]
fn agent_overrides_org() {
    // `policy` is locked by default; unlock it here to prove plain
    // agent-over-org precedence for an UNLOCKED field.
    let r = FirewallResolver::new(unlocked_base());
    let mut agent_overlays = HashMap::new();
    agent_overlays.insert(
        "a1".to_string(),
        FirewallOverlay {
            policy: Some(FirewallPolicy::Sanitize),
            ..Default::default()
        },
    );
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            policy: Some(FirewallPolicy::WarnAndContinue),
            ..Default::default()
        }),
        agent_overlays,
    };
    let cfg = r.resolve(Some("o1"), Some("a1"), Some(&bundle));
    // Agent leaf (Sanitize) wins over org (Warn) for a non-locked field.
    assert_eq!(cfg.policy, FirewallPolicy::Sanitize);
}
