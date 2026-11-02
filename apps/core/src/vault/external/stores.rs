//! Store CRUD and connection on [`PluginSecretStore`].
//!
//! Split out of [`super`], which re-exports the public items at their
//! original paths.
//!
//! test-exempt: code moved verbatim out of `mod.rs`; exercised by tests.rs (store_credentials_are_sealed_and_never_listed) and k8s_origin_tests.rs.

use super::*;

impl PluginSecretStore {
    // ── Stores ────────────────────────────────────────────────────────────

    /// Create a store; credentials are sealed with the keyring.
    pub async fn external_store_create(
        &self,
        input: StoreInput,
        actor: &AuditActor,
    ) -> Result<StoreRecord> {
        let (record, credentials) = validate_store(input)?;
        let sealed = serde_json::to_vec(&credentials)?;
        let (key_version, nonce, ciphertext) = self.seal_row(&sealed)?;
        let conn = self.conn.lock().await;
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM vault_external_stores WHERE name = ?1",
                params![record.name],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if exists {
            return Err(
                VaultError::Conflict(format!("external store `{}` exists", record.name)).into(),
            );
        }
        conn.execute(
            "INSERT INTO vault_external_stores
                (id, name, kind, address, namespace, auth_method, auth_mount, role,
                 mount, path_prefix, kv_version, project_id, infisical_environment, secret_path,
                 nonce, ciphertext, key_version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                     ?17, ?18, ?18)",
            params![
                record.id,
                record.name,
                record.kind.as_str(),
                record.address,
                record.namespace,
                record.auth_method.as_str(),
                record.auth_mount,
                record.role,
                record.mount,
                record.path_prefix,
                record.kv_version,
                record.project_id,
                record.infisical_environment,
                record.secret_path,
                nonce,
                ciphertext,
                key_version,
                record.created_at
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "external.store.create", "ok").details(json!({
                "store": record.name, "kind": record.kind.as_str(),
                "authMethod": record.auth_method.as_str(),
            })),
        );
        Ok(record)
    }

    /// Every store (no credentials).
    pub async fn external_store_list(&self) -> Result<Vec<StoreRecord>> {
        let conn = self.conn.lock().await;
        let rows = collect(
            &conn,
            &format!("SELECT {STORE_COLUMNS} FROM vault_external_stores ORDER BY name"),
            store_from_row,
        )?;
        Ok(rows.into_iter().flatten().collect())
    }

    /// One store (no credentials).
    pub async fn external_store(&self, id: &str) -> Result<StoreRecord> {
        let conn = self.conn.lock().await;
        store_locked(&conn, id)
    }

    /// Delete a store that no source or destination uses.
    pub async fn external_store_delete(&self, id: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        let record = store_locked(&conn, id)?;
        let users: i64 = conn.query_row(
            "SELECT (SELECT COUNT(*) FROM vault_external_sources WHERE store_id = ?1)
                  + (SELECT COUNT(*) FROM vault_external_destinations WHERE store_id = ?1)",
            params![id],
            |row| row.get(0),
        )?;
        if users > 0 {
            return Err(VaultError::Conflict(format!(
                "external store `{}` still has sources or destinations",
                record.name
            ))
            .into());
        }
        conn.execute(
            "DELETE FROM vault_external_stores WHERE id = ?1",
            params![id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "external.store.delete", "ok")
                .details(json!({ "store": record.name })),
        );
        Ok(())
    }

    /// The store and its unsealed credentials.
    pub(super) async fn external_connection(
        &self,
        store_id: &str,
    ) -> Result<(StoreRecord, StoreCredentials)> {
        if self.keyring.is_sealed() {
            return Err(VaultError::Sealed.into());
        }
        let conn = self.conn.lock().await;
        let record = store_locked(&conn, store_id)?;
        let (key_version, nonce, ciphertext): (u32, Vec<u8>, Vec<u8>) = conn.query_row(
            "SELECT key_version, nonce, ciphertext FROM vault_external_stores WHERE id = ?1",
            params![store_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let plain = self.open_row(key_version, &nonce, &ciphertext)?;
        let credentials: StoreCredentials =
            serde_json::from_slice(&plain).context("store credentials are malformed")?;
        Ok((record, credentials))
    }

    pub(super) async fn external_read(
        &self,
        store_id: &str,
        remote_path: &str,
    ) -> Result<RemoteFolder> {
        let (record, credentials) = self.external_connection(store_id).await?;
        let session = Session::connect(&record, &credentials).await?;
        session.read(remote_path).await
    }

    /// Log in to a store (and, for KV token auth, look the token up) to check
    /// connectivity and credentials. Never returns a value.
    pub async fn external_store_test(&self, id: &str, actor: &AuditActor) -> Result<()> {
        let result = async {
            let (record, credentials) = self.external_connection(id).await?;
            Session::connect(&record, &credentials).await?.check().await
        }
        .await;
        let outcome = if result.is_ok() { "ok" } else { "error" };
        self.audit(
            &AuditEntry::new(actor, "external.store.test", outcome).details(json!({ "store": id })),
        )
        .await;
        result
    }
}
