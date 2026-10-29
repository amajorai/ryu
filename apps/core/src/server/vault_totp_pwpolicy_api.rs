//! Secret Vault TOTP engine and password-policy routes.
//!
//! Human routes sit under `/api/vault/*` behind the node bearer (plus an
//! optional user JWT) and authorize against `sys/totp/<key>` and
//! `sys/password-policies/<name>`: managing needs `admin`, producing a code,
//! validating a code, or generating a password needs `use`. Machine routes under
//! `/api/vault/agent/*` accept only `x-ryu-vault-token` and authorize purely
//! by the token's policies (no baseline), like the other engine agent routes.
//!
//! No route returns a TOTP seed except the enrollment URL (and QR code)
//! returned once when a key is generated with `exported`.

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;

use super::vault_api::{respond, vault_error};
use super::vault_crypto_api::{caller, human, machine, ok_or, require, Caller};
use super::ServerState;
use crate::identity_verify::VerifiedCaller;
use crate::vault::password_policy::PasswordPolicySpec;
use crate::vault::policy::Capability;
use crate::vault::totp::TotpCreateRequest;

fn totp_key(name: &str) -> String {
    format!("sys/totp/{name}")
}

fn policy_key(name: &str) -> String {
    format!("sys/password-policies/{name}")
}

// ── TOTP ──────────────────────────────────────────────────────────────────

/// GET /api/vault/totp/keys.
#[utoipa::path(get, path = "/api/vault/totp/keys", tag = "Vault",
    summary = "List TOTP keys (metadata only)",
    responses((status = 200, description = "Keys", body = serde_json::Value)))]
pub async fn totp_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    match who.store().totp_list().await {
        Ok(keys) => {
            let visible: Vec<_> = keys
                .into_iter()
                .filter(|key| !who.caps(&totp_key(&key.name)).is_empty())
                .collect();
            respond(json!({ "keys": visible }))
        }
        Err(error) => vault_error(error),
    }
}

/// POST /api/vault/totp/keys generates or imports a key.
#[utoipa::path(post, path = "/api/vault/totp/keys", tag = "Vault",
    summary = "Generate or import a TOTP key (admin)",
    description = "Exactly one of `generate`, `url` (otpauth://totp/...), or `secret` (Base32). \
                   A generated key returns its otpauth URL, and a QR code when `qrFormat` is \
                   `svg` or `png`, once unless `exported` is false.",
    request_body = serde_json::Value,
    responses((status = 200, description = "Created", body = serde_json::Value)))]
pub async fn totp_create(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<TotpCreateRequest>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, totp_key(&body.name), Capability::Admin);
    match who.store().totp_create(&body, &who.actor()).await {
        Ok(created) => respond(json!(created)),
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/totp/keys/{name}.
#[utoipa::path(get, path = "/api/vault/totp/keys/{name}", tag = "Vault",
    summary = "Read a TOTP key's metadata (list)",
    params(("name" = String, Path, description = "Key name")),
    responses((status = 200, description = "Key", body = serde_json::Value)))]
pub async fn totp_get(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, totp_key(&name), Capability::List);
    ok_or(who.store().totp_info(&name).await, "key")
}

/// DELETE /api/vault/totp/keys/{name}.
#[utoipa::path(delete, path = "/api/vault/totp/keys/{name}", tag = "Vault",
    summary = "Delete a TOTP key (admin)",
    params(("name" = String, Path, description = "Key name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn totp_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, totp_key(&name), Capability::Admin);
    ok_or(
        who.store()
            .totp_delete(&name, &who.actor())
            .await
            .map(|()| true),
        "deleted",
    )
}

async fn code_for(who: &Caller, name: &str) -> Response {
    require!(who, totp_key(name), Capability::Use);
    match who.store().totp_code(name, &who.actor()).await {
        Ok(code) => respond(json!(code)),
        Err(error) => vault_error(error),
    }
}

/// Body for code validation.
#[derive(Debug, Deserialize)]
pub struct TotpValidateBody {
    code: String,
}

async fn validate_for(who: &Caller, name: &str, body: &TotpValidateBody) -> Response {
    require!(who, totp_key(name), Capability::Use);
    ok_or(
        who.store()
            .totp_validate(name, &body.code, &who.actor())
            .await,
        "valid",
    )
}

/// GET /api/vault/totp/code/{name}.
#[utoipa::path(get, path = "/api/vault/totp/code/{name}", tag = "Vault",
    summary = "Generate the current TOTP code (use; audited without the code)",
    params(("name" = String, Path, description = "Key name")),
    responses((status = 200, description = "Code", body = serde_json::Value)))]
