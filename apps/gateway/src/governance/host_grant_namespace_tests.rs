//! Regression tests: host-API grants of first-party apps cannot be squatted.
//!
//! The owner-scoped rule approves `<ns>:*` for any app whose id ends in `<ns>`.
//! When `<ns>:<verb>` is also a host-API grant (`crates/core/kernel-contracts/
//! schemas/host-api.json`), the desktop host forwards that capability with the
//! owner's node token, so `@evil/subtitles` self-granting `subtitles:crud`
//! would drive `@ryu/subtitles` as the signed-in user. Those namespaces must be
//! reserved or listed in `protected_owner_id_list()`.

use super::*;

fn one(grant: &str) -> Vec<String> {
    vec![grant.to_string()]
}

/// (first-party owner name, host-API grant it relies on).
const HOST_GRANT_OWNERS: &[(&str, &str)] = &[
    ("subtitles", "subtitles:crud"),
    ("background", "background:control"),
    ("voice", "voice:models:manage"),
];

#[test]
fn squatters_cannot_self_grant_first_party_host_grants() {
    for (name, grant) in HOST_GRANT_OWNERS {
        for squatter in [
            format!("@evil/{name}"),
            format!("com.evil.{name}"),
            (*name).to_string(),
        ] {
            let decision = validate_grants_for(Some(&squatter), &one(grant));
            assert!(
                !decision.all_approved(),
                "{squatter} must not self-grant '{grant}'"
            );
            assert_eq!(decision.denied, one(grant));
        }
        for owner in [format!("@ryu/{name}"), format!("com.ryu.{name}")] {
            let decision = validate_grants_for(Some(&owner), &one(grant));
            assert!(
                decision.all_approved(),
                "{owner} must keep its own '{grant}': denied {:?}",
                decision.denied
            );
        }
    }
}

/// Every non-allowlisted host-API grant must be unreachable through the
/// owner-scoped rule for a third-party id named after its namespace. Derived
/// from the shared host-API contract so a new host grant cannot ship with a
/// squattable namespace.
#[test]
fn every_host_api_grant_namespace_is_squat_proof() {
    let contract = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../crates/core/kernel-contracts/schemas/host-api.json");
    let Ok(raw) = std::fs::read_to_string(&contract) else {
        // Vendored gateway without the sibling kernel-contracts crate.
        return;
    };
    let parsed: Value = serde_json::from_str(&raw).expect("host-api.json is valid JSON");
    let mut grants: Vec<String> = parsed
        .get("methods")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("grant").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    grants.sort();
    grants.dedup();
    assert!(!grants.is_empty(), "host-api.json declares no grants");

    let mut failures = Vec::new();
    for grant in &grants {
        if grant_allowlist()
            .iter()
            .any(|a| a.eq_ignore_ascii_case(grant))
        {
            // Reviewed cross-app grant: approved for every app by design.
            continue;
        }
        let Some(namespace) = ryu_gw_governance::capability_namespace(grant) else {
            failures.push(format!("malformed host grant '{grant}'"));
            continue;
        };
        for squatter in [
            format!("@evil/{namespace}"),
            format!("com.evil.{namespace}"),
        ] {
            if validate_grants_for(Some(&squatter), &one(grant)).all_approved() {
                failures.push(format!("{squatter} self-grants host grant '{grant}'"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "host-API grants reachable by owner-scoped squatting; reserve the namespace \
         or add its first-party owner to protected_owner_id_list(): {}",
        failures.join(", ")
    );
}
