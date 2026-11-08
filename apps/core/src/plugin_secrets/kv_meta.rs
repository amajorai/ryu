//! KV v2 metadata parity for vault values (HashiCorp Vault / OpenBao).
//!
//! [`super::kv`] owns writes, reads, and resolution. This module adds the
//! KV v2 metadata surface on top of the same rows:
//!
//! * a JSON merge patch (RFC 7386) of a value's metadata that does not write a
//!   new value version, guarded by the `metadataVersion` check-and-set counter;
//! * a JSON merge patch of a value whose content is a JSON object, written as
//!   a new version under value check-and-set;
//! * `subkeys`: the shape of a JSON-object value with `null` leaves (refused
//!   for a sealed value, whose key names are part of its plaintext);
//! * per-version soft delete and undelete (destroy stays in `kv`);
//! * `deleteVersionAfterSecs` enforcement for the scheduler;
//! * keyset-paginated, authorization-filtered listing.
//!
//! Every mutation and every decrypting read is audited without the value.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rusqlite::{params, params_from_iter, Connection};
use serde_json::{json, Value};

use super::kv::{
    actor_id, environment_cas_required, find_row, info_from_row, prune_versions, store_metadata,
    ListFilter, SecretMetadataPatch, SecretVersionInfo, WriteRequest, INFO_COLUMNS,
    MAX_MAX_VERSIONS,
};
use super::{PluginSecretStore, SecretCoords, SecretMetadata, VaultSecretInfo, VersionSource};
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::{normalize_path, now_millis, VaultError, ROOT_PATH};

/// Default and maximum page size for a paginated listing.
pub const DEFAULT_PAGE_LIMIT: usize = 200;
pub const MAX_PAGE_LIMIT: usize = 1000;
/// Rows read per scan step while filling a page.
const SCAN_BATCH: usize = 256;
/// Column order of the listing's keyset (matches the row's unique key).
const KEYSET: &str = "environment, path, name, scope, scope_id, binding_kind, binding_id";

/// One page of a listing. `next_after` is the cursor of the last returned
/// row when more visible rows follow.
#[derive(Debug, Clone, Default)]
pub struct SecretPage {
    pub secrets: Vec<VaultSecretInfo>,
    /// Row ids parallel to `secrets`, for batched follow-up reads such as
    /// [`PluginSecretStore::versions_for_page`].
    pub ids: Vec<String>,
    pub next_after: Option<String>,
}

/// Apply an RFC 7386 JSON merge patch onto `target`.
pub fn merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(fields) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(serde_json::Map::new());
    }
    let Some(object) = target.as_object_mut() else {
        return;
    };
    for (key, value) in fields {
        if value.is_null() {
            object.remove(key);
        } else {
            merge_patch(object.entry(key.clone()).or_insert(Value::Null), value);
        }
    }
}

/// The shape of a JSON object with `null` leaves. Arrays are leaves.
/// `max_depth == 0` is unlimited.
pub fn subkeys_of(value: &Value, max_depth: usize) -> Value {
    fn shape(value: &Value, max_depth: usize, depth: usize) -> Value {
        let Value::Object(map) = value else {
            return Value::Null;
        };
        Value::Object(
            map.iter()
                .map(|(key, child)| {
                    let nested = child.is_object() && (max_depth == 0 || depth < max_depth);
                    let leaf = if nested {
                        shape(child, max_depth, depth + 1)
                    } else {
                        Value::Null
                    };
                    (key.clone(), leaf)
                })
                .collect(),
        )
    }
    shape(value, max_depth, 1)
}

/// The keyset position of one row.
type CursorKey = [String; 7];

fn encode_cursor(key: &CursorKey) -> String {
    URL_SAFE_NO_PAD.encode(key.join("\n"))
}

fn decode_cursor(cursor: &str) -> Result<CursorKey> {
    let invalid = || VaultError::Invalid("`after` is not a cursor returned by this listing".into());
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor.trim())
        .map_err(|_| invalid())?;
    let text = String::from_utf8(bytes).map_err(|_| invalid())?;
    let parts: Vec<String> = text.split('\n').map(str::to_owned).collect();
    CursorKey::try_from(parts).map_err(|_| invalid().into())
}

fn cursor_of(info: &VaultSecretInfo) -> CursorKey {
    let coords = info.coords();
    let (binding_kind, binding_id) = coords.binding_parts();
    [
        info.environment.clone(),
        info.path.clone(),
        info.name.clone(),
        info.scope.as_str().to_owned(),
        info.scope_id.clone(),
        binding_kind.to_owned(),
        binding_id.to_owned(),
    ]
}

