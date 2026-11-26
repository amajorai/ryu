//! Regression tests: the grants that open another app's whole sidecar mount are
//! not approvable for every app.
//!
//! `rlm:query`, `blueprint:review` and `app:http:@ryu/recipes` each gate one
//! generic forwarder that the app host serves with the owner's node token, so a
//! third-party manifest must not be able to request them, while the owning apps
//! and the reviewed in-repo consumers keep them. One test function per grant, so
//! a row can be judged on its own.

use super::mounted_app_grants::{
    BLUEPRINT_REVIEW_GRANT, BLUEPRINT_REVIEW_HOLDERS, RECIPES_REQUEST_GRANT,
    RECIPES_REQUEST_HOLDERS, RLM_QUERY_GRANT, RLM_QUERY_HOLDERS,
};
use super::*;

fn one(grant: &str) -> Vec<String> {
    vec![grant.to_owned()]
}

/// Third-party ids, squatters on each namespace and one unrelated first-party id.
const OTHER_APPS: &[&str] = &[
    "@evil/helper",
    "com.evil.app",
    "@evil/rlm",
    "com.evil.rlm",
    "rlm",
    "@evil/blueprint",
    "com.evil.blueprint",
    "blueprint",
    "@evil/recipes",
    "@evil/workflows",
    "com.evil.workflows",
    "@ryu/notes",
];

/// The ids of `OTHER_APPS` that get `grant` approved, plus a marker when a caller
/// without an app id gets it. Empty when the grant is closed to all of them.
fn approved_for_others(grant: &str) -> Vec<String> {
    let mut approved: Vec<String> = OTHER_APPS
        .iter()
        .copied()
        .filter(|app_id| validate_grants_for(Some(*app_id), &one(grant)).denied != one(grant))
        .map(str::to_owned)
        .collect();
    if validate_grants_for(None, &one(grant)).denied != one(grant) {
        approved.push("(no app id)".to_owned());
    }
    approved
}

fn denied_for_holders(grant: &str, holders: &[&str]) -> Vec<String> {
    holders
        .iter()
        .copied()
        .filter(|app_id| validate_grants_for(Some(*app_id), &one(grant)).approved != one(grant))
        .map(str::to_owned)
        .collect()
}

#[test]
fn mounted_app_grants_are_not_on_the_default_allowlist() {
    let on_the_list: Vec<&str> = [
        RLM_QUERY_GRANT,
        BLUEPRINT_REVIEW_GRANT,
        RECIPES_REQUEST_GRANT,
    ]
    .into_iter()
    .filter(|grant| {
        default_grant_allowlist()
            .iter()
            .any(|entry| entry.trim().eq_ignore_ascii_case(grant))
    })
    .collect();
    assert!(
        on_the_list.is_empty(),
        "approvable for every app: {on_the_list:?}"
    );
    // No per-target cross-app grant is approvable for every app.
    let targets: Vec<String> = default_grant_allowlist()
        .into_iter()
        .filter(|entry| is_app_http_target_grant(entry))
        .collect();
    assert!(targets.is_empty(), "per-target grants: {targets:?}");
}

#[test]
fn a_third_party_app_is_denied_rlm_query() {
    assert_eq!(approved_for_others(RLM_QUERY_GRANT), Vec::<String>::new());
    // Holding another reviewed mount grant does not open this one.
    for app_id in ["@ryu/blueprint", "@ryu/feedback-board", "@ryu/workflows"] {
        let decision = validate_grants_for(Some(app_id), &one(RLM_QUERY_GRANT));
        assert_eq!(decision.denied, one(RLM_QUERY_GRANT), "{app_id}");
    }
}

