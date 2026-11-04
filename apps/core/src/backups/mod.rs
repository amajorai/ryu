//! Core-owned backup orchestration. The HTTP and plugin bridges share this
//! service; credentials and resource scope never move into an app process.

mod archive;
mod request_digest;
mod restore;
mod schedule;
mod staging;
mod store;
#[cfg(test)]
mod tests;
pub use restore::RestoreBackup;
pub use schedule::start_scheduler;
pub(crate) use staging::sweep_stale_staging;
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

use crate::{scheduler::cron::CronSchedule, server::ServerState};
use request_digest::RequestDigest;
use store::{StoredDestination, StoredOperation};

pub const MAX_APP_BYTES: usize = 8 * 1024 * 1024;
const RECOVERY_FILE: &str = ".ryu-backup-recovery.json";
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
        request_hash: RequestDigest,
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
                    request_hash.matches(&entry.request_hash) && entry.operation.action == action,
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
                request_hash: request_hash.canonical,
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
}
