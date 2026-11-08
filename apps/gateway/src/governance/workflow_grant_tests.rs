//! Regression tests: `workflows:crud` / `workflows:runstate` are owner-exclusive.
//!
//! A saved workflow runs its Tool, Mcp, GhostAction, Script and Agent nodes as
//! the owner with no per-call approval, so authoring or running one is
//! equivalent to the reserved `tool:call` / `hook:run-agent:write` grants. The
//! Gateway must approve them only for the reviewed first-party owners.

use super::*;

fn grants(list: &[&str]) -> Vec<String> {
    list.iter().map(|grant| (*grant).to_string()).collect()
}

#[test]
fn third_party_apps_cannot_obtain_workflow_authoring_or_run_grants() {
    let allow = default_grant_allowlist();
    for grant in ["workflows:crud", "workflows:runstate"] {
        assert!(!allow.iter().any(|g| g == grant), "{grant} is allowlisted");
    }
    for app_id in ["@acme/x", "com.evil.app", "@ryu/notes", "workflows"] {
        let d = validate_grants_for(
            Some(app_id),
            &grants(&["workflows:crud", "workflows:runstate"]),
        );
        assert!(d.approved.is_empty(), "{app_id}: {:?}", d.approved);
        assert_eq!(d.denied.len(), 2, "{app_id}");
    }
    // The read-only node-config catalogs stay available to any app.
    let d = validate_grants_for(Some("@acme/x"), &grants(&["workflows:catalogs"]));
    assert!(d.all_approved(), "denied: {:?}", d.denied);
}

#[test]
fn reviewed_workflow_owners_keep_their_grants() {
    for app_id in [
        "@ryu/workflows",
        "com.ryu.workflows",
        "@ryu/feedback-board",
        "com.ryu.feedback-board",
    ] {
        let d = validate_grants_for(
            Some(app_id),
            &grants(&["workflows:crud", "workflows:runstate", "workflows:catalogs"]),
        );
        assert!(d.all_approved(), "{app_id} denied: {:?}", d.denied);
    }
    // Healing only re-runs failed runs; it never authors workflows.
    let d = validate_grants_for(
        Some("@ryu/healing"),
        &grants(&["workflows:runstate", "workflows:crud"]),
    );
    assert_eq!(d.approved, vec!["workflows:runstate".to_string()]);
    assert_eq!(d.denied, vec!["workflows:crud".to_string()]);
}
