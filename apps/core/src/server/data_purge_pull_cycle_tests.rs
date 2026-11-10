//! The pending-purge pull cycle against a fake control plane on loopback.

use std::sync::{Arc, Mutex};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};

use super::*;

const KEY: &str = "node-key";

/// Accepts `ok:<member>` as a purge delegation for `<member>`.
fn signed(token: &str, _: u64) -> Option<String> {
    token.strip_prefix("ok:").map(str::to_owned)
}

fn fixed_clock() -> u64 {
    100
}

/// A fake control plane: serves `purges`, records acks, and fails acks for
/// ids in `failing_acks`.
#[derive(Clone, Default)]
struct Cloud {
    purges: Arc<Mutex<Value>>,
    fail_pull: Arc<Mutex<Option<u16>>>,
    failing_acks: Arc<Mutex<Vec<String>>>,
    acks: Arc<Mutex<Vec<(String, String)>>>,
    keys: Arc<Mutex<Vec<String>>>,
}

async fn pull(State(cloud): State<Cloud>, headers: HeaderMap) -> (StatusCode, Json<Value>) {
    let key = headers
        .get("x-gateway-key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    cloud.keys.lock().unwrap().push(key);
    if let Some(status) = *cloud.fail_pull.lock().unwrap() {
        return (StatusCode::from_u16(status).unwrap(), Json(json!({})));
    }
    let purges = cloud.purges.lock().unwrap().clone();
    (StatusCode::OK, Json(json!({ "purges": purges })))
}

async fn ack(
    State(cloud): State<Cloud>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    if cloud.failing_acks.lock().unwrap().contains(&id) {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({})));
    }
    if id == "gone" {
        return (StatusCode::NOT_FOUND, Json(json!({})));
    }
    let status = body["status"].as_str().unwrap_or_default().to_owned();
    // Like the real store: a settled ("done") row is no longer pending, so the
    // next pull does not offer it again.
    if status == "done" {
        if let Some(rows) = cloud.purges.lock().unwrap().as_array_mut() {
            rows.retain(|row| row["id"] != id.as_str());
        }
    }
    cloud.acks.lock().unwrap().push((id, status));
    (
        StatusCode::OK,
        Json(json!({ "recorded": true, "state": "done" })),
    )
}

async fn serve(cloud: Cloud) -> String {
    let app = Router::new()
        .route(PULL_ROUTE, get(pull))
        .route(&format!("{PULL_ROUTE}/:id/ack"), post(ack))
        .with_state(cloud);
    serve_router(app).await
}

async fn serve_router(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    format!("http://{address}")
}

fn client() -> reqwest::Client {
    pull_client_builder().no_proxy().build().expect("client")
}

type Runs = Arc<Mutex<Vec<(String, PurgeReason)>>>;

fn executor(
    runs: Runs,
    complete: bool,
) -> impl FnMut(String, PurgeReason) -> std::future::Ready<bool> {
    move |user_id, reason| {
        runs.lock().unwrap().push((user_id, reason));
        std::future::ready(complete)
    }
}

#[tokio::test]
async fn a_cycle_runs_admitted_rows_and_acknowledges_each() {
    let cloud = Cloud::default();
    *cloud.purges.lock().unwrap() = json!([
        { "id": "p1", "user_id": "u1", "reason": "account_deleted", "delegation": "ok:u1" },
        { "id": "p2", "user_id": "u2", "reason": "member_removed", "delegation": "ok:u2" },
        { "id": "p3", "user_id": "u3", "reason": "self" },
        { "id": "p4", "user_id": "u4", "reason": "member_removed", "delegation": "forged" },
        { "id": "p5", "user_id": "u5", "reason": "account_deleted" },
    ]);
    let base = serve(cloud.clone()).await;
    let runs = Runs::default();
    let mut pending = PendingAcks::default();
    let report = run_cycle(
        &client(),
        &base,
        KEY,
        &mut pending,
        &signed,
        &fixed_clock,
        executor(runs.clone(), true),
    )
    .await
    .expect("cycle");
    assert_eq!(report.pulled, 5);
    assert_eq!(report.completed, 2);
    assert_eq!((report.refused, report.unauthorized), (3, 2));
    assert_eq!(
        *runs.lock().unwrap(),
        vec![
            ("u1".to_owned(), PurgeReason::AccountDeleted),
            ("u2".to_owned(), PurgeReason::MemberRemoved),
        ]
    );
    let acks = cloud.acks.lock().unwrap().clone();
    assert_eq!(
        acks,
        vec![
            ("p1".to_owned(), "done".to_owned()),
            ("p2".to_owned(), "done".to_owned()),
            // p4 (forged) and p5 (unsigned) are neither run nor acknowledged.
            ("p3".to_owned(), "incomplete".to_owned()),
        ]
    );
    assert_eq!(pending.len(), 0);
    assert!(cloud.keys.lock().unwrap().iter().all(|key| key == KEY));
}

