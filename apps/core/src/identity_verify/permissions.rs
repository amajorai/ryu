//! Fine-grained permission vocabulary for the org/team RBAC epic.
//!
//! This is the Rust half of a contract shared byte-for-byte with the TypeScript
//! control plane (`packages/api` / `packages/db`): the canonical permission
//! string keys and the built-in role -> permission-set mapping MUST match the TS
//! side exactly, or an effective-permission check on one layer disagrees with the
//! other. Keep the string literals and the four built-in sets in lock-step.
//!
//! Effective permissions for a member are the built-in set of their Better Auth
//! role (mapped via [`OrgRole::from_ba_str`]) UNION every permission granted by a
//! custom role assigned to them in the org. Core resolves the custom-role slice
//! by asking the control plane ([`crate::sidecar::control_plane::resolve_permissions`]);
//! the built-in tier here is the fail-closed fallback when that lookup fails.

use std::collections::HashSet;

use super::OrgRole;

// ── Canonical permission keys (MUST match the TS PERMISSIONS array) ───────────

pub const GATEWAY_VIEW: &str = "gateway.view";
pub const GATEWAY_CONFIGURE: &str = "gateway.configure";
pub const WORKFLOW_VIEW: &str = "workflow.view";
pub const WORKFLOW_RUN: &str = "workflow.run";
pub const WORKFLOW_EDIT: &str = "workflow.edit";
pub const WORKFLOW_DELETE: &str = "workflow.delete";
pub const SPACE_READ: &str = "space.read";
pub const SPACE_WRITE: &str = "space.write";
pub const SPACE_DELETE: &str = "space.delete";
pub const AGENT_VIEW: &str = "agent.view";
pub const AGENT_RUN: &str = "agent.run";
pub const AGENT_EDIT: &str = "agent.edit";
pub const TOOL_EXEC: &str = "tool.exec";
pub const MEMBERS_MANAGE: &str = "members.manage";
pub const ROLES_MANAGE: &str = "roles.manage";
pub const BILLING_MANAGE: &str = "billing.manage";
pub const AUDIT_VIEW: &str = "audit.view";

/// Every permission key, in the same order as the shared contract's `PERMISSIONS`
/// array. `owner` is derived from this full set; `admin` from this set minus
/// `billing.manage`.
pub const PERMISSIONS: &[&str] = &[
    GATEWAY_VIEW,
    GATEWAY_CONFIGURE,
    WORKFLOW_VIEW,
    WORKFLOW_RUN,
    WORKFLOW_EDIT,
    WORKFLOW_DELETE,
    SPACE_READ,
    SPACE_WRITE,
    SPACE_DELETE,
    AGENT_VIEW,
    AGENT_RUN,
    AGENT_EDIT,
    TOOL_EXEC,
    MEMBERS_MANAGE,
    ROLES_MANAGE,
    BILLING_MANAGE,
    AUDIT_VIEW,
];

/// The `member` built-in set (a working teammate: run and author, but no
/// governance/config). MUST match the TS `member` set exactly.
const MEMBER_PERMISSIONS: &[&str] = &[
    GATEWAY_VIEW,
    WORKFLOW_VIEW,
    WORKFLOW_RUN,
    SPACE_READ,
    SPACE_WRITE,
    AGENT_VIEW,
    AGENT_RUN,
    TOOL_EXEC,
];

/// The `viewer` built-in set (read-only). MUST match the TS `viewer` set exactly.
const VIEWER_PERMISSIONS: &[&str] = &[GATEWAY_VIEW, WORKFLOW_VIEW, SPACE_READ, AGENT_VIEW];

/// The built-in permission set for an [`OrgRole`]. Fail-closed: an unknown BA role
/// already maps to [`OrgRole::Viewer`] (see [`OrgRole::from_ba_str`]), so the
/// least-privileged set is the floor.
///
///   - `owner`  : ALL permissions.
///   - `admin`  : ALL EXCEPT `billing.manage`.
///   - `member` : the working-teammate set above.
///   - `viewer` : the read-only set above.
pub fn permissions_for_role(role: OrgRole) -> HashSet<&'static str> {
    match role {
        OrgRole::Owner => PERMISSIONS.iter().copied().collect(),
        OrgRole::Admin => PERMISSIONS
            .iter()
            .copied()
            .filter(|p| *p != BILLING_MANAGE)
            .collect(),
        OrgRole::Member => MEMBER_PERMISSIONS.iter().copied().collect(),
        OrgRole::Viewer => VIEWER_PERMISSIONS.iter().copied().collect(),
    }
}

/// Whether a role's built-in tier grants `perm`. This is the role-tier half of an
/// effective-permission check; the custom-role half is resolved separately from
/// the control plane and unioned in by the enforcement helper.
pub fn can(role: OrgRole, perm: &str) -> bool {
    permissions_for_role(role).contains(perm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_has_every_permission() {
        let owner = permissions_for_role(OrgRole::Owner);
        assert_eq!(owner.len(), PERMISSIONS.len());
        for perm in PERMISSIONS {
            assert!(owner.contains(perm), "owner missing {perm}");
        }
    }

    #[test]
    fn admin_is_all_except_billing() {
        let admin = permissions_for_role(OrgRole::Admin);
        assert_eq!(admin.len(), PERMISSIONS.len() - 1);
        assert!(!admin.contains(BILLING_MANAGE));
        // Every other permission is present.
        for perm in PERMISSIONS.iter().filter(|p| **p != BILLING_MANAGE) {
            assert!(admin.contains(perm), "admin missing {perm}");
        }
    }

    #[test]
    fn member_set_is_exactly_the_eight_keys() {
        let member = permissions_for_role(OrgRole::Member);
        let expected: HashSet<&str> = [
            "gateway.view",
            "workflow.view",
            "workflow.run",
            "space.read",
            "space.write",
            "agent.view",
            "agent.run",
            "tool.exec",
        ]
        .into_iter()
        .collect();
        assert_eq!(member, expected);
    }

    #[test]
    fn viewer_set_is_exactly_the_four_keys() {
        let viewer = permissions_for_role(OrgRole::Viewer);
        let expected: HashSet<&str> = ["gateway.view", "workflow.view", "space.read", "agent.view"]
            .into_iter()
            .collect();
        assert_eq!(viewer, expected);
    }

    #[test]
    fn can_reflects_the_sets() {
        assert!(can(OrgRole::Owner, BILLING_MANAGE));
        assert!(!can(OrgRole::Admin, BILLING_MANAGE));
        assert!(can(OrgRole::Member, AGENT_RUN));
        assert!(!can(OrgRole::Member, WORKFLOW_EDIT));
        assert!(can(OrgRole::Viewer, AGENT_VIEW));
        assert!(!can(OrgRole::Viewer, AGENT_RUN));
    }
}
