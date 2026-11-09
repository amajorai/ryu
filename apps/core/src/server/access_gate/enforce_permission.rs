//! The App route gate, verified-caller extraction, permission enforcement and marketplace package routes: `enforce_permission_or_unavailable` through `enforce_app_lifecycle_permission_json`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// [`enforce_permission`], except that a custom-role lookup the control plane
/// could not answer (an outage, not a refusal) is `503 Service Unavailable`
/// instead of `403`. Both refuse; a long-lived stream uses the difference to
/// retry the check rather than drop the capability for its whole lifetime.
pub(crate) async fn enforce_permission_or_unavailable(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    perm: &str,
) -> Result<(), StatusCode> {
    // An enrolled node whose registration is pending, failed or revoked is not
    // an unbound personal node: it fails closed like a managed one.
    let managed_node = crate::sidecar::node_binding::node_expects_binding();
    let node_org = crate::sidecar::control_plane::registered_org().map(|o| o.id);

    match caller {
        None => {
            if node_org.is_some() || managed_node {
                Err(StatusCode::FORBIDDEN)
            } else {
                Ok(())
            }
        }
        Some(caller) => {
            if let Some(node) = crate::sidecar::control_plane::registered_node() {
                // A personal node is private even when its owner belongs to an
                // organization. Its owner keeps the local full-trust behavior;
                // every other caller is refused before role permissions are read.
                if node.scope == crate::sidecar::control_plane::NodeScope::Personal {
                    return if node.owner_user_id.as_deref() == Some(caller.user_id.as_str()) {
                        Ok(())
                    } else {
                        Err(StatusCode::FORBIDDEN)
                    };
                }
                if node_scope_denial_reason(&node, caller).is_some() {
                    return Err(StatusCode::FORBIDDEN);
                }
            }
            match node_org.as_deref() {
                None if managed_node => Err(StatusCode::FORBIDDEN),
                None => Ok(()),
                Some(node_org) => {
                    if caller.org_id.as_deref() != Some(node_org) {
                        return Err(StatusCode::FORBIDDEN);
                    }
                    if crate::identity_verify::permissions::can(caller.role, perm) {
                        return Ok(());
                    }
                    let Ok(custom) = crate::sidecar::control_plane::try_resolve_permission_context(
                        &state.client,
                        &caller.user_id,
                    )
                    .await
                    else {
                        return Err(StatusCode::SERVICE_UNAVAILABLE);
                    };
                    if custom.permissions.contains(perm) {
                        Ok(())
                    } else {
                        Err(StatusCode::FORBIDDEN)
                    }
                }
            }
        }
    }
}

/// The lifecycle permissions are deliberately separate from the general plugin
/// route permission. Every package kind (apps, plugins, skills, agents,
/// workflows, themes, profiles, bundles, and future kinds) resolves against the
/// same node resource, so a grant cannot accidentally apply to only one catalog
/// surface.
pub(in crate::server) const APP_LIFECYCLE_PERMISSIONS: &[&str] = &[
    crate::identity_verify::permissions::APP_INSTALL,
    crate::identity_verify::permissions::APP_UPDATE,
    crate::identity_verify::permissions::APP_ENABLE,
    crate::identity_verify::permissions::APP_DISABLE,
    crate::identity_verify::permissions::APP_UNINSTALL,
];

/// Validate that a verified caller is eligible to resolve permissions on this
/// registered node. This is intentionally separate from the ACL resolver: a
/// node's org/team/personal boundary must be satisfied before an ACL overwrite
/// can grant or deny anything.
pub(in crate::server) fn node_scope_denial_reason(
    node: &crate::sidecar::control_plane::RegisteredNode,
    caller: &crate::identity_verify::VerifiedCaller,
) -> Option<&'static str> {
    match node.scope {
        crate::sidecar::control_plane::NodeScope::Personal => (node.owner_user_id.as_deref()
            != Some(caller.user_id.as_str()))
        .then_some("personal_node_owner_only"),
        crate::sidecar::control_plane::NodeScope::Org => (caller.org_id.as_deref()
            != Some(node.org.id.as_str()))
        .then_some("organization_membership_required"),
        crate::sidecar::control_plane::NodeScope::Team => {
            if caller.org_id.as_deref() != Some(node.org.id.as_str()) {
                return Some("organization_membership_required");
            }
            let in_team = node.team_id.as_deref().is_some_and(|team_id| {
                caller
                    .teams
                    .iter()
                    .any(|team| team.id == team_id && team.org_id == node.org.id)
            });
            let org_admin = caller
                .role
                .satisfies(crate::identity_verify::OrgRole::Admin);
            (!in_team && !org_admin).then_some("team_membership_required")
        }
    }
}

