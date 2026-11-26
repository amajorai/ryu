//! The durable import: started off the request, one checkpoint per item, and
//! continued after a restart without importing anything twice.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::http::StatusCode;
use serde_json::{json, Value};

use super::{
    cursor_of, import_input, register_import_runner, start_import_operation, StoredCaller,
    IMPORT_OPERATION_KIND,
};
use crate::background_processes::operations::record::now;
use crate::background_processes::operations::{
    OperationProgress, OperationRecord, OperationService, OperationStatus, OperationStore,
};
use crate::identity_verify::{OrgRole, TeamMembership, VerifiedCaller};
use crate::import::{kind, ImportSelection};
use crate::server::memory::MemoryFilter;
use crate::server::{apply_import_selections, isolated_plugin_hook_test_state, ServerState};

/// One node state for every test here (a second one in the same process can
/// find the shared stores locked). Each test imports its own marked memories.
fn state() -> ServerState {
    static STATE: OnceLock<(tempfile::TempDir, ServerState)> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let dir = tempfile::tempdir().unwrap();
            let state = isolated_plugin_hook_test_state(dir.path());
            (dir, state)
        })
        .1
        .clone()
}

/// `count` Claude memory files under `root`, each with its own content, and
/// the selections that import them.
fn memory_folder(root: &std::path::Path, marker: &str, count: usize) -> Vec<ImportSelection> {
    (0..count)
        .map(|index| {
            let rel =
                format!("projects/{marker}/memory/00000000-0000-0000-0000-00000000000{index}.md");
            let path = root.join(&rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let body = json!({
                "content": format!("{marker} note {index}: build step {index} uses bun."),
                "importance": 3
            });
            std::fs::write(path, body.to_string()).unwrap();
            ImportSelection {
                kind: kind::MEMORY.into(),
                id: format!("{}/{rel}", kind::MEMORY),
            }
        })
        .collect()
}

/// How many memories of `marker` the node holds.
async fn memories(state: &ServerState, marker: &str) -> usize {
    state
        .memory
        .list(&MemoryFilter::default())
        .await
        .unwrap()
        .iter()
        .filter(|entry| entry.content.starts_with(marker))
        .count()
}

/// An operations service on the plain file store of `dir` with the import
/// runner registered; a second call on the same folder is a restarted node.
fn service(dir: &std::path::Path, state: ServerState) -> OperationService {
    let service = OperationService::new(file_store(dir));
    register_import_runner(&service, state);
    service
}

fn file_store(dir: &std::path::Path) -> OperationStore {
    OperationStore::new(Arc::new(ryu_durable::FileCheckpointStore::new(dir)))
}

async fn finished(service: &OperationService, id: &str) -> OperationRecord {
    tokio::time::timeout(Duration::from_secs(60), service.wait_until_finished(id))
        .await
        .expect("the import did not finish in time")
        .expect("the operation exists")
}

async fn answer(response: axum::response::Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

fn statuses(results: &[Value]) -> Vec<&str> {
    results
        .iter()
        .map(|outcome| outcome["status"].as_str().unwrap_or("?"))
        .collect()
}

#[tokio::test]
async fn an_async_import_answers_at_once_and_ends_with_the_results_of_the_plain_call() {
    let state = state();
    let root = tempfile::tempdir().unwrap();
    let items = memory_folder(root.path(), "alpha", 3);
    let store = tempfile::tempdir().unwrap();
    let service = service(store.path(), state.clone());

    let (status, body) =
        answer(start_import_operation(&service, &None, root.path(), items.clone(), None).await)
            .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let id = body["operationId"].as_str().expect("an id").to_owned();
    assert_eq!(body["operation"]["id"], id.as_str());
    assert_eq!(body["operation"]["kind"], IMPORT_OPERATION_KIND);
    assert_eq!(
        body["operation"]["title"],
        root.path().file_name().unwrap().to_str().unwrap()
    );
    assert!(body["operation"].get("input").is_none());

    let done = finished(&service, &id).await;
    assert_eq!(done.status, OperationStatus::Succeeded);
    assert!(done.resumable);
    assert_eq!(done.progress, OperationProgress::steps(3, 3));
    assert_eq!(done.result["root"], root.path().to_string_lossy().as_ref());
    let results = done.result["results"].as_array().expect("results");
    assert_eq!(statuses(results), ["imported", "imported", "imported"]);
    for (outcome, item) in results.iter().zip(&items) {
        assert_eq!(outcome["id"], item.id.as_str());
        assert_eq!(outcome["kind"], kind::MEMORY);
    }
    assert_eq!(done.cursor, cursor_of(results), "one checkpoint per item");
    assert_eq!(memories(&state, "alpha").await, 3);

    // The plain call takes the same path: it finds every item already there.
    let again = apply_import_selections(&state, &None, root.path(), items).await;
    assert!(again
        .iter()
        .all(|outcome| outcome.status == "skipped" && outcome.already_exists));
    assert_eq!(memories(&state, "alpha").await, 3);
}

#[tokio::test]
async fn a_repeated_request_with_the_same_key_returns_the_same_operation() {
    let state = state();
    let root = tempfile::tempdir().unwrap();
    let items = memory_folder(root.path(), "beta", 2);
    let store = tempfile::tempdir().unwrap();
    let service = service(store.path(), state.clone());
    let key = Some("import-request-1".to_owned());

    let (status, first) = answer(
        start_import_operation(&service, &None, root.path(), items.clone(), key.clone()).await,
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let (status, second) = answer(
        start_import_operation(&service, &None, root.path(), items.clone(), key.clone()).await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "nothing new was started");
    assert_eq!(second["operationId"], first["operationId"]);

    // The same key for another selection is refused, and so is a key with a space.
    let (status, conflict) = answer(
        start_import_operation(&service, &None, root.path(), items[..1].to_vec(), key).await,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["code"], "operation_idempotency_conflict");
    let (status, _) = answer(
        start_import_operation(
            &service,
            &None,
            root.path(),
            items,
            Some("has space".to_owned()),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let id = first["operationId"].as_str().unwrap();
    assert_eq!(
        finished(&service, id).await.status,
        OperationStatus::Succeeded
    );
    assert_eq!(memories(&state, "beta").await, 2, "the batch ran once");
}

#[tokio::test]
async fn an_import_stopped_by_a_restart_continues_and_imports_nothing_twice() {
    let state = state();
    let root = tempfile::tempdir().unwrap();
    let items = memory_folder(root.path(), "gamma", 5);

    // What the node had done when it stopped: items 0 and 1 are written, and
    // the checkpoint holds item 0 only (the stop came between the write of
    // item 1 and its checkpoint).
    let before = apply_import_selections(&state, &None, root.path(), items[..2].to_vec()).await;
    assert_eq!(memories(&state, "gamma").await, 2);
    let first_outcome = serde_json::to_value(&before[0]).unwrap();
    let record = OperationRecord {
        id: "op_interrupted_import".to_owned(),
        kind: IMPORT_OPERATION_KIND.to_owned(),
        title: "gamma".to_owned(),
        owner_user_id: None,
        status: OperationStatus::Running,
        progress: OperationProgress::steps(1, 5),
        input: serde_json::to_value(import_input(&None, root.path(), &items)).unwrap(),
        cursor: cursor_of(std::slice::from_ref(&first_outcome)),
        result: Value::Null,
        error: None,
        idempotency_key: None,
        attempt: 1,
        resumable: true,
        resumed: false,
        cancel_requested: false,
        created_at: now(),
        updated_at: now(),
        completed_at: None,
    };
    let store = tempfile::tempdir().unwrap();
    file_store(store.path()).save(&record).await.unwrap();

    // The node starts again: the runner is registered, then recovery runs.
    let service = service(store.path(), state.clone());
    service.recover().await;
    let done = finished(&service, &record.id).await;

    assert_eq!(done.status, OperationStatus::Succeeded);
    assert!(done.resumed, "shown as resumed after a restart");
    assert_eq!(done.attempt, 2);
    assert_eq!(done.progress, OperationProgress::steps(5, 5));
    let results = done.result["results"].as_array().expect("results");
    assert_eq!(
        results[0], first_outcome,
        "a finished item keeps its outcome"
    );
    assert_eq!(
        statuses(results),
        ["imported", "skipped", "imported", "imported", "imported"]
    );
    assert_eq!(
        results[1]["already_exists"], true,
        "the item in flight ran again and found its own write"
    );
    assert_eq!(
        memories(&state, "gamma").await,
        5,
        "nothing was imported twice"
    );
}

#[tokio::test]
async fn an_import_whose_stored_request_cannot_be_read_fails_with_a_plain_error() {
    let mut record = OperationRecord {
        id: "op_unreadable_import".to_owned(),
        kind: IMPORT_OPERATION_KIND.to_owned(),
        title: "delta".to_owned(),
        owner_user_id: None,
        status: OperationStatus::Queued,
        progress: OperationProgress::default(),
        input: json!({ "items": "not a list" }),
        cursor: Value::Null,
        result: Value::Null,
        error: None,
        idempotency_key: None,
        attempt: 0,
        resumable: true,
        resumed: false,
        cancel_requested: false,
        created_at: now(),
        updated_at: now(),
        completed_at: None,
    };
    record.updated_at = record.created_at.clone();
    let store = tempfile::tempdir().unwrap();
    file_store(store.path()).save(&record).await.unwrap();

    let service = service(store.path(), state());
    service.recover().await;
    let done = finished(&service, &record.id).await;
    assert_eq!(done.status, OperationStatus::Failed);
    assert_eq!(
        done.error.as_deref(),
        Some("The stored import request cannot be read.")
    );
}

#[tokio::test]
async fn the_call_without_async_answers_with_the_results_as_before() {
    let state = state();
    let root = tempfile::tempdir().unwrap();
    let items = memory_folder(root.path(), "epsilon", 2);
    let wire_items: Vec<Value> = items
        .iter()
        .map(|item| json!({ "kind": item.kind, "id": item.id }))
        .collect();

    let plain: super::super::RunImportBody = serde_json::from_value(json!({
        "path": root.path().to_string_lossy(),
        "items": wire_items
    }))
    .unwrap();
    assert!(
        !plain.run_async,
        "a body without the flag is the plain call"
    );
    assert_eq!(plain.idempotency_key, None);
    let flagged: super::super::RunImportBody = serde_json::from_value(json!({
        "path": root.path().to_string_lossy(),
        "items": wire_items,
        "async": true,
        "idempotencyKey": "import-request-2"
    }))
    .unwrap();
    assert!(flagged.run_async);
    assert_eq!(flagged.idempotency_key.as_deref(), Some("import-request-2"));

    let (status, body) = answer(
        super::super::run_import_handler(
            axum::extract::State(state.clone()),
            axum::Extension(None),
            axum::Json(plain),
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.get("operationId").is_none());
    let results = body["results"].as_array().expect("results in the answer");
    assert_eq!(statuses(results), ["imported", "imported"]);
    assert!(body["root"].is_string());
    assert_eq!(memories(&state, "epsilon").await, 2);
}

#[test]
fn the_stored_request_names_the_caller_without_address_or_token() {
    let caller = VerifiedCaller {
        user_id: "user-1".to_owned(),
        email: Some("someone@example.com".to_owned()),
        email_verified: true,
        org_id: Some("org-1".to_owned()),
        role: OrgRole::Admin,
        teams: vec![TeamMembership {
            id: "team-1".to_owned(),
            org_id: "org-1".to_owned(),
            role: "member".to_owned(),
        }],
    };
    let items = vec![ImportSelection {
        kind: kind::SKILL.into(),
        id: "skill/review".to_owned(),
    }];
    let input = import_input(&Some(caller), std::path::Path::new("/data/setup"), &items);
    let wire = serde_json::to_value(&input).unwrap();
    assert_eq!(
        wire,
        json!({
            "path": "/data/setup",
            "items": [{ "kind": kind::SKILL, "id": "skill/review" }],
            "caller": {
                "userId": "user-1",
                "orgId": "org-1",
                "role": "admin",
                "teams": [{ "id": "team-1", "orgId": "org-1", "role": "member" }]
            }
        })
    );
    assert!(!wire.to_string().contains("example.com"));

    let stored = input.caller.expect("the caller is stored");
    let again = stored.to_caller();
    assert_eq!(again.user_id, "user-1");
    assert_eq!(again.org_id.as_deref(), Some("org-1"));
    assert_eq!(again.role, OrgRole::Admin);
    assert_eq!(again.teams.len(), 1);
    assert_eq!(again.teams[0].id, "team-1");
    assert_eq!(again.email, None);
    assert!(!again.email_verified);

    // A role this build does not know is read as the lowest one.
    let unknown = StoredCaller {
        role: "superuser".to_owned(),
        ..stored
    };
    assert_eq!(unknown.to_caller().role, OrgRole::Viewer);

    // An anonymous local caller stores no caller at all.
    let anonymous =
        serde_json::to_value(import_input(&None, std::path::Path::new("/x"), &items)).unwrap();
    assert!(anonymous.get("caller").is_none());
}
