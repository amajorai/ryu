//! Transit export, backup and restore, and bring-your-own-key import.

use super::*;

// ── Backups ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BackupDoc {
    format: String,
    name: String,
    #[serde(rename = "type")]
    key_type: TransitKeyType,
    latest_version: u32,
    min_decryption_version: u32,
    min_encryption_version: u32,
    min_available_version: u32,
    deletion_allowed: bool,
    derived: bool,
    convergent: bool,
    exportable: bool,
    allow_plaintext_backup: bool,
    auto_rotate_period_secs: i64,
    imported: bool,
    created_at: i64,
    versions: Vec<BackupVersion>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BackupVersion {
    version: u32,
    /// Base64 stored-form key material.
    material: String,
    created_at: i64,
}

impl PluginSecretStore {
    /// Export key material (`exportable` keys only, except public keys).
    pub async fn transit_export(
        &self,
        name: &str,
        kind: TransitExportKind,
        version: Option<u32>,
        actor: &AuditActor,
    ) -> Result<TransitExport> {
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        let key_type = meta.key_type;
        let supported = match kind {
            TransitExportKind::EncryptionKey => key_type.can_encrypt(),
            TransitExportKind::SigningKey | TransitExportKind::PublicKey => key_type.can_sign(),
            TransitExportKind::HmacKey => key_type.can_hmac(),
            TransitExportKind::CmacKey => key_type.cmac_key_bytes().is_some(),
        };
        if !supported {
            return Err(invalid(format!(
                "{} keys have no {}",
                key_type.as_str(),
                kind.as_str()
            )));
        }
        if kind != TransitExportKind::PublicKey && !meta.exportable {
            return Err(denied("this transit key is not exportable"));
        }
        let versions: Vec<u32> = match version {
            Some(version) if (meta.min_available..=meta.latest).contains(&version) => {
                vec![version]
            }
            Some(version) => {
                return Err(
                    VaultError::NotFound(format!("transit key `{name}` version {version}")).into(),
                )
            }
            None => (meta.min_available..=meta.latest).collect(),
        };
        let mut keys = BTreeMap::new();
        for version in versions {
            let value = if kind == TransitExportKind::PublicKey {
                transit_public_key(&conn, name, version)?
            } else {
                let material = self.transit_material(&conn, name, version)?;
                match kind {
                    TransitExportKind::HmacKey => B64.encode(hmac_key(key_type, &material)),
                    _ if key_type.is_symmetric()
                        || key_type.cmac_key_bytes().is_some()
                        || key_type == TransitKeyType::Ed25519 =>
                    {
                        B64.encode(&material)
                    }
                    _ => private_pem(key_type, &material)?,
                }
            };
            keys.insert(version.to_string(), value);
        }
        if kind != TransitExportKind::PublicKey
            && !self.audit_locked(
                &conn,
                &AuditEntry::new(actor, "transit.export", "ok").details(serde_json::json!({
                    "key": name, "kind": kind.as_str(), "versions": keys.keys().collect::<Vec<_>>(),
                })),
            )
        {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(TransitExport {
            name: name.to_owned(),
            key_type,
            kind,
            keys,
        })
    }

    /// A plaintext backup of every available version and the key's
    /// configuration (base64 JSON). Requires `exportable` and
    /// `allowPlaintextBackup`.
    pub async fn transit_backup(&self, name: &str, actor: &AuditActor) -> Result<String> {
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.exportable || !meta.allow_plaintext_backup {
            return Err(denied(
                "backups need both exportable and allowPlaintextBackup on the key",
            ));
        }
        let rows: Vec<(u32, i64)> = {
            let mut stmt = conn.prepare(
                "SELECT version, created_at FROM vault_transit_keys
                 WHERE name = ?1 ORDER BY version",
            )?;
            let rows = stmt.query_map(params![name], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let mut versions = Vec::with_capacity(rows.len());
        for (version, created_at) in rows {
            versions.push(BackupVersion {
                version,
                material: B64.encode(self.transit_material(&conn, name, version)?),
                created_at,
            });
        }
        let doc = BackupDoc {
            format: BACKUP_FORMAT.to_owned(),
            name: name.to_owned(),
            key_type: meta.key_type,
            latest_version: meta.latest,
            min_decryption_version: meta.min_decrypt,
            min_encryption_version: meta.min_encrypt,
            min_available_version: meta.min_available,
            deletion_allowed: meta.deletion_allowed,
            derived: meta.derived,
            convergent: meta.convergent,
            exportable: meta.exportable,
            allow_plaintext_backup: meta.allow_plaintext_backup,
            auto_rotate_period_secs: meta.auto_rotate_period_secs,
            imported: meta.imported,
            created_at: meta.created_at,
            versions,
        };
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.backup", "ok")
                .details(serde_json::json!({ "key": name, "versions": doc.versions.len() })),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(B64.encode(serde_json::to_vec(&doc)?))
    }

    /// Restore a [`Self::transit_backup`] under its own or a new `name`.
    /// An existing key is replaced only with `force`.
    pub async fn transit_restore(
        &self,
        backup_b64: &str,
        name: Option<&str>,
        force: bool,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        let raw = B64
            .decode(backup_b64.trim())
            .map_err(|_| invalid("backup must be base64"))?;
        let doc: BackupDoc =
            serde_json::from_slice(&raw).map_err(|_| invalid("backup is not a transit backup"))?;
        if doc.format != BACKUP_FORMAT {
            return Err(invalid("unsupported transit backup format"));
        }
        let target = name.unwrap_or(&doc.name).to_owned();
        if !is_valid_key_name(&target) {
            return Err(invalid("invalid transit key name"));
        }
        let options = TransitKeyOptions {
            derived: doc.derived,
            convergent: doc.convergent,
            exportable: doc.exportable,
            allow_plaintext_backup: doc.allow_plaintext_backup,
            auto_rotate_period_secs: doc.auto_rotate_period_secs,
        };
        validate_key_options(doc.key_type, &options)?;
        let min_available = doc.min_available_version.max(1);
        let expected: Vec<u32> = (min_available..=doc.latest_version).collect();
        let present: Vec<u32> = doc.versions.iter().map(|v| v.version).collect();
        if expected.is_empty()
            || present != expected
            || doc.min_decryption_version < min_available
            || doc.min_decryption_version > doc.latest_version
            || (doc.min_encryption_version != 0
                && (doc.min_encryption_version < min_available
                    || doc.min_encryption_version > doc.latest_version
                    || doc.min_encryption_version < doc.min_decryption_version))
        {
            return Err(invalid(
                "backup versions or version bounds are inconsistent",
            ));
        }
        let mut materials = Vec::with_capacity(doc.versions.len());
        for version in &doc.versions {
            let material = B64
                .decode(&version.material)
                .map_err(|_| invalid("backup material must be base64"))?;
            let public_key = public_key_of(doc.key_type, &material)?;
            materials.push((version.version, material, public_key, version.created_at));
        }
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        if let Some(existing) = read_meta(&tx, &target)? {
            if !force {
                return Err(VaultError::Conflict(format!(
                    "transit key `{target}` exists (pass force to replace it)"
                ))
                .into());
            }
            // Replacing destroys every version of the existing key, so it is
            // guarded exactly like `transit_purge`.
            if !existing.deletion_allowed {
                return Err(denied("set deletionAllowed before replacing a transit key"));
            }
            purge_locked(&tx, &target)?;
        }
        tx.execute(
            "INSERT INTO vault_transit_meta
                (name, key_type, latest_version, min_decryption_version, min_encryption_version,
                 min_available_version, deletion_allowed, derived, convergent, exportable,
                 allow_plaintext_backup, auto_rotate_period_secs, imported, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                target,
                doc.key_type.as_str(),
                doc.latest_version,
                doc.min_decryption_version,
                doc.min_encryption_version,
                min_available,
                doc.deletion_allowed,
                doc.derived,
                doc.convergent,
                doc.exportable,
                doc.allow_plaintext_backup,
                doc.auto_rotate_period_secs,
                doc.imported,
                doc.created_at
            ],
        )?;
        for (version, material, public_key, created_at) in &materials {
            self.insert_transit_material(
                &tx,
                &target,
                *version,
                material,
                public_key.as_deref(),
                *created_at,
            )?;
        }
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "transit.restore", "ok").details(serde_json::json!({
                "key": target, "from": doc.name, "versions": materials.len(), "force": force,
            })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        transit_info_locked(&conn, &target)
    }

    /// The BYOK wrapping key (SPKI PEM), generated on first use.
    pub async fn transit_wrapping_key(&self) -> Result<String> {
        {
            let conn = self.conn.lock().await;
            if let Some(pem) = transit_public_key_opt(&conn, WRAPPING_KEY_NAME, 1)? {
                return Ok(pem);
            }
        }
        let (material, public_key) = tokio::task::spawn_blocking(|| -> Result<_> {
            let key = RsaPrivateKey::new(&mut OsRng, WRAPPING_KEY_BITS)
                .map_err(|error| anyhow!("generating the wrapping key: {error}"))?;
            let der = der_bytes(key.to_pkcs8_der())?;
            let pem = spki_pem(RsaPublicKey::from(&key).to_public_key_pem(LineEnding::LF))?;
            Ok((der, pem))
        })
        .await??;
        let conn = self.conn.lock().await;
        if let Some(pem) = transit_public_key_opt(&conn, WRAPPING_KEY_NAME, 1)? {
            // Another caller won the race; keep the first key.
            return Ok(pem);
        }
        self.insert_transit_material(
            &conn,
            WRAPPING_KEY_NAME,
            1,
            &material,
            Some(&public_key),
            now_millis(),
        )?;
        Ok(public_key)
    }

    pub(super) fn unwrap_import(&self, conn: &Connection, ciphertext_b64: &str) -> Result<Vec<u8>> {
        let blob = B64
            .decode(ciphertext_b64.trim())
            .map_err(|_| invalid("ciphertext must be base64"))?;
        if blob.len() > 64 * 1024 {
            return Err(invalid("import ciphertext is too large"));
        }
        if transit_public_key_opt(conn, WRAPPING_KEY_NAME, 1)?.is_none() {
            return Err(invalid(
                "fetch the wrapping key (GET /api/vault/transit/wrapping-key) before importing",
            ));
        }
        let wrapping = rsa_key(&self.transit_material(conn, WRAPPING_KEY_NAME, 1)?)?;
        let split = wrapping.size();
        if blob.len() <= split {
            return Err(invalid(
                "import ciphertext must be the RSA-OAEP wrapped key followed by AES-KWP output",
            ));
        }
        let (wrapped_key, wrapped_material) = blob.split_at(split);
        let ephemeral = wrapping
            .decrypt(Oaep::new::<Sha256>(), wrapped_key)
            .map_err(|_| invalid("the ephemeral key failed RSA-OAEP-SHA256 decryption"))?;
        if ephemeral.len() != 32 {
            return Err(invalid("the ephemeral key must be AES-256"));
        }
        kwp_unwrap(&ephemeral, wrapped_material)
    }

    /// Create a key from wrapped external material (BYOK).
    pub async fn transit_import(
        &self,
        name: &str,
        key_type: TransitKeyType,
        ciphertext_b64: &str,
        options: &TransitKeyOptions,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        if !is_valid_key_name(name) {
            return Err(invalid("invalid transit key name"));
        }
        validate_key_options(key_type, options)?;
        let conn = self.conn.lock().await;
        let material = normalize_import(key_type, self.unwrap_import(&conn, ciphertext_b64)?)?;
        let public_key = public_key_of(key_type, &material)?;
        let tx = conn.unchecked_transaction()?;
        self.insert_transit_key_locked(
            &tx,
            name,
            key_type,
            options,
            true,
            &material,
            public_key.as_deref(),
            actor,
            "transit.import",
        )?;
        tx.commit()?;
        self.flush_audit(&conn);
        transit_info_locked(&conn, name)
    }

    /// Add an imported version to an existing key and make it the latest.
    pub async fn transit_import_version(
        &self,
        name: &str,
        ciphertext_b64: &str,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.imported {
            return Err(invalid("import_version only applies to imported keys"));
        }
        let material = normalize_import(meta.key_type, self.unwrap_import(&conn, ciphertext_b64)?)?;
        let public_key = public_key_of(meta.key_type, &material)?;
        let next = meta.latest + 1;
        let tx = conn.unchecked_transaction()?;
        self.insert_transit_material(
            &tx,
            name,
            next,
            &material,
            public_key.as_deref(),
            now_millis(),
        )?;
        tx.execute(
            "UPDATE vault_transit_meta SET latest_version = ?1, imported = 1 WHERE name = ?2",
            params![next, name],
        )?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "transit.import", "ok")
                .details(serde_json::json!({ "key": name, "version": next })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        transit_info_locked(&conn, name)
    }
}
