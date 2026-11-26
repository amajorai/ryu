//! What a node restart does to operations: resume, interrupt, the attempt cap
//! and the retention sweep.
//!
//! A "restart" here is a second service opened on the same folder while the
//! first one's run is parked for good behind a gate that never opens, which
//! leaves exactly what a stopped process leaves: the last record on disk.

use std::sync::Arc;

use serde_json::json;
use tokio::sync::Semaphore;

use super::access::OperationEvent;
use super::record::{now, OperationStatus, MAX_ATTEMPTS};
use super::service::OperationService;
use super::test_support::{
    count, file_store, manager, sample, settled, wait_for, CountingRunner, KIND,
};

/// A service on `dir` whose runner stops for good after `permits` items.
fn stalling_service(
    dir: &std::path::Path,
    resumable: bool,
    permits: usize,
) -> (OperationService, Arc<CountingRunner>) {
    let service = OperationService::new(file_store(dir));
    let gate = Arc::new(Semaphore::new(permits));
    let runner = Arc::new(CountingRunner::new(resumable).gated(gate));
    service.register_runner(KIND, runner.clone());
    (service, runner)
}

/// A service on `dir` whose runner never waits.
fn free_service(dir: &std::path::Path, resumable: bool) -> (OperationService, Arc<CountingRunner>) {
    let service = OperationService::new(file_store(dir));
    let runner = Arc::new(CountingRunner::new(resumable));
    service.register_runner(KIND, runner.clone());
    (service, runner)
}

#[tokio::test]
async fn a_resumable_operation_continues_after_a_restart_without_repeating_finished_items() {
    let dir = tempfile::tempdir().unwrap();
    let (before, first_runner) = stalling_service(dir.path(), true, 2);
    let (started, _) = before.start(count(5, Some("user-1"), None)).await.unwrap();
    wait_for(&before, &started.id, |record| {
        record.cursor == json!({ "done": 2 })
    })
    .await;
    assert_eq!(first_runner.worked(), [0, 1]);

    // The node stops here. The next start opens the same folder.
    let (after, second_runner) = free_service(dir.path(), true);
    after.recover().await;
    let finished = settled(&after, &started.id).await;

    assert_eq!(finished.status, OperationStatus::Succeeded);
    assert!(finished.resumed, "labelled as resumed after a restart");
    assert_eq!(finished.attempt, 2);
    assert_eq!(finished.result, json!({ "done": 5, "total": 5 }));
    assert_eq!(
        second_runner.worked(),
        [2, 3, 4],
        "items 0 and 1 were not repeated"
    );
    assert_eq!(finished.owner_user_id.as_deref(), Some("user-1"));
}

#[tokio::test]
async fn an_operation_that_is_not_resumable_becomes_interrupted_and_retry_starts_it_over() {
    let dir = tempfile::tempdir().unwrap();
    let (before, _) = stalling_service(dir.path(), false, 1);
    let (started, _) = before.start(count(3, None, None)).await.unwrap();
    wait_for(&before, &started.id, |record| {
        record.cursor == json!({ "done": 1 })
    })
    .await;

    let (after, runner) = free_service(dir.path(), false);
    // No explicit recover: the first call does it.
    let interrupted = after.get(&started.id, &manager()).await.unwrap();
    assert_eq!(interrupted.status, OperationStatus::Interrupted);
    assert_eq!(
        interrupted.error.as_deref(),
        Some("Interrupted by a node restart.")
    );
    assert!(interrupted.completed_at.is_some());
    assert!(!interrupted.resumed);
    assert!(runner.worked().is_empty(), "nothing ran by itself");
    // The interrupted state is on disk, not only in memory.
    let stored = file_store(dir.path())
        .load(&started.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.status, OperationStatus::Interrupted);

    let queued = after.retry(&started.id, &manager()).await.unwrap();
    assert_eq!(queued.status, OperationStatus::Queued);
    assert!(
        queued.cursor.is_null(),
        "a runner that cannot resume starts over"
    );
    let finished = settled(&after, &started.id).await;
    assert_eq!(finished.status, OperationStatus::Succeeded);
    assert_eq!(runner.worked(), [0, 1, 2]);
}

