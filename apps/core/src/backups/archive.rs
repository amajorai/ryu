//! Creating a backup: building the snapshot archive, encrypting it and
//! uploading it, and the paths a node snapshot never carries.

use super::schedule::retained_candidates;
use super::staging::{plaintext_scratch, stage_dir};
use super::*;

impl BackupService {
    pub async fn create(
        self: &Arc<Self>,
        state: ServerState,
        request: CreateBackup,
        app_data: Option<Value>,
    ) -> Result<BackupOperation> {
        let (_, s3) = self.destination(&request.destination_id).await?;
        let payload = app_data.as_ref().map(serde_json::to_vec).transpose()?;
        ensure!(
            payload
                .as_ref()
                .is_none_or(|data| data.len() <= MAX_APP_BYTES),
            "App backup exceeds 8 MiB"
        );
        ensure!(
            matches!(request.scope, BackupScope::App { .. }) == payload.is_some(),
            "Backup payload does not match its scope"
        );
        let hash = RequestDigest::for_backup(&request.scope, app_data.as_ref())?;
        drop(app_data);
        let (operation, fresh) = self
            .begin(
                &request.destination_id,
                &request.scope,
                "backup",
                &request.idempotency_key,
                hash,
            )
            .await?;
        if !fresh {
            return Ok(operation);
        }
        let service = self.clone();
        let job = operation.clone();
        tokio::spawn(async move {
            let result: Result<BackupRecord> =
                async {
                    let _permit = service.work.acquire().await?;
                    service
                        .set_operation(&job.id, |job| job.status = "running".into())
                        .await?;
                    let stage = stage_dir(&service.root, "ryu-backup-")?;
                    // The plaintext archive never gets a name: it is written to an
                    // anonymous file and dropped as soon as it is encrypted, before
                    // the (possibly long) upload starts.
                    let archive = service
                        .snapshot(
                            &state,
                            &job.scope,
                            plaintext_scratch(stage.path())?,
                            stage.path().to_path_buf(),
                            payload,
                            s3.recovery_key(),
                        )
                        .await?;
                    let encrypted = stage.path().join("snapshot.ryubak");
                    let output = encrypted.clone();
                    let key = *s3.recovery_key();
                    tokio::task::spawn_blocking(move || {
                        let mut input = archive;
                        input.rewind()?;
                        let length = input.metadata()?.len();
                        encryption::encrypt(&mut input, File::create(output)?, length, &key)
                    })
                    .await??;
                    let file = encrypted.clone();
                    let sha256 =
                        tokio::task::spawn_blocking(move || encryption::sha256(File::open(file)?))
                            .await??;
                    let record = BackupRecord {
                        version: 1,
                        id: job.id.clone(),
                        source_node_id: service.store.lock().await.node_id.clone(),
                        scope: job.scope.clone(),
                        created_at: job.created_at.clone(),
                        bytes: std::fs::metadata(&encrypted)?.len(),
                        sha256,
                        object_key: s3.scoped_object_key(&job.id, &job.scope)?,
                    };
                    s3.upload(&encrypted, &record)
                        .await
                        .context("S3 upload failed; backup was not published")?;
                    service
                        .set_operation(&job.id, |op| op.backup = Some(record.clone()))
                        .await?;
                    // A completed backup remains recoverable if retention fails.
                    if let Some(policy) =
                        service.policies().await.into_iter().find(|p| {
                            p.destination_id == job.destination_id && p.scope == job.scope
                        })
                    {
                        let previous = s3.list(Some(&job.scope)).await.context(
                            "Backup uploaded, but retention could not list earlier backups",
                        )?;
                        for old in retained_candidates(previous, &record.source_node_id)
                            .into_iter()
                            .skip(policy.retention_count)
                        {
                            s3.delete(&old).await.context(
                                "Backup uploaded, but retention could not remove an older backup",
                            )?;
                        }
                    }
                    Ok(record)
                }
                .await;
            let error = result.as_ref().err().map(safe_error);
            let outcome = service
                .set_operation(&job.id, |op| {
                    op.completed_at = Some(now());
                    op.status = if result.is_ok() {
                        "completed"
                    } else {
                        "failed"
                    }
                    .into();
                    op.error = error;
                    if let Ok(record) = result {
                        op.backup = Some(record);
                    }
                })
                .await;
            if outcome.is_err() {
                tracing::error!(operation_id = %job.id, "Could not persist backup completion");
            } else {
                tracing::info!(operation_id = %job.id, "Backup operation finished");
            }
        });
        Ok(operation)
    }

