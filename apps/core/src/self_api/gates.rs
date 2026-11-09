//! Method/kind helpers, the org-bound role gate, and the tenancy gate.

use super::*;

// ── Method / kind helpers (for the approval policy + dispatch gate) ────────────

/// Whether a tool id belongs to the CoreApi plane.
pub fn is_core_api(tool_id: &str) -> bool {
    tool_id.starts_with(ID_PREFIX) || tool_id.starts_with(LEGACY_ID_PREFIX)
}

/// The lowercase HTTP method encoded in a CoreApi tool id (`ryu_api.get_…` →
/// `get`). `None` for non-CoreApi ids. HTTP verbs contain no `_`, so the method
/// is exactly the segment between the prefix and the first `_`.
pub fn method_of(tool_id: &str) -> Option<&str> {
    let rest = tool_id
        .strip_prefix(ID_PREFIX)
        .or_else(|| tool_id.strip_prefix(LEGACY_ID_PREFIX))?;
    rest.split('_').next()
}

/// Gateway config sections an agent may not write through the self-API. Each
/// carries credentials or decides where traffic and secrets go, what is
/// filtered, or what is recorded: `egress` proxy credentials can name any
/// environment variable (a provider key sent to a proxy the agent chose),
/// `auth` mints API keys, the `firewall` sections switch off DLP and
/// prompt-injection checks, `audit` controls the record of what the agent
/// did, and `computer_use` allows locked-session use and the hardware security
/// key. Like provider keys, they stay in Settings.
pub(super) const GATEWAY_CONFIG_SETTINGS_ONLY: &[&str] = &[
    "auth",
    "audit",
    "bind",
    "channels",
    "composio",
    "computer_use",
    "control_plane",
    "egress",
    "firewall",
    "firewall_agent_overlays",
    "firewall_org_overlays",
    "providers",
];

/// The first settings-only section a Gateway config write would touch, if any.
pub(super) fn gateway_config_settings_only_section(
    path: &str,
    method: &str,
    args: &Value,
) -> Option<&'static str> {
    if path != "/api/gateway/config" || method.eq_ignore_ascii_case("get") {
        return None;
    }
    let Some(Value::Object(patch)) = args.get("body") else {
        return None;
    };
    GATEWAY_CONFIG_SETTINGS_ONLY
        .iter()
        .copied()
        .find(|section| patch.contains_key(*section))
}

/// Whether this is a **mutating** CoreApi tool (any non-GET verb). The approval
/// policy gates these in every approval mode, including an explicit `off`. See
/// [`crate::approvals::policy::should_require_approval_local`].
pub fn is_mutating(tool_id: &str) -> bool {
    is_core_api(tool_id) && !matches!(method_of(tool_id), Some("get"))
}

// ── Role gate (org-bound nodes) ───────────────────────────────────────────────

/// The organization permission a person needs before an agent may call this
/// route for them on an org-bound node. `None` means the route has no declared
/// permission, so agents cannot call it on a shared node at all.
///
/// The table exists because the loopback request passes Core's route policy as
/// the node owner. Handlers that check `enforce_permission` would refuse a
/// person without the permission anyway, but several Gateway handlers rely on
/// the route policy alone (audit, batches, evals, routing policy). Checking
/// here, before dispatch, gives every reachable route the same role check.
pub fn required_permission(path_template: &str, method: &str) -> Option<&'static str> {
    use crate::identity_verify::permissions as perm;
    let read = method.eq_ignore_ascii_case("get");
    let gateway =
        path_template.starts_with("/api/gateway/") || path_template.starts_with("/api/routing/");
    if path_template.starts_with("/api/gateway/audit") || path_template == "/api/usage/me" {
        return read.then_some(perm::AUDIT_VIEW);
    }
    if gateway {
        return Some(if read {
            perm::GATEWAY_VIEW
        } else {
            perm::GATEWAY_CONFIGURE
        });
    }
    None
}

/// Who an agent is acting for on an org-bound node, and what Core knows about
/// the conversation it was asked in.
pub struct ActingUser<'a> {
    pub user_id: &'a str,
    pub org_id: Option<&'a str>,
    /// Only the asker can answer the in-chat permission card in a private chat
    /// with no collaborators. In a shared chat another person could prompt the
    /// agent to act with the owner's role, so shared chats are refused.
    pub private_conversation: bool,
}

/// Decide whether an agent may call `route` for `user` on an org-bound node.
/// `node_owner` is the owner of a Personal-scope node, and `permissions` is the
/// person's effective permission set from the control plane (empty on any
/// lookup failure, which refuses).
pub fn acting_user_refusal(
    route: &CoreApiRoute,
    user: &ActingUser<'_>,
    node_org: &str,
    node_owner: Option<&str>,
    permissions: &HashSet<String>,
) -> Option<String> {
    let Some(permission) = required_permission(&route.path_template, &route.method) else {
        return Some(format!(
            "{} {} is not available to agents on a shared node. Use Settings instead.",
            route.method, route.path_template
        ));
    };
    if !user.private_conversation {
        return Some(
            "Agents only change Ryu settings from a private chat on a shared node. Start a new \
             chat that is not shared and ask again."
                .to_owned(),
        );
    }
    if user.org_id != Some(node_org) {
        return Some("You are not a member of the organization this node belongs to.".to_owned());
    }
    if node_owner == Some(user.user_id) || permissions.contains(permission) {
        return None;
    }
    Some(format!(
        "Your role does not include `{permission}`, which {} {} needs. Ask an organization \
         admin to make this change or to grant you that permission.",
        route.method, route.path_template
    ))
}

// ── Tenancy gate ──────────────────────────────────────────────────────────────

/// The tenancy invariant, as a pure decision so it can be unit-tested.
///
/// `unrestricted` is `true` iff the calling principal is
/// [`crate::sidecar::mcp::ToolPrincipal::Unrestricted`] — i.e. the node is
/// **unbound/personal**. On any org-bound node the loopback request would carry
/// the node's own `RYU_TOKEN` (full power, not the agent's principal scope), so
/// CoreApi tools must refuse. Returns the refusal message when they must, else
/// `None`.
pub fn refuse_reason_if_tenant_bound(unrestricted: bool) -> Option<String> {
    if unrestricted {
        None
    } else {
        Some(
            "Core self-API tools are disabled on shared (org-bound) nodes: a loopback call would \
             run with the node's own credentials rather than your scoped identity. Use them on a \
             personal node."
                .to_string(),
        )
    }
}
