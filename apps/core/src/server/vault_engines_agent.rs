//! Machine-authenticated agent routes (`x-ryu-vault-token`).
//!
//! Split out of [`super`]; the handlers are re-exported there so their
//! public paths (and OpenAPI `__path_*` items) stay stable.
//!
//! test-exempt: handlers moved verbatim out of `vault_engines_api.rs`; covered by
//! vault_public_routes_auth_test.rs, vault_engine_roles_tests.rs, and the vault engine tests.

use super::*;

// ── Agent routes (x-ryu-vault-token) ──────────────────────────────────────

/// GET /api/vault/agent/self describes the presented token.
#[utoipa::path(get, path = "/api/vault/agent/self", tag = "Vault",
    summary = "Describe the presented machine token",
    responses((status = 200, description = "Token principal", body = serde_json::Value)))]
pub async fn agent_self(headers: HeaderMap) -> Response {
    match who!(machine(&headers).await) {
        Who::Machine { principal, .. } => respond(json!({ "token": principal })),
        Who::Human(_) => unreachable!("machine() only returns machines"),
    }
}

/// POST /api/vault/agent/self/revoke revokes the presented token.
#[utoipa::path(post, path = "/api/vault/agent/self/revoke", tag = "Vault",
    summary = "Revoke the presented machine token",
    responses((status = 200, description = "Revoked", body = serde_json::Value)))]
pub async fn agent_revoke_self(headers: HeaderMap) -> Response {
    let who = who!(machine(&headers).await);
    let Who::Machine {
        store, principal, ..
    } = &who
    else {
        unreachable!("machine() only returns machines")
    };
    ok_or(
        store
            .token_revoke(&principal.accessor, &principal.actor())
            .await
            .map(|()| true),
        "revoked",
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExportBody {
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    names: Option<Vec<String>>,
    #[serde(default)]
    k8s_name: Option<String>,
    #[serde(default)]
    k8s_namespace: Option<String>,
}

/// POST /api/vault/agent/export renders the node values the token may read.
#[utoipa::path(post, path = "/api/vault/agent/export", tag = "Vault",
    summary = "Export node-scoped values the machine token may read",
    request_body = serde_json::Value,
    responses((status = 200, description = "Rendered content", body = serde_json::Value)))]
pub async fn agent_export(headers: HeaderMap, body: Option<Json<AgentExportBody>>) -> Response {
    let who = who!(machine(&headers).await);
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let format = match body.format.as_deref().map(dotenv::Format::parse) {
        None => dotenv::Format::Dotenv,
        Some(Some(format)) => format,
        Some(None) => return invalid_request("unknown format"),
    };
    let environment = body
        .environment
        .unwrap_or_else(crate::vault::active_environment);
    let path = body.path.unwrap_or_else(|| ROOT_PATH.to_owned());
    let context = SecretResolutionContext {
        environment: Some(environment.clone()),
        ..SecretResolutionContext::node_only(local_node_id(), Vec::new())
    };
    let values = match who
        .store()
        .effective_local_values(&context, &environment, &path, |coords| {
            coords.scope == SecretScope::Node
                && who
                    .sys_caps(&coords.policy_key())
                    .contains(&Capability::Read)
                && !who.read_gated(&coords.policy_key())
        })
        .await
    {
        Ok(values) => values,
        Err(error) => return vault_error(error),
    };
    let mut rendered: std::collections::BTreeMap<String, String> = values
        .into_iter()
        .map(|(name, (_, value))| (name, value))
        .collect();
    if let Some(names) = &body.names {
        rendered.retain(|name, _| names.contains(name));
    }
    if !who
        .store()
        .audit(
            &crate::vault::audit::AuditEntry::new(&who.actor(), "vault.export", "ok").details(
                json!({
                    "environment": environment, "path": path, "count": rendered.len(),
                    "names": rendered.keys().collect::<Vec<_>>(),
                }),
            ),
        )
        .await
    {
        return vault_error(crate::vault::VaultError::AuditUnavailable.into());
    }
    let k8s = dotenv::K8sOptions {
        name: body.k8s_name,
        namespace: body.k8s_namespace,
    };
    match dotenv::serialize(&rendered, format, &k8s) {
        Ok(content) => respond(json!({
            "format": format, "contentType": format.content_type(), "count": rendered.len(),
            "environment": environment, "path": path, "content": content,
        })),
        Err(error) => vault_error(error),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSecretQuery {
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    path: Option<String>,
    /// A specific version; the current one when absent.
    #[serde(default)]
    version: Option<i64>,
}

/// GET /api/vault/agent/secrets/{name} reveals one node-scoped value.
#[utoipa::path(get, path = "/api/vault/agent/secrets/{name}", tag = "Vault",
    summary = "Read one node-scoped value with a machine token (read)",
    params(
        ("name" = String, Path, description = "Secret name"),
        ("environment" = Option<String>, Query, description = "Environment (default: node's active)"),
        ("path" = Option<String>, Query, description = "Folder (default /)"),
    ),
    responses((status = 200, description = "Value", body = serde_json::Value)))]
