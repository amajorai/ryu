//! `/heartbeat/jobs*` and app-owned job targets: reconciled targets are never
//! created or retargeted through the API, and released clients do not see them
//! unless they opt in. Real handlers and file persistence; no tick or provider.
use super::*;
use crate::scheduler::store::{self, JobTarget, Schedule, ScheduledJob};
use axum::extract::{Extension, Path, Query, State};
use serde_json::{json, Value};

fn state(directory: &std::path::Path) -> ServerState {
    isolated_plugin_hook_test_state(directory)
}

fn app_job() -> ScheduledJob {
    ScheduledJob {
        id: "app-0123456789abcdef0123456789abcdef".to_owned(),
        name: "monitor: Site".to_owned(),
        schedule: Schedule::Every {
            interval: "5m".to_owned(),
        },
        target: JobTarget::AppJob {
            plugin_id: "@example/owner".to_owned(),
            job_id: "m1".to_owned(),
            payload: None,
        },
        enabled: true,
        require_approval: false,
        owner_app: Some("@example/owner".to_owned()),
        owner_user_id: None,
        org_id: None,
        created_at: "2026-01-01T00:00:00Z".to_owned(),
        updated_at: "2026-01-01T00:00:00Z".to_owned(),
        last_run_at: None,
        last_outcome: None,
        history: Vec::new(),
    }
}

async fn create(state: &ServerState, target: Value) -> (StatusCode, Value) {
    let input = json!({
        "name": "attempt",
        "schedule": { "kind": "every", "interval": "1h" },
        "target": target,
    });
    let (status, Json(body)) = create_job(
        State(state.clone()),
        Extension(None),
        Json(serde_json::from_value(input).unwrap()),
    )
    .await;
    (status, body)
}

async fn update(state: &ServerState, id: &str, body: Value) -> StatusCode {
    update_job(
        State(state.clone()),
        Extension(None),
        Path(id.to_owned()),
        Json(serde_json::from_value(body).unwrap()),
    )
    .await
    .status()
}

async fn list(state: &ServerState, include: Option<&str>) -> Vec<String> {
    let response = list_jobs(
        State(state.clone()),
        Extension(None),
        Query(IncludeQuery {
            include: include.map(str::to_owned),
        }),
    )
    .await;
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    body["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|job| job["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn reconciled_targets_cannot_be_created() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    store::with_test_jobs_directory(directory.path().join("jobs"), async {
        for target in [
            json!({ "type": "app_job", "plugin_id": "@example/owner", "job_id": "m1" }),
            json!({ "type": "quest", "quest_id": "q1" }),
            // The retired per-app shape is read as an app job, so it is refused too.
            json!({ "type": "monitor", "monitor_id": "m1" }),
        ] {
            let (status, body) = create(&state, target.clone()).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{target}: {body}");
        }
        assert!(store::list_jobs().is_empty());
    })
    .await;
}

/// The reconcile rewrites an app job's name, schedule and enabled state from the
/// app on every pass, so a PUT that changes them is refused rather than silently
/// undone; one that restates them is accepted.
#[tokio::test]
async fn reconciled_jobs_follow_their_app_and_are_never_retargeted_or_approval_gated() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    store::with_test_jobs_directory(directory.path().join("jobs"), async {
        let job = app_job();
        store::save_job(&job).unwrap();
        for change in [
            json!({ "enabled": false }),
            json!({ "name": "renamed" }),
            json!({ "schedule": { "kind": "every", "interval": "1h" } }),
        ] {
            assert_eq!(
                update(&state, &job.id, change.clone()).await,
                StatusCode::BAD_REQUEST,
                "{change}"
            );
        }
        let unchanged = store::load_job(&job.id).unwrap();
        assert!(unchanged.enabled);
        assert_eq!(unchanged.name, job.name);
        assert_eq!(
            update(
                &state,
                &job.id,
                json!({ "enabled": true, "name": job.name.clone() })
            )
            .await,
            StatusCode::OK
        );
        assert_eq!(
            update(&state, &job.id, json!({ "require_approval": true })).await,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            update(
                &state,
                &job.id,
                json!({ "target": { "type": "app_job", "plugin_id": "@example/other", "job_id": "m1" } })
            )
            .await,
            StatusCode::BAD_REQUEST
        );
        // Nor away from one: that would orphan the job and the next reconcile would
        // mint a duplicate with no history.
        let mut quest = app_job();
        quest.id = "quest-q1".to_owned();
        quest.target = JobTarget::Quest {
            quest_id: "q1".to_owned(),
        };
        store::save_job(&quest).unwrap();
        for id in [&job.id, &quest.id] {
            for target in [
                json!({ "type": "agent", "agent_id": "a1", "prompt": "hi" }),
                json!({ "type": "workflow", "workflow_id": "w1" }),
            ] {
                assert_eq!(
                    update(&state, id, json!({ "target": target.clone() })).await,
                    StatusCode::BAD_REQUEST,
                    "{id} -> {target}"
                );
            }
        }
        assert!(matches!(
            store::load_job(&job.id).unwrap().target,
            JobTarget::AppJob { .. }
        ));
        assert!(matches!(
            store::load_job(&quest.id).unwrap().target,
            JobTarget::Quest { .. }
        ));

        // Retargeting an ordinary job onto a reconciled target is refused.
        let mut workflow = app_job();
        workflow.id = "job_workflow".to_owned();
        workflow.owner_app = None;
        workflow.target = JobTarget::Workflow {
            workflow_id: "w1".to_owned(),
            input: std::collections::HashMap::new(),
        };
        store::save_job(&workflow).unwrap();
        for target in [
            json!({ "type": "app_job", "plugin_id": "@example/owner", "job_id": "m1" }),
            json!({ "type": "quest", "quest_id": "q1" }),
        ] {
            assert_eq!(
                update(&state, &workflow.id, json!({ "target": target })).await,
                StatusCode::BAD_REQUEST
            );
        }
        assert!(matches!(
            store::load_job(&workflow.id).unwrap().target,
            JobTarget::Workflow { .. }
        ));
    })
    .await;
}