#[tokio::test]
async fn an_unsigned_row_stays_pending_until_a_signed_pull_runs_it() {
    let cloud = Cloud::default();
    *cloud.purges.lock().unwrap() =
        json!([{ "id": "p1", "user_id": "u1", "reason": "member_removed" }]);
    let base = serve(cloud.clone()).await;
    let runs = Runs::default();
    let mut pending = PendingAcks::default();
    let first = run_cycle(
        &client(),
        &base,
        KEY,
        &mut pending,
        &signed,
        &fixed_clock,
        executor(runs.clone(), true),
    )
    .await
    .expect("first cycle");
    assert_eq!((first.completed, first.unauthorized), (0, 1));
    assert!(runs.lock().unwrap().is_empty());
    assert!(cloud.acks.lock().unwrap().is_empty());

    // The next pull carries a fresh delegation: now it runs and settles.
    *cloud.purges.lock().unwrap() = json!([
        { "id": "p1", "user_id": "u1", "reason": "member_removed", "delegation": "ok:u1" }
    ]);
    let second = run_cycle(
        &client(),
        &base,
        KEY,
        &mut pending,
        &signed,
        &fixed_clock,
        executor(runs.clone(), true),
    )
    .await
    .expect("second cycle");
    assert_eq!(second.completed, 1);
    assert_eq!(
        *runs.lock().unwrap(),
        vec![("u1".to_owned(), PurgeReason::MemberRemoved)]
    );
    assert_eq!(
        *cloud.acks.lock().unwrap(),
        vec![("p1".to_owned(), "done".to_owned())]
    );
}

