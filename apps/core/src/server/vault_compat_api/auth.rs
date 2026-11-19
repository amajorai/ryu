//! `/v1/auth/<method>/login`: AppRole, JWT, TLS certificate, AWS IAM, and
//! Kubernetes machine logins.
//!
//! Each calls the store login its native `/api/vault/auth/<method>/login`
//! route calls. Identity logins (everything but AppRole) answer every typed
//! refusal with the same `403 permission denied`, as the native routes do,
//! so these unauthenticated routes cannot enumerate identity names, methods,
//! or disabled identities; the reason is in the audit log.

use axum::body::Bytes;
use axum::extract::State;
use axum::response::Response;
use serde::Deserialize;

use super::token::issued;
use super::*;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::auth_methods::AwsIamLogin;
use crate::vault::machine::IssuedToken;
use crate::vault::VaultError;

/// The reply to an identity login. A fail-closed audit refusal or a sealed
/// vault stays a 503 so the caller can retry; every other typed refusal is
/// the same 403.
async fn identity_login(
    store: &PluginSecretStore,
    result: anyhow::Result<IssuedToken>,
) -> Response {
    match result {
        Ok(token) => issued(store, token).await,
        Err(error)
            if error.downcast_ref::<VaultError>().is_some_and(|e| {
                !matches!(e, VaultError::Sealed | VaultError::AuditUnavailable)
            }) =>
        {
            permission_denied()
        }
        Err(error) => store_error(&error),
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct AppRoleLoginBody {
    role_id: String,
    secret_id: String,
}

/// POST /v1/auth/approle/login.
#[utoipa::path(post, path = "/v1/auth/approle/login", tag = "Vault",
    operation_id = "vault_compat_approle_login",
    summary = "Exchange an AppRole role id and secret id for a machine token",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Machine token (`auth` block, shown once)", body = serde_json::Value),
        (status = 400, description = "Malformed request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn approle_login(State(state): State<CompatState>, body: Bytes) -> Response {
    let store = tri!(state.store());
    let body: AppRoleLoginBody = tri!(parse_json(&body));
    match store.approle_login(&body.role_id, &body.secret_id).await {
        Ok(token) => issued(store, token).await,
        Err(error) => store_error(&error),
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct JwtLoginBody {
    /// The Ryu machine identity name.
    role: String,
    jwt: String,
}

/// POST /v1/auth/jwt/login.
#[utoipa::path(post, path = "/v1/auth/jwt/login", tag = "Vault",
    operation_id = "vault_compat_jwt_login",
    summary = "Exchange an OIDC/JWT token for a machine token (`role` is the identity name)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Machine token (`auth` block, shown once)", body = serde_json::Value),
        (status = 400, description = "Malformed request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn jwt_login(State(state): State<CompatState>, body: Bytes) -> Response {
    let store = tri!(state.store());
    let body: JwtLoginBody = tri!(parse_json(&body));
    identity_login(store, store.jwt_login(&body.role, &body.jwt).await).await
}

/// Vault's cert login reads the TLS client certificate; Core sits behind the
/// node's listener, so the certificate and a proof-of-possession JWT signed
/// by its key travel in the body, as on the native route.
#[derive(Debug, Deserialize)]
pub(crate) struct CertLoginBody {
    /// The Ryu machine identity name.
    name: String,
    certificate_pem: String,
    proof: String,
}

/// POST /v1/auth/cert/login.
#[utoipa::path(post, path = "/v1/auth/cert/login", tag = "Vault",
    operation_id = "vault_compat_cert_login",
    summary = "Log in with a TLS client certificate and proof-of-possession JWT in the body",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Machine token (`auth` block, shown once)", body = serde_json::Value),
        (status = 400, description = "Malformed request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn cert_login(State(state): State<CompatState>, body: Bytes) -> Response {
    let store = tri!(state.store());
    let body: CertLoginBody = tri!(parse_json(&body));
    let result = store
        .cert_login(&body.name, &body.certificate_pem, &body.proof)
        .await;
    identity_login(store, result).await
}

#[derive(Debug, Deserialize)]
pub(crate) struct AwsLoginBody {
    /// The Ryu machine identity name.
    role: String,
    /// `iam_http_request_method`, `iam_request_url`, `iam_request_body`,
    /// `iam_request_headers` (base64, as Vault's AWS IAM login sends them).
    #[serde(flatten)]
    request: AwsIamLogin,
}

/// POST /v1/auth/aws/login.
#[utoipa::path(post, path = "/v1/auth/aws/login", tag = "Vault",
    operation_id = "vault_compat_aws_login",
    summary = "Log in with a presigned sts:GetCallerIdentity request (`role` is the identity name)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Machine token (`auth` block, shown once)", body = serde_json::Value),
        (status = 400, description = "Malformed request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn aws_login(State(state): State<CompatState>, body: Bytes) -> Response {
    let store = tri!(state.store());
    let body: AwsLoginBody = tri!(parse_json(&body));
    identity_login(store, store.aws_iam_login(&body.role, &body.request).await).await
}

#[derive(Debug, Deserialize)]
pub(crate) struct KubernetesLoginBody {
    /// The Ryu machine identity name.
    role: String,
    jwt: String,
}

/// POST /v1/auth/kubernetes/login.
#[utoipa::path(post, path = "/v1/auth/kubernetes/login", tag = "Vault",
    operation_id = "vault_compat_kubernetes_login",
    summary = "Log in with a Kubernetes service-account token (`role` is the identity name)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Machine token (`auth` block, shown once)", body = serde_json::Value),
        (status = 400, description = "Malformed request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn kubernetes_login(State(state): State<CompatState>, body: Bytes) -> Response {
    let store = tri!(state.store());
    let body: KubernetesLoginBody = tri!(parse_json(&body));
    identity_login(store, store.kubernetes_login(&body.role, &body.jwt).await).await
}
