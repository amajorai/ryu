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
//! by asking the control plane ([`crate::sidecar::control_plane::resolve_permission_context`]);
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
pub const AGENT_DELETE: &str = "agent.delete";
pub const CHANNEL_MANAGE: &str = "channel.manage";
pub const CHANNEL_DELETE: &str = "channel.delete";
pub const TOOL_EXEC: &str = "tool.exec";
pub const NOTIFICATIONS_VIEW: &str = "notifications.view";
pub const NOTIFICATIONS_MANAGE: &str = "notifications.manage";
pub const MAIL_READ: &str = "mail.read";
pub const MAIL_MANAGE: &str = "mail.manage";
pub const MESSAGING_READ: &str = "messaging.read";
pub const MESSAGING_MANAGE: &str = "messaging.manage";
pub const TEAMS_MANAGE: &str = "teams.manage";
pub const PROJECTS_MANAGE: &str = "projects.manage";
pub const REGISTRY_MANAGE: &str = "registry.manage";
pub const NODES_VIEW: &str = "nodes.view";
pub const NODES_MANAGE: &str = "nodes.manage";
pub const MEMBERS_MANAGE: &str = "members.manage";
pub const ROLES_MANAGE: &str = "roles.manage";
pub const FEATURES_MANAGE: &str = "features.manage";
pub const BILLING_MANAGE: &str = "billing.manage";
pub const AUDIT_VIEW: &str = "audit.view";
/// Organization sign-in and access policy (IP allowlist, required two-factor,
/// session lifetime) and SSO/SCIM identity configuration.
pub const ACCESS_MANAGE: &str = "access.manage";
/// Organization data controls: retention horizons and SIEM audit export.
pub const DATA_MANAGE: &str = "data.manage";
pub const APP_INSTALL: &str = "app.install";
pub const APP_UPDATE: &str = "app.update";
pub const APP_ENABLE: &str = "app.enable";
pub const APP_DISABLE: &str = "app.disable";
pub const APP_UNINSTALL: &str = "app.uninstall";
pub const MARKETPLACE_VIEW: &str = "marketplace.view";
pub const MARKETPLACE_PUBLISH: &str = "marketplace.publish";
pub const MARKETPLACE_TRANSFER: &str = "marketplace.transfer";
/// Read the node's approval inbox and its live event feeds. Approval rows carry
/// the proposed action's title, summary, and arguments.
pub const APPROVALS_VIEW: &str = "approvals.view";
/// Approve or reject a pending approval and change the node's approval mode.
/// A governance action, so only `owner` and `admin` hold it by default.
pub const APPROVALS_DECIDE: &str = "approvals.decide";

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
    AGENT_DELETE,
    CHANNEL_MANAGE,
    CHANNEL_DELETE,
    TOOL_EXEC,
    NOTIFICATIONS_VIEW,
    NOTIFICATIONS_MANAGE,
    MAIL_READ,
    MAIL_MANAGE,
    MESSAGING_READ,
    MESSAGING_MANAGE,
    TEAMS_MANAGE,
    PROJECTS_MANAGE,
    REGISTRY_MANAGE,
    NODES_VIEW,
    NODES_MANAGE,
    MEMBERS_MANAGE,
    ROLES_MANAGE,
    FEATURES_MANAGE,
    BILLING_MANAGE,
    AUDIT_VIEW,
    ACCESS_MANAGE,
    DATA_MANAGE,
    APP_INSTALL,
    APP_UPDATE,
    APP_ENABLE,
    APP_DISABLE,
    APP_UNINSTALL,
    MARKETPLACE_VIEW,
    MARKETPLACE_PUBLISH,
    MARKETPLACE_TRANSFER,
    APPROVALS_VIEW,
    APPROVALS_DECIDE,
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
    NOTIFICATIONS_VIEW,
    MAIL_READ,
    MESSAGING_READ,
    PROJECTS_MANAGE,
    NODES_VIEW,
    MARKETPLACE_VIEW,
];

/// The `viewer` built-in set (read-only). MUST match the TS `viewer` set exactly.
const VIEWER_PERMISSIONS: &[&str] = &[
    GATEWAY_VIEW,
    WORKFLOW_VIEW,
    SPACE_READ,
    AGENT_VIEW,
    NOTIFICATIONS_VIEW,
    MAIL_READ,
    MESSAGING_READ,
    NODES_VIEW,
    MARKETPLACE_VIEW,
];

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

/// The additive grant of the built-in `billing` Better Auth member role. The
/// role is not a rung on the owner/admin/member/viewer ladder:
/// [`OrgRole::from_ba_str`] floors `"billing"` at `Viewer`, and this set is
/// layered on top. MUST match the TS `BILLING_ROLE_PERMISSIONS`.
pub const BILLING_ROLE_KEY: &str = "billing";
pub const BILLING_ROLE_PERMISSIONS: &[&str] = &[BILLING_MANAGE];

/// True when a Better Auth role string carries the additive `billing` role.
pub fn ba_role_has_billing(ba_role: &str) -> bool {
    ba_role
        .split(',')
        .any(|part| part.trim().eq_ignore_ascii_case(BILLING_ROLE_KEY))
}

