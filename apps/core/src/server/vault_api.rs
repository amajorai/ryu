//! User-managed secret vault routes.
//!
//! This module is the management projection for the encrypted vault_secrets
//! table in crate::plugin_secrets. Values are write-only over HTTP: the API
//! returns scope/binding metadata and timestamps, never plaintext, ciphertext,
//! or a masked value derived from the secret. Runtime reads happen only from
//! the server-side MCP dispatch path.

use axum::{extract::Path, extract::State, response::IntoResponse, Extension, Json};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{json_error, no_store_response, ServerState};
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::plugin_secrets::{
    is_valid_scope_id, is_valid_vault_secret_name, SecretBinding, SecretScope, VaultSecretInfo,
    MAX_VAULT_SECRET_VALUE_LEN,
};
use crate::sidecar::control_plane::{NodeScope, RegisteredNode};

/// Maximum JSON body accepted by the vault mutation routes.
pub const MAX_REQUEST_BODY_BYTES: usize = 128 * 1024;

const LOCAL_SCOPE_ID: &str = "local";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PutSecretBody {
    scope: SecretScope,
    #[serde(default)]
    scope_id: Option<String>,
    #[serde(default)]
    binding: Option<SecretBinding>,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSecretBody {
    scope: SecretScope,
    #[serde(default)]
    scope_id: Option<String>,
    #[serde(default)]
    binding: Option<SecretBinding>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SecretWire {
    name: String,
    scope: SecretScope,
    scope_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    binding: Option<SecretBinding>,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeWire {
    id: String,
    scope: String,
    org_id: Option<String>,
    team_id: Option<String>,
    owner_user_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CallerWire {
    user_id: String,
    org_id: Option<String>,
    role: String,
    team_ids: Vec<String>,
}

struct SecretTarget {
    scope: SecretScope,
    scope_id: String,
    binding: Option<SecretBinding>,
}

fn store() -> Result<&'static crate::plugin_secrets::PluginSecretStore, axum::response::Response> {
    crate::plugin_secrets::global().ok_or_else(|| {
        json_error(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "vault_unavailable: encrypted secret store is not available".to_owned(),
        )
    })
}

fn current_node() -> Option<RegisteredNode> {
    crate::sidecar::control_plane::registered_node()
}

fn current_node_id(node: Option<&RegisteredNode>) -> String {
    node.map(|registered| registered.node_id.clone())
        .unwrap_or_else(crate::server::agent_sync::local_node_id)
}

fn node_scope_label(node: Option<&RegisteredNode>) -> &'static str {
    match node.map(|registered| registered.scope) {
        Some(NodeScope::Org) => "org",
        Some(NodeScope::Team) => "team",
        Some(NodeScope::Personal) => "personal",
        None => "local",
    }
}

fn node_wire(node: Option<&RegisteredNode>, node_id: String) -> NodeWire {
    NodeWire {
        id: node_id,
        scope: node_scope_label(node).to_owned(),
        org_id: node.map(|registered| registered.org.id.clone()),
        team_id: node.and_then(|registered| registered.team_id.clone()),
        owner_user_id: node.and_then(|registered| registered.owner_user_id.clone()),
    }
}

fn caller_wire(caller: Option<&VerifiedCaller>) -> Option<CallerWire> {
    caller.map(|caller| CallerWire {
        user_id: caller.user_id.clone(),
        org_id: caller.org_id.clone(),
        role: role_label(caller.role).to_owned(),
        team_ids: caller.teams.iter().map(|team| team.id.clone()).collect(),
    })
}

fn role_label(role: OrgRole) -> &'static str {
    match role {
        OrgRole::Owner => "owner",
        OrgRole::Admin => "admin",
        OrgRole::Member => "member",
        OrgRole::Viewer => "viewer",
    }
}

/// Whether a verified caller is inside the registered node's organization,
/// team, or personal-owner boundary. A missing caller is accepted only for the
/// node-bearer management path; shared scopes still require a caller below.
fn caller_can_use_node(node: Option<&RegisteredNode>, caller: Option<&VerifiedCaller>) -> bool {
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

fn record_visible(
    record: &VaultSecretInfo,
    node: Option<&RegisteredNode>,
    caller: Option<&VerifiedCaller>,
    node_id: &str,
) -> bool {
    match record.scope {
        SecretScope::Node => record.scope_id == node_id && caller_can_use_node(node, caller),
        SecretScope::User => {
            if node.is_none() && record.scope_id == LOCAL_SCOPE_ID && caller.is_none() {
                return true;
            }
            caller.is_some_and(|caller| {
                record.scope_id == caller.user_id && caller_can_use_node(node, Some(caller))
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
                    .any(|team| team.id == record.scope_id && team.org_id == node.org.id)
        }
        SecretScope::Org => {
            let (Some(node), Some(caller)) = (node, caller) else {
                return false;
            };
            caller_can_use_node(Some(node), Some(caller))
                && caller.org_id.as_deref() == Some(record.scope_id.as_str())
                && caller.org_id.as_deref() == Some(node.org.id.as_str())
        }
    }
}

fn normalized_optional_id(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn invalid_request(message: &str) -> axum::response::Response {
    json_error(
        axum::http::StatusCode::BAD_REQUEST,
        format!("vault_invalid_request: {message}"),
    )
}

fn forbidden() -> axum::response::Response {
    json_error(
        axum::http::StatusCode::FORBIDDEN,
        "vault_secret_denied: the caller cannot use this vault scope".to_owned(),
    )
}

fn resolve_target(
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

async fn can_manage_shared(
    state: &ServerState,
    node: Option<&RegisteredNode>,
    caller: Option<&VerifiedCaller>,
) -> bool {
    let Some(node) = node else {
        return false;
    };
    let Some(caller) = caller else {
        return true;
    };
    if !caller_can_use_node(Some(node), Some(caller)) {
        return false;
    }
    if node.scope == NodeScope::Personal
        && node.owner_user_id.as_deref() == Some(caller.user_id.as_str())
    {
        return true;
    }
    super::enforce_permission(
        state,
        &Some(caller.clone()),
        crate::identity_verify::permissions::GATEWAY_CONFIGURE,
    )
    .await
    .is_ok()
}

async fn can_write_target(
    state: &ServerState,
    target: &SecretTarget,
    node: Option<&RegisteredNode>,
    caller: Option<&VerifiedCaller>,
) -> bool {
    if target.scope == SecretScope::User {
        return true;
    }
    if target.scope == SecretScope::Node && node.is_none() {
        return true;
    }
    can_manage_shared(state, node, caller).await
}

fn to_wire(info: VaultSecretInfo) -> SecretWire {
    let updated_at = DateTime::<Utc>::from_timestamp_millis(info.updated_at)
        .unwrap_or_else(Utc::now)
        .to_rfc3339();
    SecretWire {
        name: info.name,
        scope: info.scope,
        scope_id: info.scope_id,
        binding: info.binding,
        updated_at,
    }
}

/// GET /api/vault/secrets lists the caller's readable vault metadata.
#[utoipa::path(
    get,
    path = "/api/vault/secrets",
    tag = "Vault",
    summary = "List readable vault secret metadata (never values)",
    responses((status = 200, description = "Metadata only", body = serde_json::Value))
)]
pub async fn list_secrets(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
) -> axum::response::Response {
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    let node = current_node();
    let node_id = current_node_id(node.as_ref());
    let secrets = match store.list_vault_secrets().await {
        Ok(secrets) => secrets
            .into_iter()
            .filter(|secret| record_visible(secret, node.as_ref(), caller.as_ref(), &node_id))
            .map(to_wire)
            .collect::<Vec<_>>(),
        Err(error) => {
            return json_error(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                error.to_string(),
            )
        }
    };
    no_store_response(
        Json(json!({
            "secrets": secrets,
            "node": node_wire(node.as_ref(), node_id),
            "caller": caller_wire(caller.as_ref()),
            "canManageShared": can_manage_shared(&state, node.as_ref(), caller.as_ref()).await,
        }))
        .into_response(),
    )
}

/// PUT /api/vault/secrets/{name} writes or clears one scoped value.
#[utoipa::path(
    put,
    path = "/api/vault/secrets/{name}",
    tag = "Vault",
    summary = "Set a write-only scoped vault secret",
    params(("name" = String, Path, description = "Env-compatible secret name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Stored metadata only", body = serde_json::Value))
)]
pub async fn put_secret(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(name): Path<String>,
    Json(body): Json<PutSecretBody>,
) -> axum::response::Response {
    if !is_valid_vault_secret_name(&name) {
        return invalid_request("name must be an environment-compatible identifier");
    }
    if body.value.len() > MAX_VAULT_SECRET_VALUE_LEN {
        return invalid_request("value exceeds the maximum allowed size");
    }
    let node = current_node();
    let target = match resolve_target(
        body.scope,
        body.scope_id,
        body.binding,
        node.as_ref(),
        caller.as_ref(),
    ) {
        Ok(target) => target,
        Err(message) => return invalid_request(message),
    };
    if !can_write_target(&state, &target, node.as_ref(), caller.as_ref()).await {
        return forbidden();
    }
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store
        .set_vault_secret(
            target.scope,
            &target.scope_id,
            target.binding.as_ref(),
            &name,
            &body.value,
        )
        .await
    {
        Ok(Some(info)) => {
            no_store_response(Json(json!({ "ok": true, "secret": to_wire(info) })).into_response())
        }
        Ok(None) => no_store_response(
            Json(json!({
                "ok": true,
                "deleted": true,
                "name": name,
                "scope": target.scope,
                "scopeId": target.scope_id,
                "binding": target.binding,
            }))
            .into_response(),
        ),
        Err(error) => json_error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            error.to_string(),
        ),
    }
}

/// DELETE /api/vault/secrets/{name} clears one scoped value. Idempotent.
#[utoipa::path(
    delete,
    path = "/api/vault/secrets/{name}",
    tag = "Vault",
    summary = "Clear a scoped vault secret",
    params(("name" = String, Path, description = "Env-compatible secret name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Cleared", body = serde_json::Value))
)]
pub async fn delete_secret(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(name): Path<String>,
    Json(body): Json<DeleteSecretBody>,
) -> axum::response::Response {
    if !is_valid_vault_secret_name(&name) {
        return invalid_request("name must be an environment-compatible identifier");
    }
    let node = current_node();
    let target = match resolve_target(
        body.scope,
        body.scope_id,
        body.binding,
        node.as_ref(),
        caller.as_ref(),
    ) {
        Ok(target) => target,
        Err(message) => return invalid_request(message),
    };
    if !can_write_target(&state, &target, node.as_ref(), caller.as_ref()).await {
        return forbidden();
    }
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    if let Err(error) = store
        .delete_vault_secret(
            target.scope,
            &target.scope_id,
            target.binding.as_ref(),
            &name,
        )
        .await
    {
        return json_error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            error.to_string(),
        );
    }
    no_store_response(
        Json(json!({
            "ok": true,
            "deleted": true,
            "name": name,
            "scope": target.scope,
            "scopeId": target.scope_id,
            "binding": target.binding,
        }))
        .into_response(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity_verify::TeamMembership;

    fn node(
        scope: NodeScope,
        team_id: Option<&str>,
        owner_user_id: Option<&str>,
    ) -> RegisteredNode {
        RegisteredNode {
            org: crate::sidecar::control_plane::RegisteredOrg {
                id: "org-1".to_owned(),
                name: "Acme".to_owned(),
                slug: None,
            },
            node_id: "node-1".to_owned(),
            scope,
            team_id: team_id.map(str::to_owned),
            owner_user_id: owner_user_id.map(str::to_owned),
        }
    }

    fn caller(user_id: &str, role: OrgRole, team_ids: &[&str]) -> VerifiedCaller {
        VerifiedCaller {
            user_id: user_id.to_owned(),
            email: None,
            org_id: Some("org-1".to_owned()),
            role,
            teams: team_ids
                .iter()
                .map(|id| TeamMembership {
                    id: (*id).to_owned(),
                    org_id: "org-1".to_owned(),
                    role: "member".to_owned(),
                })
                .collect(),
        }
    }

    fn info(scope: SecretScope, scope_id: &str) -> VaultSecretInfo {
        VaultSecretInfo {
            name: "GITHUB_TOKEN".to_owned(),
            scope,
            scope_id: scope_id.to_owned(),
            binding: None,
            updated_at: 1,
        }
    }

    #[test]
    fn visibility_matches_the_four_scope_boundaries() {
        let org_node = node(NodeScope::Org, None, None);
        let member = caller("user-1", OrgRole::Member, &["team-1"]);
        assert!(record_visible(
            &info(SecretScope::Node, "node-1"),
            Some(&org_node),
            Some(&member),
            "node-1"
        ));
        assert!(record_visible(
            &info(SecretScope::User, "user-1"),
            Some(&org_node),
            Some(&member),
            "node-1"
        ));
        assert!(record_visible(
            &info(SecretScope::Team, "team-1"),
            Some(&org_node),
            Some(&member),
            "node-1"
        ));
        assert!(record_visible(
            &info(SecretScope::Org, "org-1"),
            Some(&org_node),
            Some(&member),
            "node-1"
        ));
        assert!(!record_visible(
            &info(SecretScope::User, "user-2"),
            Some(&org_node),
            Some(&member),
            "node-1"
        ));
    }

    #[test]
    fn team_and_org_metadata_are_not_visible_without_verified_identity() {
        let org_node = node(NodeScope::Org, None, None);
        assert!(!record_visible(
            &info(SecretScope::Team, "team-1"),
            Some(&org_node),
            None,
            "node-1"
        ));
        assert!(!record_visible(
            &info(SecretScope::Org, "org-1"),
            Some(&org_node),
            None,
            "node-1"
        ));
        assert!(record_visible(
            &info(SecretScope::Node, "node-1"),
            Some(&org_node),
            None,
            "node-1"
        ));
    }

    #[test]
    fn target_scope_ids_cannot_be_repointed() {
        let org_node = node(NodeScope::Org, None, None);
        let member = caller("user-1", OrgRole::Member, &["team-1"]);
        assert!(resolve_target(
            SecretScope::User,
            Some("user-2".to_owned()),
            None,
            Some(&org_node),
            Some(&member)
        )
        .is_err());
        assert!(resolve_target(
            SecretScope::Org,
            Some("org-2".to_owned()),
            None,
            Some(&org_node),
            Some(&member)
        )
        .is_err());
        assert!(resolve_target(
            SecretScope::Team,
            Some("team-2".to_owned()),
            None,
            Some(&org_node),
            Some(&member)
        )
        .is_err());
    }
}
