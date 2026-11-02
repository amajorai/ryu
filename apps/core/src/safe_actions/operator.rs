//! Who may operate Safe Actions: read reviews and receipts, and (with `write`)
//! change policies, attest contracts, and approve or deny pending plans.
//!
//! The local-operator shortcut holds only on a truly unbound node, where the
//! shared node token is the boundary and there is one principal. A node is
//! bound once it is flagged managed OR has registered with an organization;
//! an enrolled self-hosted node registers an org without being managed, and it
//! must apply the same org/role gate as a managed one, or any org Member whose
//! JWT the node admits could approve plans and rewrite verification policies.

use axum::http::StatusCode;

use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::sidecar::control_plane::{NodeScope, RegisteredNode};

/// The operator id to record, or the refusal.
///
/// - Unbound (`!managed_node` and no registered `node`): the caller's id, or
///   `local-operator` when there is no signed-in user.
/// - Managed but not yet registered: `503`, fail closed.
/// - Bound: a signed-in caller is required. A personal node admits its owner
///   alone (as `enforce_permission` does); a team node requires team membership
///   or an org Admin; then the caller must belong to the node's organization
///   with Viewer (read) or Admin (write).
pub(super) fn authorize_operator(
    caller: Option<&VerifiedCaller>,
    managed_node: bool,
    node: Option<&RegisteredNode>,
    write: bool,
) -> Result<String, (StatusCode, &'static str)> {
    let Some(node) = node else {
        if managed_node {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Safe Actions is unavailable until managed-node registration completes",
            ));
        }
        return Ok(caller.map_or_else(
            || "local-operator".to_owned(),
            |identity| identity.user_id.clone(),
        ));
    };
    let Some(identity) = caller else {
        return Err((
            StatusCode::FORBIDDEN,
            "authenticated Safe Actions operator required",
        ));
    };
    let denied = (StatusCode::FORBIDDEN, "Safe Actions operator access denied");
    match node.scope {
        NodeScope::Personal => {
            return if node.owner_user_id.as_deref() == Some(identity.user_id.as_str()) {
                Ok(identity.user_id.clone())
            } else {
                Err(denied)
            };
        }
        NodeScope::Team => {
            let in_team = node.team_id.as_deref().is_some_and(|team_id| {
                identity
                    .teams
                    .iter()
                    .any(|team| team.id == team_id && team.org_id == node.org.id)
            });
            if !in_team && !identity.role.satisfies(OrgRole::Admin) {
                return Err(denied);
            }
        }
        NodeScope::Org => {}
    }
    let required = if write {
        OrgRole::Admin
    } else {
        OrgRole::Viewer
    };
    if identity.org_id.as_deref() != Some(node.org.id.as_str())
        || !identity.role.satisfies(required)
    {
        return Err(denied);
    }
    Ok(identity.user_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::control_plane::RegisteredOrg;

    fn operator(org_id: Option<&str>, role: OrgRole) -> VerifiedCaller {
        VerifiedCaller {
            user_id: "operator-1".to_owned(),
            email: None,
            email_verified: false,
            org_id: org_id.map(str::to_owned),
            role,
            teams: Vec::new(),
        }
    }

    fn node(org_id: &str, scope: NodeScope) -> RegisteredNode {
        RegisteredNode {
            org: RegisteredOrg {
                id: org_id.to_owned(),
                name: org_id.to_owned(),
                slug: None,
            },
            node_id: "node-1".to_owned(),
            scope,
            team_id: None,
            owner_user_id: None,
        }
    }

    fn status(result: Result<String, (StatusCode, &'static str)>) -> StatusCode {
        result.unwrap_err().0
    }

    #[test]
    fn operator_authorization_fails_closed_for_unregistered_managed_nodes() {
        let admin = operator(Some("org-1"), OrgRole::Admin);
        let org_1 = node("org-1", NodeScope::Org);
        assert_eq!(
            status(authorize_operator(Some(&admin), true, None, true)),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            status(authorize_operator(None, true, Some(&org_1), false)),
            StatusCode::FORBIDDEN
        );
        let foreign = node("org-2", NodeScope::Org);
        assert_eq!(
            status(authorize_operator(Some(&admin), true, Some(&foreign), true)),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn operator_authorization_preserves_local_and_role_scoped_access() {
        assert_eq!(
            authorize_operator(None, false, None, true).unwrap(),
            "local-operator"
        );
        let org_1 = node("org-1", NodeScope::Org);
        let viewer = operator(Some("org-1"), OrgRole::Viewer);
        assert_eq!(
            authorize_operator(Some(&viewer), true, Some(&org_1), false).unwrap(),
            "operator-1"
        );
        assert_eq!(
            status(authorize_operator(Some(&viewer), true, Some(&org_1), true)),
            StatusCode::FORBIDDEN
        );
        let admin = operator(Some("org-1"), OrgRole::Admin);
        assert_eq!(
            authorize_operator(Some(&admin), true, Some(&org_1), true).unwrap(),
            "operator-1"
        );
    }

    /// An enrolled self-hosted node registers an org without being managed. It
    /// is bound, so it applies the same org/role gate as a managed node.
    #[test]
    fn registered_unmanaged_node_requires_an_org_admin_to_write() {
        let org_1 = node("org-1", NodeScope::Org);
        let member = operator(Some("org-1"), OrgRole::Member);
        assert_eq!(
            status(authorize_operator(Some(&member), false, Some(&org_1), true)),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            authorize_operator(Some(&member), false, Some(&org_1), false).unwrap(),
            "operator-1"
        );
        let admin = operator(Some("org-1"), OrgRole::Admin);
        assert_eq!(
            authorize_operator(Some(&admin), false, Some(&org_1), true).unwrap(),
            "operator-1"
        );
        assert_eq!(
            status(authorize_operator(None, false, Some(&org_1), false)),
            StatusCode::FORBIDDEN
        );
        let foreign_admin = operator(Some("org-2"), OrgRole::Admin);
        assert_eq!(
            status(authorize_operator(
                Some(&foreign_admin),
                false,
                Some(&org_1),
                true
            )),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn personal_node_admits_only_its_owner() {
        let mut personal = node("org-1", NodeScope::Personal);
        personal.owner_user_id = Some("operator-1".to_owned());
        let owner = operator(Some("org-1"), OrgRole::Member);
        assert_eq!(
            authorize_operator(Some(&owner), false, Some(&personal), true).unwrap(),
            "operator-1"
        );
        personal.owner_user_id = Some("someone-else".to_owned());
        let admin = operator(Some("org-1"), OrgRole::Admin);
        assert_eq!(
            status(authorize_operator(
                Some(&admin),
                false,
                Some(&personal),
                true
            )),
            StatusCode::FORBIDDEN
        );
    }

    #[test]
    fn team_node_requires_team_membership_or_org_admin() {
        let mut team = node("org-1", NodeScope::Team);
        team.team_id = Some("team-1".to_owned());
        let outsider = operator(Some("org-1"), OrgRole::Viewer);
        assert_eq!(
            status(authorize_operator(
                Some(&outsider),
                false,
                Some(&team),
                false
            )),
            StatusCode::FORBIDDEN
        );
        let admin = operator(Some("org-1"), OrgRole::Admin);
        assert_eq!(
            authorize_operator(Some(&admin), false, Some(&team), true).unwrap(),
            "operator-1"
        );
    }

    /// An enrolled self-hosted node (registered org, not managed) is bound: an org
    /// Member's verified JWT reaches `/api/tools/plans` with `ToolsExec`, but must
    /// not approve a pending review or rewrite a policy. An org Admin may decide.
    #[tokio::test]
    async fn registered_unmanaged_node_refuses_member_plan_decisions() {
        use crate::safe_actions::{routes, test_pending_review_plan_hash};
        use crate::sidecar::control_plane::{
            with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
        };
        use axum::{http::Request, Router};
        use ryu_safe_actions::Policy;
        use serde_json::{json, Value};

        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let pending = state.safe_actions.insert_test_pending_review().await;
        let decided = state.safe_actions.insert_test_pending_review().await;
        let node = RegisteredNode {
            org: RegisteredOrg {
                id: "org-1".to_owned(),
                name: "org-1".to_owned(),
                slug: None,
            },
            node_id: "node-1".to_owned(),
            scope: NodeScope::Org,
            team_id: None,
            owner_user_id: None,
        };
        let caller = |user_id: &str, role| crate::identity_verify::VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            email_verified: false,
            org_id: Some("org-1".to_owned()),
            role,
            teams: Vec::new(),
        };
        let send = |caller: crate::identity_verify::VerifiedCaller,
                    method: &str,
                    uri: String,
                    body: Value| {
            let mut request = Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .body(axum::body::Body::from(body.to_string()))
                .unwrap();
            request.extensions_mut().insert(Some(caller));
            let router: Router = routes().with_state(state.clone());
            async move {
                tower::ServiceExt::oneshot(router, request)
                    .await
                    .unwrap()
                    .status()
            }
        };
        let decision = json!({"expected_plan_hash": test_pending_review_plan_hash()});
        with_test_node_binding(false, Some(node), async {
            let member = caller("member-1", crate::identity_verify::OrgRole::Member);
            assert_eq!(
                send(
                    member.clone(),
                    "POST",
                    format!("/api/tools/plans/reviews/{pending}/approve"),
                    decision.clone(),
                )
                .await,
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                send(
                    member.clone(),
                    "POST",
                    format!("/api/tools/plans/reviews/{pending}/deny"),
                    decision.clone(),
                )
                .await,
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                send(
                    member,
                    "PUT",
                    "/api/tools/plans/policies/policy-1".to_owned(),
                    json!({"name": "open", "policy": Policy::default()}),
                )
                .await,
                StatusCode::FORBIDDEN
            );
            let admin = caller("admin-1", crate::identity_verify::OrgRole::Admin);
            assert_eq!(
                send(
                    admin,
                    "POST",
                    format!("/api/tools/plans/reviews/{decided}/deny"),
                    decision.clone(),
                )
                .await,
                StatusCode::OK
            );
        })
        .await;
        assert_eq!(
            state.safe_actions.test_review_state(&pending).await,
            Some(("pending_review".to_owned(), None))
        );
        assert_eq!(
            state.safe_actions.test_review_state(&decided).await,
            Some(("denied_by_reviewer".to_owned(), Some("admin-1".to_owned())))
        );
    }
}
