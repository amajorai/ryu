//! `/v1/auth/token/*`: the presented token's own lifecycle (`lookup-self`,
//! `renew-self`, `revoke-self`) and child tokens (`create`).
//!
//! Each route calls the store method its native machine route calls
//! (`/api/vault/agent/self/{lookup,renew,revoke,child}`) with the same
//! principal, so policy narrowing, TTL caps, token roles, and audit are the
//! native ones.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};

use super::*;
use crate::plugin_secrets::PluginSecretStore;
use crate::server::vault_engines_api::Who;
use crate::vault::machine::IssuedToken;
use crate::vault::tokens::{TokenInfo, TokenRequest};

/// Parse a Vault duration: whole seconds as a number or numeric string, or a
/// Go-style duration of `s`, `m`, `h`, and `d` parts such as `90s`, `1h30m`,
/// or `7d`. `None` for anything else (negative, fractional, overflowing).
pub(super) fn duration_secs(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().filter(|secs| *secs >= 0),
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                return None;
            }
            if let Ok(secs) = text.parse::<i64>() {
                return (secs >= 0).then_some(secs);
            }
            let mut total: i64 = 0;
            let mut digits = String::new();
            for ch in text.chars() {
                if ch.is_ascii_digit() {
                    digits.push(ch);
                    continue;
                }
                let unit = match ch {
                    's' => 1,
                    'm' => 60,
                    'h' => 3_600,
                    'd' => 86_400,
                    _ => return None,
                };
                let amount: i64 = digits.parse().ok()?;
                total = total.checked_add(amount.checked_mul(unit)?)?;
                digits.clear();
            }
            digits.is_empty().then_some(total)
        }
        _ => None,
    }
}

/// An optional duration field; `0` means "the default", as in Vault.
fn duration_field(value: Option<&Value>, name: &str) -> Result<Option<i64>, Response> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => match duration_secs(value) {
            Some(0) => Ok(None),
            Some(secs) => Ok(Some(secs)),
            None => Err(errors(
                StatusCode::BAD_REQUEST,
                &format!("invalid {name}: use seconds or a duration such as 1h"),
            )),
        },
    }
}

/// The `auth` block for a token, from its stored lifecycle record.
pub(super) fn auth_block(client_token: &str, info: &TokenInfo) -> Value {
    json!({
        "client_token": client_token,
        "accessor": info.accessor,
        "policies": info.policies,
        "token_policies": info.policies,
        "identity_policies": [],
        "metadata": { "identity_id": info.identity_id },
        "lease_duration": info.ttl_secs,
        "renewable": info.renewable,
        "entity_id": info.identity_id,
        "token_type": "service",
        "orphan": info.orphan,
        "num_uses": info.num_uses_remaining.unwrap_or(0),
    })
}

/// The `auth` block for a token issued without a readable record: the token
/// was issued and audited, so it is still returned, with Vault's
/// conservative defaults for the flags that could not be read.
fn fallback_auth(token: &IssuedToken) -> Value {
    let ttl = ((token.expires_at - Utc::now().timestamp_millis()) / 1000).max(0);
    json!({
        "client_token": token.token,
        "accessor": token.accessor,
        "policies": token.policies,
        "token_policies": token.policies,
        "identity_policies": [],
        "metadata": { "identity_id": token.identity_id },
        "lease_duration": ttl,
        "renewable": false,
        "entity_id": token.identity_id,
        "token_type": "service",
        "orphan": true,
        "num_uses": 0,
    })
}

/// The envelope for a freshly issued token (login or `create`).
pub(super) async fn issued(store: &PluginSecretStore, token: IssuedToken) -> Response {
    let auth = match store.token_info(&token.accessor).await {
        Ok(info) => auth_block(&token.token, &info),
        Err(error) => {
            tracing::warn!("vault compat: issued token record unreadable: {error:#}");
            fallback_auth(&token)
        }
    };
    envelope(None, Some(auth))
}