#[tokio::test]
async fn the_attempt_cap_stops_an_operation_that_keeps_taking_the_node_down() {
    let dir = tempfile::tempdir().unwrap();
    let mut id = String::new();
    for attempt in 1..=MAX_ATTEMPTS {
        // Each start gets as far as "running" and then the node stops.
        let (service, runner) = stalling_service(dir.path(), true, 0);
        if attempt == 1 {
            id = service.start(count(2, None, None)).await.unwrap().0.id;
        } else {
            service.recover().await;
        }
        wait_for(&service, &id, |record| {
            record.status == OperationStatus::Running
        })
        .await;
        // The count is on disk before the runner did anything.
        let stored = file_store(dir.path()).load(&id).await.unwrap().unwrap();
        assert_eq!(stored.attempt, attempt);
        assert_eq!(stored.status, OperationStatus::Running);
        assert!(runner.worked().is_empty());
    }

    let (service, runner) = free_service(dir.path(), true);
    service.recover().await;
    let stopped = service.get(&id, &manager()).await.unwrap();
    assert_eq!(stopped.status, OperationStatus::Interrupted);
    assert_eq!(stopped.attempt, MAX_ATTEMPTS);
    assert!(stopped.error.as_deref().unwrap().contains("3 starts"));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(
        runner.worked().is_empty(),
        "the fourth start did not run it"
    );

    // The user can still start it by hand, which begins a new count.
    service.retry(&id, &manager()).await.unwrap();
    let finished = settled(&service, &id).await;
    assert_eq!(finished.status, OperationStatus::Succeeded);
    assert_eq!(finished.attempt, 1);
}

#[tokio::test]
async fn recovery_settles_each_kind_of_leftover_record() {
    let dir = tempfile::tempdir().unwrap();
    let store = file_store(dir.path());

    let mut never_started = sample("op_queued", OperationStatus::Queued);
    never_started.attempt = 0;
    never_started.cursor = serde_json::Value::Null;
    let mut no_runner = sample("op_no_runner", OperationStatus::Running);
    no_runner.kind = "gone.kind".to_owned();
    let mut stop_asked = sample("op_stop_asked", OperationStatus::Running);
    stop_asked.cancel_requested = true;
    let mut done = sample("op_done", OperationStatus::Succeeded);
    done.completed_at = Some(now());
    let mut old = sample("op_old", OperationStatus::Failed);
    old.completed_at = Some("2026-01-01T00:00:00.000Z".to_owned());
    old.updated_at = "2026-01-01T00:00:00.000Z".to_owned();
    for record in [&never_started, &no_runner, &stop_asked, &done, &old] {
        store.save(record).await.unwrap();
    }

    let (service, runner) = free_service(dir.path(), true);
    let (_, mut receiver) = {
        // Subscribing first is not possible (the first call recovers), so the
        // sweep's removal is checked on disk and in the list below.
        service.snapshot_and_subscribe(&manager()).await
    };

    let resumed = settled(&service, "op_queued").await;
    assert_eq!(resumed.status, OperationStatus::Succeeded);
    assert!(resumed.resumed);
    assert_eq!(resumed.attempt, 1);
    assert_eq!(runner.worked(), [0, 1, 2]);

    let orphan = service.get("op_no_runner", &manager()).await.unwrap();
    assert_eq!(orphan.status, OperationStatus::Interrupted);
    let cancelled = service.get("op_stop_asked", &manager()).await.unwrap();
    assert_eq!(cancelled.status, OperationStatus::Cancelled);
    assert!(!cancelled.cancel_requested);
    assert_eq!(service.get("op_done", &manager()).await.unwrap(), done);

    // Older than the retention window: gone from the list and from disk.
    assert!(service.get("op_old", &manager()).await.is_err());
    assert_eq!(store.load("op_old").await.unwrap(), None);
    assert_eq!(service.list(&manager()).await.len(), 4);

    // Nothing after the snapshot removed a record that is still kept.
    while let Ok(event) = receiver.try_recv() {
        assert!(!matches!(event, OperationEvent::Removed { .. }));
    }
}
