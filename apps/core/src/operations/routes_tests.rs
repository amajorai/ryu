//! What `/api/operations` answers: bodies, status codes, who sees what, and
//! the frames of the stream.

use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use axum::response::Response;
use futures_util::StreamExt as _;
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use super::super::access::{OperationError, Viewer};
use super::super::record::OperationStatus;
use super::super::service::OperationService;
use super::super::test_support::{
    count, manager, memory_service, settled, wait_for, CountingRunner, KIND,
};
use super::{cancel_for, failure, list_for, openapi, operation_event_frames, read_for, retry_for};

async fn body(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the body is readable");
    (
        status,
        serde_json::from_slice(&bytes).expect("the body is JSON"),
    )
}

/// A service whose runner waits for `gate` before every item.
fn gated() -> (OperationService, Arc<Semaphore>) {
    let service = memory_service();
    let gate = Arc::new(Semaphore::new(0));
    service.register_runner(
        KIND,
        Arc::new(CountingRunner::new(true).gated(gate.clone())),
    );
    (service, gate)
}

async fn next_frame(frames: &mut (impl futures_util::Stream<Item = String> + Unpin)) -> Value {
    let frame = tokio::time::timeout(Duration::from_secs(20), frames.next())
        .await
        .expect("a frame arrives in time")
        .expect("the stream is open");
    serde_json::from_str(&frame).expect("a frame is JSON")
}

