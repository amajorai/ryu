//! The pluggable checkpoint-store seam: [`CheckpointStore`] plus the file and
//! in-memory implementations every build carries.
//!
//! A store is bound to one **namespace** (Core uses one per record family, for
//! example workflow runs and script workflows). Every backend implements the
//! same contract, which `tests/checkpoint_conformance.rs` checks against each of
//! them:
//!
//! - `get` of an absent id is `Ok(None)`, never an error;
//! - `put` is an atomic create-or-replace: a reader sees the previous complete
//!   state or the new one, never a torn mix, and the last write wins;
//! - `delete` reports whether a record existed;
//! - `list` returns the ids present in this namespace, sorted bytewise;
//! - namespaces never see each other's records;
//! - ids are validated by [`validate_id`](crate::validate_id) before any backend
//!   I/O, so no backend ever receives a path- or key-injection id;
//! - a record written through one handle is visible through a fresh handle
//!   opened from the same configuration (durability across restarts is the
//!   backend's: `fsync`+rename for files, commit for Postgres, AOF/RDB for Redis).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::{validate_id, BoxFuture, FileCheckpointStore};

/// Errors a [`CheckpointStore`] reports.
#[derive(Debug)]
pub enum CheckpointError {
    /// The id or namespace fails [`validate_id`](crate::validate_id).
    InvalidId(String),
    /// The record could not be (de)serialized.
    Serialization(String),
    /// The configuration is incomplete or names a backend this build lacks.
    Config(String),
    /// The backend failed (I/O, connection, server error). Never carries
    /// credentials: connection strings are redacted before they reach here.
    Backend {
        backend: &'static str,
        message: String,
    },
}

impl CheckpointError {
    pub(crate) fn backend(backend: &'static str, message: impl std::fmt::Display) -> Self {
        Self::Backend {
            backend,
            message: message.to_string(),
        }
    }
}

impl std::fmt::Display for CheckpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidId(message) => write!(f, "invalid checkpoint id: {message}"),
            Self::Serialization(message) => write!(f, "checkpoint serialization failed: {message}"),
            Self::Config(message) => write!(f, "checkpoint store configuration: {message}"),
            Self::Backend { backend, message } => {
                write!(f, "{backend} checkpoint store failed: {message}")
            }
        }
    }
}

impl std::error::Error for CheckpointError {}

impl From<CheckpointError> for std::io::Error {
    fn from(error: CheckpointError) -> Self {
        let kind = match &error {
            CheckpointError::InvalidId(_) | CheckpointError::Config(_) => {
                std::io::ErrorKind::InvalidInput
            }
            CheckpointError::Serialization(_) => std::io::ErrorKind::InvalidData,
            CheckpointError::Backend { .. } => std::io::ErrorKind::Other,
        };
        Self::new(kind, error.to_string())
    }
}

/// Validate an id (or namespace) for a checkpoint verb.
pub(crate) fn checked_id(id: &str) -> Result<(), CheckpointError> {
    validate_id(id).map_err(|error| CheckpointError::InvalidId(error.to_string()))
}

/// A namespaced, durable JSON record store: the swap seam behind checkpoint /
/// resume. Object-safe (methods return [`BoxFuture`]) so it can be held as
/// `Arc<dyn CheckpointStore>` and chosen at runtime from configuration.
pub trait CheckpointStore: Send + Sync + std::fmt::Debug {
    /// Stable backend id: `"file"`, `"memory"`, `"postgres"`, or `"redis"`.
    fn backend(&self) -> &'static str;

    /// Create or atomically replace the record under `id`.
    fn put<'a>(
        &'a self,
        id: &'a str,
        state: &'a Value,
    ) -> BoxFuture<'a, Result<(), CheckpointError>>;

    /// Load the record under `id`; `Ok(None)` when it does not exist.
    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Value>, CheckpointError>>;

    /// Remove the record under `id`, returning whether it existed.
    fn delete<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<bool, CheckpointError>>;

    /// Ids present in this namespace, sorted bytewise ascending.
    fn list(&self) -> BoxFuture<'_, Result<Vec<String>, CheckpointError>>;
}

/// Serialize `value` and [`put`](CheckpointStore::put) it under `id`.
pub async fn save<T: Serialize + ?Sized>(
    store: &dyn CheckpointStore,
    id: &str,
    value: &T,
) -> Result<(), CheckpointError> {
    let state = serde_json::to_value(value)
        .map_err(|error| CheckpointError::Serialization(error.to_string()))?;
    store.put(id, &state).await
}

/// [`get`](CheckpointStore::get) the record under `id` and deserialize it.
pub async fn load<T: DeserializeOwned>(
    store: &dyn CheckpointStore,
    id: &str,
) -> Result<Option<T>, CheckpointError> {
    match store.get(id).await? {
        Some(state) => serde_json::from_value(state)
            .map(Some)
            .map_err(|error| CheckpointError::Serialization(error.to_string())),
        None => Ok(None),
    }
}

