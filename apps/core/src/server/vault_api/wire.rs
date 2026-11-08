//! Wire helpers: timestamps, responses, errors, and request basics.

use super::*;

/// Convert integer `…At` fields (epoch millis) to RFC 3339 strings, recursively.
pub(super) enum TimestampUnit {
    Millis,
    Secs,
}

/// Which wire keys carry an epoch timestamp, and in which unit.
pub(super) fn timestamp_unit(key: &str) -> Option<TimestampUnit> {
    match key {
        // SSH certificate validity is stored as the certificate's own seconds.
        "validAfter" | "validBefore" => Some(TimestampUnit::Secs),
        "at" | "notAfter" | "notBefore" => Some(TimestampUnit::Millis),
        _ if key.ends_with("At") => Some(TimestampUnit::Millis),
        _ => None,
    }
}

pub(crate) fn rfc3339_fields(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    let converted = match (&value, timestamp_unit(&key)) {
                        (Value::Number(number), Some(unit)) => number
                            .as_i64()
                            .and_then(|raw| match unit {
                                TimestampUnit::Millis => {
                                    DateTime::<Utc>::from_timestamp_millis(raw)
                                }
                                TimestampUnit::Secs => DateTime::<Utc>::from_timestamp(raw, 0),
                            })
                            .map_or(value.clone(), |at| Value::String(at.to_rfc3339())),
                        _ => rfc3339_fields(value),
                    };
                    (key, converted)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(rfc3339_fields).collect()),
        other => other,
    }
}

/// Convert RFC 3339 string `…At` fields to epoch millis, recursively (input side).
pub(crate) fn millis_fields(value: Value) -> Result<Value, String> {
    Ok(match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, value) in map {
                let converted = match (&value, key.ends_with("At")) {
                    (Value::String(text), true) => DateTime::parse_from_rfc3339(text)
                        .map(|at| Value::from(at.timestamp_millis()))
                        .map_err(|_| format!("`{key}` must be an RFC 3339 timestamp"))?,
                    _ => millis_fields(value)?,
                };
                out.insert(key, converted);
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(millis_fields)
                .collect::<Result<_, _>>()?,
        ),
        other => other,
    })
}

/// A `no-store` JSON response with timestamps rendered as RFC 3339.
pub(crate) fn respond(value: Value) -> Response {
    no_store_response(Json(rfc3339_fields(value)).into_response())
}

/// Parse a JSON body after converting RFC 3339 timestamps.
pub(crate) fn parse_body<T: serde::de::DeserializeOwned>(body: Value) -> Result<T, Response> {
    let body = millis_fields(body).map_err(|message| invalid_request(&message))?;
    serde_json::from_value(body).map_err(|error| invalid_request(&error.to_string()))
}

pub(crate) fn invalid_request(message: &str) -> Response {
    json_error(
        StatusCode::BAD_REQUEST,
        format!("vault_invalid_request: {message}"),
    )
}

pub(crate) fn denied(capability: Capability, key: &str) -> Response {
    json_error(
        StatusCode::FORBIDDEN,
        format!(
            "vault_denied: the `{}` capability is required on `{key}`",
            capability.as_str()
        ),
    )
}

/// Map a store error onto a stable status and code.
pub(crate) fn vault_error(error: anyhow::Error) -> Response {
    if let Some(vault) = error.downcast_ref::<VaultError>() {
        let status = match vault {
            VaultError::Sealed | VaultError::AuditUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            VaultError::Invalid(_) => StatusCode::BAD_REQUEST,
            VaultError::NotFound(_) => StatusCode::NOT_FOUND,
            VaultError::Conflict(_) => StatusCode::CONFLICT,
            VaultError::Denied(_) => StatusCode::FORBIDDEN,
        };
        return json_error(status, vault.to_string());
    }
    if error.downcast_ref::<rusqlite::Error>().is_some() {
        tracing::warn!("vault storage error: {error:#}");
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "vault_internal: storage error".to_owned(),
        );
    }
    invalid_request(&format!("{error:#}"))
}

/// The one message every refused public identity login carries.
pub(super) const LOGIN_REFUSED: &str = "login rejected";

/// Map the store error of a public native machine login
/// (`/api/vault/auth/{jwt,cert,aws,kubernetes}/login`).
///
/// These routes answer before any authentication, so the error must not tell
/// the caller which identity names exist, how they log in, whether one is
/// disabled, or why a credential failed: every typed refusal is the same 403.
/// The real reason is in the audit log. `Sealed` and `AuditUnavailable` say
/// nothing about the identity and stay 503 so the caller can retry; anything
/// that is not a typed vault refusal (a storage failure) goes through
/// [`vault_error`].
pub(crate) fn login_refusal(error: anyhow::Error) -> Response {
    match error.downcast_ref::<VaultError>() {
        Some(VaultError::Sealed | VaultError::AuditUnavailable) | None => vault_error(error),
        Some(_) => json_error(
            StatusCode::FORBIDDEN,
            VaultError::Denied(LOGIN_REFUSED.to_owned()).to_string(),
        ),
    }
}

/// `{ "token": … }` for a successful public native login, else
/// [`login_refusal`].
pub(crate) fn login_token_response<T: Serialize>(result: anyhow::Result<T>) -> Response {
    match result {
        Ok(token) => respond(json!({ "token": token })),
        Err(error) => login_refusal(error),
    }
}

pub(crate) fn store() -> Result<&'static PluginSecretStore, Response> {
    crate::plugin_secrets::global().ok_or_else(|| {
        json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "vault_unavailable: encrypted secret store is not available".to_owned(),
        )
    })
}

pub(super) fn current_node() -> Option<RegisteredNode> {
    crate::sidecar::control_plane::registered_node()
}

pub(super) fn current_node_id(node: Option<&RegisteredNode>) -> String {
    node.map(|registered| registered.node_id.clone())
        .unwrap_or_else(crate::server::agent_sync::local_node_id)
}

pub(super) fn node_scope_label(node: Option<&RegisteredNode>) -> &'static str {
    match node.map(|registered| registered.scope) {
        Some(NodeScope::Org) => "org",
        Some(NodeScope::Team) => "team",
        Some(NodeScope::Personal) => "personal",
        None => "local",
    }
}

pub(super) fn role_label(role: OrgRole) -> &'static str {
    role.label()
}

/// The raw user JWT on the request (forwarded to the control plane).
///
/// `x-ryu-user-jwt` wins. The bearer is forwarded only when it is the verified
/// user JWT that admitted the request (`bearer_is_user_jwt`, from
/// `resolve_managed_user_jwt`). Every other admitting bearer (the node's owner
/// token, a paired token, a node delegation) is a node-local secret, never a
/// user JWT, so it must not travel upstream as one (for example from the CLI
/// while a forwarding tunnel stops the local Core minting a JWT).
pub(super) fn user_jwt(headers: &HeaderMap, bearer_is_user_jwt: bool) -> Option<String> {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    header("x-ryu-user-jwt").or_else(|| {
        if !bearer_is_user_jwt {
            return None;
        }
        header("authorization").and_then(|value| value.strip_prefix("Bearer ").map(str::to_owned))
    })
}
