use std::{path::PathBuf, sync::Arc};

use anyhow::{ensure, Context, Result};
use ryu_backup::{BackupDestination, BackupOperation, BackupPolicy};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredDestination {
    pub destination: BackupDestination,
    pub sealed_credentials: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredOperation {
    pub operation: BackupOperation,
    pub idempotency_key: String,
    pub request_hash: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Store {
    pub version: u32,
    #[serde(default = "new_node_id")]
    pub node_id: String,
    pub destinations: Vec<StoredDestination>,
    pub policies: Vec<BackupPolicy>,
    pub operations: Vec<StoredOperation>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            version: 1,
            node_id: new_node_id(),
            destinations: vec![],
            policies: vec![],
            operations: vec![],
        }
    }
}

fn new_node_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub struct BackupService {
    pub(super) root: PathBuf,
    pub(super) store: Mutex<Store>,
    /// One snapshot/restore at a time bounds disk pressure and retention races.
    pub(super) work: Arc<tokio::sync::Semaphore>,
}

impl BackupService {
    pub fn open(root: PathBuf) -> Result<Self> {
        let path = state_dir(&root).join("state.json");
        let mut store: Store = match std::fs::read(&path) {
            Ok(bytes) => {
                ensure!(bytes.len() <= 4 * 1024 * 1024, "Backup state is too large");
                serde_json::from_slice(&bytes)
                    .context("Backup settings are damaged; original file preserved")?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Store::default(),
            Err(error) => return Err(error.into()),
        };
        ensure!(
            store.version == 1
                && store.destinations.len() <= 100
                && store.policies.len() <= 500
                && store.operations.len() <= 1000,
            "Unsupported or oversized backup settings"
        );
        for entry in &mut store.operations {
            if matches!(entry.operation.status.as_str(), "pending" | "running") {
                entry.operation.status = "failed".into();
                entry.operation.error = Some("Backup operation was interrupted by a node restart. Retry with a new request ID.".into());
                entry.operation.completed_at = Some(super::now());
            }
        }
        // Persist crash recovery before accepting new work.
        if path.exists() {
            persist(&root, &store)?;
        }
        // Staging from an interrupted job may hold SQLite snapshot copies or
        // a half-extracted recovery tree; nothing is running yet, so clear it.
        super::sweep_stale_staging(&root);
        Ok(Self {
            root,
            store: Mutex::new(store),
            work: Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }

    pub(super) async fn update<T>(
        &self,
        change: impl FnOnce(&mut Store) -> Result<T>,
    ) -> Result<T> {
        let mut current = self.store.lock().await;
        let mut next = current.clone();
        let result = change(&mut next)?;
        let root = self.root.clone();
        let saved = next.clone();
        tokio::task::spawn_blocking(move || persist(&root, &saved)).await??;
        *current = next;
        Ok(result)
    }
}

/// `<data dir>/state/backups` — backup destinations, policies and operations.
pub(super) fn state_dir(root: &std::path::Path) -> PathBuf {
    ryu_sidecar_runtime::layout::state_path(root, "backups")
}

fn persist(root: &std::path::Path, store: &Store) -> Result<()> {
    use std::io::Write;
    let directory = state_dir(root);
    ryu_backup::archive::private_directory(&directory)?;
    let bytes = serde_json::to_vec(store)?;
    ensure!(bytes.len() <= 4 * 1024 * 1024, "Backup state is too large");
    let mut file = tempfile::NamedTempFile::new_in(&directory)?;
    file.write_all(&bytes)?;
    file.as_file().sync_all()?;
    file.persist(directory.join("state.json"))?;
    Ok(())
}
