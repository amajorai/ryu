//! ACL permission vocabulary.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── ACL permission vocabulary ────────────────────────────────────────────────

/// `GET /api/acl/vocabulary` — every permission a grant may name on this node.
///
/// This is what makes an app's `permission_levels` declaration REACHABLE. Without
/// it the declaration would be inert: a surface building a grant picker has no
/// other way to learn that the Workflows app exposes `workflow.edit`, nor that it
/// implies `workflow.run`.
///
/// Two sources, one flat namespace (see [`crate::acl::vocabulary`]): the kernel's
/// canonical keys, which are shared byte-for-byte with the control plane, and the
/// levels each installed app declares. Collisions are REPORTED rather than
/// silently resolved — an app that tried to redefine a kernel key, re-declare
/// another app's level, or imply a kernel key or another app's level had those
/// edges ignored, and the admin granting permissions needs to know that.
pub(in crate::server) async fn acl_vocabulary() -> Json<serde_json::Value> {
    // The SAME cached vocabulary enforcement resolves through, so the picker can
    // never credit an id to a different owner, or show an edge, that the
    // resolver does not use. Each row's `implies` is the honoured edges only.
    let vocab = crate::acl::cached_vocabulary();

    Json(json!({
        // The kernel tier, so a picker can group "built-in" apart from per-app.
        "kernel": crate::identity_verify::permissions::PERMISSIONS,
        "declared": vocab.declared.iter().map(|l| json!({
            "plugin_id": l.plugin_id,
            "id": l.id,
            "label": l.label,
            "description": l.description,
            "implies": l.implies,
        })).collect::<Vec<_>>(),
        "collisions": vocab.collisions,
    }))
}

// ── Per-resource permission enforcement ──────────────────────────────────────

