//! Principal directory (what a grant editor offers to target).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Principal directory (what a grant editor offers to target) ───────────────

/// Shape the principal directory from ALREADY-RESOLVED inputs.
///
/// Split from the handler so the degradation contract is a pure unit test: no
/// env var, no control plane, no clock. The handler's only job is to fetch.
pub(in crate::server) fn acl_principals_payload(
    teams: Vec<crate::sidecar::control_plane::OrgTeam>,
    members: Vec<crate::sidecar::control_plane::NotifyTargetUser>,
    custom_roles: Vec<crate::sidecar::control_plane::OrgRole>,
) -> serde_json::Value {
    // Roles are LOCAL — the same ids `builtin_role_catalog` keys its base sets by.
    // They must be offered even on an unbound node, where the other two lists are
    // empty: a role overwrite resolves entirely in-process, so a picker with no
    // roles would hide the one target type that always works.
    let mut roles: Vec<serde_json::Value> = crate::acl::vocabulary::builtin_role_ids()
        .map(|id| {
            let mut label = id.to_owned();
            label[..1].make_ascii_uppercase();
            json!({ "id": id, "label": label })
        })
        .collect();
    roles.extend(custom_roles.into_iter().map(|role| {
        json!({
            "id": role.id,
            "label": role.name.unwrap_or_else(|| role.id.clone()),
        })
    }));

    json!({
        // The kinds this node actually enforces per-resource permissions on.
        // Served rather than hardcoded client-side: the desktop had its own list
        // that already said only "space" while Core enforced three more, so every
        // agent and workflow was uneditable and nothing failed to warn about it.
        "kinds": crate::acl::ENFORCED_KINDS,
        // The org whose id an `org`-tier overwrite must name. Without it the UI
        // wrote `Org("")`, which matches no principal — every org-wide rule the
        // editor produced was silently dead. `None` on an unbound node, where the
        // org tier is meaningless anyway.
        "org_id": crate::sidecar::control_plane::registered_org().map(|o| o.id),
        "roles": roles,
        "teams": teams
            .iter()
            .map(|t| json!({ "id": t.id, "name": t.name.clone().unwrap_or_else(|| t.id.clone()) }))
            .collect::<Vec<_>>(),
        "members": members
            .iter()
            .map(|m| {
                // A member row is driven off the org `member` doc, so name and email
                // are both optional; falling back to the user id keeps every row
                // selectable instead of rendering a blank, unclickable entry.
                let name = m.name.clone().or_else(|| {
                    m.email
                        .as_deref()
                        .and_then(|e| e.split('@').next())
                        .filter(|local| !local.is_empty())
                        .map(str::to_owned)
                });
                json!({
                    "id": m.user_id,
                    "name": name.unwrap_or_else(|| m.user_id.clone()),
                    // Empty rather than null: every field of a directory row is a
                    // string the picker renders, and a null would land in a hint
                    // slot typed as one.
                    "email": m.email.clone().unwrap_or_default(),
                })
            })
            .collect::<Vec<_>>(),
    })
}

/// `GET /api/acl/principals` — the roles, teams and members an overwrite may
/// target, so the grant editor offers a picker instead of a raw-id text field.
///
/// Read-only and never an error: both remote lookups degrade to empty (see
/// [`crate::sidecar::control_plane::resolve_teams`]), so an unbound personal node
/// and an unreachable control plane render the same editor rather than a failure.
pub(in crate::server) async fn acl_principals(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
) -> Result<Json<serde_json::Value>, axum::response::Response> {
    // This is the ORG DIRECTORY: every team, and every member's name and email.
    // It exists to populate a grant picker, so it is gated on the same permission
    // as editing grants — without this any holder of the node token could
    // enumerate the whole roster, which is a disclosure independent of whether
    // they could change anything.
    //
    // ORG-WIDE (`enforce_permission`, not `_on`): the directory spans the org and
    // names no resource whose overwrites could carve an exception for it. On an
    // unbound node that helper returns Ok, so a personal node still renders — and
    // there its teams/members lists are empty anyway.
    let caller = verified_caller_from_headers(&headers).await;
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::ROLES_MANAGE,
    )
    .await
    .is_err()
    {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: roles.manage".to_owned(),
        ));
    }

    let teams = crate::sidecar::control_plane::resolve_teams(&state.client).await;
    let custom_roles = crate::sidecar::control_plane::resolve_roles(&state.client).await;
    let members = crate::sidecar::control_plane::resolve_notify_targets(&state.client, None)
        .await
        .unwrap_or_default();
    Ok(Json(acl_principals_payload(teams, members, custom_roles)))
}