pub async fn totp_code(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    code_for(&who, &name).await
}

/// POST /api/vault/totp/validate/{name}.
#[utoipa::path(post, path = "/api/vault/totp/validate/{name}", tag = "Vault",
    summary = "Validate a TOTP code (use; a code is accepted once)",
    params(("name" = String, Path, description = "Key name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Validation result", body = serde_json::Value)))]
pub async fn totp_validate(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<TotpValidateBody>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    validate_for(&who, &name, &body).await
}

/// GET /api/vault/agent/totp/code/{name}.
#[utoipa::path(get, path = "/api/vault/agent/totp/code/{name}", tag = "Vault",
    summary = "Generate the current TOTP code with a machine token (use)",
    params(("name" = String, Path, description = "Key name")),
    responses((status = 200, description = "Code", body = serde_json::Value)))]
pub async fn agent_totp_code(headers: HeaderMap, Path(name): Path<String>) -> Response {
    let who = caller!(machine(&headers).await);
    code_for(&who, &name).await
}

/// POST /api/vault/agent/totp/validate/{name}.
#[utoipa::path(post, path = "/api/vault/agent/totp/validate/{name}", tag = "Vault",
    summary = "Validate a TOTP code with a machine token (use)",
    params(("name" = String, Path, description = "Key name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Validation result", body = serde_json::Value)))]
pub async fn agent_totp_validate(
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<TotpValidateBody>,
) -> Response {
    let who = caller!(machine(&headers).await);
    validate_for(&who, &name, &body).await
}

// ── Password policies ─────────────────────────────────────────────────────

/// GET /api/vault/sys/password-policies.
#[utoipa::path(get, path = "/api/vault/sys/password-policies", tag = "Vault",
    summary = "List password policies",
    responses((status = 200, description = "Policies", body = serde_json::Value)))]
pub async fn password_policy_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    match who.store().password_policy_list().await {
        Ok(policies) => {
            let visible: Vec<_> = policies
                .into_iter()
                .filter(|policy| !who.caps(&policy_key(&policy.name)).is_empty())
                .collect();
            respond(json!({ "policies": visible }))
        }
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/sys/password-policies/{name}.
#[utoipa::path(get, path = "/api/vault/sys/password-policies/{name}", tag = "Vault",
    summary = "Read a password policy (list)",
    params(("name" = String, Path, description = "Policy name")),
    responses((status = 200, description = "Policy", body = serde_json::Value)))]
pub async fn password_policy_get(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, policy_key(&name), Capability::List);
    ok_or(who.store().password_policy_get(&name).await, "policy")
}

/// PUT /api/vault/sys/password-policies/{name}.
#[utoipa::path(put, path = "/api/vault/sys/password-policies/{name}", tag = "Vault",
    summary = "Create or replace a password policy (admin)",
    description = "`{ length: 8-256, rules: [{ charset, minChars }] }`; the minimums must fit \
                   inside `length`.",
    params(("name" = String, Path, description = "Policy name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Policy", body = serde_json::Value)))]
pub async fn password_policy_put(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<PasswordPolicySpec>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, policy_key(&name), Capability::Admin);
    ok_or(
        who.store()
            .password_policy_put(&name, &body, &who.actor())
            .await,
        "policy",
    )
}

/// DELETE /api/vault/sys/password-policies/{name}.
#[utoipa::path(delete, path = "/api/vault/sys/password-policies/{name}", tag = "Vault",
    summary = "Delete a password policy no value uses (admin)",
    params(("name" = String, Path, description = "Policy name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn password_policy_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    require!(who, policy_key(&name), Capability::Admin);
    ok_or(
        who.store()
            .password_policy_delete(&name, &who.actor())
            .await
            .map(|()| true),
        "deleted",
    )
}

async fn generate_for(who: &Caller, name: &str) -> Response {
    require!(who, policy_key(name), Capability::Use);
    ok_or(
        who.store()
            .password_policy_generate(name, &who.actor())
            .await,
        "password",
    )
}

/// GET /api/vault/sys/password-policies/{name}/generate.
#[utoipa::path(get, path = "/api/vault/sys/password-policies/{name}/generate", tag = "Vault",
    summary = "Generate a password from a policy (use; audited without the value)",
    params(("name" = String, Path, description = "Policy name")),
    responses((status = 200, description = "Password", body = serde_json::Value)))]
