//! Destinations: one-way pushes of a folder.
//!
//! Exercised end to end by `external/tests.rs` and `external/targets/tests.rs`;
//! `destinations_tests.rs` covers which values a push sends.

use super::*;

impl PluginSecretStore {
    /// Push a node folder one-way to a remote path.
    pub async fn external_destination_create(
        &self,
        input: DestinationInput,
        scope_id: &str,
        actor: &AuditActor,
    ) -> Result<DestinationRecord> {
        let (environment, path) = folder(&input.environment, &input.path)?;
        let remote_path = normalize_remote(&input.remote_path)?;
        let interval_secs = in_range(
            input.interval_secs,
            DEFAULT_PUSH_INTERVAL_SECS,
            MIN_PUSH_INTERVAL_SECS,
            MAX_INTERVAL_SECS,
            "intervalSecs",
        )?;
        let conn = self.conn.lock().await;
        let store = store_locked(&conn, &input.store_id)?;
        if store.kind.is_sync_target() {
            targets::check_remote_path(&store, &remote_path)
                .map_err(|error| invalid(error.to_string()))?;
        } else if store.kind != StoreKind::Infisical
            && remote_path.is_empty()
            && store.path_prefix.is_empty()
        {
            return Err(invalid("a KV destination needs a `remotePath`"));
        }
        let clash: Option<String> = conn
            .query_row(
                "SELECT 'source' FROM vault_external_sources WHERE store_id = ?1 AND remote_path = ?2
                 UNION ALL
                 SELECT 'push' FROM vault_external_destinations
                 WHERE store_id = ?1 AND remote_path = ?2
                 UNION ALL
                 SELECT 'live' FROM vault_external_sources
                 WHERE mode = 'live' AND scope_id = ?3 AND environment = ?4 AND path = ?5
                 LIMIT 1",
                params![store.id, remote_path, scope_id, environment, path],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(kind) = clash {
            let message = match kind.as_str() {
                "source" => "that remote path is pulled by a source; pushing to it would loop",
                "live" => {
                    "that folder has a live source, so it holds no local values to push; \
                     use a sync source or push from the store itself"
                }
                _ => "that remote path already has a destination",
            };
            return Err(VaultError::Conflict(message.into()).into());
        }
        let record = DestinationRecord {
            id: format!("xdst_{}", uuid::Uuid::new_v4().simple()),
            store_id: store.id.clone(),
            environment,
            path,
            remote_path,
            scope_id: scope_id.to_owned(),
            interval_secs,
            dirty: true,
            last_push_at: None,
            last_status: None,
            last_error: None,
            last_count: 0,
            failures: 0,
            created_at: now_millis(),
        };
        conn.execute(
            "INSERT INTO vault_external_destinations
                (id, store_id, environment, path, remote_path, scope_id, interval_secs, dirty,
                 created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8)",
            params![
                record.id,
                record.store_id,
                record.environment,
                record.path,
                record.remote_path,
                record.scope_id,
                record.interval_secs,
                record.created_at
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "external.destination.create", "ok").details(json!({
                "store": store.name, "destination": record.id,
                "environment": record.environment, "path": record.path,
            })),
        );
        WAKE.notify_one();
        Ok(record)
    }

    /// Every destination.
    pub async fn external_destination_list(&self) -> Result<Vec<DestinationRecord>> {
        let conn = self.conn.lock().await;
        collect(
            &conn,
            &format!(
                "SELECT {DESTINATION_COLUMNS} FROM vault_external_destinations
                 ORDER BY environment, path"
            ),
            destination_from_row,
        )
    }

    /// Stop pushing a folder (remote values are left in place).
    pub async fn external_destination_delete(&self, id: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        destination_locked(&conn, id)?;
        conn.execute(
            "DELETE FROM vault_external_destinations WHERE id = ?1",
            params![id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "external.destination.delete", "ok")
                .details(json!({ "destination": id })),
        );
        Ok(())
    }

    /// Push one destination now. Returns how many keys were pushed.
    pub async fn external_push(&self, id: &str, actor: &AuditActor) -> Result<usize> {
        let destination = {
            let conn = self.conn.lock().await;
            let destination = destination_locked(&conn, id)?;
            // Clear first: a write landing during the push re-flags it.
            conn.execute(
                "UPDATE vault_external_destinations SET dirty = 0 WHERE id = ?1",
                params![id],
            )?;
            destination
        };
        let result = self.push_inner(&destination).await;
        let conn = self.conn.lock().await;
        let (status, error, count) = match &result {
            Ok(count) => ("ok", None, *count as i64),
            Err(error) => ("error", Some(short_error(error)), 0),
        };
        conn.execute(
            "UPDATE vault_external_destinations
             SET last_push_at = ?1, last_status = ?2, last_error = ?3,
                 last_count = CASE WHEN ?2 = 'ok' THEN ?4 ELSE last_count END,
                 dirty = CASE WHEN ?2 = 'ok' THEN dirty ELSE 1 END,
                 failures = CASE WHEN ?2 = 'ok' THEN 0 ELSE failures + 1 END
             WHERE id = ?5",
            params![now_millis(), status, error, count, id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "external.push", status).details(json!({
                "destination": id, "environment": destination.environment,
                "path": destination.path, "count": count,
            })),
        );
        result
    }

    pub(super) async fn push_inner(&self, destination: &DestinationRecord) -> Result<usize> {
        let values = self.push_values(destination).await?;
        let (record, credentials) = self.external_connection(&destination.store_id).await?;
        if record.kind.is_sync_target() {
            return targets::push(&record, &credentials, &destination.remote_path, &values).await;
        }
        let session = Session::connect(&record, &credentials).await?;
        // A KV write replaces the whole secret (v1 keeps no history): never let
        // an empty folder (a typo'd path, a cleared folder) wipe remote data.
        if values.is_empty() && record.kind != StoreKind::Infisical {
            let remote = session.read(&destination.remote_path).await?;
            if !remote.values.is_empty() {
                bail!(
                    "the folder is empty and the remote secret is not; refusing to wipe it \
                     (delete it in the store, or delete this destination)"
                );
            }
            return Ok(0);
        }
        session.write(&destination.remote_path, &values).await?;
        Ok(values.len())
    }

    /// The plaintext a push of `destination` sends: the folder's own live node
    /// values, never a sealed or control-group-gated one.
    pub(super) async fn push_values(
        &self,
        destination: &DestinationRecord,
    ) -> Result<BTreeMap<String, String>> {
        let now = now_millis();
        // A push runs unattended for no single caller, so a value that a
        // control group gates for anyone stays local (like exports).
        let policies = {
            let conn = self.conn.lock().await;
            crate::vault::policy::list_policies(&conn)?
        };
        Ok(self
            .current_values(&ListFilter {
                environment: Some(destination.environment.clone()),
                path: Some(destination.path.clone()),
                recursive: false,
                include_deleted: false,
            })
            .await?
            .into_iter()
            .filter(|(info, _)| {
                info.scope == SecretScope::Node
                    && info.scope_id == destination.scope_id
                    && info.binding.is_none()
                    && info.environment == destination.environment
                    && info.path == destination.path
                    // Sealed is use-only: a sync target could read it back.
                    && info.metadata.value_type.is_revealable()
                    && matches!(
                        info.status(now),
                        SecretStatus::Active | SecretStatus::RotationDue
                    )
                    && !crate::vault::policy_ext::read_gated_for_anyone(
                        &policies,
                        &info.coords().policy_key(),
                    )
            })
            .map(|(info, value)| (info.name, value))
            .collect())
    }
}

#[cfg(test)]
#[path = "destinations_tests.rs"]
mod destinations_tests;
