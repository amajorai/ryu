//! The runner contract: a feature registers one runner per operation kind, and
//! the service calls it on a detached task with a small context.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

use ryu_durable::BoxFuture;
use serde_json::Value;

use super::access::OperationError;
use super::record::{OperationProgress, OperationRecord};
use super::service::OperationService;

/// The work behind one operation kind.
pub trait OperationRunner: Send + Sync + 'static {
    /// Whether a run may continue from its checkpoint after a node restart.
    /// Say yes only when repeating the step that was in flight is safe. The
    /// default is no: such an operation becomes `interrupted` instead.
    fn resumable(&self) -> bool {
        false
    }

    /// Do the work. `context.record()` holds the input and the last
    /// checkpoint. Return the result to store, or the error to show. Check
    /// [`OperationContext::is_cancelled`] between steps and return what was
    /// done so far when it is set.
    fn run<'a>(&'a self, context: OperationContext) -> BoxFuture<'a, Result<Value, String>>;
}

/// What a runner gets: the record it runs for, and the three verbs.
#[derive(Clone)]
pub struct OperationContext {
    service: OperationService,
    record: OperationRecord,
    cancel: Arc<AtomicBool>,
}

impl OperationContext {
    pub(super) fn new(
        service: OperationService,
        record: OperationRecord,
        cancel: Arc<AtomicBool>,
    ) -> Self {
        Self {
            service,
            record,
            cancel,
        }
    }

    /// The record as it was when this run started (input, cursor, attempt).
    pub fn record(&self) -> &OperationRecord {
        &self.record
    }

    /// Whether a stop was requested. A runner stops between steps and keeps
    /// what it has done.
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// Show how far the run is. Sent to listeners at once; written to disk
    /// with the next checkpoint.
    pub async fn progress(&self, progress: OperationProgress) {
        self.service.set_progress(&self.record.id, progress).await;
    }

    /// Write the checkpoint a later run continues from. Durable when this
    /// returns `Ok`.
    pub async fn checkpoint(&self, cursor: Value) -> Result<(), OperationError> {
        self.service.set_cursor(&self.record.id, cursor).await
    }
}

/// A registered runner plus the lock that lets one operation of its kind run
/// at a time.
#[derive(Clone)]
pub(super) struct RegisteredRunner {
    pub(super) runner: Arc<dyn OperationRunner>,
    pub(super) turn: Arc<tokio::sync::Mutex<()>>,
}

/// The runners by kind.
#[derive(Default)]
pub(super) struct RunnerRegistry {
    runners: RwLock<HashMap<String, RegisteredRunner>>,
}

impl RunnerRegistry {
    /// Register (or replace) the runner for `kind`.
    pub(super) fn register(&self, kind: &str, runner: Arc<dyn OperationRunner>) {
        let entry = RegisteredRunner {
            runner,
            turn: Arc::new(tokio::sync::Mutex::new(())),
        };
        self.runners
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(kind.to_owned(), entry);
    }

    pub(super) fn get(&self, kind: &str) -> Option<RegisteredRunner> {
        self.runners
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(kind)
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::CountingRunner;
    use super::*;

    #[test]
    fn a_runner_is_not_resumable_unless_it_says_so() {
        struct Plain;
        impl OperationRunner for Plain {
            fn run<'a>(&'a self, _: OperationContext) -> BoxFuture<'a, Result<Value, String>> {
                Box::pin(async { Ok(Value::Null) })
            }
        }
        assert!(!Plain.resumable());
        assert!(CountingRunner::new(true).resumable());
        assert!(!CountingRunner::new(false).resumable());
    }

    #[test]
    fn the_registry_returns_the_runner_of_a_kind_and_nothing_for_an_unknown_one() {
        let registry = RunnerRegistry::default();
        assert!(registry.get("test.count").is_none());
        registry.register("test.count", Arc::new(CountingRunner::new(true)));
        let first = registry.get("test.count").expect("registered");
        let second = registry.get("test.count").expect("registered");
        assert!(
            Arc::ptr_eq(&first.turn, &second.turn),
            "one turn lock per kind"
        );
        assert!(registry.get("test.other").is_none());
    }
}
