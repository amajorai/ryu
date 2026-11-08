//! Token, machine token-config, and token-role routes.

use super::*;

// ── Tokens (human) ────────────────────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenListQuery {
    #[serde(default)]
    identity: Option<String>,
}

/// GET /api/vault/tokens lists live machine tokens (metadata only).
#[utoipa::path(get, path = "/api/vault/tokens", tag = "Vault",
    summary = "List live machine tokens (metadata only, admin)",
    params(("identity" = Option<String>, Query, description = "Identity id or name")),
    responses((status = 200, description = "Tokens", body = serde_json::Value)))]
pub async fn token_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Query(query): Query<TokenListQuery>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/machines", Capability::Admin));
    ok_or(
        who.store().token_list(query.identity.as_deref()).await,
        "tokens",
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCreateBody {
    identity: String,
    #[serde(flatten)]
    request: TokenRequest,
}

/// POST /api/vault/tokens mints a root (orphan) token for an identity.
#[utoipa::path(post, path = "/api/vault/tokens", tag = "Vault",
    summary = "Mint a token for a machine identity (admin); the token is returned once",
    request_body = serde_json::Value,
    responses((status = 200, description = "Token", body = serde_json::Value)))]
pub async fn token_create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<TokenCreateBody>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/machines", Capability::Admin));
    ok_or(
        who.store()
            .token_create_for_identity(&body.identity, body.request, &who.actor())
            .await,
        "token",
    )
}

/// GET /api/vault/tokens/{accessor} looks a token up by accessor.
#[utoipa::path(get, path = "/api/vault/tokens/{accessor}", tag = "Vault",
    summary = "Look up a machine token by accessor (admin)",
    params(("accessor" = String, Path, description = "Token accessor")),
    responses((status = 200, description = "Token metadata", body = serde_json::Value)))]
pub async fn token_lookup_accessor(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(accessor): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/machines", Capability::Admin));
    ok_or(who.store().token_info(&accessor).await, "token")
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenewBody {
    #[serde(default)]
    pub(super) increment_secs: Option<i64>,
}

/// POST /api/vault/tokens/{accessor}/renew.
#[utoipa::path(post, path = "/api/vault/tokens/{accessor}/renew", tag = "Vault",
    summary = "Renew a machine token by accessor, up to its max TTL (admin)",
    params(("accessor" = String, Path, description = "Token accessor")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Token metadata", body = serde_json::Value)))]
pub async fn token_renew_accessor(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(accessor): Path<String>,
    body: Option<Json<RenewBody>>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/machines", Capability::Admin));
    let increment = body.and_then(|Json(body)| body.increment_secs);
    ok_or(
        who.store()
            .token_renew(&accessor, increment, &who.actor())
            .await,
        "token",
    )
}

/// POST /api/vault/tokens/{accessor}/revoke-orphan.
#[utoipa::path(post, path = "/api/vault/tokens/{accessor}/revoke-orphan", tag = "Vault",
    summary = "Revoke a token but keep its children as orphans (admin)",
    params(("accessor" = String, Path, description = "Token accessor")),
    responses((status = 200, description = "Revocation report", body = serde_json::Value)))]
pub async fn token_revoke_orphan(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(accessor): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/machines", Capability::Admin));
    ok_or(
        who.store()
            .token_revoke_tree(&accessor, true, &who.actor())
            .await,
        "revoked",
    )
}

/// PUT /api/vault/machines/{id}/token-config.
#[utoipa::path(put, path = "/api/vault/machines/{id}/token-config", tag = "Vault",
    summary = "Set a machine identity's token TTLs, period, use limit, and CIDRs (admin)",
    params(("id" = String, Path, description = "Identity id or name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Identity", body = serde_json::Value)))]
pub async fn machine_token_config(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(config): Json<TokenConfig>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/machines", Capability::Admin));
    ok_or(
        who.store()
            .machine_set_token_config(&id, config, &who.actor())
            .await,
        "machine",
    )
}

// ── Token roles ───────────────────────────────────────────────────────────

/// GET /api/vault/token-roles.
#[utoipa::path(get, path = "/api/vault/token-roles", tag = "Vault",
    summary = "List token roles the caller may see",
    responses((status = 200, description = "Token roles", body = serde_json::Value)))]
pub async fn token_roles(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    match who.store().token_role_list().await {
        Ok(roles) => {
            let visible: Vec<_> = roles
                .into_iter()
                .filter(|role| {
                    !who.sys_caps(&format!("sys/token-roles/{}", role.name))
                        .is_empty()
                })
                .collect();
            respond(json!({ "roles": visible }))
        }
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/token-roles/{name}.
#[utoipa::path(get, path = "/api/vault/token-roles/{name}", tag = "Vault",
    summary = "Read a token role (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Token role", body = serde_json::Value)))]
pub async fn token_role_get(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require(&format!("sys/token-roles/{name}"), Capability::Admin));
    ok_or(who.store().token_role_get(&name).await, "role")
}

/// PUT /api/vault/token-roles/{name}.
#[utoipa::path(put, path = "/api/vault/token-roles/{name}", tag = "Vault",
    summary = "Create or replace a token role (admin)",
    params(("name" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Token role", body = serde_json::Value)))]
pub async fn token_role_put(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(role): Json<TokenRole>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require(&format!("sys/token-roles/{name}"), Capability::Admin));
    ok_or(
        who.store()
            .token_role_put(TokenRole { name, ..role }, &who.actor())
            .await,
        "role",
    )
}

/// DELETE /api/vault/token-roles/{name}.
#[utoipa::path(delete, path = "/api/vault/token-roles/{name}", tag = "Vault",
    summary = "Delete a token role (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn token_role_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require(&format!("sys/token-roles/{name}"), Capability::Admin));
    ok_or(
        who.store().token_role_delete(&name, &who.actor()).await,
        "deleted",
    )
}
