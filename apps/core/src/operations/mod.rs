//! Durable long operations: work that keeps going after its request ends and
//! is still known after the node restarts.
//!
//! A feature registers an [`OperationRunner`] for its kind and starts an
//! operation through the [`OperationService`]. The service keeps one record
//! per operation in a checkpoint store, runs the work on a detached task,
//! publishes every change to listeners, and settles what a restart left
//! behind: a resumable kind continues from its checkpoint (at most
//! [`MAX_ATTEMPTS`] starts), anything else becomes `interrupted` with Retry.
//!
//! - [`record`]: the stored and served record.
//! - [`store`]: the checkpoint store handle and the retention rule.
//! - [`runner`]: the contract a feature implements.
//! - [`service`]: start, list, read, cancel, retry, and the one write path.
//! - `lifecycle`: the detached run, recovery at start and the retention sweep.
//! - [`access`]: who may see an operation, stream frames and errors.
//! - [`routes`]: `/api/operations`.

pub mod access;
mod lifecycle;
pub mod record;
pub mod routes;
pub mod runner;
pub mod service;
pub mod store;

#[cfg(test)]
mod lifecycle_tests;
#[cfg(test)]
mod service_tests;
#[cfg(test)]
pub(crate) mod test_support;

pub use access::{OperationError, OperationEvent, Viewer};
pub use record::{NewOperation, OperationProgress, OperationRecord, OperationStatus, MAX_ATTEMPTS};
pub use runner::{OperationContext, OperationRunner};
pub use service::{global, OperationService};
pub use store::OperationStore;

/// Settle the operations a restart left queued or running, once per process.
/// Called when the router is built, after every runner is registered. Without
/// a runtime (a caller that only builds the router) nothing is started: the
/// first request to the service recovers instead.
pub fn start_recovery() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    STARTED.call_once(|| {
        handle.spawn(async {
            match global() {
                Ok(service) => service.recover().await,
                Err(error) => {
                    tracing::warn!(%error, "operations are settled on first use: the store did not open");
                }
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::test_support::{count, file_store, settled, CountingRunner, KIND};
    use super::*;
    use std::sync::Arc;

    /// The parts fit together the way a feature uses them: register, start,
    /// follow, and read the stored result through a fresh handle.
    #[tokio::test]
    async fn a_feature_registers_a_runner_starts_an_operation_and_reads_the_result() {
        let dir = tempfile::tempdir().unwrap();
        let service = OperationService::new(file_store(dir.path()));
        assert!(!service.has_runner(KIND));
        service.register_runner(KIND, Arc::new(CountingRunner::new(true)));
        assert!(service.has_runner(KIND));

        let (started, created) = service.start(count(2, Some("user-1"), None)).await.unwrap();
        assert!(created);
        let finished = settled(&service, &started.id).await;
        assert_eq!(finished.status, OperationStatus::Succeeded);
        assert_eq!(
            finished.progress,
            OperationProgress::steps(2, 2).with_label("item 2")
        );

        let reopened = OperationService::new(file_store(dir.path()));
        let stored = reopened
            .get(&started.id, &Viewer::member("user-1"))
            .await
            .unwrap();
        assert_eq!(stored, finished);
        assert_eq!(
            reopened.get(&started.id, &Viewer::member("user-2")).await,
            Err(OperationError::NotFound)
        );
    }

    /// Outside a runtime there is nothing to spawn on, and the call must not
    /// panic: the CLI builds routers without one.
    #[test]
    fn start_recovery_without_a_runtime_does_nothing() {
        start_recovery();
    }
}
