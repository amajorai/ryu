//! Seal-provider, rekey, static-role, and extra machine-login routes.
//!
//! Protected routes (node bearer plus optional user JWT, merged into the
//! vault router):
//!
//! * `GET|PUT|DELETE /api/vault/sys/seal-provider`, `POST
//!   /api/vault/sys/seal-provider/unseal`: auto-unseal providers and recovery
//!   shares (admin on `sys/seal`);
//! * `GET /api/vault/sys/rekey`, `POST /api/vault/sys/rekey/{init|update|cancel}`:
//!   authenticated rekey of the Shamir shares (admin on `sys/rekey`);
//! * `/api/vault/static/roles[/:name]`, `POST /api/vault/static/rotate/:name`,
//!   `GET /api/vault/static/creds/:name`: static-role rotation (admin on
//!   `sys/static/<name>`; reading the credential also needs `read` on its
//!   target value).
//!
//! Public routes (authenticate in-handler, like AppRole and JWT login):
//! `POST /api/vault/auth/{cert,aws,kubernetes}/login`.
//!
//! Key shares and credentials appear only in the response that creates them;
//! they are never written to the audit log.

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use super::vault_api::{
    ctx, invalid_request, login_token_response, parse_body, respond, store, try_response,
    vault_error, Ctx,
};
use super::ServerState;
use crate::identity_verify::VerifiedCaller;
use crate::vault::auth_methods::AwsIamLogin;
use crate::vault::policy::Capability;
use crate::vault::seal_ext::SealProviderConfig;

#[path = "vault_seal_static_roles.rs"]
mod static_roles;
pub use static_roles::*;

fn ok_or<T: serde::Serialize>(result: anyhow::Result<T>, key: &str) -> Response {
    match result {
        Ok(value) => respond(json!({ key: value })),
        Err(error) => vault_error(error),
    }
}

// ── Seal providers ────────────────────────────────────────────────────────

/// GET /api/vault/sys/seal-provider.
#[utoipa::path(get, path = "/api/vault/sys/seal-provider", tag = "Vault",
    summary = "Auto-unseal provider and recovery-share settings (admin)",
    responses((status = 200, description = "Provider status", body = serde_json::Value)))]
pub async fn seal_provider_status(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(ctx.require_sys("sys/seal", Capability::Admin));
    ok_or(ctx.store.seal_provider_status().await, "sealProvider")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealProviderBody {
    provider: SealProviderConfig,
    #[serde(default)]
    recovery_shares: Option<u8>,
    #[serde(default)]
    recovery_threshold: Option<u8>,
}

/// PUT /api/vault/sys/seal-provider configures auto-unseal and returns the
/// recovery shares once.
#[utoipa::path(put, path = "/api/vault/sys/seal-provider", tag = "Vault",
    summary = "Configure an auto-unseal provider; returns recovery shares once (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Recovery shares", body = serde_json::Value)))]
pub async fn seal_provider_configure(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(ctx.require_sys("sys/seal", Capability::Admin));
    let body: SealProviderBody = try_response!(parse_body(body));
    let result = ctx
        .store
        .seal_provider_configure(
            &body.provider,
            body.recovery_shares.unwrap_or(5),
            body.recovery_threshold.unwrap_or(3),
            &ctx.actor(),
        )
        .await;
    match result {
        Ok(shares) => respond(json!({
            "recoveryShares": shares,
            "sealProvider": ctx.store.seal_provider_status().await.ok(),
        })),
        Err(error) => vault_error(error),
    }
}

/// DELETE /api/vault/sys/seal-provider.
#[utoipa::path(delete, path = "/api/vault/sys/seal-provider", tag = "Vault",
    summary = "Remove the auto-unseal provider; recovery shares become unseal shares (admin)",
    responses((status = 200, description = "Removed", body = serde_json::Value)))]
pub async fn seal_provider_remove(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(ctx.require_sys("sys/seal", Capability::Admin));
    ok_or(
        ctx.store
            .seal_provider_remove(&ctx.actor())
            .await
            .map(|()| true),
        "removed",
    )
}

