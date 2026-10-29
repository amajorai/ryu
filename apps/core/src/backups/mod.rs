//! Core-owned backup orchestration. The HTTP and plugin bridges share this
//! service; credentials and resource scope never move into an app process.

mod store;
#[cfg(test)]
mod tests;
pub use store::BackupService;

use std::{
    fs::File,
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{ensure, Context, Result};
use chrono::{Timelike, Utc};
use ryu_backup::{encryption, s3::S3BackupStore, *};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{scheduler::cron::CronSchedule, server::ServerState};
use store::{StoredDestination, StoredOperation};

pub const MAX_APP_BYTES: usize = 8 * 1024 * 1024;
const RECOVERY_FILE: &str = ".ryu-backup-recovery.json";
/// `tmp/<owner>` scratch for backup and restore staging. It sits inside the data
/// dir (never the shared system temp dir), is owner-only, is skipped by node
/// snapshots (top-level `tmp`), and is emptied when the service opens so a crash
/// mid-job cannot leave staging behind.
const STAGING_OWNER: &str = "backups";

pub(crate) fn staging_root(root: &Path) -> PathBuf {
    ryu_sidecar_runtime::layout::tmp_dir_for(root, STAGING_OWNER)
}

/// A private (`0700`) per-job directory under [`staging_root`]. It holds only
/// ciphertext (`snapshot.ryubak`) and, briefly, SQLite snapshot copies; the
/// plaintext archive itself lives in an anonymous file (see [`plaintext_scratch`]).
fn stage_dir(root: &Path, prefix: &str) -> Result<tempfile::TempDir> {
    let parent = staging_root(root);
    ryu_backup::archive::private_directory(&parent)?;
    let stage = tempfile::Builder::new()
        .prefix(prefix)
        .tempdir_in(&parent)?;
    ryu_backup::archive::private_directory(stage.path())?;
    Ok(stage)
}

/// An anonymous, already-unlinked file for a plaintext archive: it has no path
/// another process can open, and the OS reclaims it when the handle closes,
/// including when Core is killed mid-job.
fn plaintext_scratch(stage: &Path) -> Result<File> {
    Ok(tempfile::tempfile_in(stage)?)
}

/// Remove staging a previous process left behind (crash, kill or power loss):
/// everything under [`staging_root`] and any half-extracted `.ryu-restore-*`
/// directory under `state/backups/recovered`. Runs once, before any job starts.
pub(crate) fn sweep_stale_staging(root: &Path) {
    let staging = staging_root(root);
    if let Ok(entries) = std::fs::read_dir(&staging) {
        for entry in entries.flatten() {
            let path = entry.path();
            let removed = if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            if let Err(error) = removed {
                tracing::warn!(path = %path.display(), "could not remove stale backup staging: {error}");
            }
        }
    }
    let recovered = store::state_dir(root).join("recovered");
    if let Ok(entries) = std::fs::read_dir(&recovered) {
        for entry in entries.flatten() {
            let is_partial = entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(".ryu-restore-"));
            if is_partial && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                if let Err(error) = std::fs::remove_dir_all(entry.path()) {
                    tracing::warn!("could not remove a partial recovery directory: {error}");
                }
            }
        }
    }
}

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub async fn global() -> Result<Arc<BackupService>> {
    static SERVICE: tokio::sync::OnceCell<Arc<BackupService>> = tokio::sync::OnceCell::const_new();
    SERVICE
        .get_or_try_init(|| async {
            tokio::task::spawn_blocking(|| {
                BackupService::open(crate::paths::ryu_dir()).map(Arc::new)
            })
            .await?
        })
        .await
        .cloned()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Credentials {
    access_key_id: String,
    secret_access_key: String,
    session_token: Option<String>,
    recovery_key: String,
}

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

fn scope_valid(scope: &BackupScope) -> Result<()> {
    match scope {
        BackupScope::Node => {}
        BackupScope::Space { space_id } => {
            uuid::Uuid::parse_str(space_id).context("Invalid Space ID")?;
        }
        BackupScope::App {
            app_id,
            namespace,
            tenant,
        } => {
            ensure!(
                !app_id.is_empty()
                    && app_id.len() <= 128
                    && !tenant.is_empty()
                    && tenant.len() <= 128,
                "Invalid app scope"
            );
            ensure!(
                !namespace.is_empty()
                    && namespace.len() <= 128
                    && namespace
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')),
                "Invalid backup namespace"
            );
        }
    }
    Ok(())
}

fn safe_error(error: &anyhow::Error) -> String {
    // Provider errors can include signed URLs or credential identifiers. The
    // context frames describe the operation without exposing provider bodies.
    error.to_string().chars().take(320).collect()
}

impl BackupService {
    pub async fn destinations(&self) -> Vec<BackupDestination> {
        self.store
            .lock()
            .await
            .destinations
            .iter()
            .map(|row| row.destination.clone())
            .collect()
    }

    pub async fn destination(&self, id: &str) -> Result<(BackupDestination, S3BackupStore)> {
        let saved = self
            .store
            .lock()
            .await
            .destinations
            .iter()
            .find(|row| row.destination.id == id)
            .cloned()
            .context("Backup destination not found")?;
        let cipher = ryu_crypto::global_cipher()?;
        ensure!(
            ryu_crypto::FieldCipher::is_sealed(&saved.sealed_credentials),
            "Backup credentials are not sealed"
        );
        let credentials: Credentials =
            serde_json::from_str(&cipher.open(&saved.sealed_credentials)?)?;
        let key = encryption::parse_key(&credentials.recovery_key)?;
        let s3 = S3BackupStore::new(
            &saved.destination,
            &credentials.access_key_id,
            &credentials.secret_access_key,
            credentials.session_token.as_deref(),
            key,
        )
        .context("Unable to configure S3 backup client")?;
        Ok((saved.destination, s3))
    }

    pub async fn save_destination(
        &self,
        id: Option<String>,
        request: SaveBackupDestination,
    ) -> Result<BackupDestination> {
        ryu_backup::s3::validate(&request)?;
        let now = now();
        let destination = BackupDestination {
            id: id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name: request.name.trim().to_owned(),
            endpoint: request.endpoint.trim_end_matches('/').to_owned(),
            bucket: request.bucket.clone(),
            region: request.region.clone(),
            prefix: request.prefix.trim_matches('/').to_owned(),
            path_style: request.path_style,
            allow_http: request.allow_http,
            allowed_apps: request.allowed_apps.clone(),
            created_at: now,
        };
        let key = encryption::parse_key(&request.recovery_key)?;
        let s3 = S3BackupStore::new(
            &destination,
            &request.access_key_id,
            &request.secret_access_key,
            request.session_token.as_deref(),
            key,
        )?;
        s3.test().await.context("S3 connection validation failed. Check endpoint, bucket, region and read/write/list/delete permissions.")?;
        let credentials = Credentials {
            access_key_id: request.access_key_id,
            secret_access_key: request.secret_access_key,
            session_token: request.session_token,
            recovery_key: request.recovery_key,
        };
        let sealed = ryu_crypto::global_cipher()?.seal(&serde_json::to_string(&credentials)?)?;
        self.update(|store| {
            ensure!(
                !store
                    .operations
                    .iter()
                    .any(|entry| entry.operation.destination_id == destination.id
                        && matches!(entry.operation.status.as_str(), "pending" | "running")),
                "Destination has an active operation"
            );
            if let Some(id) = id {
                let row = store
                    .destinations
                    .iter_mut()
                    .find(|row| row.destination.id == id)
                    .context("Destination not found")?;
                // Edits rotate credentials/sharing only. Moving a catalog or
                // replacing its key would hide valid backups and break retention.
                ensure!(
                    row.destination.endpoint == destination.endpoint
                        && row.destination.bucket == destination.bucket
                        && row.destination.prefix == destination.prefix,
                    "Create a new destination to change its bucket, endpoint or prefix"
                );
                let old: Credentials = serde_json::from_str(
                    &ryu_crypto::global_cipher()?.open(&row.sealed_credentials)?,
                )?;
                ensure!(
                    encryption::parse_key(&old.recovery_key)? == key,
                    "Keep the same recovery key when updating a destination"
                );
                *row = StoredDestination {
                    destination: destination.clone(),
                    sealed_credentials: sealed,
                };
            } else {
                ensure!(
                    store.destinations.len() < 100,
                    "Too many backup destinations"
                );
                ensure!(
                    !store
                        .destinations
                        .iter()
                        .any(|row| row.destination.endpoint == destination.endpoint
                            && row.destination.bucket == destination.bucket
                            && row.destination.prefix == destination.prefix),
                    "This bucket and prefix already have a destination"
                );
                store.destinations.push(StoredDestination {
                    destination: destination.clone(),
                    sealed_credentials: sealed,
                });
            }
            Ok(destination)
        })
        .await
    }

    pub async fn delete_destination(&self, id: &str) -> Result<()> {
        self.update(|store| {
            ensure!(
                !store.policies.iter().any(|p| p.destination_id == id),
                "Remove this destination's backup schedules first"
            );
            ensure!(
                !store
                    .operations
                    .iter()
                    .any(|p| p.operation.destination_id == id
                        && matches!(p.operation.status.as_str(), "pending" | "running")),
                "Destination has an active operation"
            );
            ensure!(
                store.destinations.iter().any(|d| d.destination.id == id),
                "Destination not found"
            );
            store.destinations.retain(|d| d.destination.id != id);
            Ok(())
        })
        .await
    }

    pub async fn policies(&self) -> Vec<BackupPolicy> {
        self.store.lock().await.policies.clone()
    }

    pub async fn save_policy(&self, request: SaveBackupPolicy) -> Result<BackupPolicy> {
        scope_valid(&request.scope)?;
        ensure!(
            !matches!(request.scope, BackupScope::App { .. }),
            "Apps schedule their own snapshot submission"
        );
        CronSchedule::parse(&request.schedule).map_err(anyhow::Error::msg)?;
        ensure!(
            (1..=500).contains(&request.retention_count),
            "Retention must be between 1 and 500 backups"
        );
        self.destination(&request.destination_id).await?;
        self.update(|store| {
            let previous = store
                .policies
                .iter()
                .find(|p| p.destination_id == request.destination_id && p.scope == request.scope);
            let policy = BackupPolicy {
                id: previous.map_or_else(|| uuid::Uuid::new_v4().to_string(), |p| p.id.clone()),
                destination_id: request.destination_id,
                scope: request.scope,
                schedule: request.schedule,
                enabled: request.enabled,
                retention_count: request.retention_count,
                last_attempt_at: previous.and_then(|p| p.last_attempt_at.clone()),
            };
            store.policies.retain(|p| p.id != policy.id);
            ensure!(store.policies.len() < 500, "Too many backup schedules");
            store.policies.push(policy.clone());
            Ok(policy)
        })
        .await
    }

    pub async fn delete_policy(&self, id: &str) -> Result<()> {
        self.update(|store| {
            store.policies.retain(|p| p.id != id);
            Ok(())
        })
        .await
    }

    pub async fn operations(&self) -> Vec<BackupOperation> {
        self.store
            .lock()
            .await
            .operations
            .iter()
            .rev()
            .take(100)
            .map(|v| v.operation.clone())
            .collect()
    }

    pub async fn operation(&self, id: &str) -> Option<BackupOperation> {
        self.store
            .lock()
            .await
            .operations
            .iter()
            .find(|v| v.operation.id == id)
            .map(|v| v.operation.clone())
    }

    async fn begin(
        &self,
        destination: &str,
        scope: &BackupScope,
        action: &str,
        idempotency: &str,
        request_hash: String,
    ) -> Result<(BackupOperation, bool)> {
        scope_valid(scope)?;
        ensure!(
            !idempotency.is_empty()
                && idempotency.len() <= 128
                && idempotency
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b':' | b'.')),
            "A valid idempotencyKey is required"
        );
        self.update(|store| {
            if let Some(entry) = store.operations.iter().find(|v| {
                v.idempotency_key == idempotency
                    && v.operation.destination_id == destination
                    && v.operation.scope == *scope
            }) {
                ensure!(
                    entry.request_hash == request_hash && entry.operation.action == action,
                    "Idempotency key was already used for a different request"
                );
                return Ok((entry.operation.clone(), false));
            }
            ensure!(
                store
                    .operations
                    .iter()
                    .filter(|v| matches!(v.operation.status.as_str(), "pending" | "running"))
                    .count()
                    < 16,
                "Backup queue is full"
            );
            if store.operations.len() >= 1000 {
                let position = store
                    .operations
                    .iter()
                    .position(|v| !matches!(v.operation.status.as_str(), "pending" | "running"))
                    .context("Backup history is full")?;
                store.operations.remove(position);
            }
            let operation = BackupOperation {
                id: uuid::Uuid::new_v4().to_string(),
                destination_id: destination.to_owned(),
                scope: scope.clone(),
                action: action.to_owned(),
                status: "pending".into(),
                created_at: now(),
                completed_at: None,
                backup: None,
                error: None,
                result: None,
            };
            store.operations.push(StoredOperation {
                operation: operation.clone(),
                idempotency_key: idempotency.into(),
                request_hash,
            });
            Ok((operation, true))
        })
        .await
    }

    async fn set_operation(
        &self,
        id: &str,
        change: impl FnOnce(&mut BackupOperation),
    ) -> Result<()> {
        self.update(|store| {
            let row = store
                .operations
                .iter_mut()
                .find(|v| v.operation.id == id)
                .context("Backup operation not found")?;
            change(&mut row.operation);
            Ok(())
        })
        .await
    }

    pub async fn create(
        self: &Arc<Self>,
        state: ServerState,
        request: CreateBackup,
        app_data: Option<Value>,
    ) -> Result<BackupOperation> {
        let (_, s3) = self.destination(&request.destination_id).await?;
        let payload = app_data.map(|data| serde_json::to_vec(&data)).transpose()?;
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
        let mut hasher = Sha256::new();
        hasher.update(serde_json::to_vec(&request.scope)?);
        if let Some(data) = &payload {
            hasher.update(data);
        }
        let hash = hex::encode(hasher.finalize());
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
                request.backup_id.clone(),
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
fn install_recovered_keys(path: &Path, recovery: &Value, key: &[u8; 32]) -> Result<()> {
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

fn node_excluded(path: &Path) -> bool {
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

fn retained_candidates(records: Vec<BackupRecord>, source_node_id: &str) -> Vec<BackupRecord> {
    records
        .into_iter()
        .filter(|record| !source_node_id.is_empty() && record.source_node_id == source_node_id)
        .collect()
}

/// Node policies run with the operator-authorized node scope, not a stored user
/// JWT. Disabling/removing the policy prevents future runs; minute claims persist
/// before work is queued so a restart cannot replay the same cron tick.
pub fn start_scheduler(state: ServerState) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            let Ok(service) = global().await else {
                tracing::error!("Backup settings could not be loaded");
                continue;
            };
            let time = Utc::now()
                .with_second(0)
                .and_then(|v| v.with_nanosecond(0))
                .expect("valid minute");
            let minute = time.to_rfc3339();
            let due = service
                .update(|store| {
                    let mut due = Vec::new();
                    for policy in &mut store.policies {
                        if policy.enabled
                            && policy.last_attempt_at.as_deref() != Some(&minute)
                            && CronSchedule::parse(&policy.schedule)
                                .is_ok_and(|cron| cron.matches(time))
                        {
                            policy.last_attempt_at = Some(minute.clone());
                            due.push(policy.clone());
                        }
                    }
                    Ok(due)
                })
                .await;
            let Ok(due) = due else {
                tracing::error!("Could not persist backup schedule tick");
                continue;
            };
            for policy in due {
                let key = format!("schedule:{}:{}", policy.id, time.timestamp());
                if service
                    .create(
                        state.clone(),
                        CreateBackup {
                            destination_id: policy.destination_id,
                            scope: policy.scope,
                            idempotency_key: key,
                        },
                        None,
                    )
                    .await
                    .is_err()
                {
                    tracing::warn!(policy_id = %policy.id, "Scheduled backup could not be queued");
                }
            }
        }
    });
}
