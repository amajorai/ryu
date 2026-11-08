//! JSON-object values: merge patch under check-and-set and `subkeys`.

use super::*;
use crate::plugin_secrets::kv::SEALED_USE_ONLY;

impl PluginSecretStore {
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
    /// version it was read from. Audited as `secret.subkeys`. A sealed value
    /// is refused like a reveal: its key names are part of its plaintext.
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
        // The key names of a sealed JSON value are part of its plaintext, so
        // they are refused (and audited as such) before anything is decrypted,
        // exactly like a reveal.
        if !info.metadata.value_type.is_revealable() {
            self.audit_locked(
                &conn,
                &coords.audit(
                    AuditEntry::new(actor, "secret.subkeys", "denied")
                        .details(json!({ "version": info.version, "reason": "sealed" })),
                ),
            );
            return Err(VaultError::Denied(SEALED_USE_ONLY.into()).into());
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
}
