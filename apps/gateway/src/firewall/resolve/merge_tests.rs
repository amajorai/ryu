//! Resolver tests: lock propagation, default locks, the inspector merge and the scanner cache.

use super::tests::{base, unlocked_base};
use super::*;
use crate::config::InspectorFailMode;
use crate::config::{FirewallPolicy, InspectorMode};

#[test]
fn lock_added_at_org_binds_the_agent_leaf() {
    // Node does NOT lock (default locks removed); org locks `enabled` = true;
    // the agent leaf cannot then disable it. This proves locks bind scopes
    // narrower than the locker.
    let r = FirewallResolver::new(unlocked_base());
    let mut agent_overlays = HashMap::new();
    agent_overlays.insert(
        "a1".to_string(),
        FirewallOverlay {
            enabled: Some(false),
            ..Default::default()
        },
    );
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            enabled: Some(true),
            locked_fields: vec!["enabled".into()],
            ..Default::default()
        }),
        agent_overlays,
    };
    let cfg = r.resolve(Some("o1"), Some("a1"), Some(&bundle));
    assert!(cfg.enabled, "org lock binds the agent leaf");
}

#[test]
fn default_locks_prevent_overlay_from_disabling_firewall() {
    // With NO explicit lock config, an org/agent overlay must not be able to
    // switch the inbound firewall off for its scope: `enabled`,
    // `scan_inbound`, and `policy` are locked by default, so every loosening
    // attempt is refused (stricter/ON wins).
    let r = FirewallResolver::new(base());
    let mut agent_overlays = HashMap::new();
    agent_overlays.insert(
        "a1".to_string(),
        FirewallOverlay {
            scan_inbound: Some(false), // attempt: skip the inbound scan
            ..Default::default()
        },
    );
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            enabled: Some(false),                          // attempt: disable
            scan_inbound: Some(false),                     // attempt: skip scan
            policy: Some(FirewallPolicy::WarnAndContinue), // attempt: downgrade
            ..Default::default()
        }),
        agent_overlays,
    };
    let cfg = r.resolve(Some("o1"), Some("a1"), Some(&bundle));
    assert!(cfg.enabled, "default lock keeps the firewall enabled");
    assert!(cfg.scan_inbound, "default lock keeps inbound scanning on");
    assert_eq!(
        cfg.policy,
        FirewallPolicy::Block,
        "default lock refuses a policy downgrade"
    );
}

#[test]
fn default_locks_still_allow_tightening() {
    // The dual: on a node explicitly loosened to Sanitize (locks left at the
    // default), a narrower scope may still TIGHTEN a locked field.
    let mut node = base();
    node.policy = FirewallPolicy::Sanitize;
    let r = FirewallResolver::new(node);
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            policy: Some(FirewallPolicy::Block),
            log_detections: Some(false), // explicit unlocked notification setting
            ..Default::default()
        }),
        agent_overlays: HashMap::new(),
    };
    let cfg = r.resolve(Some("o1"), None, Some(&bundle));
    assert_eq!(
        cfg.policy,
        FirewallPolicy::Block,
        "a locked field may still be tightened"
    );
    assert!(
        !cfg.log_detections,
        "an unlocked field is still freely overridable"
    );
}

#[test]
fn locked_inspector_cannot_be_disabled() {
    let mut node = base();
    node.inspector = InspectorConfig {
        enabled: true,
        mode: InspectorMode::Both,
        ..InspectorConfig::default()
    };
    node.locked_fields = vec!["inspector".into()];
    let r = FirewallResolver::new(node);
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            inspector: Some(InspectorConfig {
                enabled: false,
                ..InspectorConfig::default()
            }),
            ..Default::default()
        }),
        agent_overlays: HashMap::new(),
    };
    let cfg = r.resolve(Some("o1"), None, Some(&bundle));
    assert!(cfg.inspector.enabled, "locked inspector stays enabled");
}

#[test]
fn standalone_local_overlays_apply_without_bundle() {
    let r = FirewallResolver::new(base());
    r.set_agent_overlay(
        "a1".into(),
        FirewallOverlay {
            policy: Some(FirewallPolicy::Block),
            ..Default::default()
        },
    );
    // No control-plane bundle (standalone path) — overlay comes from the store.
    let cfg = r.resolve(None, Some("a1"), None);
    assert_eq!(cfg.policy, FirewallPolicy::Block);
}

