//! Run-trace retention: `RYU_TRACE_RETENTION_DAYS` / `RYU_TRACE_MAX_ROWS`
//! parsing, `prune_connection`, and `TraceStore::prune` / the boot pass.

use super::*;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// Open one closed span per name, in order, and return their ids.
async fn seed(store: &TraceStore, conv: &str, names: &[&str]) -> Vec<String> {
    let mut ids = Vec::new();
    for name in names {
        let id = store
            .open_span(conv, "tool-call", name, None, None)
            .await
            .unwrap();
        store.close_span(&id, None).await.unwrap();
        ids.push(id);
    }
    ids
}

async fn backdate(store: &TraceStore, id: &str, days: i64) {
    let conn = store.inner.conn.lock().await;
    conn.execute(
        "UPDATE spans SET started_at = ?1 WHERE id = ?2",
        params![now_millis() - days * DAY_MS, id],
    )
    .unwrap();
}

async fn names(store: &TraceStore, conv: &str) -> Vec<String> {
    store
        .get_spans(conv)
        .await
        .unwrap()
        .into_iter()
        .map(|span| span.name)
        .collect()
}

async fn prune_with(
    store: &TraceStore,
    days: Option<u64>,
    max_rows: Option<u64>,
) -> TracePruneSummary {
    let conn = store.inner.conn.lock().await;
    prune_connection(&conn, days, max_rows).unwrap()
}

fn temp_db(name: &str) -> PathBuf {
    std::env::temp_dir()
        .join(format!(
            "ryu-tracing-retention-{name}-{}",
            uuid::Uuid::new_v4()
        ))
        .join("traces.db")
}

#[tokio::test]
async fn prune_deletes_spans_older_than_the_day_cutoff() {
    let store = TraceStore::open_in_memory().unwrap();
    let ids = seed(&store, "conv-age", &["ancient", "recent", "fresh"]).await;
    backdate(&store, &ids[0], 10).await;
    backdate(&store, &ids[1], 2).await;

    let summary = prune_with(&store, Some(5), None).await;

    assert_eq!(summary.deleted_rows, 1);
    assert_eq!(summary.retention_days, Some(5));
    assert_eq!(summary.max_rows, None);
    assert_eq!(names(&store, "conv-age").await, ["recent", "fresh"]);
}

#[tokio::test]
async fn prune_keeps_only_the_newest_rows_by_seq() {
    let store = TraceStore::open_in_memory().unwrap();
    let ids = seed(&store, "conv-cap", &["s1", "s2", "s3", "s4", "s5"]).await;
    // The newest row by seq has the oldest start time: the cap must still keep
    // it, because it orders by insertion sequence, not by started_at.
    backdate(&store, &ids[4], 30).await;

    let summary = prune_with(&store, None, Some(2)).await;

    assert_eq!(summary.deleted_rows, 3);
    assert_eq!(summary.retention_days, None);
    assert_eq!(summary.max_rows, Some(2));
    assert_eq!(names(&store, "conv-cap").await, ["s4", "s5"]);
}

#[tokio::test]
async fn prune_applies_the_age_pass_before_the_row_cap() {
    let store = TraceStore::open_in_memory().unwrap();
    let ids = seed(&store, "conv-both", &["old1", "old2", "a", "b", "c"]).await;
    backdate(&store, &ids[0], 100).await;
    backdate(&store, &ids[1], 100).await;

    let summary = prune_with(&store, Some(7), Some(2)).await;

    // Two by age, then one more to bring the remaining three down to two.
    assert_eq!(summary.deleted_rows, 3);
    assert_eq!(names(&store, "conv-both").await, ["b", "c"]);
}

#[tokio::test]
async fn prune_without_bounds_deletes_nothing() {
    let store = TraceStore::open_in_memory().unwrap();
    let ids = seed(&store, "conv-off", &["x", "y", "z"]).await;
    backdate(&store, &ids[0], 10_000).await;

    let summary = prune_with(&store, None, None).await;

    assert_eq!(summary.deleted_rows, 0);
    assert_eq!(names(&store, "conv-off").await, ["x", "y", "z"]);
}

#[test]
fn retention_policy_parses_disables_and_falls_back() {
    let policy = |days: Option<&str>, rows: Option<&str>| {
        retention_policy_from(|name| match name {
            "RYU_TRACE_RETENTION_DAYS" => days.map(str::to_owned),
            "RYU_TRACE_MAX_ROWS" => rows.map(str::to_owned),
            other => panic!("unexpected env lookup {other}"),
        })
    };
    assert_eq!(policy(None, None), (Some(90), Some(1_000_000)));
    assert_eq!(policy(Some(" 7 "), Some("500")), (Some(7), Some(500)));
    assert_eq!(policy(Some("0"), Some("0")), (None, None));
    assert_eq!(policy(Some("0"), None), (None, Some(1_000_000)));
    assert_eq!(
        policy(Some("garbage"), Some("-1")),
        (Some(90), Some(1_000_000))
    );
    assert_eq!(policy(Some(""), Some("1.5")), (Some(90), Some(1_000_000)));
}

#[tokio::test]
async fn prune_on_an_in_memory_store_is_a_noop_summary() {
    let store = TraceStore::open_in_memory().unwrap();
    let ids = seed(&store, "conv-mem", &["kept"]).await;
    backdate(&store, &ids[0], 10_000).await;

    let summary = store.prune().await.unwrap();

    assert_eq!(summary.deleted_rows, 0);
    assert_eq!(summary.retention_days, None);
    assert_eq!(summary.max_rows, None);
    assert_eq!(names(&store, "conv-mem").await, ["kept"]);
}

#[tokio::test]
async fn persistent_store_prunes_expired_spans_on_demand_and_at_boot() {
    // Uses the process environment's policy; with the variables unset this is
    // the 90-day / 1,000,000-row default.
    let (days, max_rows) = trace_retention_policy();
    let Some(days) = days else {
        panic!("RYU_TRACE_RETENTION_DAYS disables retention in this environment");
    };
    let expired = i64::try_from(days).unwrap() + 30;
    let path = temp_db("persist");

    let store = TraceStore::open(path.clone()).unwrap();
    let ids = seed(&store, "conv-disk", &["stale", "live"]).await;
    backdate(&store, &ids[0], expired).await;
    let summary = store.prune().await.unwrap();
    assert_eq!(summary.deleted_rows, 1);
    assert_eq!(summary.retention_days, Some(days));
    assert_eq!(summary.max_rows, max_rows);
    assert_eq!(names(&store, "conv-disk").await, ["live"]);

    // A stale row written while the store was closed is removed by the boot
    // pass in `TraceStore::open`.
    backdate(&store, &ids[1], expired).await;
    drop(store);
    let reopened = TraceStore::open(path.clone()).unwrap();
    assert!(names(&reopened, "conv-disk").await.is_empty());
    drop(reopened);
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}
