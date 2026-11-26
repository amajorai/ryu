//! The operations service: start, list, read, cancel and retry, plus the one
//! write path every change goes through.
//!
//! The records live in memory (the mirror) and in the store. Every change
//! takes the mirror's write lock, writes the store, updates the mirror and
//! publishes the event while it still holds the lock, so a listener that takes
//! a snapshot under the read lock and subscribes there misses nothing and sees
//! nothing twice.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use serde_json::Value;
use tokio::sync::{broadcast, RwLock};

use super::access::{valid_idempotency_key, OperationError, OperationEvent, Viewer};
use super::record::{
    new_id, now, NewOperation, OperationProgress, OperationRecord, OperationStatus,
};
use super::runner::{OperationRunner, RunnerRegistry};
use super::store::OperationStore;

/// Events a slow listener may fall behind before it is sent a fresh snapshot.
const EVENT_BUFFER: usize = 256;

pub(super) struct Inner {
    pub(super) store: OperationStore,
    pub(super) records: RwLock<BTreeMap<String, OperationRecord>>,
    pub(super) events: broadcast::Sender<OperationEvent>,
    pub(super) runners: RunnerRegistry,
    /// The stop flag of every run in this process, by operation id.
    pub(super) live: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub(super) recovered: tokio::sync::OnceCell<()>,
}

/// The operations service. Cheap to clone; every clone is the same service.
#[derive(Clone)]
pub struct OperationService {
    pub(super) inner: Arc<Inner>,
}

impl OperationService {
    /// A service over `store`. Nothing is read until the first call (or
    /// [`recover`](Self::recover)), so runners can be registered first.
    pub fn new(store: OperationStore) -> Self {
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        Self {
            inner: Arc::new(Inner {
                store,
                records: RwLock::new(BTreeMap::new()),
                events,
                runners: RunnerRegistry::default(),
                live: Mutex::new(HashMap::new()),
                recovered: tokio::sync::OnceCell::new(),
            }),
        }
    }

    /// Register the runner for `kind`. Call before [`recover`](Self::recover):
    /// an operation whose kind has no runner then cannot resume.
    pub fn register_runner(&self, kind: &str, runner: Arc<dyn OperationRunner>) {
        self.inner.runners.register(kind, runner);
    }

    /// Whether a runner is registered for `kind`.
    pub fn has_runner(&self, kind: &str) -> bool {
        self.inner.runners.get(kind).is_some()
    }

    pub(super) fn live(&self) -> MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.inner
            .live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Start an operation, or return the one a repeated request already
    /// started. The second value is whether a new operation was created.
    pub async fn start(
        &self,
        new: NewOperation,
    ) -> Result<(OperationRecord, bool), OperationError> {
        self.recover().await;
        let Some(registered) = self.inner.runners.get(&new.kind) else {
            return Err(OperationError::UnknownKind(new.kind));
        };
        if let Some(key) = new.idempotency_key.as_deref() {
            if !valid_idempotency_key(key) {
                return Err(OperationError::InvalidIdempotencyKey);
            }
        }
        let record = {
            // The check and the insert share one write lock, so two requests
            // with the same key cannot both create an operation.
            let mut records = self.inner.records.write().await;
            if let Some(key) = new.idempotency_key.as_deref() {
                let existing = records.values().find(|record| {
                    record.kind == new.kind
                        && record.owner_user_id == new.owner_user_id
                        && record.idempotency_key.as_deref() == Some(key)
                });
                if let Some(existing) = existing {
                    return if existing.input == new.input {
                        Ok((existing.clone(), false))
                    } else {
                        Err(OperationError::IdempotencyConflict)
                    };
                }
            }
            let at = now();
            let record = OperationRecord {
                id: new_id(),
                kind: new.kind,
                title: new.title,
                owner_user_id: new.owner_user_id,
                status: OperationStatus::Queued,
                progress: OperationProgress::default(),
                input: new.input,
                cursor: Value::Null,
                result: Value::Null,
                error: None,
                idempotency_key: new.idempotency_key,
                attempt: 0,
                resumable: registered.runner.resumable(),
                resumed: false,
                cancel_requested: false,
                created_at: at.clone(),
                updated_at: at,
                completed_at: None,
            };
            self.inner
                .store
                .save(&record)
                .await
                .map_err(|error| OperationError::Store(error.to_string()))?;
            records.insert(record.id.clone(), record.clone());
            self.publish(OperationEvent::Update {
                operation: record.summary(),
            });
            // Still under the lock, so a cancel never sees the new record
            // without its stop flag.
            self.spawn_run(record.id.clone());
            record
        };
        Ok((record, true))
    }

