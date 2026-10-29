//! Assemble a run's flat span rows into a parent/child tree with waterfall
//! offsets. Pure: the HTTP route reads rows from [`crate::TraceStore`] and
//! hands them here.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::{Span, SpanKind, SpanStatus};

/// Hard bound on nesting so a malformed row set can never recurse unboundedly.
const MAX_DEPTH: usize = 256;

/// One span with its children, positioned on the run's timeline.
#[derive(Debug, Clone, Serialize)]
pub struct SpanNode {
    /// The stored span (every v1 and v2 field).
    #[serde(flatten)]
    pub span: Span,
    /// The canonical kind (`tool-call` → `tool_call`); `None` for an unknown
    /// kind written by an older or foreign caller.
    pub normalized_kind: Option<SpanKind>,
    /// Nesting depth (roots are 0).
    pub depth: usize,
    /// Milliseconds from the run's first span start to this span's start.
    pub offset_ms: i64,
    /// `ended_at - started_at`; `None` while the span is running.
    pub duration_ms: Option<i64>,
    /// Child spans, ordered by start time then write order.
    pub children: Vec<SpanNode>,
}

/// A run's spans as a forest (one root per turn or workflow execution, plus
/// any v1 flat spans that have no parent).
#[derive(Debug, Clone, Serialize)]
pub struct RunTraceTree {
    /// The run (conversation) id.
    pub run_id: String,
    /// Earliest span start (Unix ms); `None` for an empty run.
    pub started_at: Option<i64>,
    /// Latest span end (Unix ms); `None` while anything is still running.
    pub ended_at: Option<i64>,
    /// `ended_at - started_at` when both are known.
    pub duration_ms: Option<i64>,
    /// Total spans in the run.
    pub span_count: usize,
    /// Spans that ended with an error.
    pub error_count: usize,
    /// Root spans in start order.
    pub roots: Vec<SpanNode>,
}

/// Build the tree for one run from its rows (any order).
pub fn build_tree(run_id: &str, spans: Vec<Span>) -> RunTraceTree {
    let span_count = spans.len();
    let error_count = spans
        .iter()
        .filter(|span| span.status == SpanStatus::Error)
        .count();
    let started_at = spans.iter().map(|span| span.started_at).min();
    let ended_at = if spans.iter().any(|span| span.ended_at.is_none()) {
        None
    } else {
        spans.iter().filter_map(|span| span.ended_at).max()
    };
    let origin = started_at.unwrap_or(0);

    let known: HashSet<String> = spans
        .iter()
        .filter_map(|span| span.span_id.clone())
        .collect();
    let mut children_of: HashMap<String, Vec<Span>> = HashMap::new();
    let mut roots = Vec::new();
    for span in spans {
        match span.parent_span_id.clone() {
            Some(parent)
                if known.contains(&parent) && span.span_id.as_deref() != Some(parent.as_str()) =>
            {
                children_of.entry(parent).or_default().push(span);
            }
            _ => roots.push(span),
        }
    }
    sort_spans(&mut roots);
    let mut visited = HashSet::new();
    let mut roots: Vec<SpanNode> = roots
        .into_iter()
        .map(|span| node(span, 0, origin, &mut children_of, &mut visited))
        .collect();
    // Spans whose parent chain never reaches a root (a parent cycle in
    // malformed rows) would otherwise vanish; surface them as roots so the
    // tree always accounts for every span.
    let mut stranded: Vec<Span> = children_of.drain().flat_map(|(_, kids)| kids).collect();
    sort_spans(&mut stranded);
    let mut children_of = HashMap::new();
    for span in stranded {
        roots.push(node(span, 0, origin, &mut children_of, &mut visited));
    }

    RunTraceTree {
        run_id: run_id.to_owned(),
        started_at,
        ended_at,
        duration_ms: match (started_at, ended_at) {
            (Some(start), Some(end)) => Some(end.saturating_sub(start)),
            _ => None,
        },
        span_count,
        error_count,
        roots,
    }
}

fn sort_spans(spans: &mut [Span]) {
    spans.sort_by_key(|span| (span.started_at, span.seq));
}

