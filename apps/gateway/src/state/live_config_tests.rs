use super::AppState;
use crate::config::{RouteStrategy, SmartRoutingConfig, SmartRule};

/// The routing toggle must take effect on the request path with NO restart:
/// after `update_smart_router` the gate the pipeline reads
/// (`state.smart_router().is_active()`, checked in `apply_smart_routing`) must
/// flip live. This is the gateway-side proof that `PUT /v1/config { routing }`
/// hot-swaps smart routing instead of requiring a respawn.
#[test]
fn update_smart_router_flips_the_request_path_gate_live() {
    // Default config â†’ smart routing disabled â†’ the request path is inert.
    let state = AppState::new_for_test_default();
    assert!(
        !state.smart_router().is_active(),
        "default smart routing must be inactive (fail-open)"
    );

    // Push an ENABLED smart-routing config (a classifier + one rule) â€” exactly
    // what `PUT /v1/config { routing: { smart_routing } }` would apply live.
    let cfg = SmartRoutingConfig {
        strategy: RouteStrategy::Llm,
        enabled: true,
        classifier_model: "gemma-classifier".to_string(),
        rules: vec![SmartRule {
            description: "writing or refactoring code".to_string(),
            model: "claude-sonnet-4-5".to_string(),
            weight: 1.0,
        }],
        ..Default::default()
    };
    state.update_smart_router(cfg);

    assert!(
        state.smart_router().is_active(),
        "the request-path gate must see the new routing flag with no restart"
    );

    // And a subsequent disable swaps it back off, still live.
    state.update_smart_router(SmartRoutingConfig::default());
    assert!(
        !state.smart_router().is_active(),
        "disabling smart routing hot-swaps back to inert"
    );
}
