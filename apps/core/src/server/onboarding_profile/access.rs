//! Who may run gateway onboarding, whether a profile was already built, and
//! the caller-bound eligibility and read scope a build starts with.

use super::*;

pub(super) fn error(status: StatusCode, message: impl Into<String>) -> axum::response::Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

pub(super) fn resolve_gateway_onboarding_access(
    managed_node: bool,
    registered_node: Option<&crate::sidecar::control_plane::RegisteredNode>,
    caller: Option<&crate::identity_verify::VerifiedCaller>,
) -> GatewayOnboardingAccess {
    if managed_node {
        return GatewayOnboardingAccess {
            allowed: false,
            managed_node: true,
            reason: "managed_node",
            scope: registered_node.map(|node| node.scope),
        };
    }

    let Some(node) = registered_node else {
        // An unbound Core is the single trusted operator's local/VPS node. There
        // is no shared ACL to accidentally expose to another member.
        return GatewayOnboardingAccess {
            allowed: true,
            managed_node: false,
            reason: "local_node",
            scope: None,
        };
    };

    match node.scope {
        crate::sidecar::control_plane::NodeScope::Personal => {
            let owner_matches = node
                .owner_user_id
                .as_deref()
                .is_some_and(|owner| caller.is_some_and(|current| current.user_id == owner));
            GatewayOnboardingAccess {
                allowed: owner_matches,
                managed_node: false,
                reason: if owner_matches {
                    "personal_node"
                } else {
                    "not_node_owner"
                },
                scope: Some(node.scope),
            }
        }
        // Org and team scopes are ACL-bearing nodes. Only a same-org
        // administrator may configure the node's first-run context; ordinary
        // members can still use the finished node without seeing this setup
        // writer.
        crate::sidecar::control_plane::NodeScope::Org
        | crate::sidecar::control_plane::NodeScope::Team => {
            let in_scope = caller.is_some_and(|current| {
                crate::server::onboarding_state::caller_in_node_scope(node, current)
            });
            let allowed = in_scope
                && caller.is_some_and(|current| {
                    current
                        .role
                        .satisfies(crate::identity_verify::OrgRole::Admin)
                });
            GatewayOnboardingAccess {
                allowed,
                managed_node: false,
                reason: if allowed {
                    "shared_node_admin"
                } else {
                    "shared_acl_node"
                },
                scope: Some(node.scope),
            }
        }
    }
}

pub fn gateway_onboarding_access(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> GatewayOnboardingAccess {
    resolve_gateway_onboarding_access(
        crate::sidecar::control_plane::is_managed_node(),
        crate::sidecar::control_plane::registered_node().as_ref(),
        caller.as_ref(),
    )
}

pub(super) fn gateway_onboarding_message(reason: &str) -> &'static str {
    match reason {
        "managed_node" => "gateway onboarding is managed by Ryu Cloud",
        "shared_acl_node" => "gateway onboarding is reserved for this node's administrator",
        "shared_node_admin" => "gateway onboarding is reserved for this node's administrator",
        "not_node_owner" => "only the owner of this personal node can run gateway onboarding",
        _ => "gateway onboarding is not available on this node",
    }
}

pub(super) async fn profile_was_built(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> bool {
    let filter = crate::server::memory::MemoryFilter {
        limit: Some(500),
        ..Default::default()
    };
    let visibility = if crate::sidecar::control_plane::registered_node().is_some()
        || crate::sidecar::control_plane::is_managed_node()
    {
        crate::server::memory::MemoryVisibility::for_caller_in_org(
            caller.as_ref().map(|current| current.user_id.as_str()),
            caller
                .as_ref()
                .and_then(|current| current.org_id.as_deref()),
            true,
        )
    } else {
        crate::server::memory::MemoryVisibility::unrestricted()
    };
    let consent_user_id = caller
        .as_ref()
        .map(|current| current.user_id.as_str())
        .unwrap_or(crate::server::memory::LOCAL_USER);
    let include_sensitive = state
        .memory
        .include_sensitive_topics(consent_user_id)
        .await
        .unwrap_or(false);
    state
        .memory
        .list_visible_with_sensitive(&filter, visibility, include_sensitive)
        .await
        .map(|entries| {
            entries
                .iter()
                .any(|entry| entry.tags.iter().any(|tag| tag == "profile-bootstrap"))
        })
        .unwrap_or(false)
}

pub(super) async fn eligible(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    share_user_org: bool,
) -> Result<(String, String, ProfileOnboardingSnapshot), axum::response::Response> {
    let access = gateway_onboarding_access(caller);
    if !access.allowed {
        return Err(error(
            StatusCode::FORBIDDEN,
            gateway_onboarding_message(access.reason),
        ));
    }
    let Some(caller) = caller.as_ref() else {
        return Err(error(
            StatusCode::FORBIDDEN,
            "profile bootstrap requires a signed-in organization member",
        ));
    };
    let Some(org_id) = caller.org_id.as_deref() else {
        return Err(error(
            StatusCode::FORBIDDEN,
            "profile bootstrap requires an organization-scoped session",
        ));
    };
    if !caller
        .role
        .satisfies(crate::identity_verify::OrgRole::Admin)
    {
        return Err(error(
            StatusCode::FORBIDDEN,
            "only organization owners and admins can build the initial profile",
        ));
    }
    if !crate::entitlement::managed_inference_entitled() || !crate::entitlement::is_active() {
        return Err(error(
            StatusCode::FORBIDDEN,
            "profile bootstrap is available on paid plans only",
        ));
    }
    let onboarding = crate::server::onboarding_state::read_state(&state.preferences)
        .await
        .map_err(|read_error| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("node onboarding state is unavailable: {read_error}"),
            )
        })?;
    let onboarding_snapshot = profile_onboarding_snapshot(&onboarding);
    if onboarding_snapshot.setup_kind == NodeSetupKind::Team
        && !onboarding_snapshot.company_knowledge_enabled
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "shared company knowledge is disabled for this node",
        ));
    }
    if onboarding_snapshot.setup_kind == NodeSetupKind::Team && !share_user_org {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "explicit user and organization sharing consent is required",
        ));
    }
    Ok((
        caller.user_id.clone(),
        org_id.to_owned(),
        onboarding_snapshot,
    ))
}