fn node(
    span: Span,
    depth: usize,
    origin: i64,
    children_of: &mut HashMap<String, Vec<Span>>,
    visited: &mut HashSet<String>,
) -> SpanNode {
    let mut children = Vec::new();
    if let Some(span_id) = span.span_id.clone() {
        if depth < MAX_DEPTH && visited.insert(span_id.clone()) {
            if let Some(mut kids) = children_of.remove(&span_id) {
                sort_spans(&mut kids);
                children = kids
                    .into_iter()
                    .map(|kid| node(kid, depth + 1, origin, children_of, visited))
                    .collect();
            }
        }
    }
    SpanNode {
        normalized_kind: SpanKind::parse(&span.kind),
        depth,
        offset_ms: span.started_at.saturating_sub(origin),
        duration_ms: span.ended_at.map(|end| end.saturating_sub(span.started_at)),
        children,
        span,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(id: &str, parent: Option<&str>, kind: &str, start: i64, end: Option<i64>) -> Span {
        Span {
            id: format!("row-{id}"),
            conversation_id: "run".into(),
            kind: kind.into(),
            name: id.into(),
            args_hash: None,
            started_at: start,
            ended_at: end,
            error: None,
            session_id: None,
            seq: start,
            trace_id: Some("t".into()),
            span_id: Some(id.into()),
            parent_span_id: parent.map(str::to_owned),
            status: if end.is_some() {
                SpanStatus::Ok
            } else {
                SpanStatus::Running
            },
            agent_id: None,
            attributes: serde_json::Map::new(),
            input: None,
            output: None,
        }
    }

    #[test]
    fn nests_children_and_computes_offsets() {
        let tree = build_tree(
            "run",
            vec![
                span("tool", Some("root"), "tool_call", 150, Some(170)),
                span("root", None, "agent_run", 100, Some(200)),
                span("model", Some("root"), "model_call", 110, Some(140)),
                span("inner", Some("tool"), "retrieval", 155, Some(160)),
            ],
        );
        assert_eq!(tree.span_count, 4);
        assert_eq!(tree.started_at, Some(100));
        assert_eq!(tree.duration_ms, Some(100));
        assert_eq!(tree.roots.len(), 1);
        let root = &tree.roots[0];
        assert_eq!(root.normalized_kind, Some(SpanKind::AgentRun));
        let names: Vec<_> = root.children.iter().map(|c| c.span.name.as_str()).collect();
        assert_eq!(names, ["model", "tool"]);
        assert_eq!(root.children[1].offset_ms, 50);
        assert_eq!(root.children[1].children[0].depth, 2);
        assert_eq!(root.children[1].children[0].duration_ms, Some(5));
    }

    #[test]
    fn orphans_legacy_rows_and_self_parents_become_roots() {
        let mut legacy = span("legacy", None, "tool-call", 5, None);
        legacy.span_id = None;
        legacy.trace_id = None;
        let tree = build_tree(
            "run",
            vec![
                legacy,
                span("orphan", Some("missing"), "tool_call", 1, Some(2)),
                span("loop", Some("loop"), "memory", 3, Some(4)),
            ],
        );
        assert_eq!(tree.roots.len(), 3);
        assert_eq!(tree.ended_at, None, "a running span keeps the run open");
        assert_eq!(tree.roots[2].normalized_kind, Some(SpanKind::ToolCall));
        assert_eq!(tree.roots[2].duration_ms, None);
    }

    #[test]
    fn parent_cycles_still_surface_every_span() {
        let tree = build_tree(
            "run",
            vec![
                span("a", Some("b"), "tool_call", 1, Some(2)),
                span("b", Some("a"), "tool_call", 3, Some(4)),
            ],
        );
        assert_eq!(tree.span_count, 2);
        let names: Vec<_> = tree.roots.iter().map(|n| n.span.name.as_str()).collect();
        assert_eq!(names, ["a", "b"]);
    }

    #[test]
    fn empty_run_has_no_bounds() {
        let tree = build_tree("run", Vec::new());
        assert!(tree.roots.is_empty());
        assert_eq!(tree.started_at, None);
        assert_eq!(tree.duration_ms, None);
    }
}
