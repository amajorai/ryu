mod payloads;
mod queries;

use super::*;

#[tokio::test]
async fn write_and_read_back_tool_call_span() {
    let store = TraceStore::open_in_memory().unwrap();
    let conv_id = "test-conv-1";

    // Open a tool-call span.
    let input = serde_json::json!({ "path": "/tmp/foo.txt" });
    let ah = hash_args(&input);
    let span_id = store
        .open_span(conv_id, "tool-call", "read_file", Some(&ah), None)
        .await
        .unwrap();

    // Close it successfully.
    store.close_span(&span_id, None).await.unwrap();

    // Read back.
    let spans = store.get_spans(conv_id).await.unwrap();
    assert_eq!(spans.len(), 1);
    let s = &spans[0];
    assert_eq!(s.conversation_id, conv_id);
    assert_eq!(s.kind, "tool-call");
    assert_eq!(s.name, "read_file");
    assert!(s.args_hash.is_some());
    assert!(s.ended_at.is_some());
    assert!(s.error.is_none());
}

#[tokio::test]
async fn delete_spans_removes_temporary_run_evidence() {
    let store = TraceStore::open_in_memory().unwrap();
    let span_id = store
        .open_span("temporary-eval", "model-call", "m1", None, None)
        .await
        .unwrap();
    store.close_span(&span_id, None).await.unwrap();
    assert_eq!(store.delete_spans("temporary-eval").await.unwrap(), 1);
    assert!(store.get_spans("temporary-eval").await.unwrap().is_empty());
}

#[tokio::test]
async fn error_span_records_message() {
    let store = TraceStore::open_in_memory().unwrap();
    let span_id = store
        .open_span("conv-2", "tool-call", "bash", None, None)
        .await
        .unwrap();
    store
        .close_span(&span_id, Some("permission denied"))
        .await
        .unwrap();
    let spans = store.get_spans("conv-2").await.unwrap();
    assert_eq!(spans[0].error.as_deref(), Some("permission denied"));
}

#[tokio::test]
async fn model_call_span_keeps_session_link_without_payload() {
    let store = TraceStore::open_in_memory().unwrap();
    let span_id = store
        .open_span(
            "conv-model",
            "model-call",
            "gpt-4o-mini",
            None,
            Some("conv-model"),
        )
        .await
        .unwrap();
    store.close_span(&span_id, None).await.unwrap();

    let spans = store.get_spans("conv-model").await.unwrap();
    assert_eq!(spans[0].kind, "model-call");
    assert_eq!(spans[0].name, "gpt-4o-mini");
    assert_eq!(spans[0].session_id.as_deref(), Some("conv-model"));
    assert!(spans[0].args_hash.is_none());
}

#[tokio::test]
async fn multiple_spans_ordered_by_seq() {
    let store = TraceStore::open_in_memory().unwrap();
    let conv = "conv-order";
    for name in ["alpha", "beta", "gamma"] {
        let id = store
            .open_span(conv, "tool-call", name, None, None)
            .await
            .unwrap();
        store.close_span(&id, None).await.unwrap();
    }
    let spans = store.get_spans(conv).await.unwrap();
    assert_eq!(spans.len(), 3);
    assert!(spans[0].seq < spans[1].seq);
    assert!(spans[1].seq < spans[2].seq);
    assert_eq!(spans[0].name, "alpha");
    assert_eq!(spans[2].name, "gamma");
}

// ── v2 hierarchy ────────────────────────────────────────────────────────