// ── File backend ─────────────────────────────────────────────────────────────

impl FileCheckpointStore {
    /// Remove the record under `id`, returning whether it existed.
    pub fn remove(&self, id: &str) -> std::io::Result<bool> {
        validate_id(id)?;
        match std::fs::remove_file(self.dir.join(format!("{id}.json"))) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Ids of the records in this directory, sorted bytewise. A missing
    /// directory is an empty store; leftover `*.json.tmp` files from an
    /// interrupted write are ignored.
    pub fn ids(&self) -> std::io::Result<Vec<String>> {
        let entries = match std::fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut ids = Vec::new();
        for entry in entries {
            let name = entry?.file_name();
            let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
                continue;
            };
            if validate_id(id).is_ok() {
                ids.push(id.to_owned());
            }
        }
        ids.sort();
        Ok(ids)
    }
}

fn file_error(error: std::io::Error) -> CheckpointError {
    match error.kind() {
        std::io::ErrorKind::InvalidInput => CheckpointError::InvalidId(error.to_string()),
        std::io::ErrorKind::InvalidData => CheckpointError::Serialization(error.to_string()),
        _ => CheckpointError::backend("file", error),
    }
}

/// The file backend runs its (small, local) synchronous I/O inline in the
/// returned future, so it works under any executor or none; it is the same
/// temp + `fsync` + rename path as [`FileCheckpointStore::save`].
impl CheckpointStore for FileCheckpointStore {
    fn backend(&self) -> &'static str {
        "file"
    }

    fn put<'a>(
        &'a self,
        id: &'a str,
        state: &'a Value,
    ) -> BoxFuture<'a, Result<(), CheckpointError>> {
        Box::pin(async move { self.save(id, state).map_err(file_error) })
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Value>, CheckpointError>> {
        Box::pin(async move {
            match self.load::<Value>(id) {
                Ok(state) => Ok(Some(state)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(file_error(error)),
            }
        })
    }

    fn delete<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<bool, CheckpointError>> {
        Box::pin(async move { self.remove(id).map_err(file_error) })
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<String>, CheckpointError>> {
        Box::pin(async move { self.ids().map_err(file_error) })
    }
}

// ── In-memory backend ────────────────────────────────────────────────────────

type MemoryRecords = BTreeMap<(String, String), Value>;

/// A process-local store for tests and ephemeral runs. Handles made with
/// [`MemoryCheckpointStore::namespace`] share one map, so a "fresh handle"
/// from the same backend sees earlier writes; nothing survives the process.
#[derive(Debug, Clone)]
pub struct MemoryCheckpointStore {
    namespace: String,
    records: Arc<Mutex<MemoryRecords>>,
}

impl Default for MemoryCheckpointStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryCheckpointStore {
    /// A new, empty store bound to the `default` namespace.
    pub fn new() -> Self {
        Self {
            namespace: "default".to_owned(),
            records: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    /// Another handle onto the same records, bound to `namespace`.
    pub fn namespace(&self, namespace: &str) -> Result<Self, CheckpointError> {
        checked_id(namespace)?;
        Ok(Self {
            namespace: namespace.to_owned(),
            records: Arc::clone(&self.records),
        })
    }

    fn records(&self) -> std::sync::MutexGuard<'_, MemoryRecords> {
        // A panic while holding the lock cannot leave a record half-written
        // (each verb is one map operation), so a poisoned lock is still sound.
        self.records
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn key(&self, id: &str) -> (String, String) {
        (self.namespace.clone(), id.to_owned())
    }
}

impl CheckpointStore for MemoryCheckpointStore {
    fn backend(&self) -> &'static str {
        "memory"
    }

    fn put<'a>(
        &'a self,
        id: &'a str,
        state: &'a Value,
    ) -> BoxFuture<'a, Result<(), CheckpointError>> {
        Box::pin(async move {
            checked_id(id)?;
            self.records().insert(self.key(id), state.clone());
            Ok(())
        })
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Value>, CheckpointError>> {
        Box::pin(async move {
            checked_id(id)?;
            Ok(self.records().get(&self.key(id)).cloned())
        })
    }

    fn delete<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<bool, CheckpointError>> {
        Box::pin(async move {
            checked_id(id)?;
            Ok(self.records().remove(&self.key(id)).is_some())
        })
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<String>, CheckpointError>> {
        Box::pin(async move {
            Ok(self
                .records()
                .keys()
                .filter(|(namespace, _)| *namespace == self.namespace)
                .map(|(_, id)| id.clone())
                .collect())
        })
    }
}
