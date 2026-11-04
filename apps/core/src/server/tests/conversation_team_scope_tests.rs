use crate::identity_verify::{OrgRole, TeamMembership, VerifiedCaller};
use crate::server::conversation_team_scope_authorized;

#[test]
fn sharing_requires_verified_same_org_team_or_org_admin() {
    let mut caller = VerifiedCaller {
        user_id: "owner".into(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".into()),
        role: OrgRole::Member,
        teams: Vec::new(),
    };
    assert!(!conversation_team_scope_authorized(
        Some("target"),
        Some(&caller),
        Some("org-1")
    ));
    caller.teams.push(TeamMembership {
        id: "target".into(),
        org_id: "other-org".into(),
        role: "member".into(),
    });
    assert!(!conversation_team_scope_authorized(
        Some("target"),
        Some(&caller),
        Some("org-1")
    ));
    caller.teams[0].org_id = "org-1".into();
    assert!(conversation_team_scope_authorized(
        Some("target"),
        Some(&caller),
        Some("org-1")
    ));
    assert!(conversation_team_scope_authorized(
        None,
        Some(&caller),
        Some("org-1")
    ));
    caller.teams.clear();
    caller.role = OrgRole::Admin;
    assert!(conversation_team_scope_authorized(
        Some("target"),
        Some(&caller),
        Some("org-1")
    ));
    caller.org_id = Some("other-org".into());
    assert!(!conversation_team_scope_authorized(
        Some("target"),
        Some(&caller),
        Some("org-1")
    ));
    assert!(!conversation_team_scope_authorized(
        Some("target"),
        None,
        Some("org-1")
    ));
    assert!(conversation_team_scope_authorized(
        Some("target"),
        None,
        None
    ));
}
