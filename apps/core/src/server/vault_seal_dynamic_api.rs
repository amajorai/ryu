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
use crate::plugin_secrets::{SecretCoords, SecretScope};
use crate::vault::auth_methods::AwsIamLogin;
use crate::vault::dynamic::static_roles::StaticRoleInput;
use crate::vault::policy::Capability;
use crate::vault::seal_ext::SealProviderConfig;

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

// ── Static roles ──────────────────────────────────────────────────────────

fn static_key(name: &str) -> String {
    format!("sys/static/{name}")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticTargetBody {
    #[serde(default)]
    environment: Option<String>,
    #[serde(default)]
    path: Option<String>,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticRoleBody {
    #[serde(flatten)]
    role: StaticRoleInput,
    target: StaticTargetBody,
    /// Rotate immediately after saving (default true).
    #[serde(default)]
    rotate_now: Option<bool>,
}

fn static_target(ctx: &Ctx, target: StaticTargetBody) -> Result<SecretCoords, Response> {
    SecretCoords {
        scope: SecretScope::Node,
        scope_id: ctx.node_id.clone(),
        environment: target
            .environment
            .unwrap_or_else(|| crate::vault::DEFAULT_ENVIRONMENT.to_owned()),
        path: target
            .path
            .unwrap_or_else(|| crate::vault::ROOT_PATH.to_owned()),
        binding: None,
        name: target.name,
    }
    .normalize()
    .map_err(|error| invalid_request(&error.to_string()))
}

/// Rotations write a server-generated value into `target` with no change
/// request, so in a protected environment they are reserved to callers with
/// `admin` on the target (like every other unapproved write path), and a
/// target whose `write` carries parameter constraints cannot be managed: the
/// generated value cannot be checked against them.
async fn require_unapproved_rotation(ctx: &Ctx, target: &SecretCoords) -> Result<(), Response> {
    if super::vault_api::protected_environment(ctx, &target.environment)
        .await?
        .is_some()
        && !ctx.caps(target).contains(&Capability::Admin)
    {
        return Err(super::vault_api::protected_denied(&target.environment));
    }
    if ctx.write_parameters_constrained(target) {
        return Err(super::json_error(
            axum::http::StatusCode::FORBIDDEN,
            format!(
                "vault_denied: parameter constraints apply to `{}`, which a static role's generated value cannot satisfy",
                target.policy_key()
            ),
        ));
    }
    Ok(())
}

/// GET /api/vault/static/roles lists the roles the caller administers.
#[utoipa::path(get, path = "/api/vault/static/roles", tag = "Vault",
    summary = "List static roles (no credentials)",
    responses((status = 200, description = "Static roles", body = serde_json::Value)))]
pub async fn static_list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    match ctx.store.static_list_roles().await {
        Ok(roles) => {
            let visible: Vec<_> = roles
                .into_iter()
                .filter(|role| !ctx.sys_caps(&static_key(&role.name)).is_empty())
                .collect();
            respond(json!({ "roles": visible }))
        }
        Err(error) => vault_error(error),
    }
}

/// GET /api/vault/static/roles/{name}.
#[utoipa::path(get, path = "/api/vault/static/roles/{name}", tag = "Vault",
    summary = "Describe a static role (no credentials)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Static role", body = serde_json::Value)))]
pub async fn static_get(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(ctx.require_sys(&static_key(&name), Capability::List));
    ok_or(ctx.store.static_role(&name).await, "role")
}

