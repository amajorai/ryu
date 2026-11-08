//! Sources: folders bound to a remote path (live or sync).
//!
//! test-exempt: split out of `external/mod.rs` unchanged in shape; exercised
//! end to end by `external/tests.rs` and `external/targets/tests.rs`.

use super::*;

impl PluginSecretStore {
    /// Bind a folder to a remote path at node scope `scope_id`.
    pub async fn external_source_create(
        &self,
        input: SourceInput,
        scope_id: &str,
        actor: &AuditActor,
    ) -> Result<SourceRecord> {
        let (environment, path) = folder(&input.environment, &input.path)?;
        let remote_path = normalize_remote(&input.remote_path)?;
        let cache_ttl_secs = in_range(
            input.cache_ttl_secs,
            DEFAULT_CACHE_TTL_SECS,
            MIN_CACHE_TTL_SECS,
            MAX_CACHE_TTL_SECS,
            "cacheTtlSecs",
        )?;
        let stale_if_error_secs = in_range(
            input.stale_if_error_secs,
            0,
            0,
            MAX_STALE_IF_ERROR_SECS,
            "staleIfErrorSecs",
        )?;
        let sync_interval_secs = in_range(
            input.sync_interval_secs,
            DEFAULT_SYNC_INTERVAL_SECS,
            MIN_SYNC_INTERVAL_SECS,
            MAX_INTERVAL_SECS,
            "syncIntervalSecs",
        )?;
        let conn = self.conn.lock().await;
        let store = store_locked(&conn, &input.store_id)?;
        if store.kind.is_sync_target() {
            return Err(invalid(format!(
                "{} stores are push-only; add a destination instead",
                store.kind.as_str()
            )));
        }
        let clash: Option<String> = conn
            .query_row(
                "SELECT 'folder' FROM vault_external_sources
                 WHERE scope_id = ?5 AND environment = ?1 AND path = ?2
                 UNION ALL
                 SELECT 'push' FROM vault_external_destinations
                 WHERE store_id = ?3 AND remote_path = ?4
                 UNION ALL
                 SELECT 'pushed' FROM vault_external_destinations
                 WHERE ?6 = 'live' AND scope_id = ?5 AND environment = ?1 AND path = ?2
                 LIMIT 1",
                params![
                    environment,
                    path,
                    store.id,
                    remote_path,
                    scope_id,
                    input.mode.as_str()
                ],
                |row| row.get(0),
            )
            .optional()?;
        match clash.as_deref() {
            Some("folder") => {
                return Err(VaultError::Conflict(format!(
                    "folder `{environment}:{path}` already has a source"
                ))
                .into())
            }
            Some("pushed") => {
                return Err(VaultError::Conflict(format!(
                    "folder `{environment}:{path}` is pushed to a destination; a live source \
                     would leave the push with no values (use sync mode)"
                ))
                .into())
            }
            Some(_) => {
                return Err(VaultError::Conflict(
                    "that remote path is a push destination; pulling it would loop".into(),
                )
                .into())
            }
            None => {}
        }
        let record = SourceRecord {
            id: format!("xsrc_{}", uuid::Uuid::new_v4().simple()),
            store_id: store.id.clone(),
            environment,
            path,
            remote_path,
            mode: input.mode,
            scope_id: scope_id.to_owned(),
            cache_ttl_secs,
            stale_if_error_secs,
            sync_interval_secs,
            last_sync_at: None,
            last_status: None,
            last_error: None,
            last_count: 0,
            created_at: now_millis(),
        };
        conn.execute(
            "INSERT INTO vault_external_sources
                (id, store_id, environment, path, remote_path, mode, scope_id, cache_ttl_secs,
                 stale_if_error_secs, sync_interval_secs, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                record.id,
                record.store_id,
                record.environment,
                record.path,
                record.remote_path,
                record.mode.as_str(),
                record.scope_id,
                record.cache_ttl_secs,
                record.stale_if_error_secs,
                record.sync_interval_secs,
                record.created_at
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "external.source.create", "ok").details(json!({
                "store": store.name, "source": record.id, "mode": record.mode.as_str(),
                "environment": record.environment, "path": record.path,
            })),
        );
        if record.mode == SourceMode::Sync {
            WAKE.notify_one();
        }
        Ok(record)
    }