#[tokio::test]
async fn the_list_carries_summaries_and_the_read_carries_the_full_record() {
    let (service, gate) = gated();
    let (started, _) = service
        .start(count(2, Some("user-1"), Some("request-1")))
        .await
        .unwrap();
    let owner = Viewer::member("user-1");

    let list = serde_json::to_value(list_for(&service, &owner).await).unwrap();
    let listed = &list["operations"][0];
    assert_eq!(listed["id"], started.id.as_str());
    assert_eq!(listed["kind"], KIND);
    assert!(listed.get("input").is_none(), "a list leaves the input out");
    assert!(listed.get("idempotencyKey").is_none());

    let (status, full) = body(read_for(&service, &started.id, &owner).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(full["input"], json!({ "items": 2 }));
    assert!(
        full.get("idempotencyKey").is_none(),
        "the key is never served"
    );

    gate.add_permits(10);
    settled(&service, &started.id).await;
    let (_, done) = body(read_for(&service, &started.id, &owner).await).await;
    assert_eq!(done["status"], "succeeded");
    assert_eq!(done["result"], json!({ "done": 2, "total": 2 }));
    assert_eq!(done["cursor"], json!({ "done": 2 }));
}

#[tokio::test]
async fn another_member_gets_the_same_404_as_for_an_id_that_does_not_exist() {
    let (service, gate) = gated();
    let (started, _) = service.start(count(1, Some("user-1"), None)).await.unwrap();
    let other = Viewer::member("user-2");

    let hidden = serde_json::to_value(list_for(&service, &other).await).unwrap();
    assert_eq!(hidden, json!({ "operations": [] }));
    let missing = body(read_for(&service, "op_missing", &other).await).await;
    for response in [
        read_for(&service, &started.id, &other).await,
        cancel_for(&service, &started.id, &other).await,
        retry_for(&service, &started.id, &other).await,
    ] {
        assert_eq!(body(response).await, missing);
    }
    assert_eq!(missing.0, StatusCode::NOT_FOUND);
    assert_eq!(missing.1["code"], "operation_not_found");

    // A manager sees it.
    let (status, seen) = body(read_for(&service, &started.id, &manager()).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(seen["ownerUserId"], "user-1");
    gate.add_permits(10);
    settled(&service, &started.id).await;
}

#[tokio::test]
async fn cancel_answers_with_the_record_and_retry_refuses_what_cannot_be_retried() {
    let (service, gate) = gated();
    let (started, _) = service.start(count(3, None, None)).await.unwrap();
    wait_for(&service, &started.id, |record| {
        record.status == OperationStatus::Running
    })
    .await;

    // Running: retry is a conflict, cancel is accepted.
    let (status, refused) = body(retry_for(&service, &started.id, &manager()).await).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(refused["code"], "operation_not_retryable");
    let (status, asked) = body(cancel_for(&service, &started.id, &manager()).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(asked["cancelRequested"], true);
    assert!(
        asked.get("cursor").is_none(),
        "cancel answers with a summary"
    );

    gate.add_permits(10);
    assert_eq!(
        settled(&service, &started.id).await.status,
        OperationStatus::Cancelled
    );
    let (status, queued) = body(retry_for(&service, &started.id, &manager()).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(queued["status"], "queued");
    assert_eq!(
        settled(&service, &started.id).await.status,
        OperationStatus::Succeeded
    );
    let (status, _) = body(retry_for(&service, &started.id, &manager()).await).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "a finished operation is not retried"
    );
}

#[tokio::test]
async fn a_store_failure_is_answered_without_its_message() {
    let secret_path = "C:\\Users\\someone\\state\\operations\\op_1.json";
    let (status, answer) = body(failure(&OperationError::Store(format!(
        "cannot write {secret_path}"
    ))))
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(answer["code"], "operation_store_failed");
    assert!(
        !answer.to_string().contains("someone"),
        "no local path leaves the node"
    );

    let (status, answer) = body(failure(&OperationError::IdempotencyConflict)).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(answer["code"], "operation_idempotency_conflict");
    let (status, _) = body(failure(&OperationError::InvalidIdempotencyKey)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = body(failure(&OperationError::UnknownKind("x".to_owned()))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn the_stream_sends_a_snapshot_first_and_then_the_changes() {
    let (service, gate) = gated();
    let (existing, _) = service.start(count(1, Some("user-1"), None)).await.unwrap();
    wait_for(&service, &existing.id, |record| {
        record.status == OperationStatus::Running
    })
    .await;

    let mut frames = Box::pin(operation_event_frames(
        service.clone(),
        Viewer::member("user-1"),
    ));
    let snapshot = next_frame(&mut frames).await;
    assert_eq!(snapshot["type"], "snapshot");
    assert_eq!(snapshot["operations"][0]["id"], existing.id.as_str());
    assert_eq!(snapshot["operations"][0]["status"], "running");
    assert!(snapshot["operations"][0].get("input").is_none());

    gate.add_permits(10);
    let mut last = Value::Null;
    while last["operation"]["status"] != "succeeded" {
        last = next_frame(&mut frames).await;
        assert_eq!(last["type"], "update");
        assert_eq!(last["operation"]["id"], existing.id.as_str());
    }
    assert_eq!(last["operation"]["progress"]["done"], 1);
}

#[tokio::test]
async fn the_stream_skips_changes_to_another_users_operations() {
    let (service, gate) = gated();
    let mut frames = Box::pin(operation_event_frames(
        service.clone(),
        Viewer::member("user-2"),
    ));
    assert_eq!(
        next_frame(&mut frames).await,
        json!({ "type": "snapshot", "operations": [] })
    );

    let (theirs, _) = service.start(count(1, Some("user-1"), None)).await.unwrap();
    let (mine, _) = service.start(count(1, Some("user-2"), None)).await.unwrap();
    gate.add_permits(10);
    settled(&service, &theirs.id).await;
    settled(&service, &mine.id).await;

    // Every frame this listener gets is about its own operation.
    let mut last = Value::Null;
    while last["operation"]["status"] != "succeeded" {
        last = next_frame(&mut frames).await;
        assert_eq!(last["operation"]["id"], mine.id.as_str());
    }
}

#[tokio::test]
async fn a_listener_that_fell_behind_is_sent_a_fresh_snapshot() {
    let service = memory_service();
    service.register_runner(KIND, Arc::new(CountingRunner::new(true)));
    let mut frames = Box::pin(operation_event_frames(service.clone(), manager()));
    assert_eq!(next_frame(&mut frames).await["type"], "snapshot");

    // 300 items publish more changes than the listener's buffer holds while
    // nobody reads the stream.
    let (started, _) = service.start(count(300, None, None)).await.unwrap();
    settled(&service, &started.id).await;

    let resync = next_frame(&mut frames).await;
    assert_eq!(
        resync["type"], "snapshot",
        "the skipped changes are replaced"
    );
    assert_eq!(resync["operations"][0]["id"], started.id.as_str());
    assert_eq!(resync["operations"][0]["status"], "succeeded");
    assert_eq!(resync["operations"][0]["progress"]["done"], 300);
}

#[test]
fn the_openapi_sub_document_lists_the_five_routes() {
    let spec = serde_json::to_value(openapi()).unwrap();
    let paths = spec["paths"].as_object().expect("paths");
    let mut listed: Vec<String> = paths
        .iter()
        .flat_map(|(path, methods)| {
            methods
                .as_object()
                .expect("a path item")
                .keys()
                .map(move |method| format!("{method} {path}"))
        })
        .collect();
    listed.sort();
    assert_eq!(
        listed,
        [
            "get /api/operations",
            "get /api/operations/stream",
            "get /api/operations/{id}",
            "post /api/operations/{id}/cancel",
            "post /api/operations/{id}/retry",
        ]
    );
    assert!(spec["components"]["schemas"]["OperationRecord"].is_object());
    assert_eq!(spec["tags"][0]["name"], "Operations");
}
