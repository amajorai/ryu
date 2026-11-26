//! Start, idempotency, cancel, retry, visibility and the event order.

use std::sync::Arc;

use serde_json::json;
use tokio::sync::Semaphore;

use super::access::{OperationError, OperationEvent, Viewer};
use super::record::OperationStatus;
use super::service::OperationService;
use super::test_support::{
    count, file_store, manager, memory_service, settled, wait_for, CountingRunner, KIND,
};

fn with_runner(service: &OperationService, runner: CountingRunner) -> Arc<CountingRunner> {
    let runner = Arc::new(runner);
    service.register_runner(KIND, runner.clone());
    runner
}

#[tokio::test]
async fn an_operation_runs_off_the_request_and_its_result_is_stored() {
    let dir = tempfile::tempdir().unwrap();
    let service = OperationService::new(file_store(dir.path()));
    let runner = with_runner(&service, CountingRunner::new(true));

    let (queued, created) = service.start(count(3, Some("user-1"), None)).await.unwrap();
    assert!(created);
    assert_eq!(queued.status, OperationStatus::Queued);
    assert_eq!(queued.attempt, 0);
    assert!(queued.resumable);

    let finished = settled(&service, &queued.id).await;
    assert_eq!(finished.status, OperationStatus::Succeeded);
    assert_eq!(finished.result, json!({ "done": 3, "total": 3 }));
    assert_eq!(finished.cursor, json!({ "done": 3 }));
    assert_eq!(finished.progress.done, 3);
    assert_eq!(finished.progress.total, 3);
    assert_eq!(finished.attempt, 1);
    assert!(finished.completed_at.is_some());
    assert_eq!(runner.worked(), [0, 1, 2]);

    // What a restarted node would read is the same finished record.
    let stored = file_store(dir.path()).load(&queued.id).await.unwrap();
    assert_eq!(stored, Some(finished));
}

#[tokio::test]
async fn a_kind_without_a_runner_is_refused() {
    let service = memory_service();
    let error = service.start(count(1, None, None)).await.unwrap_err();
    assert_eq!(error, OperationError::UnknownKind(KIND.to_owned()));
    assert!(service.list(&manager()).await.is_empty());
}

#[tokio::test]
async fn the_same_idempotency_key_returns_the_same_operation() {
    let service = memory_service();
    let gate = Arc::new(Semaphore::new(0));
    let runner = with_runner(&service, CountingRunner::new(true).gated(gate.clone()));

    let (first, created) = service
        .start(count(2, Some("user-1"), Some("request-1")))
        .await
        .unwrap();
    assert!(created);
    let (second, created_again) = service
        .start(count(2, Some("user-1"), Some("request-1")))
        .await
        .unwrap();
    assert!(!created_again, "a repeated request starts nothing");
    assert_eq!(second.id, first.id);
    assert_eq!(service.list(&manager()).await.len(), 1);

    // The same key with another input is a mistake, not a repeat.
    let conflict = service
        .start(count(5, Some("user-1"), Some("request-1")))
        .await
        .unwrap_err();
    assert_eq!(conflict, OperationError::IdempotencyConflict);

    // Another user may use the same key for their own operation.
    let (other, created_other) = service
        .start(count(2, Some("user-2"), Some("request-1")))
        .await
        .unwrap();
    assert!(created_other);
    assert_ne!(other.id, first.id);

    let invalid = service
        .start(count(2, Some("user-1"), Some("has space")))
        .await
        .unwrap_err();
    assert_eq!(invalid, OperationError::InvalidIdempotencyKey);

    gate.add_permits(10);
    settled(&service, &first.id).await;
    settled(&service, &other.id).await;
    assert_eq!(runner.worked(), [0, 1, 0, 1], "each operation ran once");

    // Still the same operation after it finished.
    let (again, created_late) = service
        .start(count(2, Some("user-1"), Some("request-1")))
        .await
        .unwrap();
    assert!(!created_late);
    assert_eq!(again.id, first.id);
    assert_eq!(again.status, OperationStatus::Succeeded);
}

