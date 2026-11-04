use crate::events::{NavigationKind, NavigationRequest};
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::server::navigation_visible_to_caller;

fn request(target_user_id: Option<&str>) -> NavigationRequest {
    NavigationRequest {
        plugin_id: "agent".to_owned(),
        target: "agents".to_owned(),
        params: None,
        kind: NavigationKind::Tab,
        force_new: false,
        target_user_id: target_user_id.map(str::to_owned),
    }
}

fn caller(user_id: &str) -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    })
}

#[test]
fn targeted_navigation_reaches_only_the_verified_user() {
    let addressed = request(Some("alice"));
    assert!(navigation_visible_to_caller(
        &addressed,
        &caller("alice"),
        true
    ));
    assert!(!navigation_visible_to_caller(
        &addressed,
        &caller("bob"),
        true
    ));
    assert!(!navigation_visible_to_caller(&addressed, &None, true));
}

#[test]
fn unaddressed_navigation_is_personal_node_only() {
    let unaddressed = request(None);
    assert!(navigation_visible_to_caller(&unaddressed, &None, false));
    assert!(!navigation_visible_to_caller(
        &unaddressed,
        &caller("alice"),
        true
    ));
}