/// PUT /api/vault/static/roles/{name}.
#[utoipa::path(put, path = "/api/vault/static/roles/{name}", tag = "Vault",
    summary = "Create or replace a static role (admin; write on the target value)",
    params(("name" = String, Path, description = "Role name")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Static role", body = serde_json::Value)))]
pub async fn static_put(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(ctx.require_sys(&static_key(&name), Capability::Admin));
    let body: StaticRoleBody = try_response!(parse_body(body));
    let target = try_response!(static_target(&ctx, body.target));
    try_response!(ctx.require(&target, Capability::Write));
    // Checked before the role is saved: once saved, the scheduler rotates it.
    try_response!(require_unapproved_rotation(&ctx, &target).await);
    let actor = ctx.actor();
    let role = match ctx
        .store
        .static_put_role(&name, &body.role, target, &actor)
        .await
    {
        Ok(role) => role,
        Err(error) => return vault_error(error),
    };
    if !body.rotate_now.unwrap_or(true) {
        return respond(json!({ "role": role }));
    }
    // A failed first rotation keeps the role (it retries on schedule) and is
    // reported alongside it.
    match ctx.store.static_rotate(&name, &actor).await {
        Ok(role) => respond(json!({ "role": role, "rotated": true })),
        Err(error) => respond(json!({
            "role": ctx.store.static_role(&name).await.ok(),
            "rotated": false,
            "rotationError": error.to_string(),
        })),
    }
}

/// DELETE /api/vault/static/roles/{name}.
#[utoipa::path(delete, path = "/api/vault/static/roles/{name}", tag = "Vault",
    summary = "Stop managing a static role (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Deleted", body = serde_json::Value)))]
pub async fn static_delete(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(ctx.require_sys(&static_key(&name), Capability::Admin));
    ok_or(
        ctx.store
            .static_delete_role(&name, &ctx.actor())
            .await
            .map(|()| true),
        "deleted",
    )
}

/// POST /api/vault/static/rotate/{name}.
#[utoipa::path(post, path = "/api/vault/static/rotate/{name}", tag = "Vault",
    summary = "Rotate a static role's credential now (admin)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Static role", body = serde_json::Value)))]
pub async fn static_rotate(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    try_response!(ctx.require_sys(&static_key(&name), Capability::Admin));
    // The target's environment may have become protected (or the caller's
    // write constrained) since the role was saved.
    let role = match ctx.store.static_role(&name).await {
        Ok(role) => role,
        Err(error) => return vault_error(error),
    };
    try_response!(require_unapproved_rotation(&ctx, &role.target).await);
    ok_or(ctx.store.static_rotate(&name, &ctx.actor()).await, "role")
}

/// GET /api/vault/static/creds/{name} returns the current credential.
#[utoipa::path(get, path = "/api/vault/static/creds/{name}", tag = "Vault",
    summary = "Read a static role's current credential (read on its target value)",
    params(("name" = String, Path, description = "Role name")),
    responses((status = 200, description = "Credential", body = serde_json::Value)))]
pub async fn static_creds(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let ctx = ctx!(state, caller, headers);
    static_creds_for(&ctx, &name).await
}