pub async fn agent_secret(
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<AgentSecretQuery>,
) -> Response {
    let who = who!(machine(&headers).await);
    let environment = query
        .environment
        .unwrap_or_else(crate::vault::active_environment);
    let coords = match node_coords(
        &local_node_id(),
        &environment,
        query.path.as_deref().unwrap_or(ROOT_PATH),
        &name,
    ) {
        Ok(coords) => coords,
        Err(response) => return response,
    };
    if let Err(response) = who.require(&coords.policy_key(), Capability::Read) {
        return response;
    }
    if who.read_gated(&coords.policy_key()) {
        return json_error(
            axum::http::StatusCode::FORBIDDEN,
            format!(
                "vault_control_group_required: `{}` needs control-group approval, which machine tokens cannot request",
                coords.policy_key()
            ),
        );
    }
    ok_or(
        who.store()
            .reveal(&coords, query.version, &who.actor())
            .await,
        "value",
    )
}

/// POST /api/vault/agent/dynamic/{role}.
#[utoipa::path(post, path = "/api/vault/agent/dynamic/{role}", tag = "Vault",
    summary = "Issue a dynamic credential with a machine token (use)",
    params(("role" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Credential and lease", body = serde_json::Value)))]
pub async fn agent_dynamic_issue(
    headers: HeaderMap,
    Path(role): Path<String>,
    body: Option<Json<TtlBody>>,
) -> Response {
    let who = who!(machine(&headers).await);
    dynamic_issue_op(&who, &role, body.and_then(|Json(body)| body.ttl_secs)).await
}

/// POST /api/vault/agent/leases/{id}/{op}.
#[utoipa::path(post, path = "/api/vault/agent/leases/{id}/{op}", tag = "Vault",
    summary = "Renew or revoke the machine's own lease",
    params(
        ("id" = String, Path, description = "Lease id"),
        ("op" = String, Path, description = "`renew` or `revoke`"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Lease", body = serde_json::Value)))]
pub async fn agent_lease_operation(
    headers: HeaderMap,
    Path((id, op)): Path<(String, String)>,
    body: Option<Json<TtlBody>>,
) -> Response {
    let who = who!(machine(&headers).await);
    lease_op(&who, &id, &op, body.and_then(|Json(body)| body.ttl_secs)).await
}

/// POST /api/vault/agent/transit/{op}/{name}.
#[utoipa::path(post, path = "/api/vault/agent/transit/{op}/{name}", tag = "Vault",
    summary = "Run a transit operation with a machine token (use)",
    params(
        ("op" = String, Path, description = "encrypt, decrypt, rewrap, datakey, sign, verify, hmac"),
        ("name" = String, Path, description = "Key name"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn agent_transit(
    headers: HeaderMap,
    Path((op, name)): Path<(String, String)>,
    body: Option<Json<TransitOpBody>>,
) -> Response {
    let who = who!(machine(&headers).await);
    transit_op(
        &who,
        &op,
        &name,
        body.map(|Json(body)| body).unwrap_or_default(),
    )
    .await
}

/// POST /api/vault/agent/pki/{op}/{role}.
#[utoipa::path(post, path = "/api/vault/agent/pki/{op}/{role}", tag = "Vault",
    summary = "Issue a certificate or sign a CSR with a machine token (use)",
    params(
        ("op" = String, Path, description = "`issue` or `sign`"),
        ("role" = String, Path, description = "Role name"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Certificate", body = serde_json::Value)))]
pub async fn agent_pki(
    headers: HeaderMap,
    Path((op, role)): Path<(String, String)>,
    Json(body): Json<IssueBody>,
) -> Response {
    let who = who!(machine(&headers).await);
    pki_op(&who, &op, &role, body).await
}

/// POST /api/vault/agent/ssh/sign/{role}.
#[utoipa::path(post, path = "/api/vault/agent/ssh/sign/{role}", tag = "Vault",
    summary = "Sign an SSH public key with a machine token (use)",
    params(("role" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "OpenSSH certificate", body = serde_json::Value)))]
pub async fn agent_ssh_sign(
    headers: HeaderMap,
    Path(role): Path<String>,
    Json(body): Json<SshSignBody>,
) -> Response {
    let who = who!(machine(&headers).await);
    ssh_sign_op(&who, &role, body).await
}