#[tokio::test]
async fn cancel_stops_between_items_and_keeps_what_was_done() {
    let service = memory_service();
    let gate = Arc::new(Semaphore::new(2));
    let runner = with_runner(&service, CountingRunner::new(true).gated(gate.clone()));
    let (started, _) = service.start(count(5, None, None)).await.unwrap();
    wait_for(&service, &started.id, |record| record.progress.done == 2).await;

    let requested = service.cancel(&started.id, &manager()).await.unwrap();
    assert_eq!(requested.status, OperationStatus::Running);
    assert!(requested.cancel_requested);

    gate.add_permits(10);
    let finished = settled(&service, &started.id).await;
    assert_eq!(finished.status, OperationStatus::Cancelled);
    assert!(!finished.cancel_requested);
    assert_eq!(finished.result, json!({ "done": 2, "total": 5 }));
    assert_eq!(runner.worked(), [0, 1], "nothing ran after the stop");

    // Cancelling a finished operation changes nothing.
    let again = service.cancel(&started.id, &manager()).await.unwrap();
    assert_eq!(again, finished);
}

#[tokio::test]
async fn one_operation_of_a_kind_runs_at_a_time_and_a_queued_one_can_be_cancelled() {
    let service = memory_service();
    let gate = Arc::new(Semaphore::new(0));
    let runner = with_runner(&service, CountingRunner::new(true).gated(gate.clone()));
    let (first, _) = service.start(count(2, None, None)).await.unwrap();
    wait_for(&service, &first.id, |record| {
        record.status == OperationStatus::Running
    })
    .await;
    let (second, _) = service.start(count(2, None, None)).await.unwrap();
    let (third, _) = service.start(count(1, None, None)).await.unwrap();

    // Give the later ones every chance to start; they must still be waiting.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    for id in [&second.id, &third.id] {
        let waiting = service.get(id, &manager()).await.unwrap();
        assert_eq!(waiting.status, OperationStatus::Queued);
        assert_eq!(waiting.attempt, 0);
    }

    let requested = service.cancel(&second.id, &manager()).await.unwrap();
    assert!(requested.cancel_requested);

    gate.add_permits(10);
    assert_eq!(
        settled(&service, &first.id).await.status,
        OperationStatus::Succeeded
    );
    let cancelled = settled(&service, &second.id).await;
    assert_eq!(cancelled.status, OperationStatus::Cancelled);
    assert_eq!(cancelled.attempt, 0, "it never started");
    assert_eq!(
        settled(&service, &third.id).await.status,
        OperationStatus::Succeeded
    );
    assert_eq!(runner.worked(), [0, 1, 0]);
}

#[tokio::test]
async fn retry_continues_a_failed_resumable_operation_from_its_checkpoint() {
    let service = memory_service();
    let runner = with_runner(&service, CountingRunner::new(true).failing_at(1));
    let (started, _) = service.start(count(3, None, None)).await.unwrap();
    let failed = settled(&service, &started.id).await;
    assert_eq!(failed.status, OperationStatus::Failed);
    assert_eq!(failed.error.as_deref(), Some("item 1 failed"));
    assert_eq!(failed.cursor, json!({ "done": 1 }));

    runner.stop_failing();
    let queued = service.retry(&started.id, &manager()).await.unwrap();
    assert_eq!(queued.status, OperationStatus::Queued);
    assert_eq!(queued.error, None);
    assert_eq!(queued.completed_at, None);

    let finished = settled(&service, &started.id).await;
    assert_eq!(finished.status, OperationStatus::Succeeded);
    assert_eq!(finished.attempt, 1, "a retry starts the count again");
    assert_eq!(runner.worked(), [0, 1, 2], "item 0 was not repeated");

    let refused = service.retry(&started.id, &manager()).await.unwrap_err();
    assert_eq!(refused, OperationError::NotRetryable);
}

