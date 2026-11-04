use crate::identity_verify::{OrgRole, TeamMembership, VerifiedCaller};
use crate::server::node_scope_denial_reason;
use crate::sidecar::control_plane::{NodeScope, RegisteredNode, RegisteredOrg};

fn caller(user_id: &str, org_id: Option<&str>, role: OrgRole, teams: &[&str]) -> VerifiedCaller {
    VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: org_id.map(str::to_owned),
        role,
        teams: teams
            .iter()
            .map(|id| TeamMembership {
                id: (*id).to_owned(),
                org_id: "org-1".to_owned(),
                role: "member".to_owned(),
            })
            .collect(),
    }
}

fn node(scope: NodeScope, team_id: Option<&str>, owner_user_id: Option<&str>) -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org-1".to_owned(),
            name: "Acme".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope,
        team_id: team_id.map(str::to_owned),
        owner_user_id: owner_user_id.map(str::to_owned),
    }
}

#[test]
fn team_scope_requires_team_membership_but_allows_org_admin() {
    let team_node = node(NodeScope::Team, Some("team-1"), None);
    assert_eq!(
        node_scope_denial_reason(
            &team_node,
            &caller("member", Some("org-1"), OrgRole::Member, &["team-1"])
        ),
        None
    );
    assert_eq!(
        node_scope_denial_reason(
            &team_node,
            &caller("other", Some("org-1"), OrgRole::Member, &["team-2"])
        ),
        Some("team_membership_required")
    );
    assert_eq!(
        node_scope_denial_reason(
            &team_node,
            &caller("admin", Some("org-1"), OrgRole::Admin, &[])
        ),
        None
    );
}

#[test]
fn personal_scope_never_yields_to_org_administration() {
    let personal_node = node(NodeScope::Personal, None, Some("owner"));
    assert_eq!(
        node_scope_denial_reason(&personal_node, &caller("owner", None, OrgRole::Viewer, &[])),
        None
    );
    assert_eq!(
        node_scope_denial_reason(
            &personal_node,
            &caller("admin", Some("org-1"), OrgRole::Admin, &[])
        ),
        Some("personal_node_owner_only")
    );
}

#[test]
fn org_scope_rejects_non_members() {
    let org_node = node(NodeScope::Org, None, None);
    assert_eq!(
        node_scope_denial_reason(
            &org_node,
            &caller("outsider", Some("org-2"), OrgRole::Member, &[])
        ),
        Some("organization_membership_required")
    );
}

#[test]
fn team_ids_from_another_org_do_not_authorize_a_node() {
    let team_node = node(NodeScope::Team, Some("team-1"), None);
    let mut cross_org = caller("member", Some("org-1"), OrgRole::Member, &["team-1"]);
    cross_org.teams[0].org_id = "org-2".to_owned();
    assert_eq!(
        node_scope_denial_reason(&team_node, &cross_org),
        Some("team_membership_required")
    );
}
