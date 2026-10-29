use super::{begin_run_trace, end_trace_span, handoff_run_trace, start_trace_span};
use ryu_tracing::{SpanEnd, SpanKind, SpanStart, SpanStatus, TraceStore};

async fn ended(store: &TraceStore, run: &str) -> Vec<ryu_tracing::Span> {
    for _ in 0..50 {
        tokio::task::yield_now().await;
        let spans = store.get_spans(run).await.unwrap();
        if spans.iter().all(|span| span.ended_at.is_some()) {
            return spans;
        }
    }
    panic!("spans for {run} never ended");
}

#[tokio::test]
async fn a_turn_dropped_before_a_plane_ends_its_run_as_failed() {
    let store = TraceStore::open_in_memory().unwrap();
    let guard = begin_run_trace(&store, Some("conv-early"), Some("agent-a")).await;
    assert!(guard.is_some());
    drop(guard);
    let spans = ended(&store, "conv-early").await;
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].kind, "agent_run");
    assert_eq!(spans[0].name, "agent-a");
    assert_eq!(spans[0].status, SpanStatus::Error);
}

#[tokio::test]
async fn a_handed_off_run_nests_plane_spans_and_ends_through_the_finisher() {
    let store = TraceStore::open_in_memory().unwrap();
    let mut guard = begin_run_trace(&store, Some("conv-ok"), None).await;
    let recall = start_trace_span(
        &store,
        Some("conv-ok"),
        SpanStart::new(String::new(), SpanKind::Retrieval, "auto-recall"),
    )
    .await;
    end_trace_span(
        &store,
        recall.as_ref(),
        SpanEnd::ok().attr("injected", false),
    )
    .await;
    handoff_run_trace(&mut guard);
    assert!(guard.is_none());
    // The plane's v1 model span nests under the still-open run.
    let model = store
        .open_span("conv-ok", "model-call", "m", None, Some("conv-ok"))
        .await
        .unwrap();
    store.close_span(&model, None).await.unwrap();
    drop(store.run_finisher("conv-ok"));
    let spans = ended(&store, "conv-ok").await;
    assert_eq!(spans.len(), 3);
    let root = &spans[0];
    assert_eq!(root.kind, "agent_run");
    assert_eq!(root.name, "default");
    assert_eq!(root.status, SpanStatus::Ok);
    for child in &spans[1..] {
        assert_eq!(child.parent_span_id, root.span_id);
        assert_eq!(child.trace_id, root.trace_id);
    }
}

#[tokio::test]
async fn no_conversation_means_no_run_trace() {
    let store = TraceStore::open_in_memory().unwrap();
    assert!(begin_run_trace(&store, None, Some("a")).await.is_none());
    assert!(begin_run_trace(&store, Some(""), Some("a")).await.is_none());
    assert!(start_trace_span(
        &store,
        None,
        SpanStart::new(String::new(), SpanKind::Memory, "write")
    )
    .await
    .is_none());
}