async fn static_creds_for(ctx: &Ctx, name: &str) -> Response {
    try_response!(ctx.require_sys(&static_key(name), Capability::Read));
    let role = match ctx.store.static_role(name).await {
        Ok(role) => role,
        Err(error) => return vault_error(error),
    };
    try_response!(ctx.require(&role.target, Capability::Read));
    // The credential is the target's plaintext: a control group on the target
    // gates it here too (open one through the target's /reveal).
    try_response!(ctx.require_ungated_read(&role.target.policy_key()));
    match ctx.store.static_read(name, &ctx.actor()).await {
        Ok((role, value)) => respond(json!({
            "role": role.name,
            "username": role.summary.get("username").or_else(|| role.summary.get("userName")),
            "value": value,
            "lastRotatedAt": role.last_rotated_at,
            "nextRotationAt": role.next_rotation_at,
        })),
        Err(error) => vault_error(error),
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
    fn static_role_bodies_flatten_the_role_input() {
        let body: StaticRoleBody = serde_json::from_value(json!({
            "provider": { "kind": "redis", "connectionUrl": "redis://h", "username": "app" },
            "rotationPeriodSecs": 3600,
            "target": { "name": "CACHE_PASSWORD" },
            "rotateNow": false,
        }))
        .unwrap();
        assert_eq!(body.role.provider.kind(), "redis");
        assert_eq!(body.target.name, "CACHE_PASSWORD");
        assert_eq!(body.rotate_now, Some(false));
    }

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

    #[tokio::test]
    async fn static_creds_honor_control_groups_on_the_target() {
        use crate::plugin_secrets::{PluginSecretStore, SecretCoords, SecretScope};
        use crate::vault::audit::AuditActor;
        use crate::vault::policy::{Policy, PolicyRule};
        use crate::vault::policy_ext::{ControlGroupFactor, ControlGroupSpec};
        use axum::http::StatusCode;

        let store: &'static PluginSecretStore =
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
        let (url, _log) = crate::vault::dynamic::redis::tests::fake_server(false).await;
        let input = serde_json::from_value(json!({
            "provider": { "kind": "valkey", "connectionUrl": url, "username": "app" },
            "rotationPeriodSecs": 3600,
        }))
        .unwrap();
        let target = SecretCoords::root(SecretScope::Node, "node-1", None, "CACHE_PASSWORD");
        let actor = AuditActor::system();
        store
            .static_put_role("cache", &input, target, &actor)
            .await
            .unwrap();
        store.static_rotate("cache", &actor).await.unwrap();
        let (_, password) = store.static_read("cache", &actor).await.unwrap();

        let ctx = |gated: bool| {
            Ctx::test_member(
                store,
                "user-1",
                vec![Policy {
                    name: "reader".into(),
                    description: String::new(),
                    rules: vec![PolicyRule {
                        path: "**".into(),
                        capabilities: vec![Capability::Read],
                        deny: false,
                        control_group: gated.then(|| ControlGroupSpec {
                            ttl_secs: None,
                            factors: vec![ControlGroupFactor {
                                name: "security".into(),
                                approvers: vec!["user:bob".into()],
                                approvals: 1,
                            }],
                        }),
                        ..Default::default()
                    }],
                }],
            )
        };
        let read = |response: Response| async move {
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .unwrap();
            (status, String::from_utf8_lossy(&bytes).into_owned())
        };

        let (status, text) = read(static_creds_for(&ctx(true), "cache").await).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{text}");
        assert!(text.contains("vault_control_group_required"), "{text}");
        assert!(!text.contains(&password));

        let (status, text) = read(static_creds_for(&ctx(false), "cache").await).await;
        assert_eq!(status, StatusCode::OK, "{text}");
        assert!(text.contains(&password));
    }

    #[tokio::test]
    async fn static_roles_cannot_bypass_protected_environments_or_constraints() {
        use crate::plugin_secrets::kv::Environment;
        use crate::plugin_secrets::PluginSecretStore;
        use crate::vault::audit::AuditActor;
        use crate::vault::policy::{Policy, PolicyRule};
        use axum::http::StatusCode;

        let store: &'static PluginSecretStore =
            Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
        let ctx = |capabilities: Vec<Capability>, constrained: bool| {
            Ctx::test_member(
                store,
                "user-1",
                vec![Policy {
                    name: "writer".into(),
                    description: String::new(),
                    rules: vec![PolicyRule {
                        path: "prod/**".into(),
                        capabilities,
                        deny: false,
                        required_parameters: if constrained {
                            vec!["value".into()]
                        } else {
                            Vec::new()
                        },
                        ..Default::default()
                    }],
                }],
            )
        };
        let target = SecretCoords {
            scope: SecretScope::Node,
            scope_id: "node-1".to_owned(),
            environment: "prod".to_owned(),
            path: "/".to_owned(),
            binding: None,
            name: "DB_PASSWORD".to_owned(),
        };
        let status = |result: Result<(), Response>| match result {
            Ok(()) => StatusCode::OK,
            Err(response) => response.status(),
        };
        let writer = ctx(vec![Capability::Write], false);
        assert_eq!(
            status(require_unapproved_rotation(&writer, &target).await),
            StatusCode::OK
        );
        assert_eq!(
            status(require_unapproved_rotation(&ctx(vec![Capability::Write], true), &target).await),
            StatusCode::FORBIDDEN
        );

        store
            .put_environment(
                &Environment {
                    slug: "prod".into(),
                    name: "Production".into(),
                    protected: true,
                    required_approvals: 2,
                    position: 0,
                    cas_required: false,
                },
                &AuditActor::system(),
            )
            .await
            .unwrap();
        assert_eq!(
            status(require_unapproved_rotation(&writer, &target).await),
            StatusCode::FORBIDDEN
        );
        let admin = ctx(vec![Capability::Write, Capability::Admin], false);
        assert_eq!(
            status(require_unapproved_rotation(&admin, &target).await),
            StatusCode::OK
        );
    }
}