#[tokio::test]
async fn legacy_open_span_nests_under_the_active_scope() {
    let store = TraceStore::open_in_memory().unwrap();
    let run = store
        .begin_scope(
            SpanStart::new("conv-h", SpanKind::AgentRun, "assistant").agent(Some("agent-1")),
        )
        .await
        .unwrap();
    let tool = store
        .open_span("conv-h", "tool-call", "read_file", None, None)
        .await
        .unwrap();
    store.close_span(&tool, None).await.unwrap();
    let retrieval = store
        .start_span(SpanStart::new("conv-h", SpanKind::Retrieval, "auto-recall").attr("top_k", 5))
        .await
        .unwrap();
    store
        .end_span(&retrieval.id, SpanEnd::ok().attr("hits", 2))
        .await
        .unwrap();
    store.end_scope(&run, SpanEnd::ok()).await.unwrap();
    assert!(store.active_scope("conv-h").is_none());

    let spans = store.get_spans("conv-h").await.unwrap();
    assert_eq!(spans.len(), 3);
    assert!(spans
        .iter()
        .all(|span| span.trace_id.as_deref() == Some(run.trace_id.as_str())));
    assert!(spans
        .iter()
        .all(|span| span.agent_id.as_deref() == Some("agent-1")));
    assert_eq!(spans[1].kind, "tool-call", "legacy spelling is preserved");
    assert_eq!(
        spans[1].parent_span_id.as_deref(),
        Some(run.span_id.as_str())
    );
    assert_eq!(spans[2].attributes["top_k"], 5);
    assert_eq!(spans[2].attributes["hits"], 2);
    assert_eq!(run.trace_id.len(), 32);
    assert_eq!(run.span_id.len(), 16);

    let tree = store.get_tree("conv-h").await.unwrap();
    assert_eq!(tree.roots.len(), 1);
    assert_eq!(tree.roots[0].children.len(), 2);
    assert_eq!(tree.roots[0].span.status, SpanStatus::Ok);
}

#[tokio::test]
async fn dropped_guard_ends_the_scope_with_its_error() {
    let store = TraceStore::open_in_memory().unwrap();
    {
        let mut guard = store
            .scope_guard(SpanStart::new("conv-g", SpanKind::WorkflowRun, "flow"))
            .await
            .unwrap();
        guard.fail("step 2 failed");
        guard.set_attribute("steps", 2);
    }
    // The drop spawns the end on the runtime; let it run.
    for _ in 0..50 {
        tokio::task::yield_now().await;
        let spans = store.get_spans("conv-g").await.unwrap();
        if spans[0].ended_at.is_some() {
            assert_eq!(spans[0].status, SpanStatus::Error);
            assert_eq!(spans[0].error.as_deref(), Some("step 2 failed"));
            assert_eq!(spans[0].attributes["steps"], 2);
            return;
        }
    }
    panic!("guard did not end the scope");
}

#[tokio::test]
async fn handoff_and_run_finisher_end_nested_scopes() {
    let store = TraceStore::open_in_memory().unwrap();
    let guard = store
        .scope_guard(SpanStart::new("conv-f", SpanKind::AgentRun, "a"))
        .await
        .unwrap();
    let run = guard.handoff().unwrap();
    let step = store
        .begin_scope(SpanStart::new("conv-f", SpanKind::WorkflowStep, "inner"))
        .await
        .unwrap();
    assert_eq!(store.active_scope("conv-f").unwrap().id, step.id);
    store.run_finisher("conv-f").finish().await.unwrap();
    let spans = store.get_spans("conv-f").await.unwrap();
    assert_eq!(spans[0].id, run.id);
    assert_eq!(spans[0].status, SpanStatus::Ok);
    assert_eq!(spans[1].status, SpanStatus::Cancelled);
    assert!(!store
        .finish_active_run("conv-f", SpanEnd::ok())
        .await
        .unwrap());
}

#[tokio::test]
async fn a_new_agent_run_supersedes_a_leftover_one() {
    let store = TraceStore::open_in_memory().unwrap();
    let first = store
        .begin_scope(SpanStart::new("conv-s", SpanKind::AgentRun, "turn 1"))
        .await
        .unwrap();
    let second = store
        .begin_scope(SpanStart::new("conv-s", SpanKind::AgentRun, "turn 2"))
        .await
        .unwrap();
    assert_ne!(first.trace_id, second.trace_id);
    let old = store.get_span(&first.id).await.unwrap().unwrap();
    assert_eq!(old.status, SpanStatus::Cancelled);
    assert!(old.parent_span_id.is_none());
    // A workflow started inside the run nests instead of superseding it.
    let flow = store
        .begin_scope(SpanStart::new("conv-s", SpanKind::WorkflowRun, "flow"))
        .await
        .unwrap();
    assert_eq!(flow.trace_id, second.trace_id);
}
