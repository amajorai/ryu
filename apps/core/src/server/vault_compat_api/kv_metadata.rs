//! KV v2 `metadata/<path>`: metadata read, listing (`LIST` or `?list=true`),
//! and permanent destroy. Listings page like OpenBao's: `after` returns only
//! keys sorted after it, and `limit` (when positive) caps how many come back.

use std::collections::{BTreeMap, BTreeSet};

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;

use super::*;
use crate::plugin_secrets::kv::ListFilter;
use crate::plugin_secrets::{SecretCoords, VaultSecretInfo};
use crate::server::vault_engines_api::Who;
use crate::vault::policy::Capability;
use crate::vault::ROOT_PATH;

#[derive(Debug, Default, Deserialize)]
pub(crate) struct MetadataQuery {
    #[serde(default)]
    list: Option<String>,
    #[serde(default)]
    after: Option<String>,
    #[serde(default)]
    limit: Option<String>,
}

/// A listing page: keys strictly after `after`, at most `limit` of them.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ListPage {
    pub(crate) after: Option<String>,
    pub(crate) limit: Option<usize>,
}

impl ListPage {
    /// `limit` must be an integer; zero or negative means no limit, as in
    /// OpenBao.
    pub(crate) fn parse(after: Option<String>, limit: Option<&str>) -> Result<Self, Response> {
        let limit = match limit.map(str::trim).filter(|value| !value.is_empty()) {
            None => None,
            Some(text) => {
                let value: i64 = text
                    .parse()
                    .map_err(|_| errors(StatusCode::BAD_REQUEST, "limit must be an integer"))?;
                usize::try_from(value).ok().filter(|limit| *limit > 0)
            }
        };
        Ok(Self {
            after: after.filter(|after| !after.is_empty()),
            limit,
        })
    }

    pub(crate) fn apply(&self, keys: BTreeSet<String>) -> Vec<String> {
        let after = self.after.as_deref();
        let page = keys
            .into_iter()
            .filter(|key| after.is_none_or(|after| key.as_str() > after));
        match self.limit {
            Some(limit) => page.take(limit).collect(),
            None => page.collect(),
        }
    }
}

impl MetadataQuery {
    fn is_list(&self) -> bool {
        self.list
            .as_deref()
            .is_some_and(|value| matches!(value, "true" | "1"))
    }

    fn page(&self) -> Result<ListPage, Response> {
        ListPage::parse(self.after.clone(), self.limit.as_deref())
    }
}

/// Immediate children of `folder` visible to the caller: `name` for a
/// secret (a folder holding keys) and `name/` for a deeper prefix.
async fn list_children(
    state: &CompatState,
    headers: &HeaderMap,
    path: &str,
    query: &MetadataQuery,
) -> Response {
    let who = tri!(caller(state, headers).await);
    let page = tri!(query.page());
    let target = tri!(Target::resolve(state, headers, path, true));
    let items = match who
        .store()
        .list_vault_secrets_filtered(&ListFilter {
            environment: Some(target.environment.clone()),
            path: Some(target.folder.clone()),
            recursive: true,
            include_deleted: false,
        })
        .await
    {
        Ok(items) => items,
        Err(error) => return store_error(&error),
    };
    let prefix = if target.folder == ROOT_PATH {
        "/".to_owned()
    } else {
        format!("{}/", target.folder)
    };
    let mut keys = BTreeSet::new();
    for info in items.iter().filter(|info| target.owns(info)) {
        if !who
            .sys_caps(&info.coords().policy_key())
            .contains(&Capability::List)
        {
            continue;
        }
        let Some(rest) = info.path.strip_prefix(&prefix) else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        match rest.split_once('/') {
            Some((head, _)) => keys.insert(format!("{head}/")),
            None => keys.insert(rest.to_owned()),
        };
    }
    let keys = page.apply(keys);
    if keys.is_empty() {
        return not_found();
    }
    envelope(Some(json!({ "keys": keys })), None)
}

async fn read_metadata(who: &Who, target: &Target) -> Response {
    const METADATA: [Capability; 2] = [Capability::List, Capability::Read];
    tri!(target.require_folder(who, &METADATA));
    let folder = tri!(target.state(who.store()).await);
    let all = &folder.keys;
    if all.is_empty() {
        return not_found();
    }
    if !all
        .iter()
        .all(|info| holds_any(who, &info.coords().policy_key(), &METADATA))
    {
        return permission_denied();
    }
    let version = folder.version;
    let created = all.iter().map(|i| i.created_at).min().unwrap_or(0);
    let updated = all.iter().map(|i| i.updated_at).max().unwrap_or(0);
    let deleted = if all.iter().all(|i| i.deleted_at.is_some()) {
        all.iter().filter_map(|i| i.deleted_at).max()
    } else {
        None
    };
    let mut versions = BTreeMap::new();
    versions.insert(
        version.to_string(),
        json!({
            "created_time": rfc3339(updated),
            "deletion_time": deleted.map(rfc3339).unwrap_or_default(),
            "destroyed": false,
        }),
    );
    envelope(
        Some(json!({
            "cas_required": false,
            "created_time": rfc3339(created),
            "current_version": version,
            "custom_metadata": null,
            "delete_version_after": "0s",
            "max_versions": 0,
            "oldest_version": 0,
            "updated_time": rfc3339(updated),
            "versions": versions,
        })),
        None,
    )
}