/// The built-in permission set for a raw Better Auth role string: the ladder
/// tier of [`OrgRole::from_ba_str`] UNION the additive `billing` grant when
/// present. Mirrors the TS `resolveEffectivePermissions` built-in tier.
pub fn permissions_for_ba_role(ba_role: &str) -> HashSet<&'static str> {
    let mut set = permissions_for_role(OrgRole::from_ba_str(ba_role));
    if ba_role_has_billing(ba_role) {
        set.extend(BILLING_ROLE_PERMISSIONS.iter().copied());
    }
    set
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
    fn member_set_includes_marketplace_read_access() {
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
            "notifications.view",
            "mail.read",
            "messaging.read",
            "projects.manage",
            "nodes.view",
            "marketplace.view",
        ]
        .into_iter()
        .collect();
        assert_eq!(member, expected);
    }

    #[test]
    fn viewer_set_includes_marketplace_read_access() {
        let viewer = permissions_for_role(OrgRole::Viewer);
        let expected: HashSet<&str> = [
            "gateway.view",
            "workflow.view",
            "space.read",
            "agent.view",
            "notifications.view",
            "mail.read",
            "messaging.read",
            "nodes.view",
            "marketplace.view",
        ]
        .into_iter()
        .collect();
        assert_eq!(viewer, expected);
    }

    #[test]
    fn billing_role_is_viewer_plus_billing_manage() {
        let billing = permissions_for_ba_role("billing");
        let mut expected = permissions_for_role(OrgRole::Viewer);
        expected.insert(BILLING_MANAGE);
        assert_eq!(billing, expected);
        assert!(!billing.contains(MEMBERS_MANAGE));
        assert!(!billing.contains(GATEWAY_CONFIGURE));
        // Combined with a ladder role, billing only adds billing.manage.
        let admin_billing = permissions_for_ba_role("admin, Billing");
        assert_eq!(admin_billing.len(), PERMISSIONS.len());
        assert_eq!(
            permissions_for_ba_role("member"),
            permissions_for_role(OrgRole::Member)
        );
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

    #[test]
    fn deleting_agents_is_admin_only_by_default() {
        assert!(can(OrgRole::Owner, AGENT_DELETE));
        assert!(can(OrgRole::Admin, AGENT_DELETE));
        assert!(!can(OrgRole::Member, AGENT_DELETE));
        assert!(!can(OrgRole::Viewer, AGENT_DELETE));
    }

    #[test]
    fn lifecycle_permissions_are_admin_only_by_default() {
        for permission in [
            APP_INSTALL,
            APP_UPDATE,
            APP_ENABLE,
            APP_DISABLE,
            APP_UNINSTALL,
        ] {
            assert!(
                can(OrgRole::Owner, permission),
                "owner missing {permission}"
            );
            assert!(
                can(OrgRole::Admin, permission),
                "admin missing {permission}"
            );
            assert!(!can(OrgRole::Member, permission), "member has {permission}");
            assert!(!can(OrgRole::Viewer, permission), "viewer has {permission}");
        }
    }

    #[test]
    fn access_and_data_controls_are_admin_only_by_default() {
        for permission in [ACCESS_MANAGE, DATA_MANAGE] {
            assert!(
                can(OrgRole::Owner, permission),
                "owner missing {permission}"
            );
            assert!(
                can(OrgRole::Admin, permission),
                "admin missing {permission}"
            );
            assert!(!can(OrgRole::Member, permission), "member has {permission}");
            assert!(!can(OrgRole::Viewer, permission), "viewer has {permission}");
            assert!(
                !permissions_for_ba_role("billing").contains(permission),
                "billing has {permission}"
            );
        }
    }

    /// Owners and admins review and decide approvals on an organization node
    /// through their built-in role, without a custom-role grant.
    #[test]
    fn approvals_are_admin_only_by_default() {
        for permission in [APPROVALS_VIEW, APPROVALS_DECIDE] {
            assert!(
                can(OrgRole::Owner, permission),
                "owner missing {permission}"
            );
            assert!(
                can(OrgRole::Admin, permission),
                "admin missing {permission}"
            );
            assert!(!can(OrgRole::Member, permission), "member has {permission}");
            assert!(!can(OrgRole::Viewer, permission), "viewer has {permission}");
            assert!(
                !permissions_for_ba_role("billing").contains(permission),
                "billing has {permission}"
            );
        }
    }

    /// The quoted keys of a TypeScript `export const PERMISSIONS = [ ... ] as const;`.
    fn ts_permission_keys(source: &str) -> Vec<String> {
        let start = source
            .find("export const PERMISSIONS = [")
            .expect("PERMISSIONS array");
        let body = &source[start..];
        let end = body.find("] as const;").expect("PERMISSIONS terminator");
        body[..end]
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with('"'))
            .map(|line| line.trim_end_matches(',').trim_matches('"').to_owned())
            .collect()
    }

    /// The vocabulary is a byte-for-byte contract with the control plane and the
    /// Desktop roles editor. A key added on one side only would be dropped by the
    /// control plane's effective-permission filter or be ungrantable in the UI.
    ///
    /// The control-plane model is read at run time, not with `include_str!`:
    /// `packages/db` is not part of the public mirror (`tools/mirror-public.sh`
    /// refuses a tree with an unresolved include), so it is compared only where
    /// the package exists.
    #[test]
    fn vocabulary_matches_the_typescript_mirrors() {
        let rust: Vec<String> = PERMISSIONS.iter().map(|p| (*p).to_owned()).collect();
        assert_eq!(
            ts_permission_keys(include_str!("../../../desktop/src/lib/api/org.ts")),
            rust,
            "apps/desktop lib/api/org.ts drifted"
        );
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        if !repo.join("packages/db").is_dir() {
            return;
        }
        let model =
            std::fs::read_to_string(repo.join("packages/db/src/models/control-plane.model.ts"))
                .expect("packages/db control-plane.model.ts");
        assert_eq!(
            ts_permission_keys(&model),
            rust,
            "packages/db control-plane.model.ts drifted"
        );
    }
}