#[test]
fn scanner_cache_shares_and_invalidates() {
    let r = FirewallResolver::new(base());
    let s1 = r.scanner_for(None, None, None);
    let s2 = r.scanner_for(None, None, None);
    assert!(
        Arc::ptr_eq(&s1, &s2),
        "identical resolved configs share one scanner"
    );

    r.invalidate_cache();
    let s3 = r.scanner_for(None, None, None);
    assert!(
        !Arc::ptr_eq(&s1, &s3),
        "invalidation forces a fresh scanner build"
    );
}

#[test]
fn different_configs_get_different_scanners() {
    let r = FirewallResolver::new(unlocked_base());
    let s1 = r.scanner_for(None, None, None);
    // Explicitly unlock this fixture so the redaction overlay changes the
    // resolved config rather than testing a correctly rejected loosening.
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            redact_pii: Some(false),
            ..Default::default()
        }),
        agent_overlays: HashMap::new(),
    };
    let s2 = r.scanner_for(Some("o1"), None, Some(&bundle));
    assert!(
        !Arc::ptr_eq(&s1, &s2),
        "distinct resolved configs get distinct scanners"
    );
}

#[test]
fn locked_inspector_cannot_be_loosened_field_by_field() {
    // FIX 1: node locks `inspector` at a strict setting. A narrower scope that
    // tries to loosen EVERY dial (disable, raise min_chars, shorten timeout,
    // narrow Both→single, downgrade the action) must be rejected field by
    // field; the resolved inspector stays at least as strict as the node's.
    let mut node = base();
    node.inspector = InspectorConfig {
        enabled: true,
        model: "node-model".into(),
        mode: InspectorMode::Both,
        min_chars: 20,
        timeout_ms: 3000,
        action: FirewallPolicy::Block,
        fail_mode: Some(InspectorFailMode::Closed),
        max_windows: crate::config::DEFAULT_INSPECTOR_WINDOWS,
    };
    node.locked_fields = vec!["inspector".into()];
    let r = FirewallResolver::new(node);

    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            inspector: Some(InspectorConfig {
                enabled: false,                           // attempt: disable
                model: "agent-model".into(),              // selection, may swap
                mode: InspectorMode::Injection,           // attempt: narrow Both
                min_chars: 500,                           // attempt: scan fewer
                timeout_ms: 100,                          // attempt: shorten
                action: FirewallPolicy::WarnAndContinue,  // attempt: downgrade
                fail_mode: Some(InspectorFailMode::Open), // attempt: fail open
                max_windows: 2,                           // attempt: judge less
            }),
            ..Default::default()
        }),
        agent_overlays: HashMap::new(),
    };
    let ins = r.resolve(Some("o1"), None, Some(&bundle)).inspector;
    assert!(ins.enabled, "locked inspector cannot be disabled");
    assert_eq!(ins.mode, InspectorMode::Both, "Both cannot be narrowed");
    assert_eq!(
        ins.min_chars, 20,
        "min_chars cannot be raised (smaller wins)"
    );
    assert_eq!(
        ins.timeout_ms, 3000,
        "timeout cannot be shortened (larger wins)"
    );
    assert_eq!(
        ins.action,
        FirewallPolicy::Block,
        "action cannot be downgraded"
    );
    assert_eq!(
        ins.model, "agent-model",
        "model is a selection: the narrower scope may swap it"
    );
    assert_eq!(
        ins.effective_fail_mode(),
        InspectorFailMode::Closed,
        "a closed fail mode cannot be opened"
    );
    assert_eq!(
        ins.max_windows,
        crate::config::DEFAULT_INSPECTOR_WINDOWS,
        "the window budget cannot be shrunk (larger wins)"
    );
}

