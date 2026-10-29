//! KV v2 metadata parity for vault values (HashiCorp Vault / OpenBao).
//!
//! [`super::kv`] owns writes, reads, and resolution. This module adds the
//! KV v2 metadata surface on top of the same rows:
//!
//! * a JSON merge patch (RFC 7386) of a value's metadata that does not write a
//!   new value version, guarded by the `metadataVersion` check-and-set counter;
//! * a JSON merge patch of a value whose content is a JSON object, written as
//!   a new version under value check-and-set;
//! * `subkeys`: the shape of a JSON-object value with `null` leaves;
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

    // ── JSON values ───────────────────────────────────────────────────────

    /// Decrypt the current value of a live row as a JSON object.
    fn current_object(&self, conn: &Connection, id: &str) -> Result<Value> {
        let (key_version, nonce, ciphertext): (u32, Vec<u8>, Vec<u8>) = conn.query_row(
            "SELECT key_version, nonce, ciphertext FROM vault_secrets WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let plain = self.open_row(key_version, &nonce, &ciphertext)?;
        // The parse error is not surfaced: it could quote part of the value.
        match serde_json::from_slice::<Value>(&plain) {
            Ok(document @ Value::Object(_)) => Ok(document),
            _ => Err(VaultError::Invalid("the stored value is not a JSON object".into()).into()),
        }
    }

    /// Merge-patch a JSON-object value and write the result as a new version.
    /// The caller never sees the stored value. The write carries the version
    /// that was patched, so a concurrent writer causes a conflict rather than
    /// a lost update.
    pub async fn patch_value(
        &self,
        coords: SecretCoords,
        patch: &Value,
        expected_version: Option<i64>,
        actor: &AuditActor,
    ) -> Result<VaultSecretInfo> {
        self.patch_value_checked(coords, patch, expected_version, actor, |_| Ok(()))
            .await
    }

    /// [`Self::patch_value`] that runs `check` on the merged value before it
    /// is written; an `Err` refuses the write as `vault_denied`. The write is
    /// pinned to the patched version, so `check` sees exactly what commits.
    pub async fn patch_value_checked(
        &self,
        coords: SecretCoords,
        patch: &Value,
        expected_version: Option<i64>,
        actor: &AuditActor,
        check: impl FnOnce(&str) -> std::result::Result<(), String>,
    ) -> Result<VaultSecretInfo> {
        let coords = coords.normalize()?;
        if !patch.is_object() {
            return Err(VaultError::Invalid("the value patch must be a JSON object".into()).into());
        }
        let (version, mut document) = {
            let conn = self.conn.lock().await;
            let Some((id, info)) = find_row(&conn, &coords)? else {
                return Err(VaultError::NotFound("secret".into()).into());
            };
            if info.deleted_at.is_some() {
                return Err(VaultError::NotFound("secret is deleted".into()).into());
            }
            // The write below always carries the version read here, so the
            // `casRequired` gate in `write_secret` cannot see a missing
            // `expectedVersion`; enforce it before reading.
            if expected_version.is_none()
                && (info.metadata.cas_required
                    || environment_cas_required(&conn, &coords.environment)?)
            {
                return Err(VaultError::Invalid(
                    "check-and-set is required here: pass expectedVersion".into(),
                )
                .into());
            }
            if let Some(expected) = expected_version.filter(|expected| *expected != info.version) {
                return Err(VaultError::Conflict(format!(
                    "the secret is at version {}, not {expected}",
                    info.version
                ))
                .into());
            }
            (info.version, self.current_object(&conn, &id)?)
        };
        merge_patch(&mut document, patch);
        let value = serde_json::to_string(&document)?;
        check(&value).map_err(VaultError::Denied)?;
        self.write_secret(WriteRequest {
            coords,
            value: Some(&value),
            patch: SecretMetadataPatch::default(),
            actor,
            source: VersionSource::Write,
            expected_version: Some(version),
        })
        .await
    }

    /// The key structure of a JSON-object value with `null` leaves, and the
    /// version it was read from. Audited as `secret.subkeys`.
    pub async fn subkeys(
        &self,
        coords: &SecretCoords,
        max_depth: usize,
        actor: &AuditActor,
    ) -> Result<(i64, Value)> {
        let coords = coords.clone().normalize()?;
        let conn = self.conn.lock().await;
        let Some((id, info)) = find_row(&conn, &coords)? else {
            return Err(VaultError::NotFound("secret".into()).into());
        };
        if info.deleted_at.is_some() {
            return Err(VaultError::NotFound("secret is deleted".into()).into());
        }
        let shape = subkeys_of(&self.current_object(&conn, &id)?, max_depth);
        self.audit_locked(
            &conn,
            &coords.audit(
                AuditEntry::new(actor, "secret.subkeys", "ok")
                    .details(json!({ "version": info.version, "depth": max_depth })),
            ),
        );
        Ok((info.version, shape))
    }

    // ── Per-version soft delete ───────────────────────────────────────────

    /// Soft-delete chosen non-current versions: they stop being revealable or
    /// usable as a rollback source until undeleted. Returns the versions that
    /// changed (already deleted, destroyed, and unknown versions are skipped).
    pub async fn delete_versions(
        &self,
        coords: SecretCoords,
        versions: &[i64],
        actor: &AuditActor,
    ) -> Result<Vec<i64>> {
        self.set_versions_deleted(coords, versions, true, actor)
            .await
    }

    /// Undo [`Self::delete_versions`]. Destroyed versions cannot be undeleted.
    pub async fn undelete_versions(
        &self,
        coords: SecretCoords,
        versions: &[i64],
        actor: &AuditActor,
    ) -> Result<Vec<i64>> {
        self.set_versions_deleted(coords, versions, false, actor)
            .await
    }

    async fn set_versions_deleted(
        &self,
        coords: SecretCoords,
        versions: &[i64],
        deleted: bool,
        actor: &AuditActor,
    ) -> Result<Vec<i64>> {
        let coords = coords.normalize()?;
        let wanted: BTreeSet<i64> = versions.iter().copied().collect();
        if wanted.is_empty() || wanted.len() > MAX_MAX_VERSIONS as usize {
            return Err(VaultError::Invalid(format!(
                "versions must list 1 to {MAX_MAX_VERSIONS} version numbers"
            ))
            .into());
        }
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let Some((id, info)) = find_row(&tx, &coords)? else {
            return Err(VaultError::NotFound("secret".into()).into());
        };
        if deleted && wanted.contains(&info.version) {
            return Err(VaultError::Invalid(
                "the current version cannot be deleted; delete the secret or write a new value first"
                    .into(),
            )
            .into());
        }
        let now = now_millis();
        let by = actor_id(actor);
        let mut changed = Vec::new();
        for version in wanted {
            let count = if deleted {
                tx.execute(
                    "UPDATE vault_secret_versions SET deleted_at = ?1, deleted_by = ?2
                     WHERE secret_id = ?3 AND version = ?4 AND deleted_at IS NULL
                       AND destroyed = 0",
                    params![now, by, id, version],
                )?
            } else {
                tx.execute(
                    "UPDATE vault_secret_versions SET deleted_at = NULL, deleted_by = NULL
                     WHERE secret_id = ?1 AND version = ?2 AND deleted_at IS NOT NULL
                       AND destroyed = 0",
                    params![id, version],
                )?
            };
            if count > 0 {
                changed.push(version);
            }
        }
        let action = if deleted {
            "secret.version.delete"
        } else {
            "secret.version.undelete"
        };
        self.audit_locked(
            &tx,
            &coords.audit(AuditEntry::new(actor, action, "ok").details(json!({
                "versions": changed,
            }))),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(changed)
    }

    /// Soft-delete non-current versions older than their value's
    /// `deleteVersionAfterSecs`. Called by the vault scheduler; needs no key
    /// material. Returns the number of versions deleted.
    pub async fn enforce_delete_version_after(&self) -> Result<usize> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let due: Vec<(String, i64)> = {
            let mut stmt = tx.prepare(
                "SELECT v.secret_id, v.version FROM vault_secret_versions v
                 JOIN vault_secrets s ON s.id = v.secret_id
                 WHERE s.delete_version_after_secs IS NOT NULL AND v.version != s.version
                   AND v.deleted_at IS NULL AND v.destroyed = 0
                   AND v.created_at + s.delete_version_after_secs * 1000 <= ?1
                 ORDER BY v.secret_id, v.version",
            )?;
            let rows = stmt.query_map(params![now], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut by_secret: BTreeMap<String, Vec<i64>> = BTreeMap::new();
        for (id, version) in due {
            by_secret.entry(id).or_default().push(version);
        }
        let system = AuditActor::system();
        let by = actor_id(&system);
        let mut total = 0;
        for (id, versions) in by_secret {
            for version in &versions {
                total += tx.execute(
                    "UPDATE vault_secret_versions SET deleted_at = ?1, deleted_by = ?2
                     WHERE secret_id = ?3 AND version = ?4 AND deleted_at IS NULL",
                    params![now, by, id, version],
                )?;
            }
            let info = tx
                .query_row(
                    &format!("SELECT {INFO_COLUMNS} FROM vault_secrets WHERE id = ?1"),
                    params![id],
                    info_from_row,
                )?
                .map(|(_, info)| info);
            let entry = AuditEntry::new(&system, "secret.version.delete", "ok").details(json!({
                "versions": versions,
                "reason": "deleteVersionAfter",
            }));
            let entry = match &info {
                Some(info) => info.coords().audit(entry),
                None => entry,
            };
            self.audit_locked(&tx, &entry);
        }
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_secrets::kv::{Environment, WriteOptions};
    use crate::plugin_secrets::SecretScope;

    fn actor() -> AuditActor {
        AuditActor::new("user", Some("u1"))
    }

    fn coords(env: &str, path: &str, name: &str) -> SecretCoords {
        SecretCoords {
            scope: SecretScope::Node,
            scope_id: "node-1".into(),
            environment: env.into(),
            path: path.into(),
            binding: None,
            name: name.into(),
        }
    }

    fn request<'a>(
        coords: SecretCoords,
        value: Option<&'a str>,
        patch: SecretMetadataPatch,
        actor: &'a AuditActor,
        expected_version: Option<i64>,
    ) -> WriteRequest<'a> {
        WriteRequest {
            coords,
            value,
            patch,
            actor,
            source: VersionSource::Write,
            expected_version,
        }
    }

    async fn write(
        store: &PluginSecretStore,
        coords: SecretCoords,
        value: &str,
    ) -> VaultSecretInfo {
        store
            .write_secret(request(
                coords,
                Some(value),
                SecretMetadataPatch::default(),
                &actor(),
                None,
            ))
            .await
            .unwrap()
    }

    fn code(error: &anyhow::Error) -> String {
        error
            .downcast_ref::<VaultError>()
            .map(|error| error.to_string())
            .unwrap_or_else(|| format!("{error:#}"))
    }

    async fn audit_actions(store: &PluginSecretStore) -> (Vec<String>, String) {
        let conn = store.conn.lock().await;
        let rows = crate::vault::audit::list(
            &conn,
            &crate::vault::audit::AuditFilter {
                limit: 100,
                ..Default::default()
            },
        )
        .unwrap();
        (
            rows.iter().map(|row| row.action.clone()).collect(),
            serde_json::to_string(&rows).unwrap(),
        )
    }

    #[test]
    fn merge_patch_follows_rfc_7386() {
        let mut target = json!({ "a": "b", "c": { "d": "e", "f": "g" } });
        merge_patch(&mut target, &json!({ "a": "z", "c": { "f": null } }));
        assert_eq!(target, json!({ "a": "z", "c": { "d": "e" } }));
        let mut scalar = json!("text");
        merge_patch(&mut scalar, &json!({ "a": { "b": null, "c": 1 } }));
        assert_eq!(scalar, json!({ "a": { "c": 1 } }));
        let mut array = json!({ "a": [1, 2] });
        merge_patch(&mut array, &json!({ "a": [3] }));
        assert_eq!(array, json!({ "a": [3] }));
    }

    #[test]
    fn subkeys_replace_leaves_with_null_and_honor_depth() {
        let value =
            json!({ "user": "x", "db": { "host": "h", "tls": { "ca": "c" } }, "ports": [1] });
        assert_eq!(
            subkeys_of(&value, 0),
            json!({ "user": null, "db": { "host": null, "tls": { "ca": null } }, "ports": null })
        );
        assert_eq!(
            subkeys_of(&value, 1),
            json!({ "user": null, "db": null, "ports": null })
        );
    }

    #[tokio::test]
    async fn custom_metadata_is_validated_and_persisted() {
        let store = PluginSecretStore::in_memory().unwrap();
        let c = coords("default", "/", "API_KEY");
        let mut custom = BTreeMap::new();
        custom.insert("owner".to_owned(), "payments".to_owned());
        let info = store
            .write_secret(request(
                c.clone(),
                Some("v"),
                SecretMetadataPatch {
                    custom_metadata: Some(custom.clone()),
                    ..Default::default()
                },
                &actor(),
                None,
            ))
            .await
            .unwrap();
        assert_eq!(info.metadata.custom_metadata, custom);
        assert_eq!(info.metadata_version, 1);
        let reread = store.secret_info(&c).await.unwrap().unwrap();
        assert_eq!(reread.metadata.custom_metadata, custom);

        let too_many: BTreeMap<String, String> = (0..65)
            .map(|index| (format!("k{index}"), "v".to_owned()))
            .collect();
        let long_value: BTreeMap<String, String> =
            [("k".to_owned(), "x".repeat(513))].into_iter().collect();
        let long_key: BTreeMap<String, String> =
            [("k".repeat(129), "v".to_owned())].into_iter().collect();
        for bad in [too_many, long_value, long_key] {
            let error = store
                .write_secret(request(
                    c.clone(),
                    None,
                    SecretMetadataPatch {
                        custom_metadata: Some(bad),
                        ..Default::default()
                    },
                    &actor(),
                    None,
                ))
                .await
                .unwrap_err();
            assert!(code(&error).contains("customMetadata"), "{error:#}");
        }
        let bad_after = SecretMetadataPatch {
            delete_version_after_secs: Some(Some(5)),
            ..Default::default()
        };
        assert!(bad_after.apply(&SecretMetadata::default()).is_err());
    }

    #[tokio::test]
    async fn metadata_merge_patch_does_not_write_a_version_and_honors_metadata_cas() {
        let store = PluginSecretStore::in_memory().unwrap();
        let c = coords("default", "/", "API_KEY");
        write(&store, c.clone(), "secret-value").await;
        let patched = store
            .patch_metadata(
                c.clone(),
                &json!({ "customMetadata": { "owner": "ops", "tier": "1" }, "description": " db " }),
                Some(1),
                &actor(),
            )
            .await
            .unwrap();
        assert_eq!(patched.version, 1);
        assert_eq!(patched.metadata_version, 2);
        assert_eq!(patched.metadata.description, "db");
        let patched = store
            .patch_metadata(
                c.clone(),
                &json!({ "customMetadata": { "tier": null, "team": "core" } }),
                None,
                &actor(),
            )
            .await
            .unwrap();
        assert_eq!(
            patched
                .metadata
                .custom_metadata
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["owner".to_owned(), "team".to_owned()]
        );
        assert_eq!(patched.metadata_version, 3);

        // A no-op patch keeps the counter.
        let same = store
            .patch_metadata(c.clone(), &json!({ "description": "db" }), None, &actor())
            .await
            .unwrap();
        assert_eq!(same.metadata_version, 3);

        // Stale metadata CAS, unknown fields, and invalid values are refused.
        let stale = store
            .patch_metadata(c.clone(), &json!({ "description": "x" }), Some(1), &actor())
            .await
            .unwrap_err();
        assert!(code(&stale).starts_with("vault_conflict"), "{stale:#}");
        let unknown = store
            .patch_metadata(c.clone(), &json!({ "nope": 1 }), None, &actor())
            .await
            .unwrap_err();
        assert!(code(&unknown).contains("unknown metadata field"));
        let invalid = store
            .patch_metadata(c.clone(), &json!({ "maxVersions": 0 }), None, &actor())
            .await
            .unwrap_err();
        assert!(code(&invalid).starts_with("vault_invalid"), "{invalid:#}");
        assert!(store
            .patch_metadata(c.clone(), &json!(["x"]), None, &actor())
            .await
            .is_err());
        assert!(store
            .patch_metadata(
                coords("default", "/", "MISSING"),
                &json!({}),
                None,
                &actor()
            )
            .await
            .is_err());

        // The PUT path honors metadata CAS too.
        let stale_put = store
            .write_secret_with(
                request(
                    c.clone(),
                    None,
                    SecretMetadataPatch {
                        description: Some("new".into()),
                        ..Default::default()
                    },
                    &actor(),
                    None,
                ),
                WriteOptions {
                    expected_metadata_version: Some(2),
                },
            )
            .await
            .unwrap_err();
        assert!(code(&stale_put).starts_with("vault_conflict"));
        let put = store
            .write_secret_with(
                request(
                    c.clone(),
                    None,
                    SecretMetadataPatch {
                        description: Some("new".into()),
                        ..Default::default()
                    },
                    &actor(),
                    None,
                ),
                WriteOptions {
                    expected_metadata_version: Some(3),
                },
            )
            .await
            .unwrap();
        assert_eq!((put.version, put.metadata_version), (1, 4));
        let (actions, serialized) = audit_actions(&store).await;
        assert!(actions.iter().any(|action| action == "secret.metadata"));
        assert!(!serialized.contains("secret-value"));
    }

    #[tokio::test]
    async fn cas_required_rejects_unguarded_value_writes() {
        let store = PluginSecretStore::in_memory().unwrap();
        let c = coords("default", "/", "API_KEY");
        store
            .write_secret(request(
                c.clone(),
                Some("one"),
                SecretMetadataPatch {
                    cas_required: Some(true),
                    ..Default::default()
                },
                &actor(),
                None,
            ))
            .await
            .unwrap();
        let unguarded = store
            .write_secret(request(
                c.clone(),
                Some("two"),
                SecretMetadataPatch::default(),
                &actor(),
                None,
            ))
            .await
            .unwrap_err();
        assert!(code(&unguarded).contains("check-and-set"), "{unguarded:#}");
        let guarded = store
            .write_secret(request(
                c.clone(),
                Some("two"),
                SecretMetadataPatch::default(),
                &actor(),
                Some(1),
            ))
            .await
            .unwrap();
        assert_eq!(guarded.version, 2);
        // Metadata-only writes and system sources (rollback) are not value
        // writes by a caller and stay allowed.
        store
            .write_secret(request(
                c.clone(),
                None,
                SecretMetadataPatch {
                    description: Some("d".into()),
                    ..Default::default()
                },
                &actor(),
                None,
            ))
            .await
            .unwrap();
        assert_eq!(
            store
                .rollback(c.clone(), 1, &actor())
                .await
                .unwrap()
                .version,
            3
        );

        // Environment-level casRequired covers creates as well.
        store
            .put_environment(
                &Environment {
                    slug: "prod".into(),
                    name: "Production".into(),
                    protected: false,
                    required_approvals: 1,
                    position: 1,
                    cas_required: true,
                },
                &actor(),
            )
            .await
            .unwrap();
        assert!(
            store
                .environment("prod")
                .await
                .unwrap()
                .unwrap()
                .cas_required
        );
        let p = coords("prod", "/", "DB_URL");
        let create = store
            .write_secret(request(
                p.clone(),
                Some("x"),
                SecretMetadataPatch::default(),
                &actor(),
                None,
            ))
            .await
            .unwrap_err();
        assert!(code(&create).contains("check-and-set"));
        let created = store
            .write_secret(request(
                p.clone(),
                Some("x"),
                SecretMetadataPatch::default(),
                &actor(),
                Some(0),
            ))
            .await
            .unwrap();
        assert_eq!(created.version, 1);
        assert!(store
            .write_secret(request(
                p,
                Some("y"),
                SecretMetadataPatch::default(),
                &actor(),
                Some(0),
            ))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn per_version_soft_delete_hides_versions_until_undeleted() {
        let store = PluginSecretStore::in_memory().unwrap();
        let c = coords("default", "/", "API_KEY");
        write(&store, c.clone(), "one").await;
        write(&store, c.clone(), "two").await;
        write(&store, c.clone(), "three").await;

        let current = store
            .delete_versions(c.clone(), &[3], &actor())
            .await
            .unwrap_err();
        assert!(code(&current).contains("current version"));
        assert_eq!(
            store
                .delete_versions(c.clone(), &[1, 2, 2, 9], &actor())
                .await
                .unwrap(),
            vec![1, 2]
        );
        // Idempotent.
        assert!(store
            .delete_versions(c.clone(), &[1], &actor())
            .await
            .unwrap()
            .is_empty());
        let versions = store.list_versions(&c).await.unwrap();
        assert!(versions[0].deleted_at.is_none());
        assert!(versions[1].deleted_at.is_some() && versions[2].deleted_at.is_some());
        assert!(store.reveal(&c, Some(1), &actor()).await.is_err());
        assert!(store.rollback(c.clone(), 2, &actor()).await.is_err());
        // The current value keeps resolving.
        assert_eq!(store.reveal(&c, None, &actor()).await.unwrap(), "three");

        store
            .destroy(c.clone(), Some(&[1]), &actor())
            .await
            .unwrap();
        assert_eq!(
            store
                .undelete_versions(c.clone(), &[1, 2], &actor())
                .await
                .unwrap(),
            vec![2]
        );
        assert_eq!(store.reveal(&c, Some(2), &actor()).await.unwrap(), "two");
        assert!(store
            .delete_versions(c.clone(), &[], &actor())
            .await
            .is_err());
        let (actions, serialized) = audit_actions(&store).await;
        assert!(actions
            .iter()
            .any(|action| action == "secret.version.delete"));
        assert!(actions
            .iter()
            .any(|action| action == "secret.version.undelete"));
        assert!(!serialized.contains("\"two\""));
    }

    #[tokio::test]
    async fn delete_version_after_soft_deletes_old_non_current_versions() {
        let store = PluginSecretStore::in_memory().unwrap();
        let c = coords("default", "/", "API_KEY");
        let keep = coords("default", "/", "UNLIMITED");
        store
            .write_secret(request(
                c.clone(),
                Some("one"),
                SecretMetadataPatch {
                    delete_version_after_secs: Some(Some(3600)),
                    ..Default::default()
                },
                &actor(),
                None,
            ))
            .await
            .unwrap();
        write(&store, c.clone(), "two").await;
        write(&store, c.clone(), "three").await;
        write(&store, keep.clone(), "a").await;
        write(&store, keep.clone(), "b").await;
        assert_eq!(store.enforce_delete_version_after().await.unwrap(), 0);
        {
            let conn = store.conn.lock().await;
            conn.execute("UPDATE vault_secret_versions SET created_at = 0", [])
                .unwrap();
        }
        assert_eq!(store.enforce_delete_version_after().await.unwrap(), 2);
        assert_eq!(store.enforce_delete_version_after().await.unwrap(), 0);
        let versions = store.list_versions(&c).await.unwrap();
        assert_eq!(
            versions
                .iter()
                .map(|v| (v.version, v.deleted_at.is_some()))
                .collect::<Vec<_>>(),
            vec![(3, false), (2, true), (1, true)]
        );
        assert!(store
            .list_versions(&keep)
            .await
            .unwrap()
            .iter()
            .all(|v| v.deleted_at.is_none()));
        assert_eq!(store.reveal(&c, None, &actor()).await.unwrap(), "three");
        let report = crate::vault::scheduler::tick(&store, false).await;
        assert_eq!(report.versions_deleted, 0);
    }

    #[tokio::test]
    async fn json_values_merge_patch_under_cas_and_expose_subkeys_without_values() {
        let store = PluginSecretStore::in_memory().unwrap();
        let c = coords("default", "/", "DB");
        write(
            &store,
            c.clone(),
            r#"{"user":"app","password":"hunter2","tls":{"ca":"pem"}}"#,
        )
        .await;
        let patched = store
            .patch_value(
                c.clone(),
                &json!({ "password": "rotated", "tls": null, "port": 5432 }),
                Some(1),
                &actor(),
            )
            .await
            .unwrap();
        assert_eq!(patched.version, 2);
        let value: Value =
            serde_json::from_str(&store.reveal(&c, None, &actor()).await.unwrap()).unwrap();
        assert_eq!(
            value,
            json!({ "user": "app", "password": "rotated", "port": 5432 })
        );
        let stale = store
            .patch_value(c.clone(), &json!({ "a": 1 }), Some(1), &actor())
            .await
            .unwrap_err();
        assert!(code(&stale).starts_with("vault_conflict"));
        assert!(store
            .patch_value(c.clone(), &json!("x"), None, &actor())
            .await
            .is_err());

        let (version, shape) = store.subkeys(&c, 0, &actor()).await.unwrap();
        assert_eq!(version, 2);
        assert_eq!(
            shape,
            json!({ "user": null, "password": null, "port": null })
        );

        let plain = coords("default", "/", "PLAIN");
        write(&store, plain.clone(), "not-json-hunter3").await;
        let not_object = store.subkeys(&plain, 0, &actor()).await.unwrap_err();
        assert!(code(&not_object).contains("not a JSON object"));
        assert!(!code(&not_object).contains("hunter3"));
        assert!(store
            .patch_value(plain, &json!({ "a": 1 }), None, &actor())
            .await
            .is_err());

        let (actions, serialized) = audit_actions(&store).await;
        assert!(actions.iter().any(|action| action == "secret.subkeys"));
        assert!(!serialized.contains("rotated") && !serialized.contains("hunter"));
    }

    #[tokio::test]
    async fn value_patch_honors_cas_required_on_the_value_and_environment() {
        let store = PluginSecretStore::in_memory().unwrap();
        let c = coords("default", "/", "DB");
        store
            .write_secret(request(
                c.clone(),
                Some(r#"{"user":"app"}"#),
                SecretMetadataPatch {
                    cas_required: Some(true),
                    ..Default::default()
                },
                &actor(),
                None,
            ))
            .await
            .unwrap();
        let unguarded = store
            .patch_value(c.clone(), &json!({ "user": "x" }), None, &actor())
            .await
            .unwrap_err();
        assert!(code(&unguarded).contains("check-and-set"), "{unguarded:#}");
        let guarded = store
            .patch_value(c.clone(), &json!({ "user": "x" }), Some(1), &actor())
            .await
            .unwrap();
        assert_eq!(guarded.version, 2);

        store
            .put_environment(
                &Environment {
                    slug: "prod".into(),
                    name: "Production".into(),
                    protected: false,
                    required_approvals: 1,
                    position: 1,
                    cas_required: true,
                },
                &actor(),
            )
            .await
            .unwrap();
        let p = coords("prod", "/", "DB");
        store
            .write_secret(request(
                p.clone(),
                Some(r#"{"user":"app"}"#),
                SecretMetadataPatch::default(),
                &actor(),
                Some(0),
            ))
            .await
            .unwrap();
        let unguarded = store
            .patch_value(p.clone(), &json!({ "user": "x" }), None, &actor())
            .await
            .unwrap_err();
        assert!(code(&unguarded).contains("check-and-set"), "{unguarded:#}");
        assert_eq!(
            store
                .patch_value(p, &json!({ "user": "x" }), Some(1), &actor())
                .await
                .unwrap()
                .version,
            2
        );
    }

    #[tokio::test]
    async fn metadata_patch_prunes_versions_and_refuses_deleted_values() {
        let store = PluginSecretStore::in_memory().unwrap();
        let c = coords("default", "/", "API_KEY");
        for value in ["one", "two", "three", "four"] {
            write(&store, c.clone(), value).await;
        }
        assert_eq!(store.list_versions(&c).await.unwrap().len(), 4);
        store
            .patch_metadata(c.clone(), &json!({ "maxVersions": 2 }), None, &actor())
            .await
            .unwrap();
        let kept: Vec<i64> = store
            .list_versions(&c)
            .await
            .unwrap()
            .iter()
            .map(|version| version.version)
            .collect();
        assert_eq!(kept, vec![4, 3]);
        assert!(store.reveal(&c, Some(1), &actor()).await.is_err());

        store.soft_delete(c.clone(), &actor()).await.unwrap();
        let deleted = store
            .patch_metadata(c.clone(), &json!({ "description": "x" }), None, &actor())
            .await
            .unwrap_err();
        assert!(code(&deleted).starts_with("vault_not_found"), "{deleted:#}");
    }

    #[tokio::test]
    async fn paginated_listing_is_stable_filtered_and_never_leaks_hidden_names() {
        let store = PluginSecretStore::in_memory().unwrap();
        for (env, path, name) in [
            ("default", "/", "A"),
            ("default", "/", "B"),
            ("default", "/app", "C"),
            ("default", "/app/db", "D"),
            ("default", "/apples", "E"),
            ("prod", "/", "A"),
            ("default", "/", "HIDDEN"),
        ] {
            write(&store, coords(env, path, name), "v").await;
        }
        store
            .soft_delete(coords("default", "/", "B"), &actor())
            .await
            .unwrap();
        let visible = |info: &VaultSecretInfo| info.name != "HIDDEN";
        let mut seen = Vec::new();
        let mut after: Option<String> = None;
        loop {
            let page = store
                .list_secrets_page(&ListFilter::default(), after.as_deref(), 2, visible)
                .await
                .unwrap();
            assert!(page.secrets.len() <= 2);
            seen.extend(page.secrets.iter().map(|info| info.coords().policy_key()));
            if let Some(next) = &page.next_after {
                let decoded = String::from_utf8(URL_SAFE_NO_PAD.decode(next).unwrap()).unwrap();
                assert!(!decoded.contains("HIDDEN"));
            }
            match page.next_after {
                Some(next) => after = Some(next),
                None => break,
            }
        }
        assert_eq!(
            seen,
            vec![
                "default/A",
                "default/app/C",
                "default/app/db/D",
                "default/apples/E",
                "prod/A",
            ]
        );

        // Recursive SCAN of a folder does not match sibling prefixes.
        let scan = store
            .list_secrets_page(
                &ListFilter {
                    environment: Some("default".into()),
                    path: Some("/app".into()),
                    recursive: true,
                    include_deleted: false,
                },
                None,
                DEFAULT_PAGE_LIMIT,
                |_| true,
            )
            .await
            .unwrap();
        assert_eq!(
            scan.secrets
                .iter()
                .map(|info| info.name.as_str())
                .collect::<Vec<_>>(),
            vec!["C", "D"]
        );
        assert!(scan.next_after.is_none());
        let flat = store
            .list_secrets_page(
                &ListFilter {
                    environment: Some("default".into()),
                    path: Some("/".into()),
                    recursive: false,
                    include_deleted: true,
                },
                None,
                10,
                |_| true,
            )
            .await
            .unwrap();
        assert_eq!(
            flat.secrets
                .iter()
                .map(|info| info.name.as_str())
                .collect::<Vec<_>>(),
            vec!["A", "B", "HIDDEN"]
        );
        let bad = store
            .list_secrets_page(&ListFilter::default(), Some("not-a-cursor"), 2, |_| true)
            .await
            .unwrap_err();
        assert!(code(&bad).starts_with("vault_invalid"));
    }
}