    /// Write the scope's plaintext archive into `output` (an anonymous file) and
    /// return it. `scratch` is the job's private stage, used only for transient
    /// SQLite snapshot copies.
    async fn snapshot(
        &self,
        state: &ServerState,
        scope: &BackupScope,
        output: File,
        scratch: PathBuf,
        payload: Option<Vec<u8>>,
        recovery_key: &[u8; 32],
    ) -> Result<File> {
        match scope {
            BackupScope::Node => {
                let root = self.root.clone();
                let recovery_cipher = ryu_crypto::FieldCipher::new(recovery_key);
                let recovery = ryu_crypto::seal_backup_master_key(&recovery_cipher)?;
                // The current AND the retired keys: data still sealed under a
                // retired key (resealed lazily) must open after a restore.
                let key_bundle = ryu_crypto::custody::seal_key_bundle(&recovery_cipher)?;
                tokio::task::spawn_blocking(move || {
                    let mut zip = zip::ZipWriter::new(output);
                    ryu_backup::archive::snapshot_tree_into(
                        &root,
                        &mut zip,
                        &scratch,
                        node_excluded,
                    )?;
                    zip.start_file(
                        RECOVERY_FILE,
                        zip::write::SimpleFileOptions::default().unix_permissions(0o600),
                    )?;
                    serde_json::to_writer(
                        &mut zip,
                        &json!({
                            "version": 2,
                            "sealedMasterKey": recovery,
                            "sealedKeyBundle": key_bundle,
                        }),
                    )?;
                    Ok(zip.finish()?)
                })
                .await?
            }
            BackupScope::Space { space_id } => {
                state
                    .spaces
                    .export_backup(
                        space_id,
                        crate::server::spaces::DocFilter::unrestricted(),
                        output,
                    )
                    .await
            }
            BackupScope::App { .. } => {
                let payload = payload.context("App snapshot payload is required")?;
                tokio::task::spawn_blocking(move || {
                    let mut zip = zip::ZipWriter::new(output);
                    zip.start_file(
                        "app.json",
                        zip::write::SimpleFileOptions::default()
                            .compression_method(zip::CompressionMethod::Deflated)
                            .unix_permissions(0o600),
                    )?;
                    zip.write_all(&payload)?;
                    Ok(zip.finish()?)
                })
                .await?
            }
        }
    }
}

/// Data-dir-relative paths a node snapshot never carries: the backup state
/// itself, chat rewind snapshots (they copy project files keyed by local folder
/// paths, so they are machine-local, like a cache), and the key custody files
/// (the master key travels sealed inside the recovery file instead).
const NODE_EXCLUDED_PATHS: &[&str] = &[
    "state/backups",
    "state/chat-checkpoints",
    "secrets/master.key",
    "secrets/memory.key",
];

pub(super) fn node_excluded(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    let rel = path.to_string_lossy().replace('\\', "/");
    crate::data_path::is_backup_excluded(path)
        || NODE_EXCLUDED_PATHS.contains(&rel.as_str())
        || (path.components().count() == 1
            && matches!(
                name,
                "cache"
                    | "caches"
                    | "logs"
                    | "tmp"
                    | "run"
                    | "node_modules"
                    | "venvs"
                    | "engines"
                    | "bin"
                    | RECOVERY_FILE
            ))
        || matches!(name, "node_modules" | ".venv" | "venv" | "__pycache__")
        || name.ends_with(".pid")
        || name.ends_with(".sock")
        || name.ends_with(".part")
}
