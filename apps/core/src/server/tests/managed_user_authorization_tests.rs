use crate::authorization::{Capability, RoutePolicy};
use crate::identity_verify::{OrgRole, ResourceTenancy, TeamMembership, VerifiedCaller};
use crate::server::{
    anonymous_host_conversation_allowed, caller_owns_host_conversation, host_conversation_proof,
    host_conversation_proof_is_valid, managed_user_jwt_resolution_for,
};
use crate::sidecar::control_plane::{NodeScope, RegisteredNode, RegisteredOrg};

fn node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org_1".to_owned(),
            name: "Acme".to_owned(),
            slug: None,
        },
        node_id: "node_1".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

fn caller(role: OrgRole, org_id: &str) -> VerifiedCaller {
    VerifiedCaller {
        user_id: "user_1".to_owned(),
        email: None,
        email_verified: false,
        org_id: Some(org_id.to_owned()),
        role,
        teams: Vec::new(),
    }
}

fn team_node() -> RegisteredNode {
    RegisteredNode {
        team_id: Some("team_1".to_owned()),
        scope: NodeScope::Team,
        ..node()
    }
}

fn personal_node() -> RegisteredNode {
    RegisteredNode {
        owner_user_id: Some("user_1".to_owned()),
        scope: NodeScope::Personal,
        ..node()
    }
}

#[test]
fn member_user_jwt_gets_tool_execution_but_not_management() {
    let resolved =
        managed_user_jwt_resolution_for(caller(OrgRole::Member, "org_1"), &node(), Some("ryu"), 10)
            .expect("same-org member should resolve");

    assert!(!resolved.context.is_owner());
    assert!(resolved
        .context
        .authorize(
            &RoutePolicy::requires([Capability::ToolsExec]),
            &resolved.bindings,
            10,
        )
        .is_allowed());
    assert_eq!(
        resolved
            .context
            .authorize(&RoutePolicy::OwnerOnly, &resolved.bindings, 10),
        crate::authorization::AuthorizationDecision::Deny(
            crate::authorization::DenialReason::OwnerRequired
        )
    );
}

#[test]
fn viewer_user_jwt_can_list_tools_but_cannot_execute_them() {
    let resolved =
        managed_user_jwt_resolution_for(caller(OrgRole::Viewer, "org_1"), &node(), Some("ryu"), 10)
            .expect("same-org viewer should resolve");

    assert!(resolved
        .context
        .authorize(
            &RoutePolicy::requires([Capability::ToolsRead]),
            &resolved.bindings,
            10,
        )
        .is_allowed());
    assert!(!resolved
        .context
        .authorize(
            &RoutePolicy::requires([Capability::ToolsExec]),
            &resolved.bindings,
            10,
        )
        .is_allowed());
}

#[test]
fn a_user_from_another_org_is_not_admitted() {
    assert!(managed_user_jwt_resolution_for(
        caller(OrgRole::Owner, "org_other"),
        &node(),
        Some("ryu"),
        10
    )
    .is_none());
}

#[test]
fn team_node_requires_membership_in_that_team() {
    let mut member = caller(OrgRole::Member, "org_1");
    assert!(
        managed_user_jwt_resolution_for(member.clone(), &team_node(), Some("ryu"), 10).is_none()
    );

    member.teams.push(TeamMembership {
        id: "team_1".to_owned(),
        org_id: "org_1".to_owned(),
        role: "member".to_owned(),
    });
    assert!(managed_user_jwt_resolution_for(member, &team_node(), Some("ryu"), 10).is_some());
}

#[test]
fn personal_node_requires_the_owner() {
    assert!(managed_user_jwt_resolution_for(
        caller(OrgRole::Member, "org_1"),
        &personal_node(),
        Some("ryu"),
        10
    )
    .is_some());

    let mut other = caller(OrgRole::Member, "org_1");
    other.user_id = "user_2".to_owned();
    assert!(managed_user_jwt_resolution_for(other, &personal_node(), Some("ryu"), 10).is_none());
}

#[test]
fn agent_surface_admission_keeps_read_and_edit_capabilities_distinct() {
    let viewer = managed_user_jwt_resolution_for(
        caller(OrgRole::Viewer, "org_1"),
        &node(),
        Some("agent-a"),
        10,
    )
    .expect("same-org viewer should reach the resource ACL");
    assert!(viewer
        .context
        .authorize(
            &RoutePolicy::requires([Capability::AgentsRead]),
            &viewer.bindings,
            10,
        )
        .is_allowed());
    assert!(!viewer
        .context
        .authorize(
            &RoutePolicy::requires([Capability::AgentsManage]),
            &viewer.bindings,
            10,
        )
        .is_allowed());

    // A personal-node owner with an administrator role remains admitted to
    // both sides of the surface; the resource gate then applies the exact
    // agent ACL without changing the node-scope contract.
    let owner = managed_user_jwt_resolution_for(
        caller(OrgRole::Owner, "org_1"),
        &personal_node(),
        Some("agent-a"),
        10,
    )
    .expect("personal-node owner should reach agent management");
    assert!(owner
        .context
        .authorize(
            &RoutePolicy::requires([Capability::AgentsRead]),
            &owner.bindings,
            10,
        )
        .is_allowed());
    assert!(owner
        .context
        .authorize(
            &RoutePolicy::requires([Capability::AgentsManage]),
            &owner.bindings,
            10,
        )
        .is_allowed());
}

#[test]
fn a_shared_conversation_does_not_delegate_its_owner_vault() {
    let member = caller(OrgRole::Member, "org_1");
    let visible_to_member = ResourceTenancy {
        owner_user_id: Some("user_2".to_owned()),
        org_id: Some("org_1".to_owned()),
        visibility: "org".to_owned(),
        team_id: None,
        collaborators: Vec::new(),
    };
    assert!(!caller_owns_host_conversation(&member, &visible_to_member));

    let own = ResourceTenancy {
        owner_user_id: Some("user_1".to_owned()),
        ..visible_to_member
    };
    assert!(caller_owns_host_conversation(&member, &own));
}

#[test]
fn anonymous_host_conversation_context_requires_a_trusted_forwarder_on_bound_nodes() {
    assert!(!anonymous_host_conversation_allowed(true, false));
    assert!(anonymous_host_conversation_allowed(true, true));
    assert!(anonymous_host_conversation_allowed(false, false));
}

#[test]
fn host_conversation_proof_binds_the_id_to_this_core_process() {
    let proof = host_conversation_proof("conversation-1");
    assert!(host_conversation_proof_is_valid("conversation-1", &proof));
    assert!(!host_conversation_proof_is_valid("conversation-2", &proof));
    assert!(!host_conversation_proof_is_valid(
        "conversation-1",
        "invalid"
    ));
}