/// Resolve the selected Composio accounts against the authenticated caller
/// before a profile job is admitted. The returned toolkit/id pairs are then
/// carried into the tool bridge, so the model cannot silently fall back to a
/// different connected account or an unselected account on the same entity.
pub(super) async fn profile_connection_scope(
    state: &ServerState,
    user_id: &str,
    source_ids: &[String],
) -> Result<Option<Vec<crate::sidecar::adapters::ComposioConnectionBinding>>, Response> {
    let Some(source_ids) = (!source_ids.is_empty()).then_some(source_ids) else {
        return Ok(Some(Vec::new()));
    };
    let listed = crate::composio_connect::list_connections(&state.client, "", Some(user_id))
        .await
        .map_err(|cause| {
            error(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("selected Composio sources are unavailable: {cause}"),
            )
        })?;
    let available = crate::agent_access::active_composio_bindings(&listed)
        .into_iter()
        .map(|binding| (binding.id.clone(), binding))
        .collect::<HashMap<_, _>>();
    let mut selected = Vec::with_capacity(source_ids.len());
    for source_id in source_ids {
        let Some(binding) = available.get(source_id) else {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "one or more selected Composio sources are unavailable",
            ));
        };
        selected.push(binding.clone());
    }
    Ok(Some(selected))
}

/// Keep imported chats inside the same resource-read boundary as the regular
/// chat route. The profile builder calls `route_chat_stream` directly, so it
/// cannot rely on `chat_stream`'s HTTP-only reference filter; validate and
/// normalize the ids before they enter the job or prompt.
pub(super) fn profile_conversation_is_readable(
    caller: &crate::identity_verify::VerifiedCaller,
    meta: &crate::identity_verify::ResourceTenancy,
    node_bound: bool,
) -> bool {
    let legacy_local_row = !node_bound && meta.owner_user_id.is_none() && meta.org_id.is_none();
    let readable_by_caller = matches!(
        crate::identity_verify::can_access(
            caller,
            meta.owner_user_id.as_deref(),
            meta.org_id.as_deref(),
            &meta.visibility,
            meta.team_id.as_deref(),
            &meta.collaborators,
        ),
        crate::identity_verify::Access::Read | crate::identity_verify::Access::Write
    );
    legacy_local_row || readable_by_caller
}

pub(super) async fn profile_imported_conversations(
    state: &ServerState,
    caller: &crate::identity_verify::VerifiedCaller,
    conversation_ids: &[String],
) -> Result<Vec<String>, Response> {
    let node_bound = crate::sidecar::control_plane::registered_org().is_some()
        || crate::sidecar::control_plane::is_managed_node();
    let mut seen = std::collections::HashSet::new();
    let mut readable = Vec::with_capacity(conversation_ids.len());
    for conversation_id in conversation_ids {
        if !seen.insert(conversation_id.clone()) {
            continue;
        }
        let meta = state
            .conversations
            .get_access_meta(conversation_id)
            .await
            .map_err(|cause| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!("selected conversations are unavailable: {cause}"),
                )
            })?;
        let Some(meta) = meta else {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "one or more selected conversations are unavailable",
            ));
        };
        if !profile_conversation_is_readable(caller, &meta, node_bound) {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "one or more selected conversations are unavailable",
            ));
        }
        readable.push(conversation_id.clone());
    }
    Ok(readable)
}