async fn delete(state: &ServerState, id: &str) -> StatusCode {
    delete_job(State(state.clone()), Extension(None), Path(id.to_owned()))
        .await
        .status()
}

/// Deleting an app job its app still lists would only tombstone it until the next
/// reconcile recreates it under a fresh id with no history, so the delete is
/// refused while the app is installed (enabled or not) and allowed once the app is
/// gone, so a partly failed uninstall can still be cleaned up.
#[tokio::test]
async fn app_jobs_cannot_be_deleted_while_their_app_is_installed() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    store::with_test_jobs_directory(directory.path().join("jobs"), async {
        let job = app_job();
        store::save_job(&job).unwrap();
        state
            .app_store
            .insert("@example/owner", "1.0.0")
            .await
            .unwrap();

        assert_eq!(delete(&state, &job.id).await, StatusCode::CONFLICT);
        assert!(
            store::load_job(&job.id).is_ok(),
            "the job and its history stay"
        );

        state.app_store.remove("@example/owner").await.unwrap();
        assert_eq!(delete(&state, &job.id).await, StatusCode::OK);
        assert!(store::load_job(&job.id).is_err());
    })
    .await;
}

#[tokio::test]
async fn app_jobs_are_listed_only_on_request() {
    let directory = tempfile::tempdir().unwrap();
    let state = state(directory.path());
    store::with_test_jobs_directory(directory.path().join("jobs"), async {
        let job = app_job();
        store::save_job(&job).unwrap();
        let mut workflow = app_job();
        workflow.id = "job_workflow".to_owned();
        workflow.owner_app = None;
        workflow.target = JobTarget::Workflow {
            workflow_id: "w1".to_owned(),
            input: std::collections::HashMap::new(),
        };
        store::save_job(&workflow).unwrap();

        assert_eq!(list(&state, None).await, vec!["job_workflow".to_owned()]);
        assert_eq!(
            list(&state, Some("other")).await,
            vec!["job_workflow".to_owned()]
        );
        let mut all = list(&state, Some("other,app_jobs")).await;
        all.sort();
        assert_eq!(all, vec![job.id.clone(), "job_workflow".to_owned()]);
    })
    .await;
}