/// GET /v1/secret/metadata/{path} (`?list=true` lists).
#[utoipa::path(get, path = "/v1/secret/metadata/{path}", tag = "Vault",
    operation_id = "vault_compat_kv_metadata",
    summary = "Read KV v2 metadata, or list children with `?list=true` (also the `LIST` verb)",
    params(("path" = String, Path, description = "Secret path under `secret/`, e.g. `app/db`"),
        ("list" = Option<bool>, Query, description = "List the path's children instead"),
        ("after" = Option<String>, Query, description = "List only keys sorted after this one"),
        ("limit" = Option<i64>, Query, description = "Return at most this many keys (zero or less: no limit)")),
    responses(
        (status = 200, description = "Vault response envelope", body = serde_json::Value),
        (status = 404, description = "No such secret", body = serde_json::Value),
        (status = 400, description = "Invalid request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn get_metadata(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(path): Path<String>,
    Query(query): Query<MetadataQuery>,
) -> Response {
    if query.is_list() {
        return list_children(&state, &headers, &path, &query).await;
    }
    let who = tri!(caller(&state, &headers).await);
    let target = tri!(Target::resolve(&state, &headers, &path, false));
    read_metadata(&who, &target).await
}

/// GET /v1/secret/metadata?list=true (root listing).
#[utoipa::path(get, path = "/v1/secret/metadata", tag = "Vault",
    operation_id = "vault_compat_kv_list_root",
    summary = "List the top-level KV v2 paths (`?list=true`, or the `LIST` verb)",
    params(("list" = Option<bool>, Query, description = "Must be true"),
        ("after" = Option<String>, Query, description = "List only keys sorted after this one"),
        ("limit" = Option<i64>, Query, description = "Return at most this many keys (zero or less: no limit)")),
    responses(
        (status = 200, description = "Vault response envelope", body = serde_json::Value),
        (status = 404, description = "No such secret", body = serde_json::Value),
        (status = 400, description = "Invalid request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn get_metadata_root(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Query(query): Query<MetadataQuery>,
) -> Response {
    if query.is_list() {
        return list_children(&state, &headers, "", &query).await;
    }
    errors(StatusCode::METHOD_NOT_ALLOWED, "unsupported operation")
}

/// DELETE /v1/secret/metadata/{path}: permanently destroy every key and its
/// history.
#[utoipa::path(delete, path = "/v1/secret/metadata/{path}", tag = "Vault",
    operation_id = "vault_compat_kv_destroy",
    summary = "Permanently destroy every key of a KV v2 secret and its history",
    params(("path" = String, Path, description = "Secret path under `secret/`, e.g. `app/db`")),
    responses(
        (status = 200, description = "Vault response envelope", body = serde_json::Value),
        (status = 204, description = "Done"),
        (status = 400, description = "Invalid request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn delete_metadata(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(path): Path<String>,
) -> Response {
    let who = tri!(caller(&state, &headers).await);
    let target = tri!(Target::resolve(&state, &headers, &path, false));
    tri!(target.require_folder(&who, &[Capability::Delete]));
    let folder = tri!(target.state(who.store()).await);
    let coords: Vec<SecretCoords> = folder.keys.iter().map(VaultSecretInfo::coords).collect();
    for key in &coords {
        tri!(require(&who, &key.policy_key(), Capability::Delete));
    }
    tri!(target.require_unprotected(&who, &coords).await);
    let actor = who.actor();
    for key in coords {
        if let Err(error) = who.store().destroy(key, None, &actor).await {
            return store_error(&error);
        }
    }
    if let Err(error) = who.store().kv_folder_forget(&target.kv_folder()).await {
        return store_error(&error);
    }
    no_content()
}

/// The `LIST` verb (and anything else unrouted) on a metadata path.
pub(crate) async fn metadata_other(
    State(state): State<CompatState>,
    method: Method,
    headers: HeaderMap,
    path: Option<Path<String>>,
    Query(query): Query<MetadataQuery>,
) -> Response {
    if method.as_str() == "LIST" {
        let path = path.map(|Path(path)| path).unwrap_or_default();
        return list_children(&state, &headers, &path, &query).await;
    }
    errors(StatusCode::METHOD_NOT_ALLOWED, "unsupported operation")
}

pub(crate) async fn method_not_allowed() -> Response {
    errors(StatusCode::METHOD_NOT_ALLOWED, "unsupported operation")
}