pub async fn password_policy_generate(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = caller!(human(&state, caller, &headers).await);
    generate_for(&who, &name).await
}

/// GET /api/vault/agent/password-policies/{name}/generate.
#[utoipa::path(get, path = "/api/vault/agent/password-policies/{name}/generate", tag = "Vault",
    summary = "Generate a password from a policy with a machine token (use)",
    params(("name" = String, Path, description = "Policy name")),
    responses((status = 200, description = "Password", body = serde_json::Value)))]
pub async fn agent_password_policy_generate(
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let who = caller!(machine(&headers).await);
    generate_for(&who, &name).await
}

// ── Routers ───────────────────────────────────────────────────────────────

/// Human routes (node bearer, merged into the protected vault router).
pub fn routes() -> axum::Router<ServerState> {
    use axum::routing::{get, post};
    let limit = || axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    axum::Router::new()
        .route(
            "/api/vault/totp/keys",
            get(totp_list).post(totp_create).layer(limit()),
        )
        .route(
            "/api/vault/totp/keys/:name",
            get(totp_get).delete(totp_delete),
        )
        .route("/api/vault/totp/code/:name", get(totp_code))
        .route(
            "/api/vault/totp/validate/:name",
            post(totp_validate).layer(limit()),
        )
        .route(
            "/api/vault/sys/password-policies",
            get(password_policy_list),
        )
        .route(
            "/api/vault/sys/password-policies/:name",
            get(password_policy_get)
                .put(password_policy_put)
                .delete(password_policy_delete)
                .layer(limit()),
        )
        .route(
            "/api/vault/sys/password-policies/:name/generate",
            get(password_policy_generate),
        )
}

/// Machine-token routes (public mount; authorization is the vault token).
pub fn public_routes() -> axum::Router<ServerState> {
    use axum::routing::{get, post};
    let limit = axum::extract::DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    axum::Router::new()
        .route("/api/vault/agent/totp/code/:name", get(agent_totp_code))
        .route(
            "/api/vault/agent/totp/validate/:name",
            post(agent_totp_validate),
        )
        .route(
            "/api/vault/agent/password-policies/:name/generate",
            get(agent_password_policy_generate),
        )
        .layer(limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;

    #[test]
    fn machine_grants_expand_identity_templates() {
        let who = Caller::machine_for_test(vec![crate::vault::policy::PolicyRule {
            path: "sys/totp/{{identity.machine.id}}".into(),
            capabilities: vec![Capability::Use],
            deny: false,
            ..Default::default()
        }]);
        assert!(who.require(&totp_key("mid_x"), Capability::Use).is_ok());
        assert!(who.require(&totp_key("mid_y"), Capability::Use).is_err());
    }

    #[tokio::test]
    async fn machine_callers_need_an_explicit_use_grant() {
        let who = Caller::machine_for_test(vec![crate::vault::policy::PolicyRule {
            path: "sys/totp/github".into(),
            capabilities: vec![Capability::Use],
            deny: false,
            ..Default::default()
        }]);
        assert!(who.require(&totp_key("github"), Capability::Use).is_ok());
        assert!(who.require(&totp_key("github"), Capability::Admin).is_err());
        assert!(who.require(&totp_key("other"), Capability::Use).is_err());
        assert!(who.require(&policy_key("db"), Capability::Use).is_err());
        // A denied code request never reaches the store.
        let response = code_for(&who, "other").await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        // Granted, but the key does not exist.
        let response = code_for(&who, "github").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn explicit_deny_blocks_password_generation() {
        let who = Caller::machine_for_test(vec![
            crate::vault::policy::PolicyRule {
                path: "sys/password-policies/*".into(),
                capabilities: vec![Capability::Use],
                deny: false,
                ..Default::default()
            },
            crate::vault::policy::PolicyRule {
                path: "sys/password-policies/root".into(),
                capabilities: vec![Capability::Use],
                deny: true,
                ..Default::default()
            },
        ]);
        assert!(who.require(&policy_key("db"), Capability::Use).is_ok());
        let response = generate_for(&who, "root").await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}

#[cfg(test)]
#[path = "vault_totp_routes_test.rs"]
mod routes_test;
