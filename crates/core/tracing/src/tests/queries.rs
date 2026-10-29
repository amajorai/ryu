use std::sync::Arc;

use rusqlite::{params, Connection};

use super::*;
use crate::store::now_millis;

#[tokio::test]
async fn list_traces_filters_by_agent_status_kind_time_and_search() {
    let store = TraceStore::open_in_memory().unwrap();
    let ok = store
        .begin_scope(SpanStart::new("run-a", SpanKind::AgentRun, "support bot").agent(Some("a1")))
        .await
        .unwrap();
    let tool = store
        .start_span(SpanStart::new("run-a", SpanKind::ToolCall, "search"))
        .await
        .unwrap();
    store
        .end_span(&tool.id, SpanEnd::error("timeout"))
        .await
        .unwrap();
    store.end_scope(&ok, SpanEnd::ok()).await.unwrap();
    let failed = store
        .begin_scope(
            SpanStart::new("run-b", SpanKind::WorkflowRun, "nightly etl").agent(Some("a2")),
        )
        .await
        .unwrap();
    store
        .end_scope(&failed, SpanEnd::error("boom"))
        .await
        .unwrap();
    // A legacy flat span never appears as a trace.
    let legacy = store
        .open_span("run-c", "tool-call", "x", None, None)
        .await
        .unwrap();
    store.close_span(&legacy, None).await.unwrap();

    let all = store.list_traces(&TraceQuery::default()).await.unwrap();
    assert_eq!(all.len(), 3, "the unscoped legacy span is its own root");
    let by_agent = store
        .list_traces(&TraceQuery {
            agent_id: Some("a1".into()),
            ..TraceQuery::default()
        })
        .await
        .unwrap();
    assert_eq!(by_agent.len(), 1);
    assert_eq!(by_agent[0].span_count, 2);
    assert_eq!(by_agent[0].error_count, 1);
    assert_eq!(by_agent[0].status, SpanStatus::Ok);
    let errors = store
        .list_traces(&TraceQuery {
            status: Some(SpanStatus::Error),
            kind: Some(SpanKind::WorkflowRun),
            ..TraceQuery::default()
        })
        .await
        .unwrap();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].run_id, "run-b");
    let scoped = store
        .list_traces(&TraceQuery {
            run_ids: Some(vec!["run-b".into()]),
            ..TraceQuery::default()
        })
        .await
        .unwrap();
    assert_eq!(scoped.len(), 1);
    let none_visible = store
        .list_traces(&TraceQuery {
            run_ids: Some(Vec::new()),
            ..TraceQuery::default()
        })
        .await
        .unwrap();
    assert!(none_visible.is_empty());
    let searched = store
        .list_traces(&TraceQuery {
            search: Some("ETL".into()),
            ..TraceQuery::default()
        })
        .await
        .unwrap();
    assert_eq!(searched.len(), 1);
    let by_trace = store
        .list_traces(&TraceQuery {
            search: Some(ok.trace_id.clone()),
            ..TraceQuery::default()
        })
        .await
        .unwrap();
    assert_eq!(by_trace[0].root_id, ok.id);
    let future = store
        .list_traces(&TraceQuery {
            since: Some(now_millis() + 60_000),
            ..TraceQuery::default()
        })
        .await
        .unwrap();
    assert!(future.is_empty());
    let page = store
        .list_traces(&TraceQuery {
            limit: 1,
            offset: 1,
            ..TraceQuery::default()
        })
        .await
        .unwrap();
    assert_eq!(page.len(), 1);
}

#[derive(Default)]
struct RecordingSink(std::sync::Mutex<Vec<String>>);

impl SpanSink for RecordingSink {
    fn on_span_end(&self, span: &Span) {
        self.0
            .lock()
            .unwrap()
            .push(format!("{}:{}", span.name, span.status));
    }
}

#[tokio::test]
async fn sink_sees_each_span_once_when_it_ends() {
    let store = TraceStore::open_in_memory().unwrap();
    let sink = Arc::new(RecordingSink::default());
    store.set_sink(Some(sink.clone()));
    let span = store
        .start_span(SpanStart::new("conv-k", SpanKind::Guardrail, "pii"))
        .await
        .unwrap();
    store.end_span(&span.id, SpanEnd::ok()).await.unwrap();
    store
        .end_span(&span.id, SpanEnd::error("late"))
        .await
        .unwrap();
    assert_eq!(*sink.0.lock().unwrap(), vec!["pii:ok".to_owned()]);
}

#[tokio::test]
async fn v1_database_upgrades_in_place() {
    let dir = std::env::temp_dir().join(format!("ryu-tracing-upgrade-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("traces.db");
    {
        // Recent timestamps: the open-time retention pass drops old rows.
        let now = now_millis();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE spans (
                 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
                 conversation_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
                 args_hash TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, error TEXT);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO spans (id, conversation_id, kind, name, started_at, ended_at, error)
             VALUES ('old-1', 'conv-old', 'tool-call', 'bash', ?1, ?2, 'denied'),
                    ('old-2', 'conv-old', 'model-call', 'm', ?3, NULL, NULL)",
            params![now - 30, now - 20, now - 10],
        )
        .unwrap();
    }
    let store = TraceStore::open(path).unwrap();
    let spans = store.get_spans("conv-old").await.unwrap();
    assert_eq!(spans[0].status, SpanStatus::Error);
    assert_eq!(spans[1].status, SpanStatus::Running);
    assert!(spans[0].trace_id.is_none() && spans[0].attributes.is_empty());
    let tree = store.get_tree("conv-old").await.unwrap();
    assert_eq!(tree.roots.len(), 2);
    assert_eq!(tree.error_count, 1);
    // Close the SQLite connection (and its WAL/SHM handles) first: Windows
    // refuses to delete files that are still open.
    drop(store);
    std::fs::remove_dir_all(&dir).unwrap();
}