pub(in crate::server) fn resource_permission_admission(
    managed_node: bool,
    node_org: Option<&str>,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
) -> Result<(), StatusCode> {
    if caller.is_none() {
        return if node_org.is_some() || managed_node {
            Err(StatusCode::FORBIDDEN)
        } else {
            Ok(())
        };
    }
    if managed_node && node_org.is_none() {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(())
}

/// Require that the caller holds `permission` on ONE SPECIFIC resource.
///
/// The per-resource sibling of [`enforce_permission`]. That one answers "may this
/// caller do X anywhere in the org"; this one lets a resource carve an exception
/// out of that answer in EITHER direction — a deny overwrite removes a permission
/// the caller's role grants org-wide, and an allow overwrite hands it to someone
/// whose role does not grant it at all. Neither is expressible without reading
/// the resource, which is why this cannot be folded into `enforce_permission`.
///
/// The org-membership and anonymous rules are copied from `enforce_permission`
/// deliberately, so the two gates cannot disagree about who is even a candidate:
///   - anonymous + node UNBOUND -> allowed (a personal node's boundary is its
///     node token; denying would lock the single local user out of their own data);
///   - managed but unregistered -> denied until the node binding resolves;
///   - anonymous + node ORG-BOUND -> denied;
///   - a caller from a different org than the node's -> denied.
///
/// `pub(crate)` because the ext-proxy gates app-declared route permissions through
/// this exact function (`sidecar::ext_proxy`). An app route is not a special case:
/// it needs the same anonymous/org candidacy rules, and a second copy of them living
/// in the proxy is precisely how a personal node would end up locked out of one lane
/// and not the other.
pub(crate) async fn enforce_permission_on(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    perm: &str,
    kind: &str,
    resource_id: &str,
) -> Result<(), StatusCode> {
    if resource_permission_candidate(caller)?.is_none() {
        return Ok(());
    }
    let resolved = match caller {
        Some(caller) => {
            crate::sidecar::control_plane::resolve_permission_context(
                &state.client,
                &caller.user_id,
            )
            .await
        }
        None => Default::default(),
    };
    enforce_permission_on_resolved(caller, perm, kind, resource_id, resolved)
}

/// The shared node candidacy and resource ACL boundary. Deferred execution supplies
/// freshly resolved membership and permissions rather than a cached request context.
pub(crate) fn enforce_permission_on_resolved(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    perm: &str,
    kind: &str,
    resource_id: &str,
    mut resolved: crate::sidecar::control_plane::ResolvedPermissions,
) -> Result<(), StatusCode> {
    let Some(personal_owner) = resource_permission_candidate(caller)? else {
        return Ok(());
    };
    let caller = caller.as_ref().ok_or(StatusCode::FORBIDDEN)?;
    if personal_owner {
        resolved.permissions.insert(perm.to_owned());
    }
    match crate::acl::decide_with_context(
        caller,
        kind,
        resource_id,
        perm,
        &resolved.permissions,
        &resolved.role_ids,
    ) {
        crate::acl::Decision::Allowed => Ok(()),
        crate::acl::Decision::Denied => Err(StatusCode::FORBIDDEN),
    }
}

/// Admit node/org candidates before any control-plane permission lookup. None is
/// the existing unbound local policy; Some carries the personal-owner exception.
pub(in crate::server) fn resource_permission_candidate(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> Result<Option<bool>, StatusCode> {
    let managed_node = crate::sidecar::node_binding::node_expects_binding();
    let node_org = crate::sidecar::control_plane::registered_org().map(|o| o.id);

    resource_permission_admission(managed_node, node_org.as_deref(), caller.as_ref())?;
    let Some(caller) = caller else {
        return Ok(None);
    };

    // UNBOUND node: there is no org to scope roles against, so `to_caller_for_org`
    // narrows a caller with zero or several memberships to `org_id = None` and the
    // LEAST privilege. Falling through with that would resolve a Viewer base and
    // lock the single local user out of their own spaces — the exact trap
    // `resource_access` documents. `enforce_permission` returns Ok here for the
    // same reason; the two gates must not disagree about who is a candidate.
    // A node flagged managed but not yet registered is not an unbound personal
    // node; fail closed until its control-plane binding is available.
    let Some(node_org) = node_org.as_deref() else {
        return Ok(None);
    };

    let personal_owner = if let Some(node) = crate::sidecar::control_plane::registered_node() {
        if node_scope_denial_reason(&node, caller).is_some() {
            return Err(StatusCode::FORBIDDEN);
        }
        node.scope == crate::sidecar::control_plane::NodeScope::Personal
            && node.owner_user_id.as_deref() == Some(caller.user_id.as_str())
    } else {
        false
    };

    if !personal_owner && caller.org_id.as_deref() != Some(node_org) {
        return Err(StatusCode::FORBIDDEN);
    }

    Ok(Some(personal_owner))
}

/// Candidacy for a request the web tier forwarded on a browser's behalf
/// (`sidecar::ext_proxy`'s web-delegated admission).
///
/// The same anonymous/org/node-scope rules as [`resource_permission_candidate`], minus
/// its unbound-node allowance. That allowance rests on "a personal node's boundary is
/// its node token", which does not hold when a shared web portal holds the token for
/// many users, so an unbound (or managed but unregistered) node refuses. `Ok(true)` is
/// the node's personal owner, `Ok(false)` an org member.
pub(crate) fn web_delegated_candidate(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> Result<bool, StatusCode> {
    web_delegated_candidacy(resource_permission_candidate(caller))
}

/// The pure mapping behind [`web_delegated_candidate`]: no binding is a refusal.
pub(in crate::server) fn web_delegated_candidacy(
    candidate: Result<Option<bool>, StatusCode>,
) -> Result<bool, StatusCode> {
    candidate?.ok_or(StatusCode::FORBIDDEN)
}

/// Node ACLs use the normal `roles.manage` guard, with the documented implicit
/// management authority for personal owners and org owners/admins. The id is
/// pinned to the registered node so this endpoint cannot be used to edit an
/// arbitrary node key.
pub(in crate::server) async fn enforce_node_acl_management(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    kind: &str,
    resource_id: &str,
) -> Result<(), axum::response::Response> {
    if kind == crate::acl::KIND_NODE {
        let Some(node) = crate::sidecar::control_plane::registered_node() else {
            return Err(json_error(
                StatusCode::NOT_FOUND,
                "node ACLs are unavailable on an unbound node".to_owned(),
            ));
        };
        if resource_id != node.node_id {
            return Err(json_error(
                StatusCode::NOT_FOUND,
                "node ACL id does not match the registered node".to_owned(),
            ));
        }
        let Some(caller) = caller.as_ref() else {
            return Err(app_lifecycle_denied(
                crate::identity_verify::permissions::ROLES_MANAGE,
                Some(&node),
                "authentication_required",
            ));
        };
        if let Some(reason) = node_scope_denial_reason(&node, caller) {
            return Err(app_lifecycle_denied(
                crate::identity_verify::permissions::ROLES_MANAGE,
                Some(&node),
                reason,
            ));
        }
        let personal_owner = node.scope == crate::sidecar::control_plane::NodeScope::Personal
            && node.owner_user_id.as_deref() == Some(caller.user_id.as_str());
        let org_admin = node.scope != crate::sidecar::control_plane::NodeScope::Personal
            && caller.org_id.as_deref() == Some(node.org.id.as_str())
            && caller
                .role
                .satisfies(crate::identity_verify::OrgRole::Admin);
        if personal_owner || org_admin {
            return Ok(());
        }
    }

    enforce_permission_on(
        state,
        caller,
        crate::identity_verify::permissions::ROLES_MANAGE,
        kind,
        resource_id,
    )
    .await
    .map_err(|_| {
        json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: roles.manage".to_owned(),
        )
    })
}

/// The space a document really belongs to, for authorization.
///
/// `/api/spaces/:id/documents/:doc_id` lets a caller name ANY space next to a
/// document. Resolving a per-resource ACL against that URL id would let someone
/// bypass a deny on the document's REAL space by naming a different space they
/// can read, so every document gate resolves the parent from the store instead.
/// A missing document yields `None`, which callers surface as 404 — never as
/// permitted.
pub(crate) async fn document_parent_space(state: &ServerState, doc_id: &str) -> Option<String> {
    state.spaces.document_space_id(doc_id).await.ok().flatten()
}
