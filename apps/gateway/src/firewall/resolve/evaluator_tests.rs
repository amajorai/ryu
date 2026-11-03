//! Resolver tests: evaluator-binding cascade and inherited egress locks.

use super::tests::base;
use super::*;
use crate::config::FirewallPolicy;

// ── Evaluator-binding cascade (P1) ─────────────────────────────────────────

use crate::evaluators::EvaluatorBinding;

/// Build a test evaluator binding.
fn binding(
    id: &str,
    enabled: bool,
    inline_action: Option<FirewallPolicy>,
    locked: bool,
) -> EvaluatorBinding {
    EvaluatorBinding {
        id: id.into(),
        enabled,
        inline_action,
        offline: None,
        locked,
    }
}

fn find<'a>(bindings: &'a [EvaluatorBinding], id: &str) -> &'a EvaluatorBinding {
    bindings
        .iter()
        .find(|b| b.id == id)
        .unwrap_or_else(|| panic!("binding {id} missing"))
}

#[test]
fn merge_evaluator_bindings_unions_and_tightens_locked() {
    // Direct unit test of the helper: a locked base binding may be tightened
    // (never loosened) and an overlay-only binding is appended (union).
    let base = vec![binding("a", true, Some(FirewallPolicy::Block), true)];
    let overlay = vec![
        binding("a", false, Some(FirewallPolicy::WarnAndContinue), false),
        binding("b", true, None, false),
    ];
    let merged = merge_evaluator_bindings(&base, &overlay);
    assert_eq!(merged.len(), 2, "union keeps a and appends b");
    let a = find(&merged, "a");
    assert!(a.enabled, "locked+enabled base cannot be disabled");
    assert_eq!(
        a.inline_action,
        Some(FirewallPolicy::Block),
        "locked action cannot be downgraded to Warn"
    );
    assert!(a.locked, "lock stays");
    assert!(find(&merged, "b").enabled, "overlay-only binding appended");
}

#[test]
fn merge_evaluator_bindings_overrides_unlocked() {
    // An unlocked base binding is overridden wholesale by the overlay.
    let base = vec![binding("a", false, None, false)];
    let overlay = vec![binding("a", true, Some(FirewallPolicy::Sanitize), false)];
    let merged = merge_evaluator_bindings(&base, &overlay);
    let a = find(&merged, "a");
    assert!(a.enabled);
    assert_eq!(a.inline_action, Some(FirewallPolicy::Sanitize));
}

#[test]
fn cascade_merges_evaluators_by_id() {
    // Node base has A (off) + B (off). Org overrides A (on/Block) and adds C.
    // Agent overrides B (on/Sanitize). Resolved: A(org), B(agent), C(org).
    let mut node = base();
    node.evaluators = vec![
        binding("a", false, None, false),
        binding("b", false, None, false),
    ];
    let r = FirewallResolver::new(node);

    let mut agent_overlays = HashMap::new();
    agent_overlays.insert(
        "ag".to_string(),
        FirewallOverlay {
            evaluators: Some(vec![binding(
                "b",
                true,
                Some(FirewallPolicy::Sanitize),
                false,
            )]),
            ..Default::default()
        },
    );
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            evaluators: Some(vec![
                binding("a", true, Some(FirewallPolicy::Block), false),
                binding("c", true, None, false),
            ]),
            ..Default::default()
        }),
        agent_overlays,
    };
    let cfg = r.resolve(Some("o1"), Some("ag"), Some(&bundle));
    assert_eq!(cfg.evaluators.len(), 3, "A, B, C");
    let a = find(&cfg.evaluators, "a");
    assert!(
        a.enabled && a.inline_action == Some(FirewallPolicy::Block),
        "A from org"
    );
    let b = find(&cfg.evaluators, "b");
    assert!(
        b.enabled && b.inline_action == Some(FirewallPolicy::Sanitize),
        "B from agent"
    );
    assert!(find(&cfg.evaluators, "c").enabled, "C from org");
}

