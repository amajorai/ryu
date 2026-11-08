//! Regression tests: `tool:http-egress:127.0.0.1` is owner-exclusive.
//!
//! The grant reaches every loopback port, so a third-party manifest must not be
//! able to self-request it, while every reviewed in-repo declarer keeps it.

use super::loopback_egress::{LOOPBACK_EGRESS_GRANT, LOOPBACK_EGRESS_OWNERS};
use super::*;

fn loopback() -> Vec<String> {
    vec![LOOPBACK_EGRESS_GRANT.to_owned()]
}

#[test]
fn loopback_egress_is_not_on_the_default_allowlist() {
    assert!(
        !default_grant_allowlist()
            .iter()
            .any(|entry| entry == LOOPBACK_EGRESS_GRANT),
        "wholesale loopback egress must not be approvable for every app"
    );
}

#[test]
fn third_party_apps_are_denied_loopback_egress() {
    for app_id in ["@evil/x", "com.evil.bytebot", "@evil/advisor", "bytebot"] {
        let decision = validate_grants_for(Some(app_id), &loopback());
        assert!(
            decision.approved.is_empty(),
            "{app_id}: denied {:?}",
            decision.denied
        );
        assert_eq!(decision.denied, loopback(), "{app_id}");
    }
    let anonymous = validate_grants_for(None, &loopback());
    assert_eq!(anonymous.denied, loopback());
}

#[test]
fn reviewed_owners_keep_loopback_egress() {
    for app_id in [
        "@ryu/advisor",
        "@ryu/shadow",
        "@ryu/bytebot",
        "com.ryu.bytebot",
    ] {
        let decision = validate_grants_for(Some(app_id), &loopback());
        assert_eq!(
            decision.approved,
            loopback(),
            "{app_id}: denied {:?}",
            decision.denied
        );
        assert!(decision.denied.is_empty(), "{app_id}");
    }
}

/// Every in-repo manifest (apps-store, every plugins-store family, Core-only
/// fixtures) that declares the grant must be an approved owner, or its
/// disable/re-enable path fails with GrantsDenied.
#[test]
fn every_in_repo_loopback_declarer_is_an_owner() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut dirs = vec![repo.join("apps-store")];
    for family in ["plugins", "lsp", "external_plugins"] {
        dirs.push(
            repo.join("generated/ryu-runtime/plugins-store")
                .join(family),
        );
    }
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    for dir in dirs {
        if let Ok(entries) = std::fs::read_dir(dir) {
            paths.extend(entries.flatten().map(|e| e.path().join("manifest.json")));
        }
    }
    if let Ok(entries) = std::fs::read_dir(repo.join("apps/core/src/plugin_manifest/fixtures")) {
        paths.extend(entries.flatten().map(|e| e.path()));
    }
    let mut declarers = 0;
    for path in paths.into_iter().filter(|p| p.is_file()) {
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let declares = manifest
            .get("permission_grants")
            .and_then(Value::as_array)
            .is_some_and(|grants| {
                grants
                    .iter()
                    .any(|g| g.as_str() == Some(LOOPBACK_EGRESS_GRANT))
            });
        if !declares {
            continue;
        }
        let id = manifest
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        declarers += 1;
        assert!(
            LOOPBACK_EGRESS_OWNERS.contains(&id),
            "{} ({id}) declares {LOOPBACK_EGRESS_GRANT} but is not a reviewed owner",
            path.display()
        );
        let decision = validate_grants_for(Some(id), &loopback());
        assert_eq!(decision.approved, loopback(), "{id}");
    }
    if repo.join("generated/ryu-runtime/plugins-store").is_dir() {
        assert!(declarers > 0, "scanned no loopback declarers");
    }
}
