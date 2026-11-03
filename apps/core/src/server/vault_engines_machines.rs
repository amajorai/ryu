//! Machine identity management and the public AppRole/JWT login routes.
//!
//! Split out of [`super`]; the handlers are re-exported there so their
//! public paths (and OpenAPI `__path_*` items) stay stable.
//!
//! test-exempt: handlers moved verbatim out of `vault_engines_api.rs`; covered by
//! vault_public_routes_auth_test.rs, vault_engine_roles_tests.rs, and the vault engine tests.

use super::*;
use crate::vault::dynamic::target_guard::RoleWriter;

// ── Machine identities ────────────────────────────────────────────────────

/// GET /api/vault/machines.
#[utoipa::path(get, path = "/api/vault/machines", tag = "Vault",
    summary = "List machine identities (admin)",
    responses((status = 200, description = "Identities", body = serde_json::Value)))]
pub async fn machines(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    ok_or(who.store().machine_list().await, "machines")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineBody {
    name: String,
    auth: AuthMethod,
    #[serde(default)]
    policies: Vec<String>,
    #[serde(default)]
    token_ttl_secs: Option<i64>,
}

/// POST /api/vault/machines creates an AppRole or JWT identity.
#[utoipa::path(post, path = "/api/vault/machines", tag = "Vault",
    summary = "Create a machine identity (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Identity", body = serde_json::Value)))]
pub async fn machine_create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<MachineBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    // A delegated admin's identity may only reach public JWKS and Kubernetes
    // API hosts (screened at every login); a configuration manager's keeps
    // the host's network.
    let manager = matches!(&who, Who::Human(ctx) if ctx.manager);
    ok_or(
        who.store()
            .machine_create_as(
                &body.name,
                body.auth,
                body.policies,
                body.token_ttl_secs,
                RoleWriter::from_manager(manager),
                &who.actor(),
            )
            .await,
        "machine",
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachinePatch {
    #[serde(default)]
    policies: Option<Vec<String>>,
    #[serde(default)]
    token_ttl_secs: Option<i64>,
    #[serde(default)]
    disabled: Option<bool>,
}

/// PATCH /api/vault/machines/{id}.
#[utoipa::path(patch, path = "/api/vault/machines/{id}", tag = "Vault",
    summary = "Update a machine identity; disabling revokes its tokens (admin)",
    params(("id" = String, Path, description = "Identity id or name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Identity", body = serde_json::Value)))]
pub async fn machine_update(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<MachinePatch>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .machine_update(
                &id,
                body.policies,
                body.token_ttl_secs,
                body.disabled,
                &who.actor(),
            )
            .await,
        "machine",
    )
}

/// DELETE /api/vault/machines/{id}.
#[utoipa::path(delete, path = "/api/vault/machines/{id}", tag = "Vault",
    summary = "Delete a machine identity and its tokens (admin)",
    params(("id" = String, Path, description = "Identity id or name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn machine_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .machine_delete(&id, &who.actor())
            .await
            .map(|()| true),
        "deleted",
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretIdBody {
    #[serde(default)]
    ttl_secs: Option<i64>,
    #[serde(default)]
    uses: Option<i64>,
    /// Client CIDRs allowed to log in with the secret id.
    #[serde(default)]
    cidr_list: Vec<String>,
    /// CIDRs bound to tokens issued with the secret id.
    #[serde(default)]
    token_bound_cidrs: Vec<String>,
}

/// GET or POST /api/vault/machines/{id}/secret-ids.
#[utoipa::path(post, path = "/api/vault/machines/{id}/secret-ids", tag = "Vault",
    summary = "Issue an AppRole secret id (admin); the value is returned once",
    params(("id" = String, Path, description = "Identity id or name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Secret id", body = serde_json::Value)))]
pub async fn machine_issue_secret_id(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Option<Json<SecretIdBody>>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    let body = body.map(|Json(body)| body).unwrap_or_default();
    match who
        .store()
        .machine_issue_secret_id_with(
            &id,
            crate::vault::tokens::SecretIdOptions {
                ttl_secs: body.ttl_secs,
                uses: body.uses,
                cidr_list: body.cidr_list,
                token_bound_cidrs: body.token_bound_cidrs,
            },
            &who.actor(),
        )
        .await
    {
        Ok((secret_id, info)) => respond(json!({ "secretId": secret_id, "info": info })),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/machines/{id}/secret-ids.
#[utoipa::path(get, path = "/api/vault/machines/{id}/secret-ids", tag = "Vault",
    summary = "List AppRole secret ids (metadata only, admin)",
    params(("id" = String, Path, description = "Identity id or name")),
    responses((status = 200, description = "Secret id metadata", body = serde_json::Value)))]
pub async fn machine_secret_ids(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    ok_or(who.store().machine_list_secret_ids(&id).await, "secretIds")
}

/// DELETE /api/vault/secret-ids/{accessor}.
#[utoipa::path(delete, path = "/api/vault/secret-ids/{accessor}", tag = "Vault",
    summary = "Destroy an AppRole secret id (admin)",
    params(("accessor" = String, Path, description = "Secret id accessor")),
    responses((status = 200, description = "Destroyed", body = serde_json::Value)))]
pub async fn machine_revoke_secret_id(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(accessor): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .machine_revoke_secret_id(&accessor, &who.actor())
            .await
            .map(|()| true),
        "revoked",
    )
}

/// POST /api/vault/tokens/{accessor}/revoke.
#[utoipa::path(post, path = "/api/vault/tokens/{accessor}/revoke", tag = "Vault",
    summary = "Revoke a machine vault token by accessor (admin)",
    params(("accessor" = String, Path, description = "Token accessor")),
    responses((status = 200, description = "Revoked", body = serde_json::Value)))]
pub async fn token_revoke(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(accessor): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    if let Err(response) = who.require("sys/machines", Capability::Admin) {
        return response;
    }
    ok_or(
        who.store()
            .token_revoke(&accessor, &who.actor())
            .await
            .map(|()| true),
        "revoked",
    )
}

// ── Public machine login ──────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRoleLogin {
    role_id: String,
    secret_id: String,
}

/// POST /api/vault/auth/approle/login (public).
#[utoipa::path(post, path = "/api/vault/auth/approle/login", tag = "Vault",
    summary = "Exchange an AppRole role id and secret id for a vault token",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Vault token (shown once)", body = serde_json::Value),
        (status = 403, description = "Invalid credentials", body = serde_json::Value),
    ))]
pub async fn approle_login(Json(body): Json<AppRoleLogin>) -> Response {
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    ok_or(
        store.approle_login(&body.role_id, &body.secret_id).await,
        "token",
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JwtLogin {
    identity: String,
    jwt: String,
}

/// POST /api/vault/auth/jwt/login (public).
#[utoipa::path(post, path = "/api/vault/auth/jwt/login", tag = "Vault",
    summary = "Exchange an OIDC/JWT (for example a GitHub Actions token) for a vault token",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Vault token (shown once)", body = serde_json::Value),
        (status = 403, description = "JWT rejected", body = serde_json::Value),
    ))]
pub async fn jwt_login(Json(body): Json<JwtLogin>) -> Response {
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    login_token_response(store.jwt_login(&body.identity, &body.jwt).await)
}
