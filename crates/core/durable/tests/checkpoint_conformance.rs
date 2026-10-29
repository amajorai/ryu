//! Shared `CheckpointStore` conformance suite.
//!
//! One set of semantics, run against every backend:
//!
//! - `file`, `memory`, and Redis over the in-process RESP test server — always;
//! - live Redis/Valkey when `RYU_TEST_REDIS_URL` is set (e.g. `redis://127.0.0.1:6379/15`);
//! - live Postgres when `RYU_TEST_POSTGRES_URL` is set
//!   (e.g. `postgres://postgres@127.0.0.1:5432/postgres?sslmode=disable`).
//!
//! Live suites print a `SKIPPED` line and pass when their variable is unset, so
//! a plain `cargo test` never needs external services. Each live run uses a
//! unique key prefix / table so it cannot collide with real data, and cleans up
//! the records it wrote.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use ryu_durable::{
    load, save, CheckpointBackend, CheckpointBackendKind, CheckpointError, CheckpointStore,
    CheckpointStoreConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Opens fresh handles onto one configured backend, the way a restarted host
/// would: every call to `open` builds a new `CheckpointBackend` from the same
/// configuration (memory is the exception: it shares one backend, since a new
/// process would start empty by design).
struct Harness {
    config: CheckpointStoreConfig,
    shared: Option<CheckpointBackend>,
    root: PathBuf,
}

impl Harness {
    fn new(config: CheckpointStoreConfig) -> Self {
        let shared = (config.backend == CheckpointBackendKind::Memory)
            .then(|| CheckpointBackend::open(&config).expect("open memory backend"));
        let root = std::env::temp_dir().join(format!("ryu-durable-conformance-{}", unique()));
        Self {
            config,
            shared,
            root,
        }
    }

    fn open(&self, namespace: &str) -> Arc<dyn CheckpointStore> {
        let backend = match &self.shared {
            Some(backend) => backend.clone(),
            None => CheckpointBackend::open(&self.config).expect("open backend"),
        };
        backend
            .store(namespace, &self.dir(namespace))
            .expect("store for namespace")
    }

