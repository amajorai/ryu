//! Regression tests: `skills:crud` is not approvable for every app.
//!
//! The grant drives Core's `/api/skills` through the desktop host with the
//! owner node token, so a holder can write always-on, tool-preapproved
//! SKILL.md files that every Ryu agent and Claude Code load. Only the reviewed
//! Skill Editor may hold it.

use super::crossapp_grants::{SKILLS_CRUD_CROSSAPP_OWNERS, SKILLS_CRUD_GRANT};
use super::*;

fn one(grant: &str) -> Vec<String> {
    vec![grant.to_owned()]
}

#[test]
fn skills_crud_is_not_on_the_default_allowlist() {
    assert!(
        !default_grant_allowlist()
            .iter()
            .any(|entry| entry.eq_ignore_ascii_case(SKILLS_CRUD_GRANT)),
        "skills:crud must not be approvable for every app"
    );
}

#[test]
fn third_party_apps_are_denied_skills_crud() {
    for app_id in [
        "com.evil.notes",
        "@evil/skills",
        "com.evil.skills",
        "@evil/skill-editor",
        "skills",
        "@ryu/notes",
    ] {
        let decision = validate_grants_for(Some(app_id), &one(SKILLS_CRUD_GRANT));
        assert!(
            decision.approved.is_empty(),
            "{app_id} approved skills:crud"
        );
        assert_eq!(decision.denied, one(SKILLS_CRUD_GRANT), "{app_id}");
    }
    assert_eq!(
        validate_grants_for(None, &one(SKILLS_CRUD_GRANT)).denied,
        one(SKILLS_CRUD_GRANT)
    );
}

#[test]
fn skill_editor_keeps_skills_crud() {
    for app_id in ["@ryu/skill-editor", "com.ryu.skill-editor"] {
        let decision = validate_grants_for(Some(app_id), &one(SKILLS_CRUD_GRANT));
        assert_eq!(
            decision.approved,
            one(SKILLS_CRUD_GRANT),
            "{app_id}: {:?}",
            decision.denied
        );
    }
}

/// Every in-repo app manifest declaring `skills:crud` is a reviewed holder, so
/// its disable/re-enable path never fails with GrantsDenied.
#[test]
fn every_in_repo_skills_crud_declarer_is_reviewed() {
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
        let declares = ["permission_grants", "optional_permission_grants"]
            .iter()
            .filter_map(|key| manifest.get(*key).and_then(Value::as_array))
            .flatten()
            .any(|grant| grant.as_str() == Some(SKILLS_CRUD_GRANT));
        if !declares {
            continue;
        }
        declarers += 1;
        let id = manifest
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(
            SKILLS_CRUD_CROSSAPP_OWNERS.contains(&id),
            "{} ({id}) declares skills:crud but is not a reviewed holder",
            path.display()
        );
    }
    assert!(declarers >= 1, "scanned only {declarers} declarers");
}
