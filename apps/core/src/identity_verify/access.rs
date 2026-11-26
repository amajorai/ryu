//! Resource access resolution (`can_access`).

use super::*;

// ── Access control ───────────────────────────────────────────────────────────

/// Resolve a caller's access to a resource. Fail-closed: any case not explicitly
/// granted returns [`Access::None`].
///
/// Rules:
///   - The resource owner always gets `Write`.
///   - A same-org direct collaborator gets the stored `Read` or `Write` grant.
///   - `visibility == "org"`: a member of the SAME org gets `Write` (`Read` for
///     a `Viewer`); anyone else gets `None`.
///   - `visibility == "team"`: the caller must have a verified membership in
///     `team_id`, and that team must be narrowed to the node's org. The team's
///     embedded role determines whether the grant is read-only or writable.
///   - `visibility == "private"`: the owner and direct collaborators handled above;
///     everyone else gets `None`.
///   - Any unknown visibility string → `None`.
pub fn can_access(
    caller: &VerifiedCaller,
    owner_user_id: Option<&str>,
    org_id: Option<&str>,
    visibility: &str,
    team_id: Option<&str>,
    collaborators: &[ResourceCollaborator],
) -> Access {
    if let Some(owner) = owner_user_id {
        if owner == caller.user_id {
            return Access::Write;
        }
    }

    let same_scope = org_id.is_none() || caller.org_id.as_deref() == org_id;
    if same_scope {
        if let Some(collaborator) = collaborators
            .iter()
            .find(|collaborator| collaborator.user_id == caller.user_id)
        {
            return collaborator.access;
        }
    }

    match visibility {
        "private" => Access::None,
        "org" => org_access(caller, org_id),
        "team" => team_access(caller, org_id, team_id),
        _ => Access::None,
    }
}

/// Shared org/team membership gate: same-org member → `Write`, same-org viewer →
/// `Read`, otherwise `None`.
pub(super) fn org_access(caller: &VerifiedCaller, org_id: Option<&str>) -> Access {
    match (caller.org_id.as_deref(), org_id) {
        (Some(caller_org), Some(resource_org)) if caller_org == resource_org => {
            if caller.role.satisfies(OrgRole::Member) {
                Access::Write
            } else {
                Access::Read
            }
        }
        _ => Access::None,
    }
}

/// Resolve a team-scoped grant. A team id alone is not sufficient: the resource
/// org and the caller's narrowed team membership must both agree, preventing a
/// team id from another organization from widening access.
pub(super) fn team_access(
    caller: &VerifiedCaller,
    org_id: Option<&str>,
    team_id: Option<&str>,
) -> Access {
    let (Some(caller_org), Some(resource_org), Some(team_id)) =
        (caller.org_id.as_deref(), org_id, team_id)
    else {
        return Access::None;
    };
    if caller_org != resource_org {
        return Access::None;
    }

    caller
        .teams
        .iter()
        .find(|team| team.id == team_id && team.org_id == resource_org)
        .map(|team| {
            if OrgRole::from_ba_str(&team.role).satisfies(OrgRole::Member) {
                Access::Write
            } else {
                Access::Read
            }
        })
        .unwrap_or(Access::None)
}