/// One keyset scan step: up to `limit` rows after `cursor`, with the raw key
/// of every row read (rows from a newer binary parse to `None` but still
/// advance the cursor).
fn scan_step(
    conn: &Connection,
    filter: &ListFilter,
    path: Option<&str>,
    cursor: Option<&CursorKey>,
    limit: usize,
) -> Result<Vec<(CursorKey, Option<(String, VaultSecretInfo)>)>> {
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();
    fn bind(values: &mut Vec<rusqlite::types::Value>, value: String) -> String {
        values.push(value.into());
        format!("?{}", values.len())
    }
    if !filter.include_deleted {
        conditions.push("deleted_at IS NULL".into());
    }
    if let Some(environment) = &filter.environment {
        let slot = bind(&mut values, environment.clone());
        conditions.push(format!("environment = {slot}"));
    }
    match path {
        Some(path) if filter.recursive && path == ROOT_PATH => {}
        Some(path) if filter.recursive => {
            let exact = bind(&mut values, path.to_owned());
            let prefix = bind(&mut values, format!("{path}/"));
            conditions.push(format!(
                "(path = {exact} OR substr(path, 1, length({prefix})) = {prefix})"
            ));
        }
        Some(path) => {
            let slot = bind(&mut values, path.to_owned());
            conditions.push(format!("path = {slot}"));
        }
        None => {}
    }
    if let Some(cursor) = cursor {
        let slots: Vec<String> = cursor
            .iter()
            .map(|part| bind(&mut values, part.clone()))
            .collect();
        conditions.push(format!("({KEYSET}) > ({})", slots.join(", ")));
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let sql = format!(
        "SELECT {INFO_COLUMNS} FROM vault_secrets {where_clause} ORDER BY {KEYSET} LIMIT {limit}"
    );
    let mut stmt = conn.prepare(&sql).context("preparing vault page")?;
    let rows = stmt.query_map(params_from_iter(values), |row| {
        let key: CursorKey = [
            row.get(3)?,
            row.get(4)?,
            row.get(7)?,
            row.get(1)?,
            row.get(2)?,
            row.get(5)?,
            row.get(6)?,
        ];
        Ok((key, info_from_row(row)?))
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("reading vault page")
}

impl PluginSecretStore {
    // ── Listing ───────────────────────────────────────────────────────────

    /// One page of metadata in stable `(environment, path, name, scope,
    /// scope_id, binding)` order. `allow` is the caller's authorization filter;
    /// pages are filled with allowed rows only, so a cursor never names a
    /// value the caller may not list. With `filter.recursive`, this is the
    /// KV v2 SCAN over a folder tree.
    pub async fn list_secrets_page(
        &self,
        filter: &ListFilter,
        after: Option<&str>,
        limit: usize,
        allow: impl Fn(&VaultSecretInfo) -> bool,
    ) -> Result<SecretPage> {
        let limit = limit.clamp(1, MAX_PAGE_LIMIT);
        let path = match &filter.path {
            Some(path) => Some(normalize_path(path).ok_or_else(|| anyhow!("invalid folder path"))?),
            None => None,
        };
        let mut cursor = after.map(decode_cursor).transpose()?;
        let mut secrets: Vec<VaultSecretInfo> = Vec::new();
        let mut ids: Vec<String> = Vec::new();
        loop {
            let batch = {
                let conn = self.conn.lock().await;
                scan_step(&conn, filter, path.as_deref(), cursor.as_ref(), SCAN_BATCH)?
            };
            let exhausted = batch.len() < SCAN_BATCH;
            for (key, info) in batch {
                cursor = Some(key);
                let Some((id, info)) = info.filter(|(_, info)| allow(info)) else {
                    continue;
                };
                if secrets.len() == limit {
                    let next_after = secrets.last().map(|last| encode_cursor(&cursor_of(last)));
                    return Ok(SecretPage {
                        secrets,
                        ids,
                        next_after,
                    });
                }
                secrets.push(info);
                ids.push(id);
            }
            if exhausted {
                return Ok(SecretPage {
                    secrets,
                    ids,
                    next_after: None,
                });
            }
        }
    }

    /// Version summaries for every row of a page, in one query. Rows without
    /// versions map to an empty list.
    pub async fn versions_for_page(
        &self,
        ids: &[String],
    ) -> Result<BTreeMap<String, Vec<SecretVersionInfo>>> {
        let mut out: BTreeMap<String, Vec<SecretVersionInfo>> =
            ids.iter().map(|id| (id.clone(), Vec::new())).collect();
        if ids.is_empty() {
            return Ok(out);
        }
        let slots: Vec<String> = (1..=ids.len()).map(|slot| format!("?{slot}")).collect();
        let sql = format!(
            "SELECT v.secret_id, v.version, v.created_at, v.created_by, v.source, v.destroyed,
                    v.deleted_at, s.version
             FROM vault_secret_versions v JOIN vault_secrets s ON s.id = v.secret_id
             WHERE v.secret_id IN ({})
             ORDER BY v.secret_id, v.version DESC",
            slots.join(", ")
        );
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(&sql)
            .context("preparing vault page versions")?;
        let rows = stmt.query_map(params_from_iter(ids.iter()), |row| {
            let version: i64 = row.get(1)?;
            Ok((
                row.get::<_, String>(0)?,
                SecretVersionInfo {
                    version,
                    created_at: row.get(2)?,
                    created_by: row.get(3)?,
                    source: row.get(4)?,
                    destroyed: row.get::<_, i64>(5)? != 0,
                    current: version == row.get::<_, i64>(7)?,
                    deleted_at: row.get(6)?,
                },
            ))
        })?;
        for row in rows {
            let (id, version) = row.context("reading vault page versions")?;
            out.entry(id).or_default().push(version);
        }
        Ok(out)
    }

    // ── Metadata ──────────────────────────────────────────────────────────

    /// Apply a JSON merge patch to a value's metadata without writing a new
    /// value version. `customMetadata` merges key by key (`null` removes a
    /// key); other fields replace, and `null` resets a field to its default.
    /// An unchanged result does not bump `metadataVersion`.
    pub async fn patch_metadata(
        &self,
        coords: SecretCoords,
        patch: &Value,
        expected_metadata_version: Option<i64>,
        actor: &AuditActor,
    ) -> Result<VaultSecretInfo> {
        let coords = coords.normalize()?;
        let Value::Object(fields) = patch else {
            return Err(
                VaultError::Invalid("the metadata patch must be a JSON object".into()).into(),
            );
        };
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let Some((id, info)) = find_row(&tx, &coords)? else {
            return Err(VaultError::NotFound("secret".into()).into());
        };
        if info.deleted_at.is_some() {
            return Err(VaultError::NotFound("secret is deleted".into()).into());
        }
        if let Some(expected) = expected_metadata_version {
            if expected != info.metadata_version {
                return Err(VaultError::Conflict(format!(
                    "the secret metadata is at version {}, not {expected}",
                    info.metadata_version
                ))
                .into());
            }
        }
        let mut merged = serde_json::to_value(&info.metadata)?;
        if let Some(unknown) = fields.keys().find(|key| merged.get(key.as_str()).is_none()) {
            return Err(VaultError::Invalid(format!("unknown metadata field `{unknown}`")).into());
        }
        merge_patch(&mut merged, patch);
        let parsed: SecretMetadata = serde_json::from_value(merged)
            .map_err(|error| VaultError::Invalid(format!("metadata: {error}")))?;
        // Re-apply as a full patch so trimming, de-duplication, and
        // validation match a PUT.
        let metadata = SecretMetadataPatch::from_metadata(&parsed)
            .apply(&info.metadata)
            .map_err(|error| VaultError::Invalid(format!("{error:#}")))?;
        if metadata == info.metadata {
            return Ok(info);
        }
        let next = info.metadata_version + 1;
        store_metadata(&tx, &id, &metadata, next)?;
        // A lower `maxVersions` prunes at once, as a metadata-only PUT does.
        prune_versions(&tx, &id, info.version, metadata.max_versions)?;
        tx.execute(
            "UPDATE vault_secrets SET updated_at = ?1, updated_by = ?2 WHERE id = ?3",
            params![now_millis(), actor_id(actor), id],
        )?;
        let changed: Vec<&String> = fields.keys().collect();
        self.audit_locked(
            &tx,
            &coords.audit(
                AuditEntry::new(actor, "secret.metadata", "ok").details(json!({
                    "metadataVersion": next,
                    "fields": changed,
                    "patch": "merge",
                })),
            ),
        );
        let info = find_row(&tx, &coords)?
            .map(|(_, info)| info)
            .ok_or_else(|| anyhow!("vault metadata patch did not persist"))?;
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(info)
    }
}

mod json_values;
mod versions;

#[cfg(test)]
mod json_values_tests;
#[cfg(test)]
mod listing_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod versions_tests;
