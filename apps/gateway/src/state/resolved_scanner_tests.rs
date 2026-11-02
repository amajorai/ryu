use super::AppState;
use crate::config::{CustomPattern, CustomPatternKind, FirewallOverlay};
use crate::pipeline::node_routing::NodeRoutingPrefs;

/// The seam test the unit tests structurally cannot provide.
///
/// `clamp_firewall` is covered in `pipeline::node_routing`, and
/// `resolve_with_request` is covered in `firewall::resolve` â€” but both are
/// called DIRECTLY there. Nothing asserted that `resolved_scanner` actually
/// joins them, so deleting the `clamp_firewall` call in `resolved_scanner`
/// left the whole suite green while the node's firewall rules silently stopped
/// reaching any request. `resolved_scanner` is the seam (it hands the ONE
/// `Arc` that `pre_process` shares across the regex scan, the inspector await,
/// the locked-guardrail scan and companion redaction), so it is what to assert
/// on â€” no `run()` needed.
#[test]
fn a_request_scope_firewall_overlay_reaches_the_resolved_scanner() {
    let state = AppState::new_for_test_default();
    let mut ctx = crate::pipeline::test_support::plain_request_context();
    ctx.node_routing = Some(NodeRoutingPrefs {
        fallback: Vec::new(),
        firewall: Some(FirewallOverlay {
            custom_patterns: vec![CustomPattern {
                name: "acme_internal_id".into(),
                regex: r"ACME-\d{6}".into(),
                kind: CustomPatternKind::Pii,
            }],
            ..Default::default()
        }),
        openrouter: None,
        openrouter_model_fallbacks: Vec::new(),
    });

    let scanner = state.resolved_scanner(&ctx);
    assert!(
        scanner
            .config()
            .custom_patterns
            .iter()
            .any(|p| p.name == "acme_internal_id"),
        "the node's own extra rule never reached the per-request scanner"
    );

    // Control: the same state with no preference must be unchanged, so the
    // assertion above is detecting the overlay and not a pre-seeded pattern.
    let bare = crate::pipeline::test_support::plain_request_context();
    assert!(state
        .resolved_scanner(&bare)
        .config()
        .custom_patterns
        .is_empty());
}

/// A locked node must not let a request contribute rules at all â€” the clamp
/// runs inside `resolved_scanner`, so this is where the lever is observable.
#[test]
fn a_locked_node_keeps_request_rules_out_of_the_scanner() {
    let mut state = AppState::new_for_test_default();
    state.config.node_routing.allow_request_override = false;
    let mut ctx = crate::pipeline::test_support::plain_request_context();
    ctx.node_routing = Some(NodeRoutingPrefs {
        fallback: Vec::new(),
        firewall: Some(FirewallOverlay {
            custom_patterns: vec![CustomPattern {
                name: "acme_internal_id".into(),
                regex: r"ACME-\d{6}".into(),
                kind: CustomPatternKind::Pii,
            }],
            ..Default::default()
        }),
        openrouter: None,
        openrouter_model_fallbacks: Vec::new(),
    });

    assert!(state
        .resolved_scanner(&ctx)
        .config()
        .custom_patterns
        .is_empty());
}