/// GET|POST /v1/auth/token/lookup-self.
#[utoipa::path(get, path = "/v1/auth/token/lookup-self", tag = "Vault",
    operation_id = "vault_compat_token_lookup_self",
    summary = "Look up the presented token (Vault-compatible; never echoes the token)",
    responses(
        (status = 200, description = "Token metadata", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn lookup_self(State(state): State<CompatState>, headers: HeaderMap) -> Response {
    let who = tri!(caller(&state, &headers).await);
    let Who::Machine {
        store, principal, ..
    } = &who
    else {
        return permission_denied();
    };
    let info = match store.token_info(&principal.accessor).await {
        Ok(info) => info,
        Err(error) => return store_error(&error),
    };
    let explicit_max_ttl = info
        .max_expires_at
        .map_or(0, |max| ((max - info.created_at) / 1000).max(0));
    envelope(
        Some(json!({
            "accessor": principal.accessor,
            "creation_time": info.created_at / 1000,
            "display_name": principal.identity_name,
            "entity_id": principal.identity_id,
            "expire_time": rfc3339(principal.expires_at),
            "explicit_max_ttl": explicit_max_ttl,
            "issue_time": rfc3339(info.created_at),
            "num_uses": info.num_uses_remaining.unwrap_or(0),
            "orphan": info.orphan,
            "period": info.period_secs,
            "policies": principal.policies,
            "renewable": info.renewable,
            "ttl": info.ttl_secs,
            "type": "service",
        })),
        None,
    )
}

/// POST /v1/auth/token/lookup-self (the same lookup; Vault accepts both verbs).
#[utoipa::path(post, path = "/v1/auth/token/lookup-self", tag = "Vault",
    operation_id = "vault_compat_token_lookup_self_post",
    summary = "Look up the presented token (POST form of `lookup-self`)",
    responses(
        (status = 200, description = "Token metadata", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn lookup_self_post(state: State<CompatState>, headers: HeaderMap) -> Response {
    lookup_self(state, headers).await
}

/// POST /v1/auth/token/revoke-self.
#[utoipa::path(post, path = "/v1/auth/token/revoke-self", tag = "Vault",
    operation_id = "vault_compat_token_revoke_self",
    summary = "Revoke the presented token and its children (Vault-compatible)",
    responses(
        (status = 204, description = "Revoked"),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn revoke_self(State(state): State<CompatState>, headers: HeaderMap) -> Response {
    let who = tri!(caller(&state, &headers).await);
    let Who::Machine {
        store, principal, ..
    } = &who
    else {
        return permission_denied();
    };
    match store
        .token_revoke(&principal.accessor, &principal.actor())
        .await
    {
        Ok(()) => no_content(),
        Err(error) => store_error(&error),
    }
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct RenewSelfBody {
    #[serde(default)]
    increment: Option<Value>,
}

/// POST /v1/auth/token/renew-self.
#[utoipa::path(post, path = "/v1/auth/token/renew-self", tag = "Vault",
    operation_id = "vault_compat_token_renew_self",
    summary = "Renew the presented token by `increment` (default: its TTL), up to its max TTL",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Renewed token (`auth` block)", body = serde_json::Value),
        (status = 400, description = "Invalid increment or expired token", body = serde_json::Value),
        (status = 403, description = "permission denied, or the token is not renewable", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn renew_self(
    State(state): State<CompatState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let who = tri!(caller(&state, &headers).await);
    let Who::Machine {
        store, principal, ..
    } = &who
    else {
        return permission_denied();
    };
    let body: RenewSelfBody = tri!(parse_json(&body));
    let increment = tri!(duration_field(body.increment.as_ref(), "increment"));
    let token = presented_token(&headers).unwrap_or_default();
    match store
        .token_renew(&principal.accessor, increment, &principal.actor())
        .await
    {
        Ok(info) => envelope(None, Some(auth_block(&token, &info))),
        Err(error) => store_error(&error),
    }
}

/// The Vault `auth/token/create` fields this surface honours. `meta`,
/// `display_name`, and `no_default_policy` are accepted and ignored (Ryu has
/// no default policy); a custom `id` and batch tokens are refused.
#[derive(Debug, Default, Deserialize)]
pub(crate) struct TokenCreateBody {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    policies: Option<Value>,
    #[serde(default)]
    ttl: Option<Value>,
    #[serde(default)]
    explicit_max_ttl: Option<Value>,
    #[serde(default)]
    period: Option<Value>,
    #[serde(default)]
    num_uses: Option<i64>,
    #[serde(default)]
    renewable: Option<bool>,
    #[serde(default)]
    no_parent: Option<bool>,
    #[serde(default, rename = "type")]
    token_type: Option<String>,
}

fn policy_list(value: Option<&Value>) -> Result<Option<Vec<String>>, Response> {
    let invalid = || errors(StatusCode::BAD_REQUEST, "policies must be a list of names");
    let names: Vec<String> = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(list)) => list.split(',').map(|n| n.trim().to_owned()).collect(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(|n| n.trim().to_owned()))
            .collect::<Option<_>>()
            .ok_or_else(invalid)?,
        Some(_) => return Err(invalid()),
    };
    let names: Vec<String> = names.into_iter().filter(|n| !n.is_empty()).collect();
    Ok((!names.is_empty()).then_some(names))
}

/// The native child-token request for a Vault `create` body.
pub(super) fn token_request(
    body: TokenCreateBody,
    role: Option<String>,
) -> Result<TokenRequest, Response> {
    if body.id.as_deref().is_some_and(|id| !id.is_empty()) {
        return Err(errors(
            StatusCode::BAD_REQUEST,
            "custom token ids are not supported",
        ));
    }
    if body
        .token_type
        .as_deref()
        .is_some_and(|kind| !matches!(kind, "" | "service" | "default"))
    {
        return Err(errors(
            StatusCode::BAD_REQUEST,
            "only service tokens are supported",
        ));
    }
    let num_uses = match body.num_uses {
        Some(uses) if uses < 0 => {
            return Err(errors(
                StatusCode::BAD_REQUEST,
                "num_uses must not be negative",
            ))
        }
        Some(0) | None => None,
        uses => uses,
    };
    Ok(TokenRequest {
        role: role.filter(|name| !name.is_empty()),
        policies: policy_list(body.policies.as_ref())?,
        ttl_secs: duration_field(body.ttl.as_ref(), "ttl")?,
        explicit_max_ttl_secs: duration_field(body.explicit_max_ttl.as_ref(), "explicit_max_ttl")?,
        period_secs: duration_field(body.period.as_ref(), "period")?,
        num_uses,
        bound_cidrs: None,
        orphan: body.no_parent.filter(|orphan| *orphan),
        renewable: body.renewable,
    })
}

async fn create(
    state: &CompatState,
    headers: &HeaderMap,
    role: Option<String>,
    body: &Bytes,
) -> Response {
    let who = tri!(caller(state, headers).await);
    let Who::Machine {
        store, principal, ..
    } = &who
    else {
        return permission_denied();
    };
    let body: TokenCreateBody = tri!(parse_json(body));
    let request = tri!(token_request(body, role));
    match store
        .token_create_child(
            &principal.accessor,
            &principal.policies,
            &principal.identity_id,
            request,
            &principal.actor(),
        )
        .await
    {
        Ok(token) => issued(store, token).await,
        Err(error) => store_error(&error),
    }
}

/// POST /v1/auth/token/create.
#[utoipa::path(post, path = "/v1/auth/token/create", tag = "Vault",
    operation_id = "vault_compat_token_create",
    summary = "Create a child of the presented token (policy subset, TTL capped by the parent)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "New token (`auth` block, shown once)", body = serde_json::Value),
        (status = 400, description = "Invalid or unsupported request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn token_create(
    State(state): State<CompatState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    create(&state, &headers, None, &body).await
}

/// POST /v1/auth/token/create/{role_name}.
#[utoipa::path(post, path = "/v1/auth/token/create/{role_name}", tag = "Vault",
    operation_id = "vault_compat_token_create_role",
    summary = "Create a child token from a token role (needs use on sys/token-roles/<name>)",
    params(("role_name" = String, Path, description = "Token role name")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "New token (`auth` block, shown once)", body = serde_json::Value),
        (status = 400, description = "Invalid or unsupported request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn token_create_role(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(role): Path<String>,
    body: Bytes,
) -> Response {
    create(&state, &headers, Some(role), &body).await
}