#[test]
fn deep_read_and_research_keep_rlm_query() {
    assert_eq!(
        denied_for_holders(RLM_QUERY_GRANT, RLM_QUERY_HOLDERS),
        Vec::<String>::new()
    );
    // Research's whole declared set still validates in one request.
    let declared: Vec<String> = ["app:http", "rlm:query", "mcp:research"]
        .iter()
        .map(|grant| (*grant).to_owned())
        .collect();
    let decision = validate_grants_for(Some("@ryu/research"), &declared);
    assert!(decision.all_approved(), "denied: {:?}", decision.denied);
}

#[test]
fn a_third_party_app_is_denied_blueprint_review() {
    assert_eq!(
        approved_for_others(BLUEPRINT_REVIEW_GRANT),
        Vec::<String>::new()
    );
    for app_id in ["@ryu/rlm", "@ryu/research", "@ryu/workflows"] {
        let decision = validate_grants_for(Some(app_id), &one(BLUEPRINT_REVIEW_GRANT));
        assert_eq!(decision.denied, one(BLUEPRINT_REVIEW_GRANT), "{app_id}");
    }
}

#[test]
fn blueprint_and_feedback_board_keep_blueprint_review() {
    assert_eq!(
        denied_for_holders(BLUEPRINT_REVIEW_GRANT, BLUEPRINT_REVIEW_HOLDERS),
        Vec::<String>::new()
    );
}

#[test]
fn only_workflows_is_approved_for_the_recipes_mount() {
    assert_eq!(
        approved_for_others(RECIPES_REQUEST_GRANT),
        Vec::<String>::new()
    );
    // The target app itself and the other reviewed holders get nothing either.
    for app_id in ["@ryu/recipes", "@ryu/rlm", "@ryu/feedback-board"] {
        let decision = validate_grants_for(Some(app_id), &one(RECIPES_REQUEST_GRANT));
        assert_eq!(decision.denied, one(RECIPES_REQUEST_GRANT), "{app_id}");
    }
}

#[test]
fn workflows_keeps_the_recipes_mount_and_the_form_check_still_binds_it() {
    assert_eq!(
        denied_for_holders(RECIPES_REQUEST_GRANT, RECIPES_REQUEST_HOLDERS),
        Vec::<String>::new()
    );
    // A reviewed holder is still held to the exact, lowercase, concrete form.
    for malformed in [
        "app:http:@Ryu/Recipes",
        "APP:HTTP:@ryu/recipes",
        "app:http:@ryu/recipes/extra",
        "app:http:@ryu/*",
    ] {
        let decision = validate_grants_for(Some("@ryu/workflows"), &one(malformed));
        assert_eq!(decision.denied, one(malformed), "{malformed}");
    }
    // And to its own reviewed target.
    let other = validate_grants_for(Some("@ryu/workflows"), &one("app:http:@ryu/mail"));
    assert_eq!(other.denied, one("app:http:@ryu/mail"));
}

fn declared_grants(manifest: &Value) -> Vec<&str> {
    ["permission_grants", "optional_permission_grants"]
        .iter()
        .filter_map(|key| manifest.get(*key).and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

/// Every in-repo app manifest that declares one of the three grants (required
/// or optional) is a reviewed holder, so its disable and re-enable path never
/// fails with GrantsDenied.
#[test]
fn every_in_repo_declarer_is_a_reviewed_holder() {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let Ok(entries) = std::fs::read_dir(repo.join("apps-store")) else {
        // Vendored gateway without the sibling apps-store.
        return;
    };
    let rows: [(&str, &[&str]); 3] = [
        (RLM_QUERY_GRANT, RLM_QUERY_HOLDERS),
        (BLUEPRINT_REVIEW_GRANT, BLUEPRINT_REVIEW_HOLDERS),
        (RECIPES_REQUEST_GRANT, RECIPES_REQUEST_HOLDERS),
    ];
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
        for (grant, holders) in rows {
            if !declared_grants(&manifest).contains(&grant) {
                continue;
            }
            declarers += 1;
            assert!(
                holders.contains(&id),
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
    assert!(declarers >= 5, "scanned only {declarers} declarers");
}
