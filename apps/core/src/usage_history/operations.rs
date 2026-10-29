//! Durable progress for local imports. Separate from the ledger so a long source
//! transaction cannot block the progress endpoint. No source paths or contents
//! are stored here; per-file ledger checkpoints make interrupted work resumable.
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::ImportReport;

#[derive(Clone, Debug, Serialize, Deserialize, utoipa::ToSchema)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum ImportOperation {
    Running {
        id: String,
        started_at: String,
        progress: ImportReport,
    },
    Completed {
        id: String,
        started_at: String,
        completed_at: String,
        report: ImportReport,
    },
    Failed {
        id: String,
        started_at: String,
        completed_at: String,
        error: String,
    },
}

impl ImportOperation {
    pub(crate) fn id(&self) -> &str {
        match self {
            Self::Running { id, .. } | Self::Completed { id, .. } | Self::Failed { id, .. } => id,
        }
    }
}

#[derive(Clone)]
pub(crate) struct ImportOperations {
    connection: Arc<Mutex<Connection>>,
}

impl ImportOperations {
    pub(crate) fn open_default() -> Result<Self> {
        Self::open(&crate::paths::db_path("usage-history-operations.db"))
    }
    pub(crate) fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(2))?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > 1 {
            bail!("Unsupported usage history operation schema");
        }
        connection.execute_batch("CREATE TABLE IF NOT EXISTS history_import_operations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, state TEXT NOT NULL, request_digest TEXT NOT NULL, data TEXT NOT NULL); PRAGMA user_version=1;")?;
        let interrupted = {
            let mut statement = connection
                .prepare("SELECT data FROM history_import_operations WHERE state='running'")?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let store = Self {
            connection: Arc::new(Mutex::new(connection)),
        };
        for data in interrupted {
            if let ImportOperation::Running { id, started_at, .. } = serde_json::from_str(&data)? {
                store.update(&ImportOperation::Failed { id, started_at, completed_at: chrono::Utc::now().to_rfc3339(), error: "The node restarted during this import. Import the same selection to resume its saved checkpoints.".into() })?;
            }
        }
        Ok(store)
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| anyhow!("Usage import operation store unavailable"))
    }
    pub(crate) fn start(&self, request_digest: &str) -> Result<(ImportOperation, bool)> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction()?;
        let existing = transaction.query_row("SELECT request_digest,data FROM history_import_operations WHERE state='running' ORDER BY created_at DESC LIMIT 1", [], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?))).optional()?;
        if let Some((digest, data)) = existing {
            if digest != request_digest {
                bail!("A different import is already running");
            }
            return Ok((serde_json::from_str(&data)?, false));
        }
        let operation = ImportOperation::Running {
            id: uuid::Uuid::new_v4().to_string(),
            started_at: chrono::Utc::now().to_rfc3339(),
            progress: ImportReport::default(),
        };
        let started = match &operation {
            ImportOperation::Running { started_at, .. } => started_at,
            _ => unreachable!(),
        };
        transaction.execute("INSERT INTO history_import_operations(id,created_at,state,request_digest,data) VALUES(?1,?2,'running',?3,?4)",params![operation.id(),started,request_digest,serde_json::to_string(&operation)?])?;
        transaction.execute("DELETE FROM history_import_operations WHERE state!='running' AND id NOT IN (SELECT id FROM history_import_operations WHERE state!='running' ORDER BY created_at DESC LIMIT 100)",[])?;
        transaction.commit()?;
        Ok((operation, true))
    }
    pub(crate) fn get(&self, id: &str) -> Result<Option<ImportOperation>> {
        uuid::Uuid::parse_str(id)?;
        let data = self
            .lock()?
            .query_row(
                "SELECT data FROM history_import_operations WHERE id=?1",
                [id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        data.map(|data| serde_json::from_str(&data).map_err(Into::into))
            .transpose()
    }
    pub(crate) fn update(&self, operation: &ImportOperation) -> Result<()> {
        let state = match operation {
            ImportOperation::Running { .. } => "running",
            ImportOperation::Completed { .. } => "completed",
            ImportOperation::Failed { .. } => "failed",
        };
        self.lock()?.execute(
            "UPDATE history_import_operations SET state=?1,data=?2 WHERE id=?3",
            params![state, serde_json::to_string(operation)?, operation.id()],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeat_start_reuses_running_job_and_restart_preserves_checkpoint_message() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("operations.db");
        let store = ImportOperations::open(&path).unwrap();
        let (first, started) = store.start("selection-digest").unwrap();
        assert!(started);
        let (repeat, started) = store.start("selection-digest").unwrap();
        assert!(!started);
        assert_eq!(first.id(), repeat.id());
        assert!(store.start("another-digest").is_err());
        drop(store);
        let reopened = ImportOperations::open(&path).unwrap();
        assert!(matches!(
            reopened.get(first.id()).unwrap(),
            Some(ImportOperation::Failed { .. })
        ));
        assert!(reopened.start("selection-digest").unwrap().1);
    }
    #[test]
    fn report_is_durable_and_operation_wire_contract_is_camel_case() {
        let directory = tempfile::tempdir().unwrap();
        let store = ImportOperations::open(&directory.path().join("operations.db")).unwrap();
        let (running, _) = store.start("digest").unwrap();
        let completed = ImportOperation::Completed {
            id: running.id().into(),
            started_at: "2026-10-01T00:00:00Z".into(),
            completed_at: "2026-10-01T00:01:00Z".into(),
            report: ImportReport {
                imported_records: 42,
                ..Default::default()
            },
        };
        store.update(&completed).unwrap();
        let value = serde_json::to_value(store.get(running.id()).unwrap().unwrap()).unwrap();
        assert_eq!(value["state"], "completed");
        assert_eq!(value["report"]["importedRecords"], 42);
        assert!(value.get("completedAt").is_some());
        assert!(store.get("invalid-id").is_err());
    }
}
