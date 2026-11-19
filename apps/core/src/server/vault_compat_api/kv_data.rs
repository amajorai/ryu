//! KV v2 `data/<path>`: read, full-replace write with check-and-set, and soft
//! delete.

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::*;
use crate::plugin_secrets::{
    KvFolderReplace, SecretCoords, VaultSecretInfo, MAX_VAULT_SECRET_VALUE_LEN,
};
use crate::vault::policy::Capability;

pub(super) fn version_metadata(version: i64, created: i64, deleted: Option<i64>) -> Value {
    json!({
        "created_time": rfc3339(created),
        "custom_metadata": null,
        "deletion_time": deleted.map(rfc3339).unwrap_or_default(),
        "destroyed": false,
        "version": version,
    })
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct DataQuery {
    #[serde(default)]
    version: Option<i64>,
}

/// GET /v1/secret/data/{path}.
#[utoipa::path(get, path = "/v1/secret/data/{path}", tag = "Vault",
    operation_id = "vault_compat_kv_read",
    summary = "Read a KV v2 secret (every key, all-or-nothing; current version only)",
    params(("path" = String, Path, description = "Secret path under `secret/`, e.g. `app/db`"),
        ("version" = Option<i64>, Query, description = "Must be 0 or the current version")),
    responses(
        (status = 200, description = "Vault response envelope", body = serde_json::Value),
        (status = 404, description = "No such secret", body = serde_json::Value),
        (status = 400, description = "Invalid request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn read_data(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(path): Path<String>,
    Query(query): Query<DataQuery>,
) -> Response {
    let who = tri!(caller(&state, &headers).await);
    let target = tri!(Target::resolve(&state, &headers, &path, false));
    tri!(target.require_folder(&who, &[Capability::Read]));
    let folder = tri!(target.state(who.store()).await);
    let live: Vec<&VaultSecretInfo> = folder
        .keys
        .iter()
        .filter(|i| i.deleted_at.is_none())
        .collect();
    if live.is_empty() {
        return not_found();
    }
    // All-or-nothing, like a Vault path ACL: returning only the readable keys
    // would let a later full-replace write silently remove the hidden ones.
    for info in &live {
        let key = info.coords().policy_key();
        tri!(require(&who, &key, Capability::Read));
        // Compat tokens cannot open control-group requests; a gated value is
        // refused, as on the native machine read path.
        if who.read_gated(&key) {
            return permission_denied();
        }
    }
    let version = folder.version;
    if query
        .version
        .is_some_and(|wanted| wanted != 0 && wanted != version)
    {
        return errors(
            StatusCode::BAD_REQUEST,
            "only the current version can be read through this API",
        );
    }
    let mut data = Map::new();
    for info in &live {
        match who.store().reveal(&info.coords(), None, &who.actor()).await {
            Ok(value) => {
                data.insert(info.name.clone(), Value::String(value));
            }
            Err(error) => return store_error(&error),
        }
    }
    let created = live.iter().map(|i| i.updated_at).max().unwrap_or(0);
    envelope(
        Some(json!({
            "data": data,
            "metadata": version_metadata(version, created, None),
        })),
        None,
    )
}

#[derive(Debug, Default, Deserialize)]
pub(crate) struct WriteOptions {
    #[serde(default)]
    cas: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct WriteBody {
    data: Map<String, Value>,
    #[serde(default)]
    options: WriteOptions,
}

fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// PUT|POST /v1/secret/data/{path}: replace the secret's key set.
#[utoipa::path(put, path = "/v1/secret/data/{path}", tag = "Vault",
    operation_id = "vault_compat_kv_write",
    summary = "Replace a KV v2 secret's key set (`options.cas` is check-and-set)",
    params(("path" = String, Path, description = "Secret path under `secret/`, e.g. `app/db`")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Vault response envelope", body = serde_json::Value),
        (status = 400, description = "Invalid request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn write_data(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(path): Path<String>,
    body: Bytes,
) -> Response {
    let who = tri!(caller(&state, &headers).await);
    let target = tri!(Target::resolve(&state, &headers, &path, false));
    let body: WriteBody = tri!(parse_json(&body));

    let mut writes: Vec<(SecretCoords, String)> = Vec::with_capacity(body.data.len());
    for (name, value) in &body.data {
        let coords = tri!(target.coords(name));
        let Some(text) = scalar_text(value) else {
            return errors(
                StatusCode::BAD_REQUEST,
                "data values must be strings, numbers, or booleans",
            );
        };
        if text.trim().is_empty() {
            return errors(StatusCode::BAD_REQUEST, "data values must not be empty");
        }
        if text.len() > MAX_VAULT_SECRET_VALUE_LEN {
            return errors(
                StatusCode::BAD_REQUEST,
                "a data value exceeds the maximum size",
            );
        }
        tri!(require(&who, &coords.policy_key(), Capability::Write));
        if who
            .write_parameters_violation(&coords.policy_key(), &text)
            .is_some()
        {
            return permission_denied();
        }
        writes.push((coords, text));
    }
    // Before any lookup (an empty `data` object checks nothing above).
    tri!(target.require_folder(&who, &[Capability::Write]));

    // Authorize implicit removals against a snapshot; the store refuses the
    // replace if a key outside this set is live when it runs.
    let snapshot = tri!(target.state(who.store()).await);
    let mut removals = Vec::new();
    for info in snapshot.keys.iter().filter(|i| i.deleted_at.is_none()) {
        if !body.data.contains_key(&info.name) {
            let coords = info.coords();
            tri!(require(&who, &coords.policy_key(), Capability::Delete));
            removals.push(coords);
        }
    }
    let touched: Vec<SecretCoords> = writes
        .iter()
        .map(|(coords, _)| coords.clone())
        .chain(removals.iter().cloned())
        .collect();
    tri!(target.require_unprotected(&who, &touched).await);

    let actor = who.actor();
    let after = match who
        .store()
        .kv_folder_replace(KvFolderReplace {
            folder: target.kv_folder(),
            writes,
            removable: removals.into_iter().map(|coords| coords.name).collect(),
            cas: body.options.cas,
            actor: &actor,
        })
        .await
    {
        Ok(after) => after,
        Err(error) => return store_error(&error),
    };
    let created = after
        .keys
        .iter()
        .filter(|i| i.deleted_at.is_none())
        .map(|i| i.updated_at)
        .max()
        .unwrap_or_else(|| Utc::now().timestamp_millis());
    envelope(Some(version_metadata(after.version, created, None)), None)
}

/// POST /v1/secret/data/{path}: the same full replace as PUT.
#[utoipa::path(post, path = "/v1/secret/data/{path}", tag = "Vault",
    operation_id = "vault_compat_kv_write_post",
    summary = "Replace a KV v2 secret's key set (POST form of the write)",
    params(("path" = String, Path, description = "Secret path under `secret/`, e.g. `app/db`")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Vault response envelope", body = serde_json::Value),
        (status = 400, description = "Invalid request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn write_data_post(
    state: State<CompatState>,
    headers: HeaderMap,
    path: Path<String>,
    body: Bytes,
) -> Response {
    write_data(state, headers, path, body).await
}

/// DELETE /v1/secret/data/{path}: soft-delete every key (restorable).
#[utoipa::path(delete, path = "/v1/secret/data/{path}", tag = "Vault",
    operation_id = "vault_compat_kv_delete",
    summary = "Soft-delete every key of a KV v2 secret (restorable)",
    params(("path" = String, Path, description = "Secret path under `secret/`, e.g. `app/db`")),
    responses(
        (status = 200, description = "Vault response envelope", body = serde_json::Value),
        (status = 204, description = "Done"),
        (status = 400, description = "Invalid request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn delete_data(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(path): Path<String>,
) -> Response {
    let who = tri!(caller(&state, &headers).await);
    let target = tri!(Target::resolve(&state, &headers, &path, false));
    tri!(target.require_folder(&who, &[Capability::Delete]));
    let folder = tri!(target.state(who.store()).await);
    let coords: Vec<SecretCoords> = folder
        .keys
        .iter()
        .filter(|i| i.deleted_at.is_none())
        .map(VaultSecretInfo::coords)
        .collect();
    for key in &coords {
        tri!(require(&who, &key.policy_key(), Capability::Delete));
    }
    tri!(target.require_unprotected(&who, &coords).await);
    let actor = who.actor();
    for key in coords {
        if let Err(error) = who.store().soft_delete(key, &actor).await {
            return store_error(&error);
        }
    }
    no_content()
}
