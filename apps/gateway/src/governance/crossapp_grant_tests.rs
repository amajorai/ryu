//! Regression tests: `mail:crud` / `social:crud` are not approvable for every app.
//!
//! Both grants drive the owner's Agent Mail and Outpost data through the desktop
//! host with the owner node token, so a third-party manifest must not be able to
//! self-request them, while the owning apps and the reviewed cross-app holders
//! keep them.

use super::crossapp_grants::{
    MAIL_CRUD_CROSSAPP_OWNERS, MAIL_CRUD_GRANT, SOCIAL_CRUD_CROSSAPP_OWNERS, SOCIAL_CRUD_GRANT,
};
use super::*;

fn one(grant: &str) -> Vec<String> {
    vec![grant.to_owned()]
}

#[test]
fn crossapp_bridge_grants_are_not_on_the_default_allowlist() {
    for grant in [MAIL_CRUD_GRANT, SOCIAL_CRUD_GRANT] {
        assert!(
            !default_grant_allowlist()
                .iter()
                .any(|entry| entry.eq_ignore_ascii_case(grant)),
            "{grant} must not be approvable for every app"
        );
    }
}

#[test]
fn third_party_apps_are_denied_mail_and_social_bridges() {
    for app_id in [
        "@evil/helper",
        "com.evil.mail",
        "@evil/mail",
        "@evil/social",
        "com.evil.social",
        "mail",
        "social",
        "@ryu/notes",
    ] {
        for grant in [MAIL_CRUD_GRANT, SOCIAL_CRUD_GRANT] {
            let decision = validate_grants_for(Some(app_id), &one(grant));
            assert!(decision.approved.is_empty(), "{app_id} approved {grant}");
            assert_eq!(decision.denied, one(grant), "{app_id}");
        }
    }
    for grant in [MAIL_CRUD_GRANT, SOCIAL_CRUD_GRANT] {
        assert_eq!(validate_grants_for(None, &one(grant)).denied, one(grant));
    }
}

#[test]
fn owners_and_reviewed_crossapp_holders_keep_their_grant() {
    let cases: [(&str, &[&str]); 2] = [
        (
            MAIL_CRUD_GRANT,
            &[
                "@ryu/mail",
                "com.ryu.mail",
                "@ryu/outreach",
                "com.ryu.outreach",
            ],
        ),
        (
            SOCIAL_CRUD_GRANT,
            &[
                "@ryu/social",
                "com.ryu.social",
                "@ryu/video-studio",
                "com.ryu.video-studio",
            ],
        ),
    ];
    for (grant, owners) in cases {
        for app_id in owners {
            let decision = validate_grants_for(Some(app_id), &one(grant));
            assert_eq!(
                decision.approved,
                one(grant),
                "{app_id}: {:?}",
                decision.denied
            );
        }
    }
    // A reviewed holder of one bridge does not get the other.
    let outreach = validate_grants_for(Some("@ryu/outreach"), &one(SOCIAL_CRUD_GRANT));
    assert_eq!(outreach.denied, one(SOCIAL_CRUD_GRANT));
    let studio = validate_grants_for(Some("@ryu/video-studio"), &one(MAIL_CRUD_GRANT));
    assert_eq!(studio.denied, one(MAIL_CRUD_GRANT));
}

fn declared_grants(manifest: &Value) -> Vec<&str> {
    ["permission_grants", "optional_permission_grants"]
        .iter()
        .filter_map(|key| manifest.get(*key).and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

/// Every in-repo app manifest that declares either grant (required or
/// optional) is its owner or a reviewed cross-app holder, so its
/// disable/re-enable path never fails with GrantsDenied.
#[test]
fn every_in_repo_crossapp_declarer_is_approved() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let Ok(entries) = std::fs::read_dir(repo.join("apps-store")) else {
        return;
    };
    let mut declarers = 0;
    for path in entries.flatten().map(|e| e.path().join("manifest.json")) {
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let id = manifest
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        for grant in [MAIL_CRUD_GRANT, SOCIAL_CRUD_GRANT] {
            if !declared_grants(&manifest).contains(&grant) {
                continue;
            }
            declarers += 1;
            let reviewed = match grant {
                MAIL_CRUD_GRANT => id == "@ryu/mail" || MAIL_CRUD_CROSSAPP_OWNERS.contains(&id),
                _ => id == "@ryu/social" || SOCIAL_CRUD_CROSSAPP_OWNERS.contains(&id),
            };
            assert!(
                reviewed,
                "{} ({id}) declares {grant} but is not a reviewed holder",
                path.display()
            );
            assert_eq!(
                validate_grants_for(Some(id), &one(grant)).approved,
                one(grant),
                "{id}"
            );
        }
    }
    assert!(declarers >= 4, "scanned only {declarers} declarers");
}
