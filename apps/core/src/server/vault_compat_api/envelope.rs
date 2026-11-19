//! Vault response envelope (`{"errors": [...]}` and the success shape) and
//! caller resolution from `X-Vault-Token` / `Authorization: Bearer`.

use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use super::{CompatState, VAULT_COMPAT_TOKEN_HEADER};
use crate::server::no_store_response;
use crate::server::vault_engines_api::{machine_who, Who};
use crate::vault::policy::Capability;
use crate::vault::VaultError;

pub(super) fn errors(status: StatusCode, message: &str) -> Response {
    let list: Vec<&str> = if message.is_empty() {
        Vec::new()
    } else {
        vec![message]
    };
    no_store_response((status, Json(json!({ "errors": list }))).into_response())
}

pub(super) fn permission_denied() -> Response {
    errors(StatusCode::FORBIDDEN, "permission denied")
}

pub(super) fn not_found() -> Response {
    errors(StatusCode::NOT_FOUND, "")
}

pub(super) fn no_content() -> Response {
    no_store_response(StatusCode::NO_CONTENT.into_response())
}

/// Map a store error. Denials are generic so login failures do not reveal
/// which credential part was wrong; storage errors are not echoed.
pub(super) fn store_error(error: &anyhow::Error) -> Response {
    if let Some(vault) = error.downcast_ref::<VaultError>() {
        return match vault {
            VaultError::Sealed => errors(StatusCode::SERVICE_UNAVAILABLE, "Vault is sealed"),
            VaultError::AuditUnavailable => {
                errors(StatusCode::SERVICE_UNAVAILABLE, "audit unavailable")
            }
            VaultError::Invalid(message) | VaultError::Conflict(message) => {
                errors(StatusCode::BAD_REQUEST, message)
            }
            VaultError::NotFound(_) => not_found(),
            VaultError::Denied(_) => permission_denied(),
        };
    }
    if error.downcast_ref::<rusqlite::Error>().is_some() {
        tracing::warn!("vault compat storage error: {error:#}");
        return errors(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    }
    // Validation failures from the store (names, paths, sizes); top-level
    // message only, which never carries a value.
    errors(StatusCode::BAD_REQUEST, &error.to_string())
}

pub(super) fn rfc3339(millis: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(millis)
        .map(|at| at.to_rfc3339())
        .unwrap_or_default()
}

/// A Vault success envelope around `data` and/or `auth`.
pub(super) fn envelope(data: Option<Value>, auth: Option<Value>) -> Response {
    no_store_response(
        Json(json!({
            "request_id": uuid::Uuid::new_v4().to_string(),
            "lease_id": "",
            "renewable": false,
            "lease_duration": 0,
            "data": data,
            "wrap_info": null,
            "warnings": null,
            "auth": auth,
        }))
        .into_response(),
    )
}

pub(super) fn parse_json<T: serde::de::DeserializeOwned>(body: &Bytes) -> Result<T, Response> {
    let raw: &[u8] = if body.is_empty() { b"{}" } else { body };
    serde_json::from_slice(raw)
        .map_err(|_| errors(StatusCode::BAD_REQUEST, "failed to parse JSON input"))
}

pub(super) fn presented_token(headers: &HeaderMap) -> Option<String> {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    header(VAULT_COMPAT_TOKEN_HEADER).or_else(|| {
        header("authorization").and_then(|value| {
            value
                .strip_prefix("Bearer ")
                .map(|token| token.trim().to_owned())
        })
    })
}

pub(super) async fn caller(state: &CompatState, headers: &HeaderMap) -> Result<Who, Response> {
    let store = state.store()?;
    let Some(token) = presented_token(headers) else {
        return Err(permission_denied());
    };
    let principal = match store.token_lookup(&token).await {
        Ok(Some(principal)) => principal,
        Ok(None) => return Err(permission_denied()),
        Err(error) => return Err(store_error(&error)),
    };
    machine_who(store, principal)
        .await
        .map_err(|_| errors(StatusCode::INTERNAL_SERVER_ERROR, "internal error"))
}

pub(super) fn require(who: &Who, key: &str, capability: Capability) -> Result<(), Response> {
    who.require(key, capability)
        .map_err(|_| permission_denied())
}

/// Whether the caller holds any of `capabilities` on `key`.
pub(super) fn holds_any(who: &Who, key: &str, capabilities: &[Capability]) -> bool {
    let caps = who.sys_caps(key);
    capabilities
        .iter()
        .any(|capability| caps.contains(capability))
}