#[test]
fn locked_inspector_can_still_tighten() {
    // The dual of the loosen test: a narrower scope enabling a locked-but-off
    // inspector and raising the action MUST take effect (tightening allowed).
    let mut node = base();
    node.inspector = InspectorConfig {
        enabled: false,
        action: FirewallPolicy::WarnAndContinue,
        ..InspectorConfig::default()
    };
    node.locked_fields = vec!["inspector".into()];
    let r = FirewallResolver::new(node);

    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            inspector: Some(InspectorConfig {
                enabled: true,
                action: FirewallPolicy::Block,
                ..InspectorConfig::default()
            }),
            ..Default::default()
        }),
        agent_overlays: HashMap::new(),
    };
    let ins = r.resolve(Some("o1"), None, Some(&bundle)).inspector;
    assert!(
        ins.enabled,
        "narrower scope may enable a locked-off inspector"
    );
    assert_eq!(
        ins.action,
        FirewallPolicy::Block,
        "narrower scope may tighten"
    );
}

#[test]
fn a_narrower_scope_may_close_a_locked_open_inspector() {
    let mut node = base();
    node.inspector = InspectorConfig {
        enabled: true,
        action: FirewallPolicy::WarnAndContinue,
        ..InspectorConfig::default()
    };
    node.locked_fields = vec!["inspector".into()];
    let r = FirewallResolver::new(node);
    let overlay = |fail_mode| PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            inspector: Some(InspectorConfig {
                enabled: true,
                action: FirewallPolicy::WarnAndContinue,
                fail_mode,
                ..InspectorConfig::default()
            }),
            ..Default::default()
        }),
        agent_overlays: HashMap::new(),
    };
    let closed = r
        .resolve(
            Some("o1"),
            None,
            Some(&overlay(Some(InspectorFailMode::Closed))),
        )
        .inspector;
    assert_eq!(closed.fail_mode, Some(InspectorFailMode::Closed));
    assert_eq!(closed.action, FirewallPolicy::WarnAndContinue);
    let unset = r.resolve(Some("o1"), None, Some(&overlay(None))).inspector;
    assert_eq!(unset.effective_fail_mode(), InspectorFailMode::Open);
}

#[test]
fn org_overlay_wrap_untrusted_field_and_lock_are_dropped() {
    // FIX 2: the node-only `wrap_untrusted_tool_results` flag cannot be set or
    // locked by an org/agent overlay. The node base has it `true`; an org
    // overlay flipping it off AND locking it must have BOTH stripped — the
    // resolved value stays at the node base and the lock never appears (so it
    // also never poisons the scanner-cache key).
    let r = FirewallResolver::new(base());
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            wrap_untrusted_tool_results: Some(false),
            locked_fields: vec!["wrap_untrusted_tool_results".into()],
            ..Default::default()
        }),
        agent_overlays: HashMap::new(),
    };
    let cfg = r.resolve(Some("o1"), None, Some(&bundle));
    assert!(
        cfg.wrap_untrusted_tool_results,
        "org overlay cannot change the node-only wrap flag"
    );
    assert!(
        !cfg.locked_fields
            .contains(&"wrap_untrusted_tool_results".to_string()),
        "org overlay cannot lock the node-only wrap flag"
    );
}

#[test]
fn seed_overlays_normalizes_and_populates_local_stores() {
    // FIX 4 + FIX 2: seeding from persisted config populates the resolver's
    // standalone stores, and re-normalizes so a hand-edited gateway.toml
    // cannot smuggle the node-only wrap field back in.
    let r = FirewallResolver::new(base());
    let mut org = HashMap::new();
    org.insert(
        "o1".to_string(),
        FirewallOverlay {
            policy: Some(FirewallPolicy::Block),
            wrap_untrusted_tool_results: Some(false),
            locked_fields: vec!["wrap_untrusted_tool_results".into()],
            ..Default::default()
        },
    );
    r.seed_overlays(&org, &HashMap::new());

    let stored = r.org_overlays();
    assert_eq!(stored["o1"].policy, Some(FirewallPolicy::Block));
    assert_eq!(
        stored["o1"].wrap_untrusted_tool_results, None,
        "seed normalizes away the node-only wrap field"
    );
    assert!(
        stored["o1"].locked_fields.is_empty(),
        "seed normalizes away the node-only wrap lock"
    );
    // And it drives resolution on the standalone (no-bundle) path.
    let cfg = r.resolve(Some("o1"), None, None);
    assert_eq!(cfg.policy, FirewallPolicy::Block);
}
