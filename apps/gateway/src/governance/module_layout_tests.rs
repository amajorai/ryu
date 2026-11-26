//! The built-in grant policy lives in sibling modules of `mod.rs` since that file
//! was split for the file size limits. These tests pin the wiring between the
//! pieces: the two halves of the allowlist in their order, the cached reserved
//! list, the owner table lookup and the signing wrappers. They hold no row
//! counts, so a reviewed change to a row does not have to touch them.

use super::*;

#[test]
fn the_default_allowlist_is_both_halves_in_their_order() {
    let tools = default_allowlist_tools::tool_and_data_scopes();
    let host = default_allowlist_host::host_capability_scopes();
    assert_eq!(tools.first().map(String::as_str), Some("mcp.tools"));
    assert_eq!(tools.last().map(String::as_str), Some("identity.read"));
    assert_eq!(host.first().map(String::as_str), Some("app:http"));
    assert_eq!(host.last().map(String::as_str), Some("browser:control"));
    assert_eq!(default_grant_allowlist(), [tools, host].concat());
}

#[test]
fn the_policy_reads_the_moved_reserved_list_and_owner_table() {
    let reserved = reserved_namespaces::reserved_namespaces();
    assert!(reserved.iter().any(|name| name == "app"));
    assert_eq!(reserved_namespace_list(), &reserved);
    assert_eq!(
        owner_exclusive::owner_exclusive_grants("@ryu/kill-switch"),
        ["execution:control"]
    );
    assert!(owner_exclusive::owner_exclusive_grants("@evil/kill-switch").is_empty());
    let decision = validate_grants_for(Some("@ryu/kill-switch"), &["execution:control".to_owned()]);
    assert!(decision.all_approved(), "denied: {:?}", decision.denied);
}

#[test]
fn the_signing_module_signs_what_the_module_root_verifies() {
    let manifest = serde_json::json!({ "id": "@test/app", "version": "1.0.0" });
    let signature = signing::sign_manifest(&manifest);
    assert!(verify_manifest(&manifest, &signature, None));
    assert!(!verify_manifest(
        &serde_json::json!({ "id": "@test/other" }),
        &signature,
        None
    ));
}