    /// The operations `viewer` may see, newest first, as summaries.
    pub async fn list(&self, viewer: &Viewer) -> Vec<OperationRecord> {
        self.recover().await;
        let records = self.inner.records.read().await;
        let mut visible: Vec<OperationRecord> = records
            .values()
            .filter(|record| viewer.can_see(record.owner_user_id.as_deref()))
            .map(OperationRecord::summary)
            .collect();
        visible.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        visible
    }

    /// One operation in full, when `viewer` may see it.
    pub async fn get(&self, id: &str, viewer: &Viewer) -> Result<OperationRecord, OperationError> {
        self.recover().await;
        self.visible(id, viewer).await
    }

    /// The stored record, or `NotFound` when it does not exist or `viewer`
    /// may not see it (the two are not told apart).
    pub(super) async fn visible(
        &self,
        id: &str,
        viewer: &Viewer,
    ) -> Result<OperationRecord, OperationError> {
        let records = self.inner.records.read().await;
        records
            .get(id)
            .filter(|record| viewer.can_see(record.owner_user_id.as_deref()))
            .cloned()
            .ok_or(OperationError::NotFound)
    }

    /// Ask an operation to stop. The runner stops between steps and what it
    /// did is kept. Cancelling a finished operation changes nothing.
    pub async fn cancel(
        &self,
        id: &str,
        viewer: &Viewer,
    ) -> Result<OperationRecord, OperationError> {
        self.recover().await;
        let record = self.visible(id, viewer).await?;
        if !record.status.is_active() {
            return Ok(record);
        }
        let flag = self.live().get(id).cloned();
        match flag {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                self.update_or_keep_in_memory(id, |record| {
                    if record.status.is_active() {
                        record.cancel_requested = true;
                    }
                })
                .await
            }
            // No task holds it (a record left active by a failed start).
            None => {
                self.finish(id, OperationStatus::Cancelled, None, None)
                    .await
            }
        }
    }

    /// Start a failed, cancelled or interrupted operation again. A resumable
    /// runner continues from the checkpoint; any other starts over.
    pub async fn retry(
        &self,
        id: &str,
        viewer: &Viewer,
    ) -> Result<OperationRecord, OperationError> {
        self.recover().await;
        let record = self.visible(id, viewer).await?;
        if !record.status.is_retryable() {
            return Err(OperationError::NotRetryable);
        }
        let Some(registered) = self.inner.runners.get(&record.kind) else {
            return Err(OperationError::UnknownKind(record.kind));
        };
        let resumable = registered.runner.resumable();
        // Two retries at once: only the one whose write made the change starts
        // the run.
        let queued = Arc::new(AtomicBool::new(false));
        let mark = queued.clone();
        let updated = self
            .update(id, true, move |record| {
                if !record.status.is_retryable() {
                    return;
                }
                record.status = OperationStatus::Queued;
                record.error = None;
                record.result = Value::Null;
                record.attempt = 0;
                record.resumed = false;
                record.cancel_requested = false;
                record.completed_at = None;
                record.resumable = resumable;
                if !resumable {
                    record.cursor = Value::Null;
                    record.progress = OperationProgress::default();
                }
                mark.store(true, Ordering::SeqCst);
            })
            .await?;
        if queued.load(Ordering::SeqCst) {
            self.spawn_run(id.to_owned());
        }
        Ok(updated)
    }

    /// The visible summaries as of one change, plus a receiver that delivers
    /// exactly the changes after it.
    pub async fn snapshot_and_subscribe(
        &self,
        viewer: &Viewer,
    ) -> (Vec<OperationRecord>, broadcast::Receiver<OperationEvent>) {
        self.recover().await;
        // Every change publishes under the write lock, so under the read lock
        // none can land between the two steps.
        let records = self.inner.records.read().await;
        let receiver = self.inner.events.subscribe();
        let mut visible: Vec<OperationRecord> = records
            .values()
            .filter(|record| viewer.can_see(record.owner_user_id.as_deref()))
            .map(OperationRecord::summary)
            .collect();
        drop(records);
        visible.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        (visible, receiver)
    }

    /// Wait until the operation is no longer queued or running and return it;
    /// `None` when it does not exist.
    pub async fn wait_until_finished(&self, id: &str) -> Option<OperationRecord> {
        use broadcast::error::RecvError;
        self.recover().await;
        loop {
            let (current, mut receiver) = {
                let records = self.inner.records.read().await;
                (records.get(id).cloned(), self.inner.events.subscribe())
            };
            let current = current?;
            if !current.status.is_active() {
                return Some(current);
            }
            loop {
                match receiver.recv().await {
                    Ok(OperationEvent::Update { operation })
                        if operation.id == id && !operation.status.is_active() =>
                    {
                        break;
                    }
                    Ok(OperationEvent::Removed { id: removed, .. }) if removed == id => break,
                    Ok(_) => {}
                    Err(RecvError::Lagged(_)) => break,
                    Err(RecvError::Closed) => return None,
                }
            }
        }
    }

    pub(super) fn publish(&self, event: OperationEvent) {
        // No listener is not an error.
        let _ = self.inner.events.send(event);
    }

    /// The one write path: change a record, optionally write it to the store,
    /// then publish. With `persist`, a store failure leaves the mirror as it
    /// was and is returned.
    pub(super) async fn update<F>(
        &self,
        id: &str,
        persist: bool,
        apply: F,
    ) -> Result<OperationRecord, OperationError>
    where
        F: FnOnce(&mut OperationRecord) + Send,
    {
        let mut records = self.inner.records.write().await;
        let Some(current) = records.get(id) else {
            return Err(OperationError::NotFound);
        };
        let mut next = current.clone();
        apply(&mut next);
        if next == *current {
            return Ok(next);
        }
        next.updated_at = now();
        if persist {
            self.inner
                .store
                .save(&next)
                .await
                .map_err(|error| OperationError::Store(error.to_string()))?;
        }
        records.insert(id.to_owned(), next.clone());
        self.publish(OperationEvent::Update {
            operation: next.summary(),
        });
        Ok(next)
    }

    /// [`update`](Self::update) with a write to the store; when the store
    /// refuses it the change is kept in memory, so a listener is not left
    /// looking at a state that is no longer true.
    pub(super) async fn update_or_keep_in_memory<F>(
        &self,
        id: &str,
        apply: F,
    ) -> Result<OperationRecord, OperationError>
    where
        F: Fn(&mut OperationRecord) + Send + Sync,
    {
        match self.update(id, true, &apply).await {
            Err(OperationError::Store(message)) => {
                tracing::warn!(operation = id, %message, "operation change kept in memory only");
                self.update(id, false, &apply).await
            }
            other => other,
        }
    }

    /// Show progress now; it reaches the store with the next write.
    pub(super) async fn set_progress(&self, id: &str, progress: OperationProgress) {
        let _ = self
            .update(id, false, move |record| record.progress = progress)
            .await;
    }

    /// Write the runner's checkpoint.
    pub(super) async fn set_cursor(&self, id: &str, cursor: Value) -> Result<(), OperationError> {
        self.update(id, true, move |record| record.cursor = cursor)
            .await
            .map(|_| ())
    }
}

/// The node's own service, on the sealed store under the state directory.
/// Fails while the store key is not available.
pub fn global() -> Result<OperationService, OperationError> {
    static SERVICE: OnceLock<OperationService> = OnceLock::new();
    if let Some(service) = SERVICE.get() {
        return Ok(service.clone());
    }
    let store =
        OperationStore::open_default().map_err(|error| OperationError::Store(error.to_string()))?;
    Ok(SERVICE.get_or_init(|| OperationService::new(store)).clone())
}
