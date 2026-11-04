#[path = "../gateway_policy_patch_tests/firewall_dispatch_runtime_test.rs"]
mod firewall_dispatch_runtime;
#[path = "../gateway_policy_patch_tests/firewall_policy_runtime_test.rs"]
mod firewall_policy_runtime;

use crate::server::{
    build_firewall_patch, build_routing_patch, policy_requires_respawn, FirewallPolicyBundle,
};
use serde_json::json;

/// The firewall toggle is a LIVE config-push, never a respawn; the respawn split
/// must classify firewall/routing as push and only compression as respawn. This
/// is the "assert the respawn path is NOT taken when the field is hot-swappable"
/// guard.
#[test]
fn only_compression_requires_respawn() {
    assert!(policy_requires_respawn("compression"));
    assert!(!policy_requires_respawn("firewall"));
    assert!(!policy_requires_respawn("routing"));
    assert!(!policy_requires_respawn("sandbox"));
    assert!(!policy_requires_respawn("predict"));
    assert!(!policy_requires_respawn("dictation"));
}

/// Enabling forces `firewall.enabled = true` while PRESERVING every other field
/// of the current config (a toggle must never reset the operator's policy /
/// scan settings — the gateway's PUT firewall is full-replacement).
#[test]
fn firewall_enable_forces_enabled_and_preserves_other_fields() {
    let current = json!({
        "enabled": false,
        "policy": "block",
        "scan_inbound": true,
        "redact_pii": false,
    });
    let out = build_firewall_patch(current, true, &FirewallPolicyBundle::default());
    assert_eq!(out["enabled"], json!(true));
    assert_eq!(out["policy"], json!("block"), "policy preserved");
    assert_eq!(out["redact_pii"], json!(false), "redact_pii preserved");
}

/// Disabling forces `enabled = false` (the plugin owns the toggle direction).
#[test]
fn firewall_disable_forces_enabled_false() {
    let out = build_firewall_patch(
        json!({ "policy": "warn_and_continue" }),
        false,
        &FirewallPolicyBundle::default(),
    );
    assert_eq!(out["enabled"], json!(false));
    assert_eq!(out["policy"], json!("warn_and_continue"));
}

/// The config-pack: enabling a firewall pattern-pack plugin PUSHES its
/// `custom_patterns` on top of the existing set; disabling REMOVES exactly the
/// pack's patterns (by name) and leaves any pre-existing operator pattern intact.
#[test]
fn firewall_config_pack_pushes_on_enable_and_removes_on_disable() {
    let pack = FirewallPolicyBundle::from_definition(&json!({
        "service": "gateway",
        "custom_patterns": [
            { "name": "widget_id", "regex": "WIDGET-\\d+", "kind": "pii" }
        ]
    }));
    // A config that already carries an unrelated operator pattern.
    let current = json!({
        "enabled": true,
        "custom_patterns": [
            { "name": "operator_secret", "regex": "OP-\\d+", "kind": "secret" }
        ]
    });

    // ENABLE: the pack pattern is added; the operator's own pattern survives.
    let enabled = build_firewall_patch(current.clone(), true, &pack);
    let names: Vec<&str> = enabled["custom_patterns"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p["name"].as_str())
        .collect();
    assert!(
        names.contains(&"widget_id"),
        "pack pattern pushed on enable"
    );
    assert!(
        names.contains(&"operator_secret"),
        "operator pattern preserved"
    );

    // DISABLE: the pack pattern is removed by name; the operator's stays.
    let disabled = build_firewall_patch(enabled, false, &pack);
    let names: Vec<&str> = disabled["custom_patterns"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p["name"].as_str())
        .collect();
    assert!(
        !names.contains(&"widget_id"),
        "pack pattern removed on disable"
    );
    assert!(
        names.contains(&"operator_secret"),
        "operator pattern still intact"
    );
    // A pattern-pack plugin must NOT touch the global `enabled` flag — it was
    // `true` in `current` and stays `true` through both enable and disable, so
    // removing a narrow pack never disarms the whole firewall.
    assert_eq!(
        disabled["enabled"],
        json!(true),
        "pack toggle preserves global enabled"
    );
}