/// POST /api/vault/sys/seal-provider/unseal retries auto-unseal now.
#[utoipa::path(post, path = "/api/vault/sys/seal-provider/unseal", tag = "Vault",
    summary = "Unseal from the configured seal provider now (admin)",
    responses((status = 200, description = "Seal status", body = serde_json::Value)))]
pub async fn seal_provider_unseal(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(ctx.require_sys("sys/seal", Capability::Admin));
    ok_or(ctx.store.seal_provider_unseal(&ctx.actor()).await, "seal")
}

// ── Rekey ─────────────────────────────────────────────────────────────────

/// GET /api/vault/sys/rekey.
#[utoipa::path(get, path = "/api/vault/sys/rekey", tag = "Vault",
    summary = "Rekey progress (admin)",
    responses((status = 200, description = "Rekey status", body = serde_json::Value)))]
pub async fn rekey_status(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(ctx.require_sys("sys/rekey", Capability::Admin));
    respond(json!({ "rekey": ctx.store.rekey_status() }))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RekeyBody {
    #[serde(default)]
    shares: Option<u8>,
    #[serde(default)]
    threshold: Option<u8>,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    share: Option<String>,
}

/// Defaults apply only to an absent body; a malformed one (wrong types,
/// `shares` above 255) is rejected rather than silently replaced.
fn rekey_body(raw: &[u8]) -> Result<RekeyBody, Response> {
    if raw.iter().all(u8::is_ascii_whitespace) {
        return Ok(RekeyBody::default());
    }
    let value: Value = serde_json::from_slice(raw)
        .map_err(|_| invalid_request("the request body is not valid JSON"))?;
    parse_body(value)
}

/// POST /api/vault/sys/rekey/{op}: `init` (`shares`, `threshold`), `update`
/// (`nonce`, `share`), or `cancel`.
#[utoipa::path(post, path = "/api/vault/sys/rekey/{op}", tag = "Vault",
    summary = "Start, advance, or cancel a rekey of the key shares (admin)",
    params(("op" = String, Path, description = "`init`, `update`, or `cancel`")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Rekey status or new shares", body = serde_json::Value)))]
pub async fn rekey_operation(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(op): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(ctx.require_sys("sys/rekey", Capability::Admin));
    let body: RekeyBody = try_response!(rekey_body(&body));
    let actor = ctx.actor();
    match op.as_str() {
        "init" => ok_or(
            ctx.store
                .rekey_init(
                    body.shares.unwrap_or(5),
                    body.threshold.unwrap_or(3),
                    &actor,
                )
                .await,
            "rekey",
        ),
        "update" => {
            let (Some(nonce), Some(share)) = (body.nonce.as_deref(), body.share.as_deref()) else {
                return invalid_request("`nonce` and `share` are required");
            };
            match ctx.store.rekey_update(nonce, share, &actor).await {
                Ok(update) => respond(json!(update)),
                Err(error) => vault_error(error),
            }
        }
        "cancel" => ok_or(ctx.store.rekey_cancel(&actor).await, "rekey"),
        _ => invalid_request("unknown rekey operation"),
    }
}

// ── Machine logins (public) ───────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertLogin {
    identity: String,
    certificate_pem: String,
    proof: String,
}

/// POST /api/vault/auth/cert/login.
#[utoipa::path(post, path = "/api/vault/auth/cert/login", tag = "Vault",
    summary = "Log in with a TLS client certificate and proof-of-possession JWT",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Vault token (shown once)", body = serde_json::Value),
        (status = 403, description = "Certificate rejected", body = serde_json::Value),
    ))]
pub async fn cert_login(Json(body): Json<CertLogin>) -> Response {
    let store = try_response!(store());
    login_token_response(
        store
            .cert_login(&body.identity, &body.certificate_pem, &body.proof)
            .await,
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsLogin {
    identity: String,
    #[serde(flatten)]
    request: AwsIamLogin,
}

/// POST /api/vault/auth/aws/login.
#[utoipa::path(post, path = "/api/vault/auth/aws/login", tag = "Vault",
    summary = "Log in with a presigned sts:GetCallerIdentity request",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Vault token (shown once)", body = serde_json::Value),
        (status = 403, description = "Caller rejected", body = serde_json::Value),
    ))]
