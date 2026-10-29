use ryu_kernel_contracts::manifest::PluginManifest;

#[test]
fn old_manifest_serialization_does_not_add_an_optional_signed_field() {
    let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
        "id": "com.test.legacy", "name": "Legacy", "version": "1.0.0", "runnables": [], "permission_grants": ["usage:read"]
    })).expect("old manifest");
    assert!(manifest.optional_permission_grants.is_empty());
    let signed_surface = serde_json::to_value(&manifest).expect("canonical manifest");
    assert!(signed_surface.get("optional_permission_grants").is_none());
    let round_trip: PluginManifest =
        serde_json::from_value(signed_surface.clone()).expect("old signed surface");
    assert_eq!(
        serde_json::to_value(round_trip).expect("same signature input"),
        signed_surface
    );
}

#[test]
fn optional_declarations_round_trip_and_only_explicit_approvals_survive() {
    let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
        "id": "com.test.optional", "name": "Optional", "version": "1.0.0", "runnables": [], "permission_grants": ["usage:read"], "optional_permission_grants": ["usage:audit"]
    })).expect("manifest");
    let stored = serde_json::to_value(&manifest).expect("signed optional declaration");
    assert_eq!(
        stored["optional_permission_grants"],
        serde_json::json!(["usage:audit"])
    );
    let restored: PluginManifest = serde_json::from_value(stored).expect("restored");
    assert_eq!(
        restored.approved_permission_grants(&["usage:read".into(), "undeclared:secret".into()]),
        vec!["usage:read"]
    );
    assert_eq!(
        restored.approved_permission_grants(&["usage:read".into(), "usage:audit".into()]),
        vec!["usage:read", "usage:audit"]
    );
}