/// Error code for a signed-in caller whose user JWT carries no claim for the
/// organization this node belongs to.
///
/// The control plane applies each organization's access policy (required
/// two-factor, IP allowlist, session max age) when it mints the JWT and leaves
/// an organization that refuses the session out of the token
/// (`packages/auth/src/lib/jwt-org-access.ts`). Core verifies the token offline
/// and cannot tell that omission from a caller who is not a member at all, so
/// the refusal names both and says how a member gets the claim back.
pub(crate) const ORG_ACCESS_NOT_IN_SESSION: &str = "org_access_not_in_session";

/// The surface-neutral explanation sent with [`ORG_ACCESS_NOT_IN_SESSION`].
/// Clients add their own command or button (`ryu secrets confirm`, the desktop
/// sign-in) on top of it.
pub(crate) const ORG_ACCESS_NOT_IN_SESSION_MESSAGE: &str = "Your sign-in does not include access to the organization this node belongs to. If you are a member, the organization's security policy left it out of this session, for example because it requires two-factor authentication. Confirm it's you with your authenticator app, or sign out and sign in again with a passkey or your authenticator app, then retry.";

/// Whether `caller` is refused on `node` only because their JWT carries no
/// claim for the node's organization. A personal node admits its owner alone,
/// whatever the claims say, so it never reports this.
pub(in crate::server) fn org_claim_missing(
    node: &crate::sidecar::control_plane::RegisteredNode,
    caller: &crate::identity_verify::VerifiedCaller,
) -> bool {
    node.scope != crate::sidecar::control_plane::NodeScope::Personal
        && caller.org_id.as_deref() != Some(node.org.id.as_str())
}

/// The `403` for [`ORG_ACCESS_NOT_IN_SESSION`], in the structured error
/// contract (`{ "error": { "code", "message" } }`). It names no organization:
/// the caller may not be a member.
pub(in crate::server) fn org_access_not_in_session_response() -> axum::response::Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "error": {
                "code": ORG_ACCESS_NOT_IN_SESSION,
                "message": ORG_ACCESS_NOT_IN_SESSION_MESSAGE,
            }
        })),
    )
        .into_response()
}

/// A `403` with no body: what a handler returns from
/// [`enforce_permission`]'s bare `StatusCode`. A refusal that already explains
/// itself is left alone.
pub(in crate::server) fn is_bare_forbidden(response: &axum::response::Response) -> bool {
    use axum::body::HttpBody as _;
    response.status() == StatusCode::FORBIDDEN
        && !response
            .headers()
            .contains_key(axum::http::header::CONTENT_TYPE)
        && response.body().size_hint().exact() == Some(0)
}

/// Whether a bearer that admitted nothing else is a verified user JWT refused
/// only for lacking this node's organization claim (see
/// [`ORG_ACCESS_NOT_IN_SESSION`]). Verification is offline, and it runs only
/// after every other credential kind has already failed.
pub(in crate::server) async fn bearer_user_jwt_lacks_node_org(token: &str) -> bool {
    if token.split('.').count() != 3 {
        return false;
    }
    let Some(node) = crate::sidecar::control_plane::registered_node() else {
        return false;
    };
    let Some(caller) = verified_caller_from_token(token).await else {
        return false;
    };
    org_claim_missing(&node, &caller)
}

pub(in crate::server) fn app_lifecycle_denied(
    permission: &str,
    node: Option<&crate::sidecar::control_plane::RegisteredNode>,
    reason: &str,
) -> axum::response::Response {
    (
        StatusCode::FORBIDDEN,
        Json(app_lifecycle_denied_value(permission, node, reason)),
    )
        .into_response()
}

