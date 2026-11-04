//! Restoring a backup into a new private Space, an app snapshot, or a staged
//! node recovery directory with its recovered keys.

use super::staging::{plaintext_scratch, stage_dir};
use super::*;

#[derive(Clone, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreBackup {
    pub destination_id: String,
    pub backup_id: String,
    pub idempotency_key: String,
    /// Validate the catalog entry and return the recovery plan without creating
    /// an operation, Space, or recovery directory.
    #[serde(default)]
    pub dry_run: bool,
}

impl BackupService {
    pub async fn restore(
        self: &Arc<Self>,
        state: ServerState,
        request: RestoreBackup,
        owner: crate::server::spaces::DocOwner,
        app_scope: Option<&BackupScope>,
    ) -> Result<BackupOperation> {
        let (_, s3) = self.destination(&request.destination_id).await?;
        let record = s3
            .record(&request.backup_id)
            .await
            .context("Unable to read backup; check the recovery key and S3 permissions")?;
        ensure!(
            !matches!(record.scope, BackupScope::App { .. }),
            "Apps restore their own snapshots through the app backup primitive"
        );
        ensure!(
            app_scope.is_none_or(|scope| scope == &record.scope),
            "Backup does not belong to this app and tenant"
        );
        if request.dry_run {
            let would_create = match &record.scope {
                BackupScope::Node => "recovery_directory",
                BackupScope::Space { .. } => "private_space",
                BackupScope::App { .. } => "app_snapshot",
            };
            return Ok(BackupOperation {
                id: format!("dryrun_{}", uuid::Uuid::new_v4()),
                destination_id: request.destination_id,
                scope: record.scope.clone(),
                action: "restore".to_owned(),
                status: "dry_run".to_owned(),
                created_at: now(),
                completed_at: Some(now()),
                backup: Some(record.clone()),
                error: None,
                result: Some(json!({
                    "dryRun": true,
                    "validation": "catalog",
                    "wouldCreate": would_create,
                    "originalsPreserved": true,
                    "writes": [],
                    "note": "The backup catalog entry is valid. Restore will verify the encrypted archive and checksum when queued."
                })),
            });
        }
        let (operation, fresh) = self
            .begin(
                &request.destination_id,
                &record.scope,
                "restore",
                &request.idempotency_key,
                request.backup_id.clone().into(),
            )
            .await?;
        if !fresh {
            return Ok(operation);
        }
        let service = self.clone();
        let job = operation.clone();
        tokio::spawn(async move {
            let result: Result<Value> = async {
                let _permit = service.work.acquire().await?;
                service.set_operation(&job.id, |op| op.status = "running".into()).await?;
                let stage = stage_dir(&service.root, "ryu-recovery-")?;
                let encrypted = stage.path().join("snapshot.ryubak");
                s3.download(&record, &encrypted).await.context("Backup download or checksum verification failed")?;
                // Decrypt into an anonymous file, never a named plaintext zip.
                let mut archive = plaintext_scratch(stage.path())?;
                let key = *s3.recovery_key();
                let archive = tokio::task::spawn_blocking(move || {
                    encryption::decrypt(File::open(&encrypted)?, &mut archive, &key)?;
                    std::fs::remove_file(&encrypted)?;
                    archive.rewind()?;
                    Ok::<_, anyhow::Error>(archive)
                }).await??;
                match &record.scope {
                    BackupScope::Space { .. } => {
                        let id = state.spaces.restore_backup(archive, owner, None).await?;
                        // Index recovery is visible separately from successful
                        // source recovery; a missing model never loses the data.
                        let index_result = state.spaces.reindex_all().await;
                        Ok(json!({ "spaceId": id, "needsReindex": index_result.is_err() }))
                    }
                    BackupScope::Node => {
                        let recovery_parent = store::state_dir(&service.root).join("recovered");
                        ryu_backup::archive::private_directory(&recovery_parent)?;
                        let destination = recovery_parent.join(&job.id);
                        let path = destination.clone();
                        tokio::task::spawn_blocking(move || {
                            ryu_backup::archive::restore_tree_from(archive, &path)?;
                            let recovery: Value = serde_json::from_slice(&std::fs::read(path.join(RECOVERY_FILE))?)?;
                            install_recovered_keys(&path, &recovery, &key)
                        }).await??;
                        Ok(json!({ "recoveryPath": destination, "restartRequired": true, "keychainMode": "off" }))
                    }
                    BackupScope::App { .. } => tokio::task::spawn_blocking(move || {
                        let mut zip = zip::ZipArchive::new(archive)?;
                        let mut entry = zip.by_name("app.json")?;
                        ensure!(entry.size() <= MAX_APP_BYTES as u64, "App snapshot exceeds 8 MiB");
                        let mut bytes = Vec::new();
                        (&mut entry).take(MAX_APP_BYTES as u64 + 1).read_to_end(&mut bytes)?;
                        ensure!(bytes.len() <= MAX_APP_BYTES, "App snapshot exceeds 8 MiB");
                        Ok(serde_json::from_slice::<Value>(&bytes)?)
                    }).await?,
                }
            }.await;
            let error = result.as_ref().err().map(safe_error);
            if service
                .set_operation(&job.id, |op| {
                    op.completed_at = Some(now());
                    op.status = if result.is_ok() {
                        "completed"
                    } else {
                        "failed"
                    }
                    .into();
                    op.error = error;
                    op.backup = Some(record);
                    if let Ok(value) = result {
                        op.result = Some(value);
                    }
                })
                .await
                .is_err()
            {
                tracing::error!(operation_id = %job.id, "Could not persist restore completion");
            }
        });
        Ok(operation)
    }

