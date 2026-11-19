//! Login lockout on every machine-login route, native and `/v1`, plus the
//! admin routes that configure it, list locked identities, and unlock one.
//!
//! [`request_layer`](super::request_layer) reads the login body to learn
//! which identity it names, refuses a locked identity before the handler
//! runs, and records the outcome: `2xx` clears the count, `401`/`403`
//! counts a failure. Other statuses (bad requests, a sealed vault, quota
//! refusals) do not count.

use axum::body::{Body, Bytes};

use super::*;
use crate::vault::policy_ext::login_lockout::{LockoutConfig, LoginPrincipal};
use crate::vault::VaultError;

/// Largest login body read to find the principal.
const MAX_LOGIN_BODY_BYTES: usize = 256 * 1024;

/// The principal a login body names, if `path` is a machine-login route.
pub(super) fn login_principal(method: &Method, path: &str, body: &[u8]) -> Option<LoginPrincipal> {
    if method != Method::POST {
        return None;
    }
    let value: Value = serde_json::from_slice(body).ok()?;
    let text = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| value.get(*key).and_then(Value::as_str))
            .filter(|text| !text.is_empty() && text.len() <= 256)
            .map(str::to_owned)
    };
    match path {
        "/api/vault/auth/approle/login" | "/v1/auth/approle/login" => {
            text(&["roleId", "role_id"]).map(LoginPrincipal::RoleId)
        }
        "/v1/auth/jwt/login" => text(&["role"]).map(LoginPrincipal::Identity),
        "/api/vault/auth/jwt/login"
        | "/api/vault/auth/cert/login"
        | "/api/vault/auth/aws/login"
        | "/api/vault/auth/kubernetes/login" => text(&["identity"]).map(LoginPrincipal::Identity),
        _ => None,
    }
}

fn is_login_route(method: &Method, path: &str) -> bool {
    method == Method::POST
        && (path.starts_with("/api/vault/auth/") || path.starts_with("/v1/auth/"))
        && path.ends_with("/login")
}

/// The refusal for a locked identity: the same body the route gives a bad
/// credential, so the lock cannot tell a caller which identities exist (only
/// existing identities lock). `Retry-After` is added; the audit log has the
/// reason.
fn locked_response(path: &str, locked_until: i64) -> Response {
    let mut response = if path.starts_with("/v1/") {
        (
            StatusCode::FORBIDDEN,
            Json(json!({ "errors": ["permission denied"] })),
        )
            .into_response()
    } else if path == "/api/vault/auth/approle/login" {
        vault_error(VaultError::Denied("invalid role id or secret id".into()).into())
    } else {
        super::super::vault_api::login_refusal(VaultError::Denied(String::new()).into())
    };
    let retry_after = ((locked_until - crate::vault::now_millis()) / 1000).max(1);
    if let Ok(value) = HeaderValue::from_str(&retry_after.to_string()) {
        response
            .headers_mut()
            .insert(axum::http::header::RETRY_AFTER, value);
    }
    response
}

/// Before a login runs: refuse a locked identity, or hand back the request
/// (its body restored) with the principal to record afterwards.
pub(super) async fn before_login(
    store: &PluginSecretStore,
    request: Request,
) -> Result<(Request, Option<LoginPrincipal>), Response> {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    if !is_login_route(&method, &path) {
        return Ok((request, None));
    }
    let (parts, body) = request.into_parts();
    let bytes: Bytes = axum::body::to_bytes(body, MAX_LOGIN_BODY_BYTES)
        .await
        .map_err(|_| invalid_request("the login request is too large"))?;
    let principal = login_principal(&method, &path, &bytes);
    if let Some(principal) = &principal {
        match store.lockout_check(principal).await {
            Ok(Some(locked)) => return Err(locked_response(&path, locked.locked_until)),
            Ok(None) => {}
            Err(error) => return Err(vault_error(error)),
        }
    }
    Ok((Request::from_parts(parts, Body::from(bytes)), principal))
}

/// After a login ran: count a refused credential, clear on success.
pub(super) async fn after_login(
    store: &PluginSecretStore,
    principal: Option<LoginPrincipal>,
    status: StatusCode,
) {
    let Some(principal) = principal else {
        return;
    };
    let succeeded = status.is_success();
    if !succeeded && status != StatusCode::UNAUTHORIZED && status != StatusCode::FORBIDDEN {
        return;
    }
    if let Err(error) = store.lockout_record(&principal, succeeded).await {
        tracing::warn!(%error, "recording a login outcome for lockout");
    }
}

/// GET /api/vault/sys/lockouts.
#[utoipa::path(get, path = "/api/vault/sys/lockouts", tag = "Vault",
    summary = "List machine identities locked after failed logins, and the lockout settings (admin)",
    responses((status = 200, description = "Locked identities and settings", body = serde_json::Value)))]
pub async fn sys_lockouts(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/lockouts", Capability::Admin));
    let config = match who.store().lockout_config().await {
        Ok(config) => config,
        Err(error) => return vault_error(error),
    };
    match who.store().lockout_list().await {
        Ok(locked) => respond(json!({ "locked": locked, "config": config })),
        Err(error) => vault_error(error),
    }
}

/// PUT /api/vault/sys/lockouts/config.
#[utoipa::path(put, path = "/api/vault/sys/lockouts/config", tag = "Vault",
    summary = "Set the login lockout threshold, window, and duration (admin)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Settings", body = serde_json::Value)))]
pub async fn sys_lockout_config(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Json(body): Json<LockoutConfig>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/lockouts", Capability::Admin));
    ok_or(
        who.store().lockout_set_config(&body, &who.actor()).await,
        "config",
    )
}

/// POST /api/vault/sys/lockouts/{identity}/unlock.
#[utoipa::path(post, path = "/api/vault/sys/lockouts/{identity}/unlock", tag = "Vault",
    summary = "Unlock a machine identity locked after failed logins (admin)",
    params(("identity" = String, Path, description = "Machine identity name")),
    responses((status = 200, description = "Whether it was locked", body = serde_json::Value)))]
pub async fn sys_lockout_unlock(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    Path(identity): Path<String>,
) -> Response {
    let who = who!(human(&state, caller, &headers).await);
    check!(who.require("sys/lockouts", Capability::Admin));
    ok_or(
        who.store().lockout_unlock(&identity, &who.actor()).await,
        "wasLocked",
    )
}

#[cfg(test)]
#[path = "lockout_routes_test.rs"]
mod tests;
