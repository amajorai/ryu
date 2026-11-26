//! What happens to an operation without a request: the detached run, the
//! recovery when the node starts, and the retention sweep.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::FutureExt as _;
use serde_json::Value;

use super::access::{OperationError, OperationEvent};
use super::record::{now, OperationRecord, OperationStatus, MAX_ATTEMPTS};
use super::runner::OperationContext;
use super::service::OperationService;
use super::store::expired_ids;

/// The error an operation carries when a restart ended it and it was not
/// resumed. The status says the same in a machine-readable way.
const INTERRUPTED: &str = "Interrupted by a node restart.";
const ATTEMPTS_USED_UP: &str =
    "Stopped after 3 starts that each ended with a node restart. Retry starts it again.";
const STOPPED_UNEXPECTEDLY: &str = "The operation stopped unexpectedly.";

impl OperationService {
    /// Load the stored records and settle the ones a restart left queued or
    /// running: a resumable kind with attempts left is queued again and
    /// continues from its checkpoint; anything else becomes `interrupted`.
    /// Runs once; every public call waits for it, so calling it at startup is
    /// an optimization, not a requirement.
    pub async fn recover(&self) {
        self.inner
            .recovered
            .get_or_init(|| self.recover_once())
            .await;
    }

    async fn recover_once(&self) {
        let loaded = match self.inner.store.load_all().await {
            Ok(loaded) => loaded,
            Err(error) => {
                tracing::warn!(%error, "stored operations could not be read");
                Vec::new()
            }
        };
        let mut resumed = Vec::new();
        {
            let mut records = self.inner.records.write().await;
            for mut record in loaded {
                if record.status.is_active() {
                    let resume = self.settle_after_restart(&mut record);
                    if let Err(error) = self.inner.store.save(&record).await {
                        tracing::warn!(operation = %record.id, %error, "recovered operation could not be saved");
                    }
                    if resume {
                        resumed.push(record.id.clone());
                    }
                }
                records.insert(record.id.clone(), record);
            }
        }
        self.prune().await;
        for id in resumed {
            self.spawn_run(id);
        }
    }

    /// Decide what a record that was active when the node stopped becomes.
    /// Returns whether it runs again.
    fn settle_after_restart(&self, record: &mut OperationRecord) -> bool {
        let at = now();
        record.updated_at = at.clone();
        if record.cancel_requested {
            record.status = OperationStatus::Cancelled;
            record.cancel_requested = false;
            record.completed_at = Some(at);
            return false;
        }
        let resumable = self
            .inner
            .runners
            .get(&record.kind)
            .is_some_and(|registered| registered.runner.resumable());
        if resumable && record.attempt < MAX_ATTEMPTS {
            record.status = OperationStatus::Queued;
            record.resumed = true;
            record.resumable = true;
            return true;
        }
        record.status = OperationStatus::Interrupted;
        record.error = Some(
            if resumable {
                ATTEMPTS_USED_UP
            } else {
                INTERRUPTED
            }
            .to_owned(),
        );
        record.completed_at = Some(at);
        false
    }

    /// Run the operation on its own task. The stop flag is registered before
    /// the task starts, so a cancel that arrives at once finds it.
    pub(super) fn spawn_run(&self, id: String) {
        let cancel = Arc::new(AtomicBool::new(false));
        self.live().insert(id.clone(), cancel.clone());
        let service = self.clone();
        tokio::spawn(async move {
            service.run(&id, cancel.clone()).await;
            {
                // A retry may already have registered the next run's flag
                // under this id; only this run's own flag is removed.
                let mut live = service.live();
                if live.get(&id).is_some_and(|flag| Arc::ptr_eq(flag, &cancel)) {
                    live.remove(&id);
                }
            }
            service.prune().await;
        });
    }

    async fn run(&self, id: &str, cancel: Arc<AtomicBool>) {
        let kind = {
            let records = self.inner.records.read().await;
            match records.get(id) {
                Some(record) => record.kind.clone(),
                None => return,
            }
        };
        let Some(registered) = self.inner.runners.get(&kind) else {
            let error = OperationError::UnknownKind(kind).to_string();
            let _ = self
                .finish(id, OperationStatus::Failed, Some(error), None)
                .await;
            return;
        };
        // One operation of a kind at a time; the record stays queued while it
        // waits for its turn.
        let _turn = registered.turn.lock().await;
        if cancel.load(Ordering::SeqCst) {
            let _ = self
                .finish(id, OperationStatus::Cancelled, None, None)
                .await;
            return;
        }
        // The attempt is counted and written before any work. If this run
        // takes the node down, the next start sees the count and the cap
        // ends the loop.
        let started = self
            .update(id, true, |record| {
                // Only a queued operation starts: a cancel may have settled it
                // while it waited.
                if record.status != OperationStatus::Queued {
                    return;
                }
                record.attempt += 1;
                record.status = OperationStatus::Running;
                record.error = None;
                record.completed_at = None;
            })
            .await;
        let record = match started {
            Ok(record) if record.status == OperationStatus::Running => record,
            Ok(_) => return,
            Err(error) => {
                // Not written, so not started: an uncounted attempt could loop.
                let _ = self
                    .finish(id, OperationStatus::Failed, Some(error.to_string()), None)
                    .await;
                return;
            }
        };
        let context = OperationContext::new(self.clone(), record, cancel.clone());
        let outcome = std::panic::AssertUnwindSafe(registered.runner.run(context))
            .catch_unwind()
            .await;
        let (status, error, result) = match outcome {
            Ok(Ok(result)) if cancel.load(Ordering::SeqCst) => {
                (OperationStatus::Cancelled, None, Some(result))
            }
            Ok(Ok(result)) => (OperationStatus::Succeeded, None, Some(result)),
            Ok(Err(message)) => (OperationStatus::Failed, Some(message), None),
            Err(_) => (
                OperationStatus::Failed,
                Some(STOPPED_UNEXPECTEDLY.to_owned()),
                None,
            ),
        };
        let _ = self.finish(id, status, error, result).await;
    }

    /// Settle an active operation. A finished one is left as it is. When the
    /// store refuses the write the new state is kept in memory, so listeners
    /// are not left with a run that never ends.
    pub(super) async fn finish(
        &self,
        id: &str,
        status: OperationStatus,
        error: Option<String>,
        result: Option<Value>,
    ) -> Result<OperationRecord, OperationError> {
        self.update_or_keep_in_memory(id, |record| {
            if !record.status.is_active() {
                return;
            }
            record.status = status;
            record.error = error.clone();
            if let Some(result) = result.clone() {
                record.result = result;
            }
            record.cancel_requested = false;
            record.completed_at = Some(now());
        })
        .await
    }

    /// Drop the finished records the retention rule no longer keeps.
    pub(super) async fn prune(&self) {
        let expired = {
            let records = self.inner.records.read().await;
            expired_ids(records.values(), chrono::Utc::now())
        };
        if expired.is_empty() {
            return;
        }
        let mut records = self.inner.records.write().await;
        for id in expired {
            // A retry may have started it again since the list was made.
            let finished = records
                .get(&id)
                .is_some_and(|record| !record.status.is_active());
            if !finished {
                continue;
            }
            if let Err(error) = self.inner.store.delete(&id).await {
                tracing::warn!(operation = %id, %error, "expired operation could not be removed");
                continue;
            }
            if let Some(removed) = records.remove(&id) {
                self.publish(OperationEvent::Removed {
                    id,
                    owner_user_id: removed.owner_user_id,
                });
            }
        }
    }
}