#[tokio::test]
async fn the_real_verifier_runs_nothing_on_an_unregistered_node() {
    let cloud = Cloud::default();
    *cloud.purges.lock().unwrap() = json!([
        { "id": "p1", "user_id": "u1", "reason": "account_deleted", "delegation": "a.b.c" }
    ]);
    let base = serve(cloud.clone()).await;
    let runs = Runs::default();
    let report = run_cycle(
        &client(),
        &base,
        KEY,
        &mut PendingAcks::default(),
        &verified_purge_subject,
        &fixed_clock,
        executor(runs.clone(), true),
    )
    .await
    .expect("cycle");
    assert_eq!(report.unauthorized, 1);
    assert!(runs.lock().unwrap().is_empty());
    assert!(cloud.acks.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_incomplete_fan_out_is_never_acknowledged_done() {
    let cloud = Cloud::default();
    *cloud.purges.lock().unwrap() =
        json!([{ "id": "p1", "user_id": "u1", "reason": "member_removed", "delegation": "ok:u1" }]);
    let base = serve(cloud.clone()).await;
    let mut pending = PendingAcks::default();
    let report = run_cycle(
        &client(),
        &base,
        KEY,
        &mut pending,
        &signed,
        &fixed_clock,
        executor(Runs::default(), false),
    )
    .await
    .expect("cycle");
    assert_eq!(report.incomplete, 1);
    assert_eq!(
        *cloud.acks.lock().unwrap(),
        vec![("p1".to_owned(), "incomplete".to_owned())]
    );
    assert_eq!(pending.len(), 0);
}

#[tokio::test]
async fn a_lost_done_ack_is_retried_without_rerunning_the_purge() {
    let cloud = Cloud::default();
    *cloud.purges.lock().unwrap() = json!([{ "id": "p1", "user_id": "u1", "reason": "account_deleted", "delegation": "ok:u1" }]);
    cloud.failing_acks.lock().unwrap().push("p1".to_owned());
    let base = serve(cloud.clone()).await;
    let runs = Runs::default();
    let mut pending = PendingAcks::default();
    let first = run_cycle(
        &client(),
        &base,
        KEY,
        &mut pending,
        &signed,
        &fixed_clock,
        executor(runs.clone(), true),
    )
    .await
    .expect("first cycle");
    assert_eq!(first.ack_failed, 1);
    assert!(pending.contains("p1"));

    // Still failing: the row is offered again but not re-run.
    let second = run_cycle(
        &client(),
        &base,
        KEY,
        &mut pending,
        &signed,
        &fixed_clock,
        executor(runs.clone(), true),
    )
    .await
    .expect("second cycle");
    assert_eq!(second.completed, 0);
    assert_eq!(runs.lock().unwrap().len(), 1);

    // The ack recovers: it is re-sent first, and the row is not re-run.
    cloud.failing_acks.lock().unwrap().clear();
    let third = run_cycle(
        &client(),
        &base,
        KEY,
        &mut pending,
        &signed,
        &fixed_clock,
        executor(runs.clone(), true),
    )
    .await
    .expect("third cycle");
    assert_eq!(third.reacked, 1);
    assert!(!pending.contains("p1"));
    assert_eq!(runs.lock().unwrap().len(), 1);
    assert_eq!(
        *cloud.acks.lock().unwrap(),
        vec![("p1".to_owned(), "done".to_owned())]
    );
}

#[tokio::test]
async fn a_row_the_cloud_no_longer_has_counts_as_settled() {
    let cloud = Cloud::default();
    let base = serve(cloud.clone()).await;
    let mut pending = PendingAcks::default();
    pending.insert("gone", AckStatus::Done);
    *cloud.purges.lock().unwrap() = json!([]);
    let report = run_cycle(
        &client(),
        &base,
        KEY,
        &mut pending,
        &signed,
        &fixed_clock,
        executor(Runs::default(), true),
    )
    .await
    .expect("cycle");
    assert_eq!(report.reacked, 1);
    assert_eq!(pending.len(), 0);
}

#[tokio::test]
async fn a_refused_pull_fails_the_cycle_and_runs_nothing() {
    let cloud = Cloud::default();
    *cloud.fail_pull.lock().unwrap() = Some(401);
    let base = serve(cloud.clone()).await;
    let runs = Runs::default();
    let mut pending = PendingAcks::default();
    let result = run_cycle(
        &client(),
        &base,
        KEY,
        &mut pending,
        &signed,
        &fixed_clock,
        executor(runs.clone(), true),
    )
    .await;
    assert_eq!(result, Err(CycleError::Status(401)));
    assert!(runs.lock().unwrap().is_empty());
    assert!(cloud.acks.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_unreachable_control_plane_is_a_network_error() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("address"));
    drop(listener);
    let mut pending = PendingAcks::default();
    let result = run_cycle(
        &client(),
        &base,
        KEY,
        &mut pending,
        &signed,
        &fixed_clock,
        executor(Runs::default(), true),
    )
    .await;
    assert_eq!(result, Err(CycleError::Network));
}

#[tokio::test]
async fn real_cloud_row_ids_are_acknowledged_under_their_decoded_id() {
    let cloud = Cloud::default();
    let id = "665f1c2a9b3e4d0012ab34cd:user/abc?x#y%z";
    *cloud.purges.lock().unwrap() = json!([{ "id": id, "user_id": "user_abc", "reason": "account_deleted", "delegation": "ok:user_abc" }]);
    let base = serve(cloud.clone()).await;
    let report = run_cycle(
        &client(),
        &base,
        KEY,
        &mut PendingAcks::default(),
        &signed,
        &fixed_clock,
        executor(Runs::default(), true),
    )
    .await
    .expect("cycle");
    assert_eq!((report.completed, report.malformed), (1, 0));
    assert_eq!(
        *cloud.acks.lock().unwrap(),
        vec![(id.to_owned(), "done".to_owned())]
    );
}

#[tokio::test]
async fn every_row_is_admitted_at_the_time_the_pull_arrived() {
    use std::sync::atomic::{AtomicU64, Ordering};
    let cloud = Cloud::default();
    *cloud.purges.lock().unwrap() = json!([
        { "id": "p1", "user_id": "u1", "reason": "member_removed", "delegation": "ok:u1" },
        { "id": "p2", "user_id": "u2", "reason": "member_removed", "delegation": "ok:u2" },
    ]);
    let base = serve(cloud.clone()).await;
    let now = Arc::new(AtomicU64::new(100));
    let clock = {
        let now = now.clone();
        move || now.load(Ordering::SeqCst)
    };
    // Valid only up to the fetch time; each purge takes a minute.
    let verify = |token: &str, at: u64| {
        token
            .strip_prefix("ok:")
            .filter(|_| at <= 100)
            .map(str::to_owned)
    };
    let runs = Runs::default();
    let report = run_cycle(
        &client(),
        &base,
        KEY,
        &mut PendingAcks::default(),
        &verify,
        &clock,
        |user_id, reason| {
            runs.lock().unwrap().push((user_id, reason));
            now.fetch_add(60, Ordering::SeqCst);
            std::future::ready(true)
        },
    )
    .await
    .expect("cycle");
    assert_eq!((report.completed, report.refused), (2, 0));
    assert_eq!(runs.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_redirect_never_carries_the_node_key_to_another_origin() {
    let leaked = Arc::new(Mutex::new(Vec::<String>::new()));
    let other = {
        let leaked = leaked.clone();
        serve_router(Router::new().fallback(move |headers: HeaderMap| {
            let leaked = leaked.clone();
            async move {
                if let Some(key) = headers.get("x-gateway-key") {
                    leaked
                        .lock()
                        .unwrap()
                        .push(key.to_str().unwrap_or_default().to_owned());
                }
                Json(json!({ "purges": [] }))
            }
        }))
        .await
    };
    let target = format!("{other}{PULL_ROUTE}");
    let base = serve_router(Router::new().route(
        PULL_ROUTE,
        get(move || {
            let target = target.clone();
            async move { (StatusCode::FOUND, [("location", target)]) }
        }),
    ))
    .await;
    let result = run_cycle(
        &client(),
        &base,
        KEY,
        &mut PendingAcks::default(),
        &signed,
        &fixed_clock,
        executor(Runs::default(), true),
    )
    .await;
    assert_eq!(result, Err(CycleError::Status(302)));
    assert!(leaked.lock().unwrap().is_empty());
}
