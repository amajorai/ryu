//! Core-owned durable storage for recursive-improvement runs.
//!
//! The [`ryu_improvement_contracts`] crate owns the pure wire model and
//! lifecycle rules. This crate owns only the node-local SQLite projection. It
//! does not execute candidates, call providers, or decide policy; those remain
//! Core/Gateway/owning-app responsibilities.

use std::fmt;
use std::path::Path;
use std::sync::Arc;

use rusqlite::{params, Connection, ErrorCode, OptionalExtension};
use ryu_improvement_contracts::{ContractError, ImprovementRun, ImprovementRunRef};
use tokio::sync::Mutex;

const MAX_LIST_LIMIT: u32 = 100;

/// Errors returned by the durable improvement store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    Contract(String),
    Conflict(String),
    NotFound(String),
    Database(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Contract(message) => write!(formatter, "contract error: {message}"),
            Self::Conflict(message) => write!(formatter, "conflict: {message}"),
            Self::NotFound(message) => write!(formatter, "not found: {message}"),
            Self::Database(message) => write!(formatter, "database error: {message}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<ContractError> for StoreError {
    fn from(error: ContractError) -> Self {
        Self::Contract(error.to_string())
    }
}

/// SQLite-backed improvement-run store. Clones share the same connection.
#[derive(Clone)]
pub struct ImprovementStore {
    conn: Arc<Mutex<Connection>>,
}

impl ImprovementStore {
    /// Open or create a store at an explicit path. Core chooses the default
    /// `<RYU_DIR>/improvements.db` path at startup.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| StoreError::Database(format!("creating db dir: {error}")))?;
        }
        let connection = Connection::open(path.as_ref())
            .map_err(|error| StoreError::Database(format!("opening db: {error}")))?;
        init_schema(&connection)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(connection)),
        })
    }

    /// Open an isolated in-memory store for service and route tests.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let connection = Connection::open_in_memory()
            .map_err(|error| StoreError::Database(format!("opening in-memory db: {error}")))?;
        init_schema(&connection)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(connection)),
        })
    }

    /// Insert a new draft. Reusing an id is a conflict, never an overwrite.
    pub async fn create(&self, run: &ImprovementRun) -> Result<(), StoreError> {
        validate_run(run)?;
        let json = serialize_run(run)?;
        let connection = self.conn.lock().await;
        match connection.execute(
            "INSERT INTO improvement_runs
             (id, status, created_at, updated_at, json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                run.id,
                run.status().as_str(),
                run.created_at(),
                run.updated_at(),
                json,
            ],
        ) {
            Ok(_) => Ok(()),
            Err(rusqlite::Error::SqliteFailure(error, _))
                if error.code == ErrorCode::ConstraintViolation =>
            {
                Err(StoreError::Conflict(format!(
                    "improvement run `{}` already exists",
                    run.id
                )))
            }
            Err(error) => Err(StoreError::Database(format!(
                "creating improvement run: {error}"
            ))),
        }
    }

    /// Read one run. A malformed stored record is an error, not an empty result.
    pub async fn get(&self, id: &str) -> Result<Option<ImprovementRun>, StoreError> {
        ImprovementRunRef::new(id.to_owned())?;
        let connection = self.conn.lock().await;
        let json = connection
            .query_row(
                "SELECT json FROM improvement_runs WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| StoreError::Database(format!("reading improvement run: {error}")))?;
        json.map(|value| deserialize_run(&value)).transpose()
    }

    /// List the newest bounded projections. The store clamps the caller's
    /// limit so a client cannot request an unbounded local read.
    pub async fn list(&self, limit: u32) -> Result<Vec<ImprovementRun>, StoreError> {
        let limit = limit.clamp(1, MAX_LIST_LIMIT);
        let connection = self.conn.lock().await;
        let mut statement = connection
            .prepare(
                "SELECT json FROM improvement_runs
                 ORDER BY updated_at DESC, id DESC LIMIT ?1",
            )
            .map_err(|error| {
                StoreError::Database(format!("preparing improvement list: {error}"))
            })?;
        let rows = statement
            .query_map(params![limit], |row| row.get::<_, String>(0))
            .map_err(|error| StoreError::Database(format!("querying improvement list: {error}")))?;
        let mut runs = Vec::new();
        for row in rows {
            let json = row.map_err(|error| {
                StoreError::Database(format!("reading improvement list row: {error}"))
            })?;
            runs.push(deserialize_run(&json)?);
        }
        Ok(runs)
    }

    /// Replace one existing record after the caller has applied a validated
    /// lifecycle transition. The update is atomic at the SQLite statement.
    pub async fn update(&self, run: &ImprovementRun) -> Result<(), StoreError> {
        validate_run(run)?;
        let json = serialize_run(run)?;
        let connection = self.conn.lock().await;
        let changed = connection
            .execute(
                "UPDATE improvement_runs
                 SET status = ?2, created_at = ?3, updated_at = ?4, json = ?5
                 WHERE id = ?1",
                params![
                    run.id,
                    run.status().as_str(),
                    run.created_at(),
                    run.updated_at(),
                    json,
                ],
            )
            .map_err(|error| StoreError::Database(format!("updating improvement run: {error}")))?;
        if changed == 0 {
            return Err(StoreError::NotFound(format!(
                "improvement run `{}` does not exist",
                run.id
            )));
        }
        Ok(())
    }

    /// Load, mutate, validate, and persist one run while holding the store
    /// mutex. This is the linearizable transition primitive used by Core's
    /// HTTP API; callers cannot race a GET against a later UPDATE.
    pub async fn mutate<F>(&self, id: &str, mutator: F) -> Result<ImprovementRun, StoreError>
    where
        F: FnOnce(&mut ImprovementRun) -> Result<(), StoreError>,
    {
        ImprovementRunRef::new(id.to_owned())?;
        let connection = self.conn.lock().await;
        let json = connection
            .query_row(
                "SELECT json FROM improvement_runs WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| StoreError::Database(format!("reading improvement run: {error}")))?
            .ok_or_else(|| {
                StoreError::NotFound(format!("improvement run `{id}` does not exist"))
            })?;
        let mut run = deserialize_run(&json)?;
        mutator(&mut run)?;
        validate_run(&run)?;
        let serialized = serialize_run(&run)?;
        let changed = connection
            .execute(
                "UPDATE improvement_runs
                 SET status = ?2, created_at = ?3, updated_at = ?4, json = ?5
                 WHERE id = ?1",
                params![
                    run.id,
                    run.status().as_str(),
                    run.created_at(),
                    run.updated_at(),
                    serialized,
                ],
            )
            .map_err(|error| StoreError::Database(format!("mutating improvement run: {error}")))?;
        if changed == 0 {
            return Err(StoreError::NotFound(format!(
                "improvement run `{id}` does not exist"
            )));
        }
        Ok(run)
    }
}

fn init_schema(connection: &Connection) -> Result<(), StoreError> {
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS improvement_runs (
                 id TEXT PRIMARY KEY,
                 status TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 json TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS improvement_runs_updated_idx
                 ON improvement_runs(updated_at DESC, id DESC);",
        )
        .map_err(|error| StoreError::Database(format!("initializing improvement schema: {error}")))
}

fn validate_run(run: &ImprovementRun) -> Result<(), StoreError> {
    run.validate().map_err(StoreError::from)
}

fn serialize_run(run: &ImprovementRun) -> Result<String, StoreError> {
    serde_json::to_string(run)
        .map_err(|error| StoreError::Database(format!("serializing improvement run: {error}")))
}

fn deserialize_run(json: &str) -> Result<ImprovementRun, StoreError> {
    let run: ImprovementRun = serde_json::from_str(json)
        .map_err(|error| StoreError::Database(format!("deserializing improvement run: {error}")))?;
    validate_run(&run)?;
    Ok(run)
}

trait ImprovementRunFields {
    fn status(&self) -> ryu_improvement_contracts::ImprovementStatus;
    fn created_at(&self) -> &str;
    fn updated_at(&self) -> &str;
}

impl ImprovementRunFields for ImprovementRun {
    fn status(&self) -> ryu_improvement_contracts::ImprovementStatus {
        self.status
    }

    fn created_at(&self) -> &str {
        &self.created_at
    }

    fn updated_at(&self) -> &str {
        &self.updated_at
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_improvement_contracts::{
        ArtifactKind, ArtifactRef, ImprovementProvenance, ImprovementStatus,
    };

    fn draft(id: &str) -> ImprovementRun {
        ImprovementRun::new(
            id,
            "Improve a Ryu workflow",
            ArtifactKind::Workflow,
            ArtifactRef {
                kind: ArtifactKind::Workflow,
                id: "workflow-baseline".to_owned(),
                version: Some("1.0.0".to_owned()),
                digest: None,
            },
            ImprovementProvenance {
                source: "manual".to_owned(),
                ..Default::default()
            },
            "2026-09-11T00:00:00Z",
        )
        .unwrap()
    }

    #[tokio::test]
    async fn create_get_update_and_list_are_durable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("improvements.db");
        let store = ImprovementStore::open(&path).unwrap();
        let run = draft("improvement-1");
        store.create(&run).await.unwrap();
        assert_eq!(store.get("improvement-1").await.unwrap(), Some(run.clone()));
        assert_eq!(store.list(100).await.unwrap().len(), 1);

        let mut updated = run;
        updated.transition_to(ImprovementStatus::Baseline).unwrap();
        store.update(&updated).await.unwrap();

        let reopened = ImprovementStore::open(&path).unwrap();
        assert_eq!(
            reopened.get("improvement-1").await.unwrap().unwrap().status,
            ImprovementStatus::Baseline
        );
    }

    #[tokio::test]
    async fn duplicate_and_missing_updates_are_explicit() {
        let store = ImprovementStore::open_in_memory().unwrap();
        let run = draft("improvement-1");
        store.create(&run).await.unwrap();
        assert!(matches!(
            store.create(&run).await,
            Err(StoreError::Conflict(_))
        ));
        let missing = draft("improvement-2");
        assert!(matches!(
            store.update(&missing).await,
            Err(StoreError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn mutate_is_atomic_when_the_transition_fails() {
        let store = ImprovementStore::open_in_memory().unwrap();
        store.create(&draft("improvement-1")).await.unwrap();
        let result = store
            .mutate("improvement-1", |run| {
                run.transition_to(ImprovementStatus::Promoted)
                    .map_err(StoreError::from)
            })
            .await;
        assert!(matches!(result, Err(StoreError::Contract(_))));
        assert_eq!(
            store.get("improvement-1").await.unwrap().unwrap().status,
            ImprovementStatus::Draft
        );
    }
}