    fn dir(&self, namespace: &str) -> PathBuf {
        self.root.join(namespace)
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn unique() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("{}_{nanos}", std::process::id())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Run {
    run_id: String,
    step: u32,
    outputs: Vec<String>,
}

async fn clear(store: &dyn CheckpointStore) {
    for id in store.list().await.expect("list") {
        store.delete(&id).await.expect("delete");
    }
}

/// The contract every backend must meet.
async fn conformance(harness: &Harness) {
    let runs = harness.open("runs");
    clear(runs.as_ref()).await;

    // 1. An absent id is Ok(None), not an error.
    assert_eq!(runs.get("run_absent").await.expect("get absent"), None);

    // 2. put/get round-trips arbitrary JSON, including unicode and nesting.
    let state = json!({
        "run_id": "run_1",
        "status": "running",
        "nodes": {"a": {"done": true, "out": [1, 2.5, null, "ü✓"]}},
        "count": 9_007_199_254_740_991_i64,
    });
    runs.put("run_1", &state).await.expect("put");
    assert_eq!(runs.get("run_1").await.expect("get"), Some(state.clone()));

    // 3. Last write wins.
    let next = json!({"run_id": "run_1", "status": "done"});
    runs.put("run_1", &next).await.expect("overwrite");
    assert_eq!(runs.get("run_1").await.expect("get"), Some(next));

    // 4. Typed helpers round-trip a serde record.
    let typed = Run {
        run_id: "run_2".into(),
        step: 3,
        outputs: vec!["x".into(), "y".into()],
    };
    save(runs.as_ref(), "run_2", &typed).await.expect("save");
    assert_eq!(
        load::<Run>(runs.as_ref(), "run_2").await.expect("load"),
        Some(typed)
    );
    assert!(matches!(
        load::<Run>(runs.as_ref(), "run_1").await,
        Err(CheckpointError::Serialization(_))
    ));

    // 5. list is sorted bytewise and reflects puts.
    runs.put("Run_0", &json!(0)).await.expect("put");
    runs.put("run-9", &json!(9)).await.expect("put");
    assert_eq!(
        runs.list().await.expect("list"),
        ["Run_0", "run-9", "run_1", "run_2"]
    );

    // 6. delete reports existence and removes from get and list.
    assert!(runs.delete("run-9").await.expect("delete"));
    assert!(!runs.delete("run-9").await.expect("delete again"));
    assert_eq!(runs.get("run-9").await.expect("get"), None);
    assert_eq!(
        runs.list().await.expect("list"),
        ["Run_0", "run_1", "run_2"]
    );

    // 7. Namespaces are isolated.
    let workflows = harness.open("workflows");
    clear(workflows.as_ref()).await;
    assert_eq!(workflows.get("run_1").await.expect("get"), None);
    assert!(workflows.list().await.expect("list").is_empty());
    workflows.put("run_1", &json!("wf")).await.expect("put");
    assert_eq!(
        runs.get("run_1").await.expect("get").unwrap()["status"],
        "done"
    );

    // 8. Invalid ids are rejected on every verb before any I/O.
    for bad in ["../escape", "a/b", "a.b", "", "a b", "a:b", "a*"] {
        assert!(
            matches!(
                runs.put(bad, &json!(1)).await,
                Err(CheckpointError::InvalidId(_))
            ),
            "put {bad:?}"
        );
        assert!(
            matches!(runs.get(bad).await, Err(CheckpointError::InvalidId(_))),
            "get {bad:?}"
        );
        assert!(
            matches!(runs.delete(bad).await, Err(CheckpointError::InvalidId(_))),
            "delete {bad:?}"
        );
    }

    // 9. Concurrent writers to different ids all land.
    let writers: Vec<_> = (0..16)
        .map(|n| {
            let store = Arc::clone(&runs);
            tokio::spawn(async move {
                store
                    .put(&format!("conc_{n:02}"), &json!({"n": n}))
                    .await
                    .expect("concurrent put");
            })
        })
        .collect();
    for writer in writers {
        writer.await.expect("join writer");
    }
    let listed = runs.list().await.expect("list");
    assert_eq!(
        listed.iter().filter(|id| id.starts_with("conc_")).count(),
        16
    );

    // 10. Large records round-trip.
    let big = json!({"blob": "x".repeat(512 * 1024)});
    runs.put("run_big", &big).await.expect("put big");
    assert_eq!(runs.get("run_big").await.expect("get big"), Some(big));

    // 11. A fresh handle from the same configuration sees committed records.
    let reopened = harness.open("runs");
    assert_eq!(
        reopened
            .get("run_1")
            .await
            .expect("get via fresh handle")
            .unwrap()["status"],
        "done"
    );
    assert_eq!(
        reopened.list().await.expect("list"),
        runs.list().await.expect("list")
    );

    clear(runs.as_ref()).await;
    clear(workflows.as_ref()).await;
    assert!(reopened.list().await.expect("list").is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn file_backend_conforms() {
    let harness = Harness::new(CheckpointStoreConfig::default());
    conformance(&harness).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn file_backend_ignores_interrupted_temp_files() {
    let harness = Harness::new(CheckpointStoreConfig::default());
    let store = harness.open("runs");
    store.put("run_1", &json!(1)).await.expect("put");
    let dir: &Path = &harness.dir("runs");
    std::fs::write(dir.join("run_2.json.tmp"), b"{\"half").expect("write temp");
    assert_eq!(store.list().await.expect("list"), ["run_1"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn memory_backend_conforms() {
    let harness = Harness::new(CheckpointStoreConfig {
        backend: CheckpointBackendKind::Memory,
        ..CheckpointStoreConfig::default()
    });
    conformance(&harness).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn redis_backend_conforms_over_the_in_process_resp_server() {
    let server = ryu_redis_wire::testing::FakeRedis::start().await;
    let harness = Harness::new(CheckpointStoreConfig {
        backend: CheckpointBackendKind::Redis,
        redis_url: Some(server.url()),
        redis_key_prefix: format!("conformance:{}", unique()),
        ..CheckpointStoreConfig::default()
    });
    conformance(&harness).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn redis_backend_conforms_live() {
    let Some(url) = std::env::var("RYU_TEST_REDIS_URL")
        .ok()
        .filter(|v| !v.is_empty())
    else {
        eprintln!("SKIPPED redis_backend_conforms_live: set RYU_TEST_REDIS_URL to run it");
        return;
    };
    let harness = Harness::new(CheckpointStoreConfig {
        backend: CheckpointBackendKind::Redis,
        redis_url: Some(url),
        redis_key_prefix: format!("ryu-conformance:{}", unique()),
        ..CheckpointStoreConfig::default()
    });
    conformance(&harness).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_backend_conforms_live() {
    let Some(url) = std::env::var("RYU_TEST_POSTGRES_URL")
        .ok()
        .filter(|v| !v.is_empty())
    else {
        eprintln!("SKIPPED postgres_backend_conforms_live: set RYU_TEST_POSTGRES_URL to run it");
        return;
    };
    let harness = Harness::new(CheckpointStoreConfig {
        backend: CheckpointBackendKind::Postgres,
        postgres_url: Some(url),
        postgres_table: format!("ryu_conformance_{}", unique()),
        ..CheckpointStoreConfig::default()
    });
    conformance(&harness).await;
}

#[test]
fn non_object_json_round_trips_through_typed_helpers() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        let harness = Harness::new(CheckpointStoreConfig::default());
        let store = harness.open("misc");
        save(store.as_ref(), "scalar", &42_u32).await.expect("save");
        assert_eq!(
            load::<u32>(store.as_ref(), "scalar").await.expect("load"),
            Some(42)
        );
        let value: Option<Value> = load(store.as_ref(), "absent").await.expect("load absent");
        assert_eq!(value, None);
    });
}