    /// Returns the app's own data directly, without copying plaintext payloads
    /// into node job history or giving the app a filesystem/S3 credential seam.
    pub async fn restore_app(
        &self,
        destination: &str,
        id: &str,
        scope: &BackupScope,
    ) -> Result<Value> {
        let _permit = self.work.acquire().await?;
        let (_, s3) = self.destination(destination).await?;
        let record = s3.record(id).await.context("App backup is unavailable")?;
        ensure!(
            matches!(scope, BackupScope::App { .. }) && &record.scope == scope,
            "Backup does not belong to this app and tenant"
        );
        let stage = stage_dir(&self.root, "ryu-app-recovery-")?;
        let encrypted = stage.path().join("snapshot.ryubak");
        s3.download(&record, &encrypted)
            .await
            .context("App backup download verification failed")?;
        let key = *s3.recovery_key();
        tokio::task::spawn_blocking(move || {
            let mut archive = plaintext_scratch(stage.path())?;
            encryption::decrypt(File::open(encrypted)?, &mut archive, &key)?;
            archive.rewind()?;
            let mut zip = zip::ZipArchive::new(archive)?;
            let mut entry = zip.by_name("app.json")?;
            ensure!(
                entry.size() <= MAX_APP_BYTES as u64,
                "App backup exceeds 8 MiB"
            );
            let mut bytes = Vec::new();
            (&mut entry)
                .take(MAX_APP_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= MAX_APP_BYTES, "App backup exceeds 8 MiB");
            let value = serde_json::from_slice(&bytes)?;
            drop(stage);
            Ok(value)
        })
        .await?
    }
}

/// Write the recovered node's keys into its folder. The recovered folder boots
/// in file-key custody (the documented `RYU_KEYCHAIN=off` command), so every
/// key is written owner-only (0600 in a 0700 dir), the same protection as any
/// file-fallback node. A recovery file with a key bundle (version 2) restores
/// the current key and every retired key, and rewrites the retired-key index
/// in file custody; an older one carries only the master key.
pub(super) fn install_recovered_keys(path: &Path, recovery: &Value, key: &[u8; 32]) -> Result<()> {
    let cipher = ryu_crypto::FieldCipher::new(key);
    if let Some(sealed) = recovery.get("sealedKeyBundle").and_then(Value::as_str) {
        ensure!(
            ryu_crypto::FieldCipher::is_sealed(sealed),
            "Invalid key recovery bundle"
        );
        let (current, retired) = ryu_crypto::custody::open_key_bundle(&cipher, sealed)?;
        ryu_backup::archive::private_directory(&ryu_sidecar_runtime::layout::secrets_dir(path))?;
        return ryu_crypto::custody::install_file_custody(path, &current, &retired);
    }
    let sealed = recovery
        .get("sealedMasterKey")
        .and_then(Value::as_str)
        .context("Backup is missing its master recovery key")?;
    ensure!(
        ryu_crypto::FieldCipher::is_sealed(sealed),
        "Invalid master recovery key"
    );
    let master = cipher.open(sealed)?;
    encryption::parse_key(&master)?;
    let secrets = ryu_sidecar_runtime::layout::secrets_dir(path);
    ryu_backup::archive::private_directory(&secrets)?;
    let mut key_file = tempfile::NamedTempFile::new_in(&secrets)?;
    key_file.write_all(master.as_bytes())?;
    key_file.as_file().sync_all()?;
    key_file.persist(ryu_sidecar_runtime::layout::secret_path(path, "master.key"))?;
    Ok(())
}