/// The global-switch decoupling (the "any one firewall plugin drives the global
/// switch" fix): a pattern-pack plugin (non-empty config-pack) NEVER writes
/// `firewall.enabled` in EITHER direction — it only contributes/removes its own
/// patterns. Only the pure on/off switch owns the global flag.
#[test]
fn firewall_pattern_pack_never_writes_global_enabled() {
    let pack = FirewallPolicyBundle::from_definition(&json!({
        "custom_patterns": [{ "name": "widget_id", "regex": "WIDGET-\\d+", "kind": "pii" }]
    }));

    // Live config with the firewall ARMED (enabled:true). Disabling the pack must
    // leave it armed — only its pattern is dropped.
    let armed = json!({ "enabled": true, "policy": "block" });
    let out = build_firewall_patch(armed, false, &pack);
    assert_eq!(
        out["enabled"],
        json!(true),
        "disable-pack keeps firewall armed"
    );
    assert_eq!(out["policy"], json!("block"), "policy preserved");
    assert_eq!(
        out["custom_patterns"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["name"] == json!("widget_id"))
            .count(),
        0,
        "pack pattern removed"
    );

    // Live config with the firewall DISARMED (enabled:false). Enabling the pack
    // must NOT force the whole firewall on — a narrow pack can't arm enforcement.
    let disarmed = json!({ "enabled": false, "policy": "block" });
    let out = build_firewall_patch(disarmed, true, &pack);
    assert_eq!(
        out["enabled"],
        json!(false),
        "enable-pack does not arm firewall"
    );
    let names: Vec<&str> = out["custom_patterns"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|p| p["name"].as_str())
        .collect();
    assert!(names.contains(&"widget_id"), "pack pattern added");
}

/// Re-applying the pack is idempotent — enabling twice does not duplicate the
/// pack's patterns.
#[test]
fn firewall_config_pack_reapply_is_idempotent() {
    let pack = FirewallPolicyBundle::from_definition(&json!({
        "custom_patterns": [{ "name": "widget_id", "regex": "WIDGET-\\d+", "kind": "pii" }]
    }));
    let once = build_firewall_patch(json!({}), true, &pack);
    let twice = build_firewall_patch(once, true, &pack);
    let count = twice["custom_patterns"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["name"] == json!("widget_id"))
        .count();
    assert_eq!(count, 1, "pack pattern must not be duplicated on re-enable");
}

/// The built-in firewall fixture's definition (`service` + `note`, no patterns)
/// is a pure on/off switch — no config-pack, so only `enabled` changes.
#[test]
fn firewall_pure_switch_definition_adds_no_patterns() {
    let pack = FirewallPolicyBundle::from_definition(&json!({
        "service": "gateway",
        "note": "on/off switch"
    }));
    let out = build_firewall_patch(json!({}), true, &pack);
    assert_eq!(out["enabled"], json!(true));
    assert_eq!(out["custom_patterns"], json!([]), "no pack ⇒ no patterns");
}

/// The routing toggle forces `smart_routing.enabled` while preserving the rest
/// of the routing config (model_map, other smart_routing fields).
#[test]
fn routing_toggle_sets_smart_routing_enabled_and_preserves_rest() {
    let current = json!({
        "default_provider": "local",
        "model_map": { "gemma": { "provider": "local" } },
        "smart_routing": { "classifier_model": "gemma-mini", "cache_by_session": true }
    });
    let out = build_routing_patch(current, true);
    assert_eq!(out["smart_routing"]["enabled"], json!(true));
    assert_eq!(
        out["smart_routing"]["classifier_model"],
        json!("gemma-mini"),
        "existing smart_routing fields preserved"
    );
    assert_eq!(
        out["model_map"]["gemma"]["provider"],
        json!("local"),
        "model_map preserved"
    );

    // Disable path, starting from a config with no smart_routing block at all.
    let out = build_routing_patch(json!({ "default_provider": "local" }), false);
    assert_eq!(out["smart_routing"]["enabled"], json!(false));
    assert_eq!(out["default_provider"], json!("local"));
}
