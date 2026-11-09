//! Gateway onboarding access and the imported-conversation read scope.

use super::*;

fn registered(
    scope: crate::sidecar::control_plane::NodeScope,
) -> crate::sidecar::control_plane::RegisteredNode {
    crate::sidecar::control_plane::RegisteredNode {
        org: crate::sidecar::control_plane::RegisteredOrg {
            id: "org-1".to_owned(),
            name: "Test org".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope,
        team_id: (scope == crate::sidecar::control_plane::NodeScope::Team)
            .then(|| "team-1".to_owned()),
        owner_user_id: (scope == crate::sidecar::control_plane::NodeScope::Personal)
            .then(|| "owner-1".to_owned()),
    }
}

fn caller(user_id: &str) -> crate::identity_verify::VerifiedCaller {
    crate::identity_verify::VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org-1".to_owned()),
        role: crate::identity_verify::OrgRole::Owner,
        teams: vec![crate::identity_verify::TeamMembership {
            id: "team-1".to_owned(),
            org_id: "org-1".to_owned(),
            role: "owner".to_owned(),
        }],
    }
}

#[test]
fn gateway_onboarding_allows_unbound_and_personal_owner_only() {
    assert!(
        resolve_gateway_onboarding_access(false, None, None).allowed,
        "an unbound local/VPS node belongs to its single operator"
    );
    assert!(
        resolve_gateway_onboarding_access(
            false,
            Some(&registered(
                crate::sidecar::control_plane::NodeScope::Personal
            )),
            Some(&caller("owner-1")),
        )
        .allowed
    );
    assert_eq!(
        resolve_gateway_onboarding_access(
            false,
            Some(&registered(
                crate::sidecar::control_plane::NodeScope::Personal
            )),
            Some(&caller("member-1")),
        )
        .reason,
        "not_node_owner"
    );
    assert_eq!(
        resolve_gateway_onboarding_access(
            false,
            Some(&registered(
                crate::sidecar::control_plane::NodeScope::Personal
            )),
            None,
        )
        .reason,
        "not_node_owner"
    );
}

#[test]
fn gateway_onboarding_hides_managed_nodes_and_allows_shared_admins() {
    assert_eq!(
        resolve_gateway_onboarding_access(
            true,
            Some(&registered(
                crate::sidecar::control_plane::NodeScope::Personal
            )),
            Some(&caller("owner-1")),
        )
        .reason,
        "managed_node"
    );
    for scope in [
        crate::sidecar::control_plane::NodeScope::Org,
        crate::sidecar::control_plane::NodeScope::Team,
    ] {
        assert_eq!(
            resolve_gateway_onboarding_access(
                false,
                Some(&registered(scope)),
                Some(&caller("owner-1")),
            )
            .reason,
            "shared_node_admin"
        );
    }
}

#[test]
fn profile_import_scope_matches_conversation_read_access() {
    let owner = caller("owner-1");
    let own_private = crate::identity_verify::ResourceTenancy {
        owner_user_id: Some("owner-1".to_owned()),
        org_id: Some("org-1".to_owned()),
        visibility: "private".to_owned(),
        team_id: None,
        collaborators: Vec::new(),
    };
    let other_private = crate::identity_verify::ResourceTenancy {
        owner_user_id: Some("member-1".to_owned()),
        ..own_private.clone()
    };
    let team_other = crate::identity_verify::ResourceTenancy {
        owner_user_id: None,
        visibility: "team".to_owned(),
        team_id: Some("team-2".to_owned()),
        ..own_private.clone()
    };
    let legacy_local = crate::identity_verify::ResourceTenancy {
        owner_user_id: None,
        org_id: None,
        ..own_private.clone()
    };

    assert!(profile_conversation_is_readable(
        &owner,
        &legacy_local,
        false
    ));
    assert!(!profile_conversation_is_readable(
        &owner,
        &legacy_local,
        true
    ));
    assert!(profile_conversation_is_readable(&owner, &own_private, true));
    assert!(!profile_conversation_is_readable(
        &owner,
        &other_private,
        true
    ));
    assert!(!profile_conversation_is_readable(&owner, &team_other, true));
}
