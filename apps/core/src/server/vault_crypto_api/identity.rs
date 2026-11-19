//! Workload identity token routes, the OIDC discovery document and the JWKS.
// test-exempt: moved verbatim out of server/vault_crypto_api.rs; covered by vault_crypto_api/tests.rs, the vault public-route auth suite and the OpenAPI spec test.

use super::*;

// ── Identity tokens ───────────────────────────────────────────────────────

/// GET /api/vault/identity/config.
#[utoipa::path(get, path = "/api/vault/identity/config", tag = "Vault",
    summary = "Identity token issuer configuration",
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_config(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, IDENTITY_CONFIG_KEY, Capability::Admin);
    ok_or(who.store().identity_config().await, "config")
}

/// PUT /api/vault/identity/config.
#[utoipa::path(put, path = "/api/vault/identity/config", tag = "Vault",
    summary = "Set the identity token issuer configuration (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_set_config(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<IdentityConfig>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, IDENTITY_CONFIG_KEY, Capability::Admin);
    ok_or(
        who.store().identity_set_config(&body, &who.actor()).await,
        "config",
    )
}

/// POST /api/vault/identity/keys/rotate.
#[utoipa::path(post, path = "/api/vault/identity/keys/rotate", tag = "Vault",
    summary = "Rotate the identity token signing key (admin)",
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_rotate(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, IDENTITY_CONFIG_KEY, Capability::Admin);
    ok_or(who.store().identity_rotate_key(&who.actor()).await, "kid")
}

/// GET /api/vault/identity/roles.
#[utoipa::path(get, path = "/api/vault/identity/roles", tag = "Vault",
    summary = "List identity token roles",
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_roles(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    match who.store().identity_list_roles().await {
        Ok(roles) => {
            let visible: Vec<_> = roles
                .into_iter()
                .filter(|role| !who.caps(&identity_key(&role.name)).is_empty())
                .collect();
            respond(json!({ "roles": visible }))
        }
        Err(error) => vault_error(error),
    }
}

/// PUT /api/vault/identity/roles/{name}.
#[utoipa::path(put, path = "/api/vault/identity/roles/{name}", tag = "Vault",
    summary = "Create or update an identity token role",
    params(("name" = String, Path, description = "Identity token role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_put_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(mut body): Json<Value>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, identity_key(&name), Capability::Admin);
    if let Some(object) = body.as_object_mut() {
        object.insert("name".into(), json!(name));
    }
    let role: IdentityRole = match parse_body(body) {
        Ok(role) => role,
        Err(response) => return response,
    };
    ok_or(
        who.store()
            .identity_put_role(&role, &who.actor())
            .await
            .map(|()| role),
        "role",
    )
}

/// DELETE /api/vault/identity/roles/{name}.
#[utoipa::path(delete, path = "/api/vault/identity/roles/{name}", tag = "Vault",
    summary = "Delete an identity token role",
    params(("name" = String, Path, description = "Identity token role name")),
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_delete_role(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, identity_key(&name), Capability::Admin);
    ok_or(
        who.store().identity_delete_role(&name, &who.actor()).await,
        "deleted",
    )
}

pub(super) async fn issue_token(who: &Caller, role: &str) -> Response {
    require!(who, identity_key(role), Capability::Use);
    let Some(subject) = who.subject() else {
        return invalid_request("identity tokens require an authenticated user or machine token");
    };
    ok_or(
        who.store()
            .identity_token(role, &subject, &who.actor())
            .await,
        "token",
    )
}

/// POST /api/vault/identity/token/{role}.
#[utoipa::path(post, path = "/api/vault/identity/token/{role}", tag = "Vault",
    summary = "Mint a signed identity token for a role",
    params(("role" = String, Path, description = "Identity token role")),
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_token(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(role): Path<String>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    issue_token(&who, &role).await
}

/// POST /api/vault/agent/identity/token/{role}.
#[utoipa::path(post, path = "/api/vault/agent/identity/token/{role}", tag = "Vault",
    summary = "Mint a signed identity token for a role with a machine token",
    params(("role" = String, Path, description = "Identity token role")),
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn agent_identity_token(headers: HeaderMap, Path(role): Path<String>) -> Response {
    let who = caller!(machine(&headers).await);
    issue_token(&who, &role).await
}

/// GET /api/vault/identity/.well-known/openid-configuration (public; plain
/// JSON without the vault envelope, as relying parties expect).
#[utoipa::path(get, path = "/api/vault/identity/.well-known/openid-configuration", tag = "Vault",
    summary = "Public OIDC discovery document for identity tokens",
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_discovery() -> Response {
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.identity_discovery().await {
        Ok(Some(document)) => Json(document).into_response(),
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            "vault_not_found: no identity issuer is configured".to_owned(),
        ),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/identity/.well-known/keys (public JWKS).
#[utoipa::path(get, path = "/api/vault/identity/.well-known/keys", tag = "Vault",
    summary = "Public JWKS for identity tokens",
    responses((status = 200, description = "Result", body = serde_json::Value)))]
pub async fn identity_jwks() -> Response {
    let store = match store() {
        Ok(store) => store,
        Err(response) => return response,
    };
    match store.identity_jwks().await {
        Ok(jwks) => Json(jwks).into_response(),
        Err(error) => vault_error(error),
    }
}