#[test]
fn locked_evaluator_cannot_be_disabled_by_narrower_scope() {
    // Org locks A enabled+Block. The agent leaf tries enabled=false + Warn.
    // The lock binds the narrower scope: A stays enabled + Block.
    let r = FirewallResolver::new(base());
    let mut agent_overlays = HashMap::new();
    agent_overlays.insert(
        "ag".to_string(),
        FirewallOverlay {
            evaluators: Some(vec![binding(
                "a",
                false,
                Some(FirewallPolicy::WarnAndContinue),
                false,
            )]),
            ..Default::default()
        },
    );
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(FirewallOverlay {
            evaluators: Some(vec![binding("a", true, Some(FirewallPolicy::Block), true)]),
            ..Default::default()
        }),
        agent_overlays,
    };
    let cfg = r.resolve(Some("o1"), Some("ag"), Some(&bundle));
    let a = find(&cfg.evaluators, "a");
    assert!(
        a.enabled,
        "org lock keeps A enabled against the agent's false"
    );
    assert_eq!(
        a.inline_action,
        Some(FirewallPolicy::Block),
        "org lock keeps Block against the agent's Warn"
    );
    assert!(a.locked, "lock propagates to the narrower scope");
}

#[test]
fn back_compat_deserialize_without_evaluators_field() {
    // A FirewallConfig / FirewallOverlay JSON authored before P1 (no
    // `evaluators` key) still deserializes: config → empty Vec, overlay → None.
    let cfg: FirewallConfig = serde_json::from_str("{}").expect("config deserializes");
    assert!(cfg.evaluators.is_empty(), "missing field → empty Vec");

    let ov: FirewallOverlay = serde_json::from_str("{}").expect("overlay deserializes");
    assert!(ov.evaluators.is_none(), "missing field → None");
}
fn disable_egress() -> FirewallOverlay {
    FirewallOverlay {
        scan_outbound: Some(false),
        redact_pii: Some(false),
        redact_secrets: Some(false),
        ..Default::default()
    }
}

#[test]
fn inherited_default_egress_locks_reject_org_and_agent_loosening() {
    let resolver = FirewallResolver::new(base());
    resolver.set_org_overlay("org".into(), disable_egress());
    resolver.set_agent_overlay("agent".into(), disable_egress());
    for (org, agent) in [
        (Some("org"), None),
        (None, Some("agent")),
        (Some("org"), Some("agent")),
    ] {
        let config = resolver.resolve(org, agent, None);
        assert!(config.scan_outbound && config.redact_pii && config.redact_secrets);
    }
    let bundle = PolicyBundle {
        platform_floor: None,
        team_firewall: None,
        firewall: Some(disable_egress()),
        agent_overlays: HashMap::from([("agent".into(), disable_egress())]),
    };
    let config = resolver.resolve(Some("org"), Some("agent"), Some(&bundle));
    assert!(config.scan_outbound && config.redact_pii && config.redact_secrets);
}

#[test]
fn partial_node_config_inherits_egress_locks_and_allows_tightening() {
    let partial: crate::config::GatewayConfig = toml::from_str(
        r#"[firewall]
policy = "sanitize"
"#,
    )
    .unwrap();
    let resolver = FirewallResolver::new(partial.firewall);
    resolver.set_agent_overlay("agent".into(), disable_egress());
    let config = resolver.resolve(None, Some("agent"), None);
    assert_eq!(config.policy, FirewallPolicy::Sanitize);
    assert!(config.scan_outbound && config.redact_pii && config.redact_secrets);

    let authored: crate::config::GatewayConfig = toml::from_str(
        r#"[firewall]
scan_outbound = false
redact_pii = false
redact_secrets = false
"#,
    )
    .unwrap();
    let resolver = FirewallResolver::new(authored.firewall);
    let config = resolver.resolve(None, None, None);
    assert!(
        !config.scan_outbound && !config.redact_pii && !config.redact_secrets,
        "node-authored values remain authoritative"
    );
    resolver.set_agent_overlay(
        "agent".into(),
        FirewallOverlay {
            scan_outbound: Some(true),
            redact_pii: Some(true),
            redact_secrets: Some(true),
            ..Default::default()
        },
    );
    let tightened = resolver.resolve(None, Some("agent"), None);
    assert!(tightened.scan_outbound && tightened.redact_pii && tightened.redact_secrets);
}

#[test]
fn explicit_custom_node_locks_preserve_operator_choice() {
    for locks in ["[]", "[\"enabled\"]"] {
        let config: crate::config::GatewayConfig =
            toml::from_str(&format!("[firewall]\nlocked_fields = {locks}\n")).unwrap();
        assert!(!config
            .firewall
            .locked_fields
            .iter()
            .any(|field| field == "scan_outbound"));
        let resolver = FirewallResolver::new(config.firewall);
        resolver.set_agent_overlay("agent".into(), disable_egress());
        let config = resolver.resolve(None, Some("agent"), None);
        assert!(!config.scan_outbound && !config.redact_pii && !config.redact_secrets);
        assert!(config.enabled);
    }
}
