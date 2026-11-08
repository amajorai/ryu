//! Scope boundaries and write-target resolution (the pre-policy rules).

use super::*;

/// Whether a verified caller is inside the registered node's organization,
/// team, or personal-owner boundary. A missing caller is accepted only for the
/// node-bearer management path; shared scopes still require a caller below.
///
/// An org Admin is admitted on any team node of their organization here, which
/// governs this node's own values. Team and Organization values are decided by
/// the control plane, which (like `/gateway/vault/resolve`) acts through a team
/// node only for a live member of that team, so the node's operators can never
/// replay an admin's JWT through it. For an admin who is not on the team it
/// answers `node_proxy_required`, which the proxy passes through as a caller
/// refusal (`is_caller_refusal`).
pub(super) fn caller_can_use_node(
    node: Option<&RegisteredNode>,
    caller: Option<&VerifiedCaller>,
) -> bool {
    let Some(node) = node else {
        return true;
    };
    let Some(caller) = caller else {
        return true;
    };
    match node.scope {
        NodeScope::Org => caller.org_id.as_deref() == Some(node.org.id.as_str()),
        NodeScope::Team => {
            caller.org_id.as_deref() == Some(node.org.id.as_str())
                && (caller.role.satisfies(OrgRole::Admin)
                    || node
                        .team_id
                        .as_deref()
                        .is_some_and(|team_id| caller.teams.iter().any(|team| team.id == team_id)))
        }
        NodeScope::Personal => node.owner_user_id.as_deref() == Some(caller.user_id.as_str()),
    }
}

pub(super) fn scope_visible(
    scope: SecretScope,
    scope_id: &str,
    node: Option<&RegisteredNode>,
    caller: Option<&VerifiedCaller>,
    node_id: &str,
) -> bool {
    match scope {
        // Project values live only in the control plane; none is local.
        SecretScope::Project => false,
        SecretScope::Node => scope_id == node_id && caller_can_use_node(node, caller),
        SecretScope::User => {
            if node.is_none() && scope_id == LOCAL_SCOPE_ID && caller.is_none() {
                return true;
            }
            caller.is_some_and(|caller| {
                scope_id == caller.user_id && caller_can_use_node(node, Some(caller))
            })
        }
        SecretScope::Team => {
            let (Some(node), Some(caller)) = (node, caller) else {
                return false;
            };
            if !caller_can_use_node(Some(node), Some(caller))
                || caller.org_id.as_deref() != Some(node.org.id.as_str())
            {
                return false;
            }
            caller.role.satisfies(OrgRole::Admin)
                || caller
                    .teams
                    .iter()
                    .any(|team| team.id == scope_id && team.org_id == node.org.id)
        }
        SecretScope::Org => {
            let (Some(node), Some(caller)) = (node, caller) else {
                return false;
            };
            caller_can_use_node(Some(node), Some(caller))
                && caller.org_id.as_deref() == Some(scope_id)
                && caller.org_id.as_deref() == Some(node.org.id.as_str())
        }
    }
}

#[cfg(test)]
pub(super) fn record_visible(
    record: &VaultSecretInfo,
    node: Option<&RegisteredNode>,
    caller: Option<&VerifiedCaller>,
    node_id: &str,
) -> bool {
    scope_visible(record.scope, &record.scope_id, node, caller, node_id)
}

pub(super) fn normalized_optional_id(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

pub(super) struct SecretTarget {
    pub(crate) scope: SecretScope,
    pub(crate) scope_id: String,
    pub(crate) binding: Option<SecretBinding>,
}

pub(super) fn resolve_target(
    scope: SecretScope,
    requested_scope_id: Option<String>,
    binding: Option<SecretBinding>,
    node: Option<&RegisteredNode>,
    caller: Option<&VerifiedCaller>,
) -> Result<SecretTarget, &'static str> {
    if let Some(binding) = binding.as_ref() {
        if binding.validate().is_err() {
            return Err("the MCP binding id is invalid");
        }
    }
    let requested_scope_id = normalized_optional_id(requested_scope_id);
    let node_id = current_node_id(node);
    let scope_id = match scope {
        SecretScope::Project => {
            return Err("project values are managed in the organization console");
        }
        SecretScope::Node => {
            if requested_scope_id
                .as_deref()
                .is_some_and(|value| value != node_id)
            {
                return Err("node scope_id must name the current node");
            }
            node_id
        }
        SecretScope::User => {
            if !caller_can_use_node(node, caller) {
                return Err("the caller is outside this node's boundary");
            }
            let expected = match (node, caller) {
                (Some(_), None) => return Err("user scope requires a verified user identity"),
                (_, Some(caller)) => caller.user_id.clone(),
                (None, None) => LOCAL_SCOPE_ID.to_owned(),
            };
            if requested_scope_id
                .as_deref()
                .is_some_and(|value| value != expected)
            {
                return Err("user scope_id must name the verified caller");
            }
            expected
        }
        SecretScope::Org => {
            let Some(node) = node else {
                return Err("organization scope is unavailable on an unbound node");
            };
            if caller.is_some_and(|caller| {
                caller.org_id.as_deref() != Some(node.org.id.as_str())
                    || !caller_can_use_node(Some(node), Some(caller))
            }) {
                return Err("organization membership is required");
            }
            if requested_scope_id
                .as_deref()
                .is_some_and(|value| value != node.org.id)
            {
                return Err("organization scope_id must name this node's organization");
            }
            node.org.id.clone()
        }
        SecretScope::Team => {
            let Some(node) = node else {
                return Err("team scope is unavailable on an unbound node");
            };
            let Some(scope_id) = requested_scope_id else {
                return Err("team scope requires scope_id");
            };
            if !is_valid_scope_id(&scope_id) {
                return Err("team scope_id is invalid");
            }
            if node.scope == NodeScope::Team && node.team_id.as_deref() != Some(scope_id.as_str()) {
                return Err("a team-bound node can only use its own team scope");
            }
            match caller {
                Some(caller)
                    if caller.org_id.as_deref() == Some(node.org.id.as_str())
                        && caller_can_use_node(Some(node), Some(caller))
                        && (caller.role.satisfies(OrgRole::Admin)
                            || caller
                                .teams
                                .iter()
                                .any(|team| team.id == scope_id && team.org_id == node.org.id)) => {
                }
                None if node.scope == NodeScope::Team
                    && node.team_id.as_deref() == Some(scope_id.as_str()) => {}
                _ => return Err("team membership is required"),
            }
            scope_id
        }
    };

    Ok(SecretTarget {
        scope,
        scope_id,
        binding,
    })
}

pub(super) async fn can_manage_shared(
    state: &ServerState,
    node: Option<&RegisteredNode>,
    caller: Option<&VerifiedCaller>,
) -> bool {
    let Some(node) = node else {
        return false;
    };
    let Some(caller) = caller else {
        // Shared team/org/node writes are governance operations. A node bearer
        // proves machine admission, not which human may mutate shared secrets.
        return false;
    };
    if !caller_can_use_node(Some(node), Some(caller)) {
        return false;
    }
    if node.scope == NodeScope::Personal
        && node.owner_user_id.as_deref() == Some(caller.user_id.as_str())
    {
        return true;
    }
    crate::server::enforce_permission(
        state,
        &Some(caller.clone()),
        crate::identity_verify::permissions::GATEWAY_CONFIGURE,
    )
    .await
    .is_ok()
}