pub(in crate::server) fn app_lifecycle_denied_value(
    permission: &str,
    node: Option<&crate::sidecar::control_plane::RegisteredNode>,
    reason: &str,
) -> serde_json::Value {
    let node_scope = node.map(|registered| match registered.scope {
        crate::sidecar::control_plane::NodeScope::Org => "org",
        crate::sidecar::control_plane::NodeScope::Team => "team",
        crate::sidecar::control_plane::NodeScope::Personal => "personal",
    });
    json!({
        "success": false,
        "error": "app_lifecycle_permission_denied",
        "required_permission": permission,
        "node_scope": node_scope,
        "node": node.map(|registered| json!({
            "id": registered.node_id,
            "scope": node_scope,
            "orgId": registered.org.id,
            "teamId": registered.team_id,
            "ownerUserId": registered.owner_user_id,
        })),
        "reason": reason,
    })
}

/// Enforce one app lifecycle operation at the exact managed-node boundary.
///
/// The node scope is checked before the ACL resolver so a valid org JWT cannot
/// be reused against a team or personal node. The resolver remains authoritative
/// after that boundary: explicit node denies win over role/default grants and
/// explicit team/member/role allows can grant the otherwise-denied member/viewer
/// lifecycle permissions.
pub(in crate::server) async fn enforce_app_lifecycle_permission(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &str,
) -> Result<(), axum::response::Response> {
    // An enrolled node whose registration is pending, failed or revoked is not
    // an unbound personal node: it fails closed like a managed one.
    let managed_node = crate::sidecar::node_binding::node_expects_binding();
    let node = crate::sidecar::control_plane::registered_node();
    let Some(node) = node.as_ref() else {
        // A managed node is not temporarily local while registration is still
        // resolving. Fail closed here so a missing registration cannot bypass
        // the lifecycle ACL during startup or after a rejected handshake.
        if managed_node {
            return Err(app_lifecycle_denied(
                permission,
                None,
                "managed_node_unregistered",
            ));
        }
        // An unbound local node retains the existing node-token owner behavior.
        return Ok(());
    };

    let Some(caller) = caller.as_ref() else {
        return Err(app_lifecycle_denied(
            permission,
            Some(node),
            "authentication_required",
        ));
    };

    if let Some(reason) = node_scope_denial_reason(node, caller) {
        return Err(app_lifecycle_denied(permission, Some(node), reason));
    }

    let is_personal_owner = node.scope == crate::sidecar::control_plane::NodeScope::Personal
        && node.owner_user_id.as_deref() == Some(caller.user_id.as_str());

    // Custom roles are resolved from the control plane and degrade to an empty
    // set on lookup failure, which preserves the existing fail-closed contract.
    let mut resolved =
        crate::sidecar::control_plane::resolve_permission_context(&state.client, &caller.user_id)
            .await;
    // The personal owner has an implicit full lifecycle grant. Passing it through
    // the normal resolver keeps explicit node denies authoritative.
    if is_personal_owner {
        resolved.permissions.insert(permission.to_owned());
    }

    if crate::acl::decide_with_context(
        caller,
        crate::acl::KIND_NODE,
        &node.node_id,
        permission,
        &resolved.permissions,
        &resolved.role_ids,
    )
    .is_allowed()
    {
        Ok(())
    } else {
        Err(app_lifecycle_denied(
            permission,
            Some(node),
            "node_acl_denied",
        ))
    }
}

/// Tuple-shaped companion for catalog handlers that still expose the historic
/// `(StatusCode, Json<Value>)` return type. It delegates the decision to the
/// canonical response-producing guard, then preserves the same structured 403
/// contract without making each catalog handler convert an Axum response.
pub(in crate::server) async fn enforce_app_lifecycle_permission_json(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    permission: &str,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if enforce_app_lifecycle_permission(state, caller, permission)
        .await
        .is_ok()
    {
        return Ok(());
    }
    Err((
        StatusCode::FORBIDDEN,
        Json(app_lifecycle_denied_value(
            permission,
            crate::sidecar::control_plane::registered_node().as_ref(),
            "node_scope_or_acl_denied",
        )),
    ))
}
