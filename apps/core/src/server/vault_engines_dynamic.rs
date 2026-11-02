//! Dynamic secret roles and the leases issued under them.
//!
//! Split out of [`super`]; the handlers are re-exported there so their
//! public paths (and OpenAPI `__path_*` items) stay stable.
//!
//! test-exempt: handlers moved verbatim out of `vault_engines_api.rs`; covered by
//! vault_public_routes_auth_test.rs, vault_engine_roles_tests.rs, and the vault engine tests.

use super::*;

// ── Dynamic secrets and leases ────────────────────────────────────────────

/// GET /api/vault/dynamic/roles.
#[utoipa::path(get, path = "/api/vault/dynamic/roles", tag = "Vault",
    summary = "List dynamic-secret roles (provider credentials redacted)",
    responses((status = 200, description = "Roles", body = serde_json::Value)))]
pub async fn dynamic_roles(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    visible_listing(
        &who,
        who.store().dynamic_list_roles().await,
        "roles",
        |role| format!("sys/dynamic/{}", role.name),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynamicRoleBody {
    provider: ProviderConfig,
    #[serde(default)]
    default_ttl_secs: Option<i64>,
    #[serde(default)]
    max_ttl_secs: Option<i64>,
}

/// PUT /api/vault/dynamic/roles/{name}.
#[utoipa::path(put, path = "/api/vault/dynamic/roles/{name}", tag = "Vault",
    summary = "Create or replace a dynamic-secret role (admin)",
    params(("name" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved (redacted)", body = serde_json::Value)))]
pub async fn dynamic_put_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<DynamicRoleBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/dynamic/{name}"), Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .dynamic_put_role(
                &name,
                &body.provider,
                body.default_ttl_secs,
                body.max_ttl_secs,
                &who.actor(),
            )
            .await,
        "role",
    )
}

/// DELETE /api/vault/dynamic/roles/{name}.
#[utoipa::path(delete, path = "/api/vault/dynamic/roles/{name}", tag = "Vault",
    summary = "Delete a dynamic-secret role with no live leases (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn dynamic_delete_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/dynamic/{name}"), Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .dynamic_delete_role(&name, &who.actor())
            .await
            .map(|()| true),
        "deleted",
    )
}

/// POST /api/vault/dynamic/roles/{name}/revoke-all.
#[utoipa::path(post, path = "/api/vault/dynamic/roles/{name}/revoke-all", tag = "Vault",
    summary = "Revoke every live lease of a role (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Revoked count", body = serde_json::Value)))]
pub async fn dynamic_revoke_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require(&format!("sys/dynamic/{name}"), Capability::Admin) {
        return response;
    }
    ok_or(
        who.store().dynamic_revoke_role(&name, &who.actor()).await,
        "revoked",
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtlBody {
    #[serde(default)]
    pub(super) ttl_secs: Option<i64>,
}

pub(super) async fn dynamic_issue_op(who: &Who, role: &str, ttl_secs: Option<i64>) -> Response {
    if let Err(response) = who.require(&format!("sys/dynamic/{role}"), Capability::Use) {
        return response;
    }
    let issued_to = who.issued_to();
    ok_or(
        who.store()
            .dynamic_issue(role, ttl_secs, Some(&issued_to), &who.actor())
            .await,
        "credential",
    )
}

/// POST /api/vault/dynamic/issue/{role} mints a credential under a lease.
#[utoipa::path(post, path = "/api/vault/dynamic/issue/{role}", tag = "Vault",
    summary = "Issue a dynamic credential (use); the value is returned once",
    params(("role" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Credential and lease", body = serde_json::Value)))]
pub async fn dynamic_issue(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(role): Path<String>,
    body: Option<Json<TtlBody>>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    dynamic_issue_op(&who, &role, body.and_then(|Json(body)| body.ttl_secs)).await
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseQuery {
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    include_revoked: Option<bool>,
}

/// GET /api/vault/leases.
#[utoipa::path(get, path = "/api/vault/leases", tag = "Vault",
    summary = "List dynamic-secret leases (admin)",
    params(
        ("role" = Option<String>, Query, description = "Role filter"),
        ("includeRevoked" = Option<bool>, Query, description = "Include revoked leases"),
    ),
    responses((status = 200, description = "Leases", body = serde_json::Value)))]
pub async fn leases(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<LeaseQuery>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/leases", Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .lease_list(
                query.role.as_deref(),
                query.include_revoked.unwrap_or(false),
            )
            .await,
        "leases",
    )
}

pub(super) async fn lease_op(who: &Who, id: &str, op: &str, ttl_secs: Option<i64>) -> Response {
    let lease = match who.store().lease_get(id).await {
        Ok(lease) => lease,
        Err(error) => return vault_error(error),
    };
    // The holder may renew or revoke its own lease; otherwise admin on the role.
    let own = lease.issued_to.as_deref() == Some(who.issued_to().as_str());
    if !own {
        if let Err(response) =
            who.require(&format!("sys/dynamic/{}", lease.role), Capability::Admin)
        {
            return response;
        }
    }
    let actor = who.actor();
    match op {
        "renew" => ok_or(
            who.store().dynamic_renew(id, ttl_secs, &actor).await,
            "lease",
        ),
        "revoke" => ok_or(who.store().dynamic_revoke(id, &actor).await, "lease"),
        _ => json_error(
            StatusCode::NOT_FOUND,
            "vault_not_found: unknown lease operation".to_owned(),
        ),
    }
}

/// POST /api/vault/leases/{id}/{op}: `renew` or `revoke`.
#[utoipa::path(post, path = "/api/vault/leases/{id}/{op}", tag = "Vault",
    summary = "Renew or revoke a lease (holder or admin)",
    params(
        ("id" = String, Path, description = "Lease id"),
        ("op" = String, Path, description = "`renew` or `revoke`"),
    ),
    request_body = serde_json::Value,
    responses((status = 200, description = "Lease", body = serde_json::Value)))]
pub async fn lease_operation(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path((id, op)): Path<(String, String)>,
    body: Option<Json<TtlBody>>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    lease_op(&who, &id, &op, body.and_then(|Json(body)| body.ttl_secs)).await
}