    /// Every source.
    pub async fn external_source_list(&self) -> Result<Vec<SourceRecord>> {
        let conn = self.conn.lock().await;
        collect(
            &conn,
            &format!(
                "SELECT {SOURCE_COLUMNS} FROM vault_external_sources ORDER BY environment, path"
            ),
            source_from_row,
        )
    }

    /// One source.
    pub async fn external_source(&self, id: &str) -> Result<SourceRecord> {
        let conn = self.conn.lock().await;
        source_locked(&conn, id)
    }

    /// Unbind a folder. Values a sync already copied stay as ordinary local
    /// values (writable again).
    pub async fn external_source_delete(&self, id: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        let record = source_locked(&conn, id)?;
        conn.execute(
            "DELETE FROM vault_external_sources WHERE id = ?1",
            params![id],
        )?;
        cache_drop(id);
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "external.source.delete", "ok").details(json!({
                "source": id, "environment": record.environment, "path": record.path,
            })),
        );
        Ok(())
    }

    pub(super) fn record_source_status(
        conn: &Connection,
        id: &str,
        result: &Result<usize>,
    ) -> rusqlite::Result<usize> {
        let (status, error, count) = match result {
            Ok(count) => ("ok", None, *count as i64),
            Err(error) => ("error", Some(short_error(error)), 0),
        };
        conn.execute(
            "UPDATE vault_external_sources
             SET last_sync_at = ?1, last_status = ?2, last_error = ?3,
                 last_count = CASE WHEN ?2 = 'ok' THEN ?4 ELSE last_count END
             WHERE id = ?5",
            params![now_millis(), status, error, count, id],
        )
    }

    /// Resolve `name` through a live source on `(environment, path)` at node
    /// scope `scope_id`. Fails closed when the store is unreachable.
    pub(crate) async fn external_live_lookup(
        &self,
        scope_id: &str,
        environment: &str,
        path: &str,
        name: &str,
    ) -> Result<LiveLookup> {
        let source = {
            let conn = self.conn.lock().await;
            conn.query_row(
                &format!(
                    "SELECT {SOURCE_COLUMNS} FROM vault_external_sources
                     WHERE environment = ?1 AND path = ?2 AND mode = 'live' AND scope_id = ?3"
                ),
                params![environment, path, scope_id],
                source_from_row,
            )
            .optional()?
        };
        let Some(source) = source else {
            return Ok(LiveLookup::NotSourced);
        };
        if self.keyring.is_sealed() {
            return Ok(LiveLookup::Unavailable);
        }
        if let Some(folder) = cache_get(&source.id, secs(source.cache_ttl_secs)) {
            return Ok(lookup(&folder, name));
        }
        let fetched = self
            .external_read(&source.store_id, &source.remote_path)
            .await;
        {
            let conn = self.conn.lock().await;
            let status = fetched
                .as_ref()
                .map(|f| f.values.len())
                .map_err(|e| anyhow!("{e:#}"));
            Self::record_source_status(&conn, &source.id, &status)?;
        }
        match fetched {
            Ok(folder) => {
                let found = lookup(&folder, name);
                cache_put(&source.id, folder);
                Ok(found)
            }
            Err(error) => {
                tracing::warn!(
                    source = source.id,
                    "external store read failed: {}",
                    short_error(&error)
                );
                let stale_window = secs(source.cache_ttl_secs + source.stale_if_error_secs);
                match (source.stale_if_error_secs > 0)
                    .then(|| cache_get(&source.id, stale_window))
                    .flatten()
                {
                    Some(folder) => Ok(lookup(&folder, name)),
                    None => Ok(LiveLookup::Unavailable),
                }
            }
        }
    }

    /// Run one source now: a sync source copies the remote folder into local
    /// versions; a live source refreshes its cache.
    pub async fn external_sync_source(&self, id: &str, actor: &AuditActor) -> Result<SyncReport> {
        let lock = source_sync_lock(id);
        let _serialized = lock.lock().await;
        let source = self.external_source(id).await?;
        let result = self.sync_source_inner(&source, actor).await;
        let counted = result
            .as_ref()
            .map(|report| report.written + report.unchanged)
            .map_err(|error| anyhow!("{error:#}"));
        let conn = self.conn.lock().await;
        Self::record_source_status(&conn, id, &counted)?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(
                actor,
                "external.sync",
                if result.is_ok() { "ok" } else { "error" },
            )
            .details(json!({
                "source": id, "environment": source.environment, "path": source.path,
                "report": result.as_ref().ok(),
            })),
        );
        result
    }

    pub(super) async fn sync_source_inner(
        &self,
        source: &SourceRecord,
        actor: &AuditActor,
    ) -> Result<SyncReport> {
        let remote = self
            .external_read(&source.store_id, &source.remote_path)
            .await?;
        if source.mode == SourceMode::Live {
            let report = SyncReport {
                unchanged: remote.values.len(),
                ..SyncReport::default()
            };
            cache_put(&source.id, remote);
            return Ok(report);
        }
        // Validate everything before writing anything: one bad key aborts.
        for (key, value) in &remote.values {
            if !is_valid_vault_secret_name(key) {
                bail!("remote key `{key}` is not a valid secret name; sync aborted");
            }
            if value.trim().is_empty() || value.len() > MAX_VAULT_SECRET_VALUE_LEN {
                bail!("remote key `{key}` is empty or too large; sync aborted");
            }
        }
        let local: BTreeMap<String, String> = self
            .current_values(&ListFilter {
                environment: Some(source.environment.clone()),
                path: Some(source.path.clone()),
                recursive: false,
                include_deleted: false,
            })
            .await?
            .into_iter()
            .filter(|(info, _)| {
                info.scope == SecretScope::Node
                    && info.scope_id == source.scope_id
                    && info.binding.is_none()
                    && info.environment == source.environment
                    && info.path == source.path
                    && info.status(now_millis()) != SecretStatus::Deleted
            })
            .map(|(info, value)| (info.name, value))
            .collect();
        let mut report = SyncReport::default();
        for (key, value) in &remote.values {
            if local.get(key) == Some(value) {
                report.unchanged += 1;
                continue;
            }
            self.write_secret(WriteRequest {
                coords: self.sourced_coords(source, key),
                value: Some(value),
                patch: SecretMetadataPatch::default(),
                actor,
                source: VersionSource::External,
                expected_version: None,
            })
            .await?;
            report.written += 1;
        }
        let conn = self.conn.lock().await;
        for key in local.keys().filter(|key| !remote.values.contains_key(*key)) {
            let coords = self.sourced_coords(source, key);
            let removed = conn.execute(
                "UPDATE vault_secrets SET deleted_at = ?1, deleted_by = 'external'
                 WHERE scope = 'node' AND scope_id = ?2 AND environment = ?3 AND path = ?4
                   AND binding_kind = '' AND binding_id = '' AND name = ?5
                   AND deleted_at IS NULL",
                params![
                    now_millis(),
                    coords.scope_id,
                    coords.environment,
                    coords.path,
                    coords.name
                ],
            )?;
            if removed > 0 {
                report.removed += 1;
                self.audit_locked(
                    &conn,
                    &AuditEntry::new(actor, "secret.delete", "ok")
                        .secret(
                            "node",
                            &coords.scope_id,
                            &coords.environment,
                            &coords.path,
                            &coords.name,
                        )
                        .details(json!({ "source": "external" })),
                );
                mark_dirty(&conn, &coords)?;
            }
        }
        Ok(report)
    }

    pub(super) fn sourced_coords(&self, source: &SourceRecord, name: &str) -> SecretCoords {
        SecretCoords {
            scope: SecretScope::Node,
            scope_id: source.scope_id.clone(),
            environment: source.environment.clone(),
            path: source.path.clone(),
            binding: None,
            name: name.to_owned(),
        }
    }
}