pub async fn aws_login(Json(body): Json<AwsLogin>) -> Response {
    let store = try_response!(store());
    login_token_response(store.aws_iam_login(&body.identity, &body.request).await)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesLogin {
    identity: String,
    jwt: String,
}

/// POST /api/vault/auth/kubernetes/login.
#[utoipa::path(post, path = "/api/vault/auth/kubernetes/login", tag = "Vault",
    summary = "Log in with a Kubernetes service-account token (TokenReview)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Vault token (shown once)", body = serde_json::Value),
        (status = 403, description = "Token rejected", body = serde_json::Value),
    ))]
pub async fn kubernetes_login(Json(body): Json<KubernetesLogin>) -> Response {
    let store = try_response!(store());
    login_token_response(store.kubernetes_login(&body.identity, &body.jwt).await)
}

// ── Routers ───────────────────────────────────────────────────────────────

/// Protected routes, merged into the vault router.
pub fn routes() -> Router<ServerState> {
    let limit = || DefaultBodyLimit::max(super::vault_api::MAX_REQUEST_BODY_BYTES);
    Router::new()
        .route(
            "/api/vault/sys/seal-provider",
            get(seal_provider_status)
                .put(seal_provider_configure)
                .delete(seal_provider_remove)
                .layer(limit()),
        )
        .route(
            "/api/vault/sys/seal-provider/unseal",
            post(seal_provider_unseal),
        )
        .route("/api/vault/sys/rekey", get(rekey_status))
        .route(
            "/api/vault/sys/rekey/:op",
            post(rekey_operation).layer(limit()),
        )
        .route("/api/vault/static/roles", get(static_list))
        .route(
            "/api/vault/static/roles/:name",
            get(static_get)
                .put(static_put)
                .delete(static_delete)
                .layer(limit()),
        )
        .route("/api/vault/static/rotate/:name", post(static_rotate))
        .route("/api/vault/static/creds/:name", get(static_creds))
}

/// Public machine-login routes (authenticate in-handler).
pub fn public_routes() -> Router<ServerState> {
    Router::new()
        .route("/api/vault/auth/cert/login", post(cert_login))
        .route("/api/vault/auth/aws/login", post(aws_login))
        .route("/api/vault/auth/kubernetes/login", post(kubernetes_login))
        .layer(DefaultBodyLimit::max(
            super::vault_api::MAX_REQUEST_BODY_BYTES,
        ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aws_login_bodies_use_the_vault_wire_format() {
        let body: AwsLogin = serde_json::from_value(json!({
            "identity": "ci",
            "iamHttpRequestMethod": "POST",
            "iamRequestUrl": "aHR0cHM6Ly9zdHMuYW1hem9uYXdzLmNvbS8=",
            "iamRequestBody": "",
            "iamRequestHeaders": "e30=",
        }))
        .unwrap();
        assert_eq!(body.identity, "ci");
        assert_eq!(body.request.iam_http_request_method, "POST");
    }

    #[test]
    fn routers_build_without_conflicts() {
        let _ = routes();
        let _ = public_routes();
    }

    #[test]
    fn rekey_bodies_default_only_when_absent() {
        let empty = rekey_body(b"").ok().unwrap();
        assert_eq!((empty.shares, empty.threshold), (None, None));
        assert!(rekey_body(b"  \n").is_ok());
        let parsed = rekey_body(br#"{"shares":7,"threshold":4}"#).ok().unwrap();
        assert_eq!((parsed.shares, parsed.threshold), (Some(7), Some(4)));
        for bad in [
            &br#"{"shares":7,"threshold":"4"}"#[..],
            br#"{"shares":300,"threshold":4}"#,
            b"{not json",
        ] {
            assert!(rekey_body(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
    }
}
