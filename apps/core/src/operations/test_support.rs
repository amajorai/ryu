//! Test-only helpers: a sample record, a runner that counts, and services on a
//! memory or plain file store.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ryu_durable::BoxFuture;
use serde_json::{json, Value};

use super::access::Viewer;
use super::record::{NewOperation, OperationProgress, OperationRecord, OperationStatus};
use super::runner::{OperationContext, OperationRunner};
use super::service::OperationService;
use super::store::OperationStore;

pub(crate) const KIND: &str = "test.count";
const NEVER: u64 = u64::MAX;

pub(crate) fn sample(id: &str, status: OperationStatus) -> OperationRecord {
    OperationRecord {
        id: id.to_owned(),
        kind: KIND.to_owned(),
        title: "Sample".to_owned(),
        owner_user_id: Some("user-1".to_owned()),
        status,
        progress: OperationProgress::steps(1, 3).with_label("second"),
        input: json!({ "items": 3 }),
        cursor: json!({ "done": 1 }),
        result: Value::Null,
        error: None,
        idempotency_key: Some("key-1".to_owned()),
        attempt: 1,
        resumable: true,
        resumed: false,
        cancel_requested: false,
        created_at: "2026-11-18T10:00:00.000Z".to_owned(),
        updated_at: "2026-11-18T10:00:01.000Z".to_owned(),
        completed_at: None,
    }
}

/// Counts from the checkpoint to `input.items`, one checkpoint per item, and
/// records every item it worked on.
pub(crate) struct CountingRunner {
    resumable: bool,
    /// Every item index a run worked on, in order.
    pub(crate) worked: Arc<Mutex<Vec<u64>>>,
    /// When set, the runner takes one permit before each item.
    gate: Option<Arc<tokio::sync::Semaphore>>,
    /// The item that fails, or `NEVER`.
    pub(crate) fail_at: Arc<AtomicU64>,
    panic_at: Option<u64>,
}

impl CountingRunner {
    pub(crate) fn new(resumable: bool) -> Self {
        Self {
            resumable,
            worked: Arc::new(Mutex::new(Vec::new())),
            gate: None,
            fail_at: Arc::new(AtomicU64::new(NEVER)),
            panic_at: None,
        }
    }

    pub(crate) fn gated(mut self, gate: Arc<tokio::sync::Semaphore>) -> Self {
        self.gate = Some(gate);
        self
    }

    pub(crate) fn failing_at(self, item: u64) -> Self {
        self.fail_at.store(item, Ordering::SeqCst);
        self
    }

    pub(crate) fn panicking_at(mut self, item: u64) -> Self {
        self.panic_at = Some(item);
        self
    }

    pub(crate) fn worked(&self) -> Vec<u64> {
        self.worked.lock().unwrap().clone()
    }

    pub(crate) fn stop_failing(&self) {
        self.fail_at.store(NEVER, Ordering::SeqCst);
    }
}

impl OperationRunner for CountingRunner {
    fn resumable(&self) -> bool {
        self.resumable
    }

    fn run<'a>(&'a self, context: OperationContext) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let total = context.record().input["items"].as_u64().unwrap_or(0);
            let mut done = context.record().cursor["done"].as_u64().unwrap_or(0);
            while done < total {
                if context.is_cancelled() {
                    break;
                }
                if let Some(gate) = &self.gate {
                    gate.acquire()
                        .await
                        .map_err(|error| error.to_string())?
                        .forget();
                    // The stop may have arrived while this item waited.
                    if context.is_cancelled() {
                        break;
                    }
                }
                if self.fail_at.load(Ordering::SeqCst) == done {
                    return Err(format!("item {done} failed"));
                }
                if self.panic_at == Some(done) {
                    panic!("item {done} panicked");
                }
                self.worked.lock().unwrap().push(done);
                done += 1;
                context
                    .progress(
                        OperationProgress::steps(done, total).with_label(format!("item {done}")),
                    )
                    .await;
                context
                    .checkpoint(json!({ "done": done }))
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Ok(json!({ "done": done, "total": total }))
        })
    }
}

/// A service whose records live in memory only.
pub(crate) fn memory_service() -> OperationService {
    OperationService::new(OperationStore::new(Arc::new(
        ryu_durable::MemoryCheckpointStore::new(),
    )))
}

/// The plain file store of `dir`; a second call on the same folder is what a
/// restarted node opens.
pub(crate) fn file_store(dir: &std::path::Path) -> OperationStore {
    OperationStore::new(Arc::new(ryu_durable::FileCheckpointStore::new(dir)))
}

/// A request to count `items` items.
pub(crate) fn count(items: u64, owner: Option<&str>, key: Option<&str>) -> NewOperation {
    NewOperation {
        kind: KIND.to_owned(),
        title: format!("Count to {items}"),
        owner_user_id: owner.map(str::to_owned),
        input: json!({ "items": items }),
        idempotency_key: key.map(str::to_owned),
    }
}

/// A viewer who sees everything.
pub(crate) fn manager() -> Viewer {
    Viewer::manager(None)
}

/// The record once it is no longer queued or running.
pub(crate) async fn settled(service: &OperationService, id: &str) -> OperationRecord {
    tokio::time::timeout(Duration::from_secs(20), service.wait_until_finished(id))
        .await
        .expect("the operation did not finish in time")
        .expect("the operation exists")
}

/// The record once `ready` holds for it.
pub(crate) async fn wait_for(
    service: &OperationService,
    id: &str,
    ready: impl Fn(&OperationRecord) -> bool,
) -> OperationRecord {
    for _ in 0..4000 {
        let record = service
            .get(id, &manager())
            .await
            .expect("the operation exists");
        if ready(&record) {
            return record;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("operation {id} never reached the expected state");
}

#[tokio::test]
async fn the_counting_runner_counts_every_item_once() {
    let service = memory_service();
    let runner = Arc::new(CountingRunner::new(true));
    service.register_runner(KIND, runner.clone());
    let (record, created) = service.start(count(3, None, None)).await.unwrap();
    assert!(created);
    let finished = settled(&service, &record.id).await;
    assert_eq!(finished.status, OperationStatus::Succeeded);
    assert_eq!(runner.worked(), [0, 1, 2]);
}
