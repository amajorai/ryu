//! External-store input validation.

use super::*;

/// Store names: `^[a-z0-9][a-z0-9_-]{0,63}$`.
pub fn is_valid_store_name(name: &str) -> bool {
    crate::vault::transit::is_valid_key_name(name)
}

pub(super) fn invalid(message: impl Into<String>) -> anyhow::Error {
    VaultError::Invalid(message.into()).into()
}

pub(super) fn bounded(value: Option<String>, field: &str) -> Result<Option<String>> {
    match value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
        Some(v) if v.len() > MAX_FIELD_LEN || v.chars().any(char::is_control) => {
            Err(invalid(format!("`{field}` is invalid")))
        }
        other => Ok(other),
    }
}

/// Normalize a remote path (`a/b`), validating every segment.
pub(super) fn normalize_remote(value: &str) -> Result<String> {
    client::join_remote_path(&[value])
        .map(|segments| segments.join("/"))
        .map_err(|error| invalid(error.to_string()))
}

pub(super) fn validate_store(input: StoreInput) -> Result<(StoreRecord, StoreCredentials)> {
    if !is_valid_store_name(&input.name) {
        return Err(invalid("invalid store name"));
    }
    let sync_target = input.kind.is_sync_target();
    let options = if sync_target {
        targets::prepare_options(input.kind, input.options).map_err(|e| invalid(e.to_string()))?
    } else {
        TargetOptions::default()
    };
    let address_text = match input.address.trim() {
        "" if sync_target => targets::default_address(input.kind, &options),
        text => text.to_owned(),
    };
    if address_text.len() > MAX_ADDRESS_LEN {
        return Err(invalid("address is too long"));
    }
    let address = net::validate_address(&address_text, net::Egress::from_env())
        .map_err(|error| invalid(error.to_string()))?;
    let infisical = input.kind == StoreKind::Infisical;
    let allowed = match input.kind {
        StoreKind::Infisical => matches!(
            input.auth_method,
            AuthMethod::Token | AuthMethod::UniversalAuth
        ),
        StoreKind::Openbao | StoreKind::HashicorpVault => matches!(
            input.auth_method,
            AuthMethod::Token | AuthMethod::Approle | AuthMethod::Kubernetes
        ),
        StoreKind::GithubActions | StoreKind::Vercel => input.auth_method == AuthMethod::Token,
        StoreKind::AwsSecretsManager => input.auth_method == AuthMethod::AccessKey,
        StoreKind::GcpSecretManager => matches!(
            input.auth_method,
            AuthMethod::Token | AuthMethod::ServiceAccount
        ),
    };
    if !allowed {
        return Err(invalid(format!(
            "{} does not support {} auth",
            input.kind.as_str(),
            input.auth_method.as_str()
        )));
    }
    let credentials = input.credentials;
    let complete = match input.auth_method {
        AuthMethod::Token => filled(&credentials.token),
        AuthMethod::Approle => filled(&credentials.role_id) && filled(&credentials.secret_id),
        AuthMethod::UniversalAuth => {
            filled(&credentials.client_id) && filled(&credentials.client_secret)
        }
        AuthMethod::Kubernetes => filled(&input.role),
        AuthMethod::AccessKey => {
            filled(&credentials.access_key_id) && filled(&credentials.secret_access_key)
        }
        AuthMethod::ServiceAccount => filled(&credentials.service_account_key),
    };
    if !complete {
        return Err(invalid(format!(
            "{} auth is missing its credentials",
            input.auth_method.as_str()
        )));
    }
    if input.auth_method == AuthMethod::ServiceAccount {
        targets::gcp::ServiceAccountKey::parse(
            credentials
                .service_account_key
                .as_deref()
                .unwrap_or_default(),
        )
        .map_err(|error| invalid(error.to_string()))?;
    }
    if filled(&input.jwt_path) {
        return Err(invalid(format!(
            "`jwtPath` is not accepted; set {} on the Core host instead",
            client::ENV_K8S_JWT_PATH
        )));
    }
    if input.auth_method == AuthMethod::Kubernetes {
        k8s_origin::check(&address).map_err(|error| invalid(error.to_string()))?;
    }
    let namespace = bounded(input.namespace, "namespace")?;
    if let Some(ns) = &namespace {
        normalize_remote(ns)?;
    }
    let auth_mount = bounded(input.auth_mount, "authMount")?
        .map(|mount| normalize_remote(&mount))
        .transpose()?;
    let kv_version = input.kv_version.unwrap_or(2);
    if !matches!(kv_version, 1 | 2) {
        return Err(invalid("`kvVersion` must be 1 or 2"));
    }
    let mount = if sync_target {
        String::new()
    } else {
        normalize_remote(input.mount.as_deref().unwrap_or("secret"))?
    };
    if !infisical && !sync_target && mount.is_empty() {
        return Err(invalid("`mount` is required"));
    }
    let project_id = bounded(input.project_id, "projectId")?.unwrap_or_default();
    let infisical_environment =
        bounded(input.infisical_environment, "infisicalEnvironment")?.unwrap_or_default();
    if infisical && (project_id.is_empty() || infisical_environment.is_empty()) {
        return Err(invalid(
            "Infisical stores need `projectId` and `infisicalEnvironment`",
        ));
    }
    let path_prefix = normalize_remote(input.path_prefix.as_deref().unwrap_or(""))?;
    if sync_target {
        targets::check_project(input.kind, &project_id).map_err(|e| invalid(e.to_string()))?;
        if !path_prefix.is_empty() && input.kind != StoreKind::AwsSecretsManager {
            return Err(invalid(format!(
                "{} stores take no `pathPrefix`; use the destination's `remotePath`",
                input.kind.as_str()
            )));
        }
    }
    let now = now_millis();
    Ok((
        StoreRecord {
            id: format!("xs_{}", uuid::Uuid::new_v4().simple()),
            name: input.name,
            kind: input.kind,
            address: address.as_str().trim_end_matches('/').to_owned(),
            namespace,
            auth_method: input.auth_method,
            auth_mount,
            role: bounded(input.role, "role")?,
            mount,
            path_prefix,
            kv_version,
            project_id,
            infisical_environment,
            secret_path: normalize_remote(input.secret_path.as_deref().unwrap_or("/"))?,
            options,
            created_at: now,
            updated_at: now,
        },
        credentials,
    ))
}

pub(super) fn folder(environment: &str, path: &str) -> Result<(String, String)> {
    if !is_valid_environment(environment) {
        return Err(invalid("invalid environment"));
    }
    let path = normalize_path(path).ok_or_else(|| invalid("invalid folder path"))?;
    Ok((environment.to_owned(), path))
}

pub(super) fn in_range(
    value: Option<i64>,
    default: i64,
    min: i64,
    max: i64,
    field: &str,
) -> Result<i64> {
    let value = value.unwrap_or(default);
    if value < min || value > max {
        return Err(invalid(format!(
            "`{field}` must be between {min} and {max}"
        )));
    }
    Ok(value)
}
