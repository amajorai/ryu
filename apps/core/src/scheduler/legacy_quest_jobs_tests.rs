//! Tests for [`super`] (the `JobTarget::Quest` tick and reconcile).

use super::*;
use crate::scheduler::store::ExecOutcome;
use crate::sidecar::capability_consumer::test_support::{
    consumer_with, consumer_without_providers, fixture_manifest, registered, serve,
};
use axum::routing::post;
use axum::{Json, Router};

fn job(id: &str, target: JobTarget) -> ScheduledJob {
    ScheduledJob {
        id: id.to_string(),
        name: id.to_string(),
        schedule: Schedule::Every {
            interval: "2m".into(),
        },
        target,
        enabled: true,
        require_approval: false,
        owner_app: None,
        owner_user_id: None,
        org_id: None,
        created_at: "t".into(),
        updated_at: "t".into(),
        last_run_at: None,
        last_outcome: None::<ExecOutcome>,
        history: Vec::new(),
    }
}

fn quest_job(quest_id: &str) -> ScheduledJob {
    job(&quest_job_id(quest_id), quest_target(quest_id))
}

#[test]
fn an_authoritative_empty_list_sweeps_only_quest_jobs() {
    let app = job(
        "app-x",
        JobTarget::AppJob {
            plugin_id: "@example/a".into(),
            job_id: "a1".into(),
            payload: None,
        },
    );
    let jobs = vec![quest_job("q1"), app];
    assert_eq!(jobs_to_sweep(&[], &jobs), vec![quest_job_id("q1")]);
}

#[test]
fn a_partial_list_sweeps_only_the_missing_items() {
    let jobs = vec![quest_job("q1"), quest_job("q2")];
    let live = quest_backing_jobs(&QuestList {
        quests: vec![json!({ "id": "q1", "title": "one", "status": "open" })],
        interval: "2m".into(),
    });
    assert_eq!(jobs_to_sweep(&live, &jobs), vec![quest_job_id("q2")]);
}

#[test]
fn job_ids_and_names_stay_byte_identical() {
    assert_eq!(quest_job_id("abc"), "quest-abc");
    assert_eq!(quest_job_name("Ship"), "quest: Ship");
}

#[test]
fn backing_jobs_follow_quest_state_and_interval() {
    let quests = quest_backing_jobs(&QuestList {
        quests: vec![
            json!({ "id": "q1", "title": "open one", "status": "open" }),
            json!({ "id": "q2", "title": "done", "status": "completed" }),
            json!({ "title": "no id" }),
        ],
        interval: "10m".into(),
    });
    assert_eq!(quests.len(), 2);
    assert!(quests[0].enabled && !quests[1].enabled);
    assert_eq!(
        quests[0].schedule,
        Schedule::Every {
            interval: "10m".into()
        }
    );
}

/// With the Quests app disabled, not installed, or no consumer installed at
/// all, a tick is a quiet success and the reconcile touches nothing.
#[tokio::test]
async fn ticks_and_reconciles_fail_open_when_the_app_is_disabled_or_missing() {
    let disabled = consumer_with(
        fixture_manifest(
            1,
            &[
                (CAP_QUESTS_LIST, Some("/quests/list")),
                (CAP_QUESTS_JUDGE, Some("/quests/judge")),
            ],
        ),
        false,
    )
    .await;
    let missing = consumer_without_providers();
    for consumer in [Some(&disabled), Some(&missing), None] {
        assert_eq!(judge_quest(consumer, "q1").await, Ok(()));
        assert_eq!(
            reconcile_quest_jobs(consumer).await,
            ReconcileOutcome::Skipped
        );
    }
}

/// The tick and list calls reach the provider's declared routes with the bodies
/// the contract names.
#[tokio::test]
async fn ticks_and_lists_speak_the_capability_contract() {
    let (consumer, _sidecar, port) = registered(&[
        (CAP_QUESTS_LIST, Some("/quests/list")),
        (CAP_QUESTS_JUDGE, Some("/quests/judge")),
    ])
    .await;
    let app = Router::new()
        .route(
            "/api/fixture/quests/list",
            post(|| async {
                Json(json!({
                    "quests": [{ "id": "q1", "title": "Ship", "status": "open",
                                 "completion_condition": "shipped" }],
                    "interval": "7m",
                }))
            }),
        )
        .route(
            "/api/fixture/quests/judge",
            post(|Json(body): Json<Value>| async move {
                // The node's UI language rides along for the judge's reason.
                let has_locale = body["locale"].as_str().is_some_and(|l| !l.is_empty());
                if body["id"] == "q1" && has_locale {
                    (axum::http::StatusCode::OK, Json(json!({ "met": false })))
                } else {
                    (
                        axum::http::StatusCode::BAD_REQUEST,
                        Json(json!({ "error": "quest\nnot found" })),
                    )
                }
            }),
        );
    let server = serve(port, app).await;

    let list = list_quests(Some(&consumer)).await.unwrap();
    assert_eq!(list.interval, "7m");
    assert_eq!(list.quests.len(), 1);
    assert_eq!(judge_quest(Some(&consumer), "q1").await, Ok(()));
    // A provider-side refusal surfaces its own (cleaned) error text.
    assert_eq!(
        judge_quest(Some(&consumer), "gone").await,
        Err("quest not found".to_owned())
    );
    server.abort();
}

/// A 2xx reply without the list is "unknown", never "empty": it must not be
/// allowed to drive the orphan sweep.
#[tokio::test]
async fn a_list_reply_without_its_array_is_not_authoritative() {
    let (consumer, _sidecar, port) = registered(&[(CAP_QUESTS_LIST, Some("/quests/list"))]).await;
    let app = Router::new().route(
        "/api/fixture/quests/list",
        post(|| async { Json(json!({ "error": "store locked" })) }),
    );
    let server = serve(port, app).await;
    assert_eq!(
        reconcile_quest_jobs(Some(&consumer)).await,
        ReconcileOutcome::Skipped
    );
    server.abort();
}

/// A Quests sidecar that accepts the call but never answers times out: the
/// list is unknown, nothing is swept, and the shared reconcile loop moves on.
#[tokio::test]
async fn a_hung_quest_list_times_out_and_touches_nothing() {
    let (consumer, _sidecar, port) = registered(&[(CAP_QUESTS_LIST, Some("/quests/list"))]).await;
    let app = Router::new().route(
        "/api/fixture/quests/list",
        post(|| async {
            std::future::pending::<()>().await;
            Json(json!({}))
        }),
    );
    let server = serve(port, app).await;
    let outcome = tokio::time::timeout(
        Duration::from_secs(10),
        reconcile_quest_jobs_within(Some(&consumer), Duration::from_millis(200)),
    )
    .await
    .expect("the quest reconcile returns despite a hung provider");
    assert_eq!(outcome, ReconcileOutcome::Skipped);
    let failure = list_quests_within(Some(&consumer), Duration::from_millis(200))
        .await
        .unwrap_err();
    assert!(!failure.unbound);
    assert!(failure.message.contains("timed out"), "{}", failure.message);
    server.abort();
}

#[test]
fn usable_text_drops_unavailable_and_empty_results() {
    assert_eq!(
        usable_text(&json!({ "available": false, "text": "x" })),
        None
    );
    assert_eq!(usable_text(&json!({ "summary": "  " })), None);
    assert_eq!(
        usable_text(&json!({ "summary": " did a thing " })),
        Some("did a thing".to_owned())
    );
}