#[tokio::test]
async fn a_runner_that_panics_fails_its_operation_and_the_next_one_still_runs() {
    let service = memory_service();
    with_runner(&service, CountingRunner::new(true).panicking_at(1));
    let (started, _) = service.start(count(3, None, None)).await.unwrap();
    let failed = settled(&service, &started.id).await;
    assert_eq!(failed.status, OperationStatus::Failed);
    assert_eq!(
        failed.error.as_deref(),
        Some("The operation stopped unexpectedly.")
    );

    // The turn lock was released: another operation of the kind runs.
    let (next, _) = service.start(count(1, None, None)).await.unwrap();
    assert_eq!(
        settled(&service, &next.id).await.status,
        OperationStatus::Succeeded
    );
}

#[tokio::test]
async fn an_operation_is_hidden_from_other_members_and_shown_to_managers() {
    let service = memory_service();
    let gate = Arc::new(Semaphore::new(0));
    with_runner(&service, CountingRunner::new(true).gated(gate.clone()));
    let (started, _) = service.start(count(2, Some("user-1"), None)).await.unwrap();
    let owner = Viewer::member("user-1");
    let other = Viewer::member("user-2");

    let listed = service.list(&owner).await;
    assert_eq!(listed.len(), 1);
    assert!(listed[0].input.is_null(), "lists carry summaries");
    assert_eq!(service.list(&manager()).await.len(), 1);
    assert!(service.list(&other).await.is_empty());

    let full = service.get(&started.id, &owner).await.unwrap();
    assert_eq!(full.input, json!({ "items": 2 }));
    for refused in [
        service.get(&started.id, &other).await,
        service.cancel(&started.id, &other).await,
        service.retry(&started.id, &other).await,
        service.get("op_missing", &owner).await,
    ] {
        assert_eq!(refused.unwrap_err(), OperationError::NotFound);
    }
    let unchanged = service.get(&started.id, &owner).await.unwrap();
    assert!(
        !unchanged.cancel_requested,
        "the refused cancel did nothing"
    );

    service.cancel(&started.id, &owner).await.unwrap();
    gate.add_permits(10);
    assert_eq!(
        settled(&service, &started.id).await.status,
        OperationStatus::Cancelled
    );
}

#[tokio::test]
async fn a_listener_gets_a_snapshot_and_then_every_change_in_order() {
    let service = memory_service();
    let gate = Arc::new(Semaphore::new(0));
    with_runner(&service, CountingRunner::new(true).gated(gate.clone()));
    let (existing, _) = service.start(count(1, Some("user-1"), None)).await.unwrap();
    wait_for(&service, &existing.id, |record| {
        record.status == OperationStatus::Running
    })
    .await;

    let (snapshot, mut receiver) = service
        .snapshot_and_subscribe(&Viewer::member("user-1"))
        .await;
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].id, existing.id);
    assert_eq!(snapshot[0].status, OperationStatus::Running);
    let (hidden, _) = service
        .snapshot_and_subscribe(&Viewer::member("user-2"))
        .await;
    assert!(hidden.is_empty());

    gate.add_permits(10);
    settled(&service, &existing.id).await;
    let mut statuses = Vec::new();
    while let Ok(event) = receiver.try_recv() {
        let OperationEvent::Update { operation } = event else {
            panic!("only updates are expected");
        };
        assert_eq!(operation.id, existing.id);
        assert!(operation.cursor.is_null(), "events carry summaries");
        statuses.push((operation.status, operation.progress.done));
    }
    // Progress, then the checkpoint write (no visible change in a summary
    // except the time), then the end.
    assert_eq!(statuses.first(), Some(&(OperationStatus::Running, 1)));
    assert_eq!(statuses.last(), Some(&(OperationStatus::Succeeded, 1)));
}
